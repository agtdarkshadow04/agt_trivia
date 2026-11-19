import type { Sqlite } from '../db.js';

/**
 * All SQL of the log store (SRV-4, §13). The log store is its own SQLite file,
 * so none of this is a data write (BAK-8). Rows are never updated except a
 * coalesced audit entry's `count` and `last_at` (LOG-2).
 */

export type ServerLevel = 'info' | 'warn' | 'error' | 'fatal';
export type ActorType = 'admin' | 'anonymous';
export type AuditOutcome = 'success' | 'denied' | 'rate_limited' | 'failure';

export interface ServerEntry {
  seq?: number;
  id: string;
  at: string;
  level: ServerLevel;
  source: string;
  message: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface AuditEntry {
  seq?: number;
  id: string;
  at: string;
  lastAt: string;
  count: number;
  actorType: ActorType;
  actor: string | null;
  ipHash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  statusCode: number;
  requestId: string | null;
  details: Record<string, unknown>;
}

export const serverLevels: readonly ServerLevel[] = ['info', 'warn', 'error', 'fatal'];

export interface ServerFilters {
  /** The minimum level. */
  level?: ServerLevel;
  source?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface AuditFilters {
  actorType?: ActorType;
  action?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  q?: string;
}

// --- log_meta ---------------------------------------------------------------

export function readMeta(sqlite: Sqlite, key: string): string | null {
  return (sqlite.prepare('SELECT value FROM log_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function writeMeta(sqlite: Sqlite, key: string, value: string) {
  sqlite.prepare('INSERT INTO log_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Stores `value` unless the key exists; returns the stored value either way. */
export function insertMetaOnce(sqlite: Sqlite, key: string, value: string) {
  sqlite.prepare('INSERT INTO log_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(key, value);
  return readMeta(sqlite, key)!;
}

// --- Server log ---------------------------------------------------------------

interface ServerRow {
  seq: number;
  id: string;
  at: string;
  level: ServerLevel;
  source: string;
  message: string;
  request_id: string | null;
  details: string;
}

const serverEntry = (row: ServerRow): ServerEntry => ({
  seq: row.seq,
  id: row.id,
  at: row.at,
  level: row.level,
  source: row.source,
  message: row.message,
  requestId: row.request_id,
  details: JSON.parse(row.details) as Record<string, unknown>,
});

export function insertServerEntry(sqlite: Sqlite, entry: ServerEntry) {
  sqlite.prepare('INSERT INTO server_log (id, at, level, source, message, request_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(entry.id, entry.at, entry.level, entry.source, entry.message, entry.requestId, JSON.stringify(entry.details));
}

/** `LIKE` text that matches `value` literally anywhere. */
function contains(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function serverWhere(filters: ServerFilters, before: number | null) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (before !== null) { clauses.push('seq < ?'); values.push(before); }
  if (filters.level) {
    const levels = serverLevels.slice(serverLevels.indexOf(filters.level));
    clauses.push(`level IN (${levels.map(() => '?').join(', ')})`);
    values.push(...levels);
  }
  if (filters.source) { clauses.push('source = ?'); values.push(filters.source); }
  if (filters.from) { clauses.push('at >= ?'); values.push(filters.from); }
  if (filters.to) { clauses.push('at <= ?'); values.push(filters.to); }
  if (filters.q) { clauses.push("message LIKE ? ESCAPE '\\'"); values.push(contains(filters.q)); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

/** Newest first; `before` is the `seq` after which the page starts (API-8). */
export function listServer(sqlite: Sqlite, filters: ServerFilters, before: number | null, limit: number): ServerEntry[] {
  const { where, values } = serverWhere(filters, before);
  return (sqlite.prepare(`SELECT * FROM server_log ${where} ORDER BY seq DESC LIMIT ?`).all(...values, limit) as ServerRow[]).map(serverEntry);
}

/** Unseen warnings and errors (`error` and `fatal`) since `seenAt` (LOG-21). */
export function countUnseen(sqlite: Sqlite, seenAt: string | null) {
  const rows = sqlite.prepare(`SELECT level, count(*) AS n FROM server_log WHERE level IN ('warn', 'error', 'fatal') AND at > ? GROUP BY level`)
    .all(seenAt ?? '') as { level: ServerLevel; n: number }[];
  const count = (levels: ServerLevel[]) => rows.filter((row) => levels.includes(row.level)).reduce((sum, row) => sum + row.n, 0);
  return { unseenWarnings: count(['warn']), unseenErrors: count(['error', 'fatal']) };
}

export function clearServer(sqlite: Sqlite) {
  return sqlite.prepare('DELETE FROM server_log').run().changes;
}

export function deleteServerOlderThan(sqlite: Sqlite, before: string) {
  return sqlite.prepare('DELETE FROM server_log WHERE at < ?').run(before).changes;
}

/** Deletes the oldest entries beyond `max`. */
export function capServer(sqlite: Sqlite, max: number) {
  return sqlite.prepare('DELETE FROM server_log WHERE seq IN (SELECT seq FROM server_log ORDER BY seq DESC LIMIT -1 OFFSET ?)').run(max).changes;
}

// --- Audit log ------------------------------------------------------------------

interface AuditRow {
  seq: number;
  id: string;
  at: string;
  last_at: string;
  count: number;
  actor_type: ActorType;
  actor: string | null;
  ip_hash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  status_code: number;
  request_id: string | null;
  details: string;
}

const auditEntry = (row: AuditRow): AuditEntry => ({
  seq: row.seq,
  id: row.id,
  at: row.at,
  lastAt: row.last_at,
  count: row.count,
  actorType: row.actor_type,
  actor: row.actor,
  ipHash: row.ip_hash,
  client: row.client,
  action: row.action,
  method: row.method,
  route: row.route,
  targetType: row.target_type,
  targetId: row.target_id,
  outcome: row.outcome,
  statusCode: row.status_code,
  requestId: row.request_id,
  details: JSON.parse(row.details) as Record<string, unknown>,
});

export function insertAudit(sqlite: Sqlite, entry: AuditEntry) {
  sqlite.prepare(`INSERT INTO audit_log (id, at, last_at, count, actor_type, actor, ip_hash, client, action, method, route,
      target_type, target_id, outcome, status_code, request_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.id, entry.at, entry.lastAt, entry.count, entry.actorType, entry.actor, entry.ipHash, entry.client, entry.action,
    entry.method, entry.route, entry.targetType, entry.targetId, entry.outcome, entry.statusCode, entry.requestId,
    JSON.stringify(entry.details),
  );
}

/**
 * LOG-11: adds `entry` to an identical failure from the last 60 seconds
 * (same action, outcome, status and address hash); false when there is none.
 */
export function coalesceAudit(sqlite: Sqlite, entry: AuditEntry, since: string) {
  return sqlite.prepare(`UPDATE audit_log SET count = count + 1, last_at = ?
    WHERE seq = (SELECT seq FROM audit_log WHERE action = ? AND outcome = ? AND status_code = ? AND ip_hash IS ? AND last_at >= ?
      ORDER BY seq DESC LIMIT 1)`)
    .run(entry.lastAt, entry.action, entry.outcome, entry.statusCode, entry.ipHash, since).changes === 1;
}

function auditWhere(filters: AuditFilters, before: number | null) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (before !== null) { clauses.push('seq < ?'); values.push(before); }
  for (const [column, value] of [['actor_type', filters.actorType], ['action', filters.action], ['outcome', filters.outcome], ['target_type', filters.targetType], ['target_id', filters.targetId]] as const) {
    if (value) { clauses.push(`${column} = ?`); values.push(value); }
  }
  if (filters.from) { clauses.push('last_at >= ?'); values.push(filters.from); }
  if (filters.to) { clauses.push('at <= ?'); values.push(filters.to); }
  if (filters.q) {
    clauses.push("(actor LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_type LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')");
    values.push(...Array(5).fill(contains(filters.q)));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

export function listAudit(sqlite: Sqlite, filters: AuditFilters, before: number | null, limit: number): AuditEntry[] {
  const { where, values } = auditWhere(filters, before);
  return (sqlite.prepare(`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT ?`).all(...values, limit) as AuditRow[]).map(auditEntry);
}

export function deleteAuditOlderThan(sqlite: Sqlite, before: string) {
  return sqlite.prepare('DELETE FROM audit_log WHERE last_at < ?').run(before).changes;
}

/** LOG-15: deletes beyond `max`, the oldest non-success entries first, then the oldest successes. */
export function capAudit(sqlite: Sqlite, max: number) {
  const total = (sqlite.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;
  let excess = total - max;
  if (excess <= 0) return 0;
  const failures = sqlite.prepare(`DELETE FROM audit_log WHERE seq IN (SELECT seq FROM audit_log WHERE outcome <> 'success' ORDER BY seq LIMIT ?)`).run(excess).changes;
  excess -= failures;
  const successes = excess > 0 ? sqlite.prepare('DELETE FROM audit_log WHERE seq IN (SELECT seq FROM audit_log ORDER BY seq LIMIT ?)').run(excess).changes : 0;
  return failures + successes;
}
