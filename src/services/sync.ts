import type { Db } from '../db/database';
import { scoreDelivery } from './scoring';
import { newId, nowIso, parseJson } from './util';

export interface SyncConfig {
  remoteUrl: string | null;
  deviceId: string;
  enabled: boolean;
}

export interface SyncEvent {
  id: string;
  match_id: string | null;
  entity_type: string;
  entity_id: string;
  op: string;
  payload_json: string;
  version: number;
  created_at: string;
}

export interface SyncStatus {
  deviceId: string;
  remoteUrl: string | null;
  enabled: boolean;
  pending: number;
  synced: number;
  lastPushedAt: string | null;
  lastPulledAt: string | null;
  conflicts: number;
}

export function getSetting(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, value, nowIso(),
  );
}

export function deviceId(db: Db): string {
  let id = getSetting(db, 'device_id');
  if (!id) {
    id = newId();
    setSetting(db, 'device_id', id);
  }
  return id;
}

export function getSyncConfig(db: Db): SyncConfig {
  return {
    deviceId: deviceId(db),
    remoteUrl: getSetting(db, 'sync_remote_url'),
    enabled: getSetting(db, 'sync_enabled') === '1',
  };
}

export function setSyncConfig(db: Db, cfg: Partial<SyncConfig>): SyncConfig {
  if (cfg.remoteUrl !== undefined) setSetting(db, 'sync_remote_url', cfg.remoteUrl ?? '');
  if (cfg.enabled !== undefined) setSetting(db, 'sync_enabled', cfg.enabled ? '1' : '0');
  return getSyncConfig(db);
}

export function pendingEvents(db: Db, limit = 500): SyncEvent[] {
  return db.all<SyncEvent>(
    'SELECT * FROM outbox_events WHERE synced = 0 ORDER BY created_at ASC, rowid ASC LIMIT ?', limit,
  );
}

export function syncStatus(db: Db): SyncStatus {
  const cfg = getSyncConfig(db);
  return {
    ...cfg,
    pending: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_events WHERE synced = 0')?.n ?? 0,
    synced: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_events WHERE synced = 1')?.n ?? 0,
    lastPushedAt: db.get<{ last_pushed_at: string | null }>('SELECT last_pushed_at FROM sync_state WHERE id = ?', 'local')?.last_pushed_at ?? null,
    lastPulledAt: db.get<{ last_pulled_at: string | null }>('SELECT last_pulled_at FROM sync_state WHERE id = ?', 'local')?.last_pulled_at ?? null,
    conflicts: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'SYNC_CONFLICT'")?.n ?? 0,
  };
}

/**
 * Apply events produced by another device. Delivery events are applied through
 * the same idempotent scoring service, so a repeated push can never create a
 * duplicate delivery or double-count a run.
 */
export function applyIncomingEvents(
  db: Db,
  events: SyncEvent[],
  fromDevice: string,
): { applied: number; duplicates: number; conflicts: string[] } {
  let applied = 0;
  let duplicates = 0;
  const conflicts: string[] = [];
  db.transaction(() => {
    for (const event of events) {
      const seen = db.get('SELECT event_id FROM sync_applied_events WHERE event_id = ?', event.id);
      if (seen) { duplicates += 1; continue; }
      try {
        applyEvent(db, event);
        db.run('INSERT INTO sync_applied_events (event_id, device_id, applied_at) VALUES (?,?,?)', event.id, fromDevice, nowIso());
        applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        conflicts.push(`${event.entity_type}:${event.entity_id} -> ${message}`);
        db.run(
          `INSERT INTO audit_logs (id, entity_type, entity_id, action, actor_user_id, reason, after_json, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          newId(), event.entity_type, event.entity_id, 'SYNC_CONFLICT', null, message, event.payload_json, nowIso(),
        );
      }
    }
  });
  return { applied, duplicates, conflicts };
}

function applyEvent(db: Db, event: SyncEvent): void {
  const payload = parseJson<Record<string, unknown>>(event.payload_json, {});
  switch (event.entity_type) {
    case 'delivery': {
      const inningsId = String(payload.inningsId ?? '');
      const input = payload.input as Record<string, unknown> | undefined;
      if (!inningsId || !input) throw new Error('Malformed delivery event');
      const innings = db.get('SELECT id FROM innings WHERE id = ?', inningsId);
      if (!innings) throw new Error(`Innings ${inningsId} not present on this device`);
      scoreDelivery(db, { userId: 'sync', role: 'scorer' }, inningsId, input as never, { deliveryId: event.entity_id });
      return;
    }
    case 'innings': {
      const inningsId = event.entity_id;
      if (db.get('SELECT id FROM innings WHERE id = ?', inningsId)) return;
      const matchId = String(payload.matchId ?? '');
      const match = db.get<{ team_a_id: string; team_b_id: string }>('SELECT team_a_id, team_b_id FROM matches WHERE id = ?', matchId);
      if (!match) throw new Error(`Match ${matchId} not present on this device`);
      const battingTeamId = String(payload.battingTeamId ?? '');
      const bowlingTeamId = battingTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;
      db.run(
        `INSERT INTO innings (id, match_id, innings_number, batting_team_id, bowling_team_id, target, status, started_at, version)
         VALUES (?,?,?,?,?,?, 'in_progress', ?, 0)`,
        inningsId, matchId, Number(payload.inningsNumber ?? 1), battingTeamId, bowlingTeamId,
        payload.target === undefined || payload.target === null ? null : Number(payload.target), nowIso(),
      );
      return;
    }
    case 'match': {
      const matchId = event.entity_id;
      if (!db.get('SELECT id FROM matches WHERE id = ?', matchId)) throw new Error(`Match ${matchId} not present on this device`);
      if (typeof payload.status === 'string') {
        db.run('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?', payload.status, nowIso(), matchId);
      }
      return;
    }
    default:
      throw new Error(`Unsupported entity type ${event.entity_type}`);
  }
}

export interface PushResult {
  pushed: number;
  failed: number;
  conflicts: string[];
  error?: string;
}

export async function pushOutbox(db: Db, opts: { remoteUrl?: string; batchSize?: number } = {}): Promise<PushResult> {
  const cfg = getSyncConfig(db);
  const remoteUrl = opts.remoteUrl ?? cfg.remoteUrl;
  if (!remoteUrl) return { pushed: 0, failed: 0, conflicts: [], error: 'No remote URL configured.' };
  const events = pendingEvents(db, opts.batchSize ?? 200);
  if (events.length === 0) return { pushed: 0, failed: 0, conflicts: [] };
  try {
    const response = await fetch(`${remoteUrl.replace(/\/$/, '')}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: cfg.deviceId, events }),
    });
    if (!response.ok) {
      return { pushed: 0, failed: events.length, conflicts: [], error: `Remote responded ${response.status}` };
    }
    const body = await response.json() as { applied?: number; duplicates?: number; conflicts?: string[] };
    db.transaction(() => {
      for (const event of events) db.run('UPDATE outbox_events SET synced = 1 WHERE id = ?', event.id);
      db.run('UPDATE sync_state SET last_pushed_at = ? WHERE id = ?', nowIso(), 'local');
    });
    return { pushed: body.applied ?? events.length, failed: 0, conflicts: body.conflicts ?? [] };
  } catch (error) {
    return { pushed: 0, failed: events.length, conflicts: [], error: error instanceof Error ? error.message : String(error) };
  }
}
