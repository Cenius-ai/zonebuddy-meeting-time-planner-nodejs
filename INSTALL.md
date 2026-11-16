# Installing Zonebuddy

Zonebuddy is a single Node.js process with **no runtime dependencies**. There is nothing to
`npm install` and no database server to run.

## 1. System prerequisites (installed by you, not by the scripts)

| Requirement | Notes |
| --- | --- |
| Node.js **20 or newer** | `node -v` must print v20.x or higher. Install from your OS package manager or nodejs.org. |
| A writable project directory | The store is created at `data/db.json` next to `main.js`. |
| A POSIX shell (optional) | Only needed to run `install.sh`; the app itself is launched with `node`. |

Nothing else is required: no Python, no compilers, no native modules, no network access at
runtime.

## 2. Install

**Package manager: npm** (bundled with Node). `package-lock.json` is committed and the project
declares **no dependencies**, so there is nothing to download — `npm ci` completes without
installing a single package and `node main.js` runs straight from a fresh checkout.

```bash
bash install.sh
```

`install.sh` verifies that Node is at least version 20, creates `data/` if it is missing, prints the
run command, and exits. It runs unprivileged, installs no system packages, and never starts the
server.

## 3. Seed data

The first boot creates `data/db.json` and seeds the
two demo accounts, four teams, twelve members and one share link per team. Seeding is idempotent —
restarting the app only adds anything that is missing, never duplicates.

You can also seed explicitly without starting the server (this exits when done):

```bash
npm run seed        # or: node main.js --seed
```

To start from a clean store, delete the file (stop the server first):

```bash
rm -f data/db.json
```

## 4. Run

```bash
node main.js
```

The server binds `0.0.0.0` and reads `PORT` (default `3000`). It prints:

```
[zonebuddy] listening on http://0.0.0.0:3000
```

Open <http://localhost:3000/> — you are redirected to `/login` (or to `/app` when already signed
in) and can sign in with `cenius@cenius.ai` / `cenius`.

## 5. Configuration (all optional)

Copy `.env.example` to `.env` if you want to override anything; the app reads `.env` itself and
every value has a working default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SESSION_TTL_HOURS` | `168` | Session lifetime (7 days) |
| `ZONEBUDDY_DB` | `data/db.json` | Path to the JSON store (relative to the project root) |
| `COOKIE_SECURE` | `false` | Set to `true` only when serving over HTTPS |

## 6. Verify

```bash
npm test        # API + shell smoke suite
curl -s localhost:3000/health   # -> ok
```

## Troubleshooting

- **`EADDRINUSE`** — something already holds the port; set `PORT` to a free value.
- **A blank page** — check the browser console; the app sets a strict `script-src 'self'` CSP, so a
  proxy that rewrites or injects inline scripts will be blocked.
- **Wrong times in the grid** — the grid always renders in the selected reference zone; switch it
  with the "Reference zone" control at the top of the planner.
