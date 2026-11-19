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

### Changed

- The app is rebuilt on the AGT Web Application Specification v6.0.1 stack: a Fastify 5 server with a React 19 +
  Vite 8 client, in TypeScript, with a separate admin page at `/admin` (#9).
- The page uses the AGT look: the official AGT logo, the NMS Futura font and the AGT base stylesheet, bundled and
  served by the app itself (#9).

### Removed

- The AWS Amplify build (`amplify.yml`), the build-time `VITE_*` settings and the bundled example CSV files (#9).

### Security

- Pages may load images only from the app itself: the Content-Security-Policy's `img-src` is `'self'` (#10).

## [1.0.0] - 2026-08-04

### Added

- The static trivia app: categories with priorities and short codes, `?category=` links, short, long and full
  quizzes, single- and multi-answer questions, scores and ranks, read from a published Google Sheet.
