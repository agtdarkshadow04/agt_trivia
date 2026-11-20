import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { QuizAttempt, QuizLength } from '../src/lib/api.js';
import { isUuidV4 } from '../src/lib/api.js';
import { asOperation } from './dataWrite.js';
import type { Database } from './db.js';
import { getSecret, insertSecretIfMissing } from './repository/secrets.js';

/**
 * Signed quiz attempts (#45). Every quiz the public quiz route draws comes
 * with an attempt: a random ID and a token, an HMAC-SHA-256 over the attempt
 * ID, the category, the length, the drawn questions in order and the expiry.
 * Drawing a quiz writes nothing (BAK-8); a member's result that carries the
 * token must answer exactly those questions, and each attempt is saved once.
 * The key is a generated secret in `app_secrets` (SEC-8), created at startup
 * and at the end of a restore when missing, as ALT-2 does for ALTCHA.
 */

/** The `app_secrets` name of the key. */
export const ATTEMPT_KEY_NAME = 'quiz_attempt_key';
/** How long a drawn quiz can be saved. */
export const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_VERSION = 'v1';

/** What a token proves: the attempt and the quiz that was drawn for it. */
export interface AttemptClaims {
  attemptId: string;
  categoryId: string;
  length: QuizLength;
  /** SHA-256 of the drawn question IDs in order, and how many there were. */
  questionsDigest: string;
  questionCount: number;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** The digest of question IDs in the order they were drawn or answered. */
export function questionsDigest(questionIds: readonly string[]) {
  return createHash('sha256').update(questionIds.map((id) => id.toLowerCase()).join('\n')).digest('base64url');
}

function sign(key: string, payload: string) {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(`${TOKEN_VERSION}.${payload}`).digest();
}

/**
 * Creates the attempt key unless the database has one; run at startup before
 * the server listens, and at the end of a restore (BAK-4 step 5). Returns
 * whether a key was created. These are the startup's or the restore's own
 * writes, not a request's.
 */
export function ensureAttemptKey(db: Database, now = new Date()): boolean {
  return asOperation(() => insertSecretIfMissing(db, ATTEMPT_KEY_NAME, randomBytes(32).toString('base64url'), now));
}

function attemptKey(db: Database) {
  const key = getSecret(db, ATTEMPT_KEY_NAME);
  // ensureAttemptKey() runs before the server listens and after every restore.
  if (!key) throw new Error('The quiz attempt key is missing from app_secrets.');
  return key;
}

/** A new attempt for a drawn quiz. */
export function issueAttempt(db: Database, quiz: { categoryId: string; length: QuizLength; questionIds: readonly string[] }, now = new Date()): QuizAttempt {
  const claims: AttemptClaims = {
    attemptId: randomUUID(),
    categoryId: quiz.categoryId,
    length: quiz.length,
    questionsDigest: questionsDigest(quiz.questionIds),
    questionCount: quiz.questionIds.length,
    expiresAt: now.getTime() + ATTEMPT_TTL_MS,
  };
  const payload = base64url(JSON.stringify(claims));
  return {
    id: claims.attemptId,
    token: `${TOKEN_VERSION}.${payload}.${base64url(sign(attemptKey(db), payload))}`,
    expiresAt: new Date(claims.expiresAt).toISOString(),
  };
}

function isClaims(value: unknown): value is AttemptClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  return isUuidV4(claims.attemptId) && isUuidV4(claims.categoryId)
    && (claims.length === 'short' || claims.length === 'long' || claims.length === 'all')
    && typeof claims.questionsDigest === 'string' && Number.isInteger(claims.questionCount)
    && Number.isInteger(claims.expiresAt);
}

/**
 * The claims of a token this server signed, or why it cannot be used: `invalid`
 * for anything malformed, tampered with or signed with another key, `expired`
 * after `ATTEMPT_TTL_MS`.
 */
export function verifyAttempt(db: Database, token: string, now = new Date()): { claims: AttemptClaims } | { problem: 'invalid' | 'expired' } {
  const [version, payload, signature, ...rest] = token.split('.');
  if (version !== TOKEN_VERSION || !payload || !signature || rest.length) return { problem: 'invalid' };
  const expected = sign(attemptKey(db), payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { problem: 'invalid' };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { problem: 'invalid' };
  }
  if (!isClaims(claims)) return { problem: 'invalid' };
  if (now.getTime() > claims.expiresAt) return { problem: 'expired' };
  return { claims };
}
