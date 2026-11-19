# Changelog

All notable changes to AGT Galactic Trivia are documented in this file. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) as the AGT Web Application Specification requires (§21).

## [2.0.0] - Unreleased

### Upgrade notes

- 2.0.0 replaces the static AWS Amplify app and its published Google Sheet with a self-hosted server. There is
  nothing to upgrade in place: install 2.0.0 as the README describes, then import the sheet's data. The release
  notes below grow with each part of the rebuild (#6).
- Node.js 26 and npm 11.20 or newer within npm 11 are required.

### Added

- `config.yaml` for every non-secret setting, validated at startup: an unknown key or an invalid value stops the
  server with a message naming the key. `config.example.yaml` lists every key with its default (#10).
- Settings for the site title, the support link and the short and long quiz lengths (10 and 30 questions by
  default), which the admin dashboard will also be able to change; the configuration file always wins (#10).
- A SQLite database in the data directory, created and migrated automatically at startup. A database from a newer
  version stops the server instead of being changed (#10).
- `GET /api/health` now checks the database, `GET /api/settings/public` returns the public settings, and
  `GET /api/openapi.json` describes the API (OpenAPI 3.1). Every error has the same JSON body with a stable code
  (`docs/API.md`) (#10).
- First-run setup at `/admin`: with the one-time `AGT_TRIVIA_SETUP_PASSWORD` from `.env`, create the single Admin
  account. Setup cannot run again once the Admin exists; the server and the dashboard remind you to remove the
  variable (#11).
- Admin sign-in with a session cookie, sign-out, and a password change that signs out every other session.
  Sign-in, setup and the password change are rate limited (`session.*` and `rateLimits.*` in `config.yaml`) (#11).
- The admin dashboard with its **Settings** tab, where the Admin changes the site title and the quiz lengths
  (settings set in `config.yaml` are shown read-only), and its **Account** tab (#11).
- All ten AGT languages (English, French, German, Spanish, Brazilian Portuguese, Italian, Thai, Mandarin Chinese,
  Hindi and Japanese) and a text size from 1× to 2×, chosen in the dashboard's Settings dialog and remembered in this
  browser for both pages. Error messages are shown in the chosen language (#11).
- The server log and the audit log, kept in their own file (`storage.logDatabaseFile`) and never in backups, with
  **Server log** and **Audit log** tabs to filter, search and export them (JSON Lines or CSV) and to clear the server
  log. Addresses are stored only as pseudonymous hashes; retention is set with the `logs.*` settings (#12).
- A time-zone choice (the device's, or a fixed UTC offset) in the Settings dialog, for the times the dashboard shows
  (#12).
- **Backup & restore** tab: download a backup (a ZIP with the database, `config.yaml` and a manifest with checksums;
  never `.env`, sessions or the logs), preview an uploaded backup without changing anything, and restore it. A
  restore saves the current data as a pre-restore backup first, puts it back if anything fails, and signs everyone
  out; `config.yaml` is never restored, but its differences are shown. Limits for uploads are the `backup.*`
  settings; pre-restore backups go to `storage.backupsDir` (#13).
- While a restore runs, the API answers `503` with `Retry-After` and both pages show a maintenance notice and retry;
  `GET /api/health` reports `maintenance`. Changes made while a backup is taken wait for it (#13).

### Changed

- The app is rebuilt on the AGT Web Application Specification v6.0.1 stack: a Fastify 5 server with a React 19 +
  Vite 8 client, in TypeScript, with a separate admin page at `/admin` (#9).
- The page uses the AGT look: the official AGT logo, the NMS Futura font and the AGT base stylesheet, bundled and
  served by the app itself (#9).

### Removed

- The AWS Amplify build (`amplify.yml`), the build-time `VITE_*` settings and the bundled example CSV files (#9).

### Security

- Pages may load images only from the app itself: the Content-Security-Policy's `img-src` is `'self'` (#10).
- An uploaded backup is checked completely before anything changes: only the expected files, safe paths, size and
  entry limits before unpacking, checksums, database integrity, no triggers or views, and a valid Admin password
  hash. If a restore fails and even putting the old data back fails, the app stays in maintenance and refuses to
  start until the data is restored (#13).

## [1.0.0] - 2026-08-04

### Added

- The static trivia app: categories with priorities and short codes, `?category=` links, short, long and full
  quizzes, single- and multi-answer questions, scores and ranks, read from a published Google Sheet.
