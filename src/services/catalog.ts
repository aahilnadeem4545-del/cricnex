import type { Db } from '../db/database';
import { badRequest, conflict, newId, notFound, nowIso } from './util';

export interface TeamInput {
  name: string;
  shortName?: string | null;
  logoUrl?: string | null;
  coach?: string | null;
  captainId?: string | null;
}

export interface PlayerInput {
  fullName: string;
  photoUrl?: string | null;
  jerseyNumber?: number | null;
  battingStyle?: string | null;
  bowlingStyle?: string | null;
  playingRole?: string | null;
  primaryTeamId?: string | null;
}

export function listTeams(db: Db): Array<Record<string, unknown>> {
  return db.all(
    `SELECT t.*, (SELECT COUNT(*) FROM team_players tp WHERE tp.team_id = t.id) AS player_count
     FROM teams t ORDER BY t.name COLLATE NOCASE`,
  );
}

export function getTeam(db: Db, id: string): Record<string, unknown> {
  const team = db.get<Record<string, unknown>>('SELECT * FROM teams WHERE id = ?', id);
  if (!team) throw notFound('Team not found');
  const players = db.all(
    `SELECT p.*, tp.is_captain, tp.is_wicketkeeper FROM players p
     JOIN team_players tp ON tp.player_id = p.id WHERE tp.team_id = ? ORDER BY p.full_name COLLATE NOCASE`,
    id,
  );
  const record = db.get(
    `SELECT COUNT(*) AS played,
       SUM(CASE WHEN winner_team_id = ? THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN result_type IN ('RUNS','WICKETS','INNINGS') AND winner_team_id IS NOT NULL AND winner_team_id != ? THEN 1 ELSE 0 END) AS lost,
       SUM(CASE WHEN result_type = 'TIE' THEN 1 ELSE 0 END) AS tied,
       SUM(CASE WHEN status IN ('NO_RESULT','ABANDONED') THEN 1 ELSE 0 END) AS no_result
     FROM matches WHERE status IN ('COMPLETED','DRAWN','NO_RESULT','ABANDONED') AND (team_a_id = ? OR team_b_id = ?)`,
    id, id, id, id,
  );
  return { ...team, players, record };
}

export function createTeam(db: Db, input: TeamInput): Record<string, unknown> {
  const name = input.name?.trim();
  if (!name) throw badRequest('Team name is required.');
  const dupe = db.get('SELECT id FROM teams WHERE name = ? COLLATE NOCASE', name);
  if (dupe) throw conflict('A team with that name already exists.', 'TEAM_EXISTS');
  const id = newId();
  const ts = nowIso();
  db.run(
    'INSERT INTO teams (id, name, short_name, logo_url, coach, captain_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, name, input.shortName ?? null, input.logoUrl ?? null, input.coach ?? null, input.captainId ?? null, ts, ts,
  );
  return db.get<Record<string, unknown>>('SELECT * FROM teams WHERE id = ?', id)!;
}

export function updateTeam(db: Db, id: string, input: Partial<TeamInput>): Record<string, unknown> {
  const team = db.get<Record<string, unknown>>('SELECT * FROM teams WHERE id = ?', id);
  if (!team) throw notFound('Team not found');
  if (input.name) {
    const dupe = db.get('SELECT id FROM teams WHERE name = ? COLLATE NOCASE AND id != ?', input.name.trim(), id);
    if (dupe) throw conflict('A team with that name already exists.', 'TEAM_EXISTS');
  }
  db.run(
    `UPDATE teams SET name = COALESCE(?, name), short_name = ?, logo_url = ?, coach = ?, captain_id = ?, updated_at = ?
     WHERE id = ?`,
    input.name?.trim() ?? null, input.shortName ?? (team.short_name as string | null),
    input.logoUrl ?? (team.logo_url as string | null), input.coach ?? (team.coach as string | null),
    input.captainId ?? (team.captain_id as string | null), nowIso(), id,
  );
  return db.get<Record<string, unknown>>('SELECT * FROM teams WHERE id = ?', id)!;
}

export function deleteTeam(db: Db, id: string): void {
  const used = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matches WHERE team_a_id = ? OR team_b_id = ?', id, id);
  if ((used?.n ?? 0) > 0) throw conflict('This team is used by existing matches and cannot be deleted.', 'TEAM_IN_USE');
  db.run('DELETE FROM teams WHERE id = ?', id);
}

export function listPlayers(db: Db, opts: { search?: string; teamId?: string; limit?: number; offset?: number } = {}): {
  items: Array<Record<string, unknown>>; total: number;
} {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.search) {
    where.push('(p.full_name LIKE ? OR p.playing_role LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts.teamId) {
    where.push('p.primary_team_id = ?');
    params.push(opts.teamId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM players p ${clause}`, ...params)?.n ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const items = db.all(
    `SELECT p.*, t.name AS team_name,
       (SELECT COUNT(*) FROM team_players tp WHERE tp.player_id = p.id) AS team_count
     FROM players p LEFT JOIN teams t ON t.id = p.primary_team_id
     ${clause} ORDER BY p.full_name COLLATE NOCASE LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  return { items, total };
}

export function getPlayer(db: Db, id: string): Record<string, unknown> {
  const player = db.get<Record<string, unknown>>(
    `SELECT p.*, t.name AS team_name FROM players p LEFT JOIN teams t ON t.id = p.primary_team_id WHERE p.id = ?`, id,
  );
  if (!player) throw notFound('Player not found');
  const career = db.get('SELECT * FROM player_career_cache WHERE player_id = ?', id) ?? null;
  const teams = db.all('SELECT t.* FROM teams t JOIN team_players tp ON tp.team_id = t.id WHERE tp.player_id = ?', id);
  return { ...player, career, teams };
}

export function createPlayer(db: Db, input: PlayerInput): Record<string, unknown> {
  const fullName = input.fullName?.trim();
  if (!fullName) throw badRequest('Player name is required.');
  const id = newId();
  const ts = nowIso();
  db.run(
    `INSERT INTO players (id, full_name, photo_url, jersey_number, batting_style, bowling_style, playing_role, primary_team_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, fullName, input.photoUrl ?? null, input.jerseyNumber ?? null,
    input.battingStyle ?? null, input.bowlingStyle ?? null, input.playingRole ?? null,
    input.primaryTeamId ?? null, ts, ts,
  );
  if (input.primaryTeamId) addPlayerToTeam(db, input.primaryTeamId, id, {});
  return getPlayer(db, id);
}

export function updatePlayer(db: Db, id: string, input: Partial<PlayerInput>): Record<string, unknown> {
  const player = db.get<Record<string, unknown>>('SELECT * FROM players WHERE id = ?', id);
  if (!player) throw notFound('Player not found');
  db.run(
    `UPDATE players SET full_name = COALESCE(?, full_name), photo_url = ?, jersey_number = ?, batting_style = ?,
       bowling_style = ?, playing_role = ?, primary_team_id = ?, updated_at = ? WHERE id = ?`,
    input.fullName?.trim() ?? null, input.photoUrl ?? (player.photo_url as string | null),
    input.jerseyNumber ?? (player.jersey_number as number | null),
    input.battingStyle ?? (player.batting_style as string | null),
    input.bowlingStyle ?? (player.bowling_style as string | null),
    input.playingRole ?? (player.playing_role as string | null),
    input.primaryTeamId ?? (player.primary_team_id as string | null), nowIso(), id,
  );
  return getPlayer(db, id);
}

export function deletePlayer(db: Db, id: string): void {
  const used = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE striker_id = ? OR bowler_id = ? OR non_striker_id = ?', id, id, id);
  if ((used?.n ?? 0) > 0) throw conflict('This player has match records and cannot be deleted.', 'PLAYER_IN_USE');
  db.run('DELETE FROM players WHERE id = ?', id);
}

export function addPlayerToTeam(db: Db, teamId: string, playerId: string, opts: { isCaptain?: boolean; isWicketkeeper?: boolean }): void {
  if (!db.get('SELECT id FROM teams WHERE id = ?', teamId)) throw notFound('Team not found');
  if (!db.get('SELECT id FROM players WHERE id = ?', playerId)) throw notFound('Player not found');
  db.run(
    `INSERT INTO team_players (team_id, player_id, is_captain, is_wicketkeeper, added_at) VALUES (?,?,?,?,?)
     ON CONFLICT(team_id, player_id) DO UPDATE SET is_captain = excluded.is_captain, is_wicketkeeper = excluded.is_wicketkeeper`,
    teamId, playerId, opts.isCaptain ? 1 : 0, opts.isWicketkeeper ? 1 : 0, nowIso(),
  );
  if (opts.isCaptain) db.run('UPDATE teams SET captain_id = ?, updated_at = ? WHERE id = ?', playerId, nowIso(), teamId);
}

export function removePlayerFromTeam(db: Db, teamId: string, playerId: string): void {
  db.run('DELETE FROM team_players WHERE team_id = ? AND player_id = ?', teamId, playerId);
}

/** Head-to-head record between two teams across all completed matches. */
export function headToHead(db: Db, teamAId: string, teamBId: string): Record<string, unknown> {
  const rows = db.all<{ winner_team_id: string | null; result_type: string | null; status: string }>(
    `SELECT winner_team_id, result_type, status FROM matches
     WHERE ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))
       AND status IN ('COMPLETED','DRAWN','NO_RESULT','ABANDONED')`,
    teamAId, teamBId, teamBId, teamAId,
  );
  let aWins = 0, bWins = 0, ties = 0, noResult = 0;
  for (const r of rows) {
    if (r.winner_team_id === teamAId) aWins += 1;
    else if (r.winner_team_id === teamBId) bWins += 1;
    else if (r.result_type === 'TIE') ties += 1;
    else noResult += 1;
  }
  return { played: rows.length, teamAWins: aWins, teamBWins: bWins, ties, noResult };
}
