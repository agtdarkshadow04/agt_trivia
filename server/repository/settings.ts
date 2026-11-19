import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';
import type { StoredSettings } from '../context.js';

/** The `settings` table (CFG-6). Values are stored as JSON; callers validate them first (CFG-8). */

/** Every stored setting, by key. A value that is not valid JSON cannot exist (the table checks it). */
export function readSettings(db: Database): StoredSettings {
  const rows = db.connection.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
}

/** Sets or, for `null`, removes each key, in one transaction. */
export function writeSettings(db: Database, values: Readonly<Record<string, unknown>>, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  db.transaction((sqlite) => {
    const upsert = sqlite.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const remove = sqlite.prepare('DELETE FROM settings WHERE key = ?');
    for (const [key, value] of Object.entries(values)) {
      if (value === null) remove.run(key);
      else upsert.run(key, JSON.stringify(value), at, at);
    }
  });
}
