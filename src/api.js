// All /api/* endpoints.
import {
  checkNewPassword,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  rateLimit,
  recordAttempt,
  requireUser,
  sessionCookie,
  verifyPassword,
  COOKIE,
} from './auth.js';
import { db } from './db.js';
import { clearStateCookie, finishLogin, oidcEnabled, oidcName, startLogin } from './oidc.js';
import { aiStatus, generate, voiceStatus, importFromUrl, parseText, readPhotos } from './ai.js';
import { cleanGrocery, cleanRecipe } from './recipes.js';
import { HttpError, clientIp, fail, isEmail, json, now, parseCookies, readJson, sha256, str } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
  );
  routes.push({ method, re, keys, handler });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  try {
    // Block cross-site form posts: browsers always send Origin on these requests.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) fail(403, 'Cross-site request blocked.');
    }
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.handler({ request, env, url, params });
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong on our end. Please try again.' }, 500);
  }
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name };
}

/* ----------------------------- Session & login ---------------------------- */

route('GET', '/api/session', async ({ request, env }) => {
  const user = await currentUser(request, env);
  return json({ user: user ? publicUser(user) : null });
});

route('POST', '/api/login', async ({ request, env }) => {
  const body = await readJson(request);
  const email = str(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  const key = `login:${clientIp(request)}`;
  await rateLimit(env, key, 10, 15 * 60);

  const d = await db(env);
  const user = await d.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await recordAttempt(env, key);
    fail(401, 'That email and password do not match.');
  }
  await d.prepare(`UPDATE users SET last_login_at = ?1 WHERE id = ?2`).bind(now(), user.id).run();
  const cookie = await createSession(env, request, user.id);
  return json({ user: publicUser(user) }, 200, { 'set-cookie': cookie });
});

/* ------------------------- Sign in with Authentik ------------------------ */

// Someone whose provider account has the same email as a Recipe Board login
// signs in to that login. Anyone else the provider lets through gets a new
// login (the provider decides who may use the app), with no password.
const NO_PASSWORD = '!';

function redirect(location, cookies) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

function oidcError(env, err) {
  if (err instanceof HttpError) return err.message;
  console.error(err);
  return `Could not reach ${oidcName(env)}. Please try again.`;
}

route('GET', '/api/oidc/start', async ({ request, env }) => {
  if (!oidcEnabled(env)) fail(404, 'Not found');
  try {
    const { location, cookie } = await startLogin(env, request);
    return redirect(location, [cookie]);
  } catch (err) {
    return redirect(`/login?error=${encodeURIComponent(oidcError(env, err))}`, []);
  }
});

route('GET', '/api/oidc/callback', async ({ request, env, url }) => {
  if (!oidcEnabled(env)) fail(404, 'Not found');
  const clear = clearStateCookie(request);
  let person;
  try {
    person = await finishLogin(env, request, url, parseCookies(request).rb_oidc);
  } catch (err) {
    return redirect(`/login?error=${encodeURIComponent(oidcError(env, err))}`, [clear]);
  }
  const d = await db(env);
  let user = await d.prepare(`SELECT id FROM users WHERE email = ?1`).bind(person.email).first();
  if (!user) {
    const res = await d
      .prepare(`INSERT INTO users (email, name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(person.email, person.name || person.email, NO_PASSWORD, now())
      .run();
    user = { id: res.meta.last_row_id };
  }
  await d.prepare(`UPDATE users SET last_login_at = ?1 WHERE id = ?2`).bind(now(), user.id).run();
  const cookie = await createSession(env, request, user.id);
  return redirect('/', [clear, cookie]);
});

route('POST', '/api/logout', async ({ request, env }) => {
  await destroySession(request, env);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
});

route('POST', '/api/account/password', async ({ request, env }) => {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const d = await db(env);
  const row = await d.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(user.id).first();
  const key = `pw:${user.id}`;
  await rateLimit(env, key, 10, 15 * 60);
  if (!(await verifyPassword(String(body.current || ''), row.password_hash))) {
    await recordAttempt(env, key);
    fail(400, 'Your current password is not correct.');
  }
  checkNewPassword(body.next);
  if (body.next === body.current) fail(400, 'Please choose a new password that is different.');
  await d.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`).bind(await hashPassword(body.next), user.id).run();
  // Sign out other devices but keep this one.
  const token = parseCookies(request)[COOKIE];
  await d
    .prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id != ?2`)
    .bind(user.id, token ? await sha256(token) : '')
    .run();
  return json({ ok: true });
});

// Anyone logged in can give another household member their own login.
// Everyone shares the same recipes and grocery list.
route('GET', '/api/users', async ({ request, env }) => {
  await requireUser(request, env);
  const d = await db(env);
  const { results } = await d.prepare(`SELECT id, email, name FROM users ORDER BY id`).all();
  return json({ users: results.map(publicUser) });
});

route('POST', '/api/users', async ({ request, env }) => {
  await requireUser(request, env);
  const body = await readJson(request);
  const { name, email } = cleanAccount(body);
  checkNewPassword(body.password);
  const d = await db(env);
  const taken = await d.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  if (taken) fail(409, 'Someone already uses that email.');
  await d
    .prepare(`INSERT INTO users (email, name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(email, name, await hashPassword(body.password), now())
    .run();
  return json({ ok: true });
});

route('DELETE', '/api/users/:id', async ({ request, env, params }) => {
  const user = await requireUser(request, env);
  const id = Number(params.id);
  if (id === user.id) fail(400, 'You cannot remove your own login while using it.');
  const d = await db(env);
  await d.prepare(`DELETE FROM users WHERE id = ?1`).bind(id).run();
  return json({ ok: true });
});

function cleanAccount(body) {
  const email = str(body.email, 200).toLowerCase();
  const name = str(body.name, 100);
  if (!name) fail(400, 'Please enter a name.');
  if (!isEmail(email)) fail(400, 'Please enter a valid email.');
  return { name, email };
}

/* --------------------------- First-time setup ------------------------------ */

async function userCount(env) {
  const d = await db(env);
  const row = await d.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  return row?.n || 0;
}

route('GET', '/api/setup', async ({ env }) => {
  return json({
    needsSetup: (await userCount(env)) === 0,
    setupKeyConfigured: !!env.SETUP_KEY,
    oidc: oidcEnabled(env) ? oidcName(env) : null,
  });
});

route('POST', '/api/setup', async ({ request, env }) => {
  if ((await userCount(env)) > 0) fail(403, 'Setup is already complete. Please log in.');
  if (!env.SETUP_KEY) fail(400, 'SETUP_KEY is not configured in Cloudflare yet.');
  const key = `setup:${clientIp(request)}`;
  await rateLimit(env, key, 10, 15 * 60);
  const body = await readJson(request);
  if (String(body.setupKey || '') !== env.SETUP_KEY) {
    await recordAttempt(env, key);
    fail(403, 'Setup key is not correct.');
  }
  const { name, email } = cleanAccount(body);
  checkNewPassword(body.password);
  const d = await db(env);
  const res = await d
    .prepare(`INSERT INTO users (email, name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(email, name, await hashPassword(body.password), now())
    .run();
  const cookie = await createSession(env, request, res.meta.last_row_id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
});

/* -------------------------- Recipes & grocery list ------------------------- */

route('GET', '/api/state', async ({ request, env }) => {
  await requireUser(request, env);
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT coll, id, data FROM docs WHERE coll IN ('recipes', 'grocery') ORDER BY updated_at`)
    .all();
  const out = { recipes: [], grocery: [] };
  for (const row of results) {
    try {
      out[row.coll].push({ ...JSON.parse(row.data), id: row.id });
    } catch {
      // Skip a damaged row rather than failing the whole board.
    }
  }
  return json(out);
});

async function putDoc(env, coll, id, data) {
  const d = await db(env);
  await d
    .prepare(
      `INSERT INTO docs (coll, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(coll, id, JSON.stringify(data), Date.now())
    .run();
}

function checkId(id) {
  if (!ID_RE.test(id)) fail(400, 'That id is not valid.');
  return id;
}

route('PUT', '/api/recipes/:id', async ({ request, env, params }) => {
  await requireUser(request, env);
  const recipe = cleanRecipe(await readJson(request, 64_000));
  await putDoc(env, 'recipes', checkId(params.id), recipe);
  return json({ ok: true });
});

route('DELETE', '/api/recipes/:id', async ({ request, env, params }) => {
  await requireUser(request, env);
  const d = await db(env);
  await d.prepare(`DELETE FROM docs WHERE coll = 'recipes' AND id = ?1`).bind(checkId(params.id)).run();
  return json({ ok: true });
});

route('PUT', '/api/grocery/:key', async ({ request, env, params }) => {
  await requireUser(request, env);
  const item = cleanGrocery(await readJson(request, 32_000));
  await putDoc(env, 'grocery', checkId(params.key), item);
  return json({ ok: true });
});

route('DELETE', '/api/grocery/:key', async ({ request, env, params }) => {
  await requireUser(request, env);
  const d = await db(env);
  await d.prepare(`DELETE FROM docs WHERE coll = 'grocery' AND id = ?1`).bind(checkId(params.key)).run();
  return json({ ok: true });
});

// DELETE /api/grocery?only=bought clears ticked items; without it, the whole list.
route('DELETE', '/api/grocery', async ({ request, env, url }) => {
  await requireUser(request, env);
  const d = await db(env);
  if (url.searchParams.get('only') === 'bought') {
    await d.prepare(`DELETE FROM docs WHERE coll = 'grocery' AND json_extract(data, '$.bought') = 1`).run();
  } else {
    await d.prepare(`DELETE FROM docs WHERE coll = 'grocery'`).run();
  }
  return json({ ok: true });
});

/* ------------------------------------ AI ----------------------------------- */

// Each call returns a draft recipe for the editor; nothing is saved here.
// A daily cap per person keeps usage inside Cloudflare's free AI allowance.
async function aiAllowance(env, user) {
  const key = `ai:${user.id}`;
  await rateLimit(env, key, Number(env.AI_DAILY_LIMIT) || 40, 86400);
  await recordAttempt(env, key);
}

route('GET', '/api/ai/status', async ({ request, env }) => {
  await requireUser(request, env);
  const [ai, voice] = await Promise.all([aiStatus(env), voiceStatus(env)]);
  return json({ ...ai, voice });
});

route('POST', '/api/ai/import', async ({ request, env }) => {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  await aiAllowance(env, user);
  return json(await importFromUrl(env, body.url));
});

route('POST', '/api/ai/parse', async ({ request, env }) => {
  const user = await requireUser(request, env);
  const body = await readJson(request, 40_000);
  await aiAllowance(env, user);
  return json(await parseText(env, body.text));
});

route('POST', '/api/ai/generate', async ({ request, env }) => {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  await aiAllowance(env, user);
  return json(await generate(env, body.prompt));
});

route('POST', '/api/ai/photo', async ({ request, env }) => {
  const user = await requireUser(request, env);
  const body = await readJson(request, 8_000_000);
  await aiAllowance(env, user);
  return json(await readPhotos(env, body.images));
});

/* ---------------------------------- Talk ---------------------------------- */

// Reads text aloud with the home server's voice (server/tts.mjs). The app
// sends a few sentences at a time so playback starts quickly. Without a voice
// server the app falls back to the browser's own voice.
const MAX_SPEECH = 600;

route('POST', '/api/tts', async ({ request, env }) => {
  await requireUser(request, env);
  const body = await readJson(request);
  const text = str(body.text, MAX_SPEECH);
  if (!text) fail(400, 'Nothing to read.');
  if (!env.TTS) fail(503, 'No voice server is set up.');
  let audio;
  try {
    audio = await env.TTS.speak(text);
  } catch (err) {
    console.error('TTS error:', err?.message || err);
    fail(502, `The voice server could not read that. (Details: ${String(err?.message || err).slice(0, 200)})`);
  }
  return new Response(audio.bytes, { headers: { 'content-type': audio.type, 'cache-control': 'no-store' } });
});
