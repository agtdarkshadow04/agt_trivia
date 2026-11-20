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
  'file_required',
  'csrf',
  'forbidden',
  'iam_disabled',
  'app_access_denied',
  'not_found',
  'conflict',
  'managed_by_iam',
  'defined_in_config',
  'setup_complete',
  'file_too_large',
  'body_too_large',
  'multipart_required',
  'archive_rejected',
  'rate_limited',
  'internal',
  'iam_bad_gateway',
  'setup_password_missing',
  'iam_unavailable',
  'maintenance',
  'iam_timeout',
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
  agtSignIn: Type.Boolean({ description: 'Members can sign in with their AGT account: `iam.enabled` is on and AGT IAM is configured (#18).' }),
}, 'The settings the player UI needs (CFG-10); nothing sensitive.');

// --- Categories and the public quiz (#15) -----------------------------------

export const PublicCategory = object({
  id: Type.String({ format: 'uuid' }),
  shortName: Type.String({ description: 'Letters, digits and `-`; the `?category=` link of the player UI.' }),
  name: Type.String(),
  description: Type.String(),
  priority: Type.Integer({ description: '0 to 100; lower first, then by name.' }),
  questionCount: Type.Integer({ description: 'Approved questions: what a quiz can draw from.' }),
}, 'A category as visitors see it (API-3).');

export const PublicCategoryList = Type.Array(PublicCategory, { description: 'Every category, lower priority first, then by name (API-8: a plain array, bounded by moderator effort).' });

export const CategoryIdParams = object({ id: Type.String({ description: 'The category ID (a UUIDv4); anything else answers 404.' }) });

export const QuizLength = Type.Union([Type.Literal('short'), Type.Literal('long'), Type.Literal('all')], {
  description: '`short` (`quiz.shortLength` questions), `long` (`quiz.longLength`) or `all` approved questions.',
});

export const QuizQuery = object({ length: QuizLength });

export const PublicQuestion = object({
  id: Type.String({ format: 'uuid' }),
  prompt: Type.String(),
  choices: Type.Array(object({ id: Type.String({ format: 'uuid' }), text: Type.String() }), { description: "2 to 4 answers, in the author's order." }),
  correctChoiceIds: Type.Array(Type.String({ format: 'uuid' }), { description: 'One ID, or several for a multi-answer question. Anonymous play is graded in the browser, as in 1.x.' }),
  authorCredit: Type.Union([Type.String(), Type.Null()], { description: 'The "Submitted by" credit, or null.' }),
}, 'An approved question as visitors see it (API-3): never its review note or the members who wrote or approved it.');

export const PublicQuiz = object({
  category: PublicCategory,
  length: QuizLength,
  questions: Type.Array(PublicQuestion, { description: 'A random selection of approved questions, as many as `length` asks for or all there are.' }),
});

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

export const IamCredentials = object({
  travellerName: Type.String({ minLength: 1, maxLength: 84, description: 'The AGT Traveller Name.' }),
  password: Type.String({ minLength: 1, maxLength: 1024, description: 'The AGT password; sent only to AGT IAM, never stored or logged.' }),
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
  restoreFailed: Type.Boolean({ description: 'A restore failed and could not be rolled back: only a restore ends the maintenance (BAK-11).' }),
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

export const IamStatus = object({
  enabled: Type.Boolean({ description: 'The effective `iam.enabled` setting.' }),
  available: Type.Boolean({ description: 'Enabled and configured: members can sign in with their AGT account.' }),
  missing: Type.Array(Type.Union([Type.Literal('baseUrl'), Type.Literal('appId'), Type.Literal('apiKey')]), {
    description: 'What AGT sign-in still needs: `iam.baseUrl` or `iam.appId` in config.yaml, or AGT_TRIVIA_IAM_API_KEY in .env.',
  }),
}, 'The AGT sign-in status (#18).');

export const SettingsList = object({ settings: Type.Array(SettingState), iam: IamStatus });

export const SettingsUpdate = object({
  values: Type.Record(Type.String(), Type.Union([SettingValue, Type.Null()]), { description: 'New values by key; `null` resets a key to its default.' }),
});

export const SettingsResult = object({
  settings: Type.Array(SettingState),
  iam: IamStatus,
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
  actorType: Type.Optional(Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('anonymous')])),
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
  actorType: Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('anonymous')]),
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

// --- Backup and restore (§12) -------------------------------------------------

export const BackupDownload = {
  description: 'The backup archive (BAK-2), as an attachment.',
  content: { 'application/zip': { schema: Type.String({ format: 'binary' }) } },
};

/** The restore upload as the OpenAPI document shows it; the route reads the parts itself (BAK-1). */
export const RestoreUploadDocument = {
  description: 'multipart/form-data with the `action` field and the `backup` file.',
  content: {
    'multipart/form-data': {
      schema: object({
        action: Type.Union([Type.Literal('preview'), Type.Literal('restore')], { description: '`preview` checks the archive and changes nothing; `restore` checks it again and replaces the data.' }),
        backup: Type.String({ format: 'binary', description: 'A backup archive (BAK-2).' }),
      }),
    },
  },
};

const DiffLine = object({ kind: Type.Union([Type.Literal('+'), Type.Literal('-'), Type.Literal(' ')]), text: Type.String() });

export const RestoreReport = object({
  createdAt: Type.String({ format: 'date-time' }),
  appVersion: Type.String(),
  schemaVersion: object({ backup: Type.Integer(), current: Type.Integer() }),
  counts: object({ categories: Type.Integer(), questions: Type.Integer({ description: 'Of every status.' }), members: Type.Integer(), admin: Type.Integer(), settings: Type.Integer() }),
  adminUsername: Type.Union([Type.String(), Type.Null()]),
  ignoredSettings: Type.Array(Type.String(), { description: 'Settings the backup has that this config.yaml locks: dropped (CFG-8).' }),
  warningCodes: Type.Array(Type.String(), { description: '`no_admin`, `set_aside_not_deleted`.' }),
  config: object({
    included: Type.Boolean(),
    identical: Type.Boolean(),
    diff: Type.Array(DiffLine, { description: 'The current config.yaml against the backup\'s, line by line. It is never restored (BAK-5).' }),
    content: Type.Union([Type.String(), Type.Null()], { description: 'The backup\'s config.yaml, to download and apply by hand.' }),
  }),
  preRestoreBackup: Type.Union([Type.String(), Type.Null()], { description: 'After a restore: the pre-restore backup\'s file name.' }),
}, 'What the backup holds, and after a restore, what was done (BAK-3, BAK-4).');

// --- Members (#17, the AUTH-1 deviation) -------------------------------------

const MemberRoleSchema = Type.Union([Type.Literal('Player'), Type.Literal('Editor'), Type.Literal('Moderator')], {
  description: 'Player: plays and keeps a score history. Editor: also writes questions. Moderator: also reviews questions and manages categories.',
});

const memberSessionFields = {
  id: Type.String({ format: 'uuid' }),
  username: Type.Union([Type.String(), Type.Null()], { description: 'Lowercase; null for an AGT member (#18).' }),
  displayName: Type.String(),
  role: MemberRoleSchema,
  authSource: Type.Union([Type.Literal('local'), Type.Literal('agt_iam')]),
};

export const MemberSession = object(memberSessionFields, 'The signed-in member.');

export const AdminMember = object({
  ...memberSessionFields,
  isActive: Type.Boolean({ description: 'An inactive member cannot sign in.' }),
  travellerId: Type.Union([Type.String(), Type.Null()], { description: "An AGT member's AGT traveller ID (#18); null for a local member." }),
  iamPermission: Type.Union([Type.String(), Type.Null()], { description: "An AGT member's AGT IAM tier at their last sign-in; null for a local member." }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, 'A member account as the Admin sees it.');

export const MemberResult = object({
  member: AdminMember,
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2); always empty for members.' }),
});

export const MemberPage = object({
  items: Type.Array(AdminMember),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
}, 'Newest first (API-8).');

export const MemberListQuery = object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', description: '1 to 200; 50 by default (API-8).' })),
  cursor: Type.Optional(Type.String({ maxLength: 512, description: 'The `nextCursor` of the previous page (API-8).' })),
  q: Type.Optional(Type.String({ maxLength: 120, description: 'Part of a username or display name, ignoring ASCII case.' })),
});

export const MemberIdParams = object({ id: Type.String({ description: 'The member ID (a UUIDv4); anything else answers 404.' }) });

export const MemberCreateBody = object({
  username: Type.String({ maxLength: 128, description: 'Trimmed and stored lowercase: 3 to 64 letters, digits, dots, underscores or hyphens.' }),
  displayName: Type.String({ maxLength: 240, description: 'Trimmed; 1 to 120 characters.' }),
  role: MemberRoleSchema,
  password: Password,
});

export const MemberReplaceBody = object({
  displayName: Type.String({ maxLength: 240, description: 'Trimmed; 1 to 120 characters.' }),
  role: MemberRoleSchema,
  isActive: Type.Boolean(),
});

export const MemberPasswordBody = object({ password: Password });

// --- Question authoring and review (#19) ----------------------------------------

const QuestionStatusSchema = Type.Union([Type.Literal('draft'), Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected')], {
  description: 'draft → pending (submitted) → approved (in the public quiz) or rejected (with a review note); a changed rejected question is a draft again, and an unpublished one too.',
});

const Version = Type.Integer({ minimum: 1, description: 'The question version that was read; `409 conflict` when it has changed since.' });

export const MemberQuestion = object({
  id: Type.String({ format: 'uuid' }),
  categoryId: Type.String({ format: 'uuid' }),
  prompt: Type.String(),
  status: QuestionStatusSchema,
  choices: Type.Array(object({ id: Type.String({ format: 'uuid' }), text: Type.String(), isCorrect: Type.Boolean() }), { description: "2 to 4 answers, in the author's order." }),
  authorCredit: Type.Union([Type.String(), Type.Null()], { description: 'The "Submitted by" credit players see, or null.' }),
  reviewNote: Type.String({ description: "A Moderator's reason for rejecting it; empty when there is none. Never public." }),
  createdBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()], { description: 'The member who wrote it; null when they were deleted or it was imported.' }),
  createdByName: Type.Union([Type.String(), Type.Null()], { description: "The author's display name, or null." }),
  approvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, 'A question as its author or a Moderator sees it.');

export const QuestionResult = object({
  question: MemberQuestion,
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2): `prompt` `too_many_words` (more than 15 words) and `prompt` `duplicate` (the category has a question with the same text).' }),
});

export const QuestionPage = object({
  items: Type.Array(MemberQuestion),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
}, 'Newest first (API-8).');

export const QuestionListQuery = object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', description: '1 to 200; 50 by default (API-8).' })),
  cursor: Type.Optional(Type.String({ maxLength: 512, description: 'The `nextCursor` of the previous page (API-8).' })),
  status: Type.Optional(QuestionStatusSchema),
  categoryId: Type.Optional(Type.String({ maxLength: 64, description: 'Only the questions of this category.' })),
  mine: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')], { description: "Moderators: `true` lists only their own questions. Editors always see only their own." })),
  q: Type.Optional(Type.String({ maxLength: 300, description: 'Part of the question text, ignoring ASCII case.' })),
});

const statusCounts = object({ draft: Type.Integer(), pending: Type.Integer(), approved: Type.Integer(), rejected: Type.Integer() });

export const QuestionCounts = object({
  mine: statusCounts,
  reviewQueue: Type.Union([Type.Integer(), Type.Null()], { description: 'Every pending question, for Moderators; null for Editors.' }),
});

export const QuestionIdParams = object({ id: Type.String({ description: 'The question ID (a UUIDv4); anything else, or a question the member may not see, answers 404.' }) });

const questionContent = {
  categoryId: Type.String({ maxLength: 64, description: 'An existing category.' }),
  prompt: Type.String({ maxLength: 1200, description: 'Trimmed; 1 to 300 characters. More than 15 words gives a notice.' }),
  choices: Type.Array(object({
    text: Type.String({ maxLength: 800, description: 'Trimmed; 1 to 200 characters, unique within the question ignoring case.' }),
    isCorrect: Type.Boolean(),
  }), { maxItems: 8, description: '2 to 4 answers, at least one correct; more than one correct makes a multi-answer question.' }),
  authorCredit: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()], {
    description: 'The "Submitted by" credit: 1 to 64 characters, or empty or null for none. Only Moderators can change it; left out, a new question gets the author\'s display name and a changed one keeps its credit.',
  })),
};

export const QuestionCreateBody = object(questionContent);
export const QuestionReplaceBody = object({ ...questionContent, version: Version });
export const QuestionVersionBody = object({ version: Version });
export const QuestionRejectBody = object({ version: Version, reviewNote: Type.String({ maxLength: 4000, description: 'Required, trimmed; 1 to 1000 characters. The author sees it.' }) });
export const QuestionDeleteQuery = object({ version: Type.String({ pattern: '^[1-9][0-9]{0,9}$', description: 'The question version that was read; `409 conflict` when it has changed since.' }) });
