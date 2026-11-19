import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import BetterSqlite3 from 'better-sqlite3';
import { settingKeys } from './config.js';
import { lockedSettingKeys, settingValues, type AppContext } from './context.js';
import { asOperation } from './dataWrite.js';
import { EXPECTED_TABLES, missingTables, openSqlite, runMigrations, SCHEMA_VERSION, schemaVersion, type Sqlite } from './db.js';
import type { RestoreWarningCode } from './backupCodes.js';
import { ArchiveRejectedError, HttpError } from './http.js';
import type { RecoverySession } from './operation.js';
import { parseHash } from './passwords.js';
import { readSettings } from './repository/settings.js';
import { extractEntry, isSafePath, openSafeZip, writeZip, type SafeZip } from './zip.js';

/**
 * Backup and restore (§12) for a SQLite app without uploads. A backup is one
 * ZIP: `manifest.json`, `database.sqlite` (an online-backup snapshot with the
 * sessions deleted, VACUUMed, journal_mode DELETE) and `config.yaml` when one
 * exists (BAK-2). `.env` and the log store are never included. A restore
 * validates the whole upload, saves a pre-restore backup, swaps the database
 * file and checks it, and rolls back on failure (BAK-3, BAK-4, BAK-10); if even
 * the rollback fails, the app stays in maintenance (BAK-11). It never writes
 * `config.yaml` (BAK-5).
 */

export const backupFormat = 'agt-trivia-backup';
export const backupFormatVersion = 1;
/** Every path a backup archive may contain (SEC-10). */
const archivePaths = new Set(['manifest.json', 'database.sqlite', 'config.yaml']);
const manifestFields = ['format', 'formatVersion', 'appVersion', 'schemaVersion', 'createdAt', 'files'];
const maxManifestBytes = 1024 * 1024;
const maxConfigBytes = 1024 * 1024;

export interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  files: { path: string; size: number; sha256: string }[];
}

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

/** What a preview found, and what a restore did (BAK-3, BAK-4 step 6.4). */
export interface RestoreReport {
  createdAt: string;
  appVersion: string;
  schemaVersion: { backup: number; current: number };
  counts: { categories: number; questions: number; admin: number; settings: number };
  adminUsername: string | null;
  /** Dashboard settings the backup has that this installation's config.yaml locks: dropped (CFG-8). */
  ignoredSettings: string[];
  warningCodes: RestoreWarningCode[];
  config: { included: boolean; identical: boolean; diff: DiffLine[]; content: string | null };
  /** After a restore: the pre-restore backup's file name in the backups directory. */
  preRestoreBackup: string | null;
}

/** Test hooks that inject failures into a restore (TEST-4, BAK-10, BAK-11). */
export interface BackupHooks {
  /** After the snapshot, while the backup state still holds. */
  afterSnapshot?(): Promise<void> | void;
  /** BAK-4 step 4 done: the new database is in place. */
  afterSwap?(): void;
  /** Inside the step 6.1 transaction. */
  duringCommit?(): void;
  /** Deletes one set-aside path (step 6.2). */
  deleteSetAside?(path: string): void;
  /** Before the rollback reopens the database (BAK-10). */
  duringRollback?(): void;
}

export interface BackupLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/** The BAK-11 marker file in the data directory. */
export function markerFile(dataDir: string) {
  return join(dataDir, 'restore-failed.json');
}

/** BAK-2: the timestamp in file names, with `:` and `.` replaced by `-`. */
export function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** A line diff (longest common subsequence) of the backup's config.yaml against the current one (BAK-5). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: ' ', text: a[i] }); i += 1; j += 1; }
    else if (j < b.length && (i === a.length || lengths[i][j + 1] > lengths[i + 1][j])) { lines.push({ kind: '+', text: b[j] }); j += 1; }
    else { lines.push({ kind: '-', text: a[i] }); i += 1; }
  }
  return lines;
}

/** Checks the manifest's shape (BAK-2, BAK-7). */
function checkManifest(value: unknown): BackupManifest {
  const invalid = (detail: string) => new ArchiveRejectedError('invalid_manifest', `manifest.json is not valid: ${detail}.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('it is not an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== backupFormat) throw new ArchiveRejectedError('not_a_backup', `The archive is not an AGT Galactic Trivia backup (format ${JSON.stringify(manifest.format)}).`);
  if (!Number.isInteger(manifest.formatVersion) || (manifest.formatVersion as number) < 1) throw invalid('formatVersion');
  if ((manifest.formatVersion as number) > backupFormatVersion) {
    throw new ArchiveRejectedError('newer_format', `The backup's formatVersion ${manifest.formatVersion} is newer than this version reads (${backupFormatVersion}).`);
  }
  const keys = Object.keys(manifest).sort();
  if (keys.join() !== [...manifestFields].sort().join()) throw invalid(`it must have exactly the fields ${manifestFields.join(', ')}`);
  if (typeof manifest.appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.appVersion)) throw invalid('appVersion');
  if (!Number.isInteger(manifest.schemaVersion) || (manifest.schemaVersion as number) < 0) throw invalid('schemaVersion');
  if (typeof manifest.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(manifest.createdAt)) throw invalid('createdAt');
  if (!Array.isArray(manifest.files)) throw invalid('files');
  const seen = new Set<string>();
  for (const file of manifest.files as unknown[]) {
    const entry = file as Record<string, unknown>;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'path,sha256,size') throw invalid('a files entry');
    if (typeof entry.path !== 'string' || !isSafePath(entry.path) || entry.path === 'manifest.json' || seen.has(entry.path)) throw invalid(`the path ${JSON.stringify(entry.path)}`);
    if (!Number.isInteger(entry.size) || (entry.size as number) < 0) throw invalid(`the size of ${entry.path}`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw invalid(`the checksum of ${entry.path}`);
    seen.add(entry.path);
  }
  return manifest as unknown as BackupManifest;
}

async function readEntry(zip: SafeZip, path: string, max: number) {
  const entry = zip.entries.find((candidate) => candidate.path === path)!;
  if (entry.size > max) throw new ArchiveRejectedError(path === 'manifest.json' ? 'invalid_manifest' : 'too_large', `${path} is larger than ${max} bytes.`);
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.stream(entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A transform that hashes what passes through. */
function hasher() {
  const hash = createHash('sha256');
  const stream = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  return { stream, digest: () => hash.digest('hex') };
}

/**
 * BAK-3: the objects a backup's database may contain: the expected tables
 * (and SQLite's own `sqlite_sequence`) and indexes on them. Triggers and views
 * would run code on the live data, so they are refused.
 */
function checkObjects(sqlite: Sqlite) {
  const tables = new Set([...EXPECTED_TABLES, 'sqlite_sequence']);
  const objects = sqlite.prepare('SELECT type, name, tbl_name FROM sqlite_master').all() as { type: string; name: string; tbl_name: string }[];
  const disallowed = objects.find((object) => !((object.type === 'table' && tables.has(object.name)) || (object.type === 'index' && tables.has(object.tbl_name))));
  if (disallowed) {
    throw new ArchiveRejectedError('disallowed_entry', `The database contains ${disallowed.type} ${JSON.stringify(disallowed.name)}, which a backup may not contain.`);
  }
}

/** Opens a database file from an archive with defensive settings; a damaged file is `invalid_database`. */
function openUntrusted(file: string) {
  try {
    const sqlite = new BetterSqlite3(file);
    sqlite.pragma('trusted_schema = OFF');
    sqlite.pragma('foreign_keys = ON');
    const integrity = sqlite.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      sqlite.close();
      throw new ArchiveRejectedError('invalid_database', 'The database fails PRAGMA integrity_check.');
    }
    return sqlite;
  } catch (error) {
    if (error instanceof ArchiveRejectedError) throw error;
    throw new ArchiveRejectedError('invalid_database', `The database cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** BAK-4 step 5: the health check of a database about to serve, live or restored. */
function healthCheck(sqlite: Sqlite) {
  const integrity = sqlite.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('PRAGMA integrity_check failed.');
  if ((sqlite.pragma('foreign_key_check') as unknown[]).length) throw new Error('PRAGMA foreign_key_check found violations.');
  if (schemaVersion(sqlite) !== SCHEMA_VERSION) throw new Error(`The schema version is ${schemaVersion(sqlite)}, not ${SCHEMA_VERSION}.`);
  const missing = missingTables(sqlite);
  if (missing.length) throw new Error(`Tables are missing: ${missing.join(', ')}.`);
}

interface Inspection {
  report: RestoreReport;
  /** The backup's database, checked and migrated, in the work directory. */
  databaseFile: string;
}

export class BackupService {
  readonly backupsDir: string;

  constructor(private readonly context: AppContext, private readonly log: BackupLog, private readonly hooks: BackupHooks = {}) {
    this.backupsDir = resolve(context.dataDir, context.config.storage.backupsDir);
  }

  /** A fresh work directory under the backups directory, which callers always delete (SEC-10). */
  workDir(prefix: string) {
    const dir = join(this.backupsDir, `.${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private limits() {
    // BAK-11: after a failed rollback the database is closed; the recovery restore uses config.yaml and the defaults.
    const values = settingValues(this.context.config, this.context.db.open ? readSettings(this.context.db) : new Map());
    return { maxZipBytes: values['backup.maxZipBytes'], maxEntries: values['backup.maxEntries'], maxUncompressedBytes: values['backup.maxUncompressedBytes'] };
  }

  /** The largest accepted upload, for the multipart limit. */
  maxUploadBytes() {
    return this.limits().maxZipBytes;
  }

  /**
   * BAK-9: an online-backup snapshot of the live database. The caller holds
   * the operation lock, so no data write runs meanwhile. The copy then loses
   * its sessions (AUTH-8) and is VACUUMed with journal_mode DELETE (BAK-2).
   */
  private async snapshot(file: string) {
    this.context.db.connection.pragma('wal_checkpoint(PASSIVE)');
    await this.context.db.connection.backup(file);
  }

  private static finishSnapshot(file: string) {
    const sqlite = new BetterSqlite3(file);
    try {
      sqlite.prepare('DELETE FROM sessions').run();
      sqlite.pragma('journal_mode = DELETE');
      sqlite.exec('VACUUM');
    } finally {
      sqlite.close();
    }
  }

  /** Writes the BAK-2 archive of a finished snapshot to `zipFile`. */
  private async archive(snapshotFile: string, zipFile: string) {
    const entries: { path: string; data?: Buffer; file?: string }[] = [];
    const files: BackupManifest['files'] = [];
    const database = readFileSync(snapshotFile);
    entries.push({ path: 'database.sqlite', file: snapshotFile });
    files.push({ path: 'database.sqlite', size: database.length, sha256: sha256(database) });
    const configText = this.context.configFile.text;
    if (configText !== null) {
      const data = Buffer.from(configText, 'utf8');
      entries.push({ path: 'config.yaml', data });
      files.push({ path: 'config.yaml', size: data.length, sha256: sha256(data) });
    }
    const snapshot = new BetterSqlite3(snapshotFile, { readonly: true });
    const manifest: BackupManifest = {
      format: backupFormat,
      formatVersion: backupFormatVersion,
      appVersion: this.context.version,
      schemaVersion: schemaVersion(snapshot),
      createdAt: new Date().toISOString(),
      files,
    };
    snapshot.close();
    await writeZip(zipFile, [{ path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }, ...entries]);
  }

  /**
   * `GET /api/admin/backup` (BAK-1, BAK-9): takes the `backup` state, drains
   * the data writes, snapshots the database and releases the state; then
   * builds the archive. Returns the archive's file; `cleanup()` deletes it.
   */
  async createBackup() {
    const dir = this.workDir('backup');
    try {
      const snapshot = join(dir, 'database.sqlite');
      await this.context.operations.begin('backup');
      try {
        await this.snapshot(snapshot);
        await this.hooks.afterSnapshot?.();
      } finally {
        this.context.operations.end('idle');
      }
      BackupService.finishSnapshot(snapshot);
      const fileName = `agt-trivia-backup-${fileTimestamp()}.zip`;
      const file = join(dir, fileName);
      await this.archive(snapshot, file);
      this.log.info({ source: 'backup', size: statSync(file).size }, `Backup ${fileName} created.`);
      return { file, fileName, size: statSync(file).size, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** BAK-4 step 3: the pre-restore backup, written while the restore holds the lock, and kept. */
  private async preRestoreBackup() {
    const dir = this.workDir('pre-restore');
    try {
      const snapshot = join(dir, 'database.sqlite');
      await this.snapshot(snapshot);
      BackupService.finishSnapshot(snapshot);
      const fileName = `pre-restore-backup-${fileTimestamp()}.zip`;
      await this.archive(snapshot, join(this.backupsDir, fileName));
      return fileName;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * BAK-3: validates an uploaded archive without changing anything: the
   * manifest and checksums, only expected paths, the size and entry limits,
   * the database's integrity, objects, schema version, foreign keys, required
   * tables and Admin hash; and how its config.yaml differs.
   */
  private async inspect(upload: string, dir: string): Promise<Inspection> {
    const limits = this.limits();
    if (statSync(upload).size > limits.maxZipBytes) throw new ArchiveRejectedError('too_large', `The file is larger than ${limits.maxZipBytes} bytes.`);
    const zip = await openSafeZip(upload, { maxEntries: limits.maxEntries, maxUncompressedBytes: limits.maxUncompressedBytes }, archivePaths);
    let configText: string | null = null;
    const databaseFile = join(dir, 'database.sqlite');
    let manifest: BackupManifest;
    try {
      if (!zip.entries.some((entry) => entry.path === 'manifest.json')) throw new ArchiveRejectedError('missing_manifest', 'The archive has no manifest.json.');
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readEntry(zip, 'manifest.json', maxManifestBytes)).toString('utf8'));
      } catch (error) {
        if (error instanceof ArchiveRejectedError) throw error;
        throw new ArchiveRejectedError('invalid_manifest', 'manifest.json is not valid JSON.');
      }
      manifest = checkManifest(parsed);
      const listed = new Map(manifest.files.map((file) => [file.path, file]));
      const unlisted = zip.entries.find((entry) => entry.path !== 'manifest.json' && !listed.has(entry.path));
      if (unlisted) throw new ArchiveRejectedError('unlisted_file', `${unlisted.path} is in the archive but not in its manifest.`);
      for (const file of manifest.files) {
        const entry = zip.entries.find((candidate) => candidate.path === file.path);
        if (!entry) throw new ArchiveRejectedError('missing_file', `${file.path} is listed in the manifest but missing from the archive.`);
        if (entry.size !== file.size) throw new ArchiveRejectedError('checksum_mismatch', `${file.path} does not have the size its manifest lists.`);
      }
      if (!listed.has('database.sqlite')) throw new ArchiveRejectedError('missing_file', 'The archive has no database.sqlite.');
      for (const file of manifest.files) {
        let digest: string;
        if (file.path === 'database.sqlite') {
          const hash = hasher();
          await extractEntry(zip, zip.entries.find((entry) => entry.path === file.path)!, databaseFile, [hash.stream]);
          digest = hash.digest();
        } else {
          const data = await readEntry(zip, file.path, maxConfigBytes);
          digest = sha256(data);
          configText = data.toString('utf8');
        }
        if (digest !== file.sha256) throw new ArchiveRejectedError('checksum_mismatch', `${file.path} does not match its checksum.`);
      }
    } finally {
      zip.close();
    }

    const sqlite = openUntrusted(databaseFile);
    let report: RestoreReport;
    try {
      checkObjects(sqlite);
      const version = schemaVersion(sqlite);
      if (version > SCHEMA_VERSION) throw new ArchiveRejectedError('newer_schema', `The backup's database schema ${version} is newer than this version supports (${SCHEMA_VERSION}).`);
      if (version !== manifest.schemaVersion) throw new ArchiveRejectedError('schema_mismatch', `The database's schema version ${version} differs from the manifest's ${manifest.schemaVersion}.`);
      if ((sqlite.pragma('foreign_key_check') as unknown[]).length) throw new ArchiveRejectedError('invalid_database', 'The database has foreign key violations.');
      // Older backups are migrated here, on the copy (DATA-4, BAK-4 step 5).
      try {
        runMigrations(sqlite);
      } catch (error) {
        throw new ArchiveRejectedError('invalid_database', `The database cannot be migrated: ${error instanceof Error ? error.message : String(error)}`);
      }
      const missing = missingTables(sqlite);
      if (missing.length) throw new ArchiveRejectedError('missing_tables', `The database lacks the tables ${missing.join(', ')}.`);
      const admin = sqlite.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get() as { username: string; password_hash: string } | undefined;
      // AUTH-2: a hash that fails the format check could never sign in.
      if (admin && parseHash(admin.password_hash) === null) throw new ArchiveRejectedError('invalid_admin', 'The backup\'s Admin password hash is malformed or uses unsupported parameters.');
      const settings = (sqlite.prepare('SELECT key FROM settings').all() as { key: string }[]).map((row) => row.key);
      const locked = new Set<string>(lockedSettingKeys(this.context.config));
      const current = this.context.configFile.text;
      report = {
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        schemaVersion: { backup: version, current: SCHEMA_VERSION },
        counts: {
          categories: (sqlite.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n,
          questions: (sqlite.prepare('SELECT count(*) AS n FROM questions').get() as { n: number }).n,
          admin: admin ? 1 : 0,
          settings: settings.filter((key) => (settingKeys as readonly string[]).includes(key)).length,
        },
        adminUsername: admin?.username ?? null,
        ignoredSettings: settings.filter((key) => locked.has(key)).sort(),
        warningCodes: admin ? [] : ['no_admin'],
        config: {
          included: configText !== null,
          identical: configText !== null && configText === current,
          diff: configText === null ? [] : lineDiff(current ?? '', configText),
          content: configText,
        },
        preRestoreBackup: null,
      };
    } finally {
      sqlite.close();
    }
    return { report, databaseFile };
  }

  /** `action=preview` (BAK-3): the report; nothing changes. */
  async preview(upload: string) {
    const dir = this.workDir('preview');
    try {
      return (await this.inspect(upload, dir)).report;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * `action=restore` (BAK-4). Validates the upload again (step 1), takes the
   * `restore` state and drains (step 2), writes the pre-restore backup (step
   * 3), swaps the database file (step 4), migrates and checks it (step 5),
   * commits the settings and sessions cleanup (step 6.1), deletes what it set
   * aside (step 6.2) and releases the lock (step 6.3). A failure in steps 4 to
   * 6.1 rolls back (BAK-10), or, if that fails too, leaves `restore_failed`
   * (BAK-11). `caller` is the restoring Admin's session, kept for recovery.
   */
  async restore(upload: string, caller: RecoverySession): Promise<RestoreReport> {
    const lock = this.context.operations;
    const recovery = lock.state === 'restore_failed';
    const dir = this.workDir('restore');
    try {
      const { report, databaseFile } = await this.inspect(upload, dir);
      await lock.begin('restore', { recovery, ownActivity: 1 });
      if (!recovery) lock.recovery = caller;
      let preRestore: string | null;
      try {
        preRestore = recovery ? this.markedPreRestore() : await this.preRestoreBackup();
      } catch (error) {
        lock.end('idle');
        this.log.error({ source: 'backup', err: error }, 'The pre-restore backup failed; nothing was changed.');
        throw error;
      }

      const stamp = fileTimestamp();
      const live = this.context.db.file;
      const setAside: [string, string][] = [];
      let dropped: string[];
      try {
        // Step 4: the new file beside the live one; checkpoint and close; rename aside; rename into place; reopen.
        const incoming = `${live}.restore-new-${stamp}`;
        copyFileSync(databaseFile, incoming);
        if (this.context.db.open) this.context.db.connection.pragma('wal_checkpoint(TRUNCATE)');
        this.context.db.close();
        for (const suffix of ['', '-wal', '-shm']) {
          if (!existsSync(`${live}${suffix}`)) continue;
          const aside = `${live}${suffix}.restore-old-${stamp}`;
          renameSync(`${live}${suffix}`, aside);
          setAside.push([`${live}${suffix}`, aside]);
        }
        renameSync(incoming, live);
        this.hooks.afterSwap?.();
        // Step 5: migrations, then the health check.
        const sqlite = openSqlite(live);
        this.context.db.replace(sqlite);
        runMigrations(sqlite);
        healthCheck(sqlite);
        // Step 6.1: settings config.yaml locks, and every session, in one transaction.
        dropped = asOperation(() => this.context.db.transaction((connection) => {
          const locked = lockedSettingKeys(this.context.config);
          const present = locked.filter((key) => connection.prepare('SELECT 1 FROM settings WHERE key = ?').get(key));
          for (const key of locked) connection.prepare('DELETE FROM settings WHERE key = ?').run(key);
          connection.prepare('DELETE FROM sessions').run();
          this.hooks.duringCommit?.();
          return present;
        }));
      } catch (error) {
        this.failed(error, setAside, preRestore, recovery);
      }

      // Step 6.2: delete what was set aside; a failure is only a warning.
      const left: string[] = [];
      for (const [, aside] of setAside) {
        try {
          (this.hooks.deleteSetAside ?? unlinkSync)(aside);
        } catch {
          left.push(aside);
        }
      }
      if (left.length) this.log.warn({ source: 'backup', paths: left }, `The restore could not delete ${left.join(', ')}; delete them by hand.`);
      // A recovery restore ends the failed state: its marker goes.
      if (recovery) rmSync(markerFile(this.context.dataDir), { force: true });
      // Step 6.3.
      lock.end('idle');
      this.log.info({ source: 'backup', preRestoreBackup: preRestore }, `Backup restored${preRestore ? `; the replaced data was saved as ${preRestore}` : ''}.`);
      return {
        ...report,
        ignoredSettings: [...new Set([...report.ignoredSettings, ...dropped!])].sort(),
        warningCodes: [...report.warningCodes, ...(left.length ? ['set_aside_not_deleted' as const] : [])],
        preRestoreBackup: preRestore,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The pre-restore backup the BAK-11 marker names. */
  private markedPreRestore(): string | null {
    try {
      const marker = JSON.parse(readFileSync(markerFile(this.context.dataDir), 'utf8')) as { preRestoreBackup?: unknown };
      return typeof marker.preRestoreBackup === 'string' ? marker.preRestoreBackup : null;
    } catch {
      return null;
    }
  }

  /**
   * A failure in steps 4 to 6.1. BAK-10: put the set-aside files back, reopen
   * and check them, and answer `500` with the lock back to `idle`. A recovery
   * restore has nothing to roll back to, and a rollback that fails leaves the
   * app in `restore_failed` with the marker file (BAK-11).
   */
  private failed(cause: unknown, setAside: [string, string][], preRestore: string | null, recovery: boolean): never {
    const lock = this.context.operations;
    this.log.error({ source: 'backup', err: cause }, 'The restore failed.');
    if (recovery) {
      lock.end('restore_failed');
      throw new HttpError(500, 'internal', 'The restore failed. The app stays in maintenance.');
    }
    try {
      this.context.db.close();
      const live = this.context.db.file;
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true });
      for (const [original, aside] of setAside) renameSync(aside, original);
      this.hooks.duringRollback?.();
      const sqlite = openSqlite(live);
      this.context.db.replace(sqlite);
      healthCheck(sqlite);
    } catch (rollbackError) {
      this.enterFailed(preRestore, rollbackError);
      throw new HttpError(500, 'internal', 'The restore failed and could not be rolled back. The app stays in maintenance.');
    }
    lock.end('idle');
    this.log.error({ source: 'backup' }, 'The restore failed and was rolled back. Nothing was changed.');
    throw new HttpError(500, 'internal', 'The restore failed and was rolled back. Nothing was changed.');
  }

  /** BAK-11: maintenance until a recovery restore or the operator fixes it; the marker stops later starts. */
  private enterFailed(preRestore: string | null, cause: unknown) {
    this.context.operations.end('restore_failed');
    try {
      writeFileSync(markerFile(this.context.dataDir), `${JSON.stringify({ preRestoreBackup: preRestore, failedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (error) {
      this.log.error({ source: 'backup', err: error }, 'The restore-failed marker file could not be written.');
    }
    this.log.error(
      { source: 'backup', err: cause, preRestoreBackup: preRestore },
      `The restore failed and so did its rollback. The app stays in maintenance. The data before the restore is in ${preRestore ?? '(no pre-restore backup)'} in the backups directory; see README, Troubleshooting.`,
    );
  }
}
