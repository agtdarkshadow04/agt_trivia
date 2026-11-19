/**
 * Field errors shared by the server and the browser (API-6). A FieldError
 * names the request property (dotted for nested ones, e.g. `choices.2`), a
 * stable field code, English text, and the values the text needs. The
 * translated texts (I18N-6, `errorText()` and `fieldErrorText()`) arrive with
 * the string tables (#11).
 */

export type FieldParams = Record<string, string | number | boolean>;

export interface FieldError {
  field: string;
  code: string;
  message: string;
  params?: FieldParams;
}

/** The standard field codes (API-6); the app adds its own here. */
export const FIELD_CODES = [
  'required',
  'too_long',
  'too_short',
  'out_of_range',
  'too_many',
  'invalid_format',
  'invalid_url',
  'not_allowed',
  'duplicate',
  'mismatch',
  'same_as_setup_password',
  'too_few',
  'correct_choice_required',
  'too_many_words',
] as const;

export type FieldCode = typeof FIELD_CODES[number];

export function fieldError(field: string, code: FieldCode, message: string, params?: FieldParams): FieldError {
  return params ? { field, code, message, params } : { field, code, message };
}

// --- Translated errors (I18N-6) ---------------------------------------------------

/** The parts of the string tables `errorText()` and `fieldErrorText()` read. */
export interface ErrorTranslations {
  /** One string per API-6 `error` code (and the client's own `network_error`), with `{{param}}` placeholders. */
  errors: Readonly<Record<string, string>>;
  /** One string per field code, with `{{field}}` and `{{param}}` placeholders. */
  fieldErrors: Readonly<Record<string, string>>;
  /** Shown for a failure that is not an API error at all (a bug, a broken page). */
  unexpectedError: string;
}

/** Fills `{{name}}` placeholders; unknown names stay as they are (the same rule as `formatTranslation()`). */
function fill(template: string, values: Readonly<Record<string, unknown>>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (values[name] === undefined ? match : String(values[name])));
}

function isApiErrorLike(value: unknown): value is { code: string; message: string; params?: Record<string, unknown> } {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

/**
 * The reader's text for an error: the translation of its `error` code with its
 * `params`, the server's English `message` only for a code this client does not
 * know, and a generic text for anything that is not an API error.
 */
export function errorText(error: unknown, translations: ErrorTranslations): string {
  if (!isApiErrorLike(error)) return translations.unexpectedError;
  const template = translations.errors[error.code];
  return template === undefined ? error.message : fill(template, error.params ?? {});
}

/** The reader's text for a field error, with the translated field `label` as `{{field}}`. */
export function fieldErrorText(fieldError: FieldError, label: string, translations: ErrorTranslations): string {
  const template = translations.fieldErrors[fieldError.code];
  return template === undefined ? fieldError.message : fill(template, { ...fieldError.params, field: label });
}
