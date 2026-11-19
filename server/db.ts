import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import settingsMigration from './migrations/0001_settings.sql';
import adminSessionsMigration from './migrations/0002_admin_sessions.sql';

/**
 * The SQLite database (DATA-1, DATA-5): one file in `storage.dataDir`, opened
 * with WAL, foreign keys and a busy timeout, its schema version in
 * `PRAGMA user_version`, migrated at startup. Only this file and
 * `server/repository/*.ts` touch SQL (SRV-4).
 */

export type Sqlite = BetterSqlite3.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Numbered plain-SQL migrations (DATA-3), applied in order. Never edit or
 * reorder a released migration; add a new file and append it here.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_settings', sql: settingsMigration },
  { version: 2, name: '0002_admin_sessions', sql: adminSessionsMigration },
];

/** The schema version this build creates and supports. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Every table of the main database; a restored database must have them all (DATA-5, BAK-3). */
export const EXPECTED_TABLES: readonly string[] = ['settings', 'admin', 'sessions'];

export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`The database schema version ${found} is newer than this version of the app supports (${supported}). Run a newer release, or restore a backup made by this one.`);
    this.name = 'SchemaTooNewError';
  }
}

export function schemaVersion(sqlite: Sqlite): number {
  return sqlite.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies the pending migrations, each in its own transaction with its
 * `user_version` (DATA-4). A schema newer than `migrations` knows stops here,
 * before anything changes (SRV-8). Returns the migrations it applied.
 */
export function runMigrations(sqlite: Sqlite, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  const current = schemaVersion(sqlite);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) throw new SchemaTooNewError(current, latest);
  const applied: Migration[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite.pragma(`user_version = ${migration.version}`);
    })();
    applied.push(migration);
  }
  return applied;
}

/** Opens a SQLite file with the standard pragmas (DATA-5), creating its directory. `:memory:` is for tests. */
export function openSqlite(file: string): Sqlite {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new BetterSqlite3(file);
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  return sqlite;
}

/** The expected tables a database lacks. */
export function missingTables(sqlite: Sqlite): string[] {
  const present = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  return EXPECTED_TABLES.filter((table) => !present.has(table));
}

/**
 * The app's handle on the main database. Routes and services reach SQLite only
 * through it, so a restore (#13) can swap the file underneath.
 */
export class Database {
  constructor(private sqlite: Sqlite) {}

  /** The open connection, for the repository functions. */
  get connection(): Sqlite {
    return this.sqlite;
  }

  /** Runs `work` in one transaction (nested calls become savepoints). */
  transaction<T>(work: (sqlite: Sqlite) => T): T {
    return this.sqlite.transaction(() => work(this.sqlite))();
  }

  /** SRV-11: a trivial query, so the health check fails when the database does. */
  ping() {
    this.sqlite.prepare('SELECT 1').get();
  }

  close() {
    if (this.sqlite.open) this.sqlite.close();
  }
}

export interface OpenedDatabase {
  db: Database;
  /** The migrations this start applied, for the server log (LOG-8). */
  applied: Migration[];
  schemaVersion: number;
}

/** Opens and migrates the main database (DATA-4); closes it again if migrating fails. */
export function openDatabase(file: string): OpenedDatabase {
  const sqlite = openSqlite(file);
  try {
    const applied = runMigrations(sqlite);
    return { db: new Database(sqlite), applied, schemaVersion: schemaVersion(sqlite) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
