import type { Db } from '../db/database';
import { getMatch, getRules, loadInningsState } from './scoring';
import { badRequest, conflict, newId, notFound, nowIso, parseJson } from './util';

export interface TournamentInput {
  name: string;
  format?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  config?: { pointsWin?: number; pointsTie?: number; pointsNoResult?: number };
}

export function createTournament(db: Db, input: TournamentInput): Record<string, unknown> {
  const name = input.name?.trim();
  if (!name) throw badRequest('Tournament name is required.');
  const id = newId();
  const ts = nowIso();
  db.run(
    `INSERT INTO tournaments (id, name, format, start_date, end_date, status, config_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, name, input.format ?? 'T20', input.startDate ?? null, input.endDate ?? null, 'draft',
    JSON.stringify({ pointsWin: 2, pointsTie: 1, pointsNoResult: 1, ...(input.config ?? {}) }), ts, ts,
  );
  return db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', id)!;
}

export function listTournaments(db: Db): Array<Record<string, unknown>> {
  return db.all(
    `SELECT t.*, (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id) AS team_count,
       (SELECT COUNT(*) FROM fixtures f WHERE f.tournament_id = t.id) AS fixture_count
     FROM tournaments t ORDER BY t.created_at DESC`,
  );
}

export function addTeamsToTournament(db: Db, tournamentId: string, teamIds: string[], groupName: string | null = null): void {
  db.transaction(() => {
    if (!db.get('SELECT id FROM tournaments WHERE id = ?', tournamentId)) throw notFound('Tournament not found');
    for (const teamId of teamIds) {
      if (!db.get('SELECT id FROM teams WHERE id = ?', teamId)) throw notFound(`Team ${teamId} not found`);
      db.run(
        `INSERT INTO tournament_teams (tournament_id, team_id, group_name) VALUES (?,?,?)
         ON CONFLICT(tournament_id, team_id) DO UPDATE SET group_name = excluded.group_name`,
        tournamentId, teamId, groupName,
      );
      db.run(
        `INSERT INTO points_tables (id, tournament_id, team_id, group_name, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(tournament_id, team_id, group_name) DO NOTHING`,
        newId(), tournamentId, teamId, groupName, nowIso(),
      );
    }
    db.run('UPDATE tournaments SET updated_at = ? WHERE id = ?', nowIso(), tournamentId);
  });
}

/** Generate a single round-robin fixture list (circle method). */
export function generateRoundRobin(db: Db, tournamentId: string, opts: { venue?: string | null; startDate?: string | null; doubleRound?: boolean } = {}): Array<Record<string, unknown>> {
  return db.transaction(() => {
    const tournament = db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
    if (!tournament) throw notFound('Tournament not found');
    const teams = db.all<{ team_id: string }>('SELECT team_id FROM tournament_teams WHERE tournament_id = ?', tournamentId);
    if (teams.length < 2) throw badRequest('Add at least two teams before generating fixtures.');
    const existing = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fixtures WHERE tournament_id = ?', tournamentId);
    if ((existing?.n ?? 0) > 0) throw conflict('Fixtures already exist for this tournament.', 'FIXTURES_EXIST');

    const ids = teams.map(t => t.team_id);
    if (ids.length % 2 === 1) ids.push('__BYE__');
    const rounds = ids.length - 1;
    const half = ids.length / 2;
    let matchNumber = 1;
    const start = opts.startDate ? new Date(opts.startDate) : new Date();
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < half; i++) {
        const a = ids[i];
        const b = ids[ids.length - 1 - i];
        if (a === '__BYE__' || b === '__BYE__') continue;
        const homeFirst = (round + i) % 2 === 0;
        insertFixture(db, tournamentId, `Round ${round + 1}`, matchNumber++, homeFirst ? a : b, homeFirst ? b : a, opts.venue ?? null, start);
        if (opts.doubleRound) {
          insertFixture(db, tournamentId, `Round ${round + 1 + rounds}`, matchNumber++, homeFirst ? b : a, homeFirst ? a : b, opts.venue ?? null, start);
        }
      }
      ids.splice(1, 0, ids.pop()!);
    }
    db.run('UPDATE tournaments SET status = ?, updated_at = ? WHERE id = ?', 'active', nowIso(), tournamentId);
    return db.all('SELECT * FROM fixtures WHERE tournament_id = ? ORDER BY match_number', tournamentId);
  });
}

function insertFixture(db: Db, tournamentId: string, round: string, matchNumber: number, teamA: string, teamB: string, venue: string | null, base: Date): void {
  const scheduled = new Date(base.getTime() + (matchNumber - 1) * 86400_000).toISOString();
  db.run(
    `INSERT INTO fixtures (id, tournament_id, round, match_number, team_a_id, team_b_id, scheduled_at, venue, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(), tournamentId, round, matchNumber, teamA, teamB, scheduled, venue, 'scheduled',
  );
}

export function linkFixtureToMatch(db: Db, fixtureId: string, matchId: string): void {
  db.run('UPDATE fixtures SET match_id = ?, status = ? WHERE id = ?', matchId, 'scheduled', fixtureId);
}

export function completeFixture(db: Db, matchId: string): void {
  db.run('UPDATE fixtures SET status = ? WHERE match_id = ?', 'completed', matchId);
}

export function recomputePointsTable(db: Db, tournamentId: string): Array<Record<string, unknown>> {
  return db.transaction(() => {
    const config = parseJson<{ pointsWin: number; pointsTie: number; pointsNoResult: number }>(
      db.get<{ config_json: string }>('SELECT config_json FROM tournaments WHERE id = ?', tournamentId)?.config_json ?? '{}',
      { pointsWin: 2, pointsTie: 1, pointsNoResult: 1 },
    );
    const entries = db.all<{ id: string; team_id: string; group_name: string | null }>(
      'SELECT id, team_id, group_name FROM points_tables WHERE tournament_id = ?', tournamentId,
    );
    const matches = db.all<{ id: string; team_a_id: string; team_b_id: string; winner_team_id: string | null; result_type: string | null; status: string }>(
      `SELECT id, team_a_id, team_b_id, winner_team_id, result_type, status FROM matches
       WHERE tournament_id = ? AND status IN ('COMPLETED','DRAWN','NO_RESULT','ABANDONED')`, tournamentId,
    );
    for (const entry of entries) {
      const stats = { played: 0, won: 0, lost: 0, tied: 0, no_result: 0, points: 0, runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 };
      for (const m of matches) {
        if (m.team_a_id !== entry.team_id && m.team_b_id !== entry.team_id) continue;
        const rules = getRules(getMatch(db, m.id));
        const quotaBalls = rules.overs > 0 ? rules.overs * rules.ballsPerOver : 0;
        const inningsRows = db.all<{ id: string; batting_team_id: string }>('SELECT id, batting_team_id FROM innings WHERE match_id = ?', m.id);
        stats.played += 1;
        if (m.result_type === 'TIE') { stats.tied += 1; stats.points += config.pointsTie; }
        else if (m.status === 'NO_RESULT' || m.status === 'ABANDONED' || m.result_type === 'NO_RESULT' || m.result_type === 'ABANDONED') { stats.no_result += 1; stats.points += config.pointsNoResult; }
        else if (m.winner_team_id === entry.team_id) { stats.won += 1; stats.points += config.pointsWin; }
        else if (m.winner_team_id) { stats.lost += 1; }
        else { stats.no_result += 1; stats.points += config.pointsNoResult; }

        for (const row of inningsRows) {
          const state = loadInningsState(db, row.id);
          const allOut = state.wickets >= 10;
          const ballsUsed = allOut && quotaBalls > 0 ? quotaBalls : state.legalBalls;
          if (row.batting_team_id === entry.team_id) {
            stats.runsFor += state.runs;
            stats.ballsFaced += ballsUsed;
          } else {
            stats.runsAgainst += state.runs;
            stats.ballsBowled += ballsUsed;
          }
        }
      }
      const oversFaced = stats.ballsFaced / 6;
      const oversBowled = stats.ballsBowled / 6;
      const nrr = (oversFaced > 0 ? stats.runsFor / oversFaced : 0) - (oversBowled > 0 ? stats.runsAgainst / oversBowled : 0);
      db.run(
        `UPDATE points_tables SET played=?, won=?, lost=?, tied=?, no_result=?, points=?, runs_for=?, overs_faced_balls=?,
           runs_against=?, overs_bowled_balls=?, nrr=?, updated_at=? WHERE id=?`,
        stats.played, stats.won, stats.lost, stats.tied, stats.no_result, stats.points, stats.runsFor,
        stats.ballsFaced, stats.runsAgainst, stats.ballsBowled, Math.round(nrr * 1000) / 1000, nowIso(), entry.id,
      );
    }
    return db.all(
      `SELECT pt.*, t.name AS team_name FROM points_tables pt JOIN teams t ON t.id = pt.team_id
       WHERE pt.tournament_id = ? ORDER BY pt.points DESC, pt.nrr DESC, pt.runs_for DESC`, tournamentId,
    );
  });
}

export function tournamentLeaderboards(db: Db, tournamentId: string, limit = 10): Record<string, unknown> {
  const batting = db.all(
    `SELECT p.full_name, t.name AS team_name, SUM(b.runs) AS runs, SUM(b.balls) AS balls,
       SUM(b.fours) AS fours, SUM(b.sixes) AS sixes, COUNT(*) AS innings,
       ROUND(CASE WHEN SUM(b.balls) > 0 THEN SUM(b.runs) * 100.0 / SUM(b.balls) ELSE 0 END, 2) AS strike_rate,
       MAX(b.runs) AS highest
     FROM batting_scorecards b JOIN innings i ON i.id = b.innings_id
     JOIN matches m ON m.id = i.match_id JOIN players p ON p.id = b.player_id
     LEFT JOIN teams t ON t.id = p.primary_team_id
     WHERE m.tournament_id = ? GROUP BY b.player_id ORDER BY runs DESC LIMIT ?`, tournamentId, limit,
  );
  const bowling = db.all(
    `SELECT p.full_name, t.name AS team_name, SUM(f.wickets) AS wickets, SUM(f.runs_conceded) AS runs_conceded,
       SUM(f.legal_balls) AS legal_balls, COUNT(*) AS innings,
       ROUND(CASE WHEN SUM(f.legal_balls) > 0 THEN SUM(f.runs_conceded) * 6.0 / SUM(f.legal_balls) ELSE 0 END, 2) AS economy
     FROM bowling_figures f JOIN innings i ON i.id = f.innings_id
     JOIN matches m ON m.id = i.match_id JOIN players p ON p.id = f.player_id
     LEFT JOIN teams t ON t.id = p.primary_team_id
     WHERE m.tournament_id = ? GROUP BY f.player_id ORDER BY wickets DESC, economy ASC LIMIT ?`, tournamentId, limit,
  );
  return { batting, bowling };
}

export function getTournament(db: Db, tournamentId: string): Record<string, unknown> {
  const tournament = db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
  if (!tournament) throw notFound('Tournament not found');
  const teams = db.all(
    `SELECT t.*, tt.group_name FROM tournament_teams tt JOIN teams t ON t.id = tt.team_id WHERE tt.tournament_id = ?`, tournamentId,
  );
  const fixtures = db.all(
    `SELECT f.*, ta.name AS team_a_name, tb.name AS team_b_name FROM fixtures f
     JOIN teams ta ON ta.id = f.team_a_id JOIN teams tb ON tb.id = f.team_b_id
     WHERE f.tournament_id = ? ORDER BY f.match_number`, tournamentId,
  );
  const points = db.all(
    `SELECT pt.*, t.name AS team_name FROM points_tables pt JOIN teams t ON t.id = pt.team_id
     WHERE pt.tournament_id = ? ORDER BY pt.points DESC, pt.nrr DESC, pt.runs_for DESC`, tournamentId,
  );
  return { tournament, teams, fixtures, pointsTable: points, leaderboards: tournamentLeaderboards(db, tournamentId) };
}

export function createFixture(db: Db, tournamentId: string, teamAId: string, teamBId: string, opts: { round?: string | null; venue?: string | null; scheduledAt?: string | null } = {}): Record<string, unknown> {
  if (teamAId === teamBId) throw badRequest('A fixture needs two different teams.');
  const id = newId();
  db.run(
    `INSERT INTO fixtures (id, tournament_id, round, match_number, team_a_id, team_b_id, scheduled_at, venue, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, tournamentId, opts.round ?? 'Custom', null, teamAId, teamBId, opts.scheduledAt ?? null, opts.venue ?? null, 'scheduled',
  );
  return db.get<Record<string, unknown>>('SELECT * FROM fixtures WHERE id = ?', id)!;
}
