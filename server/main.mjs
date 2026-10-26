// Runs Recipe Board on a home server (Docker on ZimaOS, or plain Node 22+).
// It does what Cloudflare did: serves /public with the headers from
// public/_headers, sends /api/* to src/api.js, and gives that code a D1-style
// database (SQLite file) and an AI binding (see server/ai.mjs).
//
// Settings come from environment variables; see README "Self-hosting".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { openD1 } from './d1.mjs';
import { makeAi } from './ai.mjs';
import { handleApi } from '../src/api.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pub = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const port = Number(process.env.PORT || 8788);
// Only trust X-Forwarded-* / CF-Connecting-IP when a proxy we run (Cloudflare
// Tunnel, Tailscale serve, Caddy) sits in front; otherwise anyone could fake them.
const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const MAX_BODY = 12 * 1024 * 1024; // three phone photos plus JSON overhead

fs.mkdirSync(dataDir, { recursive: true });
const DB = openD1(path.join(dataDir, 'recipe-board.sqlite'));
const env = { ...process.env, DB };
env.AI = makeAi(env) || undefined;

/* ------------------------------ Static files ------------------------------ */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

// public/_headers, in the Cloudflare format: a path pattern, then indented
// "Name: value" lines.
function loadHeaderRules() {
  const rules = [];
  let file;
  try {
    file = fs.readFileSync(path.join(pub, '_headers'), 'utf8');
  } catch {
    return rules;
  }
  for (const line of file.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const re = new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      rules.push({ re, headers: [] });
    } else if (rules.length) {
      const i = line.indexOf(':');
      if (i > 0) rules.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}
const headerRules = loadHeaderRules();

function applyHeaderRules(pathname, headers) {
  for (const rule of headerRules) {
    if (rule.re.test(pathname)) for (const [k, v] of rule.headers) headers.set(k, v);
  }
}

// Same lookups as Workers static assets: /login serves login.html, / serves index.html.
function findFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const c of [decoded, decoded + '.html', path.join(decoded, 'index.html')]) {
    const file = path.join(pub, path.normalize(c));
    if (!file.startsWith(pub + path.sep) || path.basename(file) === '_headers') continue;
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) return { file, stat };
    } catch {}
  }
  return null;
}

function serveStatic(request) {
  const { pathname } = new URL(request.url);
  const headers = new Headers();
  applyHeaderRules(pathname, headers);
  const found = findFile(pathname);
  if (!found) return new Response('Not found', { status: 404, headers });
  const { file, stat } = found;
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  headers.set('etag', etag);
  headers.set('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const body = request.method === 'HEAD' ? null : fs.readFileSync(file);
  return new Response(body, { headers });
}

/* --------------------------------- Server --------------------------------- */

function toRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  if (!trustProxy) {
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-proto');
    headers.set('x-forwarded-for', req.socket.remoteAddress || 'local');
  }
  const proto = (headers.get('x-forwarded-proto') || 'http').split(',')[0].trim();
  const host = headers.get('x-forwarded-host') && trustProxy ? headers.get('x-forwarded-host') : headers.get('host') || `localhost:${port}`;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
}

async function handle(req) {
  if (req.url === '/healthz') return new Response('ok');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return new Response('Too large', { status: 413 });
  const request = toRequest(req);
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/')) return handleApi(request, env);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  return serveStatic(request);
}

const server = http.createServer(async (req, res) => {
  try {
    const response = await handle(req);
    const headers = {};
    response.headers.forEach((v, k) => {
      if (k === 'set-cookie') return;
      headers[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(port, () => {
  const ai = env.AI ? env.AI_PROVIDER || 'cloudflare' : 'off';
  console.log(`Recipe Board on http://0.0.0.0:${port}  data: ${dataDir}  AI: ${ai}`);
  if (!env.SETUP_KEY) console.log('SETUP_KEY is not set; set it to create the first login.');
  env.AI?.check?.().then(
    () => console.log(`AI ready: ${env.AI_MODEL} at ${env.AI_BASE_URL || 'default URL'}`),
    (err) => console.error(`AI check failed: ${err.message}`),
  );
});

function shutdown() {
  server.close(() => {
    DB.sqlite.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
