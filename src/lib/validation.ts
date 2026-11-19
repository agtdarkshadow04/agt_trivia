import { fieldError, type FieldError } from './errors.js';

/**
 * Semantic validation shared by the server and the browser (REPO-3, FE-6):
 * the rules a schema cannot express. The server checks types first with the
 * route's TypeBox schema, then runs these; forms run the same functions, so
 * both report the same field codes. Never duplicate a rule elsewhere.
 */

/** The allowed quiz lengths (CFG-6: `quiz.shortLength`, `quiz.longLength`). */
export const quizLengthLimits = {
  short: { min: 1, max: 100 },
  long: { min: 2, max: 500 },
} as const;

/** A long quiz must have more questions than a short one; null when the pair is fine. */
export function quizLengthsError(shortLength: number, longLength: number): FieldError | null {
  if (longLength > shortLength) return null;
  return fieldError('quiz.longLength', 'out_of_range', `quiz.longLength must be greater than quiz.shortLength (${shortLength}).`, { min: shortLength + 1 });
}

/** AUTH-3: the Admin username (after trimming) and every password, counted in Unicode code points. */
export const credentialLimits = {
  username: { max: 64 },
  password: { min: 12, max: 1024 },
} as const;

function codePoints(value: string) {
  return [...value].length;
}

/** The Admin username as stored: trimmed, otherwise exactly as entered (AUTH-3). */
export function adminUsernameError(username: string): FieldError | null {
  const trimmed = username.trim();
  if (!trimmed) return fieldError('username', 'required', 'The username is required.');
  if (codePoints(trimmed) > credentialLimits.username.max) {
    return fieldError('username', 'too_long', `The username must be at most ${credentialLimits.username.max} characters.`, { max: credentialLimits.username.max });
  }
  return null;
}

/** A new password: 12 to 1024 characters (AUTH-3). `field` names the form field. */
export function newPasswordError(password: string, field = 'password'): FieldError | null {
  const length = codePoints(password);
  if (!length) return fieldError(field, 'required', 'The password is required.');
  if (length < credentialLimits.password.min) {
    return fieldError(field, 'too_short', `The password must be at least ${credentialLimits.password.min} characters.`, { min: credentialLimits.password.min });
  }
  if (length > credentialLimits.password.max) {
    return fieldError(field, 'too_long', `The password must be at most ${credentialLimits.password.max} characters.`, { max: credentialLimits.password.max });
  }
  return null;
}

/** The confirmation field of a new password must repeat it (`mismatch`; a form-only check). */
export function confirmationError(password: string, confirmation: string, field = 'passwordConfirmation', other = 'password'): FieldError | null {
  return password === confirmation ? null : fieldError(field, 'mismatch', 'The passwords do not match.', { other });
}

/** A field the form needs before it can be sent (sign-in, the current password). */
export function requiredError(field: string, value: string): FieldError | null {
  return value ? null : fieldError(field, 'required', `${field} is required.`);
}

/** The field errors of several checks, in order, without the passing ones. */
export function errorsOf(...checks: (FieldError | null)[]): FieldError[] {
  return checks.filter((check): check is FieldError => check !== null);
}
