import type { Db } from '../db/database';
import { economy, oversString } from '../domain/engine';
import { getMatch, getRules, loadInningsState } from './scoring';
import { newId, nowIso, toInt } from './util';

/** Recompute one player's career cache purely from recorded deliveries/scorecards. */
export function recomputePlayerCareer(db: Db, playerId: string): void {
  const bat = db.get<{
    innings: number; runs: number; balls: number; fours: number; sixes: number;
    highest: number; not_outs: number; matches: number;
  }>(
    `SELECT COUNT(*) AS innings, COALESCE(SUM(b.runs),0) AS runs, COALESCE(SUM(b.balls),0) AS balls,
       COALESCE(SUM(b.fours),0) AS fours, COALESCE(SUM(b.sixes),0) AS sixes,
       COALESCE(MAX(b.runs),0) AS highest, COALESCE(SUM(b.is_not_out),0) AS not_outs,
       COUNT(DISTINCT i.match_id) AS matches
     FROM batting_scorecards b JOIN innings i ON i.id = b.innings_id WHERE b.player_id = ?`,
    playerId,
  )!;
  const bowl = db.get<{
    legal_balls: number; runs_conceded: number; wickets: number; matches: number;
  }>(
    `SELECT COALESCE(SUM(f.legal_balls),0) AS legal_balls, COALESCE(SUM(f.runs_conceded),0) AS runs_conceded,
       COALESCE(SUM(f.wickets),0) AS wickets, COUNT(DISTINCT i.match_id) AS matches
     FROM bowling_figures f JOIN innings i ON i.id = f.innings_id WHERE f.player_id = ?`,
    playerId,
  )!;
  const best = db.get<{ wickets: number; runs_conceded: number }>(
    `SELECT f.wickets, f.runs_conceded FROM bowling_figures f WHERE f.player_id = ?
     ORDER BY f.wickets DESC, f.runs_conceded ASC LIMIT 1`,
    playerId,
  );
  const highestNotOut = db.get<{ v: number }>(
    `SELECT b.runs AS v FROM batting_scorecards b WHERE b.player_id = ?
     ORDER BY b.runs DESC, b.is_not_out DESC LIMIT 1`,
    playerId,
  );
  const catches = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliveries WHERE dismissal_type = 'CAUGHT' AND fielder_ids_json LIKE ?`,
    `%${playerId}%`,
  )!;
  const runOuts = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM deliveries WHERE dismissal_type = 'RUN_OUT' AND fielder_ids_json LIKE ?`,
    `%${playerId}%`,
  )!;
  const highestIsNotOut = db.get<{ is_not_out: number }>(
    `SELECT b.is_not_out FROM batting_scorecards b WHERE b.player_id = ? ORDER BY b.runs DESC, b.is_not_out DESC LIMIT 1`,
    playerId,
  );

  const dismissals = bat.innings - bat.not_outs;
  const average = dismissals > 0 ? Math.round((bat.runs / dismissals) * 100) / 100 : bat.runs > 0 ? bat.runs : 0;
  const strikeRate = bat.balls > 0 ? Math.round((bat.runs / bat.balls) * 10000) / 100 : 0;
  const bowlingAverage = bowl.wickets > 0 ? Math.round((bowl.runs_conceded / bowl.wickets) * 100) / 100 : null;
  const bowlEconomy = bowl.legal_balls > 0 ? Math.round((bowl.runs_conceded / (bowl.legal_balls / 6)) * 100) / 100 : null;
  const matches = Math.max(bat.matches, bowl.matches);

  db.run(
    `INSERT INTO player_career_cache (player_id, matches, innings, runs, balls, highest_score, highest_not_out,
       not_outs, average, strike_rate, fours, sixes, wickets, bowling_average, economy, best_bowling, catches, run_outs, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(player_id) DO UPDATE SET matches=excluded.matches, innings=excluded.innings, runs=excluded.runs,
       balls=excluded.balls, highest_score=excluded.highest_score, highest_not_out=excluded.highest_not_out,
       not_outs=excluded.not_outs, average=excluded.average, strike_rate=excluded.strike_rate, fours=excluded.fours,
       sixes=excluded.sixes, wickets=excluded.wickets, bowling_average=excluded.bowling_average,
       economy=excluded.economy, best_bowling=excluded.best_bowling, catches=excluded.catches,
       run_outs=excluded.run_outs, updated_at=excluded.updated_at`,
    playerId, matches, bat.innings, bat.runs, bat.balls, highestNotOut?.v ?? bat.highest,
    (highestIsNotOut?.is_not_out ?? 0) ? 1 : 0, bat.not_outs, average, strikeRate, bat.fours, bat.sixes,
    bowl.wickets, bowlingAverage, bowlEconomy, best ? `${best.wickets}/${best.runs_conceded}` : null,
    catches.n, runOuts.n, nowIso(),
  );
}

export function recomputeAllCareers(db: Db): void {
  for (const p of db.all<{ id: string }>('SELECT id FROM players')) recomputePlayerCareer(db, p.id);
}

export function battingLeaders(db: Db, limit = 20): Array<Record<string, unknown>> {
  return db.all(
    `SELECT c.*, p.full_name, p.playing_role, t.name AS team_name FROM player_career_cache c
     JOIN players p ON p.id = c.player_id LEFT JOIN teams t ON t.id = p.primary_team_id
     WHERE c.innings > 0 ORDER BY c.runs DESC, c.average DESC LIMIT ?`, limit,
  );
}

export function bowlingLeaders(db: Db, limit = 20): Array<Record<string, unknown>> {
  return db.all(
    `SELECT c.*, p.full_name, p.playing_role, t.name AS team_name FROM player_career_cache c
     JOIN players p ON p.id = c.player_id LEFT JOIN teams t ON t.id = p.primary_team_id
     WHERE c.economy IS NOT NULL ORDER BY c.wickets DESC, c.economy ASC LIMIT ?`, limit,
  );
}

/** Manhattan chart: runs scored in each over, derived from the delivery log. */
export function manhattanData(db: Db, inningsId: string): Array<Record<string, unknown>> {
  return db.all(
    `SELECT over_number, SUM(total_runs) AS runs, SUM(CASE WHEN dismissal_type IS NOT NULL THEN 1 ELSE 0 END) AS wickets,
       SUM(CASE WHEN is_legal_ball = 1 THEN 1 ELSE 0 END) AS legal_balls
     FROM deliveries WHERE innings_id = ? AND status = 'active' AND event_type = 'DELIVERY'
     GROUP BY over_number ORDER BY over_number`, inningsId,
  );
}

/** Cumulative run-rate graph, derived from the delivery log. */
export function runRateGraph(db: Db, inningsId: string): Array<Record<string, unknown>> {
  const overs = manhattanData(db, inningsId);
  let cumulative = 0;
  let balls = 0;
  const series: Array<Record<string, unknown>> = [];
  for (const o of overs) {
    cumulative += toInt(o.runs);
    balls += toInt(o.legal_balls);
    series.push({
      over: toInt(o.over_number),
      runs: toInt(o.runs),
      cumulative,
      runRate: balls === 0 ? 0 : Math.round((cumulative / (balls / 6)) * 100) / 100,
    });
  }
  return series;
}

export function wagonWheelData(db: Db, inningsId: string): Array<Record<string, unknown>> {
  return db.all(
    `SELECT d.sequence, d.shot_angle, d.shot_distance, d.batter_runs, p.full_name AS batter_name
     FROM deliveries d JOIN players p ON p.id = d.striker_id
     WHERE d.innings_id = ? AND d.status = 'active' AND d.shot_angle IS NOT NULL
     ORDER BY d.sequence`, inningsId,
  );
}

export function overByOver(db: Db, inningsId: string): Array<Record<string, unknown>> {
  return db.all(
    `SELECT over_number, bowler_id, SUM(total_runs) AS runs,
       SUM(CASE WHEN dismissal_type IS NOT NULL THEN 1 ELSE 0 END) AS wickets,
       SUM(wides) AS wides, SUM(no_ball) AS no_balls,
       SUM(CASE WHEN is_legal_ball = 1 THEN 1 ELSE 0 END) AS legal_balls
     FROM deliveries WHERE innings_id = ? AND status = 'active' AND event_type = 'DELIVERY'
     GROUP BY over_number, bowler_id ORDER BY over_number`, inningsId,
  );
}

export function inningsStatistics(db: Db, inningsId: string): Record<string, unknown> {
  const innings = db.get<{ match_id: string }>('SELECT match_id FROM innings WHERE id = ?', inningsId);
  if (!innings) return {};
  const rules = getRules(getMatch(db, innings.match_id));
  const state = loadInningsState(db, inningsId);
  const batting = db.all<Record<string, unknown>>(
    `SELECT b.*, p.full_name FROM batting_scorecards b JOIN players p ON p.id = b.player_id
     WHERE b.innings_id = ? ORDER BY b.runs DESC`, inningsId,
  );
  const bestBatting = batting[0] ?? null;
  const bestBowling = db.all<Record<string, unknown>>(
    `SELECT f.*, p.full_name FROM bowling_figures f JOIN players p ON p.id = f.player_id
     WHERE f.innings_id = ? ORDER BY f.wickets DESC, f.runs_conceded ASC LIMIT 1`, inningsId,
  )[0] ?? null;
  const highestPartnership = db.all<Record<string, unknown>>(
    `SELECT pa.*, p1.full_name AS player1_name, p2.full_name AS player2_name FROM partnerships pa
     JOIN players p1 ON p1.id = pa.player1_id JOIN players p2 ON p2.id = pa.player2_id
     WHERE pa.innings_id = ? ORDER BY pa.runs DESC LIMIT 1`, inningsId,
  )[0] ?? null;
  return {
    inningsId,
    total: { runs: state.runs, wickets: state.wickets, overs: oversString(state.legalBalls, rules.ballsPerOver) },
    extras: { ...state.extras, total: state.extras.wides + state.extras.noBall + state.extras.byes + state.extras.legByes + state.extras.penalty },
    powerplay: state.powerplay,
    bestBatting,
    bestBowling,
    highestPartnership,
    manhattan: manhattanData(db, inningsId),
    runRateGraph: runRateGraph(db, inningsId),
    overByOver: overByOver(db, inningsId),
    wagonWheel: wagonWheelData(db, inningsId),
    lastSix: state.lastSix,
    freeHit: state.freeHitNext,
    partnershipCount: state.partnerships.length,
  };
}

export function matchStatistics(db: Db, matchId: string): Record<string, unknown> {
  const rows = db.all<{ id: string }>('SELECT id FROM innings WHERE match_id = ? ORDER BY innings_number', matchId);
  const perInnings = rows.map(r => inningsStatistics(db, r.id));
  const bestBatting = db.all<Record<string, unknown>>(
    `SELECT b.*, p.full_name, i.match_id FROM batting_scorecards b
     JOIN players p ON p.id = b.player_id JOIN innings i ON i.id = b.innings_id
     WHERE i.match_id = ? ORDER BY b.runs DESC LIMIT 1`, matchId,
  )[0] ?? null;
  const bestBowling = db.all<Record<string, unknown>>(
    `SELECT f.*, p.full_name FROM bowling_figures f
     JOIN innings i ON i.id = f.innings_id JOIN players p ON p.id = f.player_id
     WHERE i.match_id = ? ORDER BY f.wickets DESC, f.runs_conceded ASC LIMIT 1`, matchId,
  )[0] ?? null;
  const highestPartnership = db.all<Record<string, unknown>>(
    `SELECT pa.*, p1.full_name AS player1_name, p2.full_name AS player2_name FROM partnerships pa
     JOIN innings i ON i.id = pa.innings_id
     JOIN players p1 ON p1.id = pa.player1_id JOIN players p2 ON p2.id = pa.player2_id
     WHERE i.match_id = ? ORDER BY pa.runs DESC LIMIT 1`, matchId,
  )[0] ?? null;
  return { perInnings, bestBatting, bestBowling, highestPartnership };
}

export function recomputeAfterMatch(db: Db, matchId: string): void {
  const playerIds = db.all<{ player_id: string }>(
    `SELECT DISTINCT b.player_id FROM batting_scorecards b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ?
     UNION SELECT DISTINCT f.player_id FROM bowling_figures f JOIN innings i ON i.id = f.innings_id WHERE i.match_id = ?`,
    matchId, matchId,
  );
  for (const row of playerIds) recomputePlayerCareer(db, row.player_id);
  void newId;
  void economy;
}
