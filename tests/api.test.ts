import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../src/db/database';
import { buildApp } from '../src/api/app';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end HTTP contract test. It boots the real Fastify app against an
 * in-memory database and drives the API exactly as the UI does, so route-level
 * regressions (missing columns, broken joins, wrong payload shapes) surface here
 * rather than in the browser.
 */

let db: Db;
let app: FastifyInstance;
let backupDir: string;
let token = '';
let viewerToken = '';

interface Res { statusCode: number; body: any }

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth = token): Promise<Res> {
  const res = await app.inject({
    method, url,
    payload: payload as never,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
  let body: unknown = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { statusCode: res.statusCode, body };
}

function ok(res: Res, label: string): any {
  assert.equal(res.statusCode, 200, `${label} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
  return res.body;
}

const created: Record<string, string> = {};

describe('HTTP API', () => {
  before(async () => {
    db = openDatabase(':memory:');
    backupDir = mkdtempSync(join(tmpdir(), 'cricnex-api-'));
    app = buildApp({ db, backupDir, logger: false });
    await app.ready();

    const login = ok(await api('POST', '/api/auth/login', { username: 'admin', password: 'cricnex-admin' }, ''), 'admin login');
    token = login.token;
    assert.ok(login.user, 'login returns the user');
    assert.equal(login.user.role, 'admin');

    const viewer = ok(await api('POST', '/api/users', { username: 'watcher', password: 'watcher-pass-1', displayName: 'Watcher', role: 'viewer' }), 'create viewer');
    assert.equal(viewer.user.role, 'viewer');
    const viewerLogin = ok(await api('POST', '/api/auth/login', { username: 'watcher', password: 'watcher-pass-1' }, ''), 'viewer login');
    viewerToken = viewerLogin.token;
  });

  after(async () => {
    await app.close();
    db.close();
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('rejects bad credentials and unauthenticated access', async () => {
    const bad = await api('POST', '/api/auth/login', { username: 'admin', password: 'wrong' }, '');
    assert.equal(bad.statusCode, 401);
    const anon = await api('GET', '/api/dashboard', undefined, '');
    assert.equal(anon.statusCode, 401);
  });

  it('enforces role based access control', async () => {
    // Viewer may read but not write.
    assert.equal((await api('GET', '/api/teams', undefined, viewerToken)).statusCode, 200);
    assert.equal((await api('POST', '/api/teams', { name: 'Nope FC' }, viewerToken)).statusCode, 403);
    // Admin-only surface.
    assert.equal((await api('GET', '/api/users', undefined, viewerToken)).statusCode, 403);
    assert.equal((await api('GET', '/api/users')).statusCode, 200);
    assert.equal((await api('GET', '/api/system/health', undefined, '')).statusCode, 200);
  });

  it('validates payloads', async () => {
    const bad = await api('POST', '/api/teams', { name: '' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, 'VALIDATION');
    const missing = await api('GET', '/api/teams/does-not-exist');
    assert.equal(missing.statusCode, 404);
  });

  it('runs a full match lifecycle through the API', async () => {
    const teamA = ok(await api('POST', '/api/teams', { name: 'Alpha', shortName: 'ALP' }), 'create team A').team.id;
    const teamB = ok(await api('POST', '/api/teams', { name: 'Bravo', shortName: 'BRV' }), 'create team B').team.id;
    created.teamA = teamA; created.teamB = teamB;

    const playersA: string[] = [];
    const playersB: string[] = [];
    for (let i = 0; i < 11; i++) {
      playersA.push(ok(await api('POST', '/api/players', { fullName: `Alpha ${i + 1}`, primaryTeamId: teamA }), 'create A player').player.id);
      playersB.push(ok(await api('POST', '/api/players', { fullName: `Bravo ${i + 1}`, primaryTeamId: teamB }), 'create B player').player.id);
    }
    created.playerA = playersA[0]; created.playerB = playersB[0];

    // Team detail should include the squad members we just created.
    const teamDetail = ok(await api('GET', `/api/teams/${teamA}`), 'team detail');
    assert.equal(teamDetail.team.players.length, 11);

    const match = ok(await api('POST', '/api/matches', {
      title: 'API Match', format: 'T20', venue: 'API Ground',
      teamAId: teamA, teamBId: teamB,
      squads: {
        teamA: playersA.map((p, i) => ({ playerId: p, inPlayingXI: true, isCaptain: i === 0, isWicketkeeper: i === 1 })),
        teamB: playersB.map((p, i) => ({ playerId: p, inPlayingXI: true, isCaptain: i === 0, isWicketkeeper: i === 1 })),
      },
      toss: { winnerTeamId: teamA, decision: 'BAT' },
    }), 'create match').match;
    created.match = match.id;
    assert.equal(match.status, 'TOSS');

    assert.equal(ok(await api('GET', `/api/matches/${match.id}/validate`), 'validate').ok, true);

    const innings = ok(await api('POST', `/api/matches/${match.id}/innings`, { battingTeamId: teamA }), 'start innings').innings;
    created.innings = innings.id;

    ok(await api('POST', `/api/innings/${innings.id}/openers`, { strikerId: playersA[0], nonStrikerId: playersA[1], bowlerId: playersB[0] }), 'set openers');

    // Track the live striker/non-striker from the engine rather than guessing.
    let striker = playersA[0];
    let nonStriker = playersA[1];
    let bowler = playersB[0];
    let key = 0;
    const ball = async (partial: Record<string, unknown>): Promise<any> => {
      const res = ok(await api('POST', `/api/innings/${innings.id}/deliveries`, {
        idempotencyKey: `api-${++key}`, strikerId: striker, nonStrikerId: nonStriker, bowlerId: bowler,
        batterRuns: 0, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, ...partial,
      }), `ball ${key}`);
      striker = res.state.strikerId;
      nonStriker = res.state.nonStrikerId;
      return res.state;
    };

    // Over with runs, a wide, a no-ball, a wicket, then a second over.
    await ball({ batterRuns: 4 });
    await ball({ batterRuns: 1 });
    await ball({ wides: 1 });
    await ball({ noBall: 1, batterRuns: 2 });
    await ball({ batterRuns: 6 });
    const afterWicket = await ball({ dismissal: { type: 'BOWLED', batterId: striker }, nextBatterId: playersA[2] });
    assert.equal(afterWicket.wickets, 1, 'wicket recorded');
    await ball({ batterRuns: 0 });
    const endOfOver = await ball({ batterRuns: 0 });
    assert.equal(endOfOver.legalBalls, 6, 'first over complete');

    // Second over must be bowled by a different bowler.
    bowler = playersB[1];
    await ball({ batterRuns: 1 });

    const score = ok(await api('GET', `/api/matches/${match.id}/live`), 'live scoreboard').live;
    assert.ok(score, 'live scoreboard present');

    const state = ok(await api('GET', `/api/innings/${innings.id}`), 'innings').state;
    assert.equal(state.runs, 4 + 1 + 1 + 3 + 6 + 0 + 0 + 0 + 1);
    assert.equal(state.wickets, 1);
    assert.equal(state.legalBalls, 7);

    // Idempotency: replaying the same key must not double count.
    const replay = await api('POST', `/api/innings/${innings.id}/deliveries`, {
      idempotencyKey: 'api-1', strikerId: playersA[0], nonStrikerId: playersA[1], bowlerId: playersB[0], batterRuns: 4,
    });
    assert.equal(replay.body.duplicate, true);

    // Undo the last ball and confirm the projection moves back.
    const undone = ok(await api('POST', `/api/innings/${innings.id}/undo`, { reason: 'test undo' }), 'undo').state;
    assert.equal(undone.legalBalls, 6);
    striker = undone.strikerId;
    nonStriker = undone.nonStrikerId;

    // Correction: re-record the undone ball as a single.
    await ball({ batterRuns: 1 });

    const card = ok(await api('GET', `/api/innings/${innings.id}/scorecard`), 'scorecard').scorecard;
    assert.ok(Array.isArray(card.batting) && card.batting.length > 0, 'batting card present');
    assert.ok(Array.isArray(card.bowling) && card.bowling.length > 0, 'bowling card present');

    ok(await api('POST', `/api/matches/${match.id}/finalize`), 'finalize');
  });

  it('serves every read endpoint without a server error', async () => {
    const urls = [
      '/api/auth/me', '/api/users', '/api/teams', `/api/teams/${created.teamA}`,
      `/api/teams/${created.teamA}/head-to-head/${created.teamB}`,
      '/api/players', `/api/players/${created.playerA}`, '/api/formats',
      '/api/matches', `/api/matches/${created.match}`, `/api/matches/${created.match}/live`,
      `/api/matches/${created.match}/stats`, `/api/matches/${created.match}/validate`,
      `/api/innings/${created.innings}`, `/api/innings/${created.innings}/scorecard`,
      `/api/innings/${created.innings}/statistics`, `/api/innings/${created.innings}/deliveries`,
      '/api/tournaments', '/api/stats/leaderboards', '/api/dashboard',
      '/api/sync/status', '/api/backups', '/api/settings', '/api/system/health',
    ];
    for (const url of urls) {
      const res = await api('GET', url);
      assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    ok(await api('POST', '/api/stats/recompute'), 'recompute stats');
  });

  it('supports tournaments, fixtures and points tables', async () => {
    const tournament = ok(await api('POST', '/api/tournaments', { name: 'API Cup', format: 'T20' }), 'create tournament').tournament;
    created.tournament = tournament.id;
    ok(await api('POST', `/api/tournaments/${tournament.id}/teams`, { teamIds: [created.teamA, created.teamB] }), 'add teams');

    const fixtures = ok(await api('POST', `/api/tournaments/${tournament.id}/fixtures/generate`, {}), 'generate fixtures').fixtures;
    assert.equal(fixtures.length, 1, 'round robin of two teams is one fixture');

    const points = ok(await api('POST', `/api/tournaments/${tournament.id}/recompute`, {}), 'recompute points').pointsTable;
    assert.ok(Array.isArray(points), 'points table is an array');

    ok(await api('GET', `/api/tournaments/${tournament.id}`), 'tournament detail');
    ok(await api('GET', `/api/tournaments/${tournament.id}/leaderboards`), 'tournament leaderboards');
  });

  it('records sync events and creates backups', async () => {
    const push = ok(await api('POST', '/api/sync/push', {
      deviceId: 'api-test',
      events: [{ id: 'evt-1', entity_type: 'match', entity_id: created.match, op: 'upsert', payload_json: '{"status":"LIVE"}' }],
    }), 'sync push');
    assert.equal(push.applied, 1);
    // Replaying the same event id is idempotent.
    const replay = ok(await api('POST', '/api/sync/push', {
      deviceId: 'api-test',
      events: [{ id: 'evt-1', entity_type: 'match', entity_id: created.match, op: 'upsert', payload_json: '{"status":"LIVE"}' }],
    }), 'sync replay');
    assert.equal(replay.applied, 0);
    assert.equal(replay.duplicates, 1);

    const backup = ok(await api('POST', '/api/backups', { keep: 5 }), 'create backup');
    assert.ok(backup.backup, 'backup metadata returned');
    const listed = ok(await api('GET', '/api/backups'), 'list backups');
    assert.ok(listed.backups.length >= 1, 'backup appears in listing');
  });
});
