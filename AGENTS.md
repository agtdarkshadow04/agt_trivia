# Agent guide — AGT Galactic Trivia

AGT Galactic Trivia is the trivia game of the Alliance of Galactic Travellers, being rebuilt (#6) from a static
Amplify app on a published Google Sheet into a self-hosted web application: a React 19 + Vite player UI
(`index.html` → `src/`) and an admin dashboard (`admin.html` → `src/admin/`), both served, with the REST API under
`/api/`, by a **Fastify 5** server (`server/`, Node.js 26, TypeScript). When the rebuild is done, anonymous visitors
play quizzes by category; **members** (local accounts or AGT accounts through AGT IAM, roles Player, Editor and
Moderator) keep a score history, write questions and review them; and the single installation **Admin** manages
members, settings, logs, the Google Sheet import and backups. No cloud services: no code, package or name may depend
on AWS or Amplify.

**Database: SQLite** (DATA-2, via `better-sqlite3`, added in #10): a few question writers and members' score saves
are far from sustained concurrent writes, one process serves the app, and nothing needs PostgreSQL features.
Deployment: Docker Compose (service `trivia`, port 8082 on loopback, volume `trivia-data`) or a systemd service on
Ubuntu/Debian (`deploy/agt-trivia.service`), both added in #14.

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
npm run dev:server  # build and run the server on 127.0.0.1:8082
npm run dev         # Vite dev server on :5173, proxies /api/ to :8082
```

Run a single test file:

```bash
npx esbuild server/test/app.test.ts --bundle --platform=node --target=node26 --format=esm --packages=external --loader:.sql=text --outdir=.test-build/server --out-extension:.js=.mjs && node --test .test-build/server/app.test.mjs
npx playwright test tests/e2e/shell.spec.ts -g "name"   # one browser test file, or one test (after npm run build)
```

`npm run test:e2e` starts `node dist-server/index.mjs` itself (`playwright.config.ts`); it needs Chromium
(`npx playwright install --with-deps chromium`, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing at an installed one).
CI (`.github/workflows/ci.yml`) runs `npm ci`, the install-script check (STACK-7) and `npm run check`, then
`npm run test:e2e`, on pull requests and pushes to `main`.

## Where things live

| Path | Purpose |
| --- | --- |
| `docs/agt-webapp-spec.md` | Pinned copy of the AGT Web Application Specification v6.0.1 (tag `v6.0.1`). Never edit; `.gitattributes` keeps it byte-identical |
| `CHANGELOG.md` | Release notes (Keep a Changelog 1.1.0), newest first (VER-9) |
| `server/index.ts` | Entry point and the only server file that reads `process.env` or calls `listen()` (SRV-1); shuts down on SIGTERM/SIGINT (SRV-7) |
| `server/app.ts` | `buildApp(context, options)`: the Fastify app without `listen()` (SRV-2), the SEC-1..SEC-3 headers hook, the error and 404 handlers, `/api/health`, and the static files of `dist/` (SRV-9) |
| `server/headers.ts` | The exact CSP and the other SEC-1..SEC-3 header values |
| `server/context.ts` | `AppContext` (SRV-3) |
| `server/test/` | `node:test` server tests: `app.test.ts` (headers, static files, 404s, versioning), `assets.test.ts` (UI-15, UI-16), `spec.test.ts` (SPEC-2) |
| `src/` | Player UI: `main.tsx`, `App.tsx` (the UI-7 chrome), `translations.ts` (`COMMON_TRANSLATIONS`; the locales arrive in #11/#16), `agt-base.css` (the AGT base stylesheet, copied unmodified, UI-16), `styles.css` (imports it first); `components/` |
| `src/lib/` | Framework-free code shared with the server where it needs it (REPO-3, FE-8), with `node:test` tests in `*.test.ts`: `quiz.ts` (sorting, shuffling, answer checking, ranks; ported from 1.x) |
| `src/admin/` | Admin dashboard: `main.tsx`, `AdminApp.tsx` (UI-8 shell), `admin.css` (imported after `src/styles.css`). The public bundle must never import from `src/admin/` |
| `public/` | The AGT logo, NMS Futura, the flag font and the font licences, copied unmodified from the spec's v6.0.1 `assets/` and checked by SHA-256 in `server/test/assets.test.ts` (UI-15); the server serves them at their own paths |
| `tests/e2e/`, `playwright.config.ts` | Playwright browser tests (TEST-6) against `node dist-server/index.mjs`: `fixtures.ts` (console/CSP watch, axe, layout checks), `shell.spec.ts` |
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
- **Logging:** log through the pino logger (`app.log`, `request.log`, or the logger `server/index.ts` builds) with a
  `source`; never `console.*` in the server. Never log passwords, tokens, cookies, keys, request bodies or raw IPs
  (SRV-6).
- **Security headers (SEC-1..SEC-3):** the first `onRequest` hook in `server/app.ts` sets the exact CSP and the other
  headers on every response. Never widen the CSP, never add CORS (SEC-6), never use `dangerouslySetInnerHTML` (SEC-11),
  and never load anything from a CDN (SEC-14).
- **Frontend (§14–§16):** no router and no global state library (STACK-2); no CSS framework or component library
  (STACK-3). CSS adds to `src/agt-base.css` and never edits it, redefines its tokens or restyles a UI-9 class
  (`server/test/assets.test.ts`); sizes text in `rem`. Admin-only rules go in `src/admin/admin.css`.
- **Translations (§17):** components show no hard-coded text (I18N-3). Until the string tables arrive (#11, #16) the
  pages show only the untranslated names in `COMMON_TRANSLATIONS`; add a string only together with its tables in all
  10 locales.
- **Tests:** server tests live in `server/test/*.test.ts` and `src/lib` tests next to their file; both use
  `node:test` and `node:assert/strict`, are bundled by esbuild into `.test-build/`, and read repository files by paths
  relative to the repository root (never `import.meta.url`). Use `buildApp()` with `inject()` for HTTP. UI behaviour
  is tested in the browser (`tests/e2e/`, one worker); UI logic that needs no DOM goes in `src/lib/` with a
  `node:test` test. A UI change runs `npm run test:e2e`. Never skip or weaken a test to make a change pass (TEST-5).
- Keep changes minimal; a new runtime dependency needs a reason in the PR (STACK-1). Every dependency with an install
  script needs an `allowScripts` decision (`npm install-scripts approve|deny <pkg>`, STACK-7); approve
  `better-sqlite3` when #10 adds it.
- Update `README.md` when a change affects setup, configuration, roles or user-visible behaviour.
- Commit subjects are short and imperative, with `Refs #<issue>` in the body when working from an issue.

## Deviations from the AGT web app spec

Rule IDs refer to the pinned v6.0.1 copy. The rebuild adds the spec's features one sub-issue of #6 at a time; each
row below names the sub-issue that removes it. Narrow the row as items land, and delete it in the PR that removes the
last one. Three permanent deviations are planned and get their rows with the code: AUTH-1 (member accounts, #17),
Principle 1 and SEC-14 (AGT sign-in, #18) and SEC-9 (CSV files in the Admin's sheet import, #22).

| Rule | What differs | Why |
| --- | --- | --- |
| SRV-8, SRV-11, CFG-1..CFG-10, API-6, API-10..API-13, DATA-3..DATA-10, BAK-8, SEC-4, SEC-7, REPO-3, FE-2 | **To fix (#10):** no `config.yaml`, settings, database or migrations yet; the server listens on 127.0.0.1:8082 (or `AGT_TRIVIA_SERVER_HOST`); `/api/health` answers without a database query; no OpenAPI document, rate limits, `HttpError` or shared API client; the only error codes are `not_found`, `invalid_request` and `internal` | Scaffold (#9) |
| AUTH-1..AUTH-9, SEC-5, UI-8, I18N-1..I18N-6, A11Y-2, A11Y-4..A11Y-6, CFG-6 (Settings tab) | **To fix (#11):** no Admin account, first-run setup, sessions, CSRF check, admin tabs, string tables, user settings dialog or font scale | Scaffold (#9) |
| LOG-1..LOG-23 | **To fix (#12):** no log store; the server logs to stdout only | Scaffold (#9) |
| BAK-1..BAK-11 | **To fix (#13):** no backup and restore | Scaffold (#9) |
| DEP-1..DEP-10, SEC-15, REPO-1 (`Dockerfile`, `docker-compose.yml`, `.env.example`, `config.example.yaml`, `deploy/`), TEST-8 | **To fix (#14):** no Docker image, Compose file, systemd unit or Caddy example | Scaffold (#9) |
| DOC-1 | **To fix (#10–#22):** README sections for features that do not exist yet say so and name their sub-issue | Scaffold (#9) |
| UI-7 | **To fix (#16):** the public header has no icon buttons (settings, sign-in) and the footer no support link | Scaffold (#9) |
