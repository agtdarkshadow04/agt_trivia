import { assertDataWrite } from '../dataWrite.js';
import type { Database, Sqlite } from '../db.js';

/**
 * The `admin` row and the Admin's `sessions` (AUTH-1, AUTH-8). Writing the
 * Admin account is a data write (BAK-8); session rows alone are not, so the
 * session functions do not call `assertDataWrite()`.
 */

export interface AdminRow {
  username: string;
  password_hash: string;
}

export function adminAccount(db: Database): AdminRow | null {
  return (db.connection.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get() as AdminRow | undefined) ?? null;
}

export function adminExists(db: Database) {
  return db.connection.prepare('SELECT 1 FROM admin WHERE id = 1').get() !== undefined;
}

/** Creates the Admin; false when one already exists (a concurrent setup won). */
export function insertAdmin(sqlite: Sqlite, username: string, passwordHash: string, now = new Date()) {
  assertDataWrite();
  const at = now.toISOString();
  return sqlite.prepare('INSERT INTO admin (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
    .run(username, passwordHash, at, at).changes === 1;
}

export function updateAdminPassword(sqlite: Sqlite, passwordHash: string, now = new Date()) {
  assertDataWrite();
  sqlite.prepare('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1').run(passwordHash, now.toISOString());
}

/** Stores a new session and purges the expired ones (AUTH-8). */
export function insertSession(sqlite: Sqlite, tokenHash: string, expiresAt: Date, now = new Date()) {
  const at = now.toISOString();
  sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at);
  sqlite.prepare('INSERT INTO sessions (token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run(tokenHash, expiresAt.toISOString(), at, at);
}

/** The Admin's username for an unexpired session, or null. */
export function adminForSession(db: Database, tokenHash: string, now = new Date()): string | null {
  const row = db.connection.prepare(`SELECT admin.username FROM sessions JOIN admin ON admin.id = 1
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash, now.toISOString()) as { username: string } | undefined;
  return row?.username ?? null;
}

export function deleteSession(db: Database, tokenHash: string) {
  db.connection.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteAllSessions(sqlite: Sqlite) {
  sqlite.prepare('DELETE FROM sessions').run();
}

/** When an unexpired session ends; the BAK-11 recovery session keeps this expiry. */
export function sessionExpiry(db: Database, tokenHash: string): Date | null {
  const row = db.connection.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { expires_at: string } | undefined;
  return row ? new Date(row.expires_at) : null;
}
