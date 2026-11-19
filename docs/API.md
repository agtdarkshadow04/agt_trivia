# AGT Galactic Trivia API

The server's REST API lives under `/api/`. The complete, generated description is the OpenAPI 3.1 document at
`GET /api/openapi.json` (API-11); this guide explains the conventions it follows. The API grows with the rebuild
(#6): authoring, member accounts and score history arrive in their sub-issues.

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
- **CSRF:** every state-changing request to `/api/setup` and `/api/admin/*`, login and logout included, must carry
  the header `x-agt-request: 1` (`403 csrf` otherwise). The browser client adds it.
- **Rate limits:** first-run setup, Admin sign-in and the Admin password change allow `rateLimits.*` requests per
  client address (10 per 15 minutes by default, each counted separately); then `429 rate_limited`.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }` when the server and its database answer (SRV-11) |
| `GET /api/settings/public` | The settings the player UI needs: `siteTitle`, `supportUrl`, `quizShortLength`, `quizLongLength` (CFG-10) |
| `GET /api/categories` | Every category, `[{ id, shortName, name, description, priority, questionCount }]`, lower `priority` first, then by name; `questionCount` counts approved questions. A plain array (API-8) |
| `GET /api/categories/{id}/quiz?length=short\|long\|all` | A random quiz: `{ category, length, questions }`, with `quiz.shortLength`, `quiz.longLength` or all approved questions (fewer when the category has fewer). Each question is `{ id, prompt, choices: [{ id, text }], correctChoiceIds, authorCredit }`, choices in the author's order; more than one correct choice makes it a multi-answer question. An unknown or malformed `id` answers `404 not_found` |
| `GET /api/setup/status` | `{ adminExists, setupPasswordConfigured }` (AUTH-5) |
| `POST /api/setup` | `{ setupPassword, username, password }`: creates the Admin with `AGT_TRIVIA_SETUP_PASSWORD` and signs it in; `201 { username }` |
| `POST /api/admin/login` | `{ username, password }`: signs the Admin in; `200 { username }` |
| `POST /api/admin/logout` | Ends the session; `204` |
| `GET /api/admin/session` | `{ username, version, setupPasswordStillSet }` |
| `POST /api/admin/password` | `{ currentPassword, password }`: changes the password, ends every other session; `200 { username }` |
| `GET /api/admin/settings` | `{ settings }`: every dashboard setting with `value`, `source` (`config`, `dashboard` or `default`), `locked`, `default` and `description` |
| `PUT /api/admin/settings` | `{ values: { key: value or null } }`: changes settings (`null` resets one); `200 { settings, notices }` |
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
| `unauthorized` | 401 | No valid Admin session | — |
| `invalid_credentials` | 401 | Wrong username or password, or wrong current password | — |
| `invalid_setup_password` | 401 | Wrong setup password | — |
| `csrf` | 403 | A state-changing request without `x-agt-request: 1` | — |
| `not_found` | 404 | Unknown route, or an unknown or invisible resource | — |
| `conflict` | 409 | A backup or restore is already running, or the server stayed busy for 30 seconds; nothing was changed | — |
| `defined_in_config` | 409 | A settings update names a key that `config.yaml` sets; nothing was changed | `{ key }` |
| `setup_complete` | 410 | First-run setup after the Admin exists | — |
| `file_too_large` | 413 | A backup upload larger than `backup.maxZipBytes` | `{ maxBytes }` |
| `body_too_large` | 413 | The request body is larger than the route accepts | `{ maxBytes }` |
| `multipart_required` | 415 | A restore that is not `multipart/form-data` | — |
| `archive_rejected` | 422 | The backup archive failed a check; nothing was changed. `params.reason` says which: `too_large`, `not_zip`, `unsafe_zip`, `missing_manifest`, `invalid_manifest`, `not_a_backup`, `newer_format`, `unlisted_file`, `missing_file`, `checksum_mismatch`, `invalid_database`, `disallowed_entry`, `newer_schema`, `schema_mismatch`, `missing_tables`, `invalid_admin` | `{ reason }` |
| `rate_limited` | 429 | Too many requests; the `Retry-After` header says when to retry | `{ retryAfterSeconds }` |
| `internal` | 500 | An unexpected error; the server log has the details | — |
| `setup_password_missing` | 503 | First-run setup, but `AGT_TRIVIA_SETUP_PASSWORD` is not set | — |
| `maintenance` | 503 | A restore is running or has failed, or a write waited 30 seconds for a backup; `Retry-After: 10` | `{ retryAfterSeconds }` |

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
