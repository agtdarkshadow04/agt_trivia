import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { Readable, Writable } from 'node:stream';
import pino from 'pino';
import type { AppConfig } from './config.js';
import { openSqlite, runMigrations, type Migration, type Sqlite } from './db.js';
import initialLogs from './migrations/logs/0001_initial.sql';
import * as repo from './repository/logs.js';
import type { AuditEntry, AuditFilters, ServerEntry, ServerFilters, ServerLevel } from './repository/logs.js';

/**
 * The log store (§13): the server log and the audit log in their own SQLite
 * file (LOG-1), the pino logger that writes to stdout and the server log
 * (LOG-5), IP pseudonymization (LOG-12), retention (LOG-15) and exports
 * (LOG-22). Writes never fail a request or the server (LOG-3).
 */

export type { AuditEntry, ServerEntry } from './repository/logs.js';

/** The log store's own migrations (LOG-1), run at startup like the main database's. */
export const LOG_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_initial', sql: initialLogs },
];

/** Where a failure to write the log store is reported, once (LOG-3). Never the logger itself. */
export type FailureReporter = (message: string) => void;

const ipKeyName = 'ip_hash_key';
const seenKeyName = 'server_log_seen_at';

/** LOG-11: failures within this many milliseconds of an identical one are coalesced. */
const coalesceWindow = 60_000;

/**
 * LOG-12: the client address to hash. IPv4-mapped IPv6 becomes IPv4; other
 * IPv6 addresses keep only their /64 prefix.
 */
export function normalizeAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || '0', 16).toString(16)).join(':')}::/64`;
}

const pinoLevels: Record<number, ServerLevel> = { 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
/** pino's fields that are not details (LOG-7, LOG-9). */
const recordFields = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'source', 'reqId', 'req', 'res', 'err', 'responseTime', 'route']);

/** A pino record as a server log entry; levels below info give null (LOG-5, LOG-7, LOG-9). */
export function serverEntryFromRecord(record: Record<string, unknown>): ServerEntry | null {
  const level = pinoLevels[Number(record.level)];
  if (!level) return null;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!recordFields.has(key)) details[key] = value;
  const error = record.err as { type?: string; message?: string; stack?: string } | undefined;
  // LOG-9: an error's name, message, stack and route only; never headers or bodies.
  if (error && typeof error === 'object') {
    details.error = { name: error.type, message: error.message, stack: error.stack };
    if (typeof record.route === 'string') details.route = record.route;
  }
  const requestId = typeof record.reqId === 'string' ? record.reqId : null;
  return {
    id: randomUUID(),
    at: new Date(typeof record.time === 'number' ? record.time : Date.now()).toISOString(),
    level,
    source: typeof record.source === 'string' ? record.source : requestId ? 'http' : 'server',
    message: typeof record.msg === 'string' ? record.msg : '',
    requestId,
    details,
  };
}

export interface RetentionSettings {
  serverRetentionDays: number;
  serverMaxEntries: number;
  auditRetentionDays: number;
  auditMaxEntries: number;
}

export interface LogStoreOptions {
  report?: FailureReporter;
  now?: () => Date;
}

/** The log store. Writes never throw (LOG-3); reads do, and routes answer them with errors. */
export class LogStore {
  private readonly ipKey: Buffer;
  private failureReported = false;
  private readonly report: FailureReporter;
  private readonly now: () => Date;

  constructor(private readonly sqlite: Sqlite, options: LogStoreOptions = {}) {
    this.report = options.report ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.ipKey = Buffer.from(repo.insertMetaOnce(sqlite, ipKeyName, randomBytes(32).toString('hex')), 'hex');
  }

  private failed(what: string, error: unknown) {
    if (this.failureReported) return;
    this.failureReported = true;
    this.report(`The log store could not ${what}: ${error instanceof Error ? error.message : String(error)}. Further failures are not reported.`);
  }

  writeServer(entry: ServerEntry) {
    try {
      repo.insertServerEntry(this.sqlite, entry);
    } catch (error) {
      this.failed('write the server log', error);
    }
  }

  /** LOG-12: the first 16 hex characters of HMAC-SHA256(key, address). */
  ipHash(address: string | undefined) {
    if (!address) return null;
    return createHmac('sha256', this.ipKey).update(normalizeAddress(address)).digest('hex').slice(0, 16);
  }

  /** Writes an audit entry, coalescing repeated failures (LOG-11). Never throws (LOG-3). */
  audit(entry: Omit<AuditEntry, 'id' | 'at' | 'lastAt' | 'count'>) {
    const now = this.now();
    const at = now.toISOString();
    const full: AuditEntry = { ...entry, id: randomUUID(), at, lastAt: at, count: 1 };
    try {
      if (full.outcome !== 'success' && repo.coalesceAudit(this.sqlite, full, new Date(now.getTime() - coalesceWindow).toISOString())) return;
      repo.insertAudit(this.sqlite, full);
    } catch (error) {
      this.failed('write the audit log', error);
    }
  }

  listServer(filters: ServerFilters, before: number | null, limit: number) {
    return repo.listServer(this.sqlite, filters, before, limit);
  }

  listAudit(filters: AuditFilters, before: number | null, limit: number) {
    return repo.listAudit(this.sqlite, filters, before, limit);
  }

  /** LOG-21: unseen warnings and errors since the "seen" marker. */
  summary() {
    return repo.countUnseen(this.sqlite, repo.readMeta(this.sqlite, seenKeyName));
  }

  markSeen() {
    repo.writeMeta(this.sqlite, seenKeyName, this.now().toISOString());
  }

  /** LOG-20: the Admin's Clear log, for the server log only. */
  clearServer() {
    return repo.clearServer(this.sqlite);
  }

  /**
   * LOG-15: deletes entries older than the retention periods, then the oldest
   * beyond the caps (for the audit log, failures before successes).
   */
  applyRetention(settings: RetentionSettings) {
    const day = 24 * 60 * 60 * 1000;
    const now = this.now().getTime();
    const before = (days: number) => new Date(now - days * day).toISOString();
    return this.sqlite.transaction(() => ({
      server: repo.deleteServerOlderThan(this.sqlite, before(settings.serverRetentionDays)) + repo.capServer(this.sqlite, settings.serverMaxEntries),
      audit: repo.deleteAuditOlderThan(this.sqlite, before(settings.auditRetentionDays)) + repo.capAudit(this.sqlite, settings.auditMaxEntries),
    }))();
  }

  close() {
    if (this.sqlite.open) this.sqlite.close();
  }
}

/** Opens and migrates the log store file (LOG-1); `:memory:` is for tests. */
export function openLogStore(file: string, options: LogStoreOptions = {}) {
  const sqlite = openSqlite(file);
  try {
    const applied = runMigrations(sqlite, LOG_MIGRATIONS);
    return { store: new LogStore(sqlite, options), applied };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** The stream behind the logger that feeds the server log: info and above, parsed from pino's JSON lines (LOG-5). */
export function logStoreStream(store: Pick<LogStore, 'writeServer'>, report: FailureReporter = () => undefined) {
  let reported = false;
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      try {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          const entry = serverEntryFromRecord(JSON.parse(line) as Record<string, unknown>);
          if (entry) store.writeServer(entry);
        }
      } catch (error) {
        if (!reported) {
          reported = true;
          report(`A log line could not be stored: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      callback();
    },
  });
}

const levelValues: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

/** Paths pino never logs (SRV-6, LOG-9). */
export const redactedPaths = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

/**
 * LOG-5: the logger Fastify gets as `loggerInstance`. stdout follows
 * `server.logLevel`; the log store gets info and above whatever that level is.
 */
export function createLogger(config: Pick<AppConfig, 'server'>, stdout: NodeJS.WritableStream, store: Writable) {
  const stdoutLevel = config.server.logLevel;
  const streams: pino.StreamEntry[] = [{ level: 'info', stream: store }];
  if (stdoutLevel !== 'silent') streams.push({ level: stdoutLevel as pino.Level, stream: stdout });
  const level = levelValues[stdoutLevel] < levelValues.info ? stdoutLevel : 'info';
  return pino({ level, redact: redactedPaths }, pino.multistream(streams));
}

/**
 * LOG-15: retention at startup and then every hour. A run that deletes
 * anything writes one server log entry with the counts.
 */
export function startRetention(
  store: Pick<LogStore, 'applyRetention'>,
  settings: () => RetentionSettings,
  log: { info(details: object, message: string): void; error(details: object, message: string): void },
  /** BAK-8: admits the run as a job, or null to skip it while a restore runs or has failed. */
  admit: () => (() => void) | null = () => () => undefined,
) {
  const run = () => {
    const end = admit();
    if (!end) return;
    try {
      const deleted = store.applyRetention(settings());
      if (deleted.server || deleted.audit) {
        log.info({ source: 'retention', deleted }, `Retention deleted ${deleted.server} server log and ${deleted.audit} audit log entries.`);
      }
    } catch (error) {
      log.error({ source: 'retention', err: error }, 'Log retention failed.');
    } finally {
      end();
    }
  };
  run();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// --- Exports (LOG-22) -----------------------------------------------------------------

export type ExportFormat = 'jsonl' | 'csv';

/** LOG-22: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading quote. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const serverColumns = ['id', 'at', 'level', 'source', 'message', 'requestId', 'details'] as const;
export const auditColumns = [
  'id', 'at', 'lastAt', 'count', 'actorType', 'actor', 'ipHash', 'client', 'action', 'method', 'route',
  'targetType', 'targetId', 'outcome', 'statusCode', 'requestId', 'details',
] as const;

/**
 * A streamed export of every entry matching the filters, newest first, read in
 * pages so the whole log is never held in memory.
 */
export function exportStream<Entry extends { seq?: number }>(
  page: (before: number | null, limit: number) => Entry[],
  format: ExportFormat,
  columns: readonly string[],
) {
  let before: number | null = null;
  let started = false;
  let done = false;
  return new Readable({
    read() {
      try {
        if (!started) {
          started = true;
          if (format === 'csv') {
            this.push(`${columns.join(',')}\r\n`);
            return;
          }
        }
        if (done) {
          this.push(null);
          return;
        }
        const rows = page(before, 500);
        if (rows.length < 500) done = true;
        if (!rows.length) {
          this.push(null);
          return;
        }
        before = rows.at(-1)!.seq ?? null;
        this.push(rows.map((row) => {
          const record = { ...row } as Record<string, unknown>;
          delete record.seq;
          return format === 'jsonl' ? `${JSON.stringify(record)}\n` : `${columns.map((column) => csvCell(record[column])).join(',')}\r\n`;
        }).join(''));
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/** `agt-trivia-<server|audit>-log-<timestamp>.<ext>` (LOG-22). */
export function exportFileName(log: 'server' | 'audit', format: ExportFormat, date: Date) {
  return `agt-trivia-${log}-log-${date.toISOString().replace(/[:.]/g, '-')}.${format}`;
}

// --- Cursors (API-8) ---------------------------------------------------------------------

/** The position after an entry: base64url of its `seq`. */
export function encodeLogCursor(seq: number) {
  return Buffer.from(String(seq)).toString('base64url');
}

/** Decodes a log cursor; null for a malformed one, which the caller answers with `400 invalid_request`. */
export function decodeLogCursor(cursor: string): number | null {
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[1-9][0-9]{0,15}$/.test(text) ? Number(text) : null;
}
