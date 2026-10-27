import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from '../server/d1.mjs';
import { handleApi } from '../src/api.js';
import { db } from '../src/db.js';

const ISSUER = 'https://auth.example.com/application/o/recipes/';
const ORIGIN = 'https://recipe.example.com';

function jwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

// A pretend Authentik: discovery plus a token endpoint that checks PKCE.
function fakeProvider(claims) {
  const seen = {};
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === `${ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: 'https://auth.example.com/application/o/authorize/',
        token_endpoint: 'https://auth.example.com/application/o/token/',
      });
    }
    if (url === 'https://auth.example.com/application/o/token/') {
      const body = new URLSearchParams(init.body);
      const challenge = Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier'))),
      ).toString('base64url');
      if (body.get('code') !== 'good-code' || challenge !== seen.challenge || body.get('client_secret') !== 'secret') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      assert.equal(body.get('redirect_uri'), `${ORIGIN}/api/oidc/callback`);
      return Response.json({
        id_token: jwt({ iss: ISSUER, aud: 'rb', exp: Date.now() / 1000 + 300, sub: '1', nonce: seen.nonce, ...claims }),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return seen;
}

// src/db.js sets up one database per process, so the tests share it.
const DB = openD1(':memory:');

function setup() {
  try {
    DB.sqlite.exec(`DELETE FROM sessions; DELETE FROM users`);
  } catch {} // tables not made yet
  return {
    DB,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'rb',
    OIDC_CLIENT_SECRET: 'secret',
  };
}

async function signIn(env, seen, { code = 'good-code', tamperState = false } = {}) {
  const start = await handleApi(new Request(`${ORIGIN}/api/oidc/start`), env);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.origin + auth.pathname, 'https://auth.example.com/application/o/authorize/');
  seen.challenge = auth.searchParams.get('code_challenge');
  seen.nonce = auth.searchParams.get('nonce');
  const stateCookie = start.headers.getSetCookie()[0].split(';')[0];
  const state = tamperState ? 'other' : auth.searchParams.get('state');
  return handleApi(
    new Request(`${ORIGIN}/api/oidc/callback?code=${code}&state=${state}`, { headers: { cookie: stateCookie } }),
    env,
  );
}

function sessionCookie(res) {
  return res.headers.getSetCookie().find((c) => c.startsWith('rb_session=') && !c.includes('Max-Age=0'));
}

test('signing in with the provider joins the login with the same email', async () => {
  const env = setup();
  const seen = fakeProvider({ email: 'Maham@Example.com', name: 'Maham' });
  // An existing password login.
  await db(env); // creates the tables
  await env.DB.prepare(`INSERT INTO users (email, name, password_hash, created_at) VALUES ('maham@example.com', 'M', 'x', 0)`).run();

  const res = await signIn(env, seen);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const cookie = sessionCookie(res);
  assert.ok(cookie, 'sets a session');

  const session = await handleApi(new Request(`${ORIGIN}/api/session`, { headers: { cookie: cookie.split(';')[0] } }), env);
  assert.deepEqual((await session.json()).user, { id: 1, email: 'maham@example.com', name: 'M' });
  const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  assert.equal(n, 1);
});

test('a new person gets a login with no password', async () => {
  const env = setup();
  const seen = fakeProvider({ email: 'new@example.com', name: 'New Person' });
  const res = await signIn(env, seen);
  assert.ok(sessionCookie(res));
  const user = await env.DB.prepare(`SELECT name, password_hash FROM users WHERE email = 'new@example.com'`).first();
  assert.equal(user.name, 'New Person');
  const login = await handleApi(
    new Request(`${ORIGIN}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: '!' }),
    }),
    env,
  );
  assert.equal(login.status, 401, 'no password works for that login');
});

test('a wrong state or code goes back to the login page with a message', async () => {
  const env = setup();
  const seen = fakeProvider({ email: 'a@example.com' });
  for (const opts of [{ tamperState: true }, { code: 'bad-code' }]) {
    const res = await signIn(env, seen, opts);
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?error=/);
    assert.equal(sessionCookie(res), undefined);
  }
});

test('a token for another app or with a wrong nonce is refused', async () => {
  for (const claims of [{ aud: 'other-app' }, { nonce: 'replayed' }, { iss: 'https://evil.example.com/' }]) {
    const env = setup();
    const seen = fakeProvider({ email: 'a@example.com', ...claims });
    const res = await signIn(env, seen);
    assert.match(res.headers.get('location'), /^\/login\?error=/, JSON.stringify(claims));
  }
});

test('the login page learns the button name only when it is set up', async () => {
  const on = await (await handleApi(new Request(`${ORIGIN}/api/setup`), { ...setup(), OIDC_NAME: 'Authentik' })).json();
  assert.equal(on.oidc, 'Authentik');
  const off = await (await handleApi(new Request(`${ORIGIN}/api/setup`), { DB })).json();
  assert.equal(off.oidc, null);
  const start = await handleApi(new Request(`${ORIGIN}/api/oidc/start`), { DB });
  assert.equal(start.status, 404);
});
