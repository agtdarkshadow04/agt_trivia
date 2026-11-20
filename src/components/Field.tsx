import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { ApiError } from '../lib/client';
import { errorText, fieldErrorText, type FieldError } from '../lib/errors';
import type { Translations } from '../translations';

/**
 * Form fields with the UI-9 `.field` markup (A11Y-5): a visible label, the help
 * text and the field error linked with `aria-describedby`, and
 * `aria-invalid="true"` while the field has an error.
 */

interface FieldParts {
  label: ReactNode;
  help?: ReactNode;
  error?: string;
}

export function TextField({ label, help, error, ...input }: FieldParts & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <span><label htmlFor={id}>{label}</label></span>
      <input id={id} {...input} aria-invalid={error ? true : undefined} aria-describedby={[errorId, helpId].filter(Boolean).join(' ') || undefined} />
      {help && <span id={helpId} className="field-help">{help}</span>}
      {error && <span id={errorId} className="field-error">{error}</span>}
    </div>
  );
}

/** A labelled select with the same help and error wiring as `TextField` (A11Y-5). */
export function SelectField({ label, help, error, children, ...select }: FieldParts & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <span><label htmlFor={id}>{label}</label></span>
      <select id={id} {...select} aria-invalid={error ? true : undefined} aria-describedby={[errorId, helpId].filter(Boolean).join(' ') || undefined}>
        {children}
      </select>
      {help && <span id={helpId} className="field-help">{help}</span>}
      {error && <span id={errorId} className="field-error">{error}</span>}
    </div>
  );
}

export interface FormErrors {
  /** The translated message for each field, by the field's name in the request. */
  fields: Record<string, string>;
  /** The translated message for the whole form, if any. */
  form: string;
}

export const noFormErrors: FormErrors = Object.freeze({ fields: Object.freeze({}), form: '' }) as FormErrors;

/**
 * The reader's messages for a failed check or request (I18N-6, FE-6): each field
 * error through `fieldErrorText()` with its translated label, the request's error
 * through `errorText()`. The browser's check and the server's answer give the
 * same text, because both report the same field codes.
 */
export function formErrors(result: readonly FieldError[] | unknown, t: Translations, labels: Readonly<Record<string, string>> = {}): FormErrors {
  const label = (field: string) => labels[field] ?? t.fields[field as keyof Translations['fields']] ?? field;
  const translate = (errors: readonly FieldError[]) => {
    const fields: Record<string, string> = {};
    for (const error of errors) fields[error.field] ??= fieldErrorText(error, label(error.field), t);
    return fields;
  };
  if (Array.isArray(result)) return { fields: translate(result as FieldError[]), form: '' };
  if (result instanceof ApiError) return { fields: translate(result.fields), form: errorText(result, t) };
  return { fields: {}, form: errorText(result, t) };
}
