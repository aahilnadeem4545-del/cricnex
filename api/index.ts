import serverless from 'serverless-http';
import { buildApp } from '../src/api/app';
import { openDatabase } from '../src/db/database';
import { recomputeAllCareers } from '../src/services/stats';

const isVercel = !!process.env.VERCEL;

const dataDir = isVercel ? '/tmp' : (process.env.CRICNEX_DATA_DIR ?? '/tmp');
const backupDir = isVercel ? '/tmp/backups' : (process.env.CRICNEX_BACKUP_DIR ?? '/tmp/backups');
const dbPath = process.env.CRICNEX_DB ?? `${dataDir}/cricnex.db`;

const db = openDatabase(dbPath);

try {
  recomputeAllCareers(db);
} catch (e) {
  console.error('career recompute failed:', e);
}

const app = buildApp({
  db,
  uiDir: undefined,
  backupDir,
  logger: false,
});

// serverless-http wraps the Fastify app into a Vercel-compatible handler.
const handler = serverless(app as any);
export default handler;
