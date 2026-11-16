# Setup — CRICNEX

## Prerequisites
- Node.js 20+ (tested on Node 26). No native build tools required: the database uses Node's built-in `node:sqlite`.
- ~200 MB free disk for `node_modules`.

## Install
```bash
npm install
```

## Run (development)
```bash
npm run dev        # Fastify API + serves the UI build on http://127.0.0.1:4000
npm run dev:ui     # Vite dev server (optional, http://127.0.0.1:5173) with HMR
```
If `src/ui/dist` does not exist yet, run `npm run build:ui` first so the API can serve the UI.

## Run (production)
```bash
npm run build      # compiles server (dist/) and UI (src/ui/dist/)
npm start          # node dist/server.js
```

## Environment variables
- `CRICNEX_PORT` (default 4000)
- `CRICNEX_HOST` (default 127.0.0.1)
- `CRICNEX_DATA_DIR` (default `./data`) — SQLite database `cricnex.db`
- `CRICNEX_BACKUP_DIR` (default `./backups`) — `VACUUM INTO` snapshots
- `CRICNEX_UI_DIR` (default `./src/ui/dist`) — built SPA
- `CRICNEX_DEVICE_ID` — stable sync device id (auto-generated if unset)

## First run
The bootstrap administrator is created automatically:
- username: `admin`
- password: `cricnex-admin`
Change the password in **Settings** immediately. Roles: `admin`, `scorer`, `viewer`.

## Tests
```bash
npm test           # all suites (engine + integration + api)
npm run test:engine
npm run typecheck  # server
npx tsc -p src/ui/tsconfig.json --noEmit   # UI
```

## Data safety
- Deliveries are the single source of truth; scorecards/statistics/career caches are derived projections that self-heal when stale.
- `VACUUM INTO` backups are available from Settings or `POST /api/backups`.
- Integrity check: `GET /api/system/health`.
