// Loads a Cloudflare D1 export into the home server's database.
//
//   npx wrangler d1 export recipe-board-db --remote --output=d1-backup.sql
//   node server/import-d1.mjs d1-backup.sql            (plain Node)
//   docker exec recipe-board node server/import-d1.mjs /data/d1-backup.sql
//
// Run it before anyone logs in on the new server: it refuses to import into a
// database that already has users or recipes, so nothing gets mixed up.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [sqlFile, dbArg] = process.argv.slice(2);
if (!sqlFile) {
  console.error('Usage: node server/import-d1.mjs <d1-export.sql> [database file]');
  process.exit(1);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dbFile = dbArg || path.join(path.resolve(process.env.DATA_DIR || path.join(root, '.data')), 'recipe-board.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const sqlite = new DatabaseSync(dbFile);
const hasRows = (table) => {
  const exists = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return exists && sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > 0;
};
if (hasRows('users') || hasRows('docs')) {
  console.error(`${dbFile} already has data. Stop the app, move that file aside, and run this again.`);
  process.exit(1);
}

// The app creates empty tables on first request; drop them so the export's
// own CREATE TABLE statements run cleanly. Skip D1's internal _cf_ tables.
const sql = fs
  .readFileSync(sqlFile, 'utf8')
  .split('\n')
  .filter((line) => !/_cf_/.test(line))
  .join('\n');
sqlite.exec('PRAGMA foreign_keys = OFF');
sqlite.exec('BEGIN');
try {
  for (const t of ['sessions', 'attempts', 'docs', 'users']) sqlite.exec(`DROP TABLE IF EXISTS ${t}`);
  sqlite.exec(sql);
  sqlite.exec('COMMIT');
} catch (err) {
  sqlite.exec('ROLLBACK');
  console.error('Import failed, nothing was changed:', err.message);
  process.exit(1);
}
const count = (t) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Imported into ${dbFile}: ${count('users')} logins, ${count('docs')} board items.`);
