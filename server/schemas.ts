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

// --- Logs (LOG-18) -----------------------------------------------------------

const Text = (maxLength: number, description?: string) => Type.String({ maxLength, ...(description ? { description } : {}) });
const Time = Type.String({ format: 'date-time', description: 'ISO 8601.' });
const page = {
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', description: '1 to 200; 50 by default (API-8).' })),
  cursor: Type.Optional(Text(64, 'The `nextCursor` of the previous page (API-8).')),
};

export const ServerLogQuery = object({
  level: Type.Optional(Type.Union(['info', 'warn', 'error', 'fatal'].map((level) => Type.Literal(level)), { description: 'The minimum level.' })),
  source: Type.Optional(Text(100)),
  from: Type.Optional(Time),
  to: Type.Optional(Time),
  q: Type.Optional(Text(200, 'Text in the message.')),
  ...page,
});

export const AuditLogQuery = object({
  actorType: Type.Optional(Type.Union([Type.Literal('admin'), Type.Literal('anonymous')])),
  action: Type.Optional(Text(100)),
  outcome: Type.Optional(Type.Union(['success', 'denied', 'rate_limited', 'failure'].map((outcome) => Type.Literal(outcome)))),
  targetType: Type.Optional(Text(100)),
  targetId: Type.Optional(Text(200)),
  from: Type.Optional(Time),
  to: Type.Optional(Time),
  q: Type.Optional(Text(200, 'Text in the actor, action, target and details.')),
  ...page,
});

const exportFormat = { format: Type.Union([Type.Literal('jsonl'), Type.Literal('csv')], { description: 'JSON Lines or CSV (LOG-22).' }) };
const withoutPage = <T extends Record<string, unknown>>(properties: T) => {
  const { limit: _limit, cursor: _cursor, ...rest } = properties as T & { limit?: unknown; cursor?: unknown };
  return rest;
};
export const ServerLogExportQuery = object({ ...withoutPage(ServerLogQuery.properties), ...exportFormat });
export const AuditLogExportQuery = object({ ...withoutPage(AuditLogQuery.properties), ...exportFormat });

const Details = Type.Record(Type.String(), Type.Unknown(), { description: 'A JSON summary; never secrets or request bodies (LOG-9, LOG-14).' });
const nullableText = Type.Union([Type.String(), Type.Null()]);

export const ServerLogEntry = object({
  id: Type.String(),
  at: Type.String({ format: 'date-time' }),
  level: Type.Union(['info', 'warn', 'error', 'fatal'].map((level) => Type.Literal(level))),
  source: Type.String(),
  message: Type.String(),
  requestId: nullableText,
  details: Details,
});

export const AuditLogEntry = object({
  id: Type.String(),
  at: Type.String({ format: 'date-time', description: 'The first time.' }),
  lastAt: Type.String({ format: 'date-time', description: 'The last time; later than `at` for coalesced entries.' }),
  count: Type.Integer({ description: 'Identical events coalesced into this entry (LOG-11).' }),
  actorType: Type.Union([Type.Literal('admin'), Type.Literal('anonymous')]),
  actor: nullableText,
  ipHash: Type.Union([Type.String({ description: 'A pseudonymous address hash, never the address (LOG-12).' }), Type.Null()]),
  client: Type.Union([Type.Literal('web'), Type.Literal('api')]),
  action: Type.String({ description: 'The route\'s operationId.' }),
  method: Type.String(),
  route: Type.String(),
  targetType: nullableText,
  targetId: nullableText,
  outcome: Type.Union(['success', 'denied', 'rate_limited', 'failure'].map((outcome) => Type.Literal(outcome))),
  statusCode: Type.Integer(),
  requestId: nullableText,
  details: Details,
});

const LogPage = (item: ReturnType<typeof object>) => object({
  items: Type.Array(item),
  nextCursor: Type.Union([Type.String(), Type.Null()], { description: 'null on the last page.' }),
});
export const ServerLogPage = LogPage(ServerLogEntry);
export const AuditLogPage = LogPage(AuditLogEntry);

export const ServerLogSummary = object({
  unseenWarnings: Type.Integer(),
  unseenErrors: Type.Integer({ description: 'Unseen `error` and `fatal` entries.' }),
});

/** A streamed download (LOG-22): JSON Lines or CSV. */
export const LogExport = {
  description: 'The matching entries, newest first, as an attachment.',
  content: {
    'application/x-ndjson': { schema: Type.String({ description: 'One JSON object per line.' }) },
    'text/csv': { schema: Type.String({ description: 'A header row, then one row per entry.' }) },
  },
};
