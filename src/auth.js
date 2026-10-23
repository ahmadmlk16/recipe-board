// Passwords, sessions, and login rate limiting.
import { db } from './db.js';
import { b64url, fail, now, parseCookies, randomId, sha256 } from './util.js';

const ITERATIONS = 100_000; // Cloudflare's PBKDF2 maximum
const SESSION_DAYS = 60;
export const COOKIE = 'rb_session';

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, expected] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = b64url(await pbkdf2(password, fromB64url(salt), Number(iter)));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) fail(400, 'Password must be at least 8 characters.');
  if (password.length > 200) fail(400, 'Password is too long.');
}

export async function createSession(env, request, userId) {
  const d = await db(env);
  const token = randomId(32);
  const t = now();
  await d
    .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await sha256(token), userId, t + SESSION_DAYS * 86400, t)
    .run();
  // Tidy up expired sessions and old login attempts now and then.
  await d.batch([
    d.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(t),
    d.prepare(`DELETE FROM attempts WHERE at < ?1`).bind(t - 86400),
  ]);
  return sessionCookie(request, token, SESSION_DAYS * 86400);
}

export function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function currentUser(request, env) {
  const token = parseCookies(request)[COOKIE];
  if (!token || !env.DB) return null;
  const d = await db(env);
  const user = await d
    .prepare(
      `SELECT u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1 AND s.expires_at > ?2`,
    )
    .bind(await sha256(token), now())
    .first();
  return user || null;
}

export async function destroySession(request, env) {
  const token = parseCookies(request)[COOKIE];
  if (!token) return;
  const d = await db(env);
  await d.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(await sha256(token)).run();
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) fail(401, 'Please log in.');
  return user;
}

// Simple sliding-window rate limit stored in D1.
export async function rateLimit(env, key, limit, windowSeconds) {
  const d = await db(env);
  const row = await d
    .prepare(`SELECT COUNT(*) AS n FROM attempts WHERE key = ?1 AND at > ?2`)
    .bind(key, now() - windowSeconds)
    .first();
  if ((row?.n || 0) >= limit) fail(429, 'Too many attempts. Please wait a few minutes and try again.');
}

export async function recordAttempt(env, key) {
  const d = await db(env);
  await d.prepare(`INSERT INTO attempts (key, at) VALUES (?1, ?2)`).bind(key, now()).run();
}
