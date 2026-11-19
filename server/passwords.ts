import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing (AUTH-2), stored as `scrypt$N$r$p$<salt base64>$<hash base64>`.
 * A stored hash is checked before any scrypt call and can only verify with a
 * supported profile.
 */

/** Every scrypt call passes these fixed options; `maxmem` is never derived from a stored hash. */
const maxmem = 64 * 1024 * 1024;
const saltBytes = 16;
const keyBytes = 64;

interface Profile {
  N: number;
  r: number;
  p: number;
}

/**
 * The supported parameter profiles; the first is used for new hashes (AUTH-2).
 * Add one only together with the code that rehashes on the next sign-in.
 */
export const SCRYPT_PROFILES: readonly Profile[] = [{ N: 32768, r: 8, p: 1 }];
const current = SCRYPT_PROFILES[0];

/** The scrypt call the hashing makes; tests replace `run` to see whether it ran. */
export const scryptImplementation = {
  run(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scryptCallback(password, salt, keyBytes, options, (error, key) => (error ? reject(error) : resolve(key)));
    });
  },
};

function scrypt(password: string, salt: Buffer, profile: Profile): Promise<Buffer> {
  return scryptImplementation.run(password.normalize('NFKC'), salt, { N: profile.N, r: profile.r, p: profile.p, maxmem });
}

const decimal = /^(0|[1-9][0-9]*)$/;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(value: string, bytes: number) {
  if (!base64.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value ? decoded : null;
}

export interface ParsedHash {
  profile: Profile;
  salt: Buffer;
  hash: Buffer;
}

/** Checks a stored hash without calling scrypt (AUTH-2); null means it can never verify. */
export function parseHash(stored: string): ParsedHash | null {
  const fields = stored.split('$');
  if (fields.length !== 6 || fields[0] !== 'scrypt') return null;
  const [, N, r, p, saltValue, hashValue] = fields;
  if (![N, r, p].every((value) => decimal.test(value))) return null;
  const profile = SCRYPT_PROFILES.find((candidate) => candidate.N === Number(N) && candidate.r === Number(r) && candidate.p === Number(p));
  if (!profile) return null;
  const salt = decode(saltValue, saltBytes);
  const hash = decode(hashValue, keyBytes);
  return salt && hash ? { profile, salt, hash } : null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltBytes);
  const key = await scrypt(password, salt, current);
  return `scrypt$${current.N}$${current.r}$${current.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export type VerifyResult =
  | { ok: true }
  /** Wrong password, or `malformed`: the stored hash failed the format check, so scrypt was not called. */
  | { ok: false; malformed: boolean };

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, malformed: true };
  const key = await scrypt(password, parsed.salt, parsed.profile);
  return timingSafeEqual(key, parsed.hash) ? { ok: true } : { ok: false, malformed: false };
}

/**
 * A valid hash of a random password, verified when no Admin exists so a failed
 * sign-in takes the same time whether or not setup has run (AUTH-3).
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

/** Compares two secrets in constant time, whatever their lengths: their SHA-256 digests (AUTH-3). */
export function secretsEqual(left: string, right: string) {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}
