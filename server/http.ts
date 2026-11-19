import { fieldError, type FieldCode, type FieldError } from '../src/lib/errors.js';

/**
 * `HttpError` and `errorReply()`: the one mapping from thrown errors to the
 * API-6 error body (SRV-5). Handlers and services throw; only the app's error
 * handler builds an error response.
 */

export type ErrorParams = Record<string, string | number | boolean>;

export interface HttpErrorOptions {
  /** Field-level errors (`validation_failed`, and conflicts on one field). */
  fields?: FieldError[];
  /** Values the translated message needs, e.g. `{ retryAfterSeconds }` (API-6). */
  params?: ErrorParams;
}

/** An error with an HTTP status and a stable snake_case code listed in `errorCodes` (API-6). */
export class HttpError extends Error {
  readonly fields?: FieldError[];
  readonly params?: ErrorParams;

  constructor(readonly statusCode: number, readonly error: string, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.fields = options.fields;
    this.params = options.params;
  }
}

/** A `400 validation_failed` for one field. */
export function invalidField(field: string, code: FieldCode, message: string, params?: ErrorParams) {
  return new HttpError(400, 'validation_failed', message, { fields: [fieldError(field, code, message, params)] });
}

/** A rate limit was hit: `429`, `Retry-After` and `params.retryAfterSeconds` (SEC-7, API-6). */
export class RateLimitedError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'rate_limited', `Too many requests. Try again in ${retryAfterSeconds} seconds.`, { params: { retryAfterSeconds } });
  }
}

/** The API-6 error body. */
export interface ErrorBody {
  error: string;
  message: string;
  params?: ErrorParams;
  fields?: FieldError[];
}

export interface ErrorReply {
  statusCode: number;
  headers: Record<string, string>;
  body: ErrorBody;
}

/** An Ajv error from a route's TypeBox schema, as Fastify attaches it to `error.validation`. */
interface SchemaIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (!(error instanceof Error) || !('validation' in error) || !Array.isArray(error.validation)) return null;
  return error.validation as SchemaIssue[];
}

/** Where Fastify found the invalid value: `body`, `querystring`, `params` or `headers`. */
function schemaContext(error: unknown) {
  return error instanceof Error && 'validationContext' in error && typeof error.validationContext === 'string' ? error.validationContext : 'body';
}

/**
 * Maps a schema failure to field errors (API-6); the field is the request
 * property, dotted for nested ones. Messages name the field, never its value.
 */
export function fieldErrorsFromSchema(issues: readonly SchemaIssue[]): FieldError[] {
  return issues.map((issue) => {
    const path = issue.instancePath.split('/').filter(Boolean);
    const name = (extra?: unknown) => [...path, ...(typeof extra === 'string' ? [extra] : [])].join('.') || '(body)';
    const limit = typeof issue.params.limit === 'number' ? issue.params.limit : undefined;
    switch (issue.keyword) {
      case 'required':
        return fieldError(name(issue.params.missingProperty), 'required', `${name(issue.params.missingProperty)} is required.`);
      case 'additionalProperties':
        return fieldError(name(issue.params.additionalProperty), 'not_allowed', `${name(issue.params.additionalProperty)} is not allowed.`);
      case 'maxLength':
        return fieldError(name(), 'too_long', `${name()} must be at most ${limit} characters.`, limit === undefined ? undefined : { max: limit });
      case 'minLength':
        return limit === 1
          ? fieldError(name(), 'required', `${name()} is required.`)
          : fieldError(name(), 'too_short', `${name()} must be at least ${limit} characters.`, limit === undefined ? undefined : { min: limit });
      case 'maxItems':
        return fieldError(name(), 'too_many', `${name()} must have at most ${limit} items.`, limit === undefined ? undefined : { max: limit });
      case 'maximum':
      case 'exclusiveMaximum':
        return fieldError(name(), 'out_of_range', `${name()} is too large.`, limit === undefined ? undefined : { max: limit });
      case 'minimum':
      case 'exclusiveMinimum':
        return fieldError(name(), 'out_of_range', `${name()} is too small.`, limit === undefined ? undefined : { min: limit });
      case 'enum':
      case 'const':
      case 'anyOf':
      case 'oneOf':
        return fieldError(name(), 'not_allowed', `${name()} is not an allowed value.`);
      case 'format':
        return fieldError(name(), issue.params.format === 'uri' ? 'invalid_url' : 'invalid_format', `${name()} has the wrong format.`);
      default:
        return fieldError(name(), 'invalid_format', `${name()} has the wrong type or format.`);
    }
  });
}

/** Fastify's own errors carry a `code` such as FST_ERR_CTP_BODY_TOO_LARGE and a status. */
function fastifyError(error: unknown): { code: string; statusCode?: number } | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string' || !error.code.startsWith('FST_')) return null;
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
  return { code: error.code, statusCode };
}

/**
 * Maps any thrown error to a response without exposing internal details.
 * Unexpected errors are reported through `onUnexpected` and answered with a
 * generic 500 (SRV-5).
 */
export function errorReply(error: unknown, options: { maxBodyBytes: number; onUnexpected?: (error: unknown) => void }): ErrorReply {
  const reply = (statusCode: number, body: ErrorBody, headers: Record<string, string> = {}): ErrorReply => ({ statusCode, headers, body });
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (typeof error.params?.retryAfterSeconds === 'number') headers['retry-after'] = String(error.params.retryAfterSeconds);
    return reply(error.statusCode, {
      error: error.error,
      message: error.message,
      ...(error.params ? { params: error.params } : {}),
      ...(error.fields ? { fields: error.fields } : {}),
    }, headers);
  }
  const issues = schemaIssues(error);
  if (issues) {
    // A malformed query string or path parameter is a bad request, not a form error.
    if (schemaContext(error) !== 'body') return reply(400, { error: 'invalid_request', message: 'The request is invalid.' });
    const fields = fieldErrorsFromSchema(issues);
    return reply(400, { error: 'validation_failed', message: `The request is invalid: ${fields[0]?.message ?? 'it does not match the schema.'}`, fields });
  }
  const fastify = fastifyError(error);
  if (fastify?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply(413, { error: 'body_too_large', message: 'The request body is too large.', params: { maxBytes: options.maxBodyBytes } }, { connection: 'close' });
  }
  if (fastify?.statusCode && fastify.statusCode >= 400 && fastify.statusCode < 500) {
    return reply(400, { error: 'invalid_request', message: 'The request is invalid.' });
  }
  options.onUnexpected?.(error);
  return reply(500, { error: 'internal', message: 'An unexpected server error occurred.' });
}
