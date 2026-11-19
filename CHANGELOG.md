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

### Changed

- The app is rebuilt on the AGT Web Application Specification v6.0.1 stack: a Fastify 5 server with a React 19 +
  Vite 8 client, in TypeScript, with a separate admin page at `/admin` (#9).
- The page uses the AGT look: the official AGT logo, the NMS Futura font and the AGT base stylesheet, bundled and
  served by the app itself (#9).

### Removed

- The AWS Amplify build (`amplify.yml`), the build-time `VITE_*` settings and the bundled example CSV files (#9).

## [1.0.0] - 2026-08-04

### Added

- The static trivia app: categories with priorities and short codes, `?category=` links, short, long and full
  quizzes, single- and multi-answer questions, scores and ranks, read from a published Google Sheet.
