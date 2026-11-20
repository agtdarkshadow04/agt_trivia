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

/** CFG-6: the allowed backup upload limits (`backup.*`). */
export const backupLimits = {
  maxZipBytes: { min: 1024, max: 2 * 1024 * 1024 * 1024 },
  maxUncompressedBytes: { min: 1024, max: 8 * 1024 * 1024 * 1024 },
  maxEntries: { min: 1, max: 100_000 },
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

// --- Categories and questions (#15) ------------------------------------------------

/** The limits of a category (#15), counted in Unicode code points like every text limit. */
export const categoryLimits = {
  shortName: { max: 16 },
  name: { max: 100 },
  description: { max: 300 },
  priority: { min: 0, max: 100 },
} as const;

/** The limits of a question and its choices (#15). */
export const questionLimits = {
  prompt: { max: 300 },
  choices: { min: 2, max: 4 },
  choiceText: { max: 200 },
  authorCredit: { max: 64 },
  reviewNote: { max: 1000 },
  /** Prompts longer than this get a notice, not an error (the sheet's "10–15 words" guideline, API-2). */
  promptWords: 15,
} as const;

export const questionStatuses = ['draft', 'pending', 'approved', 'rejected'] as const;
export type QuestionStatus = typeof questionStatuses[number];

export interface CategoryInput {
  shortName: string;
  name: string;
  description: string;
  priority: number;
}

export interface ChoiceInput {
  text: string;
  isCorrect: boolean;
}

export interface QuestionInput {
  prompt: string;
  choices: readonly ChoiceInput[];
  /** The "Submitted by" credit; empty or null for none. */
  authorCredit: string | null;
  reviewNote?: string;
}

/** Letters, digits and `-`: the `?category=` link of a category. */
const shortNamePattern = /^[A-Za-z0-9-]+$/;

/** Text and choice comparisons ignore case (unique names, unique choices per question). */
export function sameText(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

/** A required text after trimming, at most `max` code points. */
function textError(field: string, value: string, max: number, label: string): FieldError | null {
  const trimmed = value.trim();
  if (!trimmed) return fieldError(field, 'required', `${label} is required.`);
  if (codePoints(trimmed) > max) return fieldError(field, 'too_long', `${label} must be at most ${max} characters.`, { max });
  return null;
}

/** An optional text after trimming: empty is fine. */
function optionalTextError(field: string, value: string, max: number, label: string): FieldError | null {
  return value.trim() ? textError(field, value, max, label) : null;
}

/** A category as stored: every text trimmed. */
export function normalizeCategory(input: CategoryInput): CategoryInput {
  return { shortName: input.shortName.trim(), name: input.name.trim(), description: input.description.trim(), priority: input.priority };
}

/** The field errors of a category (#15); uniqueness against other categories is the server's check. */
export function categoryErrors(input: CategoryInput): FieldError[] {
  const { shortName, priority } = categoryLimits;
  const trimmedShortName = input.shortName.trim();
  return errorsOf(
    textError('shortName', input.shortName, shortName.max, 'The short name')
      ?? (shortNamePattern.test(trimmedShortName) ? null : fieldError('shortName', 'invalid_format', 'The short name may contain only letters, digits and "-".')),
    textError('name', input.name, categoryLimits.name.max, 'The name'),
    textError('description', input.description, categoryLimits.description.max, 'The description'),
    Number.isInteger(input.priority) && input.priority >= priority.min && input.priority <= priority.max
      ? null
      : fieldError('priority', 'out_of_range', `The priority must be a whole number from ${priority.min} to ${priority.max}.`, { min: priority.min, max: priority.max }),
  );
}

/** A question as stored: texts trimmed, an empty credit as null, an absent review note as empty. */
export function normalizeQuestion(input: QuestionInput): Required<QuestionInput> {
  const credit = input.authorCredit?.trim() ?? '';
  return {
    prompt: input.prompt.trim(),
    choices: input.choices.map((choice) => ({ text: choice.text.trim(), isCorrect: choice.isCorrect })),
    authorCredit: credit || null,
    reviewNote: (input.reviewNote ?? '').trim(),
  };
}

/**
 * The field errors of a question (#15): a prompt, 2 to 4 choices with
 * distinct texts (ignoring case), at least one correct, an optional credit and
 * review note. Each choice's errors name `choices.<index>`.
 */
export function questionErrors(input: QuestionInput): FieldError[] {
  const { choices, choiceText } = questionLimits;
  const errors = errorsOf(
    textError('prompt', input.prompt, questionLimits.prompt.max, 'The question'),
    input.choices.length < choices.min
      ? fieldError('choices', 'too_few', `A question needs at least ${choices.min} answers.`, { min: choices.min })
      : input.choices.length > choices.max
        ? fieldError('choices', 'too_many', `A question has at most ${choices.max} answers.`, { max: choices.max })
        : null,
  );
  input.choices.forEach((choice, index) => {
    const field = `choices.${index}`;
    const problem = textError(field, choice.text, choiceText.max, 'The answer')
      ?? (input.choices.slice(0, index).some((earlier) => earlier.text.trim() && sameText(earlier.text, choice.text))
        ? fieldError(field, 'duplicate', 'Each answer must be different.')
        : null);
    if (problem) errors.push(problem);
  });
  if (input.choices.length >= choices.min && !input.choices.some((choice) => choice.isCorrect)) {
    errors.push(fieldError('choices', 'correct_choice_required', 'Mark at least one answer as correct.'));
  }
  return errors.concat(errorsOf(
    input.authorCredit === null ? null : optionalTextError('authorCredit', input.authorCredit, questionLimits.authorCredit.max, 'The credit'),
    input.reviewNote === undefined ? null : optionalTextError('reviewNote', input.reviewNote, questionLimits.reviewNote.max, 'The review note'),
  ));
}

/** Non-blocking notices for a question (API-2): a prompt longer than 15 words. */
export function questionNotices(input: Pick<QuestionInput, 'prompt'>): FieldError[] {
  const words = input.prompt.trim().split(/\s+/).filter(Boolean).length;
  return words > questionLimits.promptWords
    ? [fieldError('prompt', 'too_many_words', `Questions read best with at most ${questionLimits.promptWords} words; this one has ${words}.`, { max: questionLimits.promptWords, count: words })]
    : [];
}

/** A Moderator's reason for rejecting a question (#19): required, at most 1000 characters. */
export function reviewNoteError(note: string): FieldError | null {
  return textError('reviewNote', note, questionLimits.reviewNote.max, 'The review note');
}

// --- Member accounts (#17) ----------------------------------------------------------

/** A member's username: 3–64 lowercase letters, digits, dots, underscores or hyphens (stored lowercase). */
export const memberLimits = {
  username: { min: 3, max: 64 },
  displayName: { max: 120 },
} as const;

const memberUsernamePattern = /^[a-z0-9_.-]+$/;

/** The username as stored: trimmed and lowercase. Sign-in compares it the same way. */
export function normalizeMemberUsername(username: string) {
  return username.trim().toLowerCase();
}

export function memberUsernameError(username: string, field = 'username'): FieldError | null {
  const value = normalizeMemberUsername(username);
  const { min, max } = memberLimits.username;
  if (!value) return fieldError(field, 'required', 'The username is required.');
  if (value.length < min) return fieldError(field, 'too_short', `The username must be at least ${min} characters.`, { min });
  if (value.length > max) return fieldError(field, 'too_long', `The username must be at most ${max} characters.`, { max });
  if (!memberUsernamePattern.test(value)) return fieldError(field, 'invalid_format', 'The username may contain only letters, digits, dots, underscores and hyphens.');
  return null;
}

/** The name players see, trimmed: 1–120 characters. */
export function displayNameError(displayName: string, field = 'displayName'): FieldError | null {
  const value = displayName.trim();
  if (!value) return fieldError(field, 'required', 'The display name is required.');
  if (codePoints(value) > memberLimits.displayName.max) {
    return fieldError(field, 'too_long', `The display name must be at most ${memberLimits.displayName.max} characters.`, { max: memberLimits.displayName.max });
  }
  return null;
}
