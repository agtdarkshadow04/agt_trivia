# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Copilot, etc.) working in this repo.
Human-facing docs live in `README.md`. `CLAUDE.md` imports this file.

## What this is

AGT Galactic Trivia: a static, framework-free Vite single-page app. Trivia content comes
from two CSV files fetched at runtime and parsed with PapaParse. There is no backend; it is
deployed to AWS Amplify Hosting (`amplify.yml` → `npm ci && npm run build` → `dist/`).

## Commands

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Verify everything (run before committing; CI runs this) | `npm run check` (tests + production build) |
| Unit tests only | `npm test` (~1s) |
| Single test file | `npx vitest run src/lib/quiz.test.js` |
| Dev server | `npm run dev` (http://localhost:5173) |

Node 20.19+ or 22.12+. No linter or formatter is configured; match the existing style
(2-space indent, double quotes, semicolons, trailing commas).

## Layout

```
index.html            Static shell; mounts #app and loads src/main.js
src/main.js           State object, HTML-string views, render(), delegated event handlers
src/config.js         VITE_* env vars with defaults (CSV URLs, logo path)
src/lib/csv.js        Fetch + parse + validate CSVs (all data validation lives here)
src/lib/quiz.js       Pure quiz logic: sorting, filtering, shuffling, answer checking
src/lib/format.js     Pure formatting helpers: escapeHtml, pluralize, rankForPercent
src/lib/*.test.js     Vitest tests, colocated with the module they cover
src/styles.css        All styles; colour tokens are CSS custom properties on :root
public/data/*.csv     Bundled example data (served at /data/*.csv)
```

## How the UI works

- A single mutable `state` object in `src/main.js`. Every change mutates `state` and calls
  `render()`, which replaces `#app.innerHTML` with the view for the current state
  (loading → error → categories → quiz length → question → results).
- Event listeners are attached **once** to `#app` (click / change / submit) and dispatch on
  `data-action`, `data-category` and `data-quiz-length` attributes. To add an interaction,
  add a `data-*` hook in the view markup and handle it in `handleClick`; do not bind
  listeners inside views or in `render()`.
- `?category=<catNameShort>` deep-links to a category; `popstate` keeps history in sync.

## Rules that matter

- **Escape everything from CSV/env** with `escapeHtml` before interpolating into view
  templates. Views are HTML strings, so unescaped data is an XSS bug.
- Put logic that can be pure in `src/lib/` and test it there; `main.js` is untested DOM
  glue and should stay thin.
- CSV validation errors must name the file and row number (follow the existing messages in
  `csv.js`); they are shown to admins in the UI.
- Category ↔ question matching and answer matching are case-insensitive.
- The bundled CSVs are parsed by a test in `csv.test.js`, so `npm test` fails if you add
  invalid rows. Quote cells that contain commas (`answers`, multi-value `correctAnswer`).

## CSV schema (summary; full tables in README)

- `categories.csv`: `catName`, `catNameShort` (unique, used in URLs), `catDesc`,
  `catPriority` (0–100, lower first), `adminNotes` (ignored).
- `questions.csv`: `category` (must equal a `catName`), `isApproved` / `adminNotes`
  (ignored), `isMultiAnswer` (true/false/1/0/yes/no; must agree with the number of correct
  answers), `question`, `answers` (2–4, comma-separated), `correctAnswer`, `author`.

## Gotchas

- `.env.local` is tracked in git even though `.gitignore` lists it; it holds the `VITE_*`
  values for the build. Never put secrets in a `VITE_*` variable: Vite inlines them into
  the public client bundle.
- `VITE_*` values are read at **build** time, not runtime.
- Remote CSV URLs must allow CORS from the deployed origin. CSVs are fetched with
  `cache: "no-store"` so data edits show up without a redeploy.
- `dist/` and `node_modules/` are gitignored; never commit them.
