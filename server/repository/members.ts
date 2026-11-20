import type { AdminMember, AuthSource, MemberRole, MemberSession } from '../../src/lib/api.js';
import { assertDataWrite } from '../dataWrite.js';
import type { Database, Sqlite } from '../db.js';

/**
 * The `members` and `member_sessions` tables (#17). Writing a member is a data
 * write (BAK-8); session rows alone are not, so the session functions do not
 * call `assertDataWrite()`. Callers validate and normalize input first.
 */

interface MemberRow {
  id: string;
  auth_source: AuthSource;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  role: MemberRole;
  is_active: number;
  created_at: string;
  updated_at: string;
  iam_traveller_id: string | null;
  iam_permission: string | null;
  last_sign_in_at: string | null;
}

export interface MemberCredentials {
  member: AdminMember;
  passwordHash: string;
}

function toMember(row: MemberRow): AdminMember {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    authSource: row.auth_source,
    isActive: row.is_active === 1,
    travellerId: row.iam_traveller_id,
    iamPermission: row.iam_permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSignInAt: row.last_sign_in_at,
  };
}

/** The session view of a member: what `GET /api/member/session` returns. */
export function toSession(member: AdminMember): MemberSession {
  const { id, username, displayName, role, authSource } = member;
  return { id, username, displayName, role, authSource };
}

export function getMember(db: Database, id: string): AdminMember | null {
  const row = db.connection.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

export function usernameTaken(db: Database, username: string) {
  return db.connection.prepare('SELECT 1 FROM members WHERE username = ?').get(username) !== undefined;
}

/** A local member's account and password hash by username (stored lowercase), active or not. */
export function localMemberByUsername(db: Database, username: string): MemberCredentials | null {
  const row = db.connection.prepare("SELECT * FROM members WHERE username = ? AND auth_source = 'local'").get(username) as MemberRow | undefined;
  return row ? { member: toMember(row), passwordHash: row.password_hash! } : null;
}

export function localMemberCredentials(db: Database, id: string): MemberCredentials | null {
  const row = db.connection.prepare("SELECT * FROM members WHERE id = ? AND auth_source = 'local'").get(id) as MemberRow | undefined;
  return row ? { member: toMember(row), passwordHash: row.password_hash! } : null;
}

export interface MemberPagePosition {
  createdAt: string;
  id: string;
}

/**
 * One page of members, newest first, the ID breaking ties (API-8); `after` is
 * the last member of the previous page. `search` matches the username or the
 * display name, ignoring ASCII case.
 */
export function listMembers(db: Database, options: { limit: number; after: MemberPagePosition | null; search: string; signedInBefore?: string | null }) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (options.signedInBefore) {
    // #48: never signed in, or not since then.
    conditions.push('(last_sign_in_at IS NULL OR last_sign_in_at < ?)');
    values.push(options.signedInBefore);
  }
  if (options.after) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(options.after.createdAt, options.after.createdAt, options.after.id);
  }
  if (options.search) {
    const pattern = `%${options.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    conditions.push("(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
    values.push(pattern, pattern);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.connection.prepare(`SELECT * FROM members ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, options.limit + 1) as MemberRow[];
  return { members: rows.slice(0, options.limit).map(toMember), more: rows.length > options.limit };
}

export interface NewLocalMember {
  id: string;
  username: string;
  displayName: string;
  role: MemberRole;
  passwordHash: string;
}

export function insertLocalMember(db: Database, input: NewLocalMember, now = new Date()): AdminMember {
  assertDataWrite();
  const at = now.toISOString();
  db.connection.prepare(`INSERT INTO members (id, auth_source, username, display_name, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, 'local', ?, ?, ?, ?, 1, ?, ?)`).run(input.id, input.username, input.displayName, input.passwordHash, input.role, at, at);
  return getMember(db, input.id)!;
}

/** Replaces the Admin-editable fields of a member. */
export function updateMember(db: Database, id: string, input: { displayName: string; role: MemberRole; isActive: boolean }, now = new Date()) {
  assertDataWrite();
  db.connection.prepare('UPDATE members SET display_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?')
    .run(input.displayName, input.role, input.isActive ? 1 : 0, now.toISOString(), id);
  return getMember(db, id)!;
}

export function updateMemberPassword(db: Database, id: string, passwordHash: string, now = new Date()) {
  assertDataWrite();
  db.connection.prepare('UPDATE members SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, now.toISOString(), id);
}

/**
 * Deletes a member: their sessions go with them (`ON DELETE CASCADE`), and the
 * questions they wrote, approved or changed keep everything but the member's
 * ID (#15), and so do the reports they sent or resolved (#46), in the same
 * transaction.
 */
export function deleteMember(db: Database, id: string) {
  assertDataWrite();
  db.transaction((sqlite) => {
    for (const column of ['created_by', 'approved_by', 'modified_by'] as const) {
      sqlite.prepare(`UPDATE questions SET ${column} = NULL WHERE ${column} = ?`).run(id);
    }
    for (const column of ['member_id', 'resolved_by'] as const) {
      sqlite.prepare(`UPDATE question_reports SET ${column} = NULL WHERE ${column} = ?`).run(id);
    }
    sqlite.prepare('DELETE FROM members WHERE id = ?').run(id);
  });
}

// --- Sessions (AUTH-8) ------------------------------------------------------------

/**
 * Records a successful sign-in (#48). A data write (BAK-8), unlike the session
 * row; `updated_at` stays, since the account itself did not change.
 */
export function recordMemberSignIn(db: Database, id: string, now = new Date()) {
  assertDataWrite();
  db.connection.prepare('UPDATE members SET last_sign_in_at = ? WHERE id = ?').run(now.toISOString(), id);
}

/** Stores a member session and purges the expired ones. */
export function insertMemberSession(sqlite: Sqlite, tokenHash: string, memberId: string, expiresAt: Date, now = new Date()) {
  const at = now.toISOString();
  sqlite.prepare('DELETE FROM member_sessions WHERE expires_at <= ?').run(at);
  sqlite.prepare('INSERT INTO member_sessions (token_hash, member_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash, memberId, expiresAt.toISOString(), at, at);
}

/** The active member of an unexpired session, or null. */
export function memberForSession(db: Database, tokenHash: string, now = new Date()): AdminMember | null {
  const row = db.connection.prepare(`SELECT members.* FROM member_sessions JOIN members ON members.id = member_sessions.member_id
    WHERE member_sessions.token_hash = ? AND member_sessions.expires_at > ? AND members.is_active = 1`).get(tokenHash, now.toISOString()) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

export function deleteMemberSession(db: Database, tokenHash: string) {
  db.connection.prepare('DELETE FROM member_sessions WHERE token_hash = ?').run(tokenHash);
}

/** AUTH-4: ends every session of one member. */
export function deleteMemberSessions(sqlite: Sqlite, memberId: string) {
  sqlite.prepare('DELETE FROM member_sessions WHERE member_id = ?').run(memberId);
}

// --- AGT members (#18) ---------------------------------------------------------------

/** An AGT member by traveller ID, active or not. */
export function iamMember(db: Database, travellerId: string): AdminMember | null {
  const row = db.connection.prepare("SELECT * FROM members WHERE iam_traveller_id = ? AND auth_source = 'agt_iam'").get(travellerId) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

export interface IamMemberInput {
  travellerId: string;
  /** The traveller name, also the display name (an empty one shows as the traveller ID). */
  travellerName: string;
  permission: string;
  role: MemberRole;
}

const displayNameOf = (input: IamMemberInput) => (input.travellerName || input.travellerId).slice(0, 120);

/** Creates an AGT member at their first sign-in: no username, no password. */
export function insertIamMember(db: Database, id: string, input: IamMemberInput, now = new Date()): AdminMember {
  assertDataWrite();
  const at = now.toISOString();
  db.connection.prepare(`INSERT INTO members (id, auth_source, username, display_name, password_hash, role, is_active, created_at, updated_at,
    iam_traveller_id, iam_traveller_name, iam_permission, iam_synced_at) VALUES (?, 'agt_iam', NULL, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(id, displayNameOf(input), input.role, at, at, input.travellerId, input.travellerName || null, input.permission || null, at);
  return getMember(db, id)!;
}

/** Refreshes an AGT member's name, tier and role from IAM at a sign-in. */
export function updateIamMember(db: Database, id: string, input: IamMemberInput, now = new Date()): AdminMember {
  assertDataWrite();
  const at = now.toISOString();
  db.connection.prepare(`UPDATE members SET display_name = ?, role = ?, iam_traveller_name = ?, iam_permission = ?, iam_synced_at = ?, updated_at = ?
    WHERE id = ?`).run(displayNameOf(input), input.role, input.travellerName || null, input.permission || null, at, at, id);
  return getMember(db, id)!;
}

/** Switching AGT sign-in off ends every AGT member's session (AUTH-4). */
export function deleteIamMemberSessions(sqlite: Sqlite) {
  sqlite.prepare("DELETE FROM member_sessions WHERE member_id IN (SELECT id FROM members WHERE auth_source = 'agt_iam')").run();
}

// --- Leaderboard opt-in (#49) -----------------------------------------------------

export function leaderboardOptIn(db: Database, id: string): boolean {
  const row = db.connection.prepare('SELECT leaderboard_opt_in FROM members WHERE id = ?').get(id) as { leaderboard_opt_in: number } | undefined;
  return row?.leaderboard_opt_in === 1;
}

/** The member's own choice; `updated_at` stays, as for a sign-in (#48). */
export function setLeaderboardOptIn(db: Database, id: string, optIn: boolean) {
  assertDataWrite();
  db.connection.prepare('UPDATE members SET leaderboard_opt_in = ? WHERE id = ?').run(optIn ? 1 : 0, id);
}
