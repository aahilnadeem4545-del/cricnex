/** Core domain types for CRICNEX. The delivery log is the single source of truth. */

export type MatchFormat =
  | 'TEST'
  | 'ODI'
  | 'T20'
  | 'T10'
  | 'CUSTOM'
  | 'TENNIS_BALL'
  | 'TAPE_BALL'
  | 'LOCAL';

export type MatchStatus =
  | 'SETUP'
  | 'TOSS'
  | 'LIVE'
  | 'INNINGS_BREAK'
  | 'SUPER_OVER'
  | 'COMPLETED'
  | 'ABANDONED'
  | 'DRAWN'
  | 'NO_RESULT';

export type DismissalType =
  | 'BOWLED'
  | 'CAUGHT'
  | 'LBW'
  | 'RUN_OUT'
  | 'STUMPED'
  | 'HIT_WICKET'
  | 'HIT_BALL_TWICE'
  | 'OBSTRUCTING_FIELD'
  | 'TIMED_OUT'
  | 'RETIRED_OUT'
  | 'RETIRED_HURT';

export type DeliveryEventType =
  | 'DELIVERY'
  | 'DEAD_BALL'
  | 'RETIREMENT'
  | 'FIELDER_CHANGE'
  | 'INNINGS_EVENT';

export interface MatchRules {
  format: MatchFormat;
  overs: number;
  ballsPerOver: number;
  inningsCount: number;
  freeHitEnabled: boolean;
  powerplayOvers: number;
  maxOversPerBowler: number;
  /** Runs behind required to enforce the follow-on in a Test match. */
  followOnMargin: number;
}

export interface DeliveryInput {
  idempotencyKey: string;
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  batterRuns: number;
  wides: number;
  noBall: number;
  byes: number;
  legByes: number;
  penalty: number;
  eventType?: DeliveryEventType;
  dismissal?: {
    type: DismissalType;
    batterId: string;
    creditedBowlerId?: string | null;
    fielderIds?: string[];
    runsCompletedBeforeDismissal?: number;
    note?: string;
  };
  shot?: { angle?: number; distance?: number };
  /** Batter entering after a wicket or retirement; required for those events. */
  nextBatterId?: string;
  note?: string;
  recordedBy: string;
}

export interface DeliveryRecord {
  id: string;
  idempotencyKey: string;
  matchId: string;
  inningsId: string;
  sequence: number;
  overNumber: number;
  ballInOver: number;
  legalBallNumber: number;
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  batterRuns: number;
  wides: number;
  noBall: number;
  byes: number;
  legByes: number;
  penalty: number;
  totalRuns: number;
  isLegalBall: boolean;
  isFreeHit: boolean;
  dismissalType: DismissalType | null;
  dismissedBatterId: string | null;
  creditedBowlerId: string | null;
  fielderIds: string[];
  runsCompletedBeforeDismissal: number | null;
  dismissalNote: string | null;
  shotAngle: number | null;
  shotDistance: number | null;
  eventType: DeliveryEventType;
  status: 'active' | 'superseded';
  supersedes: string | null;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface BatterState {
  id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  active: boolean;
  out: boolean;
  dismissalType: DismissalType | null;
  dismissalDetail: string | null;
  dismissedByBowlerId: string | null;
}

export interface BowlerState {
  id: string;
  legalBalls: number;
  runsConceded: number;
  wides: number;
  noBalls: number;
  byes: number;
  legByes: number;
  wickets: number;
  maidens: number;
  currentOverRuns: number;
}

export interface FallOfWicket {
  wicketNumber: number;
  batterId: string;
  runs: number;
  balls: number;
  over: string;
  partnershipRuns: number;
  partnershipBalls: number;
  bowlerId: string | null;
  dismissalType: DismissalType;
}

export interface Partnership {
  wicketNumber: number;
  player1Id: string;
  player2Id: string;
  runs: number;
  balls: number;
  ended: boolean;
  endType: DismissalType | 'OVER_END' | 'INNINGS_END';
}

export interface OverSummary {
  overNumber: number;
  bowlerId: string;
  runs: number;
  wickets: number;
  wides: number;
  noBalls: number;
  isMaiden: boolean;
  balls: string[];
}

export interface InningsState {
  inningsId: string;
  matchId: string;
  inningsNumber: number;
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: { wides: number; noBall: number; byes: number; legByes: number; penalty: number };
  strikerId: string | null;
  nonStrikerId: string | null;
  bowlerId: string | null;
  lastBowlerId: string | null;
  freeHitNext: boolean;
  batters: Record<string, BatterState>;
  bowlers: Record<string, BowlerState>;
  fallOfWickets: FallOfWicket[];
  partnerships: Partnership[];
  currentPartnership: { player1Id: string; player2Id: string; runs: number; balls: number } | null;
  lastSix: string[];
  overSummaries: OverSummary[];
  currentOver: {
    number: number;
    bowlerId: string | null;
    legalBalls: number;
    runs: number;
    wickets: number;
    wides: number;
    noBalls: number;
    balls: string[];
  };
  powerplay: { runs: number; wickets: number; balls: number };
  shots: Array<{ angle: number; distance: number; runs: number; batterId: string; sequence: number }>;
  status: 'in_progress' | 'complete' | 'declared' | 'abandoned';
  target: number | null;
  deliveryCount: number;
}

export interface ApplyResult {
  state: InningsState;
  delivery: DeliveryRecord;
  warnings: string[];
}

export interface MatchResult {
  resultType:
    | 'RUNS'
    | 'WICKETS'
    | 'INNINGS'
    | 'TIE'
    | 'DRAW'
    | 'NO_RESULT'
    | 'ABANDONED'
    | 'SUPER_OVER'
    | 'IN_PROGRESS';
  winningTeamId: string | null;
  margin: number | null;
  summary: string;
  dls: { available: false; reason: string };
  followOnRequired?: { teamId: string; margin: number } | null;
}
