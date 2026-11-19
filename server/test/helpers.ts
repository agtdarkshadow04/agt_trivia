import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { withDataWrite } from '../dataWrite.js';
import { Database, openDatabase, openSqlite, runMigrations } from '../db.js';
import { openLogStore } from '../logs.js';
import { OperationLock, type OperationTimings } from '../operation.js';
import { adminSessionCookie, AdminAuthService } from '../session.js';

export interface TestContextOptions {
  setupPassword?: string | null;
  now?: () => Date;
  /** The operation lock's timings; tests of the 30-second drain use short ones (BAK-8). */
  timings?: Partial<OperationTimings>;
  /** A database file in the data directory instead of `:memory:`, for backups and restores (BAK-4). */
  file?: boolean;
}

export type TestContext = AppContext & { close(): void };

/**
 * A context on a fresh, migrated database (TEST-3), in-memory unless `file` is
 * set, with its own temporary data directory. `config` is `config.yaml` text;
 * call `close()` in `after()`.
 */
export function testContext(config = '', options: TestContextOptions = {}): TestContext {
  const dataDir = mkdtempSync(join(tmpdir(), 'agt-trivia-test-'));
  let db: Database;
  if (options.file) {
    db = openDatabase(join(dataDir, 'agt-trivia.sqlite')).db;
  } else {
    const sqlite = openSqlite(':memory:');
    runMigrations(sqlite);
    db = new Database(sqlite);
  }
  const { store: logs } = openLogStore(':memory:', { now: options.now });
  return {
    config: parseConfig(config),
    configFile: { path: 'config.yaml', text: config || null },
    db,
    dataDir,
    logs,
    operations: new OperationLock({ drainMs: 30_000, writeWaitMs: 30_000, pollMs: 5, ...options.timings }),
    setupPassword: options.setupPassword === undefined ? testSetupPassword : options.setupPassword,
    version: '0.0.0-test',
    close: () => {
      db.close();
      logs.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The setup password test contexts get unless they pass another (or null). */
export const testSetupPassword = 'setup-password-for-tests';

/** The Admin the sign-in helpers create. */
export const testAdmin = { username: 'keeper', password: 'Admin-Password-1!' };

const silentLog = { error: () => undefined, info: () => undefined };

/** Creates the Admin (unless it exists) and returns a `cookie` header value with a new session. */
export async function adminCookie(context: AppContext) {
  const auth = new AdminAuthService(context);
  const session = auth.adminExists()
    ? await auth.login(testAdmin.username, testAdmin.password, silentLog)
    : await withDataWrite(context.operations, () => auth.setup({ setupPassword: context.setupPassword ?? '', ...testAdmin }, silentLog));
  return `${adminSessionCookie}=${session.token}`;
}

/** The headers of a signed-in Admin write: the session cookie and the CSRF header. */
export async function adminWriteHeaders(context: AppContext) {
  return { cookie: await adminCookie(context), 'x-agt-request': '1' };
}

/** The SQLite change counter: how many rows inserts, updates and deletes touched so far. */
export function totalChanges(context: AppContext) {
  return (context.db.connection.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}
