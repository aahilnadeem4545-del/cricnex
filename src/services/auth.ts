import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/database';
import { conflict, forbidden, HttpError, newId, nowIso, notFound } from './util';

export type Role = 'admin' | 'scorer' | 'viewer';

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

const SESSION_HOURS = 12;

function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const useSalt = salt ?? randomBytes(16).toString('hex');
  const derived = scryptSync(password, useSalt, 64).toString('hex');
  return { salt: useSalt, hash: derived };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createUser(db: Db, username: string, password: string, displayName: string, role: Role): User {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-32 characters (letters, numbers, . _ -).', 'INVALID_USERNAME');
  }
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.', 'WEAK_PASSWORD');
  const exists = db.get('SELECT id FROM users WHERE username = ?', username);
  if (exists) throw conflict('That username is already taken.', 'USERNAME_TAKEN');
  const { salt, hash } = hashPassword(password);
  const id = newId();
  const ts = nowIso();
  db.run(
    'INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    id, username, displayName, `${salt}:${hash}`, role, ts, ts,
  );
  return db.get<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?', id)!;
}

export function setPassword(db: Db, userId: string, password: string): void {
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.', 'WEAK_PASSWORD');
  const { salt, hash } = hashPassword(password);
  db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', `${salt}:${hash}`, nowIso(), userId);
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function verifyLogin(db: Db, username: string, password: string): User {
  const row = db.get<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE username = ?', username,
  );
  if (!row) throw new HttpError(401, 'Invalid username or password.', 'BAD_CREDENTIALS');
  const [salt, expected] = row.password_hash.split(':');
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected ?? '', 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'Invalid username or password.', 'BAD_CREDENTIALS');
  }
  return db.get<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?', row.id)!;
}

export function createSession(db: Db, user: User): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  db.run(
    'INSERT INTO sessions (token, user_id, role, expires_at, created_at) VALUES (?,?,?,?,?)',
    tokenHash(token), user.id, user.role, expiresAt, nowIso(),
  );
  return { token, expiresAt };
}

export function authenticate(db: Db, token: string | undefined): User | null {
  if (!token) return null;
  const row = db.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?', tokenHash(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.run('DELETE FROM sessions WHERE token = ?', tokenHash(token));
    return null;
  }
  return db.get<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?', row.user_id) ?? null;
}

export function logout(db: Db, token: string | undefined): void {
  if (!token) return;
  db.run('DELETE FROM sessions WHERE token = ?', tokenHash(token));
}

export function listUsers(db: Db): User[] {
  return db.all<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users ORDER BY username');
}

export function updateUserRole(db: Db, actorId: string, userId: string, role: Role): User {
  const user = db.get<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?', userId);
  if (!user) throw notFound('User not found');
  if (user.id === actorId && role !== 'admin') throw forbidden('You cannot remove your own admin role.');
  db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', role, nowIso(), userId);
  return { ...user, role };
}

export function deleteUser(db: Db, actorId: string, userId: string): void {
  if (actorId === userId) throw forbidden('You cannot delete your own account.');
  const remainingAdmins = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?", userId);
  const target = db.get<User>('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?', userId);
  if (!target) throw notFound('User not found');
  if (target.role === 'admin' && (remainingAdmins?.n ?? 0) === 0) {
    throw forbidden('At least one admin must remain.');
  }
  db.run('DELETE FROM users WHERE id = ?', userId);
}

export function ensureBootstrapAdmin(db: Db, username = 'admin', password = 'cricnex-admin'): void {
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  if ((count?.n ?? 0) > 0) return;
  createUser(db, username, password, 'Administrator', 'admin');
}
