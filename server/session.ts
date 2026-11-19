import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { fieldError } from '../src/lib/errors.js';
import { adminUsernameError, newPasswordError } from '../src/lib/validation.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { dummyPasswordHash, hashPassword, secretsEqual, verifyPassword } from './passwords.js';
import * as repo from './repository/admin.js';

/**
 * First-run setup (AUTH-5, AUTH-6), Admin sign-in (AUTH-3), cookie sessions
 * (AUTH-8) and the password change (AUTH-4). Tokens are 32 random bytes,
 * base64url, in the `agt_trivia_session` cookie; only their SHA-256 is stored.
 */

export const adminSessionCookie = 'agt_trivia_session';
export const setupPasswordVariable = 'AGT_TRIVIA_SETUP_PASSWORD';
/** AUTH-5: the longest setup password the setup form can send. */
export const maxSetupPasswordLength = 1024;

/** Writes to the server log; the app passes `request.log`, tests a spy. */
export interface AuthLog {
  error(message: string): void;
  info(message: string): void;
}

export interface AdminSession {
  token: string;
  expiresAt: Date;
  username: string;
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A token no real one can look like is never looked up. */
function plausibleToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function invalidCredentials(): never {
  throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
}

function validation(error: ReturnType<typeof newPasswordError>): never {
  throw new HttpError(400, 'validation_failed', error!.message, { fields: [error!] });
}

function passwordReused(): never {
  const message = 'The new password must differ from the setup password.';
  throw new HttpError(400, 'validation_failed', message, { fields: [fieldError('password', 'same_as_setup_password', message)] });
}

/** The single Admin, as `server/routes.ts` uses it. */
export class AdminAuthService {
  constructor(private readonly context: Pick<AppContext, 'config' | 'db' | 'setupPassword'>) {}

  /** A new session, purging the expired ones (AUTH-8). */
  private newSession(username: string, sqlite = this.context.db.connection): AdminSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.context.config.session.ttlHours * 60 * 60 * 1000);
    repo.insertSession(sqlite, hashSessionToken(token), expiresAt);
    return { token, expiresAt, username };
  }

  /** Verifies the Admin password; a malformed stored hash never verifies and is logged, never shown (AUTH-2). */
  private async passwordMatches(password: string, stored: string, log: AuthLog) {
    const result = await verifyPassword(password, stored);
    if (!result.ok && result.malformed) log.error('The stored admin password hash is malformed or uses unsupported scrypt parameters.');
    return result.ok;
  }

  adminExists() {
    return repo.adminExists(this.context.db);
  }

  /** `GET /api/setup/status` (AUTH-5). */
  setupStatus() {
    return { adminExists: this.adminExists(), setupPasswordConfigured: this.context.setupPassword !== null };
  }

  /**
   * Creates the Admin on a fresh installation (AUTH-5). Needs
   * AGT_TRIVIA_SETUP_PASSWORD, which never becomes the Admin password, is never
   * stored, and is ignored once an Admin exists.
   */
  async setup(input: { setupPassword: string; username: string; password: string }, log: AuthLog): Promise<AdminSession> {
    if (this.adminExists()) throw setupComplete();
    const expected = this.context.setupPassword;
    if (expected === null) {
      throw new HttpError(503, 'setup_password_missing', `Setup is unavailable: ${setupPasswordVariable} is not set. Set it in .env and restart.`);
    }
    if (!secretsEqual(input.setupPassword, expected)) throw new HttpError(401, 'invalid_setup_password', 'The setup password is incorrect.');
    const usernameError = adminUsernameError(input.username);
    if (usernameError) validation(usernameError);
    const passwordError = newPasswordError(input.password);
    if (passwordError) validation(passwordError);
    if (secretsEqual(input.password, expected)) passwordReused();
    const username = input.username.trim();
    const passwordHash = await hashPassword(input.password);
    const session = this.context.db.transaction((sqlite) => {
      if (!repo.insertAdmin(sqlite, username, passwordHash)) throw setupComplete();
      return this.newSession(username, sqlite);
    });
    log.info(`Admin account created. Remove ${setupPasswordVariable} from .env and restart.`);
    return session;
  }

  /**
   * Verifies the Admin's credentials (AUTH-3). The username is trimmed and
   * compared exactly, in constant time; without an Admin the password is checked
   * against a dummy hash, so timing reveals neither which part was wrong nor
   * whether setup has run.
   */
  async login(username: string, password: string, log: AuthLog): Promise<AdminSession> {
    const admin = repo.adminAccount(this.context.db);
    let ok = false;
    if (admin) ok = await this.passwordMatches(password, admin.password_hash, log);
    else await verifyPassword(password, await dummyPasswordHash());
    const usernameValid = secretsEqual(username.trim(), admin?.username ?? '');
    if (!admin || !ok || !usernameValid) invalidCredentials();
    return this.newSession(admin.username);
  }

  /** The Admin's username for a session token, or null when the token is unknown or expired. */
  session(token: string | undefined): string | null {
    if (!plausibleToken(token)) return null;
    return repo.adminForSession(this.context.db, hashSessionToken(token));
  }

  logout(token: string | undefined) {
    if (plausibleToken(token)) repo.deleteSession(this.context.db, hashSessionToken(token));
  }

  /** Changes the Admin password, ends every session and starts a new one for the caller (AUTH-4). */
  async changePassword(currentPassword: string, password: string, log: AuthLog): Promise<AdminSession> {
    const admin = repo.adminAccount(this.context.db);
    if (!admin || !await this.passwordMatches(currentPassword, admin.password_hash, log)) invalidCredentials();
    const passwordError = newPasswordError(password);
    if (passwordError) validation(passwordError);
    const expected = this.context.setupPassword;
    if (expected !== null && secretsEqual(password, expected)) passwordReused();
    const passwordHash = await hashPassword(password);
    return this.context.db.transaction((sqlite) => {
      repo.updateAdminPassword(sqlite, passwordHash);
      repo.deleteAllSessions(sqlite);
      return this.newSession(admin.username, sqlite);
    });
  }
}

function setupComplete() {
  return new HttpError(410, 'setup_complete', 'Setup has already been completed.');
}

/**
 * The startup check of the setup password (AUTH-5, AUTH-6): too long while no
 * Admin exists stops the server; still set once one exists is a warning.
 */
export function setupPasswordCheck(context: Pick<AppContext, 'db' | 'setupPassword'>): { error?: string; warning?: string } {
  const { setupPassword } = context;
  if (setupPassword === null) return {};
  if (repo.adminExists(context.db)) {
    return { warning: `${setupPasswordVariable} is still set although the Admin account exists. Remove it from .env and restart.` };
  }
  if (setupPassword.length > maxSetupPasswordLength) {
    return { error: `${setupPasswordVariable} is longer than ${maxSetupPasswordLength} characters. Set a shorter value in .env and restart.` };
  }
  return {};
}

/** Whether a cookie set in answer to `request` gets `Secure` (`session.secureCookie`, AUTH-8). */
export function secureCookie(context: Pick<AppContext, 'config'>, request: FastifyRequest) {
  const setting = context.config.session.secureCookie;
  return setting === 'auto' ? request.protocol === 'https' : setting;
}

/** The session cookie with the AUTH-8 attributes. */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean) {
  const maxAge = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  return [`${adminSessionCookie}=${token}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearedCookie(secure: boolean) {
  return [`${adminSessionCookie}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}
