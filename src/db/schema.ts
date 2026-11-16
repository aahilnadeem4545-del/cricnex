export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','scorer','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  logo_url TEXT,
  coach TEXT,
  captain_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  photo_url TEXT,
  jersey_number INTEGER,
  batting_style TEXT,
  bowling_style TEXT,
  playing_role TEXT,
  primary_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_players (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  is_captain INTEGER NOT NULL DEFAULT 0,
  is_wicketkeeper INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_teams (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  group_name TEXT,
  PRIMARY KEY (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
  round TEXT,
  match_number INTEGER,
  team_a_id TEXT NOT NULL REFERENCES teams(id),
  team_b_id TEXT NOT NULL REFERENCES teams(id),
  scheduled_at TEXT,
  venue TEXT,
  match_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS points_tables (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  group_name TEXT,
  played INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  lost INTEGER NOT NULL DEFAULT 0,
  tied INTEGER NOT NULL DEFAULT 0,
  no_result INTEGER NOT NULL DEFAULT 0,
  points REAL NOT NULL DEFAULT 0,
  runs_for INTEGER NOT NULL DEFAULT 0,
  overs_faced_balls INTEGER NOT NULL DEFAULT 0,
  runs_against INTEGER NOT NULL DEFAULT 0,
  overs_bowled_balls INTEGER NOT NULL DEFAULT 0,
  nrr REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (tournament_id, team_id, group_name)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE SET NULL,
  tournament_name TEXT,
  venue TEXT,
  match_date TEXT,
  format TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  team_a_id TEXT NOT NULL REFERENCES teams(id),
  team_b_id TEXT NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'SETUP',
  toss_winner_team_id TEXT,
  toss_decision TEXT,
  batting_first_team_id TEXT,
  batting_second_team_id TEXT,
  winner_team_id TEXT,
  result_type TEXT,
  result_margin INTEGER,
  result_summary TEXT,
  player_of_match_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  super_over_parent_match_id TEXT,
  dls_note TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_squads (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  in_playing_xi INTEGER NOT NULL DEFAULT 1,
  is_captain INTEGER NOT NULL DEFAULT 0,
  is_wicketkeeper INTEGER NOT NULL DEFAULT 0,
  is_substitute INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS innings (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_number INTEGER NOT NULL,
  batting_team_id TEXT NOT NULL REFERENCES teams(id),
  bowling_team_id TEXT NOT NULL REFERENCES teams(id),
  target INTEGER,
  follow_on_enforced INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress',
  runs INTEGER NOT NULL DEFAULT 0,
  wickets INTEGER NOT NULL DEFAULT 0,
  legal_balls INTEGER NOT NULL DEFAULT 0,
  extras_wides INTEGER NOT NULL DEFAULT 0,
  extras_noball INTEGER NOT NULL DEFAULT 0,
  extras_byes INTEGER NOT NULL DEFAULT 0,
  extras_legbyes INTEGER NOT NULL DEFAULT 0,
  extras_penalty INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (match_id, innings_number)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id TEXT NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  over_number INTEGER NOT NULL,
  ball_in_over INTEGER NOT NULL,
  legal_ball_number INTEGER NOT NULL,
  striker_id TEXT NOT NULL REFERENCES players(id),
  non_striker_id TEXT NOT NULL REFERENCES players(id),
  bowler_id TEXT NOT NULL REFERENCES players(id),
  batter_runs INTEGER NOT NULL DEFAULT 0,
  wides INTEGER NOT NULL DEFAULT 0,
  no_ball INTEGER NOT NULL DEFAULT 0,
  byes INTEGER NOT NULL DEFAULT 0,
  leg_byes INTEGER NOT NULL DEFAULT 0,
  penalty INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,
  is_legal_ball INTEGER NOT NULL,
  is_free_hit INTEGER NOT NULL DEFAULT 0,
  dismissal_type TEXT,
  dismissed_batter_id TEXT,
  credited_bowler_id TEXT,
  fielder_ids_json TEXT,
  runs_completed_before_dismissal INTEGER,
  dismissal_note TEXT,
  shot_angle REAL,
  shot_distance REAL,
  event_type TEXT NOT NULL DEFAULT 'DELIVERY',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  supersedes TEXT REFERENCES deliveries(id),
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  input_json TEXT NOT NULL,
  UNIQUE (innings_id, idempotency_key)
);

-- Only ACTIVE deliveries occupy a sequence slot. A correction supersedes the
-- old row and reuses its sequence, so replay order is always preserved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_innings_sequence_active
  ON deliveries(innings_id, sequence) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_deliveries_innings_active ON deliveries(innings_id, status, sequence);
CREATE INDEX IF NOT EXISTS idx_deliveries_match ON deliveries(match_id, sequence);

CREATE TABLE IF NOT EXISTS batting_scorecards (
  id TEXT PRIMARY KEY,
  innings_id TEXT NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  batting_position INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  balls INTEGER NOT NULL DEFAULT 0,
  fours INTEGER NOT NULL DEFAULT 0,
  sixes INTEGER NOT NULL DEFAULT 0,
  strike_rate REAL NOT NULL DEFAULT 0,
  dismissal_type TEXT,
  dismissal_detail TEXT,
  bowler_id TEXT,
  is_out INTEGER NOT NULL DEFAULT 0,
  is_not_out INTEGER NOT NULL DEFAULT 1,
  UNIQUE (innings_id, player_id)
);

CREATE TABLE IF NOT EXISTS bowling_figures (
  id TEXT PRIMARY KEY,
  innings_id TEXT NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  overs_text TEXT NOT NULL DEFAULT '0.0',
  legal_balls INTEGER NOT NULL DEFAULT 0,
  maidens INTEGER NOT NULL DEFAULT 0,
  runs_conceded INTEGER NOT NULL DEFAULT 0,
  wickets INTEGER NOT NULL DEFAULT 0,
  economy REAL NOT NULL DEFAULT 0,
  wides INTEGER NOT NULL DEFAULT 0,
  no_balls INTEGER NOT NULL DEFAULT 0,
  UNIQUE (innings_id, player_id)
);

CREATE TABLE IF NOT EXISTS partnerships (
  id TEXT PRIMARY KEY,
  innings_id TEXT NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  wicket_number INTEGER NOT NULL,
  player1_id TEXT NOT NULL REFERENCES players(id),
  player2_id TEXT NOT NULL REFERENCES players(id),
  runs INTEGER NOT NULL DEFAULT 0,
  balls INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0,
  end_type TEXT,
  UNIQUE (innings_id, wicket_number)
);

CREATE TABLE IF NOT EXISTS fall_of_wickets (
  id TEXT PRIMARY KEY,
  innings_id TEXT NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  wicket_number INTEGER NOT NULL,
  batter_id TEXT NOT NULL REFERENCES players(id),
  runs INTEGER NOT NULL,
  balls INTEGER NOT NULL,
  over_text TEXT NOT NULL,
  partnership_runs INTEGER NOT NULL,
  partnership_balls INTEGER NOT NULL,
  bowler_id TEXT,
  dismissal_type TEXT NOT NULL,
  UNIQUE (innings_id, wicket_number)
);

-- Transactionally maintained projection of the delivery log. It exists purely
-- for speed: it is always rebuilt from deliveries if it is missing or stale,
-- so it can never disagree with the source of truth.
CREATE TABLE IF NOT EXISTS innings_state_cache (
  innings_id TEXT PRIMARY KEY REFERENCES innings(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  deliveries_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  match_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY CHECK (id = 'local'),
  last_pulled_at TEXT,
  last_pushed_at TEXT,
  remote_cursor TEXT
);

CREATE TABLE IF NOT EXISTS player_career_cache (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  matches INTEGER NOT NULL DEFAULT 0,
  innings INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  balls INTEGER NOT NULL DEFAULT 0,
  highest_score INTEGER NOT NULL DEFAULT 0,
  highest_not_out INTEGER NOT NULL DEFAULT 0,
  not_outs INTEGER NOT NULL DEFAULT 0,
  average REAL NOT NULL DEFAULT 0,
  strike_rate REAL NOT NULL DEFAULT 0,
  fours INTEGER NOT NULL DEFAULT 0,
  sixes INTEGER NOT NULL DEFAULT 0,
  wickets INTEGER NOT NULL DEFAULT 0,
  bowling_average REAL,
  economy REAL,
  best_bowling TEXT,
  catches INTEGER NOT NULL DEFAULT 0,
  run_outs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_applied_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sync_state (id) VALUES ('local');
`;
