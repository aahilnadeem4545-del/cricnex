import type { Db } from '../db/database';
import { requiredRunRate, runRate, oversString, economy, strikeRate } from '../domain/engine';
import { calculateMatchResult } from '../domain/result';
import type { InningsState, MatchRules } from '../domain/types';
import { badRequest, conflict, newId, notFound, nowIso, parseJson, toInt } from './util';
import { getMatch, getRules, getInnings, loadInningsState, type InningsRow, type MatchRow } from './scoring';

export const FORMAT_PRESETS: Record<string, Partial<MatchRules>> = {
  TEST: { overs: 0, inningsCount: 4, freeHitEnabled: false, powerplayOvers: 0, maxOversPerBowler: 0, followOnMargin: 200 },
  ODI: { overs: 50, inningsCount: 2, freeHitEnabled: true, powerplayOvers: 10, maxOversPerBowler: 10, followOnMargin: 200 },
  T20: { overs: 20, inningsCount: 2, freeHitEnabled: true, powerplayOvers: 6, maxOversPerBowler: 4, followOnMargin: 200 },
  T10: { overs: 10, inningsCount: 2, freeHitEnabled: true, powerplayOvers: 3, maxOversPerBowler: 2, followOnMargin: 200 },
  CUSTOM: { overs: 20, inningsCount: 2, freeHitEnabled: true, powerplayOvers: 6, maxOversPerBowler: 4, followOnMargin: 200 },
  TENNIS_BALL: { overs: 6, inningsCount: 2, freeHitEnabled: false, powerplayOvers: 0, maxOversPerBowler: 0, followOnMargin: 200 },
  TAPE_BALL: { overs: 6, inningsCount: 2, freeHitEnabled: false, powerplayOvers: 0, maxOversPerBowler: 0, followOnMargin: 200 },
  LOCAL: { overs: 20, inningsCount: 2, freeHitEnabled: false, powerplayOvers: 0, maxOversPerBowler: 0, followOnMargin: 200 },
};

export function rulesForFormat(format: string, overrides: Partial<MatchRules> = {}): MatchRules {
  const preset = FORMAT_PRESETS[format] ?? FORMAT_PRESETS.CUSTOM;
  return {
    format: format as MatchRules['format'],
    overs: 20, ballsPerOver: 6, inningsCount: 2,
    freeHitEnabled: true, powerplayOvers: 6, maxOversPerBowler: 4, followOnMargin: 200,
    ...preset,
    ...overrides,
  };
}

export interface SquadEntry {
  playerId: string;
  inPlayingXI?: boolean;
  isCaptain?: boolean;
  isWicketkeeper?: boolean;
  isSubstitute?: boolean;
}

export interface CreateMatchInput {
  title: string;
  tournamentId?: string | null;
  tournamentName?: string | null;
  venue?: string | null;
  matchDate?: string | null;
  format: string;
  rules?: Partial<MatchRules>;
  teamAId: string;
  teamBId: string;
  squads?: { teamA?: SquadEntry[]; teamB?: SquadEntry[] };
  umpires?: string[];
  toss?: { winnerTeamId: string; decision: 'BAT' | 'BOWL' } | null;
  createdBy: string;
}

export function createMatch(db: Db, input: CreateMatchInput): MatchRow {
  return db.transaction(() => {
    const title = input.title?.trim();
    if (!title) throw badRequest('Match title is required.');
    if (input.teamAId === input.teamBId) throw badRequest('A match needs two different teams.');
    for (const id of [input.teamAId, input.teamBId]) {
      if (!db.get('SELECT id FROM teams WHERE id = ?', id)) throw notFound(`Team ${id} not found`);
    }
    const rules = rulesForFormat(input.format, input.rules ?? {});
    if (rules.ballsPerOver < 1 || rules.ballsPerOver > 12) throw badRequest('ballsPerOver must be between 1 and 12.');
    if (rules.inningsCount < 1 || rules.inningsCount > 4) throw badRequest('inningsCount must be between 1 and 4.');
    if (rules.overs < 0) throw badRequest('overs cannot be negative.');
    if (rules.format !== 'TEST' && rules.overs === 0) throw badRequest('Limited-overs formats need at least one over.');

    const id = newId();
    const ts = nowIso();
    db.run(
      `INSERT INTO matches (id, title, tournament_id, tournament_name, venue, match_date, format, rules_json,
        team_a_id, team_b_id, status, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      id, title, input.tournamentId ?? null, input.tournamentName ?? null, input.venue ?? null,
      input.matchDate ?? null, rules.format, JSON.stringify(rules), input.teamAId, input.teamBId, 'SETUP', ts, ts,
    );

    const squads: Array<[string, SquadEntry[] | undefined]> = [
      [input.teamAId, input.squads?.teamA], [input.teamBId, input.squads?.teamB],
    ];
    for (const [teamId, entries] of squads) {
      if (!entries) continue;
      for (const entry of entries) {
        const player = db.get<{ id: string }>('SELECT id FROM players WHERE id = ?', entry.playerId);
        if (!player) throw notFound(`Player ${entry.playerId} not found`);
        db.run(
          `INSERT INTO match_squads (match_id, team_id, player_id, in_playing_xi, is_captain, is_wicketkeeper, is_substitute)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(match_id, team_id, player_id) DO UPDATE SET in_playing_xi = excluded.in_playing_xi,
             is_captain = excluded.is_captain, is_wicketkeeper = excluded.is_wicketkeeper, is_substitute = excluded.is_substitute`,
          id, teamId, entry.playerId, entry.inPlayingXI === false ? 0 : 1,
          entry.isCaptain ? 1 : 0, entry.isWicketkeeper ? 1 : 0, entry.isSubstitute ? 1 : 0,
        );
      }
    }
    if (input.umpires?.length) {
      db.run('INSERT INTO match_events (id, match_id, innings_id, type, payload_json, created_at) VALUES (?,?,?,?,?,?)',
        newId(), id, null, 'MATCH_SETUP', JSON.stringify({ umpires: input.umpires }), ts);
    }
    if (input.toss) recordTossInternal(db, id, input.toss.winnerTeamId, input.toss.decision, input.createdBy);
    return getMatch(db, id);
  });
}

function recordTossInternal(db: Db, matchId: string, winnerTeamId: string, decision: 'BAT' | 'BOWL', actor: string): void {
  const match = getMatch(db, matchId);
  if (winnerTeamId !== match.team_a_id && winnerTeamId !== match.team_b_id) {
    throw badRequest('The toss winner must be one of the two match teams.');
  }
  const other = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;
  const battingFirst = decision === 'BAT' ? winnerTeamId : other;
  const battingSecond = decision === 'BAT' ? other : winnerTeamId;
  db.run(
    `UPDATE matches SET toss_winner_team_id = ?, toss_decision = ?, batting_first_team_id = ?, batting_second_team_id = ?,
       status = CASE WHEN status = 'SETUP' THEN 'TOSS' ELSE status END, version = version + 1, updated_at = ? WHERE id = ?`,
    winnerTeamId, decision, battingFirst, battingSecond, nowIso(), matchId,
  );
  db.run('INSERT INTO audit_logs (id, entity_type, entity_id, action, actor_user_id, after_json, created_at) VALUES (?,?,?,?,?,?,?)',
    newId(), 'match', matchId, 'TOSS', actor, JSON.stringify({ winnerTeamId, decision, battingFirst }), nowIso());
}

export function recordToss(db: Db, actor: string, matchId: string, winnerTeamId: string, decision: 'BAT' | 'BOWL'): MatchRow {
  return db.transaction(() => {
    recordTossInternal(db, matchId, winnerTeamId, decision, actor);
    return getMatch(db, matchId);
  });
}

export function validateMatchReady(db: Db, matchId: string): { ok: boolean; problems: string[] } {
  const match = getMatch(db, matchId);
  const problems: string[] = [];
  if (!match.toss_winner_team_id) problems.push('The toss has not been recorded.');
  if (!match.batting_first_team_id) problems.push('Batting order has not been decided.');
  for (const teamId of [match.team_a_id, match.team_b_id]) {
    const xi = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM match_squads WHERE match_id = ? AND team_id = ? AND in_playing_xi = 1 AND is_substitute = 0',
      matchId, teamId,
    );
    const name = db.get<{ name: string }>('SELECT name FROM teams WHERE id = ?', teamId)?.name ?? teamId;
    if ((xi?.n ?? 0) < 2) problems.push(`${name} needs at least two players in the playing XI.`);
    const captain = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM match_squads WHERE match_id = ? AND team_id = ? AND is_captain = 1', matchId, teamId);
    if ((captain?.n ?? 0) === 0) problems.push(`${name} has no captain selected.`);
    const wk = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM match_squads WHERE match_id = ? AND team_id = ? AND is_wicketkeeper = 1', matchId, teamId);
    if ((wk?.n ?? 0) === 0) problems.push(`${name} has no wicketkeeper selected.`);
  }
  return { ok: problems.length === 0, problems };
}

export function setSquad(db: Db, matchId: string, teamId: string, entries: SquadEntry[]): void {
  db.transaction(() => {
    const match = getMatch(db, matchId);
    if (teamId !== match.team_a_id && teamId !== match.team_b_id) throw badRequest('That team is not in this match.');
    db.run('DELETE FROM match_squads WHERE match_id = ? AND team_id = ?', matchId, teamId);
    for (const entry of entries) {
      db.run(
        `INSERT INTO match_squads (match_id, team_id, player_id, in_playing_xi, is_captain, is_wicketkeeper, is_substitute)
         VALUES (?,?,?,?,?,?,?)`,
        matchId, teamId, entry.playerId, entry.inPlayingXI === false ? 0 : 1,
        entry.isCaptain ? 1 : 0, entry.isWicketkeeper ? 1 : 0, entry.isSubstitute ? 1 : 0,
      );
    }
  });
}

export interface LiveScoreboard {
  match: Record<string, unknown>;
  rules: MatchRules;
  battingTeam: { id: string; name: string } | null;
  bowlingTeam: { id: string; name: string } | null;
  score: number;
  wickets: number;
  overs: string;
  ballsBowled: number;
  ballsRemaining: number | null;
  runRate: number;
  target: number | null;
  runsRequired: number | null;
  requiredRunRate: number | null;
  striker: PlayerLine | null;
  nonStriker: PlayerLine | null;
  bowler: BowlerLine | null;
  partnership: { runs: number; balls: number } | null;
  lastSix: string[];
  fallOfWickets: Array<Record<string, unknown>>;
  extras: { wides: number; noBall: number; byes: number; legByes: number; penalty: number; total: number };
  powerplay: { runs: number; wickets: number; balls: number };
  freeHit: boolean;
  inningsNumber: number | null;
  inningsStatus: string | null;
  nextBowlerRequired: boolean;
}

export interface PlayerLine {
  id: string; name: string; runs: number; balls: number; fours: number; sixes: number; strikeRate: number;
}
export interface BowlerLine {
  id: string; name: string; overs: string; legalBalls: number; maidens: number; runs: number; wickets: number;
  economy: number; wides: number; noBalls: number;
}

function playerName(db: Db, id: string | null): string {
  if (!id) return 'Unknown';
  return db.get<{ full_name: string }>('SELECT full_name FROM players WHERE id = ?', id)?.full_name ?? 'Unknown';
}

function currentInningsRow(db: Db, matchId: string): InningsRow | null {
  return db.get<InningsRow>(
    `SELECT * FROM innings WHERE match_id = ? ORDER BY innings_number DESC LIMIT 1`, matchId,
  ) ?? null;
}

export function liveScoreboard(db: Db, matchId: string): LiveScoreboard {
  const match = getMatch(db, matchId);
  const rules = getRules(match);
  const innings = currentInningsRow(db, matchId);
  const teamName = (id: string | null) => (id ? db.get<{ name: string }>('SELECT name FROM teams WHERE id = ?', id)?.name ?? id : '');
  if (!innings) {
    return {
      match: match as unknown as Record<string, unknown>, rules,
      battingTeam: null, bowlingTeam: null, score: 0, wickets: 0, overs: '0.0', ballsBowled: 0,
      ballsRemaining: rules.overs > 0 ? rules.overs * rules.ballsPerOver : null, runRate: 0, target: null,
      runsRequired: null, requiredRunRate: null, striker: null, nonStriker: null, bowler: null,
      partnership: null, lastSix: [], fallOfWickets: [],
      extras: { wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0, total: 0 },
      powerplay: { runs: 0, wickets: 0, balls: 0 }, freeHit: false, inningsNumber: null, inningsStatus: null,
      nextBowlerRequired: false,
    };
  }
  const state = loadInningsState(db, innings.id);
  const ballsBowled = state.legalBalls;
  const totalBalls = rules.overs > 0 ? rules.overs * rules.ballsPerOver : null;
  const ballsRemaining = totalBalls === null ? null : Math.max(totalBalls - ballsBowled, 0);
  const target = innings.target;
  const runsRequired = target === null ? null : Math.max(target - state.runs, 0);
  const batter = (id: string | null): PlayerLine | null => {
    if (!id) return null;
    const b = state.batters[id];
    if (!b) return null;
    return { id, name: playerName(db, id), runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, strikeRate: strikeRate(b.runs, b.balls) };
  };
  const bowlerId = state.bowlerId ?? state.currentOver.bowlerId;
  const bowlerState = bowlerId ? state.bowlers[bowlerId] : null;
  const fow = db.all<Record<string, unknown>>(
    `SELECT f.*, p.full_name AS batter_name FROM fall_of_wickets f
     JOIN players p ON p.id = f.batter_id WHERE f.innings_id = ? ORDER BY f.wicket_number`, innings.id,
  );
  return {
    match: match as unknown as Record<string, unknown>,
    rules,
    battingTeam: { id: innings.batting_team_id, name: teamName(innings.batting_team_id) },
    bowlingTeam: { id: innings.bowling_team_id, name: teamName(innings.bowling_team_id) },
    score: state.runs,
    wickets: state.wickets,
    overs: oversString(ballsBowled, rules.ballsPerOver),
    ballsBowled,
    ballsRemaining,
    runRate: runRate(state.runs, ballsBowled, rules.ballsPerOver),
    target,
    runsRequired,
    requiredRunRate: runsRequired !== null && ballsRemaining !== null ? requiredRunRate(runsRequired, ballsRemaining, rules.ballsPerOver) : null,
    striker: batter(state.strikerId),
    nonStriker: batter(state.nonStrikerId),
    bowler: bowlerId && bowlerState
      ? {
        id: bowlerId, name: playerName(db, bowlerId),
        overs: oversString(bowlerState.legalBalls, rules.ballsPerOver),
        legalBalls: bowlerState.legalBalls, maidens: bowlerState.maidens,
        runs: bowlerState.runsConceded, wickets: bowlerState.wickets,
        economy: economy(bowlerState.runsConceded, bowlerState.legalBalls, rules.ballsPerOver),
        wides: bowlerState.wides, noBalls: bowlerState.noBalls,
      }
      : null,
    partnership: state.currentPartnership ? { runs: state.currentPartnership.runs, balls: state.currentPartnership.balls } : null,
    lastSix: state.lastSix,
    fallOfWickets: fow,
    extras: {
      wides: state.extras.wides, noBall: state.extras.noBall, byes: state.extras.byes,
      legByes: state.extras.legByes, penalty: state.extras.penalty,
      total: state.extras.wides + state.extras.noBall + state.extras.byes + state.extras.legByes + state.extras.penalty,
    },
    powerplay: state.powerplay,
    freeHit: state.freeHitNext,
    inningsNumber: innings.innings_number,
    inningsStatus: innings.status,
    nextBowlerRequired: state.bowlerId === null && state.status === 'in_progress',
  };
}

export interface InningsScorecard {
  innings: InningsRow;
  batting: Array<Record<string, unknown>>;
  bowling: Array<Record<string, unknown>>;
  fallOfWickets: Array<Record<string, unknown>>;
  partnerships: Array<Record<string, unknown>>;
  overSummaries: Array<Record<string, unknown>>;
  extras: { wides: number; noBall: number; byes: number; legByes: number; penalty: number; total: number };
  total: { runs: number; wickets: number; overs: string };
  state: InningsState;
}

export function inningsScorecard(db: Db, inningsId: string): InningsScorecard {
  const innings = getInnings(db, inningsId);
  const match = getMatch(db, innings.match_id);
  const rules = getRules(match);
  const state = loadInningsState(db, inningsId);
  const batting = db.all<Record<string, unknown>>(
    `SELECT b.*, p.full_name AS player_name, p.jersey_number FROM batting_scorecards b
     JOIN players p ON p.id = b.player_id WHERE b.innings_id = ? ORDER BY b.batting_position`, inningsId,
  );
  const bowling = db.all<Record<string, unknown>>(
    `SELECT f.*, p.full_name AS player_name FROM bowling_figures f
     JOIN players p ON p.id = f.player_id WHERE f.innings_id = ? ORDER BY f.overs_text DESC`, inningsId,
  );
  const fow = db.all<Record<string, unknown>>(
    `SELECT f.*, p.full_name AS batter_name FROM fall_of_wickets f JOIN players p ON p.id = f.batter_id
     WHERE f.innings_id = ? ORDER BY f.wicket_number`, inningsId,
  );
  const partnerships = db.all<Record<string, unknown>>(
    `SELECT pa.*, p1.full_name AS player1_name, p2.full_name AS player2_name FROM partnerships pa
     JOIN players p1 ON p1.id = pa.player1_id JOIN players p2 ON p2.id = pa.player2_id
     WHERE pa.innings_id = ? ORDER BY pa.wicket_number`, inningsId,
  );
  return {
    innings, batting, bowling, fallOfWickets: fow, partnerships,
    overSummaries: state.overSummaries as unknown as Array<Record<string, unknown>>,
    extras: {
      wides: state.extras.wides, noBall: state.extras.noBall, byes: state.extras.byes,
      legByes: state.extras.legByes, penalty: state.extras.penalty,
      total: state.extras.wides + state.extras.noBall + state.extras.byes + state.extras.legByes + state.extras.penalty,
    },
    total: { runs: state.runs, wickets: state.wickets, overs: oversString(state.legalBalls, rules.ballsPerOver) },
    state,
  };
}

export function matchDetail(db: Db, matchId: string): Record<string, unknown> {
  const match = getMatch(db, matchId);
  const rules = getRules(match);
  const team = (id: string) => db.get('SELECT * FROM teams WHERE id = ?', id);
  const squads = db.all<Record<string, unknown>>(
    `SELECT ms.*, p.full_name, p.jersey_number, p.playing_role, p.batting_style, p.bowling_style
     FROM match_squads ms JOIN players p ON p.id = ms.player_id WHERE ms.match_id = ? ORDER BY p.full_name`, matchId,
  );
  const inningsRows = db.all<InningsRow>('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_number', matchId);
  const innings = inningsRows.map(row => inningsScorecard(db, row.id));
  const events = db.all<Record<string, unknown>>(
    'SELECT * FROM match_events WHERE match_id = ? ORDER BY created_at DESC LIMIT 50', matchId,
  );
  const states = inningsRows.map(r => loadInningsState(db, r.id));
  const names: Record<string, string> = {};
  for (const t of db.all<{ id: string; name: string }>('SELECT id, name FROM teams')) names[t.id] = t.name;
  const result = calculateMatchResult({
    rules, innings: states, battingTeamNames: names,
    battingFirstTeamId: match.batting_first_team_id ?? match.team_a_id,
    battingSecondTeamId: match.batting_second_team_id ?? match.team_b_id,
    isAbandoned: match.status === 'ABANDONED', isNoResult: match.status === 'NO_RESULT',
  });
  return {
    match, rules,
    teamA: team(match.team_a_id), teamB: team(match.team_b_id),
    squads, innings, events, result,
    live: liveScoreboard(db, matchId),
  };
}

export function listMatches(db: Db, opts: { status?: string; teamId?: string; tournamentId?: string; limit?: number; offset?: number } = {}): {
  items: Array<Record<string, unknown>>; total: number;
} {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.status) { where.push('m.status = ?'); params.push(opts.status); }
  if (opts.teamId) { where.push('(m.team_a_id = ? OR m.team_b_id = ?)'); params.push(opts.teamId, opts.teamId); }
  if (opts.tournamentId) { where.push('m.tournament_id = ?'); params.push(opts.tournamentId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matches m ${clause}`, ...params)?.n ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const items = db.all(
    `SELECT m.*, ta.name AS team_a_name, tb.name AS team_b_name, tw.name AS winner_name,
       (SELECT COUNT(*) FROM innings i WHERE i.match_id = m.id) AS innings_count
     FROM matches m
     JOIN teams ta ON ta.id = m.team_a_id
     JOIN teams tb ON tb.id = m.team_b_id
     LEFT JOIN teams tw ON tw.id = m.winner_team_id
     ${clause} ORDER BY COALESCE(m.match_date, m.created_at) DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  return { items, total };
}

export function setPlayerOfMatch(db: Db, matchId: string, playerId: string): void {
  const match = getMatch(db, matchId);
  if (match.status === 'SETUP') throw conflict('Record the toss before naming a player of the match.');
  db.run('UPDATE matches SET player_of_match_id = ?, updated_at = ? WHERE id = ?', playerId, nowIso(), matchId);
}

export function abandonMatch(db: Db, actor: string, matchId: string, reason: string): MatchRow {
  return db.transaction(() => {
    getMatch(db, matchId);
    db.run('UPDATE matches SET status = ?, result_summary = ?, result_type = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      'ABANDONED', `Match abandoned (${reason})`, 'ABANDONED', nowIso(), matchId);
    db.run('INSERT INTO audit_logs (id, entity_type, entity_id, action, actor_user_id, reason, created_at) VALUES (?,?,?,?,?,?,?)',
      newId(), 'match', matchId, 'ABANDON', actor, reason, nowIso());
    return getMatch(db, matchId);
  });
}

export function toInningsSummary(row: InningsRow, state: InningsState, ballsPerOver: number): Record<string, unknown> {
  return {
    id: row.id,
    inningsNumber: row.innings_number,
    battingTeamId: row.batting_team_id,
    runs: state.runs,
    wickets: state.wickets,
    overs: oversString(state.legalBalls, ballsPerOver),
    legalBalls: state.legalBalls,
    target: row.target,
    status: row.status,
    extras: state.extras,
  };
}

export function parseRules(text: string): MatchRules {
  return parseJson<MatchRules>(text, rulesForFormat('T20'));
}

export function getInningsRow(db: Db, id: string): InningsRow {
  return getInnings(db, id);
}

export function inningsCount(db: Db, matchId: string): number {
  return toInt(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM innings WHERE match_id = ?', matchId)?.n ?? 0);
}
