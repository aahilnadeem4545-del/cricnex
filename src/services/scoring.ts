import type { Db } from '../db/database';
import {
  applyDelivery, changeBowler, createInningsState, inningsCompletion, rebuildInnings, ScoringError, setOpeningPlayers,
} from '../domain/engine';
import { calculateMatchResult } from '../domain/result';
import type { DeliveryInput, DeliveryRecord, InningsState, MatchRules } from '../domain/types';
import { newId, nowIso, parseJson, toInt, conflict, notFound, badRequest, HttpError } from './util';

export interface MatchRow {
  id: string;
  title: string;
  format: string;
  rules_json: string;
  team_a_id: string;
  team_b_id: string;
  status: string;
  toss_winner_team_id: string | null;
  toss_decision: string | null;
  batting_first_team_id: string | null;
  batting_second_team_id: string | null;
  winner_team_id: string | null;
  result_type: string | null;
  result_margin: number | null;
  result_summary: string | null;
  version: number;
  tournament_id: string | null;
}

export interface InningsRow {
  id: string;
  match_id: string;
  innings_number: number;
  batting_team_id: string;
  bowling_team_id: string;
  target: number | null;
  follow_on_enforced: number;
  status: string;
  runs: number;
  wickets: number;
  legal_balls: number;
  started_at: string | null;
  completed_at: string | null;
  version: number;
}

interface DeliveryRow {
  id: string;
  innings_id: string;
  sequence: number;
  input_json: string;
  recorded_at: string;
  status: string;
  idempotency_key: string;
}

export interface ScoringContext {
  userId: string;
  role: 'admin' | 'scorer' | 'viewer';
}

export function getMatch(db: Db, matchId: string): MatchRow {
  const row = db.get<MatchRow>('SELECT * FROM matches WHERE id = ?', matchId);
  if (!row) throw notFound(`Match ${matchId} not found`);
  return row;
}

export function getRules(match: MatchRow): MatchRules {
  return parseJson<MatchRules>(match.rules_json, {
    format: 'T20', overs: 20, ballsPerOver: 6, inningsCount: 2,
    freeHitEnabled: true, powerplayOvers: 6, maxOversPerBowler: 4, followOnMargin: 200,
  });
}

export function getInnings(db: Db, inningsId: string): InningsRow {
  const row = db.get<InningsRow>('SELECT * FROM innings WHERE id = ?', inningsId);
  if (!row) throw notFound(`Innings ${inningsId} not found`);
  return row;
}

export function activeDeliveries(db: Db, inningsId: string): DeliveryRow[] {
  return db.all<DeliveryRow>(
    `SELECT id, innings_id, sequence, input_json, recorded_at, status, idempotency_key
     FROM deliveries WHERE innings_id = ? AND status = 'active' ORDER BY sequence ASC`,
    inningsId,
  );
}

function toInputs(rows: DeliveryRow[]): Array<{ input: DeliveryInput; id: string; recordedAt: string; sequence: number }> {
  return rows.map(r => ({
    input: parseJson<DeliveryInput>(r.input_json, {} as DeliveryInput),
    id: r.id,
    recordedAt: r.recorded_at,
    sequence: r.sequence,
  }));
}

/**
 * Load the innings state. The cache is a pure projection of the delivery log,
 * so a missing or stale cache is transparently rebuilt from deliveries.
 */
export function loadInningsState(db: Db, inningsId: string): InningsState {
  const innings = getInnings(db, inningsId);
  const rows = activeDeliveries(db, inningsId);
  const cache = db.get<{ state_json: string; deliveries_count: number }>(
    'SELECT state_json, deliveries_count FROM innings_state_cache WHERE innings_id = ?', inningsId,
  );
  if (cache && cache.deliveries_count === rows.length) {
    const state = parseJson<InningsState>(cache.state_json, null as unknown as InningsState);
    if (state && state.inningsId === inningsId) return syncInningsStatus(innings, state);
  }
  return rebuildState(db, innings, rows);
}

/**
 * The innings row is the authoritative record of whether an innings is open.
 * The cached state mirrors it so a scorer can never add a ball to a closed
 * innings, and so reopening/undo restores the innings immediately.
 */
function syncInningsStatus(innings: InningsRow, state: InningsState): InningsState {
  if (innings.status === 'complete' || innings.status === 'declared' || innings.status === 'abandoned') {
    state.status = innings.status;
  } else if (state.status !== 'in_progress') {
    state.status = 'in_progress';
  }
  return state;
}

function emptyStateFor(db: Db, innings: InningsRow): InningsState {
  return createInningsState({
    inningsId: innings.id,
    matchId: innings.match_id,
    inningsNumber: innings.innings_number,
    battingTeamId: innings.batting_team_id,
    bowlingTeamId: innings.bowling_team_id,
    target: innings.target,
  });
}

/** Deterministically rebuild an innings state from an ordered delivery list. */
function stateFromRows(db: Db, innings: InningsRow, rows: DeliveryRow[]): InningsState {
  const rules = getRules(getMatch(db, innings.match_id));
  const base = emptyStateFor(db, innings);
  return rows.length === 0 ? base : rebuildInnings(base, toInputs(rows), rules);
}

function rebuildState(db: Db, innings: InningsRow, rows: DeliveryRow[]): InningsState {
  const state = stateFromRows(db, innings, rows);
  if (innings.status === 'declared' || innings.status === 'abandoned') {
    state.status = innings.status;
  }
  saveStateCache(db, innings.id, state, rows.length);
  return state;
}

function saveStateCache(db: Db, inningsId: string, state: InningsState, count: number): void {
  db.run(
    `INSERT INTO innings_state_cache (innings_id, state_json, deliveries_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(innings_id) DO UPDATE SET state_json = excluded.state_json,
       deliveries_count = excluded.deliveries_count, updated_at = excluded.updated_at`,
    inningsId, JSON.stringify(state), count, nowIso(),
  );
}

/** Rebuild every derived table for an innings from the delivery log. */
export function rebuildInningsDerived(db: Db, inningsId: string, state?: InningsState): InningsState {
  const innings = getInnings(db, inningsId);
  const rows = activeDeliveries(db, inningsId);
  const resolved = state ?? rebuildState(db, innings, rows);
  saveStateCache(db, inningsId, resolved, rows.length);
  writeDerived(db, inningsId, resolved);
  return resolved;
}

export function writeDerived(db: Db, inningsId: string, state: InningsState): void {
  const match = getInnings(db, inningsId);
  db.run(
    `UPDATE innings SET runs = ?, wickets = ?, legal_balls = ?, extras_wides = ?, extras_noball = ?,
       extras_byes = ?, extras_legbyes = ?, extras_penalty = ?, version = version + 1
     WHERE id = ?`,
    state.runs, state.wickets, state.legalBalls, state.extras.wides, state.extras.noBall,
    state.extras.byes, state.extras.legByes, state.extras.penalty, inningsId,
  );

  db.run('DELETE FROM batting_scorecards WHERE innings_id = ?', inningsId);
  const batterInsert = db.prepare(
    `INSERT INTO batting_scorecards
     (id, innings_id, player_id, batting_position, runs, balls, fours, sixes, strike_rate,
      dismissal_type, dismissal_detail, bowler_id, is_out, is_not_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let position = 0;
  for (const key of Object.keys(state.batters)) {
    const b = state.batters[key];
    position += 1;
    const sr = b.balls === 0 ? 0 : Math.round((b.runs / b.balls) * 10000) / 100;
    batterInsert.run(
      newId(), inningsId, b.id, position, b.runs, b.balls, b.fours, b.sixes, sr,
      b.dismissalType, b.dismissalDetail, b.dismissedByBowlerId, b.out ? 1 : 0, b.out ? 0 : 1,
    );
  }

  db.run('DELETE FROM bowling_figures WHERE innings_id = ?', inningsId);
  const bowlInsert = db.prepare(
    `INSERT INTO bowling_figures
     (id, innings_id, player_id, overs_text, legal_balls, maidens, runs_conceded, wickets, economy, wides, no_balls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const key of Object.keys(state.bowlers)) {
    const b = state.bowlers[key];
    const overs = `${Math.floor(b.legalBalls / 6)}.${b.legalBalls % 6}`;
    const econ = b.legalBalls === 0 ? 0 : Math.round((b.runsConceded / (b.legalBalls / 6)) * 100) / 100;
    bowlInsert.run(
      newId(), inningsId, b.id, overs, b.legalBalls, b.maidens, b.runsConceded, b.wickets, econ, b.wides, b.noBalls,
    );
  }

  db.run('DELETE FROM partnerships WHERE innings_id = ?', inningsId);
  const partInsert = db.prepare(
    `INSERT INTO partnerships (id, innings_id, wicket_number, player1_id, player2_id, runs, balls, ended, end_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of state.partnerships) {
    partInsert.run(newId(), inningsId, p.wicketNumber, p.player1Id, p.player2Id, p.runs, p.balls, p.ended ? 1 : 0, p.endType);
  }
  if (state.currentPartnership) {
    partInsert.run(
      newId(), inningsId, state.wickets + 1, state.currentPartnership.player1Id,
      state.currentPartnership.player2Id, state.currentPartnership.runs, state.currentPartnership.balls, 0, null,
    );
  }

  db.run('DELETE FROM fall_of_wickets WHERE innings_id = ?', inningsId);
  const fowInsert = db.prepare(
    `INSERT INTO fall_of_wickets
     (id, innings_id, wicket_number, batter_id, runs, balls, over_text, partnership_runs, partnership_balls, bowler_id, dismissal_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of state.fallOfWickets) {
    fowInsert.run(
      newId(), inningsId, f.wicketNumber, f.batterId, f.runs, f.balls, f.over,
      f.partnershipRuns, f.partnershipBalls, f.bowlerId, f.dismissalType,
    );
  }
  void match;
}

function audit(db: Db, entityType: string, entityId: string, action: string, actor: string | null, before: unknown, after: unknown, reason?: string): void {
  db.run(
    `INSERT INTO audit_logs (id, entity_type, entity_id, action, actor_user_id, before_json, after_json, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), entityType, entityId, action, actor,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    reason ?? null, nowIso(),
  );
}

function emitOutbox(db: Db, entityType: string, entityId: string, op: string, payload: unknown, matchId: string | null): void {
  const prev = db.get<{ v: number }>(
    'SELECT COALESCE(MAX(version), 0) AS v FROM outbox_events WHERE entity_type = ? AND entity_id = ?',
    entityType, entityId,
  );
  db.run(
    `INSERT INTO outbox_events (id, match_id, entity_type, entity_id, op, payload_json, version, created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    newId(), matchId, entityType, entityId, op, JSON.stringify(payload), (prev?.v ?? 0) + 1, nowIso(),
  );
}

export function logEvent(db: Db, matchId: string, inningsId: string | null, type: string, payload: unknown): void {
  db.run(
    'INSERT INTO match_events (id, match_id, innings_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId(), matchId, inningsId, type, JSON.stringify(payload), nowIso(),
  );
}

/* ------------------------------------------------------------------ */
/* Innings lifecycle                                                   */
/* ------------------------------------------------------------------ */

export function startInnings(
  db: Db,
  ctx: ScoringContext,
  matchId: string,
  battingTeamId: string,
  opts: { target?: number | null; inningsNumber?: number; followOnEnforced?: boolean } = {},
): InningsRow {
  return db.transaction(() => {
    const match = getMatch(db, matchId);
    const existing = db.get<InningsRow>(
      'SELECT * FROM innings WHERE match_id = ? ORDER BY innings_number DESC LIMIT 1', matchId,
    );
    const inningsNumber = opts.inningsNumber ?? (existing ? existing.innings_number + 1 : 1);
    const bowlingTeamId = battingTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;
    if (battingTeamId !== match.team_a_id && battingTeamId !== match.team_b_id) {
      throw badRequest('Batting team must be one of the two match teams.');
    }
    const dup = db.get('SELECT id FROM innings WHERE match_id = ? AND innings_number = ?', matchId, inningsNumber);
    if (dup) throw conflict('That innings already exists for this match.');
    const id = newId();
    db.run(
      `INSERT INTO innings (id, match_id, innings_number, batting_team_id, bowling_team_id, target, follow_on_enforced, status, started_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, 0)`,
      id, matchId, inningsNumber, battingTeamId, bowlingTeamId, opts.target ?? null,
      opts.followOnEnforced ? 1 : 0, nowIso(),
    );
    db.run('UPDATE matches SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', 'LIVE', nowIso(), matchId);
    audit(db, 'innings', id, 'START', ctx.userId, null, { battingTeamId, inningsNumber, target: opts.target ?? null });
    emitOutbox(db, 'innings', id, 'INSERT', { matchId, inningsNumber, battingTeamId, bowlingTeamId }, matchId);
    logEvent(db, matchId, id, 'INNINGS_START', { battingTeamId, inningsNumber, target: opts.target ?? null });
    return getInnings(db, id);
  });
}

export function setOpeners(
  db: Db,
  ctx: ScoringContext,
  inningsId: string,
  strikerId: string | undefined,
  nonStrikerId: string | undefined,
  bowlerId: string,
): InningsState {
  return db.transaction(() => {
    const innings = getInnings(db, inningsId);
    const state = loadInningsState(db, inningsId);
    const s = strikerId ?? state.strikerId ?? '';
    const ns = nonStrikerId ?? state.nonStrikerId ?? '';
    const next = state.deliveryCount === 0
      ? setOpeningPlayers(state, s, ns, bowlerId)
      : changeBowler(state, bowlerId);
    saveStateCache(db, inningsId, next, activeDeliveries(db, inningsId).length);
    audit(db, 'innings', inningsId, state.deliveryCount === 0 ? 'SET_OPENERS' : 'CHANGE_BOWLER', ctx.userId, null, { strikerId: s, nonStrikerId: ns, bowlerId });
    void innings;
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Ball-by-ball scoring                                                */
/* ------------------------------------------------------------------ */

export interface ScoreDeliveryResult {
  state: InningsState;
  delivery: DeliveryRecord;
  duplicate: boolean;
}

export function scoreDelivery(
  db: Db,
  ctx: ScoringContext,
  inningsId: string,
  input: DeliveryInput,
  options: { deliveryId?: string } = {},
): ScoreDeliveryResult {
  return db.transaction(() => {
    const innings = getInnings(db, inningsId);
    if (ctx.role === 'viewer') throw new HttpError(403, 'Viewers cannot modify scores', 'FORBIDDEN');
    if (innings.status !== 'in_progress') throw conflict('This innings is not in progress.', 'INNINGS_CLOSED');

    // Idempotency: replaying the same request returns the original result.
    const existing = db.get<DeliveryRow>(
      'SELECT * FROM deliveries WHERE innings_id = ? AND idempotency_key = ?', inningsId, input.idempotencyKey,
    );
    if (existing) {
      const state = loadInningsState(db, inningsId);
      const record = rowToRecord(db, existing.id);
      return { state, delivery: record, duplicate: true };
    }

    const match = getMatch(db, innings.match_id);
    const rules = getRules(match);
    let state = loadInningsState(db, inningsId);
    const active = activeDeliveries(db, inningsId);
    if (state.deliveryCount === 0 && state.strikerId === null && (input.eventType ?? 'DELIVERY') === 'DELIVERY') {
      // First ball of the innings: seat the openers and opening bowler.
      state = setOpeningPlayers(state, input.strikerId, input.nonStrikerId, input.bowlerId);
    }
    let applied;
    try {
      applied = applyDelivery(state, input, rules, { sequence: active.length + 1, id: options.deliveryId });
    } catch (error) {
      if (error instanceof ScoringError) throw new HttpError(422, error.message, error.code);
      throw error;
    }
    const { state: nextState, delivery } = applied;

    insertDelivery(db, delivery, input, nextState.deliveryCount);
    saveStateCache(db, inningsId, nextState, active.length + 1);
    writeDerived(db, inningsId, nextState);
    audit(db, 'delivery', delivery.id, 'CREATE', ctx.userId, null, {
      inningsId, sequence: delivery.sequence, totalRuns: delivery.totalRuns,
      wicket: delivery.dismissalType, idempotencyKey: input.idempotencyKey,
    });
    emitOutbox(db, 'delivery', delivery.id, 'INSERT', { inningsId, input }, innings.match_id);
    logEvent(db, innings.match_id, inningsId, 'DELIVERY', {
      sequence: delivery.sequence, runs: delivery.totalRuns, wicket: delivery.dismissalType,
    });

    maybeCompleteInnings(db, ctx, innings.match_id, inningsId, nextState);
    db.run('UPDATE matches SET version = version + 1, updated_at = ? WHERE id = ?', nowIso(), innings.match_id);
    return { state: nextState, delivery, duplicate: false };
  });
}

function insertDelivery(db: Db, record: DeliveryRecord, input: DeliveryInput, sequence: number): void {
  db.run(
    `INSERT INTO deliveries (
      id, idempotency_key, match_id, innings_id, sequence, over_number, ball_in_over, legal_ball_number,
      striker_id, non_striker_id, bowler_id, batter_runs, wides, no_ball, byes, leg_byes, penalty, total_runs,
      is_legal_ball, is_free_hit, dismissal_type, dismissed_batter_id, credited_bowler_id, fielder_ids_json,
      runs_completed_before_dismissal, dismissal_note, shot_angle, shot_distance, event_type, status,
      supersedes, note, recorded_by, recorded_at, input_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    record.id, record.idempotencyKey, record.matchId, record.inningsId, sequence, record.overNumber,
    record.ballInOver, record.legalBallNumber, record.strikerId, record.nonStrikerId, record.bowlerId,
    record.batterRuns, record.wides, record.noBall, record.byes, record.legByes, record.penalty, record.totalRuns,
    record.isLegalBall ? 1 : 0, record.isFreeHit ? 1 : 0, record.dismissalType, record.dismissedBatterId,
    record.creditedBowlerId, JSON.stringify(record.fielderIds), record.runsCompletedBeforeDismissal,
    record.dismissalNote, record.shotAngle, record.shotDistance, record.eventType, record.status,
    record.supersedes, record.note, record.recordedBy, record.recordedAt, JSON.stringify(input),
  );
}

export function rowToRecord(db: Db, deliveryId: string): DeliveryRecord {
  const r = db.get<Record<string, unknown>>('SELECT * FROM deliveries WHERE id = ?', deliveryId);
  if (!r) throw notFound('Delivery not found');
  return {
    id: String(r.id),
    idempotencyKey: String(r.idempotency_key),
    matchId: String(r.match_id),
    inningsId: String(r.innings_id),
    sequence: toInt(r.sequence),
    overNumber: toInt(r.over_number),
    ballInOver: toInt(r.ball_in_over),
    legalBallNumber: toInt(r.legal_ball_number),
    strikerId: String(r.striker_id),
    nonStrikerId: String(r.non_striker_id),
    bowlerId: String(r.bowler_id),
    batterRuns: toInt(r.batter_runs),
    wides: toInt(r.wides),
    noBall: toInt(r.no_ball),
    byes: toInt(r.byes),
    legByes: toInt(r.leg_byes),
    penalty: toInt(r.penalty),
    totalRuns: toInt(r.total_runs),
    isLegalBall: Boolean(r.is_legal_ball),
    isFreeHit: Boolean(r.is_free_hit),
    dismissalType: (r.dismissal_type as DeliveryRecord['dismissalType']) ?? null,
    dismissedBatterId: (r.dismissed_batter_id as string) ?? null,
    creditedBowlerId: (r.credited_bowler_id as string) ?? null,
    fielderIds: parseJson<string[]>(r.fielder_ids_json as string, []),
    runsCompletedBeforeDismissal: r.runs_completed_before_dismissal === null ? null : toInt(r.runs_completed_before_dismissal),
    dismissalNote: (r.dismissal_note as string) ?? null,
    shotAngle: r.shot_angle === null ? null : Number(r.shot_angle),
    shotDistance: r.shot_distance === null ? null : Number(r.shot_distance),
    eventType: r.event_type as DeliveryRecord['eventType'],
    status: r.status as DeliveryRecord['status'],
    supersedes: (r.supersedes as string) ?? null,
    note: (r.note as string) ?? null,
    recordedBy: String(r.recorded_by),
    recordedAt: String(r.recorded_at),
  };
}

/**
 * Undo the most recent delivery of an innings. The original row is retained as
 * 'superseded' for the audit trail and every derived table is rebuilt, so the
 * scorecard can never drift from the delivery log.
 */
export function undoLastDelivery(db: Db, ctx: ScoringContext, inningsId: string, reason: string): InningsState {
  return db.transaction(() => {
    if (ctx.role === 'viewer') throw new HttpError(403, 'Viewers cannot modify scores', 'FORBIDDEN');
    const innings = getInnings(db, inningsId);
    const last = db.get<DeliveryRow>(
      `SELECT * FROM deliveries WHERE innings_id = ? AND status = 'active' ORDER BY sequence DESC LIMIT 1`,
      inningsId,
    );
    if (!last) throw conflict('There is nothing to undo in this innings.', 'NOTHING_TO_UNDO');
    db.run(`UPDATE deliveries SET status = 'superseded' WHERE id = ?`, last.id);
    audit(db, 'delivery', last.id, 'UNDO', ctx.userId, { sequence: last.sequence }, { status: 'superseded' }, reason);
    emitOutbox(db, 'delivery', last.id, 'UNDO', { inningsId, deliveryId: last.id }, innings.match_id);

    // Reopen the innings if the undo removed the delivery that closed it.
    if (innings.status === 'complete') {
      db.run(`UPDATE innings SET status = 'in_progress', completed_at = NULL WHERE id = ?`, inningsId);
    }
    if (innings.status === 'in_progress') {
      db.run(`UPDATE matches SET status = 'LIVE', winner_team_id = NULL, result_type = NULL, result_margin = NULL, result_summary = NULL, updated_at = ? WHERE id = ?`, nowIso(), innings.match_id);
    }
    return rebuildInningsDerived(db, inningsId);
  });
}

export function editDelivery(
  db: Db,
  ctx: ScoringContext,
  deliveryId: string,
  newInput: DeliveryInput,
  reason: string,
): ScoreDeliveryResult {
  return db.transaction(() => {
    if (ctx.role === 'viewer') throw new HttpError(403, 'Viewers cannot modify scores', 'FORBIDDEN');
    const original = rowToRecord(db, deliveryId);
    const innings = getInnings(db, original.inningsId);
    const rules = getRules(getMatch(db, innings.match_id));
    // A correction reuses the original sequence slot, so replay order is
    // preserved. Rebuild everything strictly before it, then apply the edit.
    const priorRows = activeDeliveries(db, original.inningsId)
      .filter(r => r.id !== deliveryId && r.sequence < original.sequence);
    let baseState = stateFromRows(db, innings, priorRows);
    if (priorRows.length === 0) {
      baseState = setOpeningPlayers(baseState, newInput.strikerId, newInput.nonStrikerId, newInput.bowlerId);
    }
    const input: DeliveryInput = { ...newInput, idempotencyKey: `${original.idempotencyKey}:edit:${newId()}` };
    let applied;
    try {
      applied = applyDelivery(baseState, input, rules, { sequence: original.sequence });
    } catch (error) {
      if (error instanceof ScoringError) throw new HttpError(422, error.message, error.code);
      throw error;
    }
    const { delivery } = applied;
    delivery.supersedes = deliveryId;
    db.run(`UPDATE deliveries SET status = 'superseded' WHERE id = ?`, deliveryId);
    insertDelivery(db, delivery, input, original.sequence);
    audit(db, 'delivery', deliveryId, 'EDIT', ctx.userId, original, { newDeliveryId: delivery.id }, reason);
    emitOutbox(db, 'delivery', delivery.id, 'EDIT', { inningsId: original.inningsId, input }, innings.match_id);
    const nextState = rebuildInningsDerived(db, original.inningsId);
    maybeCompleteInnings(db, ctx, innings.match_id, original.inningsId, nextState);
    return { state: nextState, delivery, duplicate: false };
  });
}

function maybeCompleteInnings(db: Db, ctx: ScoringContext, matchId: string, inningsId: string, state: InningsState): void {
  const match = getMatch(db, matchId);
  const rules = getRules(match);
  const info = inningsCompletion(state, rules);
  if (!info.complete) return;
  db.run(
    `UPDATE innings SET status = 'complete', completed_at = ? WHERE id = ? AND status = 'in_progress'`,
    nowIso(), inningsId,
  );
  logEvent(db, matchId, inningsId, 'INNINGS_COMPLETE', { reason: info.reason });
  advanceMatch(db, ctx, matchId);
}

/** Decide the next match state after an innings closes. */
export function advanceMatch(db: Db, ctx: ScoringContext, matchId: string): void {
  const match = getMatch(db, matchId);
  const rules = getRules(match);
  const innings = db.all<InningsRow>('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_number ASC', matchId);
  const completed = innings.filter(i => i.status === 'complete' || i.status === 'declared' || i.status === 'abandoned');
  const allDone = completed.length >= rules.inningsCount;

  if (allDone) {
    storeResult(db, ctx, matchId);
    return;
  }
  db.run(`UPDATE matches SET status = 'INNINGS_BREAK', updated_at = ? WHERE id = ?`, nowIso(), matchId);
}

export function storeResult(db: Db, ctx: ScoringContext, matchId: string): void {
  const match = getMatch(db, matchId);
  const rules = getRules(match);
  const inningsRows = db.all<InningsRow>('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_number ASC', matchId);
  const states = inningsRows.map(i => loadInningsState(db, i.id));
  const teamNames: Record<string, string> = {};
  for (const t of db.all<{ id: string; name: string }>('SELECT id, name FROM teams')) teamNames[t.id] = t.name;
  const result = calculateMatchResult({
    rules,
    innings: states,
    battingTeamNames: teamNames,
    battingFirstTeamId: match.batting_first_team_id ?? match.team_a_id,
    battingSecondTeamId: match.batting_second_team_id ?? match.team_b_id,
  });
  const status = result.resultType === 'IN_PROGRESS' ? 'LIVE'
    : result.resultType === 'TIE' ? 'COMPLETED'
    : result.resultType === 'DRAW' ? 'DRAWN'
    : result.resultType === 'NO_RESULT' ? 'NO_RESULT'
    : result.resultType === 'ABANDONED' ? 'ABANDONED'
    : 'COMPLETED';
  db.run(
    `UPDATE matches SET status = ?, winner_team_id = ?, result_type = ?, result_margin = ?, result_summary = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    status, result.winningTeamId, result.resultType, result.margin, result.summary, nowIso(), matchId,
  );
  logEvent(db, matchId, null, 'RESULT', result);
  emitOutbox(db, 'match', matchId, 'UPDATE', { status, result }, matchId);
  void ctx;
}

export function reopenInnings(db: Db, ctx: ScoringContext, inningsId: string): InningsState {
  return db.transaction(() => {
    if (ctx.role === 'viewer') throw new HttpError(403, 'Viewers cannot modify scores', 'FORBIDDEN');
    const innings = getInnings(db, inningsId);
    db.run(`UPDATE innings SET status = 'in_progress', completed_at = NULL WHERE id = ?`, inningsId);
    db.run(`UPDATE matches SET status = 'LIVE', result_summary = NULL, result_type = NULL, result_margin = NULL, winner_team_id = NULL, updated_at = ? WHERE id = ?`, nowIso(), innings.match_id);
    audit(db, 'innings', inningsId, 'REOPEN', ctx.userId, { status: innings.status }, { status: 'in_progress' });
    return rebuildInningsDerived(db, inningsId);
  });
}

export function declareInnings(db: Db, ctx: ScoringContext, inningsId: string): InningsState {
  return db.transaction(() => {
    if (ctx.role === 'viewer') throw new HttpError(403, 'Viewers cannot modify scores', 'FORBIDDEN');
    const innings = getInnings(db, inningsId);
    db.run(`UPDATE innings SET status = 'declared', completed_at = ? WHERE id = ?`, nowIso(), inningsId);
    audit(db, 'innings', inningsId, 'DECLARE', ctx.userId, { status: innings.status }, { status: 'declared' });
    const state = rebuildInningsDerived(db, inningsId);
    advanceMatch(db, ctx, innings.match_id);
    return state;
  });
}
