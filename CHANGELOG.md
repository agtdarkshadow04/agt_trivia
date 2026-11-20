# Changelog

All notable changes to AGT Galactic Trivia are documented in this file. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) as the AGT Web Application Specification requires (§21).

## [2.1.0] - Unreleased

### Added

- **Review your answers** on the results screen: every question of the quiz in the order played, with your answer, the
  correct one, and whether it was right. It works without signing in, and nothing is sent to the server (#44).
- `GET /api/categories/{id}/quiz` returns the quiz's signed `attempt`, and `POST /api/member/results` takes its token
  as `attemptToken` (error `attempt_invalid` when it does not fit). The key that signs attempts is generated at
  startup and kept in the database, so backups carry it (#45).
- **Report a problem** with a question: signed-in members report a question while they play it or from the answer
  review, with a reason and optional details. Moderators see the open reports under **Reported questions** on the
  Review queue page, counted in the header, and mark them resolved or dismiss them (#46).
- **Move questions** on the Categories page: Moderators move every question of a category, whatever its status, to
  another category in one step, from the category's card or from a refused delete, and can then delete it (#47).
- The **Members** tab shows each member's last sign-in, or "Never", and filters the members who have not signed in
  for 30, 90 or 365 days. A member sign-in now records the time, so like every other change it is refused during a
  restore (#48).
- **Leaderboards**, off by default (`leaderboards.enabled`, `leaderboards.size`): each category gets a public board of
  the members who turn on **Show me on leaderboards** in their account, by display name, ranked by their best quiz of
  at least `quiz.shortLength` questions, of any length, saved from a signed attempt (#49, #60).

### Changed

- A category offers only the quiz lengths that differ: with no more questions than a short quiz it offers only the
  full quiz, and with no more than a long quiz, the short and the full ones, instead of the same quiz up to three
  times (#43).

### Deprecated

- Saving a result (`POST /api/member/results`) without `attemptToken` still works as before but is deprecated; 3.0.0
  will refuse it. Send the `attempt.token` of the quiz `GET /api/categories/{id}/quiz` drew (#45).

### Fixed

- The admin dashboard's buttons with an icon and a label (Sign out, the log filters, export and clear, the import's
  and backup's preview, download, import and restore) showed the icon at full size against the text; it is now
  text-sized and spaced like the rest of the app (#39, #40).
- A quiz showed every question's answers in the order they were written, and the 1.x sheet often lists the correct
  answer first, so "A" was right far more often than chance. The answers are now shuffled each time a quiz is drawn
  (#41).
- A rounded percentage chose the rank, so 199 of 200 showed 100 % and earned Atlas Archivist, and 149 of 200 counted
  as 75 %. The rank now comes from the exact score, and a percentage (on the results screen and in **My scores**)
  shows 100 % only for a perfect score and 0 % only when no answer was right (#42).
- A member's saved score is now tied to the quiz the server drew. Every quiz comes with a signed attempt, and a
  result that carries it must answer exactly the questions drawn, for that category and length, within a day; each
  quiz is saved once, so **Try again** after a save whose answer was lost no longer saves it twice. Before, a result
  could answer only some questions, claim any length, or be saved again (#45).

## [2.0.0] - 2026-11-20

### Upgrade notes

- 2.0.0 replaces the static AWS Amplify app and its published Google Sheet with a self-hosted server. There is
  nothing to upgrade in place: install 2.0.0 as the README describes, then bring the sheet's categories and questions
  in on the dashboard's **Import** tab. The release
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

- Installation with Docker Compose (an image that runs as a non-root user on a read-only file system, published on
  `127.0.0.1:8082` only) or as a systemd service on Ubuntu/Debian, with an example Caddy configuration for HTTPS.
  The README covers installing a release, TLS and reverse proxies, upgrading and rolling back (#14).

- Quiz categories and questions in the database, replacing the Google Sheet's two tables. A question has 2 to 4
  answers, at least one correct; more than one correct answer makes it a multi-answer question, and answers may now
  contain commas. Only approved questions are public. Categories no longer have a theme (#15).
- `GET /api/categories` lists the categories with their number of approved questions, and
  `GET /api/categories/{id}/quiz?length=short|long|all` draws a random quiz from them (#15).
- Backup previews and restore reports count categories and questions (#15).
- The game, rebuilt on the new server: choose a category, a short, long or full quiz, answer single- and
  multi-answer questions with feedback after each one, and see your score, percentage and rank. Links like
  `/?category=space` open a category directly, ignoring case (#16).
- **Member accounts** with the roles Player, Editor and Moderator, created by the Admin in the new **Members** tab
  (no self-registration). Members sign in with the **Sign in** button in the game's header, and the **Account**
  button shows their account, changes their password and signs them out. A role change, deactivation, password
  reset or deletion signs the member out everywhere; member sessions are never backed up (#17).
- **AGT sign-in**: members can sign in with their AGT account through AGT IAM, off by default. The first sign-in
  creates the member; every sign-in sets the role from the AGT IAM tier (`iam.roleMap`, Player by default). Set
  `iam.baseUrl`, `iam.appId` and `AGT_TRIVIA_IAM_API_KEY`, then turn it on in the Settings tab (#18).
- A **Settings** button in the header for the language and the text size, shared with the admin dashboard, and a
  footer with the Alliance links and the support link (#16).
- **Writing and reviewing questions**: Editors write questions in **My questions** (`/?page=questions`) with a live
  preview and the writing guidelines, save them as drafts and submit them; Moderators approve them into the quiz or
  reject them with a note in the **Review queue** (`/?page=review`, with a count in the header), and can change,
  unpublish and delete any question. A changed rejected question is a draft again; approved questions are locked for
  Editors. Two people changing the same question never overwrite each other: the second one is asked to reload (#19).
- **Category management**: Moderators create, edit and delete categories on the **Categories** page
  (`/?page=categories`), which lists them in display order with their questions counted by status. Changing a short
  name warns that old links break; a category with questions cannot be deleted until they are moved or deleted (#20).
- **Score history**: a signed-in member's finished quiz is saved to their history automatically, graded by the
  server. **My scores** (`/?page=scores`) shows their plays, best and average percentage per category and their
  results, newest first; only they can see it, and **Clear history** deletes it. The Settings dialog now also sets
  the time zone for these dates (#21).
- **Import** tab in the admin dashboard: upload the 1.x Google Sheet's `validCategories` and `pendingQuestions` tabs
  as CSV, preview what would be added and every row that needs fixing (with its file, row and column), and import it
  all in one go. Existing categories and questions are skipped, so importing again adds nothing; the files are never
  kept. The README shows how to download the tabs from Google Sheets (#22).

### Changed

- The app is rebuilt on the AGT Web Application Specification v6.0.1 stack: a Fastify 5 server with a React 19 +
  Vite 8 client, in TypeScript, with a separate admin page at `/admin` (#9).
- The game is fully keyboard-accessible and announces its feedback to screen readers; whether an answer was right
  is shown with an icon and words, not only colour. The former starfield, "Network online" signal and themes are
  gone (#16).
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
