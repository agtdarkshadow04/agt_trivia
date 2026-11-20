# Agent guide — AGT Galactic Trivia

AGT Galactic Trivia is the trivia game of the Alliance of Galactic Travellers, being rebuilt (#6) from a static
Amplify app on a published Google Sheet into a self-hosted web application: a React 19 + Vite player UI
(`index.html` → `src/`) and an admin dashboard (`admin.html` → `src/admin/`), both served, with the REST API under
`/api/`, by a **Fastify 5** server (`server/`, Node.js 26, TypeScript). When the rebuild is done, anonymous visitors
play quizzes by category; **members** (local accounts, and AGT accounts through AGT IAM; roles Player, Editor and
Moderator) keep a score history, write questions and review them; and the single installation **Admin** manages
members, settings, logs, the Google Sheet import and backups. No cloud services: no code, package or name may depend
on AWS or Amplify.

**Database: SQLite** (DATA-2, via `better-sqlite3`): a few question writers and members' score saves
are far from sustained concurrent writes, one process serves the app, and nothing needs PostgreSQL features. The
server opens `storage.dataDir/storage.databaseFile` (default `data/agt-trivia.sqlite`) and applies the migrations
itself at startup.
Deployment: Docker Compose (service `trivia`, port 8082 on loopback, volume `trivia-data`) or a systemd service on
Ubuntu/Debian (`deploy/agt-trivia.service`), with `deploy/Caddyfile.example` for TLS (README, Installation).

This app follows the **[AGT Web Application Specification](docs/agt-webapp-spec.md) v6.0.1**
(`agtdarkshadow04/agt_webapp_specification@v6.0.1`). Read it before changing architecture, API, security, UI or
deployment. `docs/agt-webapp-spec.md` is a pinned copy of that tag: never edit it (SPEC-2;
`server/test/spec.test.ts` checks its SHA-256). Propose rule changes as a PR to the spec repository (SPEC-4); move to
a newer spec version in a PR of its own (SPEC-3). The rebuild is not finished: every rule the app does not meet yet
is listed under [Deviations](#deviations-from-the-agt-web-app-spec) with the sub-issue of #6 that removes it. When
the spec is silent, follow its reference implementation `agtdarkshadow04/agt_event_calendar` at the spec's
Reference version (also SQLite); member accounts and AGT sign-in follow `agtdarkshadow04/agt_knowledge_base`.

## Branches

- `main` is the default branch. Work on a feature branch and open a PR into `main`.
- `amplify` is frozen (#7): AWS Amplify builds the live static 1.x app from it until the maintainer moves the site
  to the new app. Never push to, merge into, rebase or delete `amplify` (WF-1).

## Commands

Requires Node.js 26 and npm 11.20 or newer within npm 11 (`engines`, `engine-strict=true` in `.npmrc`). Install with
`npm ci`.

```bash
npm run check       # lint + test + build — run this before every commit
npm run lint        # tsc -b over the app, node and server projects (strict, no unused symbols; no ESLint)
npm test            # test:client (src/lib/*.test.ts) + test:server (server/test/*.test.ts)
npm run test:e2e    # build, then the Playwright browser tests in tests/e2e/ against the real server (not part of check; needs Chromium)
npm run build       # Vite build → dist/, server bundle → dist-server/index.mjs
npm run dev:server  # build and run the server on 127.0.0.1:8082 (reads ./config.yaml if present; data in ./data/)
npm run dev         # Vite dev server on :5173, proxies /api/ to :8082
```

Run a single test file:

```bash
npx esbuild server/test/app.test.ts --bundle --platform=node --target=node26 --format=esm --packages=external --loader:.sql=text --outdir=.test-build/server --out-extension:.js=.mjs && node --test .test-build/server/app.test.mjs
npx playwright test tests/e2e/shell.spec.ts -g "name"   # one browser test file, or one test (after npm run build)
```

`npm run test:e2e` starts `node dist-server/index.mjs` itself, on a fresh data directory and test `config.yaml`
(`tests/e2e/environment.ts`); it needs Chromium
(`npx playwright install --with-deps chromium`, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing at an installed one).
CI (`.github/workflows/ci.yml`) runs `npm ci`, the install-script check (STACK-7) and `npm run check`, then
`npm run test:e2e`, and builds the image and starts the Compose stack until it is healthy (TEST-8), on pull requests
and pushes to `main`. A change to the image, the Compose file or `deploy/` follows the spec's §18 templates; check
it with the TEST-8 smoke tests the README's Installation steps describe.

## Where things live

| Path | Purpose |
| --- | --- |
| `docs/agt-webapp-spec.md` | Pinned copy of the AGT Web Application Specification v6.0.1 (tag `v6.0.1`). Never edit; `.gitattributes` keeps it byte-identical |
| `CHANGELOG.md` | Release notes (Keep a Changelog 1.1.0), newest first (VER-9) |
| `docs/API.md` | API guide: conventions, routes, error codes (every code in `errorCodes` must be listed) |
| `config.example.yaml` | Every `config.yaml` key, commented out, with its default (CFG-4; `server/test/config.test.ts` checks it) |
| `server/index.ts` | Entry point and the only server file that reads `process.env` or calls `listen()` (SRV-1): loads the startup settings, opens and migrates the database, logs the startup entry, refuses to start with one line (SRV-8), shuts down on SIGTERM/SIGINT (SRV-7) |
| `server/startup.ts` | `loadStartup(env)`: the CFG-2 `AGT_TRIVIA_*` variables (the setup password included), where `config.yaml` and the database file are |
| `server/config.ts` | `config.yaml`: its TypeBox schema with the CFG-5 keys (unknown keys are errors), `parseConfig()`/`loadConfigFile()`, and `EDITABLE_SETTINGS` (CFG-6) |
| `server/context.ts` | `AppContext` (SRV-3: the config, the database, the data directory, the log store, the operation lock) and the settings precedence: `setting()`, `settingStates()`, `settingValues()`, `lockedSettingKeys()` (CFG-7) |
| `server/app.ts` | `buildApp(context, options)`: the Fastify app without `listen()` (SRV-2), the SEC-1..SEC-3 headers hook, the one authentication hook (CSRF header and Admin session, AUTH-9, SEC-5, and the SEC-4 plain-HTTP warning), `@fastify/rate-limit` with the `rateLimits.*` buckets (SEC-7), the single error handler, the registration of every route table entry, and the static files of `dist/` (SRV-9) |
| `server/session.ts` | `AdminAuthService`: first-run setup (AUTH-5, AUTH-6), sign-in (AUTH-3), sessions (AUTH-8), the password change (AUTH-4); `setupPasswordCheck()` for startup; the cookie helpers for both cookies |
| `server/iam.ts` | AGT sign-in (#18): `IamClient`, the only code that makes an outbound request (`POST <iam.baseUrl>/api/v1/auth/verify`, the SEC-14 deviation), its answer mapping, and `iamStatus()` (`iam.enabled` and what is missing) |
| `server/members.ts`, `server/memberRoutes.ts` | Member accounts (#17, AUTH-1 deviation): `MemberAuthService` (sign-in, sessions, the password change, and AGT sign-in: `verifyIam()` in the route's `prepare` step before the data write, `completeIamLogin()` inside it) and `AdminMemberService` (the Members tab: list, create, replace, set password, delete, each ending sessions per AUTH-4); the member and `/api/admin/members` routes |
| `server/passwords.ts` | scrypt hashing with `SCRYPT_PROFILES`, the stored-hash format check before scrypt (AUTH-2), `secretsEqual()` and the dummy hash (AUTH-3) |
| `server/settings.ts` | The Settings tab's reads and `updateSettings()` (CFG-8: unknown, locked and invalid keys, the quiz-length rule) |
| `server/headers.ts` | The exact CSP and the other SEC-1..SEC-3 header values |
| `server/http.ts` | `HttpError(statusCode, error, message, { fields, params })` and `errorReply()`, the one mapping from errors to the API-6 body |
| `server/routes.ts` | The route table: every `/api/` route with `auth`, `writesData` (BAK-8), `operationId`, tag, summary, schemas and handler |
| `server/schemas.ts` | TypeBox request and response schemas, `ErrorBody`/`FieldError`, and `errorCodes` (every code the server sends) |
| `server/openapi.ts` | `@fastify/swagger` registration and the `SECURITY` values each route declares (API-11) |
| `server/db.ts` | `openDatabase()`/`openSqlite()` (DATA-5 pragmas), `MIGRATIONS`, `SCHEMA_VERSION`, `EXPECTED_TABLES`, `runMigrations()` (refuses a newer schema), and `Database`, the swappable handle the context holds |
| `server/dataWrite.ts` | `withDataWrite(lock, work)` (every `writesData` route runs in it), `asOperation()` (the restore's own writes) and `assertDataWrite()` (every repository write calls it, BAK-8) |
| `server/operation.ts` | `OperationLock`, the one-process operation lock (BAK-8): `idle`/`backup`/`restore`/`restore_failed`, `enterWrite()`, `enterActivity()`, `begin()` with the 30-second drain, and the BAK-11 recovery session |
| `server/backup.ts`, `server/backupRoutes.ts`, `server/backupCodes.ts`, `server/zip.ts` | Backup and restore (§12): `BackupService` (the online-backup snapshot, the BAK-2 archive, the BAK-3 checks of an upload, the BAK-4 restore with its pre-restore backup, swap, rollback (BAK-10) and `restore_failed` with the `restore-failed.json` marker (BAK-11), and `BackupHooks` for failure tests); the two routes and the multipart upload; the archive rejection reasons and restore warnings; `zip.ts` is the only ZIP reader and writer (SEC-10) |
| `server/logs.ts`, `server/audit.ts`, `server/logRoutes.ts` | The log store (§13): `openLogStore()`, `LogStore` (server log and audit log writes that never throw, LOG-3; LOG-11 coalescing; the LOG-12 IP hash; retention), `createLogger()` (pino multistream to stdout and the server log, LOG-5), `startRetention()` (LOG-15), streamed exports with formula neutralization (LOG-22), `seq` cursors (API-8); `audit.ts` is the one `onResponse` hook that writes every audit entry (LOG-11); `logRoutes.ts` the LOG-18 admin routes |
| `server/repository/*.ts` | All SQL (SRV-4), parameterized: `settings.ts`, `admin.ts` (the Admin row and its sessions), `categories.ts` (categories, sorted as 1.x did, with their approved-question counts, counts per status and name conflicts; versioned update and delete), `questions.ts` (questions with their choices; the member lists, counts, versioned replace, status changes and delete), `members.ts` (members and their sessions), `results.ts` (quiz results and their graded answers, stats), `logs.ts` (the log store) |
| `server/questions.ts`, `server/questionRoutes.ts` | Question authoring and review (#19): `QuestionService` (list, counts, read, create, replace, delete, submit, approve, reject, unpublish; every change at a `version`, `409 conflict` otherwise; the credit rule; the long-prompt and duplicate-prompt notices) and the `/api/member/questions` routes with their audit summaries (question ID, status, changed field names) |
| `server/categories.ts`, `server/categoryRoutes.ts` | Category management (#20): `CategoryService` (Moderators only: list with counts per status, create, replace at a `version`, delete only when empty, `409 category_not_empty`) and the `/api/member/categories` routes |
| `server/results.ts`, `server/resultRoutes.ts` | Member score history (#21): `ResultService` (grading a finished quiz against the approved questions as they are now, leaving out and reporting unapproved ones; the member's own paged results, per-category stats, and clearing) and the `/api/member/results` and `/api/member/stats` routes |
| `server/sheetImport.ts`, `server/importRoutes.ts` | The Admin's sheet import (#22, the SEC-9 deviation): `readImportUpload()` (the route's `prepare` step: the multipart files in memory, their limits and text checks), `SheetImportService` (the plan: categories matched by name, questions skipped when their category has the same text; the preview, and the import in one transaction) and `POST /api/admin/import` |
| `server/quizRoutes.ts` | The public quiz reads (#15): `GET /api/categories` and `GET /api/categories/{id}/quiz`, mapping rows to the public schemas (API-3) |
| `server/migrations/NNNN_<name>.sql`, `server/migrations/logs/NNNN_<name>.sql` | Every schema change, imported as text into `MIGRATIONS` (DATA-3); the log store's into `LOG_MIGRATIONS` (LOG-1), which backups and restores never touch |
| `server/test/` | `node:test` server tests; `helpers.ts` has `testContext()` (a migrated in-memory database, or a file with `file: true`, in its own data directory, with short operation-lock timings when asked), `seedQuiz()` (a category with approved and hidden questions), `createMember()` and `memberCookie()`, and `totalChanges()`. `members.test.ts` (the members table, member sign-in, session separation, CSRF, the member rate limit, the password change, the Members tab with every AUTH-4 sign-out, deletion keeping questions, backups without member sessions, the log store migration), `iam.test.ts` (the IAM client against a fake AGT IAM on a loopback port: the role map with the Player default, refused tiers, every failure mapping without retries, the timeout, URL rules; and AGT sign-in through the app: the first sign-in, role changes, the Admin's limits, `iam.enabled` off, IAM outside the data write), `logs.test.ts` (every write audited with its outcome, coalescing, no addresses or secrets in the logs, the 500 entry and its request ID, paging, summary, clear, exports, retention), `auth.test.ts` (setup, hashing, sign-in, sessions, the password change, CSRF and 401 on every admin route, cookies behind a proxy, rate limits, the settings update), `app.test.ts` (headers, static files, versioning), `config.test.ts` (CFG-2..CFG-5), `settings.test.ts` (CFG-7, CFG-10), `questions.test.ts` (#19: every role × action × status, CSRF, the credit rule, validation and notices, review notes, the public quiz after approval and unpublishing, 409 on old versions, paging, counts, audit entries without text), `categories.test.ts` (#20: Moderators only, validation and duplicates, counts per status, 409 on old versions, the refused delete, audit entries), `import.test.ts` (#22: the SEC-9 limits, preview, import, a second import adding nothing, pending questions, bad rows refusing the import, audit counts), `results.test.ts` (#21: grading single- and multi-answer questions, other categories, duplicates, foreign choices, changed questions; only one's own results; stats, a deleted category, clearing, member deletion; 401 for visitors and the Admin; audit entries without answers), `quiz.test.ts` (the quiz tables' constraints, the repository, the public reads: only approved questions and only public fields), `backup.test.ts` (TEST-4: the archive, round trips, every rejection reason, locked settings and config.yaml, the operation lock and its drain, maintenance, rollbacks, `restore_failed` and the recovery restore), `db.test.ts` (migrations), `routes.test.ts` (route table, BAK-8 declarations, error bodies), `openapi.test.ts` (API-13), `assets.test.ts` (UI-15, UI-16), `spec.test.ts` (SPEC-2) |
| `src/` | Player UI: `main.tsx`, `App.tsx` (loads the public settings and categories, keeps `?category=` in step with the view (FE-4), and plays the quiz), `translations.ts` (`LOCALES`, `COMMON_TRANSLATIONS` and the string tables for all 10 locales, I18N-1..I18N-3), `agt-base.css` (the AGT base stylesheet, copied unmodified, UI-16), `styles.css` (imports it first); `components/`: `I18n.tsx` (`I18nProvider`/`useI18n`: language, strings, `changePreference()`; sets `<html lang>` and `data-font-scale`), `Dialog.tsx` and `useDialog.ts` (every dialog, A11Y-2), `Field.tsx` (labelled fields with errors, A11Y-5, and `formErrors()`), `DisplaySettings.tsx` (language, time zone unless `timeZone={false}`, and text size), `Icons.tsx` (FE-7), `MaintenanceNotice.tsx` (FE-5), `BrandLockup.tsx` (the admin header's), `Layout.tsx` (the UI-7 chrome: header with the Settings button and dialog, footer with the support link), `CategoryList.tsx`, `QuizPlay.tsx` (length choice, question with its feedback, results with the score ring), `useViewHeading.ts` (focus moves to each new view's heading), `MemberAccount.tsx` (the `?page=login` sign-in and the account menu), `QuestionWorkshop.tsx` (#19: `?page=questions` with the question form, preview and guidelines, and the Moderators' `?page=review` queue), `CategoryManager.tsx` (#20: the Moderators' `?page=categories` with its create, edit and delete dialogs), `ScoreHistory.tsx` (#21: `SaveResult` on the results screen and the member's `?page=scores`) |
| `src/lib/` | Framework-free code shared with the server where it needs it (REPO-3, FE-8), with `node:test` tests in `*.test.ts`: `api.ts` (API types, `isUuidV4()`), `errors.ts` (`FieldError`, field codes), `validation.ts` (the shared semantic validators, categories and questions included, with the prompt-length notice; change rules here only), `client.ts` (`apiRequest()`/`ApiError`, the only way the browser calls the API, FE-2), `preferences.ts` (the one `agt_trivia_settings` `localStorage` object: language, time zone, font scale; FE-3, I18N-4), `format.ts` (`Intl` dates and numbers in the reader's language and time zone, I18N-5), `translationChecks.ts` (the completeness checks the translation tests share), `quiz.ts` (sorting, shuffling, answer checking, ranks; ported from 1.x), `quizSession.ts` (one quiz being played: choosing, locking, grading, results, and the answers a member's result sends), `routes.ts` (the `?category=` deep link and the `?page=` pages, FE-4), `playerApi.ts` (the player UI's API calls), `questionRules.ts` (who may do what with a question, #19: the server enforces it, the UI shows only allowed actions), `questionForm.ts` (the question form's state, body and checks), `csv.ts` (the RFC 4180 parser, #22), `sheetImport.ts` (reading the sheet's CSV downloads into categories and questions, with every bad row's file, row and column) |
| `src/admin/` | Admin dashboard: `main.tsx`, `AdminApp.tsx` (UI-8 shell: setup, sign-in, header, the tablist, the preferences dialog), `MembersPanel.tsx` (#17), `SettingsPanel.tsx`, `ImportPanel.tsx` (#22: the sheet import's preview, problems and import), `LogPanel.tsx` (the Server log and Audit log tabs), `BackupPanel.tsx` (BAK-1), `AccountPanel.tsx`, `api.ts` (its API calls and types), `download.ts`, `i18n.ts` (the admin string tables for all 10 locales), `context.ts` (`useAdminI18n()`), `admin.css` (imported after `src/styles.css`). The public bundle must never import from `src/admin/` |
| `public/` | The AGT logo, NMS Futura, the flag font and the font licences, copied unmodified from the spec's v6.0.1 `assets/` and checked by SHA-256 in `server/test/assets.test.ts` (UI-15); the server serves them at their own paths |
| `tests/fixtures/sheet/` | `validCategories.csv` and `pendingQuestions.csv`, cut from the 1.x sheet's own CSV downloads (#22), for the parser, import and browser tests |
| `tests/e2e/`, `playwright.config.ts` | Playwright browser tests (TEST-6) against `node dist-server/index.mjs`: `environment.ts` (the run's data directory and `config.yaml`), `fixtures.ts` (console/CSP watch, axe, dialog and layout checks), `setup.spec.ts` (the setup project: first-run setup through the UI, saving the signed-in Admin in `tests/e2e/.auth/`, and `seedQuizData()` from `environment.ts`, which writes the quiz straight into the server's database: a dozen questions per category are quicker to seed than to author, and the import (#22) needs the Admin and creates other categories), `player.spec.ts` (playing, deep links, keyboard-only play, settings, every view at every width), `members.spec.ts` (the Members tab, signing in as each role, the account menu), `authoring.spec.ts` (#19: write, submit, reject, fix, approve, play, delete; Players kept out; every width), `import.spec.ts` (#22: preview, import, the questions in the game, a second preview, bad rows; it deletes what it imported), `scores.spec.ts` (#21: play → history → clear, the retry after a failed save, the sign-in invitation, every width), `categories.spec.ts` (#20: create, edit with the link warning, the refused delete of a non-empty category, delete; only Moderators; every width), `iam.spec.ts` with `fake-iam.ts` (a fake AGT IAM that `playwright.config.ts` starts on port 4182: AGT sign-in end to end), `admin.spec.ts`, `backup.spec.ts` (a real restore, which re-saves the signed-in state), `shell.spec.ts` |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` | The DEP-1 image (`node:26-bookworm-slim`, healthcheck, non-root `node`), the DEP-2 Compose stack (service `trivia`, `127.0.0.1:8082`, volume `trivia-data`, read-only, SEC-15), and the secrets template (DEP-4) |
| `deploy/` | `agt-trivia.service` (the DEP-7 systemd unit) and `Caddyfile.example` (DEP-10) |
| `.github/workflows/ci.yml` | CI |

## Conventions and gotchas

- **Versioning (§21):** `1.0.0` (tag) is the static Amplify app. The rebuild is `2.0.0`: every rebuild PR keeps
  `package.json` at `2.0.0` and adds its entries under `## [2.0.0] - Unreleased` in `CHANGELOG.md` (VER-8, VER-9). Set
  versions with `npm version X.Y.Z --no-git-tag-version`. Docs-only, test-only, CI and `AGENTS.md` changes need no
  bump (VER-6). New tags use the `v` prefix (`v2.0.0`, VER-11); create tags and GitHub Releases only when the
  maintainer asks (VER-12).
- **Spec work:** cite rule IDs in commits and PRs (WF-2). When a PR makes a deviation below go away, narrow or delete
  its row in the same PR; when it adds one, add a row. One concern per PR (WF-3); each sub-issue of #6 is one or more
  PRs of its own.
- TypeScript `strict` with `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`; lint fails on
  unused symbols. ES modules. No Prettier: match the surrounding style (2-space indent, single quotes, semicolons,
  trailing commas). Server files import relative files with a `.js` extension (`import { buildApp } from './app.js';`);
  frontend imports under `src/` are extensionless, and files in `src/lib/` that the server imports use `.js` too.
- **Server structure (SRV-1..SRV-3):** only `server/index.ts` reads `process.env`. A new environment variable must be
  in the CFG-2 set (`AGT_TRIVIA_*`) or an `AGT_TRIVIA_<NAME>` secret. Everything else gets what it needs from the
  `AppContext` passed to `buildApp()`; never add a module-level database, config cache or `process.env` read.
- Request input is checked twice: the route's TypeBox schema (types, required properties, no undeclared properties,
  in the body and the query string alike; `removeAdditional` and `coerceTypes` are off, so nothing is silently
  dropped or converted), then the semantic validators in `src/lib/validation.ts` (shared with the browser; never
  duplicate a rule). Signal failures by throwing `HttpError` (`server/http.ts`) with a snake_case `error` code that is
  listed in `errorCodes` and `docs/API.md`, and `fields` for field errors. Handlers never build error responses
  themselves; `errorReply()` is the only place that maps errors to bodies.
- **Response schemas list every field** a route returns: Fastify's serializer drops undeclared ones, which is also
  how public responses stay public (API-3).
- **SQL** lives in `server/repository/*.ts` only (SRV-4; the migration runner in `db.ts` has its own), always
  parameterized; map user-supplied sort fields through an allowlist. New rows get `crypto.randomUUID()` IDs from the
  server (DATA-6); validate incoming IDs with `isUuidV4()` from `src/lib/api.ts`. Times are stored as ISO 8601 UTC
  text ending in `Z` (DATA-7). Wrap multi-statement writes in `db.transaction()`.
- **Data writes (BAK-8):** every route declares `writesData` in `server/routes.ts` (true when it can change the main
  database; session rows alone do not count), and `app.ts` runs those handlers in `withDataWrite()`, which waits
  while a backup takes its snapshot and refuses during a restore (`503 maintenance`). Every `/api/` request except
  the health check counts as activity that a restore drains; a background job enters `enterActivity()` too. Every repository
  function that writes the main database calls `assertDataWrite()` first, so a write anywhere else throws;
  `server/test/routes.test.ts` checks the declarations and that GET routes write nothing.
- **Adding an API route:** add an entry to `apiRoutes` in `server/routes.ts` with `auth`, `writesData`, a unique
  camelCase `operationId`, a tag, a one-sentence summary and TypeBox schemas (`server/schemas.ts`) for its params,
  query string, body and every success response; `buildApp()` registers it with its `security` (API-11) and the
  `default` error response. `server/test/openapi.test.ts` (API-13) fails if a route is missing or incomplete, its
  security is wrong, or an error code is missing from `errorCodes` or `docs/API.md`. Client calls go through
  `apiRequest()` in `src/lib/client.ts`.
- **Adding a database migration:** add `server/migrations/NNNN_<snake_case>.sql` (the next number; no
  `BEGIN`/`COMMIT`, the runner wraps each migration in a transaction and sets `PRAGMA user_version`), import it and
  append it to `MIGRATIONS` in `server/db.ts`, and add new tables to `EXPECTED_TABLES`; `server/test/db.test.ts` fails if
  the list and the files disagree. Never edit or reorder a shipped migration. Use `STRICT` tables, `TEXT` IDs and
  timestamps; every new table gets `created_at` and `updated_at` unless it is a pure join or log table (DATA-8).
- **Configuration:** non-secret settings live in `config.yaml` (document every key, commented out, in
  `config.example.yaml`; `server/test/config.test.ts` checks it); secrets stay in environment variables. A
  dashboard-editable setting is an `EDITABLE_SETTINGS` entry (schema, default, description) plus its `config.yaml`
  key; it resolves config file → `settings` table → default only in `settingStates()` (CFG-7), and a key the file
  defines must never be changeable through any API, migration or restore. A rule between two settings goes in
  `src/lib/validation.ts` (like `quizLengthsError()`).
- **Logging (§13):** log through the pino logger (`app.log`, `request.log`, or the logger `server/index.ts` builds)
  with a `source` (`startup`, `shutdown`, `config`, `migrations`, `retention`, `http`, `auth`, `security`, later
  `backup` and `import`); never `console.*` in the server. Never log passwords, tokens, cookies, keys, request bodies
  or raw IPs (SRV-6, LOG-9). Never audit by hand: the `onResponse` hook in `server/audit.ts` audits every non-GET
  route, GET routes with `audit: true` (downloads, exports), admin 401/403s and every 429. A handler adds the target
  and a summary by setting `request.audit`; summaries name things and list changed field names, never values or
  bodies, except settings changes (old and new value, LOG-14). Log tables are append-only: only retention and the
  Admin's Clear (server log only) delete entries, and no route may edit or delete audit entries (LOG-2, LOG-18). The
  log store is its own file: its writes are never data writes.
- **Security headers (SEC-1..SEC-3):** the first `onRequest` hook in `server/app.ts` sets the exact CSP and the other
  headers on every response. Never widen the CSP, never add CORS (SEC-6), never use `dangerouslySetInnerHTML` (SEC-11),
  and never load anything from a CDN (SEC-14).
- **Frontend (§14–§16):** no router and no global state library (STACK-2); no CSS framework or component library
  (STACK-3). CSS adds to `src/agt-base.css` and never edits it, redefines its tokens or restyles a UI-9 class
  (`server/test/assets.test.ts`); sizes text in `rem`. Admin-only rules go in `src/admin/admin.css`.
- **Authentication:** the single Admin and the members (#17, the AUTH-1 deviation). Handlers read `request.admin` or
  `request.member` and never inspect cookies; the authentication hook in `server/app.ts` checks the
  `agt_trivia_session` cookie on `auth: 'admin'` routes, the `agt_trivia_member_session` cookie on `auth: 'member'`
  routes (each mode reads only its own cookie: never let one grant the other), and the `x-agt-request: 1` header on
  every non-GET `csrf`, `admin` and `member` route. No bearer token is accepted. No outbound requests from the
  server, except `IamClient` in `server/iam.ts` to `iam.baseUrl` while AGT sign-in is on (the SEC-14 deviation);
  never log, store or return the AGT password, AGT IAM's token or `AGT_TRIVIA_IAM_API_KEY`; tests use a fake IAM on
  a loopback port. Roles authorize with `roleAtLeast()`
  (`src/lib/api.ts`) on the server, `403 forbidden` otherwise; UI hiding is never access control. Anything that ends
  a member's access (password reset, deactivation, role change, deletion) deletes their `member_sessions` rows
  (AUTH-4); role handling needs regression tests.
  Store passwords only through `server/passwords.ts`; a new scrypt profile needs the rehash-on-sign-in code with it
  (AUTH-2). Credential-checking routes get a `rateLimit` bucket. Never log, store or return the setup password.
- **Translations (§17):** every string the UI shows comes from `src/translations.ts` (`useI18n().t`) or
  `src/admin/i18n.ts` (`useAdminI18n().a`), never from a literal in a component; `src/lib/translations.test.ts` scans
  the components for hard-coded text. A new string goes into the English table and all nine other locales in the
  same PR, with the same `{{placeholders}}`; the completeness tests fail on a missing key, a changed placeholder or an
  untranslated English sentence. Strings the AGT Knowledge Base already has should reuse its translations. A new
  error code needs a string in `errors` of every locale, and a new field name a label in `fields`. Show errors with
  `useI18n().error()` or `formErrors()`, never with the API's English `message`. Question and category text stays
  English.
- **Frontend:** call the API only through `apiRequest()`; every dialog through `Dialog`/`ConfirmDialog` (`useDialog`),
  never `window.confirm`; form fields through `components/Field.tsx`, checked first with the validators the server
  uses (FE-6); status changes in a `role="status"` live region; `localStorage` only through `src/lib/preferences.ts`.
- **Tests:** server tests live in `server/test/*.test.ts` and `src/lib` tests next to their file; both use
  `node:test` and `node:assert/strict`, are bundled by esbuild into `.test-build/`, and read repository files by paths
  relative to the repository root (never `import.meta.url`). Use `buildApp()` with `inject()` for HTTP. UI behaviour
  is tested in the browser (`tests/e2e/`, one worker); UI logic that needs no DOM goes in `src/lib/` with a
  `node:test` test. A UI change runs `npm run test:e2e`. Never skip or weaken a test to make a change pass (TEST-5).
- Keep changes minimal; a new runtime dependency needs a reason in the PR (STACK-1). Every dependency with an install
  script needs an `allowScripts` decision (`npm install-scripts approve|deny <pkg>`, STACK-7); `esbuild` and
  `better-sqlite3` are approved.
- Update `README.md` when a change affects setup, configuration, roles or user-visible behaviour.
- Commit subjects are short and imperative, with `Refs #<issue>` in the body when working from an issue.

## Deviations from the AGT web app spec

Rule IDs refer to the pinned v6.0.1 copy. The rebuild adds the spec's features one sub-issue of #6 at a time; each
row below names the sub-issue that removes it. Narrow the row as items land, and delete it in the PR that removes the
last one. Every row is now permanent: AUTH-1 (member accounts, #17), Principle 1/SEC-14 (AGT sign-in, #18) and SEC-9
(the CSV files of the Admin's sheet import, #22).

| Rule | What differs | Why |
| --- | --- | --- |
| Principle 1, SEC-14 | While AGT sign-in is on (`iam.enabled`, off by default) and `iam.baseUrl`, `iam.appId` and `AGT_TRIVIA_IAM_API_KEY` are set, the server sends one `POST` to `<iam.baseUrl>/api/v1/auth/verify` per AGT sign-in, from `IamClient` in `server/iam.ts` only: `https://` only (`http://` only to a loopback host), no redirects, a timeout (`iam.timeoutSeconds`), a 64 KiB answer limit, no retries, and outside the data write (the route's `prepare` step, BAK-8). The traveller's password goes only there and is never stored or logged, nor AGT IAM's token; the API key is an app secret in `.env` (CFG-2, SEC-8). A default install still makes no outbound request | Members sign in with their AGT account (#18); AGT IAM is the AGT community's own identity service. Permanent, agreed with the maintainer in #6, as in the AGT Knowledge Base |
| AUTH-1 | Besides the single Admin there are **member accounts** (`members`, roles `Player`, `Editor` and `Moderator`, #17). All of it reuses the spec's own mechanisms: members sign in with AUTH-8 cookie sessions (cookie `agt_trivia_member_session`, same attributes as the Admin cookie; table `member_sessions`, SHA-256 token hashes; routes `/api/member/login`, `/api/member/logout`, `/api/member/session`, `/api/member/password`), accepted only on member routes by the one authentication hook and never in place of the Admin cookie or the reverse; `x-agt-request: 1` on every member write (SEC-5); `rateLimits.login` with each route's own counter (SEC-7); AUTH-2/AUTH-3 password rules; a password change ends the member's other sessions, and a role change, deactivation, password reset or deletion by the Admin ends all of them (AUTH-4); member sessions are never backed up and are emptied by a restore (BAK-2, BAK-4); OpenAPI adds the `memberSessionCookie` scheme (member reads `[{ memberSessionCookie: [] }]`, writes `[{ memberSessionCookie: [], csrfHeader: [] }]`, sign-in `[{ csrfHeader: [] }]`), checked by the API-13 test (API-11); the audit log records `actor_type: member` with the username, and member 401/403 responses like admin ones (LOG-10, LOG-11). No self-registration: the Admin creates members (Members tab), or a first AGT sign-in does. **AGT members** (#18): `members` rows with `auth_source = 'agt_iam'`, no username or password hash, keyed by `iam_traveller_id`; they sign in at `POST /api/member/iam/login` (its own counter on `rateLimits.login`), get the same member cookie, and their role comes from `iam.roleMap` (default Player) at every sign-in; the Admin can only activate, deactivate or delete them (`409 managed_by_iam` otherwise); switching `iam.enabled` off deletes their sessions, and their sessions are refused while AGT sign-in is unavailable | Members playing with a score history, writing and reviewing questions are what the rebuild is for (#6). Nothing else is loosened. Implemented in `server/members.ts`, `server/memberRoutes.ts` and the authentication hook in `server/app.ts` |
| SEC-9 | The Admin's sheet import (`POST /api/admin/import`, #22) accepts two CSV files besides images: the 1.x Google Sheet's `validCategories` and `pendingQuestions` downloads. Only the Admin (`auth: 'admin'`, CSRF header, `rateLimits.adminUploads`); at most 1 MiB each; media type `text/csv`, `text/plain` or `application/vnd.ms-excel` (what browsers send for `.csv` on Windows with Excel); checked as text (no NUL bytes, valid UTF-8, a BOM ignored), parsed in memory by `src/lib/csv.ts` and discarded: never written to disk, stored or served. `server/test/import.test.ts` covers each limit (401 for visitors and members, 413 over 1 MiB, binary and non-UTF-8 content, other media types, nothing left on disk) | The rebuild has to bring in the existing sheet's questions (#6, #22), and the server must not fetch the sheet itself (SEC-14). Permanent, agreed with the maintainer in #22 |
