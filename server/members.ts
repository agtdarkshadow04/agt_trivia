import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminMember, MemberRole, MemberSession } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { fieldError, type FieldError } from '../src/lib/errors.js';
import { displayNameError, errorsOf, memberUsernameError, newPasswordError, normalizeMemberUsername } from '../src/lib/validation.js';
import { settingValues, type AppContext } from './context.js';
import { iamDisabled, iamStatus, iamUnavailable, invalidIamCredentials, type IamTraveller, type IamVerifier } from './iam.js';
import { readSettings } from './repository/settings.js';
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

function managedByIam(): never {
  throw new HttpError(409, 'managed_by_iam', 'AGT IAM manages this member: only activate, deactivate or delete them here.');
}

function notFound(): never {
  throw new HttpError(404, 'not_found', 'The member does not exist.');
}

export class MemberAuthService {
  constructor(private readonly context: Pick<AppContext, 'config' | 'db' | 'iamApiKey'>) {}

  /** Whether AGT sign-in is on and configured (#18). */
  iamAvailability() {
    return iamStatus(this.context, settingValues(this.context.config, readSettings(this.context.db)));
  }

  /**
   * A new session for a member (AUTH-8), on `sqlite` when it runs inside a
   * transaction. `maxSeconds` shortens it, for an AGT sign-in whose IAM token
   * expires sooner.
   */
  newSession(member: AdminMember, sqlite = this.context.db.connection, maxSeconds?: number): MemberSessionResult {
    const token = randomBytes(32).toString('base64url');
    const ttlMs = this.context.config.session.ttlHours * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + (maxSeconds === undefined ? ttlMs : Math.min(ttlMs, maxSeconds * 1000)));
    repo.insertMemberSession(sqlite, hashSessionToken(token), member.id, expiresAt);
    return { token, expiresAt, member: repo.toSession(member) };
  }

  /**
   * Step 1 of a local sign-in, before the data write, so scrypt never holds
   * the write lock (BAK-8): the member whose username, compared lowercase,
   * and password match (AUTH-3). An unknown username still checks a dummy
   * hash, so timing does not tell; an inactive member cannot sign in.
   */
  async verifyLogin(username: string, password: string, log: AuthLog): Promise<AdminMember> {
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
    return found.member;
  }

  /**
   * Step 2, inside the data write: the member must still be active (the Admin
   * may have changed them meanwhile); records the sign-in (#48) and starts a
   * session, in one transaction.
   */
  completeLogin(verified: AdminMember): MemberSessionResult {
    return this.context.db.transaction((sqlite) => {
      const member = repo.getMember(this.context.db, verified.id);
      if (!member || !member.isActive || member.authSource !== 'local') invalidCredentials();
      repo.recordMemberSignIn(this.context.db, member.id);
      return this.newSession(member, sqlite);
    });
  }

  /** The active member of a session token, or null; an AGT member's session counts only while AGT sign-in is available. */
  session(token: string | undefined): MemberSession | null {
    if (!plausibleToken(token)) return null;
    const member = repo.memberForSession(this.context.db, hashSessionToken(token));
    if (!member) return null;
    if (member.authSource === 'agt_iam' && !this.iamAvailability().available) return null;
    return repo.toSession(member);
  }

  /**
   * Step 1 of an AGT sign-in (#18), before the data write, so a slow IAM never
   * holds the write lock (BAK-8): checks that AGT sign-in is on and
   * configured, then asks IAM. The password goes only to IAM.
   */
  async verifyIam(travellerName: string, password: string, iam: IamVerifier | null): Promise<IamTraveller> {
    const status = this.iamAvailability();
    if (!status.enabled) throw iamDisabled();
    if (!status.available || !iam) throw iamUnavailable();
    return iam.verify(travellerName, password);
  }

  /**
   * Step 2, inside the data write: creates the AGT member at their first
   * sign-in, or refreshes their name, tier and role (a changed role ends their
   * other sessions, AUTH-4), then starts a session that ends no later than
   * IAM's own token. A member the Admin deactivated cannot sign in.
   */
  completeIamLogin(traveller: IamTraveller): MemberSessionResult {
    if (!this.iamAvailability().available) throw iamDisabled();
    return this.context.db.transaction((sqlite) => {
      const input = { travellerId: traveller.travellerId, travellerName: traveller.travellerName, permission: traveller.permission, role: traveller.role };
      const existing = repo.iamMember(this.context.db, traveller.travellerId);
      if (existing && !existing.isActive) invalidIamCredentials();
      let member: AdminMember;
      if (existing) {
        member = repo.updateIamMember(this.context.db, existing.id, input);
        if (existing.role !== member.role) repo.deleteMemberSessions(sqlite, existing.id);
      } else {
        member = repo.insertIamMember(this.context.db, randomUUID(), input);
      }
      repo.recordMemberSignIn(this.context.db, member.id);
      return this.newSession(member, sqlite, traveller.expiresInSeconds);
    });
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

  /** `idleDays` (#48) keeps the members who never signed in or not for that many days. */
  list(query: { limit?: number; cursor?: string; q?: string; idleDays?: number }, now = new Date()) {
    const after = query.cursor ? decodeMemberCursor(query.cursor) : null;
    if (query.cursor && !after) throw new HttpError(400, 'invalid_request', 'The cursor is not valid.');
    const signedInBefore = query.idleDays ? new Date(now.getTime() - query.idleDays * 24 * 60 * 60 * 1000).toISOString() : null;
    const page = repo.listMembers(this.context.db, { limit: query.limit ?? 50, after, search: (query.q ?? '').trim(), signedInBefore });
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

  /**
   * Replaces the display name, role and active flag; a role change or
   * deactivation ends the member's sessions (AUTH-4). AGT IAM sets an AGT
   * member's name and role, so for them only the active flag may change
   * (`409 managed_by_iam`).
   */
  replace(id: string, input: MemberUpdate): { member: AdminMember; changed: string[] } {
    const current = this.get(id);
    const problems = errorsOf(displayNameError(input.displayName));
    if (problems.length) validation(problems);
    const next = { displayName: input.displayName.trim(), role: input.role, isActive: input.isActive };
    const changed = (['displayName', 'role', 'isActive'] as const).filter((key) => current[key] !== next[key]);
    if (current.authSource === 'agt_iam' && changed.some((key) => key !== 'isActive')) managedByIam();
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
    if (member.authSource !== 'local') managedByIam();
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
