// Local test server that mimics Cloudflare Pages + D1 (+ Workers AI) using only Node 22.
// Usage: node dev/server.mjs  (then open http://localhost:8788, setup key: dev-setup-key)
//        MOCK_AI=1 node dev/server.mjs   answers AI requests with a canned recipe
//        TTS_BASE_URL=http://localhost:7860 TTS_VOICE_FILE=voice.wav node dev/server.mjs
//                                        reads aloud with an Index-TTS WebUI
// Real deployments do not use this file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openD1 } from '../server/d1.mjs';
import { makeTts } from '../server/tts.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = path.join(root, '.dev-data');
fs.mkdirSync(dataDir, { recursive: true });

const DB = openD1(process.env.DEV_DB || path.join(dataDir, 'd1.sqlite'));

const env = { DB, SETUP_KEY: process.env.SETUP_KEY || 'dev-setup-key' };
// "Continue with ..." button: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_NAME,
// and PASSWORD_LOGIN=off to make it the only way in.
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('OIDC_') || k === 'PASSWORD_LOGIN') env[k] = v;

/* --------------------------- Workers AI mock -------------------------- */
if (process.env.MOCK_AI) {
  env.AI = {
    async run(model, { messages, image, prompt }) {
      if (prompt) return { response: 'ok' };
      if (image || Array.isArray(messages.at(-1).content)) {
        // MOCK_VISION_FAIL=1 makes the first vision model fail, to exercise the fallback.
        if (process.env.MOCK_VISION_FAIL && model.includes('llama-4')) throw new Error('5006: mock vision failure');
        return { response: 'CHANA MASALA\nServes 4\n2 cans chickpeas\n1 onion\nFry the onion. Add chickpeas.' };
      }
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

env.TTS = makeTts({ ...process.env, TTS_VOICE_FILE: process.env.TTS_VOICE_FILE || path.join(dataDir, 'voice.wav') }) || undefined;

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
