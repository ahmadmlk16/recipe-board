// "Continue with Authentik": sign in through an OpenID Connect provider.
// Authorization code flow with PKCE. The ID token comes straight from the
// provider's token endpoint over HTTPS, so its claims are checked (issuer,
// audience, expiry, nonce) but its signature is not (OIDC Core 3.1.3.7).
//
// Settings: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and optionally
// OIDC_NAME (button label), OIDC_REDIRECT_URI (if the public address
// can't be worked out from the request) and PASSWORD_LOGIN=off.
import { b64url, fail, randomId } from './util.js';

const STATE_COOKIE = 'rb_oidc';
const STATE_MAX_AGE = 600; // ten minutes to finish signing in

export function oidcEnabled(env) {
  return !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
}

// PASSWORD_LOGIN=off leaves the provider as the only way in. It only takes
// effect while the provider is set up, so nobody gets locked out.
export function passwordsEnabled(env) {
  return !(oidcEnabled(env) && /^(0|false|off|no)$/i.test(String(env.PASSWORD_LOGIN || '').trim()));
}

// Where people change their provider password, e.g. Authentik's user page.
export function oidcAccountUrl(env) {
  try {
    return new URL(env.OIDC_ISSUER).origin;
  } catch {
    return null;
  }
}

export function oidcName(env) {
  return env.OIDC_NAME || 'Authentik';
}

function issuer(env) {
  return String(env.OIDC_ISSUER).replace(/\/+$/, '');
}

function redirectUri(env, request) {
  return env.OIDC_REDIRECT_URI || `${new URL(request.url).origin}/api/oidc/callback`;
}

let discovery = null; // { issuer, value }

async function discover(env) {
  const iss = issuer(env);
  if (discovery?.issuer === iss) return discovery.value;
  const res = await fetch(`${iss}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!res.ok) fail(502, `Could not reach ${oidcName(env)} (${res.status}).`);
  const value = await res.json();
  if (!value.authorization_endpoint || !value.token_endpoint) fail(502, `${oidcName(env)} sent an unexpected reply.`);
  discovery = { issuer: iss, value };
  return value;
}

function stateCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${STATE_COOKIE}=${value}; Path=/api/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearStateCookie(request) {
  return stateCookie(request, '', 0);
}

// Returns { location, cookie } for the redirect to the provider.
export async function startLogin(env, request) {
  const config = await discover(env);
  const state = randomId(16);
  const nonce = randomId(16);
  const verifier = randomId(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(config.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.OIDC_CLIENT_ID,
    redirect_uri: redirectUri(env, request),
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { location: url.toString(), cookie: stateCookie(request, `${state}.${nonce}.${verifier}`, STATE_MAX_AGE) };
}

function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) fail(502, 'The sign-in reply had no ID token.');
  try {
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    fail(502, 'The sign-in reply could not be read.');
  }
}

// Checks the callback and returns { email, name } of the person who signed in.
export async function finishLogin(env, request, url, cookieValue) {
  const error = url.searchParams.get('error');
  if (error) fail(401, url.searchParams.get('error_description') || 'Sign-in was cancelled.');
  const [state, nonce, verifier] = String(cookieValue || '').split('.');
  const code = url.searchParams.get('code');
  if (!state || !verifier || !code || url.searchParams.get('state') !== state) {
    fail(400, 'That sign-in link expired. Please try again.');
  }

  const config = await discover(env);
  const res = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, request),
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      code_verifier: verifier,
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) fail(401, tokens.error_description || `${oidcName(env)} did not accept the sign-in (${res.status}).`);

  const claims = decodeJwtPayload(tokens.id_token);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const nowSec = Date.now() / 1000;
  if (String(claims.iss || '').replace(/\/+$/, '') !== String(config.issuer || issuer(env)).replace(/\/+$/, '')) {
    fail(401, 'The sign-in came from the wrong place.');
  }
  if (!aud.includes(env.OIDC_CLIENT_ID)) fail(401, 'The sign-in was meant for another app.');
  if (!(claims.exp > nowSec - 60)) fail(401, 'That sign-in expired. Please try again.');
  if (claims.nonce !== nonce) fail(401, 'That sign-in link expired. Please try again.');

  let { email, name } = claims;
  if (!email && tokens.access_token && config.userinfo_endpoint) {
    const info = await fetch(config.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    }).then((r) => (r.ok ? r.json() : {}), () => ({}));
    email = info.email;
    name = name || info.name;
  }
  email = String(email || '').trim().toLowerCase();
  if (!email) fail(401, `Your ${oidcName(env)} account has no email address. Add one there and try again.`);
  name = String(name || claims.preferred_username || email.split('@')[0]).trim().slice(0, 100);
  return { email, name };
}
