// Local test server that mimics Cloudflare Pages + D1 (+ Workers AI) using only Node 22.
// Usage: node dev/server.mjs  (then open http://localhost:8788, setup key: dev-setup-key)
//        MOCK_AI=1 node dev/server.mjs   answers AI requests with a canned recipe
// Real deployments do not use this file.
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = path.join(root, '.dev-data');
fs.mkdirSync(dataDir, { recursive: true });

/* ----------------------------- D1 shim ----------------------------- */
const sqlite = new DatabaseSync(process.env.DEV_DB || path.join(dataDir, 'd1.sqlite'));
sqlite.exec('PRAGMA foreign_keys = ON');
const norm = (v) => (v === undefined ? (() => { throw new Error('D1_TYPE_ERROR: undefined bind'); })() : typeof v === 'boolean' ? (() => { throw new Error('D1_TYPE_ERROR: boolean bind'); })() : v);
class Stmt {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.sql, p.map(norm)); }
  async first(col) { const r = sqlite.prepare(this.sql).get(...this.params); return r ? (col ? r[col] : { ...r }) : null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};

const env = { DB, SETUP_KEY: process.env.SETUP_KEY || 'dev-setup-key' };

/* --------------------------- Workers AI mock -------------------------- */
if (process.env.MOCK_AI) {
  env.AI = {
    async run(model, { messages }) {
      const ask = messages.at(-1).content.slice(0, 60);
      return {
        response: {
          name: 'Test chana masala',
          category: 'Dinner',
          minutes: 35,
          servings: 4,
          ingredients: ['2 cans chickpeas, drained', '1 large onion, diced', '3 cloves garlic, minced', '1 tbsp garam masala', '1 can diced tomatoes', '2 tbsp oil', 'salt to taste'],
          steps: ['Fry the onion in oil until golden.', 'Add garlic and garam masala, cook 1 minute.', 'Add tomatoes and chickpeas, simmer 15 minutes.', 'Season with salt.'],
          notes: `Mock answer for: ${ask}`,
          tags: ['indian', 'vegetarian'],
          nutrition: { calories: 320, protein: 12, carbs: 45, fat: 10 },
        },
      };
    },
  };
}

/* ----------------------------- Routing ----------------------------- */
const api = await import(path.join(root, 'functions/api/[[path]].js'));

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

function serveStatic(pathname) {
  const pub = path.join(root, 'public');
  const candidates = [pathname, pathname + '.html', path.join(pathname, 'index.html')];
  for (const c of candidates) {
    const file = path.join(pub, path.normalize(c));
    if (file.startsWith(pub) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    }
  }
  return new Response('Not found', { status: 404 });
}

async function handle(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/')) return api.onRequest({ request, env, params: {}, waitUntil() {} });
  return serveStatic(pathname);
}

const port = Number(process.env.PORT || 8788);
http
  .createServer(async (req, res) => {
    try {
      const url = `http://localhost:${port}${req.url}`;
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const response = await handle(request);
      const headers = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (err) {
      console.error(err);
      res.writeHead(500).end('dev server error');
    }
  })
  .listen(port, () => console.log(`Dev server on http://localhost:${port}`));
