/** Typed HTTP client for the CRICNEX API, plus the offline delivery queue.
 *
 *  The queue is deliberately small and honest: when the network is unavailable
 *  a scored delivery is persisted locally (with its idempotency key) and
 *  replayed, in order, once connectivity returns. The server dedupes on the
 *  idempotency key, so a replayed ball can never be double counted. */

import type { DeliveryInput } from './types';

const TOKEN_KEY = 'cricnex.token';
const USER_KEY = 'cricnex.user';
const QUEUE_KEY = 'cricnex.outbox';
const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void { onUnauthorized = fn; }

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getStoredUser(): unknown {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function setStoredUser(user: unknown): void {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Internal: set when replaying a queued request so failures do not recurse. */
  signal?: AbortSignal;
}

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(0, 'Network unavailable', 'NETWORK');
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  }
  if (!response.ok) {
    const err = (payload ?? {}) as { error?: string; code?: string };
    if (response.status === 401) { setToken(null); setStoredUser(null); onUnauthorized?.(); }
    throw new ApiError(response.status, err.error || `Request failed (${response.status})`, err.code || 'ERROR');
  }
  return payload as T;
}

/* ------------------------------- endpoints ------------------------------- */

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; expiresAt: string; user: unknown }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: unknown }>('/auth/me'),

  dashboard: () => request('/dashboard'),

  teams: () => request<{ teams: unknown[] }>('/teams'),
  team: (id: string) => request<{ team: unknown }>(`/teams/${id}`),
  createTeam: (body: unknown) => request('/teams', { method: 'POST', body }),
  updateTeam: (id: string, body: unknown) => request(`/teams/${id}`, { method: 'PATCH', body }),
  deleteTeam: (id: string) => request(`/teams/${id}`, { method: 'DELETE' }),
  addTeamPlayer: (id: string, body: unknown) => request(`/teams/${id}/players`, { method: 'POST', body }),
  removeTeamPlayer: (id: string, playerId: string) => request(`/teams/${id}/players/${playerId}`, { method: 'DELETE' }),
  headToHead: (id: string, otherId: string) => request(`/teams/${id}/head-to-head/${otherId}`),

  players: (query = '') => request<{ items: unknown[]; total: number }>(`/players${query}`),
  player: (id: string) => request<{ player: unknown }>(`/players/${id}`),
  createPlayer: (body: unknown) => request('/players', { method: 'POST', body }),
  updatePlayer: (id: string, body: unknown) => request(`/players/${id}`, { method: 'PATCH', body }),
  deletePlayer: (id: string) => request(`/players/${id}`, { method: 'DELETE' }),

  formats: () => request<{ presets: Record<string, unknown> }>('/formats'),
  matches: (query = '') => request<{ items: unknown[]; total: number }>(`/matches${query}`),
  match: (id: string) => request(`/matches/${id}`),
  live: (id: string) => request<{ live: unknown }>(`/matches/${id}/live`),
  matchStats: (id: string) => request<{ stats: unknown }>(`/matches/${id}/stats`),
  validateMatch: (id: string) => request<{ ok: boolean; problems: string[] }>(`/matches/${id}/validate`),
  createMatch: (body: unknown) => request('/matches', { method: 'POST', body }),
  recordToss: (id: string, body: unknown) => request(`/matches/${id}/toss`, { method: 'POST', body }),
  setSquad: (id: string, body: unknown) => request(`/matches/${id}/squads`, { method: 'POST', body }),
  startInnings: (id: string, body: unknown) => request(`/matches/${id}/innings`, { method: 'POST', body }),
  abandonMatch: (id: string, body: unknown) => request(`/matches/${id}/abandon`, { method: 'POST', body }),
  finalizeMatch: (id: string) => request(`/matches/${id}/finalize`, { method: 'POST' }),
  setPlayerOfMatch: (id: string, playerId: string) => request(`/matches/${id}/player-of-match`, { method: 'PATCH', body: { playerId } }),

  innings: (id: string) => request<{ innings: unknown; state: unknown; scorecard: unknown }>(`/innings/${id}`),
  inningsStats: (id: string) => request<{ statistics: Record<string, unknown> }>(`/innings/${id}/statistics`),
  deliveries: (id: string) => request<{ deliveries: unknown[] }>(`/innings/${id}/deliveries`),
  setOpeners: (id: string, body: unknown) => request(`/innings/${id}/openers`, { method: 'POST', body }),
  undo: (id: string, reason = 'Undo last delivery') => request(`/innings/${id}/undo`, { method: 'POST', body: { reason } }),
  declare: (id: string) => request(`/innings/${id}/declare`, { method: 'POST' }),
  reopen: (id: string) => request(`/innings/${id}/reopen`, { method: 'POST' }),
  editDelivery: (deliveryId: string, body: unknown) => request(`/deliveries/${deliveryId}`, { method: 'PATCH', body }),

  tournaments: () => request<{ tournaments: unknown[] }>('/tournaments'),
  tournament: (id: string) => request(`/tournaments/${id}`),
  createTournament: (body: unknown) => request('/tournaments', { method: 'POST', body }),
  addTournamentTeams: (id: string, body: unknown) => request(`/tournaments/${id}/teams`, { method: 'POST', body }),
  generateFixtures: (id: string, body: unknown) => request(`/tournaments/${id}/fixtures/generate`, { method: 'POST', body }),
  recomputePoints: (id: string) => request(`/tournaments/${id}/recompute`, { method: 'POST' }),

  leaderboards: (limit = 20) => request<{ batting: unknown[]; bowling: unknown[] }>(`/stats/leaderboards?limit=${limit}`),
  recomputeStats: () => request('/stats/recompute', { method: 'POST' }),

  syncStatus: () => request('/sync/status'),
  syncRun: () => request('/sync/run', { method: 'POST', body: {} }),
  health: () => request('/system/health'),
  backups: () => request('/backups'),
  createBackup: () => request('/backups', { method: 'POST', body: {} }),
  settings: () => request('/settings'),
  users: () => request<{ users: unknown[] }>('/users'),
  createUser: (body: unknown) => request('/users', { method: 'POST', body }),
  updateUserRole: (id: string, role: string) => request(`/users/${id}/role`, { method: 'PATCH', body: { role } }),
};

/* ---------------------------- offline delivery queue ---------------------------- */

export interface QueuedDelivery {
  id: string;
  inningsId: string;
  input: DeliveryInput;
  createdAt: string;
}

function readQueue(): QueuedDelivery[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedDelivery[]) : [];
  } catch { return []; }
}

function writeQueue(items: QueuedDelivery[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  emitQueue();
}

type QueueListener = (count: number) => void;
const listeners = new Set<QueueListener>();
function emitQueue(): void {
  const n = readQueue().length;
  for (const fn of listeners) fn(n);
}
export function onQueueChange(fn: QueueListener): () => void {
  listeners.add(fn);
  fn(readQueue().length);
  return () => listeners.delete(fn);
}
export function queueSize(): number { return readQueue().length; }
export function queuedFor(inningsId: string): QueuedDelivery[] {
  return readQueue().filter((q) => q.inningsId === inningsId);
}

export function newIdempotencyKey(): string {
  const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return `ui-${rnd}`;
}

export interface DeliveryOutcome {
  queued: boolean;
  offline: boolean;
}

/** Score a delivery. On a network failure it is queued locally and replayed later. */
export async function postDelivery(inningsId: string, input: DeliveryInput): Promise<DeliveryOutcome> {
  try {
    await request(`/innings/${inningsId}/deliveries`, { method: 'POST', body: input });
    return { queued: false, offline: false };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NETWORK') {
      const queue = readQueue();
      queue.push({ id: input.idempotencyKey, inningsId, input, createdAt: new Date().toISOString() });
      writeQueue(queue);
      return { queued: true, offline: true };
    }
    throw error;
  }
}

/** Remove the most recently queued delivery for an innings (local undo). */
export function dequeueLast(inningsId: string): boolean {
  const queue = readQueue();
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].inningsId === inningsId) {
      queue.splice(i, 1);
      writeQueue(queue);
      return true;
    }
  }
  return false;
}

export interface FlushResult { flushed: number; remaining: number; errors: string[]; }

/** Replay queued deliveries in order. Stops at the first network failure. */
export async function flushQueue(): Promise<FlushResult> {
  const queue = readQueue();
  const errors: string[] = [];
  let flushed = 0;
  while (queue.length > 0) {
    const item = queue[0];
    try {
      await request(`/innings/${item.inningsId}/deliveries`, { method: 'POST', body: item.input });
      queue.shift();
      flushed += 1;
      writeQueue([...queue]);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NETWORK') break; // still offline
      // A validation/conflict error means this ball can never apply; drop it and report.
      queue.shift();
      errors.push(error instanceof Error ? error.message : String(error));
      writeQueue([...queue]);
    }
  }
  return { flushed, remaining: queue.length, errors };
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}
