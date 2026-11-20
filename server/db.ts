import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import settingsMigration from './migrations/0001_settings.sql';
import adminSessionsMigration from './migrations/0002_admin_sessions.sql';
import categoriesQuestionsMigration from './migrations/0003_categories_questions.sql';
import membersMigration from './migrations/0004_members.sql';
import agtIamMembersMigration from './migrations/0005_agt_iam_members.sql';
import questionAuthoringMigration from './migrations/0006_question_authoring.sql';
import quizResultsMigration from './migrations/0007_quiz_results.sql';
import quizAttemptsMigration from './migrations/0008_quiz_attempts.sql';
import questionReportsMigration from './migrations/0009_question_reports.sql';
import memberLastSignInMigration from './migrations/0010_member_last_sign_in.sql';
import leaderboardOptInMigration from './migrations/0011_leaderboard_opt_in.sql';

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
  { version: 3, name: '0003_categories_questions', sql: categoriesQuestionsMigration },
  { version: 4, name: '0004_members', sql: membersMigration },
  { version: 5, name: '0005_agt_iam_members', sql: agtIamMembersMigration },
  { version: 6, name: '0006_question_authoring', sql: questionAuthoringMigration },
  { version: 7, name: '0007_quiz_results', sql: quizResultsMigration },
  { version: 8, name: '0008_quiz_attempts', sql: quizAttemptsMigration },
  { version: 9, name: '0009_question_reports', sql: questionReportsMigration },
  { version: 10, name: '0010_member_last_sign_in', sql: memberLastSignInMigration },
  { version: 11, name: '0011_leaderboard_opt_in', sql: leaderboardOptInMigration },
];

/** The schema version this build creates and supports. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Every table of the main database; a restored database must have them all (DATA-5, BAK-3). */
export const EXPECTED_TABLES: readonly string[] = ['settings', 'admin', 'sessions', 'categories', 'questions', 'question_choices', 'members', 'member_sessions', 'quiz_results', 'quiz_result_answers', 'app_secrets', 'question_reports'];

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
  /** `file` is the database's path, which a restore replaces (BAK-4); `:memory:` in tests. */
  constructor(private sqlite: Sqlite, readonly file = ':memory:') {}

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

  /** Whether the connection is open; false while a restore has the file closed. */
  get open() {
    return this.sqlite.open;
  }

  /** BAK-4 step 4: the restore swaps the connection after renaming the files. */
  replace(sqlite: Sqlite) {
    this.close();
    this.sqlite = sqlite;
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
    return { db: new Database(sqlite, file), applied, schemaVersion: schemaVersion(sqlite) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
