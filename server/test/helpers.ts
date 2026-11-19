import { parseConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { withDataWrite } from '../dataWrite.js';
import { Database, openSqlite, runMigrations } from '../db.js';
import { openLogStore } from '../logs.js';
import { adminSessionCookie, AdminAuthService } from '../session.js';

/**
 * A context on a fresh, migrated in-memory database (TEST-3). `config` is
 * `config.yaml` text; call `close()` in `after()`.
 */
export function testContext(config = '', options: { setupPassword?: string | null; now?: () => Date } = {}): AppContext & { close(): void } {
  const sqlite = openSqlite(':memory:');
  runMigrations(sqlite);
  const db = new Database(sqlite);
  const { store: logs } = openLogStore(':memory:', { now: options.now });
  return {
    config: parseConfig(config),
    configFile: { path: 'config.yaml', text: config || null },
    db,
    logs,
    setupPassword: options.setupPassword === undefined ? testSetupPassword : options.setupPassword,
    version: '0.0.0-test',
    close: () => { db.close(); logs.close(); },
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
    : await withDataWrite(() => auth.setup({ setupPassword: context.setupPassword ?? '', ...testAdmin }, silentLog));
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
