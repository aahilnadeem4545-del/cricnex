import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL } from './schema';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export class Db {
  readonly raw: DatabaseSync;
  private readonly path: string;
  private depth = 0;

  constructor(path: string) {
    if (path === ':memory:') {
      this.path = ':memory:';
      this.raw = new DatabaseSync(':memory:');
    } else {
      this.path = resolve(path);
      mkdirSync(dirname(this.path), { recursive: true });
      this.raw = new DatabaseSync(this.path);
    }
    this.raw.exec(SCHEMA_SQL);
  }

  get location(): string {
    return this.path;
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.raw.prepare(sql).run(...params) as RunResult;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Nested-safe, atomic transaction using BEGIN IMMEDIATE so writers serialise
   * and a crash mid-way rolls back to the last committed delivery.
   */
  transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    if (isOuter) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT sp_${this.depth}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      if (isOuter) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE sp_${this.depth}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      try {
        if (isOuter) this.raw.exec('ROLLBACK');
        else this.raw.exec(`ROLLBACK TO sp_${this.depth}`);
      } catch {
        /* rollback best effort; surface the original error */
      }
      throw error;
    }
  }

  integrityCheck(): string {
    const row = this.get<{ integrity_check: string }>('PRAGMA integrity_check');
    return row?.integrity_check ?? 'unknown';
  }

  /** Consistent hot backup using SQLite's own VACUUM INTO. */
  backupTo(targetPath: string): void {
    mkdirSync(dirname(resolve(targetPath)), { recursive: true });
    this.raw.exec(`VACUUM INTO '${resolve(targetPath).replace(/'/g, "''")}'`);
  }

  close(): void {
    this.raw.close();
  }

  fileExists(): boolean {
    return this.path === ':memory:' || existsSync(this.path);
  }
}

export function openDatabase(path: string): Db {
  return new Db(path);
}
