// A small stand-in for Cloudflare D1 on top of Node's built-in SQLite, so the
// same src/ code runs on a home server. Only the parts of the D1 API the app
// uses are here: prepare().bind().first()/all()/run() and batch().
import { DatabaseSync } from 'node:sqlite';

export function openD1(file) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');

  // D1 rejects undefined and boolean binds; do the same so bugs show up here too.
  const norm = (v) => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined bind');
    if (typeof v === 'boolean') throw new Error('D1_TYPE_ERROR: boolean bind');
    return v;
  };

  class Stmt {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...p) {
      return new Stmt(this.sql, p.map(norm));
    }
    async first(col) {
      const r = sqlite.prepare(this.sql).get(...this.params);
      return r ? (col ? r[col] : { ...r }) : null;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true };
    }
    async run() {
      const r = sqlite.prepare(this.sql).run(...this.params);
      return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    }
  }

  return {
    sqlite,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
