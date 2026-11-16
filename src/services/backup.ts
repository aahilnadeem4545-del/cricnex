import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../db/database';
import { nowIso } from './util';

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function createBackup(db: Db, dir: string): BackupInfo {
  mkdirSync(resolve(dir), { recursive: true });
  const file = `cricnex-${stamp()}.db`;
  const path = resolve(dir, file);
  db.backupTo(path);
  const stat = statSync(path);
  return { file, path, sizeBytes: stat.size, createdAt: nowIso() };
}

export function listBackups(dir: string): BackupInfo[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const path = resolve(root, f);
      const stat = statSync(path);
      return { file: f, path, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pruneBackups(dir: string, keep = 10): string[] {
  const backups = listBackups(dir);
  const removed: string[] = [];
  for (const b of backups.slice(keep)) {
    unlinkSync(b.path);
    removed.push(b.file);
  }
  return removed;
}

export function backupHealth(db: Db): { integrity: string; journalMode: string; pageCount: number; sizeBytes: number } {
  const journal = db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode ?? 'unknown';
  const pages = db.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0;
  const pageSize = db.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0;
  return {
    integrity: db.integrityCheck(),
    journalMode: journal,
    pageCount: pages,
    sizeBytes: pages * pageSize,
  };
}
