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
] as const;

export type FieldCode = typeof FIELD_CODES[number];

export function fieldError(field: string, code: FieldCode, message: string, params?: FieldParams): FieldError {
  return params ? { field, code, message, params } : { field, code, message };
}
