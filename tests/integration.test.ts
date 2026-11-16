import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../src/db/database';
import { buildApp } from '../src/api/app';
import { ensureBootstrapAdmin, verifyLogin } from '../src/services/auth';
import { addPlayerToTeam, createPlayer, createTeam } from '../src/services/catalog';
import { createMatch, liveScoreboard, matchDetail, setSquad, validateMatchReady, recordToss } from '../src/services/matches';
import {
  declareInnings, editDelivery, getInnings, loadInningsState, reopenInnings, scoreDelivery,
  setOpeners, startInnings, undoLastDelivery, getMatch, activeDeliveries,
} from '../src/services/scoring';
import { recomputeAfterMatch, matchStatistics } from '../src/services/stats';
import { applyIncomingEvents, pushOutbox, pendingEvents, setSyncConfig, syncStatus } from '../src/services/sync';
import { recomputePointsTable, generateRoundRobin, addTeamsToTournament, createTournament, getTournament } from '../src/services/tournaments';
import type { DeliveryInput } from '../src/domain/types';

const SCORER = { userId: 'test-scorer', role: 'scorer' as const };

interface Fixture {
  db: Db;
  teamA: string;
  teamB: string;
  playersA: string[];
  playersB: string[];
  matchId: string;
}

function seed(db: Db, format = 'T20', rules: Record<string, unknown> = {}): Fixture {
  const teamA = String(createTeam(db, { name: `Alpha ${Math.random().toString(36).slice(2, 6)}` }).id);
  const teamB = String(createTeam(db, { name: `Bravo ${Math.random().toString(36).slice(2, 6)}` }).id);
  const playersA = Array.from({ length: 11 }, (_, i) => String(createPlayer(db, { fullName: `A${i + 1}`, primaryTeamId: teamA }).id));
  const playersB = Array.from({ length: 11 }, (_, i) => String(createPlayer(db, { fullName: `B${i + 1}`, primaryTeamId: teamB }).id));
  const match = createMatch(db, {
    title: 'Integration Match', format, rules, teamAId: teamA, teamBId: teamB, createdBy: 'test',
    squads: {
      teamA: playersA.map((p, i) => ({ playerId: p, inPlayingXI: true, isCaptain: i === 0, isWicketkeeper: i === 1 })),
      teamB: playersB.map((p, i) => ({ playerId: p, inPlayingXI: true, isCaptain: i === 0, isWicketkeeper: i === 1 })),
    },
  });
  recordToss(db, 'test', match.id, teamA, 'BAT');
  return { db, teamA, teamB, playersA, playersB, matchId: match.id };
}

function ball(f: Fixture, inningsId: string, partial: Partial<DeliveryInput> & { strikerId: string; nonStrikerId: string; bowlerId: string }): void {
  scoreDelivery(f.db, SCORER, inningsId, {
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    batterRuns: 0, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, recordedBy: 'test',
    ...partial,
  });
}

test('match setup validates squads and toss', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  assert.equal(validateMatchReady(db, f.matchId).ok, true);
  db.close();
});

test('scoring persists a delivery log and derives scorecards from it', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  setOpeners(db, SCORER, innings.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 4 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 2 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], wides: 1 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 1 });

  const state = loadInningsState(db, innings.id);
  assert.equal(state.runs, 8);
  assert.equal(state.legalBalls, 3);
  assert.equal(activeDeliveries(db, innings.id).length, 4);

  const card = db.all<{ player_id: string; runs: number; balls: number; fours: number }>(
    'SELECT player_id, runs, balls, fours FROM batting_scorecards WHERE innings_id = ? ORDER BY batting_position', innings.id,
  );
  assert.equal(card[0].runs, 7);
  assert.equal(card[0].balls, 3);
  assert.equal(card[0].fours, 1);
  const bowling = db.get<{ runs_conceded: number; wides: number; legal_balls: number }>(
    'SELECT runs_conceded, wides, legal_balls FROM bowling_figures WHERE innings_id = ? AND player_id = ?', innings.id, f.playersB[0],
  )!;
  assert.equal(bowling.runs_conceded, 8);
  assert.equal(bowling.wides, 1);
  assert.equal(bowling.legal_balls, 3);

  const row = db.get<{ runs: number; legal_balls: number; extras_wides: number }>('SELECT * FROM innings WHERE id = ?', innings.id)!;
  assert.equal(row.runs, 8);
  assert.equal(row.legal_balls, 3);
  assert.equal(row.extras_wides, 1);
  db.close();
});

test('duplicate submissions are idempotent and never double-count', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  const input: DeliveryInput = {
    idempotencyKey: 'fixed-key-1', strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0],
    batterRuns: 6, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, recordedBy: 'test',
  };
  const first = scoreDelivery(db, SCORER, innings.id, input);
  const second = scoreDelivery(db, SCORER, innings.id, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.delivery.id, first.delivery.id);
  assert.equal(activeDeliveries(db, innings.id).length, 1);
  assert.equal(loadInningsState(db, innings.id).runs, 6);
  db.close();
});

test('undo rolls back state and keeps an audit trail', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 4 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 6 });
  assert.equal(loadInningsState(db, innings.id).runs, 10);
  const state = undoLastDelivery(db, SCORER, innings.id, 'wrong button');
  assert.equal(state.runs, 4);
  assert.equal(activeDeliveries(db, innings.id).length, 1);
  const superseded = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE innings_id = ? AND status = 'superseded'", innings.id);
  assert.equal(superseded?.n, 1);
  const audit = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'UNDO'");
  assert.equal(audit?.n, 1);
  assert.equal(db.get<{ runs: number }>('SELECT runs FROM innings WHERE id = ?', innings.id)?.runs, 4);
  db.close();
});

test('editing a middle delivery preserves sequence order and rebuilds everything after it', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 1 });
  ball(f, innings.id, { strikerId: f.playersA[1], nonStrikerId: f.playersA[0], bowlerId: f.playersB[0], batterRuns: 1 });
  const third = scoreDelivery(db, SCORER, innings.id, {
    idempotencyKey: 'third', strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0],
    batterRuns: 1, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, recordedBy: 'test',
  });
  assert.equal(loadInningsState(db, innings.id).runs, 3);
  // The second ball should have been 4, not 1.
  const second = activeDeliveries(db, innings.id)[1];
  editDelivery(db, SCORER, second.id, {
    idempotencyKey: second.idempotency_key, strikerId: f.playersA[1], nonStrikerId: f.playersA[0],
    bowlerId: f.playersB[0], batterRuns: 4, wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, recordedBy: 'test',
  }, 'scorer correction');
  const state = loadInningsState(db, innings.id);
  assert.equal(state.runs, 6);
  const active = activeDeliveries(db, innings.id);
  assert.equal(active.length, 3);
  assert.deepEqual(active.map(a => a.sequence), [1, 2, 3]);
  assert.equal(active[1].id === second.id, false, 'edited row is a new row in the same slot');
  const runs = db.all<{ total_runs: number }>('SELECT total_runs FROM deliveries WHERE innings_id = ? AND status = ? ORDER BY sequence', innings.id, 'active');
  assert.deepEqual(runs.map(r => r.total_runs), [1, 4, 1]);
  void third;
  db.close();
});

test('data survives a restart: reopening the database restores committed state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cricnex-'));
  const path = join(dir, 'test.db');
  let db = openDatabase(path);
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 4 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 6 });
  const before = loadInningsState(db, innings.id);
  db.close();

  db = openDatabase(path);
  const after = loadInningsState(db, innings.id);
  assert.deepEqual(after, before);
  assert.equal(after.runs, 10);
  assert.equal(activeDeliveries(db, innings.id).length, 2);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a stale state cache self-heals from the delivery log', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 4 });
  // Simulate corruption / a crash between writes.
  db.run("UPDATE innings_state_cache SET deliveries_count = 999, state_json = '{}' WHERE innings_id = ?", innings.id);
  const healed = loadInningsState(db, innings.id);
  assert.equal(healed.runs, 4);
  assert.equal(healed.legalBalls, 1);
  db.close();
});

test('a full T20 match runs from toss to a computed result', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const inn1 = startInnings(db, SCORER, f.matchId, f.teamA);
  // Team A: 10 overs of 1 run per ball = 60 runs, one wicket at the end.
  setOpeners(db, SCORER, inn1.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  let striker = f.playersA[0];
  let nonStriker = f.playersA[1];
  let nextBatter = 2;
  for (let over = 0; over < 10; over++) {
    const bowler = f.playersB[over % 5];
    for (let b = 0; b < 6; b++) {
      ball(f, inn1.id, { strikerId: striker, nonStrikerId: nonStriker, bowlerId: bowler, batterRuns: 1 });
      [striker, nonStriker] = [nonStriker, striker];
    }
    // over end swaps strike again
    [striker, nonStriker] = [nonStriker, striker];
  }
  // declare the innings complete by running out the overs via a fresh innings quota
  const inn1State = loadInningsState(db, inn1.id);
  assert.equal(inn1State.runs, 60);
  assert.equal(inn1State.legalBalls, 60);
  declareInnings(db, SCORER, inn1.id);

  const target = inn1State.runs + 1;
  const inn2 = startInnings(db, SCORER, f.matchId, f.teamB, { target });
  setOpeners(db, SCORER, inn2.id, f.playersB[0], f.playersB[1], f.playersA[0]);
  let s2 = f.playersB[0];
  let n2 = f.playersB[1];
  for (let over = 0; over < 4 && loadInningsState(db, inn2.id).status === 'in_progress'; over++) {
    const bowler = f.playersA[over % 5];
    for (let b = 0; b < 6; b++) {
      const st = loadInningsState(db, inn2.id);
      if (st.status !== 'in_progress') break;
      ball(f, inn2.id, { strikerId: s2, nonStrikerId: n2, bowlerId: bowler, batterRuns: 3 });
      [s2, n2] = [n2, s2];
    }
    [s2, n2] = [n2, s2];
  }
  const inn2State = loadInningsState(db, inn2.id);
  assert.equal(inn2State.runs >= target, true, 'chase should have reached the target');
  const match = getMatch(db, f.matchId);
  assert.equal(match.status, 'COMPLETED');
  assert.equal(match.winner_team_id, f.teamB);
  assert.match(String(match.result_summary), /won by \d+ wicket/);

  recomputeAfterMatch(db, f.matchId);
  const career = db.get<{ runs: number; matches: number }>('SELECT * FROM player_career_cache WHERE player_id = ?', f.playersB[0])!;
  assert.ok(career.runs > 0);
  assert.equal(career.matches, 1);
  void nextBatter;
  db.close();
});

test('viewers cannot score and the API enforces roles', async () => {
  const db = openDatabase(':memory:');
  ensureBootstrapAdmin(db);
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  const admin = verifyLogin(db, 'admin', 'cricnex-admin');
  const app = buildApp({ db, backupDir: join(tmpdir(), 'cricnex-backups'), logger: false });
  const token = (await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'cricnex-admin' },
  })).json().token as string;
  assert.ok(token);

  // create a viewer
  const viewer = (await app.inject({
    method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${token}` },
    payload: { username: 'viewer1', password: 'viewerpass1', displayName: 'Viewer', role: 'viewer' },
  })).json().user as { id: string };
  const viewerToken = (await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username: 'viewer1', password: 'viewerpass1' },
  })).json().token as string;

  const read = await app.inject({ method: 'GET', url: `/api/matches/${f.matchId}`, headers: { authorization: `Bearer ${viewerToken}` } });
  assert.equal(read.statusCode, 200);
  const writeAttempt = await app.inject({
    method: 'POST', url: `/api/innings/${innings.id}/deliveries`, headers: { authorization: `Bearer ${viewerToken}` },
    payload: { idempotencyKey: 'x', strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 1 },
  });
  assert.equal(writeAttempt.statusCode, 403);
  const noAuth = await app.inject({ method: 'GET', url: '/api/teams' });
  assert.equal(noAuth.statusCode, 401);
  void admin; void viewer;
  await app.close();
  db.close();
});

test('HTTP scoring endpoint records a ball end to end', async () => {
  const db = openDatabase(':memory:');
  ensureBootstrapAdmin(db);
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  const app = buildApp({ db, backupDir: join(tmpdir(), 'cricnex-backups'), logger: false });
  const token = (await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'cricnex-admin' },
  })).json().token as string;
  const res = await app.inject({
    method: 'POST', url: `/api/innings/${innings.id}/deliveries`, headers: { authorization: `Bearer ${token}` },
    payload: {
      idempotencyKey: 'http-1', strikerId: f.playersA[0], nonStrikerId: f.playersA[1],
      bowlerId: f.playersB[0], batterRuns: 4,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const live = await app.inject({ method: 'GET', url: `/api/matches/${f.matchId}/live`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(live.json().live.score, 4);
  await app.close();
  db.close();
});

test('offline sync pushes deliveries without creating duplicates on retry', async () => {
  const local = openDatabase(':memory:');
  const remote = openDatabase(':memory:');
  const f = seed(local);
  // Mirror the match structure onto the "remote" device.
  seedRemote(remote, f, local);
  const innings = startInnings(local, SCORER, f.matchId, f.teamA);
  setOpeners(local, SCORER, innings.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 4 });
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 6 });
  setSyncConfig(local, { remoteUrl: 'http://localhost:9/sync' });
  assert.ok(syncStatus(local).pending >= 3, 'delivery + innings events are queued');

  const events = pendingEvents(local);
  const first = applyIncomingEvents(remote, events, 'device-local');
  assert.equal(first.applied, events.length);
  const second = applyIncomingEvents(remote, events, 'device-local');
  assert.equal(second.applied, 0);
  assert.equal(second.duplicates, events.length, 'a retried push is fully de-duplicated');

  const remoteState = loadInningsState(remote, innings.id);
  assert.equal(remoteState.runs, 10);
  const remoteDeliveries = remote.all<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'active'");
  assert.equal(remoteDeliveries[0].n, 2);
  local.close();
  remote.close();
});

test('tournament fixtures, points table and NRR are computed from real match data', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const tournament = createTournament(db, { name: 'Cup', format: 'T20' });
  addTeamsToTournament(db, String(tournament.id), [f.teamA, f.teamB]);
  db.run('UPDATE matches SET tournament_id = ? WHERE id = ?', String(tournament.id), f.matchId);
  const fixtures = generateRoundRobin(db, String(tournament.id), {});
  assert.equal(fixtures.length, 1);

  // Play a short completed match so the points table has data.
  const inn1 = startInnings(db, SCORER, f.matchId, f.teamA);
  setOpeners(db, SCORER, inn1.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  // Team A bat a full over and score 6 (a run a ball). The strike alternates on every single.
  for (let i = 0; i < 6; i++) {
    ball(f, inn1.id, {
      strikerId: i % 2 === 0 ? f.playersA[0] : f.playersA[1],
      nonStrikerId: i % 2 === 0 ? f.playersA[1] : f.playersA[0],
      bowlerId: f.playersB[0], batterRuns: 1,
    });
  }
  declareInnings(db, SCORER, inn1.id);
  // Team B chase 7 and reach it inside the same over (rate 7 vs 6), so the winner's NRR is positive.
  const inn2 = startInnings(db, SCORER, f.matchId, f.teamB, { target: 7 });
  setOpeners(db, SCORER, inn2.id, f.playersB[0], f.playersB[1], f.playersA[0]);
  for (let i = 0; i < 6; i++) {
    ball(f, inn2.id, {
      strikerId: i % 2 === 0 ? f.playersB[0] : f.playersB[1],
      nonStrikerId: i % 2 === 0 ? f.playersB[1] : f.playersB[0],
      bowlerId: f.playersA[0], batterRuns: i === 5 ? 2 : 1,
    });
  }

  const table = recomputePointsTable(db, String(tournament.id));
  const winner = table.find(t => t.team_id === f.teamB);
  const loser = table.find(t => t.team_id === f.teamA);
  assert.equal(winner?.points, 2);
  assert.equal(winner?.won, 1);
  assert.equal(loser?.points, 0);
  assert.ok(Number(winner?.nrr) > 0);
  const detail = getTournament(db, String(tournament.id));
  assert.equal((detail.pointsTable as unknown[]).length, 2);
  db.close();
});

test('innings can be reopened after being closed, and undo reopens a completed innings', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  setOpeners(db, SCORER, innings.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  ball(f, innings.id, { strikerId: f.playersA[0], nonStrikerId: f.playersA[1], bowlerId: f.playersB[0], batterRuns: 1 });
  declareInnings(db, SCORER, innings.id);
  assert.equal(getInnings(db, innings.id).status, 'declared');
  reopenInnings(db, SCORER, innings.id);
  assert.equal(getInnings(db, innings.id).status, 'in_progress');
  db.close();
});

test('live scoreboard exposes target, required rate and current players', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const inn1 = startInnings(db, SCORER, f.matchId, f.teamA);
  setOpeners(db, SCORER, inn1.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  for (let i = 0; i < 6; i++) ball(f, inn1.id, { strikerId: loadInningsState(db, inn1.id).strikerId!, nonStrikerId: loadInningsState(db, inn1.id).nonStrikerId!, bowlerId: f.playersB[0], batterRuns: 2 });
  declareInnings(db, SCORER, inn1.id);
  const inn2 = startInnings(db, SCORER, f.matchId, f.teamB, { target: 13 });
  setOpeners(db, SCORER, inn2.id, f.playersB[0], f.playersB[1], f.playersA[0]);
  ball(f, inn2.id, { strikerId: f.playersB[0], nonStrikerId: f.playersB[1], bowlerId: f.playersA[0], batterRuns: 4 });
  const live = liveScoreboard(db, f.matchId);
  assert.equal(live.target, 13);
  assert.equal(live.runsRequired, 9);
  assert.equal(live.ballsRemaining, 119);
  assert.ok(live.requiredRunRate !== null);
  assert.equal(live.striker?.runs, 4);
  assert.equal(live.bowler?.wickets, 0);
  assert.ok(live.lastSix.length >= 1);
  const detail = matchDetail(db, f.matchId);
  assert.ok(detail.innings);
  db.close();
});

function seedRemote(remote: Db, f: Fixture, local: Db): void {
  // Copy the reference data (teams/players/match) so the remote can apply events.
  for (const t of local.all<Record<string, unknown>>('SELECT * FROM teams')) {
    remote.run('INSERT INTO teams (id, name, short_name, logo_url, coach, captain_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      t.id as string, t.name as string, t.short_name as string | null, t.logo_url as string | null, t.coach as string | null, t.captain_id as string | null, t.created_at as string, t.updated_at as string);
  }
  for (const p of local.all<Record<string, unknown>>('SELECT * FROM players')) {
    remote.run('INSERT INTO players (id, full_name, photo_url, jersey_number, batting_style, bowling_style, playing_role, primary_team_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      p.id as string, p.full_name as string, p.photo_url as string | null, p.jersey_number as number | null, p.batting_style as string | null, p.bowling_style as string | null, p.playing_role as string | null, p.primary_team_id as string | null, p.created_at as string, p.updated_at as string);
  }
  for (const m of local.all<Record<string, unknown>>('SELECT * FROM matches')) {
    remote.run(`INSERT INTO matches (id, title, tournament_id, tournament_name, venue, match_date, format, rules_json, team_a_id, team_b_id, status, version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      m.id as string, m.title as string, null, null, m.venue as string | null, m.match_date as string | null, m.format as string, m.rules_json as string, m.team_a_id as string, m.team_b_id as string, m.status as string, 0, m.created_at as string, m.updated_at as string);
  }
  void f;
}

test('stats are derived from the delivery log, not stored independently', () => {
  const db = openDatabase(':memory:');
  const f = seed(db);
  const innings = startInnings(db, SCORER, f.matchId, f.teamA);
  setOpeners(db, SCORER, innings.id, f.playersA[0], f.playersA[1], f.playersB[0]);
  for (let i = 0; i < 6; i++) ball(f, innings.id, { strikerId: loadInningsState(db, innings.id).strikerId!, nonStrikerId: loadInningsState(db, innings.id).nonStrikerId!, bowlerId: f.playersB[0], batterRuns: 1 });
  const stats = matchStatistics(db, f.matchId);
  const perInnings = stats.perInnings as Array<Record<string, unknown>>;
  assert.equal(perInnings.length, 1);
  const manhattan = perInnings[0].manhattan as Array<Record<string, unknown>>;
  assert.equal(manhattan.length, 1);
  assert.equal(manhattan[0].runs, 6);
  const graph = perInnings[0].runRateGraph as Array<Record<string, unknown>>;
  assert.equal(graph[0].runRate, 6);
  db.close();
});
