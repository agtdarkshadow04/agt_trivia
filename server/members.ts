import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminMember, MemberRole, MemberSession } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { displayNameError, errorsOf, memberUsernameError, newPasswordError, normalizeMemberUsername } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import * as repo from './repository/members.js';
import { hashSessionToken, invalidCredentials, plausibleToken, type AuthLog } from './session.js';

/**
 * Member accounts (#17, the AUTH-1 deviation): sign-in, sessions and the
 * password change of local members (`MemberAuthService`), and the Admin's
 * management of them (`AdminMemberService`). Ported from the AGT Knowledge
 * Base, for SQLite. Anything that ends a member's access ends their sessions
 * (AUTH-4).
 */

export interface MemberSessionResult {
  token: string;
  expiresAt: Date;
  member: MemberSession;
}

function validation(errors: FieldError[]): never {
  throw new HttpError(400, 'validation_failed', errors.map((error) => error.message).join(' '), { fields: errors });
}

function notFound(): never {
  throw new HttpError(404, 'not_found', 'The member does not exist.');
}

export class MemberAuthService {
  constructor(private readonly context: Pick<AppContext, 'config' | 'db'>) {}

  /** A new session for a member (AUTH-8), on `sqlite` when it runs inside a transaction. */
  newSession(member: AdminMember, sqlite = this.context.db.connection): MemberSessionResult {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.context.config.session.ttlHours * 60 * 60 * 1000);
    repo.insertMemberSession(sqlite, hashSessionToken(token), member.id, expiresAt);
    return { token, expiresAt, member: repo.toSession(member) };
  }

  /**
   * Signs a local member in by username, compared lowercase (AUTH-3). An
   * unknown username still checks a dummy hash, so timing does not tell; an
   * inactive member cannot sign in. Only session rows are written, which are
   * not data writes (BAK-8).
   */
  async login(username: string, password: string, log: AuthLog): Promise<MemberSessionResult> {
    const normalized = normalizeMemberUsername(username);
    const found = normalized.length <= 64 ? repo.localMemberByUsername(this.context.db, normalized) : null;
    if (!found) {
      await verifyPassword(password, await dummyPasswordHash());
      invalidCredentials();
    }
    const result = await verifyPassword(password, found.passwordHash);
    if (!result.ok) {
      if (result.malformed) log.error('A stored member password hash is malformed or uses unsupported scrypt parameters.');
      invalidCredentials();
    }
    if (!found.member.isActive) invalidCredentials();
    return this.newSession(found.member);
  }

  /** The active member of a session token, or null. */
  session(token: string | undefined): MemberSession | null {
    if (!plausibleToken(token)) return null;
    const member = repo.memberForSession(this.context.db, hashSessionToken(token));
    return member ? repo.toSession(member) : null;
  }

  logout(token: string | undefined) {
    if (plausibleToken(token)) repo.deleteMemberSession(this.context.db, hashSessionToken(token));
  }

  /** A local member changes their own password: every session of theirs ends, and the caller gets a new one (AUTH-4). */
  async changePassword(memberId: string, currentPassword: string, password: string, log: AuthLog): Promise<MemberSessionResult> {
    const found = repo.localMemberCredentials(this.context.db, memberId);
    if (!found) throw new HttpError(403, 'forbidden', 'Only members with a local account have a password here.');
    const result = await verifyPassword(currentPassword, found.passwordHash);
    if (!result.ok) {
      if (result.malformed) log.error('A stored member password hash is malformed or uses unsupported scrypt parameters.');
      invalidCredentials();
    }
    const problems = errorsOf(newPasswordError(password));
    if (problems.length) validation(problems);
    const passwordHash = await hashPassword(password);
    return this.context.db.transaction((sqlite) => {
      repo.updateMemberPassword(this.context.db, memberId, passwordHash);
      repo.deleteMemberSessions(sqlite, memberId);
      return this.newSession(found.member, sqlite);
    });
  }
}

/** API-8: the opaque cursor of the member list, the position after its last item. */
export function encodeMemberCursor(position: repo.MemberPagePosition) {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString('base64url');
}

export function decodeMemberCursor(cursor: string): repo.MemberPagePosition | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && isUuidV4(value[1])) return { createdAt: value[0], id: value[1] };
  } catch {
    // An unreadable cursor is the same as a wrong one.
  }
  return null;
}

export interface MemberInput {
  username: string;
  displayName: string;
  role: MemberRole;
  password: string;
}

export interface MemberUpdate {
  displayName: string;
  role: MemberRole;
  isActive: boolean;
}

/** The Admin's management of member accounts (#17): there is no self-registration. */
export class AdminMemberService {
  constructor(private readonly context: Pick<AppContext, 'db'>) {}

  list(query: { limit?: number; cursor?: string; q?: string }) {
    const after = query.cursor ? decodeMemberCursor(query.cursor) : null;
    if (query.cursor && !after) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
    const page = repo.listMembers(this.context.db, { limit: query.limit ?? 50, after, search: (query.q ?? '').trim() });
    const last = page.members.at(-1);
    return { items: page.members, nextCursor: page.more && last ? encodeMemberCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  get(id: string): AdminMember {
    const member = isUuidV4(id) ? repo.getMember(this.context.db, id.toLowerCase()) : null;
    if (!member) notFound();
    return member;
  }

  async create(input: MemberInput): Promise<AdminMember> {
    const username = normalizeMemberUsername(input.username);
    const problems = errorsOf(memberUsernameError(input.username), displayNameError(input.displayName), newPasswordError(input.password));
    if (!problems.length && repo.usernameTaken(this.context.db, username)) {
      problems.push(fieldError('username', 'duplicate', 'Another member already has this username.'));
    }
    if (problems.length) validation(problems);
    const passwordHash = await hashPassword(input.password);
    return repo.insertLocalMember(this.context.db, { id: randomUUID(), username, displayName: input.displayName.trim(), role: input.role, passwordHash });
  }

  /** Replaces the display name, role and active flag; a role change or deactivation ends the member's sessions (AUTH-4). */
  replace(id: string, input: MemberUpdate): { member: AdminMember; changed: string[] } {
    const current = this.get(id);
    const problems = errorsOf(displayNameError(input.displayName));
    if (problems.length) validation(problems);
    const next = { displayName: input.displayName.trim(), role: input.role, isActive: input.isActive };
    const changed = (['displayName', 'role', 'isActive'] as const).filter((key) => current[key] !== next[key]);
    const member = this.context.db.transaction((sqlite) => {
      const updated = repo.updateMember(this.context.db, current.id, next);
      if (changed.includes('role') || !next.isActive) repo.deleteMemberSessions(sqlite, current.id);
      return updated;
    });
    return { member, changed };
  }

  /** Sets a local member's password and ends their sessions (AUTH-4). */
  async setPassword(id: string, password: string): Promise<AdminMember> {
    const member = this.get(id);
    if (member.authSource !== 'local') throw new HttpError(409, 'conflict', 'This member signs in with their AGT account and has no password here.');
    const problems = errorsOf(newPasswordError(password));
    if (problems.length) validation(problems);
    const passwordHash = await hashPassword(password);
    this.context.db.transaction((sqlite) => {
      repo.updateMemberPassword(this.context.db, member.id, passwordHash);
      repo.deleteMemberSessions(sqlite, member.id);
    });
    return this.get(member.id);
  }

  /** Deletes a member and, with them, their sessions (AUTH-4). */
  delete(id: string): AdminMember {
    const member = this.get(id);
    repo.deleteMember(this.context.db, member.id);
    return member;
  }
}
