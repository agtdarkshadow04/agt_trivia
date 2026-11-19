# AGT Galactic Trivia API

The server's REST API lives under `/api/`. The complete, generated description is the OpenAPI 3.1 document at
`GET /api/openapi.json` (API-11); this guide explains the conventions it follows. The API grows with the rebuild
(#6): sign-in, the Admin routes, categories, questions and score history arrive in their sub-issues.

## Requests and responses

- JSON in and out (`application/json`), camelCase property names (API-4). Request bodies are at most 2 MiB.
- Requests are checked against the route's schema: a missing or wrong-typed property, or one the route does not
  declare, is rejected (API-10). Nothing is silently dropped or converted.
- IDs are lowercase UUIDv4 strings (API-5); a malformed ID answers `404`.
- Times are ISO 8601 UTC strings ending in `Z` (API-7).
- No CORS headers are ever sent (API-9): the API serves only the app's own pages.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }` when the server and its database answer (SRV-11) |
| `GET /api/settings/public` | The settings the player UI needs: `siteTitle`, `supportUrl`, `quizShortLength`, `quizLongLength` (CFG-10) |
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
| `not_found` | 404 | Unknown route, or an unknown or invisible resource | — |
| `body_too_large` | 413 | The request body is larger than the route accepts | `{ maxBytes }` |
| `rate_limited` | 429 | Too many requests; the `Retry-After` header says when to retry | `{ retryAfterSeconds }` |
| `internal` | 500 | An unexpected error; the server log has the details | — |

Field codes: `required`, `too_long` (`{ max }`), `too_short` (`{ min }`), `out_of_range` (`{ min?, max? }`),
`too_many` (`{ max }`), `invalid_format`, `invalid_url`, `not_allowed`, `duplicate`, `mismatch` (`{ other }`) and
`same_as_setup_password`.
