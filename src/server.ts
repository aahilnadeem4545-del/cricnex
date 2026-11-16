import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from './db/database';
import { buildApp } from './api/app';
import { createBackup, pruneBackups } from './services/backup';
import { recomputeAllCareers } from './services/stats';

const root = resolve(__dirname, '..');
const dataDir = process.env.CRICNEX_DATA_DIR ?? resolve(root, 'data');
const backupDir = process.env.CRICNEX_BACKUP_DIR ?? resolve(root, 'backups');
const dbPath = process.env.CRICNEX_DB ?? resolve(dataDir, 'cricnex.db');
const uiDir = process.env.CRICNEX_UI_DIR ?? resolve(root, 'src', 'ui', 'dist');
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';

const db = openDatabase(dbPath);

// Crash recovery / integrity: verify the database and self-heal the career
// caches from the delivery log before accepting any traffic.
const integrity = db.integrityCheck();
if (integrity !== 'ok') {
  console.error(`[cricnex] DATABASE INTEGRITY PROBLEM: ${integrity}`);
}
try {
  recomputeAllCareers(db);
} catch (error) {
  console.error('[cricnex] career recompute failed (continuing):', error);
}

const app = buildApp({
  db,
  uiDir: existsSync(uiDir) ? uiDir : undefined,
  backupDir,
  logger: process.env.CRICNEX_LOG === '1',
});

// Startup safety backup (kept to a rolling window).
try {
  createBackup(db, backupDir);
  pruneBackups(backupDir, 10);
} catch (error) {
  console.error('[cricnex] startup backup failed (continuing):', error);
}

const shutdown = async (signal: string) => {
  app.log?.info?.(`[cricnex] ${signal} received, shutting down`);
  try {
    await app.close();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.listen({ port, host }).then(() => {
  console.log(`[cricnex] listening on http://${host}:${port}`);
  console.log(`[cricnex] database: ${dbPath}`);
  console.log(`[cricnex] ui: ${existsSync(uiDir) ? uiDir : 'not built (API only)'}`);
}).catch(error => {
  console.error('[cricnex] failed to start:', error);
  process.exit(1);
});
