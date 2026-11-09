# AGT Galactic Trivia

A sci-fi themed, CSV-driven trivia game for the Alliance of Galactic Travellers. The app supports single- and multi-answer questions, shareable category URLs, category priority ordering, scoring, and responsive keyboard-friendly gameplay.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

The included example data is served from `public/data/categories.csv` and `public/data/questions.csv`.

## Configure quiz data

Copy `.env.example` to `.env.local` and update either CSV location:

```dotenv
VITE_CATEGORIES_CSV_URL=/data/categories.csv
VITE_QUESTIONS_CSV_URL=/data/questions.csv
VITE_LOGO_PATH=/logo-placeholder.svg
```

Each value can be a path within `public/` or an absolute HTTPS URL. Remote CSV hosts must allow browser requests from the deployed app's origin through CORS.

Categories use these columns:

| Column | Purpose |
| --- | --- |
| `catName` | Full category name; must match question `category` values |
| `catNameShort` | Unique short code used by links such as `?category=LORE` |
| `catDesc` | Description displayed on the category card |
| `catPriority` | Number from 0–100; lower values display first, then alphabetically |
| `adminNotes` | Ignored |

Questions use these columns:

| Column | Purpose |
| --- | --- |
| `category` | Full category name |
| `isApproved` | Ignored |
| `adminNotes` | Ignored |
| `isMultiAnswer` | `true` when more than one answer is correct |
| `question` | Question text |
| `answers` | Comma-separated list of 2–4 choices |
| `correctAnswer` | Correct choice, or comma-separated choices for multi-answer questions |
| `author` | Attribution shown below the question |

Because `answers` and multi-value `correctAnswer` fields contain commas, quote those cells in a standard CSV file. See the bundled data for examples.

## Change the logo

Place a replacement image in `public/` and set `VITE_LOGO_PATH`, or set it to an absolute HTTPS image URL. The header logo element reads this value at build time.

## Deploy with AWS Amplify

1. Connect this repository to a new Amplify Hosting app.
2. Select the `main` branch.
3. Amplify will detect `amplify.yml`, install dependencies, and publish `dist/`.
4. If using external CSV files or a different logo, add the matching `VITE_*` values under **Hosting → Environment variables**, then redeploy.

No backend resources are required.

## Verification

```bash
npm run check
```

This runs the unit tests and a production build; CI runs the same command on every pull request. Contributor and AI-agent guidance lives in `AGENTS.md`.
