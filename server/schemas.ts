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
  'category_not_empty',
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
  'attempt_invalid',
  'report_exists',
  'leaderboards_closed',
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
  leaderboards: Type.Boolean({ description: '`leaderboards.enabled`: categories have public leaderboards (#49).' }),
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
  choices: Type.Array(object({ id: Type.String({ format: 'uuid' }), text: Type.String() }), { description: '2 to 4 answers, shuffled anew for every quiz.' }),
  correctChoiceIds: Type.Array(Type.String({ format: 'uuid' }), { description: 'One ID, or several for a multi-answer question. Anonymous play is graded in the browser, as in 1.x.' }),
  authorCredit: Type.Union([Type.String(), Type.Null()], { description: 'The "Submitted by" credit, or null.' }),
}, 'An approved question as visitors see it (API-3): never its review note or the members who wrote or approved it.');

export const PublicQuiz = object({
  category: PublicCategory,
  length: QuizLength,
  questions: Type.Array(PublicQuestion, { description: 'A random selection of approved questions, as many as `length` asks for or all there are.' }),
  attempt: object({
    id: Type.String({ format: 'uuid' }),
    token: Type.String({ description: 'Signed by the server; a member sends it back as `attemptToken` with their result.' }),
    expiresAt: Type.String({ format: 'date-time', description: 'After this the result can no longer be saved.' }),
  }, 'The signed attempt of this draw (#45). Nothing is stored when a quiz is drawn.'),
});

// --- Leaderboards (#49) ---------------------------------------------------------

export const PublicLeaderboard = object({
  category: PublicCategory,
  minimumAnswers: Type.Integer({ description: 'Results count from a quiz of any length with at least this many answers: `quiz.shortLength`, or every question of a smaller category.' }),
  entries: Type.Array(object({
    rank: Type.Integer({ minimum: 1 }),
    displayName: Type.String({ description: "The member's display name; nothing else about them." }),
    bestPercent: Type.Integer({ description: '0 to 100, rounded; 100 only for a perfect score.' }),
    plays: Type.Integer({ description: 'Their results that count.' }),
  }), { description: 'At most `leaderboards.size`, best first: by best percentage, then more plays, then who reached it first.' }),
}, 'A category\'s leaderboard (#49): only active members who chose to appear on it, and only results saved from a signed quiz attempt (#45).');

export const MemberPreferences = object({
  leaderboardOptIn: Type.Boolean({ description: 'Whether the member appears, by display name, on the public leaderboards (#49). Off until they turn it on.' }),
}, "The signed-in member's own preferences.");

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
  lastSignInAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { description: 'The last successful sign-in, local or with an AGT account (#48); null when the member never signed in.' }),
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
  idleDays: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,3}$', description: 'Only members who never signed in or not in this many days (1 to 3650, #48).' })),
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
  openReports: Type.Union([Type.Integer(), Type.Null()], { description: 'Every open question report, for Moderators; null for Editors (#46).' }),
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

// --- Question reports (#46) ------------------------------------------------------

const ReportStatusSchema = Type.Union([Type.Literal('open'), Type.Literal('resolved'), Type.Literal('dismissed')]);

export const QuestionReport = object({
  id: Type.String({ format: 'uuid' }),
  questionId: Type.String({ format: 'uuid' }),
  questionPrompt: Type.String(),
  questionStatus: QuestionStatusSchema,
  categoryId: Type.String({ format: 'uuid' }),
  categoryName: Type.String(),
  reason: Type.Union(['wrong_answer', 'unclear', 'typo', 'outdated', 'other'].map((reason) => Type.Literal(reason))),
  note: Type.String({ description: "The member's details; empty when there are none." }),
  status: ReportStatusSchema,
  reportedBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()], { description: 'The reporting member; null once deleted.' }),
  reportedByName: Type.Union([Type.String(), Type.Null()], { description: "The reporting member's display name, or null." }),
  resolvedByName: Type.Union([Type.String(), Type.Null()], { description: 'The Moderator who resolved or dismissed it, or null.' }),
  resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  resolutionNote: Type.String({ description: "The Moderator's note for the record; empty when there is none." }),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, "A member's report of a problem with a question (#46).");

export const ReportCreateBody = object({
  reason: Type.String({ maxLength: 32, description: '`wrong_answer`, `unclear`, `typo`, `outdated` or `other`.' }),
  note: Type.String({ maxLength: 2000, description: 'Trimmed; at most 500 characters; required for `other`.' }),
});

export const ReportCloseBody = object({
  version: Type.Integer({ minimum: 1, description: 'The report version that was read; `409 conflict` when it has changed or is no longer open.' }),
  resolutionNote: Type.String({ maxLength: 2000, description: 'Trimmed; at most 500 characters; may be empty. Never shown to the reporting member.' }),
});

export const ReportPage = object({
  items: Type.Array(QuestionReport),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
}, 'Oldest first, as a work queue (API-8 deviation, #63).');

export const ReportListQuery = object({
  status: Type.Optional(ReportStatusSchema),
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', description: '1 to 200; 50 by default (API-8).' })),
  cursor: Type.Optional(Type.String({ maxLength: 512, description: 'The `nextCursor` of the previous page (API-8).' })),
});

export const ReportIdParams = object({ id: Type.String({ description: 'The report ID (a UUIDv4); anything else answers 404.' }) });

// --- Category management (#20) --------------------------------------------------

export const ManagedCategory = object({
  id: Type.String({ format: 'uuid' }),
  shortName: Type.String({ description: 'Letters, digits and `-`; the `?category=` link of the player UI.' }),
  name: Type.String(),
  description: Type.String(),
  priority: Type.Integer({ description: '0 to 100; lower first, then by name.' }),
  questionCounts: object({ draft: Type.Integer(), pending: Type.Integer(), approved: Type.Integer(), rejected: Type.Integer() }, 'The category\'s questions by status.'),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, 'A category as Moderators manage it.');

export const ManagedCategoryList = Type.Array(ManagedCategory, { description: 'Every category in display order: lower priority first, then by name (API-8: a plain array, bounded by moderator effort).' });

export const CategoryResult = object({
  category: ManagedCategory,
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2); always empty for categories.' }),
});

const categoryFields = {
  shortName: Type.String({ maxLength: 64, description: 'Trimmed; 1 to 16 letters, digits and `-`, unique ignoring case. Changing it breaks old `?category=` links.' }),
  name: Type.String({ maxLength: 400, description: 'Trimmed; 1 to 100 characters, unique ignoring case.' }),
  description: Type.String({ maxLength: 1200, description: 'Trimmed; 1 to 300 characters.' }),
  priority: Type.Integer({ description: '0 to 100; lower comes first.' }),
};

export const CategoryCreateBody = object(categoryFields);
export const CategoryReplaceBody = object({ ...categoryFields, version: Type.Integer({ minimum: 1, description: 'The category version that was read; `409 conflict` when it has changed since.' }) });
export const CategoryMoveBody = object({
  targetCategoryId: Type.String({ maxLength: 64, description: 'The category that gets every question of this one; another existing category.' }),
  version: Type.Integer({ minimum: 1, description: 'The version of the category the questions leave, as read; `409 conflict` when it has changed since.' }),
});

export const CategoryMoveResult = object({
  source: ManagedCategory,
  target: ManagedCategory,
  moved: Type.Integer({ description: 'How many questions moved, of any status.' }),
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2): `targetCategoryId` `duplicate` with `params.count` when moved questions have the same text as questions the target already had.' }),
});

export const CategoryDeleteQuery = object({ version: Type.String({ pattern: '^[1-9][0-9]{0,9}$', description: 'The category version that was read; `409 conflict` when it has changed since.' }) });

// --- Member score history (#21) ------------------------------------------------

export const QuizResult = object({
  id: Type.String({ format: 'uuid' }),
  categoryId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()], { description: 'Null once the category has been deleted.' }),
  categoryName: Type.String({ description: "The category's name when the quiz was played." }),
  length: QuizLength,
  score: Type.Integer({ description: 'Correct answers, as graded by the server.' }),
  total: Type.Integer({ description: 'Graded answers.' }),
  percent: Type.Integer({ description: '0 to 100, rounded; 100 only for a perfect score and 0 only for none right.' }),
  finishedAt: Type.String({ format: 'date-time' }),
}, "A finished quiz in the member's history.");

export const ResultCreateBody = object({
  categoryId: Type.String({ maxLength: 64 }),
  length: QuizLength,
  attemptToken: Type.Optional(Type.String({
    maxLength: 1024,
    description: "The `attempt.token` of the quiz that was played (#45): the answers must then be exactly its questions, in the order drawn, and the attempt is saved once (sending it again returns `200` with the saved result). A result without it is deprecated and will be refused from 3.0.0.",
  })),
  answers: Type.Array(object({
    questionId: Type.String({ maxLength: 64 }),
    choiceIds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 4, description: 'The chosen answers; empty counts as wrong.' }),
  }), { maxItems: 1000, description: 'One per question played, each question once, at most as many as the category has approved questions.' }),
});

export const ResultCreated = object({
  result: QuizResult,
  skippedQuestionIds: Type.Array(Type.String({ format: 'uuid' }), { description: 'Questions that are no longer approved: their answers were left out of the score.' }),
  notices: Type.Array(Type.Ref('FieldError'), { description: 'Non-blocking warnings (API-2); always empty for results.' }),
});

export const ResultPage = object({
  items: Type.Array(QuizResult),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
}, 'Newest first (API-8).');

export const ResultListQuery = object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', description: '1 to 200; 50 by default (API-8).' })),
  cursor: Type.Optional(Type.String({ maxLength: 512, description: 'The `nextCursor` of the previous page (API-8).' })),
  categoryId: Type.Optional(Type.String({ maxLength: 64, description: 'Only the results of this category.' })),
});

export const MemberStats = Type.Array(object({
  categoryId: Type.String({ format: 'uuid' }),
  categoryName: Type.String(),
  plays: Type.Integer(),
  bestPercent: Type.Integer({ description: '0 to 100, rounded; 100 only for a perfect score and 0 only for none right.' }),
  averagePercent: Type.Integer({ description: 'The mean of the exact percentages, 0 to 100, rounded; 100 only when every play was perfect and 0 only when none had a right answer.' }),
  lastPlayedAt: Type.String({ format: 'date-time' }),
}), { description: 'Per category that still exists, the most recently played first (a plain array, bounded by the number of categories, API-8).' });

// --- The sheet import (#22) -------------------------------------------------------

export const ImportReport = object({
  action: Type.Union([Type.Literal('preview'), Type.Literal('import')]),
  imported: Type.Boolean({ description: 'True once the import has been written; false for a preview.' }),
  categories: object({
    create: Type.Integer({ description: 'New categories (matched by name, ignoring case).' }),
    skip: Type.Integer({ description: 'Categories that already exist; they are left as they are.' }),
  }),
  questions: object({
    create: Type.Integer({ description: 'New questions.' }),
    skip: Type.Integer({ description: 'Questions whose category already has the same text (ignoring case), or repeated in the file.' }),
    approved: Type.Integer({ description: 'New questions with `isApproved` TRUE.' }),
    pending: Type.Integer({ description: 'New questions with `isApproved` FALSE: they wait for review.' }),
  }),
  problems: Type.Array(Type.Ref('FieldError'), { description: 'Every bad row: `field` is the file (`categories` or `questions`), `params.row` the sheet row (the header is row 1) and `params.column` the column. An import with any is refused.' }),
}, 'What an import of the sheet does, or did.');

export const ImportUploadDocument = {
  description: '`multipart/form-data`: the `action` field (`preview` or `import`) and the `categories` and `questions` files (one or both): CSV downloads of the sheet\'s `validCategories` and `pendingQuestions`, UTF-8 text of at most 1 MiB each.',
  content: {
    'multipart/form-data': {
      schema: object({
        action: Type.Union([Type.Literal('preview'), Type.Literal('import')], { description: '`preview` checks the files and changes nothing; `import` checks them again and writes them in one transaction.' }),
        categories: Type.Optional(Type.String({ format: 'binary', description: 'The `validCategories` sheet as CSV.' })),
        questions: Type.Optional(Type.String({ format: 'binary', description: 'The `pendingQuestions` sheet as CSV.' })),
      }),
    },
  },
};
