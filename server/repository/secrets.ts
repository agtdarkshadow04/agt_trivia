import { assertDataWrite } from '../dataWrite.js';
import type { Database } from '../db.js';

/**
 * The `app_secrets` table (SEC-8): generated secrets that belong to the data,
 * such as the quiz attempt key (#45). They are written only at startup and at
 * the end of a restore, never by a request, and never logged or returned.
 */

export function getSecret(db: Database, name: string): string | null {
  const row = db.connection.prepare('SELECT value FROM app_secrets WHERE name = ?').get(name) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Stores `value` under `name` unless the name already has one; returns whether it was stored. */
export function insertSecretIfMissing(db: Database, name: string, value: string, now = new Date()): boolean {
  assertDataWrite();
  const at = now.toISOString();
  return db.connection.prepare('INSERT INTO app_secrets (name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING')
    .run(name, value, at, at).changes > 0;
}
