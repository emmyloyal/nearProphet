/**
 * Consistent copy of the database (safe while the bot runs), into ./backups. Keeps the last 14 days.
 * Works on any OS (no sqlite3 binary needed).  Run: npm run backup
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';

const dir = 'backups';
mkdirSync(dir, { recursive: true });
try {
  statSync(config.dbPath);
} catch {
  console.log(`${new Date().toISOString()} no database at ${config.dbPath} yet`);
  process.exit(0);
}
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const out = join(dir, `bot-${stamp}.db`);
const db = new DatabaseSync(config.dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
const cutoff = Date.now() - 14 * 24 * 3_600_000;
for (const f of readdirSync(dir)) if (/^bot-.*\.db$/.test(f) && statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f));
console.log(`${new Date().toISOString()} saved ${out}`);
