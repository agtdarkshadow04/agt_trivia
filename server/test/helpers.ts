import { parseConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { Database, openSqlite, runMigrations } from '../db.js';

/**
 * A context on a fresh, migrated in-memory database (TEST-3). `config` is
 * `config.yaml` text; call `close()` in `after()`.
 */
export function testContext(config = ''): AppContext & { close(): void } {
  const sqlite = openSqlite(':memory:');
  runMigrations(sqlite);
  const db = new Database(sqlite);
  return {
    config: parseConfig(config),
    configFile: { path: 'config.yaml', text: config || null },
    db,
    version: '0.0.0-test',
    close: () => db.close(),
  };
}

/** The SQLite change counter: how many rows inserts, updates and deletes touched so far. */
export function totalChanges(context: AppContext) {
  return (context.db.connection.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}
