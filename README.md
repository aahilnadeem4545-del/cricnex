# CRICNEX

**CRICNEX** is a cricket management and ball-by-ball scoring system. It is a
complete, working application — not a demo — built around a rules-accurate
scoring engine where the **delivery log is the single source of truth**: every
scorecard, statistic and points table is derived from recorded deliveries and
can always be rebuilt from them.

- **Backend** — Node.js + TypeScript (strict, CommonJS) on Fastify, with Zod
  validation, and SQLite via Node's built-in `node:sqlite` (`DatabaseSync`).
  No native build step, no C toolchain required.
- **Frontend** — a React + Vite single-page app served by the same Fastify
  process, with a dark charcoal / emerald theme, mobile-first scoring and
  desktop admin screens.
- **Offline-first** — a service worker caches the app shell and the last-seen
  data; deliveries scored with no connection are queued locally and replayed
  through the *same* deterministic engine so the scoreboard never lies.

---

## Quick start

```bash
npm install
npm run build          # builds the server (dist/) and the UI (src/ui/dist/)
npm start              # serves the API and UI on http://127.0.0.1:4000
```

Open <http://127.0.0.1:4000>. The first run creates a bootstrap administrator:

## Deploy (free, permanent public link)

**Railway:** push this repo to GitHub, then create a new project from the repo.
Set env vars `CRICNEX_DATA_DIR=/data` and `CRICNEX_BACKUP_DIR=/data/backups`,
and attach a persistent volume at `/data` (SQLite needs it). Railway auto-detects
the `Dockerfile`.

**Render:** connect the repo — it reads `render.yaml` automatically.

**Any VPS / Docker:**
```
docker build -t cricnex .
docker run -p 4000:4000 -v cricnex-data:/data cricnex
```

**Vercel (serverless):**
```
vercel deploy
```
Or connect the repo on https://vercel.com → it reads `vercel.json`.
⚠️ Vercel's filesystem is ephemeral: SQLite data in `/tmp` is reset on cold
starts. For a production scoring app use Railway/Render/Fly.io with a
persistent volume instead. Vercel is fine for demos.

| Username | Password        | Role  |
|----------|-----------------|-------|
| `admin`  | `cricnex-admin` | admin |

Change the password (Settings → Users) after your first sign-in.

### Development

```bash
npm run dev            # API with hot reload (tsx watch) on :4000
npm run dev:ui         # Vite dev server on :5173, proxying /api to :4000
npm test               # full automated test suite
npm run typecheck      # strict typecheck of the server
```

### Environment variables

| Variable             | Default              | Purpose                          |
|----------------------|----------------------|----------------------------------|
| `PORT`               | `4000`               | HTTP port                        |
| `HOST`               | `127.0.0.1`          | Bind address                     |
| `CRICNEX_DB`         | `data/cricnex.db`    | SQLite database file             |
| `CRICNEX_DATA_DIR`   | `data/`              | Directory for the database       |
| `CRICNEX_BACKUP_DIR` | `backups/`           | Directory for backups            |
| `CRICNEX_UI_DIR`     | `src/ui/dist`        | Static UI assets                 |
| `CRICNEX_LOG`        | `0`                  | `1` enables Fastify request logs |

See [`docs/setup.md`](docs/setup.md) for the full guide, and
[`docs/testing-report.md`](docs/testing-report.md) for what is tested and how.

---

## What it does

### Scoring engine (`src/domain/`)
A pure, deterministic reducer over an innings state. Given the same starting
state and delivery input it always produces the same output, which is what makes
undo, correction and crash recovery safe.

- Runs, boundaries, extras (wides, no-balls, byes, leg byes, penalty runs)
- Strike rotation, over completion, maidens, powerplay tracking
- Dismissals: bowled, caught, lbw, run out, stumped, hit wicket, hit ball twice,
  obstructing the field, timed out, retired out / hurt
- Free hits, follow-on detection, multi-innings (Test) matches
- Result engine: wins by runs/wickets/innings, ties, draws, abandonment, and an
  explicit **"DLS not available"** result — revised targets are never invented

### Data (`src/db/`)
Append-only `deliveries` table plus transactional derived tables
(`batting_scorecards`, `bowling_figures`, `fall_of_wickets`, `partnerships`,
`innings_state_cache`). The state cache is a *pure projection*; if it is ever
missing or stale it is transparently rebuilt from the delivery log. Schema and
indexes live in `src/db/schema.ts`.

### Services (`src/services/`)
Auth & RBAC, catalog (teams/players), the match wizard, scoring (with undo and
mid-innings correction), statistics, tournaments (round-robin fixtures, points
table and NRR), backups (`VACUUM INTO`), and offline sync (idempotent outbox).

### API (`src/api/app.ts`)
A documented REST surface covering auth, users, teams, players, matches,
innings/scoring, tournaments, statistics, sync, backups and health, with role
enforcement (admin / scorer / viewer) and a single error handler.

### UI (`src/ui/`)
Home dashboard, match centre, create-match wizard, live scoring pad, scorecards
with SVG charts (Manhattan, run-rate, wagon wheel) drawn from real delivery
data, teams, players, tournaments, statistics and settings.

---

## Principles

- **No fake functionality.** No placeholder buttons, hardcoded scoreboards or
  simulated persistence. Every screen is wired to the real API and database.
- **One source of truth.** Deliveries are authoritative; derived data is
  recomputable and self-healing.
- **Honest about limits.** DLS returns "not available" rather than guessing.

## License

Private / unpublished.
