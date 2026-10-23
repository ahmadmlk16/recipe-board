// Database setup. Tables are created automatically on first use, so there
// are no migration commands to run when setting up Cloudflare.
import { fail } from './util.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  // Board data is stored as JSON documents, one row each, grouped by
  // collection ("recipes", "grocery"). Future boards (calories, life board
  // tasks) add their own collections here without a schema change.
  `CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (coll, id)
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    key TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, at)`,
];

let ready = null;

export function db(env) {
  if (!env.DB) fail(500, 'Database is not connected yet (missing DB binding).');
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready.then(() => env.DB);
}
