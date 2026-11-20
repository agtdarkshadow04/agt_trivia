# AGT Galactic Trivia API

The server's REST API lives under `/api/`. The complete, generated description is the OpenAPI 3.1 document at
`GET /api/openapi.json` (API-11); this guide explains the conventions it follows. The API grows with the rebuild
(#6): authoring and score history arrive in their sub-issues.

## Requests and responses

- JSON in and out (`application/json`), camelCase property names (API-4). Request bodies are at most 2 MiB.
- Requests are checked against the route's schema: a missing or wrong-typed property, or one the route does not
  declare, is rejected (API-10). Nothing is silently dropped or converted.
- IDs are lowercase UUIDv4 strings (API-5); a malformed ID answers `404`.
- Times are ISO 8601 UTC strings ending in `Z` (API-7).
- No CORS headers are ever sent (API-9): the API serves only the app's own pages.

## Authentication

- **Public routes** need nothing.
- **The Admin** signs in with `POST /api/admin/login`, which sets the `agt_trivia_session` cookie (`HttpOnly`,
  `SameSite=Strict`, and `Secure` over HTTPS, `session.secureCookie`). Every `/api/admin/*` route except login needs
  it (`401 unauthorized` otherwise). No bearer token is accepted.
- **Members** (players, editors and moderators, #17) sign in with `POST /api/member/login`, which sets the
  `agt_trivia_member_session` cookie, with the same attributes. Every `/api/member/*` route except login needs it.
  **The two cookies never stand in for each other:** an Admin route ignores the member cookie and a member route
  ignores the Admin's, so a Moderator is never the Admin and the Admin is never a member.
- **CSRF:** every state-changing request to `/api/setup`, `/api/admin/*` and `/api/member/*`, sign-in and sign-out
  included, must carry the header `x-agt-request: 1` (`403 csrf` otherwise). The browser client adds it.
- **Rate limits:** first-run setup, Admin and member sign-in and both password changes allow `rateLimits.*` requests
  per client address (10 per 15 minutes by default, each route counted separately); then `429 rate_limited`.
- **Roles:** a Player plays and keeps a score history; an Editor also writes questions; a Moderator also reviews
  them and manages categories. A member route the role does not allow answers `403 forbidden`.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }` when the server and its database answer (SRV-11) |
| `GET /api/settings/public` | The settings the player UI needs: `siteTitle`, `supportUrl`, `quizShortLength`, `quizLongLength`, and `agtSignIn` (AGT sign-in is on and configured) (CFG-10) |
| `GET /api/categories` | Every category, `[{ id, shortName, name, description, priority, questionCount }]`, lower `priority` first, then by name; `questionCount` counts approved questions. A plain array (API-8) |
| `GET /api/categories/{id}/quiz?length=short\|long\|all` | A random quiz: `{ category, length, questions }`, with `quiz.shortLength`, `quiz.longLength` or all approved questions (fewer when the category has fewer). Each question is `{ id, prompt, choices: [{ id, text }], correctChoiceIds, authorCredit }`, choices in the author's order; more than one correct choice makes it a multi-answer question. An unknown or malformed `id` answers `404 not_found` |
| `GET /api/setup/status` | `{ adminExists, setupPasswordConfigured }` (AUTH-5) |
| `POST /api/setup` | `{ setupPassword, username, password }`: creates the Admin with `AGT_TRIVIA_SETUP_PASSWORD` and signs it in; `201 { username }` |
| `POST /api/admin/login` | `{ username, password }`: signs the Admin in; `200 { username }` |
| `POST /api/admin/logout` | Ends the session; `204` |
| `GET /api/admin/session` | `{ username, version, setupPasswordStillSet }` |
| `POST /api/admin/password` | `{ currentPassword, password }`: changes the password, ends every other session; `200 { username }` |
| `POST /api/member/login` | `{ username, password }`: signs a member in (the username ignoring case); `200` the member: `{ id, username, displayName, role, authSource }` |
| `POST /api/member/iam/login` | `{ travellerName, password }`: signs a member in with their AGT account through AGT IAM (#18); the first sign-in creates the member, every sign-in sets the role from the AGT tier. The password goes only to AGT IAM; `200` the member |
| `POST /api/member/logout` | Ends the member session; `204` |
| `GET /api/member/session` | The signed-in member |
| `POST /api/member/password` | `{ currentPassword, password }`: changes a local member's password, ends their other sessions; `200` the member |
| `GET /api/admin/members` | Member accounts, newest first: `{ items, nextCursor }` (API-8; `limit`, `cursor`, and `q` to search usernames and display names) |
| `POST /api/admin/members` | `{ username, displayName, role, password }`: creates a local member; `201 { member, notices }` |
| `PUT /api/admin/members/{id}` | `{ displayName, role, isActive }`; a role change or deactivation signs the member out; for an AGT member only `isActive` may change (`409 managed_by_iam`); `200 { member, notices }` |
| `POST /api/admin/members/{id}/password` | `{ password }`: sets a local member's password and signs them out; `200` the member |
| `DELETE /api/admin/members/{id}` | Deletes the member and their sessions; their questions stay, without their ID; `204` |
| `GET /api/admin/settings` | `{ settings, iam }`: `iam` is the AGT sign-in status `{ enabled, available, missing }`, and `settings` every dashboard setting with `value`, `source` (`config`, `dashboard` or `default`), `locked`, `default` and `description` |
| `PUT /api/admin/settings` | `{ values: { key: value or null } }`: changes settings (`null` resets one); `200 { settings, iam, notices }`. Switching `iam.enabled` off signs every AGT member out |
| `GET /api/admin/logs/server`, `GET /api/admin/logs/audit` | The server log and the audit log, newest first, with filters (`limit`, `cursor`) |
| `GET /api/admin/logs/server/export`, `GET /api/admin/logs/audit/export` | The same entries as JSON Lines or CSV (`format=jsonl` or `csv`) |
| `GET /api/admin/logs/server/summary`, `POST /api/admin/logs/server/seen` | Unseen warnings and errors, and marking them seen |
| `DELETE /api/admin/logs/server` | Clears the server log; the audit log cannot be cleared |
| `GET /api/admin/backup` | A backup archive (`application/zip`): `manifest.json`, `database.sqlite` and `config.yaml` |
| `POST /api/admin/restore` | `multipart/form-data` with `action` (`preview` or `restore`) and the `backup` file: previews or restores a backup |
| `GET /api/openapi.json` | The OpenAPI document |

## Errors

Every non-2xx response has the same body (API-6):

```json
{
  "error": "validation_failed",
  "message": "The request is invalid: prompt is required.",
  "fields": [{ "field": "prompt", "code": "required", "message": "prompt is required." }]
}
```

`error` is a stable snake_case code that clients translate and may branch on; `message` is English text for people
and logs, which clients show only for codes they do not know. `params` carries the values a translated text needs,
and `fields` lists field-level problems, each with a `field` (the request property, dotted for nested ones), a field
`code` and its own `params`.

| `error` | Status | When | `params` |
| --- | --- | --- | --- |
| `invalid_request` | 400 | The request is malformed: bad JSON, a bad query string or path parameter | — |
| `validation_failed` | 400 | The body failed validation; `fields` says where | — |
| `unknown_setting` | 400 | A settings update names a key that is not a dashboard setting | `{ key }` |
| `invalid_setting` | 400 | A settings update has a value the setting does not allow | `{ key }` |
| `file_required` | 400 | A restore upload without its `backup` file | — |
| `unauthorized` | 401 | No valid Admin session on an Admin route, or no valid member session on a member route | — |
| `invalid_credentials` | 401 | Wrong username or password, or wrong current password | — |
| `invalid_setup_password` | 401 | Wrong setup password | — |
| `csrf` | 403 | A state-changing request without `x-agt-request: 1` | — |
| `iam_disabled` | 403 | AGT sign-in while `iam.enabled` is off | — |
| `app_access_denied` | 403 | AGT IAM does not authorize the traveller for this app (or gives the tier `NOACCESS` or `NONE`); nothing was created | — |
| `forbidden` | 403 | The member's role does not allow this, or an AGT member asks to change a password here | — |
| `not_found` | 404 | Unknown route, or an unknown or invisible resource | — |
| `conflict` | 409 | A backup or restore is already running, or the server stayed busy for 30 seconds; nothing was changed | — |
| `managed_by_iam` | 409 | The Admin changes an AGT member's name, role or password: AGT IAM sets those; only activate, deactivate or delete | — |
| `defined_in_config` | 409 | A settings update names a key that `config.yaml` sets; nothing was changed | `{ key }` |
| `setup_complete` | 410 | First-run setup after the Admin exists | — |
| `file_too_large` | 413 | A backup upload larger than `backup.maxZipBytes` | `{ maxBytes }` |
| `body_too_large` | 413 | The request body is larger than the route accepts | `{ maxBytes }` |
| `multipart_required` | 415 | A restore that is not `multipart/form-data` | — |
| `archive_rejected` | 422 | The backup archive failed a check; nothing was changed. `params.reason` says which: `too_large`, `not_zip`, `unsafe_zip`, `missing_manifest`, `invalid_manifest`, `not_a_backup`, `newer_format`, `unlisted_file`, `missing_file`, `checksum_mismatch`, `invalid_database`, `disallowed_entry`, `newer_schema`, `schema_mismatch`, `missing_tables`, `invalid_admin` | `{ reason }` |
| `rate_limited` | 429 | Too many requests; the `Retry-After` header says when to retry | `{ retryAfterSeconds }` |
| `internal` | 500 | An unexpected error; the server log has the details | — |
| `iam_bad_gateway` | 502 | AGT IAM could not be reached or answered unexpectedly | — |
| `setup_password_missing` | 503 | First-run setup, but `AGT_TRIVIA_SETUP_PASSWORD` is not set | — |
| `iam_unavailable` | 503 | AGT sign-in is on but not fully configured, or AGT IAM refused this app (see the server log) | — |
| `maintenance` | 503 | A restore is running or has failed, or a write waited 30 seconds for a backup; `Retry-After: 10` | `{ retryAfterSeconds }` |
| `iam_timeout` | 504 | AGT IAM did not answer within `iam.timeoutSeconds` | — |

Field codes: `required`, `too_long` (`{ max }`), `too_short` (`{ min }`), `out_of_range` (`{ min?, max? }`),
`too_many` (`{ max }`), `too_few` (`{ min }`, a list with too few items), `invalid_format`, `invalid_url`,
`not_allowed`, `duplicate`, `mismatch` (`{ other }`), `same_as_setup_password` and `correct_choice_required` (a
question without a correct answer).

## Notices

A successful write may return `notices` (API-2): non-blocking warnings with the same shape as field errors. A question
whose prompt has more than 15 words gets `too_many_words` (`{ max, count }`) on `prompt`.

## Public data

Public routes return only the fields their schemas list (API-3). The quiz includes the correct answers, as the 1.x
published sheet did: anonymous play is graded in the browser and writes nothing. Questions that are not approved,
review notes and the members who wrote or approved a question are never public.
