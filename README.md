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

Two methods, both on Ubuntu 24.04 LTS or Debian 12/13: [Docker Compose](#docker-compose) or a
[local installation](#local-installation-ubuntudebian) as a systemd service. Either way, install a **release tag**,
never `main`: in the commands below, replace `vX.Y.Z` with the latest release from the repository's Releases page
(2.0.0 or later; the 1.x tags are the former static app). The app serves plain HTTP on port 8082 of the loopback
interface; put a [TLS reverse proxy](#tls-and-reverse-proxies) in front of it.

### Docker Compose

Needs Docker Engine with the Compose plugin.

```bash
git clone https://github.com/agtdarkshadow04/agt_trivia.git
cd agt_trivia
git checkout vX.Y.Z
cp config.example.yaml config.yaml
cp .env.example .env
chmod 600 .env
# Edit .env: set AGT_TRIVIA_SETUP_PASSWORD (see First run)
docker compose up -d --build
```

`config.yaml` must exist before the first `docker compose up`, because it is mounted into the container (read-only);
uncomment in it what you change. Data lives in the Docker volume `trivia-data` (`/app/data` in the container): the
database, the log store and the pre-restore backups. The container runs as the non-root `node` user on a read-only
file system, and the port is published on `127.0.0.1` only.

`docker compose ps` shows the service `healthy` after a few seconds; then open `http://127.0.0.1:8082/admin` (or
your proxy's address) for [First run](#first-run). Logs: `docker compose logs trivia`.

### Local installation (Ubuntu/Debian)

As a user with `sudo`:

```bash
# 1. Node.js 26 from NodeSource, and build tools for the SQLite module
curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs git build-essential python3

# 2. System user and code
sudo useradd --system --home-dir /var/lib/agt-trivia --shell /usr/sbin/nologin agt-trivia
sudo git clone https://github.com/agtdarkshadow04/agt_trivia.git /opt/agt-trivia
sudo git -C /opt/agt-trivia checkout vX.Y.Z
cd /opt/agt-trivia
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev

# 3. Configuration
sudo mkdir -p /etc/agt-trivia
sudo cp config.example.yaml /etc/agt-trivia/config.yaml
sudo cp .env.example /etc/agt-trivia/.env
sudo chmod 600 /etc/agt-trivia/.env
# Edit /etc/agt-trivia/config.yaml: uncomment storage: and set dataDir: /var/lib/agt-trivia
# Edit /etc/agt-trivia/.env: set AGT_TRIVIA_SETUP_PASSWORD (see First run)

# 4. Service
sudo cp deploy/agt-trivia.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agt-trivia
```

The service ([`deploy/agt-trivia.service`](deploy/agt-trivia.service)) runs as the `agt-trivia` user with systemd's
sandboxing; it may write only to `/var/lib/agt-trivia`, which holds the database, the log store and the backups.
`systemctl status agt-trivia` should say `active (running)`; then open `http://127.0.0.1:8082/admin` for
[First run](#first-run). Logs: `journalctl -u agt-trivia`.

### TLS and reverse proxies

The app speaks plain HTTP and is reachable only from the same machine. Serve it over HTTPS through a reverse proxy
on that machine. With [Caddy](https://caddyserver.com), [`deploy/Caddyfile.example`](deploy/Caddyfile.example) is
all it takes: replace `trivia.example.org` with your domain, and Caddy obtains and renews the certificate.

Then tell the app to trust the proxy, in `config.yaml`:

```yaml
server:
  trustProxy: 127.0.0.1
```

Use `127.0.0.1` for a local installation. With Docker, the app sees the proxy connect from the Docker network's
gateway: use that address (`docker network inspect agt_trivia_default`, `Gateway`) or the network's CIDR range.
Without `trustProxy`, the app ignores `X-Forwarded-*`: it cannot tell that visitors used HTTPS, so the Admin's
session cookie is not marked `Secure` and every visitor shares the proxy's address for rate limits and logs. Keep
`session.secureCookie: auto`.

Only if the proxy runs on another machine: set `server.host` (local installation) or the published address in
`docker-compose.yml` (Docker) to an interface that machine can reach, and allow that port from the proxy's address
only, with a firewall.

### Upgrading

1. Read the release's upgrade notes in [`CHANGELOG.md`](CHANGELOG.md).
2. Download a backup (**Backup & restore** tab), and keep it until the new version works.
3. Check out the new tag and rebuild. Migrations run at startup.

Docker Compose:

```bash
git fetch --tags
git checkout vX.Y.Z
docker compose up -d --build
```

Local installation:

```bash
cd /opt/agt-trivia
sudo git fetch --tags
sudo git checkout vX.Y.Z
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo systemctl restart agt-trivia
```

The dashboard's header shows the running version.

### Rolling back

Going back to an older version in place is not possible: once a newer version has migrated the database, an older
one refuses to start with it. To roll back, check out the previous tag and rebuild as in [Upgrading](#upgrading),
then put back the backup from before the upgrade:

- **Docker Compose:** `docker compose down`, then `docker volume rm agt_trivia_trivia-data` (this deletes the
  current data and the logs), `git checkout` the previous tag, `docker compose up -d --build`.
- **Local installation:** `sudo systemctl stop agt-trivia`, then
  `sudo rm /var/lib/agt-trivia/agt-trivia.sqlite*` (the database only; the logs stay), check out the previous tag
  and rebuild, `sudo systemctl start agt-trivia`.

The app then starts empty: run [First run](#first-run) again with a setup password, and restore the backup in the
**Backup & restore** tab. A backup made by the newer version cannot be restored into the older one.

## First run

The installation has a single **Admin** account, created once on first run with a one-time setup password.

1. Choose a setup password and put it in `.env` (Docker Compose: `.env` beside `docker-compose.yml`; local
   installation: `/etc/agt-trivia/.env`; both copied from [`.env.example`](.env.example)):
   `AGT_TRIVIA_SETUP_PASSWORD=<something long and random>` (at most 1024 characters). Start or restart the server
   (`docker compose up -d`, or `sudo systemctl restart agt-trivia`).
2. Open `/admin`. The setup screen asks for the setup password, the Admin username and a new password (at least 12
   characters, different from the setup password). The setup password never becomes the Admin password and is
   never stored.
3. **Remove `AGT_TRIVIA_SETUP_PASSWORD` and restart.** It is no longer needed: setup cannot run again once the
   Admin exists. Until you remove it, the server log warns at every start and the dashboard shows a reminder.
   - Docker Compose: delete the line from `.env`, then `docker compose up -d`.
   - Local installation: delete the line from `/etc/agt-trivia/.env`, then `sudo systemctl restart agt-trivia`.

If the variable is not set, the setup screen says "Setup is unavailable" and nothing can be created.

## Configuration reference

Settings come from three places:

- **`config.yaml`**, for everything that is not a secret. The server reads `./config.yaml` (or the file
  `AGT_TRIVIA_CONFIG_FILE` names); without one it uses the defaults and logs a warning. Copy
  [`config.example.yaml`](config.example.yaml), which lists every key with its default, and uncomment what you change.
  An unknown key or an invalid value stops the server with a message naming the key. The app never writes this file.
- **`.env`**, for secrets only: see [`.env.example`](.env.example).
- **The dashboard's Settings tab**, for the keys in the second table below.

**Precedence: config file > dashboard > default.** A key set in `config.yaml` cannot be changed from the dashboard.

### Config-file-only keys

| Key | Default | Description |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | Listen address; `AGT_TRIVIA_SERVER_HOST` sets it when the file does not (the Docker image uses `0.0.0.0`) |
| `server.port` | `8082` | Listen port |
| `server.trustProxy` | `false` | Trust `X-Forwarded-*` headers from a TLS reverse proxy: `true`, or the proxy's address or CIDR range (one or a list) |
| `server.logLevel` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` (stdout) |
| `storage.dataDir` | `data` | Where the app keeps its data, relative to the working directory |
| `storage.databaseFile` | `agt-trivia.sqlite` | The SQLite database, relative to `storage.dataDir` |
| `storage.logDatabaseFile` | `logs.sqlite` | The log store (server log and audit log), relative to `storage.dataDir`; never in backups |
| `storage.backupsDir` | `backups` | Pre-restore backups and the temporary files of backups and restores, relative to `storage.dataDir` |
| `session.ttlHours` | `12` | How long an Admin sign-in lasts, in hours (1–168) |
| `session.secureCookie` | `auto` | Whether the session cookie is `Secure`: `auto` (when the request came over HTTPS; behind a proxy that needs `server.trustProxy`), `true` or `false` |
| `rateLimits.login` | 10 per 15 minutes | Admin sign-in and the Admin password change, each counted separately, per client address |
| `rateLimits.setup` | 10 per 15 minutes | First-run setup, per client address |
| `rateLimits.adminUploads` | 120 per 15 minutes | Backup previews and restores, per client address |

### Dashboard-editable keys

| Key | Default | Description |
| --- | --- | --- |
| `site.title` | `AGT Galactic Trivia` | Name shown in the header and the browser title (1–100 characters) |
| `site.supportUrl` | `https://www.nms-agt.com/support` | Support link: an absolute `http:` or `https:` URL |
| `quiz.shortLength` | `10` | Questions in a short quiz (1–100, fewer than `quiz.longLength`) |
| `quiz.longLength` | `30` | Questions in a long quiz (2–500, more than `quiz.shortLength`) |
| `backup.maxZipBytes` | `209715200` (200 MiB) | Largest backup upload, in bytes (1024 to 2 GiB) |
| `backup.maxUncompressedBytes` | `1073741824` (1 GiB) | Largest total size of a backup's files once unpacked, in bytes (1024 to 8 GiB) |
| `backup.maxEntries` | `10000` | Most files in a backup archive (1–100000) |
| `logs.serverRetentionDays` | `30` | Days the server log keeps an entry (1–3650) |
| `logs.serverMaxEntries` | `100000` | Most server log entries (1000–10000000); the oldest go first |
| `logs.auditRetentionDays` | `365` | Days the audit log keeps an entry (30–3650) |
| `logs.auditMaxEntries` | `1000000` | Most audit log entries (10000–10000000); the oldest failures go first, then the oldest successes |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGT_TRIVIA_SETUP_PASSWORD` | In `.env`: the one-time setup password for [First run](#first-run). Remove it after setup |
| `AGT_TRIVIA_CONFIG_FILE` | Path of `config.yaml` (default `./config.yaml`); set by the Dockerfile and the systemd unit |
| `AGT_TRIVIA_SERVER_HOST` | Listen address when `server.host` is not in `config.yaml`; set by the Dockerfile |
| `AGT_TRIVIA_STATIC_DIR` | Development only: the built client, instead of `dist/` |

The database is a single SQLite file, migrated automatically at startup. A database made by a newer version of the
app stops the server instead of being changed.

## Admin dashboard

The Admin signs in at `/admin`. The header shows the app version, a **Settings** button for the language, time zone
and text size (stored in this browser and shared with the game), **View site** and **Sign out**. The tabs:

- **Settings** edits the [dashboard-editable keys](#dashboard-editable-keys). Settings defined in `config.yaml` are
  shown read-only, marked "Set in the configuration file".
- **Server log** shows, filters, searches, exports and clears the server log (see [Logs](#logs)). While there are
  unseen warnings or errors, the tab shows a badge with their count and the dashboard a link to it.
- **Audit log** shows, filters, searches and exports the audit log. It cannot be edited or cleared.
- **Backup & restore** downloads a backup, and previews and restores one (see [Backup & restore](#backup--restore)).
- **Account** changes the Admin password. This signs out every other Admin session.

Members and Import arrive in #17 to #22.

## Playing

Categories, quizzes, member accounts and score history: added in #15 to #21.

## Backup & restore

The **Backup & restore** tab of the dashboard downloads a backup and restores one. A backup is one ZIP file,
`agt-trivia-backup-<time>.zip`, with:

- `database.sqlite`: a consistent copy of the database (the Admin account and the dashboard settings; categories,
  questions, members and scores as they arrive), without sessions;
- `config.yaml`, when the server has one;
- `manifest.json`: the app and schema versions, the time, and each file's size and SHA-256 checksum.

`.env`, sessions and the [logs](#logs) are never in a backup. **A backup contains the Admin's password hash** (and,
later, the members'): keep it as safe as the server itself, and restore only backups you made or trust.

Taking a backup takes a moment: changes wait while the copy is made (at most 30 seconds, then they answer "Maintenance
in progress"); reading goes on.

To restore, choose the file and **Preview backup**. The server checks the whole archive first and changes nothing:
the manifest and every checksum, that it holds only the files a backup has, the size limits (`backup.*`), that the
database is intact, contains only the app's tables and indexes, and is not from a newer version, and that its Admin
password hash is valid. The preview shows when and by which version the backup was made, what it contains, the
settings `config.yaml` overrides, and how its `config.yaml` differs from the current one. **`config.yaml` is never
restored**: copy what you want from the diff (or download the backup's file) and edit the server's file by hand.

Then confirm and **Restore backup**. The restore:

1. checks the archive again, then puts the app in maintenance: requests in progress finish (if they take longer
   than 30 seconds, the restore gives up and changes nothing), and new ones answer "Maintenance in progress";
2. saves the current data as `pre-restore-backup-<time>.zip` in `storage.backupsDir` (the server keeps it; delete
   it when you no longer need it);
3. replaces the database file, upgrades an older backup's database, and checks it;
4. drops dashboard settings that the current `config.yaml` sets, and ends every session.

Everyone is signed out; sign in with the Admin account from the backup. If anything fails in steps 3 or 4, the
previous database is put back and nothing changes.

Backups and restores run one at a time. Older backups are upgraded; backups from a newer version are refused.

## Logs

The server keeps two logs in their own SQLite file, `storage.logDatabaseFile` (`logs.sqlite` in the data directory).
**Logs are not part of backups**, and a restore never changes them.

- The **server log** holds what the server did by itself: startup (version, schema versions, address, which
  configuration file), configuration warnings such as the setup-password reminder, every migration applied,
  retention runs, unexpected errors with their stack, and shutdown. Entries at `info` level and above are stored,
  whatever `server.logLevel` says; that key only controls what is also printed to stdout.
- The **audit log** holds what people did: every request that changes something (setup, sign-in and sign-out,
  password changes, settings changes, clearing the server log), downloads of log exports, denied attempts on the
  Admin pages and every rate-limited request, each with its outcome. Settings changes record the old and new values;
  nothing else records submitted values, and passwords, tokens and cookies are never logged. Repeated failures from
  one address within a minute are counted in one entry.

**Privacy:** the audit log stores the Admin's username and, for every entry, a pseudonymous network identifier: the
first 16 hex characters of an HMAC of the client address (the /64 prefix for IPv6), with a random key kept in the log
store. Raw IP addresses are never stored, in either log. Entries are kept for `logs.auditRetentionDays` (365 days by
default, at least 30) and the server log's for `logs.serverRetentionDays` (30 days); each log also has a maximum
number of entries. A retention job removes older entries at startup and every hour, and notes each run that deleted
something in the server log.

Both tabs export the entries matching the current filters as JSON Lines or CSV. CSV cells that start like a
spreadsheet formula (`=`, `+`, `-`, `@`) get a leading `'`, so opening an export never runs one.

## Content safety

- Every response carries a strict Content-Security-Policy (no inline scripts or styles, no external hosts),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cross-Origin-Opener-Policy`, and
  API and HTML responses are never cached. The API sends no CORS headers.
- The fonts and the logo are bundled and served by the app; nothing is loaded from another site.
- The Admin password is hashed with scrypt (`N = 2^15, r = 8, p = 1`); a stored hash in any other format can never
  verify. Sessions use random tokens stored only as SHA-256 hashes, in an `HttpOnly`, `SameSite=Strict` cookie, and
  every request that changes something needs the `x-agt-request: 1` header. Setup, sign-in and the password change
  are rate limited.

## Development

Requires Node.js 26 and npm 11.20 or newer within npm 11.

```bash
npm ci
npm run check
```

| Command | What it does |
| --- | --- |
| `npm run dev:server` | Builds and runs the server on `127.0.0.1:8082`, with `./config.yaml` if present and its data in `./data/` |
| `npm run dev` | Vite dev server on `http://localhost:5173`, proxying `/api/` to the server |
| `npm run check` | Type check, unit and server tests, and the production build |
| `npm run test:e2e` | Builds, then runs the Playwright browser tests against the real server |
| `npm run build` | Client into `dist/`, server into `dist-server/index.mjs` |
| `npm start` | Runs the built server |

The browser tests need Chromium: run `npx playwright install --with-deps chromium` once.

| Path | Contents |
| --- | --- |
| `server/` | Fastify server, its SQLite migrations (`server/migrations/`) and its tests (`server/test/`) |
| `src/` | Player UI (React), with `src/admin/` for the admin page and `src/lib/` for shared logic |
| `public/` | The AGT logo, fonts and font licences |
| `tests/e2e/` | Browser tests |
| `docs/API.md` | API guide; the full description is `GET /api/openapi.json` |
| `docs/agt-webapp-spec.md` | The AGT Web Application Specification v6.0.1 the app follows |

Contributor and AI-agent guidance is in [`AGENTS.md`](AGENTS.md); the rules the app follows are in the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## Troubleshooting

- **The server does not start:** it logs one line saying why, on stdout, and exits with status 1. The usual causes:
  - `Invalid config.yaml: <key>: …`: fix or remove that key; [`config.example.yaml`](config.example.yaml) shows
    every allowed key and value.
  - `The database schema version N is newer than this version of the app supports`: the data was written by a newer
    release. Run that release again, or restore a backup made by this one. The database is left unchanged.
  - `The server could not listen on …`: another program uses port 8082; set `server.port`.
  - `AGT_TRIVIA_SETUP_PASSWORD is longer than 1024 characters`: set a shorter value in `.env` and restart.
- **"Setup is unavailable" on `/admin`:** `AGT_TRIVIA_SETUP_PASSWORD` is not set, or the server was not restarted
  after you set it.
- **Locked out of the Admin account:** delete the Admin and its sessions with the SQLite command-line tool and run
  first-run setup again:
  1. Stop the server.
  2. Run `sqlite3 data/agt-trivia.sqlite "DELETE FROM sessions; DELETE FROM admin;"` (the path is
     `storage.dataDir`/`storage.databaseFile`).
  3. Set `AGT_TRIVIA_SETUP_PASSWORD` in `.env`, start the server and open `/admin`.
- **"Too many attempts. Try again in N seconds."** Sign-in, the password change and setup are rate limited per
  client address (`rateLimits.*`). Behind a reverse proxy, set `server.trustProxy` to the proxy's address, or every
  visitor shares the proxy's address and one limit.
- **Signed out right after signing in, behind HTTPS:** the session cookie is `Secure` only when the server knows the
  request came over HTTPS. Set `server.trustProxy` so it believes the proxy's `X-Forwarded-Proto`, or set
  `session.secureCookie: true`.
- **Something went wrong:** open the **Server log** tab first. Unexpected errors are there with their details, and
  the matching audit entry has the same request ID.
- **"Maintenance in progress":** a restore is running, or a change waited 30 seconds for a backup. The page retries
  by itself after a few seconds.
- **A restore failed** and could not be rolled back (the dashboard says so): the app stays in maintenance, and only
  the Admin who ran the restore can use the **Backup & restore** tab, to restore another backup. Restore the
  `pre-restore-backup-<time>.zip` the server log names (in `storage.backupsDir`), or another backup. If the server
  was restarted meanwhile, it refuses to start, because `restore-failed.json` is in the data directory. Then restore
  by hand:
  1. Stop the server.
  2. Unpack `database.sqlite` from the pre-restore backup the marker file names (or from another backup) and copy it
     over the database (`storage.dataDir`/`storage.databaseFile`); delete the database's `-wal` and `-shm` files and
     any `*.restore-old-*` and `*.restore-new-*` files beside it.
  3. Delete `restore-failed.json` from the data directory and start the server.
- **"The replaced database files could not be deleted"** after a restore: delete the `*.restore-old-*` files the
  server log names, next to the database in `storage.dataDir`.

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
