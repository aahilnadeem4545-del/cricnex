/**
 * CRICNEX pure scoring engine.
 *
 * Every rule is applied as a deterministic reduction over an InningsState.
 * There is deliberately no database or clock access here: given the same
 * starting state and the same delivery input, the output is always identical.
 * This is what makes rebuilds, undo and crash recovery safe.
 */
import type {
  ApplyResult,
  BatterState,
  BowlerState,
  DeliveryInput,
  DeliveryRecord,
  DismissalType,
  InningsState,
  MatchRules,
} from './types';

const WICKET_TYPES = new Set<DismissalType>([
  'BOWLED', 'CAUGHT', 'LBW', 'RUN_OUT', 'STUMPED', 'HIT_WICKET',
  'HIT_BALL_TWICE', 'OBSTRUCTING_FIELD', 'TIMED_OUT', 'RETIRED_OUT',
]);

const BOWLER_CREDITED_TYPES = new Set<DismissalType>([
  'BOWLED', 'CAUGHT', 'LBW', 'STUMPED', 'HIT_WICKET', 'HIT_BALL_TWICE',
]);

const FREE_HIT_DISMISSALS = new Set<DismissalType>([
  'RUN_OUT', 'OBSTRUCTING_FIELD', 'HIT_BALL_TWICE', 'RETIRED_HURT', 'RETIRED_OUT',
]);

export class ScoringError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

export function oversString(legalBalls: number, ballsPerOver: number): string {
  return `${Math.floor(legalBalls / ballsPerOver)}.${legalBalls % ballsPerOver}`;
}

export function bowlerOversString(legalBalls: number, ballsPerOver: number): string {
  return oversString(legalBalls, ballsPerOver);
}

export function strikeRate(runs: number, balls: number): number {
  return balls === 0 ? 0 : Math.round((runs / balls) * 10000) / 100;
}

export function economy(runs: number, legalBalls: number, ballsPerOver: number): number {
  if (legalBalls === 0) return 0;
  return Math.round((runs / (legalBalls / ballsPerOver)) * 100) / 100;
}

export function runRate(runs: number, legalBalls: number, ballsPerOver: number): number {
  return economy(runs, legalBalls, ballsPerOver);
}

export function requiredRunRate(runsNeeded: number, ballsRemaining: number, ballsPerOver: number): number {
  if (ballsRemaining <= 0) return 0;
  return Math.round((runsNeeded / (ballsRemaining / ballsPerOver)) * 100) / 100;
}

export function createInningsState(params: {
  inningsId: string;
  matchId: string;
  inningsNumber: number;
  battingTeamId: string;
  bowlingTeamId: string;
  target?: number | null;
}): InningsState {
  return {
    inningsId: params.inningsId,
    matchId: params.matchId,
    inningsNumber: params.inningsNumber,
    battingTeamId: params.battingTeamId,
    bowlingTeamId: params.bowlingTeamId,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: { wides: 0, noBall: 0, byes: 0, legByes: 0, penalty: 0 },
    strikerId: null,
    nonStrikerId: null,
    bowlerId: null,
    lastBowlerId: null,
    freeHitNext: false,
    batters: {},
    bowlers: {},
    fallOfWickets: [],
    partnerships: [],
    currentPartnership: null,
    lastSix: [],
    overSummaries: [],
    currentOver: {
      number: 1, bowlerId: null, legalBalls: 0, runs: 0,
      wickets: 0, wides: 0, noBalls: 0, balls: [],
    },
    powerplay: { runs: 0, wickets: 0, balls: 0 },
    shots: [],
    status: 'in_progress',
    target: params.target ?? null,
    deliveryCount: 0,
  };
}

/** Set the opening batters and first bowler before the first delivery. */
export function setOpeningPlayers(
  state: InningsState,
  strikerId: string,
  nonStrikerId: string,
  bowlerId: string,
): InningsState {
  if (state.deliveryCount > 0) throw new ScoringError('INNINGS_STARTED', 'Openers cannot be changed after the first delivery.');
  if (strikerId === nonStrikerId) throw new ScoringError('DUPLICATE_BATTER', 'Striker and non-striker must be different players.');
  const next = cloneState(state);
  next.strikerId = strikerId;
  next.nonStrikerId = nonStrikerId;
  next.bowlerId = bowlerId;
  next.currentOver.bowlerId = bowlerId;
  next.batters[strikerId] = emptyBatter(strikerId);
  next.batters[nonStrikerId] = emptyBatter(nonStrikerId);
  next.bowlers[bowlerId] = emptyBowler(bowlerId);
  next.currentPartnership = { player1Id: strikerId, player2Id: nonStrikerId, runs: 0, balls: 0 };
  return next;
}

/** Change only the bowler for the next (not-yet-started) over. */
export function changeBowler(state: InningsState, bowlerId: string): InningsState {
  // Permissive: allow changing the bowler at any point. If the current over is
  // incomplete we simply switch the bowler for the remainder of the over
  // instead of blocking the scorer.
  if (bowlerId === state.bowlerId) return state;
  const next = cloneState(state);
  next.bowlerId = bowlerId;
  next.currentOver.bowlerId = bowlerId;
  if (!next.bowlers[bowlerId]) next.bowlers[bowlerId] = emptyBowler(bowlerId);
  return next;
}

function emptyBatter(id: string): BatterState {
  return {
    id, runs: 0, balls: 0, fours: 0, sixes: 0,
    active: true, out: false, dismissalType: null,
    dismissalDetail: null, dismissedByBowlerId: null,
  };
}

function emptyBowler(id: string): BowlerState {
  return {
    id, legalBalls: 0, runsConceded: 0, wides: 0, noBalls: 0,
    byes: 0, legByes: 0, wickets: 0, maidens: 0, currentOverRuns: 0,
  };
}

export function cloneState(state: InningsState): InningsState {
  return JSON.parse(JSON.stringify(state)) as InningsState;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ScoringError('INVALID_RUNS', `${field} must be a non-negative integer.`);
  }
}

function validateInput(state: InningsState, input: DeliveryInput, rules: MatchRules): void {
  const eventType = input.eventType ?? 'DELIVERY';
  if (state.status !== 'in_progress') {
    throw new ScoringError('INNINGS_CLOSED', 'This innings is no longer accepting deliveries.');
  }
  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    throw new ScoringError('MISSING_KEY', 'An idempotency key is required.');
  }
  assertNonNegativeInteger(input.batterRuns, 'batterRuns');
  assertNonNegativeInteger(input.wides, 'wides');
  assertNonNegativeInteger(input.byes, 'byes');
  assertNonNegativeInteger(input.legByes, 'legByes');
  assertNonNegativeInteger(input.penalty, 'penalty');
  if (!Number.isInteger(input.noBall) || input.noBall < 0 || input.noBall > 1) {
    throw new ScoringError('INVALID_NO_BALL', 'noBall must be 0 or 1.');
  }
  if (input.batterRuns > 6) throw new ScoringError('INVALID_RUNS', 'batterRuns cannot exceed 6.');
  if (input.wides > 6) throw new ScoringError('INVALID_RUNS', 'wides on one delivery cannot exceed 6.');
  if (input.byes > 6 || input.legByes > 6) throw new ScoringError('INVALID_RUNS', 'Byes/leg byes on one delivery cannot exceed 6.');
  if (input.wides > 0 && (input.batterRuns > 0 || input.legByes > 0)) {
    throw new ScoringError('INVALID_WIDE_COMBINATION', 'Runs off a wide are recorded as wides only.');
  }
  if (eventType === 'DELIVERY' && state.strikerId !== input.strikerId) {
    throw new ScoringError('WRONG_STRIKER', `Expected striker ${state.strikerId}, received ${input.strikerId}.`);
  }
  if (eventType === 'DELIVERY' && state.nonStrikerId !== input.nonStrikerId) {
    throw new ScoringError('WRONG_NON_STRIKER', `Expected non-striker ${state.nonStrikerId}, received ${input.nonStrikerId}.`);
  }
  if (eventType === 'DELIVERY' && !input.bowlerId) {
    throw new ScoringError('MISSING_BOWLER', 'A bowler is required for a delivery.');
  }
  if (eventType === 'DELIVERY' && state.currentOver.legalBalls > 0 && state.bowlerId !== input.bowlerId) {
    throw new ScoringError('BOWLER_CHANGE_MID_OVER', 'The over is not complete; the same bowler must continue.');
  }
  if (eventType === 'DELIVERY' && state.currentOver.legalBalls === 0 && input.bowlerId === state.lastBowlerId) {
    throw new ScoringError('CONSECUTIVE_OVERS', 'A bowler cannot bowl consecutive overs.');
  }
  if (eventType === 'DELIVERY' && rules.overs > 0 && state.legalBalls >= rules.overs * rules.ballsPerOver) {
    throw new ScoringError('OVERS_COMPLETE', 'The innings has used all of its overs.');
  }
  if (input.dismissal) {
    if (input.dismissal.batterId !== input.strikerId && input.dismissal.batterId !== input.nonStrikerId) {
      throw new ScoringError('INVALID_DISMISSED_BATTER', 'The dismissed batter must be at the crease.');
    }
    const batter = state.batters[input.dismissal.batterId];
    if (!batter || batter.out || !batter.active) {
      throw new ScoringError('BATTER_ALREADY_OUT', 'The dismissed batter is no longer available.');
    }
    if (state.freeHitNext && !FREE_HIT_DISMISSALS.has(input.dismissal.type)) {
      throw new ScoringError('FREE_HIT_DISMISSAL', `${input.dismissal.type} is not possible off a free hit.`);
    }
    if (['RETIRED_HURT', 'RETIRED_OUT'].includes(input.dismissal.type) && !input.nextBatterId) {
      throw new ScoringError('MISSING_REPLACEMENT', 'A replacement batter is required for a retirement.');
    }
    if (WICKET_TYPES.has(input.dismissal.type) && input.dismissal.type !== 'RETIRED_HURT' && !input.nextBatterId) {
      throw new ScoringError('MISSING_NEXT_BATTER', 'A new batter is required after a wicket.');
    }
  }
}

function dismissalDetail(type: DismissalType, bowlerId: string | null, fielders: string[], note?: string): string {
  const suffix = note ? ` (${note})` : '';
  switch (type) {
    case 'BOWLED': return `b ${bowlerId ?? 'bowler'}${suffix}`;
    case 'CAUGHT': return `c ${fielders.join(' & ') || 'fielder'} b ${bowlerId ?? 'bowler'}${suffix}`;
    case 'LBW': return `lbw b ${bowlerId ?? 'bowler'}${suffix}`;
    case 'STUMPED': return `st ${fielders.join(' & ') || 'keeper'} b ${bowlerId ?? 'bowler'}${suffix}`;
    case 'RUN_OUT': return `run out (${fielders.join(' & ') || 'fielder'})${suffix}`;
    case 'HIT_WICKET': return `hit wicket b ${bowlerId ?? 'bowler'}${suffix}`;
    case 'HIT_BALL_TWICE': return `hit the ball twice${suffix}`;
    case 'OBSTRUCTING_FIELD': return `obstructing the field${suffix}`;
    case 'TIMED_OUT': return `timed out${suffix}`;
    case 'RETIRED_OUT': return `retired out${suffix}`;
    case 'RETIRED_HURT': return `retired hurt${suffix}`;
    default: return String(type).toLowerCase();
  }
}

export function deliveryNotation(record: DeliveryRecord, ballsPerOver: number): string {
  const pieces: string[] = [];
  if (record.isLegalBall) {
    pieces.push(record.batterRuns === 0 ? '.' : String(record.batterRuns));
  }
  if (record.noBall > 0) pieces.push('nb');
  if (record.wides > 0) pieces.push(record.wides > 1 ? `${record.wides}wd` : 'wd');
  if (record.byes > 0) pieces.push(record.byes > 1 ? `${record.byes}b` : 'b');
  if (record.legByes > 0) pieces.push(record.legByes > 1 ? `${record.legByes}lb` : 'lb');
  if (record.penalty > 0) pieces.push(`${record.penalty}pen`);
  if (record.dismissalType) pieces.push('W');
  if (record.eventType === 'DEAD_BALL') pieces.push('dead');
  return pieces.join('+') || '.';
}

/**
 * Apply one delivery to a state. Returns a NEW state and the normalised record.
 * The record is appended by the persistence layer inside the same transaction.
 */
export function applyDelivery(
  state: InningsState,
  input: DeliveryInput,
  rules: MatchRules,
  options: { id?: string; recordedAt?: string; sequence?: number; skipValidation?: boolean } = {},
): ApplyResult {
  if (!options.skipValidation) validateInput(state, input, rules);

  const next = cloneState(state);
  const eventType = input.eventType ?? 'DELIVERY';
  const isDelivery = eventType === 'DELIVERY';
  const isLegal = isDelivery && input.wides === 0 && input.noBall === 0;
  // Penalty runs can be awarded as a standalone event (no ball bowled) or on
  // top of a delivery; either way they count to the team, not the bowler.
  const totalRuns = isDelivery
    ? input.batterRuns + input.wides + input.noBall + input.byes + input.legByes + input.penalty
    : input.penalty;
  const isFreeHit = state.freeHitNext;
  const strikerAtStart = state.strikerId!;
  const nonStrikerAtStart = state.nonStrikerId!;
  const bowlerAtStart = input.bowlerId || state.bowlerId || '';

  const overNumber = Math.floor(state.legalBalls / rules.ballsPerOver) + 1;
  const ballInOver = (state.legalBalls % rules.ballsPerOver) + 1;
  const sequence = options.sequence ?? state.deliveryCount + 1;

  next.runs += totalRuns;
  next.extras.penalty += input.penalty;

  if (isDelivery) {
    next.legalBalls += isLegal ? 1 : 0;
    next.deliveryCount += 1;
    next.extras.wides += input.wides;
    next.extras.noBall += input.noBall;
    next.extras.byes += input.byes;
    next.extras.legByes += input.legByes;

    const batter = next.batters[strikerAtStart] ?? (next.batters[strikerAtStart] = emptyBatter(strikerAtStart));
    const bowler = next.bowlers[bowlerAtStart] ?? (next.bowlers[bowlerAtStart] = emptyBowler(bowlerAtStart));

    // A no ball counts as a ball faced; a wide does not.
    if (input.wides === 0) {
      batter.balls += 1;
      if (next.currentPartnership) next.currentPartnership.balls += 1;
    }
    batter.runs += input.batterRuns;
    if (input.batterRuns === 4) batter.fours += 1;
    if (input.batterRuns === 6) batter.sixes += 1;

    if (isLegal) bowler.legalBalls += 1;
    bowler.runsConceded += input.batterRuns + input.wides + input.noBall;
    bowler.wides += input.wides;
    bowler.noBalls += input.noBall;
    bowler.byes += input.byes;
    bowler.legByes += input.legByes;
    bowler.currentOverRuns += input.batterRuns + input.wides + input.noBall;

    if (next.currentOver.bowlerId === null) {
      next.currentOver.bowlerId = bowlerAtStart;
      next.currentOver.number = overNumber;
    }
    next.currentOver.legalBalls += isLegal ? 1 : 0;
    next.currentOver.runs += input.batterRuns + input.wides + input.noBall;
    next.currentOver.wides += input.wides;
    next.currentOver.noBalls += input.noBall;

    if (rules.powerplayOvers > 0 && state.legalBalls < rules.powerplayOvers * rules.ballsPerOver) {
      next.powerplay.runs += totalRuns;
      next.powerplay.balls += isLegal ? 1 : 0;
    }
    if (next.currentPartnership) {
      next.currentPartnership.runs += input.batterRuns + input.byes + input.legByes;
    }
  }

  const dismissal = input.dismissal;
  let creditedBowlerId: string | null = null;
  let partnershipEnded = false;

  if (dismissal) {
    const isWicket = WICKET_TYPES.has(dismissal.type) && dismissal.type !== 'RETIRED_HURT';
    creditedBowlerId = BOWLER_CREDITED_TYPES.has(dismissal.type) && !isFreeHit
      ? (dismissal.creditedBowlerId ?? bowlerAtStart)
      : null;

    const batter = next.batters[dismissal.batterId];
    batter.out = isWicket;
    batter.active = false;
    batter.dismissalType = dismissal.type;
    batter.dismissalDetail = dismissalDetail(
      dismissal.type, creditedBowlerId, dismissal.fielderIds ?? [], dismissal.note,
    );
    batter.dismissedByBowlerId = creditedBowlerId;

    if (isWicket) {
      next.wickets += 1;
      if (creditedBowlerId && next.bowlers[creditedBowlerId]) {
        next.bowlers[creditedBowlerId].wickets += 1;
      }
      next.currentOver.wickets += 1;
      if (rules.powerplayOvers > 0 && state.legalBalls < rules.powerplayOvers * rules.ballsPerOver) {
        next.powerplay.wickets += 1;
      }
      next.fallOfWickets.push({
        wicketNumber: next.wickets,
        batterId: dismissal.batterId,
        runs: next.runs,
        balls: batter.balls,
        over: oversString(state.legalBalls, rules.ballsPerOver),
        partnershipRuns: next.currentPartnership?.runs ?? 0,
        partnershipBalls: next.currentPartnership?.balls ?? 0,
        bowlerId: creditedBowlerId,
        dismissalType: dismissal.type,
      });
    }

    if (next.currentPartnership) {
      next.partnerships.push({
        wicketNumber: next.wickets + (isWicket ? 0 : 1),
        player1Id: next.currentPartnership.player1Id,
        player2Id: next.currentPartnership.player2Id,
        runs: next.currentPartnership.runs,
        balls: next.currentPartnership.balls,
        ended: true,
        endType: dismissal.type,
      });
      partnershipEnded = true;
    }
  }

  // Strike rotation. The automatic penalty component of a wide/no ball never
  // rotates strike; only runs actually completed by the batters do.
  const completedRunsForParity = isDelivery
    ? input.batterRuns + input.byes + input.legByes + (input.wides > 0 ? input.wides - 1 : 0)
    : 0;
  let swap = completedRunsForParity % 2 === 1;
  let striker = strikerAtStart;
  let nonStriker = nonStrikerAtStart;

  if (dismissal) {
    const dismissed = dismissal.batterId;
    const dismissedRuns = dismissal.runsCompletedBeforeDismissal ?? completedRunsForParity;
    const dismissedSwap = dismissedRuns % 2 === 1;
    const survivor = dismissed === strikerAtStart ? nonStrikerAtStart : strikerAtStart;
    const newBatterFaces = dismissed === strikerAtStart ? !dismissedSwap : dismissedSwap;
    if (newBatterFaces) {
      striker = input.nextBatterId ?? survivor;
      nonStriker = survivor;
    } else {
      striker = survivor;
      nonStriker = input.nextBatterId ?? '';
    }
    // A wicket/retirement has already seated a new batter: it must not also
    // swap for the completed runs on this delivery.
    if (input.nextBatterId) {
      next.batters[input.nextBatterId] = emptyBatter(input.nextBatterId);
    }
  } else if (swap) {
    // Runs actually completed by the batters rotate the strike.
    striker = nonStrikerAtStart;
    nonStriker = strikerAtStart;
  }

  const overCompleted = isLegal && next.currentOver.legalBalls === rules.ballsPerOver;
  if (overCompleted) {
    if (next.currentOver.bowlerId && next.bowlers[next.currentOver.bowlerId]) {
      if (next.currentOver.runs === 0) next.bowlers[next.currentOver.bowlerId].maidens += 1;
      next.bowlers[next.currentOver.bowlerId].currentOverRuns = 0;
    }
    next.overSummaries.push({
      overNumber: next.currentOver.number,
      bowlerId: next.currentOver.bowlerId ?? bowlerAtStart,
      runs: next.currentOver.runs,
      wickets: next.currentOver.wickets,
      wides: next.currentOver.wides,
      noBalls: next.currentOver.noBalls,
      isMaiden: next.currentOver.runs === 0,
      balls: [...next.currentOver.balls],
    });
    next.lastBowlerId = next.currentOver.bowlerId ?? bowlerAtStart;
    // Strike changes at the end of every over, on top of any run-based swap.
    const t = striker; striker = nonStriker; nonStriker = t;
    next.currentOver = {
      number: Math.floor(next.legalBalls / rules.ballsPerOver) + 1,
      bowlerId: null, legalBalls: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0, balls: [],
    };
    next.bowlerId = null;
  }

  next.strikerId = striker || null;
  next.nonStrikerId = nonStriker || null;
  if (!overCompleted) next.bowlerId = bowlerAtStart;

  if (partnershipEnded && striker && nonStriker) {
    next.currentPartnership = { player1Id: striker, player2Id: nonStriker, runs: 0, balls: 0 };
  } else if (partnershipEnded) {
    next.currentPartnership = null;
  }

  const record: DeliveryRecord = {
    id: options.id ?? crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey,
    matchId: state.matchId,
    inningsId: state.inningsId,
    sequence,
    overNumber,
    ballInOver,
    legalBallNumber: state.legalBalls + (isLegal ? 1 : 0),
    strikerId: strikerAtStart,
    nonStrikerId: nonStrikerAtStart,
    bowlerId: bowlerAtStart,
    batterRuns: input.batterRuns,
    wides: input.wides,
    noBall: input.noBall,
    byes: input.byes,
    legByes: input.legByes,
    penalty: input.penalty,
    totalRuns,
    isLegalBall: isLegal,
    isFreeHit,
    dismissalType: dismissal?.type ?? null,
    dismissedBatterId: dismissal?.batterId ?? null,
    creditedBowlerId,
    fielderIds: dismissal?.fielderIds ?? [],
    runsCompletedBeforeDismissal: dismissal?.runsCompletedBeforeDismissal ?? null,
    dismissalNote: dismissal?.note ?? null,
    shotAngle: input.shot?.angle ?? null,
    shotDistance: input.shot?.distance ?? null,
    eventType,
    status: 'active',
    supersedes: null,
    note: input.note ?? null,
    recordedBy: input.recordedBy,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };

  const notation = deliveryNotation(record, rules.ballsPerOver);
  next.currentOver.balls.push(notation);
  next.lastSix.push(notation);
  if (next.lastSix.length > 6) next.lastSix.shift();
  if (input.shot?.angle !== undefined && input.shot?.distance !== undefined) {
    next.shots.push({
      angle: input.shot.angle,
      distance: input.shot.distance,
      runs: input.batterRuns,
      batterId: strikerAtStart,
      sequence,
    });
  }

  // A no ball always grants a free hit; an illegal ball bowled ON a free hit
  // means the following delivery remains a free hit.
  next.freeHitNext = rules.freeHitEnabled
    ? (input.noBall > 0 || (isFreeHit && !isLegal))
    : false;

  return { state: next, delivery: record, warnings: [] };
}

/** Rebuild a whole innings from an ordered list of active deliveries. */
export function rebuildInnings(
  base: InningsState,
  deliveries: Array<{ input: DeliveryInput; id: string; recordedAt: string; sequence: number }>,
  rules: MatchRules,
): InningsState {
  let state = createInningsState({
    inningsId: base.inningsId,
    matchId: base.matchId,
    inningsNumber: base.inningsNumber,
    battingTeamId: base.battingTeamId,
    bowlingTeamId: base.bowlingTeamId,
    target: base.target,
  });
  const first = deliveries[0];
  if (first) {
    state = setOpeningPlayers(state, first.input.strikerId, first.input.nonStrikerId, first.input.bowlerId);
  }
  for (const item of deliveries) {
    // During replay the log is authoritative about who faced the ball and who
    // bowled it. Honouring the recorded personnel (rather than re-deriving the
    // strike) means an earlier correction can never make later, already
    // recorded deliveries unreadable.
    const input = item.input;
    if (!state.batters[input.strikerId]) state.batters[input.strikerId] = emptyBatter(input.strikerId);
    if (!state.batters[input.nonStrikerId]) state.batters[input.nonStrikerId] = emptyBatter(input.nonStrikerId);
    if (input.bowlerId && !state.bowlers[input.bowlerId]) state.bowlers[input.bowlerId] = emptyBowler(input.bowlerId);
    state.strikerId = input.strikerId;
    state.nonStrikerId = input.nonStrikerId;
    if (input.bowlerId) {
      state.bowlerId = input.bowlerId;
      if (state.currentOver.legalBalls === 0) state.currentOver.bowlerId = input.bowlerId;
    }
    state = applyDelivery(state, input, rules, {
      id: item.id, recordedAt: item.recordedAt, sequence: item.sequence, skipValidation: true,
    }).state;
  }
  state.status = base.status;
  return state;
}

export interface CompletionInfo {
  complete: boolean;
  reason: 'ALL_OUT' | 'OVERS_COMPLETE' | 'TARGET_REACHED' | 'DECLARED' | 'ABANDONED' | null;
}

export function inningsCompletion(state: InningsState, rules: MatchRules): CompletionInfo {
  if (state.status === 'complete' || state.status === 'declared') return { complete: true, reason: 'DECLARED' };
  if (state.status === 'abandoned') return { complete: true, reason: 'ABANDONED' };
  if (state.wickets >= 10) return { complete: true, reason: 'ALL_OUT' };
  if (state.target !== null && state.runs >= state.target) return { complete: true, reason: 'TARGET_REACHED' };
  if (rules.overs > 0 && state.legalBalls >= rules.overs * rules.ballsPerOver) {
    return { complete: true, reason: 'OVERS_COMPLETE' };
  }
  return { complete: false, reason: null };
}
