# AGT Galactic Trivia

> **AI Disclosure:** This software was created using generative AI.

AGT Galactic Trivia is the trivia game of the Alliance of Galactic Travellers. Visitors pick a category and play a
short, long or full quiz of single- and multi-answer questions, and see their score and rank. Version 2.0.0, being
built now (#6), turns the former static app on a published Google Sheet into a self-hosted web application: members
keep a score history, write and review questions in the app, and a single installation Admin manages members,
settings, backups and logs from a separate page at `/admin`. It is fully self-hosted: it uses no cloud service and
no CDN, the server makes no outbound requests, and the browser loads everything from your server. All data will
live on your machine, in the app's SQLite database and data directory, with the settings in `config.yaml` and the
secrets in `.env`.

> **Status:** 2.0.0 is under construction. This README describes what exists today; sections for parts that are
> not built yet say so and link the issue that adds them. The live site still runs the 1.x static app from the
> frozen `amplify` branch.

## Contents

- [Installation](#installation)
- [First run](#first-run)
- [Configuration reference](#configuration-reference)
- [Admin dashboard](#admin-dashboard)
- [Playing](#playing)
- [Backup & restore](#backup--restore)
- [Logs](#logs)
- [Content safety](#content-safety)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

## Installation

Docker Compose and a local installation on Ubuntu 24.04 LTS or Debian 12/13, both from a release tag, with a TLS
reverse proxy, upgrading and rolling back: added in #14. Until then, run the server as [Development](#development)
describes.

## First run

First-run setup of the Admin account with `AGT_TRIVIA_SETUP_PASSWORD`: added in #11.

## Configuration reference

`config.yaml`, `.env` and the dashboard settings: added in #10. The server currently listens on `127.0.0.1:8082`.

## Admin dashboard

The page at `/admin`. Its tabs (Members, Settings, Server log, Audit log, Import, Backup & restore, Account) are
added in #11 to #22.

## Playing

Categories, quizzes, member accounts and score history: added in #15 to #21.

## Backup & restore

Added in #13.

## Logs

Added in #12.

## Content safety

- Every response carries a strict Content-Security-Policy (no inline scripts or styles, no external hosts),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cross-Origin-Opener-Policy`, and
  API and HTML responses are never cached. The API sends no CORS headers.
- The fonts and the logo are bundled and served by the app; nothing is loaded from another site.

## Development

Requires Node.js 26 and npm 11.20 or newer within npm 11.

```bash
npm ci
npm run check
```

| Command | What it does |
| --- | --- |
| `npm run dev:server` | Builds and runs the server on `127.0.0.1:8082` |
| `npm run dev` | Vite dev server on `http://localhost:5173`, proxying `/api/` to the server |
| `npm run check` | Type check, unit and server tests, and the production build |
| `npm run test:e2e` | Builds, then runs the Playwright browser tests against the real server |
| `npm run build` | Client into `dist/`, server into `dist-server/index.mjs` |
| `npm start` | Runs the built server |

The browser tests need Chromium: run `npx playwright install --with-deps chromium` once.

| Path | Contents |
| --- | --- |
| `server/` | Fastify server and its tests (`server/test/`) |
| `src/` | Player UI (React), with `src/admin/` for the admin page and `src/lib/` for shared logic |
| `public/` | The AGT logo, fonts and font licences |
| `tests/e2e/` | Browser tests |
| `docs/agt-webapp-spec.md` | The AGT Web Application Specification v6.0.1 the app follows |

Contributor and AI-agent guidance is in [`AGENTS.md`](AGENTS.md); the rules the app follows are in the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## Troubleshooting

- **The server does not start:** it logs one line saying why, on stdout. Port 8082 may be in use by another program.
- More topics (setup password, locked out, rate limits, proxies, maintenance, failed restores) arrive with their
  features (#10 to #14).

## Credits

The AGT logo and the fonts come unmodified from the
[AGT Web Application Specification](https://github.com/agtdarkshadow04/agt_webapp_specification/blob/v6.0.1/assets/README.md)
(v6.0.1). The logo is © Alliance of Galactic Travellers, all rights reserved, and is used only in AGT apps.

- **NMS Futura** (`public/NMSFuturaProBook_Kerned.ttf`), the interface font: by No Man's Sky Community Developers &
  Designers (NMSCD), designer Blend3rman (licence notice © 2020 Hector Javier Gonzalez Rivera), based on the typeface
  of Hello Games' No Man's Sky. Licensed under the [SIL Open Font License 1.1](public/fonts/NMSFuturaProBook-OFL.txt).
  Source: [NMSCD/No-Mans-Sky-Universal-Font](https://github.com/NMSCD/No-Mans-Sky-Universal-Font/blob/master/assets/font/NMSFuturaProBook_Kerned/Web-TT/NMSFuturaProBook_Kerned.ttf).
- **Twemoji Country Flags** (`public/fonts/TwemojiCountryFlags.woff2`), which shows the flags of the language
  choices: flag artwork by Twitter, Inc. and other contributors (Twemoji),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); font packaging © 2022 TalkJS, MIT
  ([licence file](public/fonts/TwemojiCountryFlags-LICENSE.md)). Source:
  [talkjs/country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) 0.1.10.

The app shows no portal codes, so it does not bundle the NMS Glyphs Mono font.
