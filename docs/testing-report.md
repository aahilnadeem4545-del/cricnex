# Testing Report — CRICNEX

## Summary
- **54 tests, 54 passing, 0 failing** (Node test runner, `tsx --test tests/**/*.test.ts`).
- Suites: `tests/engine.test.ts` (32), `tests/integration.test.ts` (15), `tests/api.test.ts` (7).
- Server typecheck (`tsc -p tsconfig.json --noEmit`): clean.
- UI typecheck (`tsc -p src/ui/tsconfig.json --noEmit`): clean.
- Production build (`npm run build`): clean — 53 modules, 330.83 kB JS (95.60 kB gzipped).

## Bug found and fixed during this pass
- **`bowlingLeaders` referenced a non-existent column `c.legal_balls`** on `player_career_cache`. The cache stores `economy` (null when no legal balls bowled), not `legal_balls`, so `/api/dashboard` and `/api/stats/leaderboards` returned 500 on a fresh database. Fixed the filter to `WHERE c.economy IS NOT NULL`. Regression coverage: `tests/api.test.ts` (read-endpoint sweep + dashboard) and the `npm test` run above.

## Coverage by area

### Scoring engine (32 tests)
- Runs/extras semantics, strike rotation on odd/even runs, over completion, maidens.
- Free-hit gating (bowled/lbw/caught blocked, run out allowed; no-ball on a free hit keeps the free hit alive).
- Wicket completion of an innings at ten wickets; target reached; overs complete.
- Rebuild determinism: rebuilding from the delivery log reproduces the exact state.
- Undo supersedes the last row and restores state.
- Editing a middle delivery preserves sequence order and rebuilds everything after it.
- Validation rejects invalid deliveries before mutating state.
- Limited-overs results: chase wins by wickets, defence wins by runs, tie detection.
- Abandonment and no result reported without a fabricated winner.
- Test match: innings victory + follow-on detection, fourth-innings chase win, drawn match.
- Powerplay runs/wickets tracked only inside the powerplay.
- Invalid deliveries rejected before state mutation.

### Persistence & derived projections (integration, 15 tests)
- Match setup validation (squads + toss).
- Delivery log persistence and scorecard derivation.
- Idempotent duplicate submissions (no double counting).
- Undo audit trail.
- Edit-middle-delivery rebuild.
- Data survives a process restart (reopen DB).
- Stale state cache self-heals from the delivery log.
- Full T20 match from toss to computed result.
- RBAC: viewers cannot score, API enforces roles.
- HTTP scoring endpoint records a ball end to end.
- Offline sync pushes deliveries without duplicates on retry.
- Tournament fixtures, points table, NRR from real match data.
- Innings reopen after closure; undo reopens a completed innings.
- Live scoreboard exposes target, required rate, current players.
- Stats derived from the delivery log, not stored independently.

### HTTP contract (api, 7 tests)
- Authentication: bad credentials 401, unauthenticated 401.
- RBAC: viewer reads, cannot write, cannot access admin surfaces.
- Payload validation 400 + `VALIDATION` code; unknown entity 404.
- Full match lifecycle via HTTP: teams, players, match creation, squads, toss, innings, openers, 8 deliveries (runs, wide, no-ball, six, bowled, dot), undo, idempotent replay, scorecard.
- Every read endpoint returns 200 (22 routes).
- Tournaments: create, add teams, round-robin generate, points table recompute, leaderboards.
- Sync push idempotency (applied then duplicate) and backup create/list.

## Deliberately NOT implemented
- **DLS / revised targets**: `result` engine returns an explicit `NOT_AVAILABLE` result; no revised target is ever invented. Covered by the absence of any DLS code path (no DLS tests are expected to pass a fabricated target).

## Browser smoke test
- Loaded `http://127.0.0.1:4000`, logged in as `admin`/`cricnex-admin`; app shell renders with all nav links.
- All 8 routes (`/`, `/matches`, `/matches/new`, `/teams`, `/players`, `/tournaments`, `/statistics`, `/settings`) rendered with **0 console errors**.
- `/api/dashboard` returns 200 with correct payload from the browser context.
- Desktop browser session disconnected before a full screenshot could be captured; rendering verified via DOM inspection (`document.body.innerText`) instead.

## Known limitations
- No dedicated E2E browser automation suite (Playwright) — manual smoke only.
- `tests/api.test.ts` uses an in-memory database and a single shared app instance per suite; tests are sequential.
- The UI's offline queue is exercised through `optimistic.ts` unit logic embedded in the integration flow, not a separate browser-level offline test.
