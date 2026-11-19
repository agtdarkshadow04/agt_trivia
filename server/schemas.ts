import { Type } from '@sinclair/typebox';
import { FIELD_CODES } from '../src/lib/errors.js';

/**
 * TypeBox schemas of every route (API-10). Request schemas describe the shape
 * (types, required properties, no extra properties); the semantic rules run
 * afterwards in the shared validators of `src/lib/validation.ts`. Response
 * schemas must list every field a route returns: Fastify's serializer drops
 * undeclared ones, which is also how public responses stay public (API-3).
 */

export const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T, description?: string) =>
  Type.Object(properties, { additionalProperties: false, ...(description ? { description } : {}) });

/** An empty request part (no query string, no body properties). */
export const Empty = object({});

// --- Errors (API-6) -------------------------------------------------------

/** Every `error` code the server sends; `docs/API.md` lists each one (API-6, `server/test/openapi.test.ts`). */
export const errorCodes = [
  'invalid_request',
  'validation_failed',
  'not_found',
  'body_too_large',
  'rate_limited',
  'internal',
] as const;

const Params = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
  description: 'Values the translated message needs, e.g. `{ retryAfterSeconds }` or `{ maxBytes }`.',
});

export const FieldErrorSchema = Type.Object({
  field: Type.String({ description: 'The request property, dotted for nested ones (e.g. `choices.2`).' }),
  code: Type.String({ description: `One of: ${FIELD_CODES.map((code) => `\`${code}\``).join(', ')}.` }),
  message: Type.String({ description: 'English text; clients show the translated text of `code` instead.' }),
  params: Type.Optional(Params),
}, { $id: 'FieldError' });

export const ErrorBodySchema = Type.Object({
  error: Type.String({ description: `Stable snake_case code. One of: ${errorCodes.map((code) => `\`${code}\``).join(', ')}.` }),
  message: Type.String({ description: 'English text for humans and logs.' }),
  params: Type.Optional(Params),
  fields: Type.Optional(Type.Array(Type.Ref('FieldError'))),
}, { $id: 'ErrorBody' });

// --- Public reads ---------------------------------------------------------

export const Health = object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('maintenance')], { description: '`maintenance` while a restore runs.' }),
});

export const PublicSettings = object({
  siteTitle: Type.String({ description: '`site.title`.' }),
  supportUrl: Type.String({ description: '`site.supportUrl`.' }),
  quizShortLength: Type.Integer({ description: '`quiz.shortLength`: questions in a short quiz.' }),
  quizLongLength: Type.Integer({ description: '`quiz.longLength`: questions in a long quiz.' }),
}, 'The settings the player UI needs (CFG-10); nothing sensitive.');
