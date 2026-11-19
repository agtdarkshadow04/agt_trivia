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
