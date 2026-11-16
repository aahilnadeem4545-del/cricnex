/** Shapes returned by the CRICNEX API. Kept intentionally loose where the
 *  server returns rich rows, but precise for the fields the UI depends on. */

export type Role = 'admin' | 'scorer' | 'viewer';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt?: string;
}

export interface MatchRules {
  format: string;
  overs: number;
  ballsPerOver: number;
  inningsCount: number;
  freeHitEnabled: boolean;
  powerplayOvers: number;
  maxOversPerBowler: number;
  followOnMargin: number;
}

export interface Team {
  id: string;
  name: string;
  short_name?: string | null;
  logo_url?: string | null;
  coach?: string | null;
  captain_id?: string | null;
  player_count?: number;
  players?: Player[];
  record?: Record<string, number>;
}

export interface Player {
  id: string;
  full_name: string;
  photo_url?: string | null;
  jersey_number?: number | null;
  batting_style?: string | null;
  bowling_style?: string | null;
  playing_role?: string | null;
  primary_team_id?: string | null;
  team_name?: string | null;
  team_count?: number;
  career?: Career | null;
  teams?: Team[];
}

export interface Career {
  player_id: string;
  matches: number;
  innings: number;
  runs: number;
  balls: number;
  highest_score: number;
  highest_not_out: number;
  not_outs: number;
  average: number;
  strike_rate: number;
  fours: number;
  sixes: number;
  wickets: number;
  bowling_average: number | null;
  economy: number | null;
  best_bowling: string | null;
  catches: number;
  run_outs: number;
}

export interface MatchSummary {
  id: string;
  title: string;
  status: string;
  format: string;
  rules_json?: string;
  venue?: string | null;
  match_date?: string | null;
  created_at: string;
  team_a_id: string;
  team_b_id: string;
  team_a_name: string;
  team_b_name: string;
  winner_name?: string | null;
  winner_team_id?: string | null;
  result_type?: string | null;
  result_summary?: string | null;
  innings_count?: number;
  tournament_id?: string | null;
}

export interface BatterLine {
  id: string; name: string; runs: number; balls: number; fours: number; sixes: number; strikeRate: number;
}
export interface BowlerLine {
  id: string; name: string; overs: string; legalBalls: number; maidens: number; runs: number;
  wickets: number; economy: number; wides: number; noBalls: number;
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
  striker: BatterLine | null;
  nonStriker: BatterLine | null;
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

export interface BatterState {
  id: string; runs: number; balls: number; fours: number; sixes: number;
  active: boolean; out: boolean; dismissalType: string | null; dismissalDetail: string | null;
}
export interface BowlerState {
  id: string; legalBalls: number; runsConceded: number; wides: number; noBalls: number;
  byes: number; legByes: number; wickets: number; maidens: number; currentOverRuns: number;
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
  fallOfWickets: Array<Record<string, unknown>>;
  partnerships: Array<Record<string, unknown>>;
  currentPartnership: { player1Id: string; player2Id: string; runs: number; balls: number } | null;
  lastSix: string[];
  overSummaries: Array<{ overNumber: number; bowlerId: string; runs: number; wickets: number; isMaiden: boolean; balls: string[] }>;
  currentOver: { number: number; bowlerId: string | null; legalBalls: number; runs: number; wickets: number; wides: number; noBalls: number; balls: string[] };
  powerplay: { runs: number; wickets: number; balls: number };
  shots: Array<{ angle: number; distance: number; runs: number; batterId: string; sequence: number }>;
  status: 'in_progress' | 'complete' | 'declared' | 'abandoned';
  target: number | null;
  deliveryCount: number;
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

export interface Scorecard {
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

export interface MatchDetail {
  match: Record<string, unknown> & {
    id: string; title: string; status: string; format: string; venue?: string | null;
    match_date?: string | null; team_a_id: string; team_b_id: string;
    batting_first_team_id?: string | null; batting_second_team_id?: string | null;
    toss_winner_team_id?: string | null; toss_decision?: string | null;
    player_of_match_id?: string | null; result_summary?: string | null; result_type?: string | null;
  };
  rules: MatchRules;
  teamA: Team;
  teamB: Team;
  squads: Array<{
    match_id: string; team_id: string; player_id: string; full_name: string; jersey_number?: number | null;
    playing_role?: string | null; batting_style?: string | null; bowling_style?: string | null;
    in_playing_xi: number; is_captain: number; is_wicketkeeper: number; is_substitute: number;
  }>;
  innings: Scorecard[];
  events: Array<Record<string, unknown>>;
  result: {
    resultType: string; winningTeamId: string | null; margin: number | null; summary: string;
    dls: { available: false; reason: string };
  };
  live: LiveScoreboard;
}

export interface Tournament {
  id: string;
  name: string;
  format: string;
  start_date?: string | null;
  end_date?: string | null;
  status: string;
  config_json: string;
  team_count?: number;
  fixture_count?: number;
}

export interface TournamentDetail {
  tournament: Tournament;
  teams: Team[];
  fixtures: Array<Record<string, unknown>>;
  pointsTable: Array<Record<string, unknown>>;
  leaderboards: { batting: Array<Record<string, unknown>>; bowling: Array<Record<string, unknown>> };
}

export interface Dashboard {
  live: MatchSummary[];
  recent: MatchSummary[];
  counts: { teams: number; players: number; matches: number; tournaments: number; deliveries: number; live: number };
  upcoming: Array<Record<string, unknown>>;
  topBatting: Array<Record<string, unknown>>;
  topBowling: Array<Record<string, unknown>>;
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
  eventType?: string;
  dismissal?: {
    type: string;
    batterId: string;
    creditedBowlerId?: string | null;
    fielderIds?: string[];
    runsCompletedBeforeDismissal?: number;
    note?: string;
  };
  shot?: { angle?: number; distance?: number };
  nextBatterId?: string;
  note?: string;
}
