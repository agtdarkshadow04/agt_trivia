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
  'unknown_setting',
  'invalid_setting',
  'unauthorized',
  'invalid_credentials',
  'invalid_setup_password',
  'csrf',
  'not_found',
  'defined_in_config',
  'setup_complete',
  'body_too_large',
  'rate_limited',
  'internal',
  'setup_password_missing',
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

// --- Setup and the Admin session (AUTH-3..AUTH-6) --------------------------

const Password = Type.String({ maxLength: 1024, description: '12 to 1024 characters.' });

export const SetupStatus = object({
  adminExists: Type.Boolean(),
  setupPasswordConfigured: Type.Boolean({ description: 'Whether AGT_TRIVIA_SETUP_PASSWORD is set; setup needs it.' }),
});

export const SetupRequest = object({
  setupPassword: Type.String({ maxLength: 1024 }),
  username: Type.String({ maxLength: 64, description: 'Trimmed; 1 to 64 characters.' }),
  password: Password,
});

export const Credentials = object({
  username: Type.String({ maxLength: 64 }),
  password: Type.String({ maxLength: 1024 }),
});

export const PasswordChange = object({
  currentPassword: Type.String({ maxLength: 1024 }),
  password: Password,
});

export const AdminIdentity = object({ username: Type.String() });

export const AdminSession = object({
  username: Type.String(),
  version: Type.String({ description: 'The app version (VER-2).' }),
  setupPasswordStillSet: Type.Boolean({ description: 'AGT_TRIVIA_SETUP_PASSWORD is still set and should be removed (AUTH-6).' }),
});

export const NoContent = Type.Null({ description: 'No content.' });

// --- Settings (CFG-6..CFG-9) ----------------------------------------------

const SettingValue = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const SettingState = object({
  key: Type.String(),
  value: SettingValue,
  source: Type.Union([Type.Literal('config'), Type.Literal('dashboard'), Type.Literal('default')]),
  locked: Type.Boolean({ description: 'Set in config.yaml, so it cannot be changed here.' }),
  default: SettingValue,
  description: Type.String(),
});

export const SettingsList = object({ settings: Type.Array(SettingState) });

export const SettingsUpdate = object({
  values: Type.Record(Type.String(), Type.Union([SettingValue, Type.Null()]), { description: 'New values by key; `null` resets a key to its default.' }),
});

export const SettingsResult = object({
  settings: Type.Array(SettingState),
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2); always empty for settings.' }),
});
