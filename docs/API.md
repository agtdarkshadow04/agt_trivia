# AGT Galactic Trivia API

The server's REST API lives under `/api/`. The complete, generated description is the OpenAPI 3.1 document at
`GET /api/openapi.json` (API-11); this guide explains the conventions it follows. The API grows with the rebuild
(#6): categories, questions, member accounts and score history arrive in their sub-issues.

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
| `GET /api/setup/status` | `{ adminExists, setupPasswordConfigured }` (AUTH-5) |
| `POST /api/setup` | `{ setupPassword, username, password }`: creates the Admin with `AGT_TRIVIA_SETUP_PASSWORD` and signs it in; `201 { username }` |
| `POST /api/admin/login` | `{ username, password }`: signs the Admin in; `200 { username }` |
| `POST /api/admin/logout` | Ends the session; `204` |
| `GET /api/admin/session` | `{ username, version, setupPasswordStillSet }` |
| `POST /api/admin/password` | `{ currentPassword, password }`: changes the password, ends every other session; `200 { username }` |
| `GET /api/admin/settings` | `{ settings }`: every dashboard setting with `value`, `source` (`config`, `dashboard` or `default`), `locked`, `default` and `description` |
| `PUT /api/admin/settings` | `{ values: { key: value or null } }`: changes settings (`null` resets one); `200 { settings, notices }` |
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
| `unauthorized` | 401 | No valid Admin session | — |
| `invalid_credentials` | 401 | Wrong username or password, or wrong current password | — |
| `invalid_setup_password` | 401 | Wrong setup password | — |
| `csrf` | 403 | A state-changing request without `x-agt-request: 1` | — |
| `not_found` | 404 | Unknown route, or an unknown or invisible resource | — |
| `defined_in_config` | 409 | A settings update names a key that `config.yaml` sets; nothing was changed | `{ key }` |
| `setup_complete` | 410 | First-run setup after the Admin exists | — |
| `body_too_large` | 413 | The request body is larger than the route accepts | `{ maxBytes }` |
| `rate_limited` | 429 | Too many requests; the `Retry-After` header says when to retry | `{ retryAfterSeconds }` |
| `internal` | 500 | An unexpected error; the server log has the details | — |
| `setup_password_missing` | 503 | First-run setup, but `AGT_TRIVIA_SETUP_PASSWORD` is not set | — |

Field codes: `required`, `too_long` (`{ max }`), `too_short` (`{ min }`), `out_of_range` (`{ min?, max? }`),
`too_many` (`{ max }`), `invalid_format`, `invalid_url`, `not_allowed`, `duplicate`, `mismatch` (`{ other }`) and
`same_as_setup_password`.
