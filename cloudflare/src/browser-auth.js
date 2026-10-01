import { boundedText } from './request-body.js';

// The browser remembers an opaque token; provider credentials never leave the
// verification exchange or enter browser storage. KV records are keyed by hash.
export const SESSION_COOKIE = '__Host-th-session';
const STATE_COOKIE = '__Host-th-github-state';
const SESSION_SECONDS = 30 * 86400, STATE_SECONDS = 600;
const PRIVATE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const tokenValid = value => /^[a-f0-9]{64}$/.test(value || '');
export const identityOwnerId = identity => `${identity?.provider === 'github' ? 'github' : 'google'}:${identity?.sub || ''}`;
export function identityOwns(entry, identity, { legacyEmail = false } = {}) {
  if (!identity?.sub) return false;
  return entry.ownerId === identityOwnerId(identity) || (legacyEmail && identity.provider !== 'github' && entry.ownerId?.startsWith('google:') && entry.googleEmail && entry.googleEmail === identity.email);
}
export const githubConfigured = env => Boolean(env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
export const sessionsConfigured = env => Boolean(env.OAUTH_KV && (env.GOOGLE_CLIENT_ID || githubConfigured(env)));
export const sameOrigin = request => request.headers.get('Origin') === new URL(request.url).origin;
const safeMethod = request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
export function cookieValue(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { ...PRIVATE, ...headers } });
const result = session => ({ ok: true, authenticated: Boolean(session), user: session?.identity || null, expiresAt: session?.expiresAt || null });
function normalize(identity, provider) {
  const email = String(identity.email || '').toLowerCase().slice(0, 254);
  const picture = String(identity.picture || '');
  return { provider, sub: String(identity.sub), email, name: String(identity.name || '').slice(0, 200), picture: /^https:\/\//.test(picture) ? picture.slice(0, 2048) : '', ...(provider === 'github' ? { login: String(identity.login || '').slice(0, 100) } : {}) };
}
async function stored(env, key) {
  const raw = await env.OAUTH_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export async function browserSession(request, env) {
  if (!env.OAUTH_KV || (!safeMethod(request) && !sameOrigin(request))) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!tokenValid(token)) return null;
  const session = await stored(env, `browser-session:${await hash(token)}`);
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || !['google', 'github'].includes(session.identity?.provider) || !session.identity?.sub) return null;
  return session;
}
export async function browserIdentity(request, env) { return (await browserSession(request, env))?.identity || null; }
async function revokeSession(request, env) {
  const old = cookieValue(request, SESSION_COOKIE);
  if (tokenValid(old)) await env.OAUTH_KV.delete(`browser-session:${await hash(old)}`);
}
async function issueSession(request, env, identity) {
  // Rotate rather than adopt any caller-supplied cookie: no session fixation.
  const token = random(), expiresAt = Date.now() + SESSION_SECONDS * 1000;
  await revokeSession(request, env);
  const session = { identity, expiresAt };
  await env.OAUTH_KV.put(`browser-session:${await hash(token)}`, JSON.stringify(session), { expirationTtl: SESSION_SECONDS });
  return { session, value: cookie(SESSION_COOKIE, token, SESSION_SECONDS) };
}
function safeReturnTo(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/leaderboard';
  const parsed = new URL(value, origin);
  if (parsed.origin !== origin || parsed.pathname.startsWith('/api/auth/')) return '/leaderboard';
  return parsed.pathname + parsed.search + parsed.hash;
}
function callbackUrl(request, env) {
  const url = new URL('/api/auth/github/callback', new URL(request.url).origin);
  // A configured callback cannot route the browser/provider credentials to a
  // different host. Canonical deployment needs no extra redirect setting.
  if (env.GITHUB_REDIRECT_URI && env.GITHUB_REDIRECT_URI !== url.href) throw new Error('Invalid callback configuration');
  return url.href;
}
function redirect(location, cookies = []) {
  const headers = new Headers({ ...PRIVATE, Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
async function boundedJsonFetch(url, init, maxBytes = 65536) {
  const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: abort.signal });
    if (!response.ok) throw new Error('Provider rejected request');
    return JSON.parse(await boundedText(response, maxBytes, { timeoutMs: 8000 }));
  } finally { clearTimeout(deadline); }
}
async function githubIdentity(request, env, code, verifier) {
  if (!code || code.length > 512 || /[\u0000-\u0020]/.test(code)) throw new Error('Invalid code');
  const token = await boundedJsonFetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl(request, env), code_verifier: verifier })
  }, 16384);
  if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 2048 || String(token.token_type).toLowerCase() !== 'bearer') throw new Error('No access token');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'Token-Horizon', 'X-GitHub-Api-Version': '2022-11-28' };
  const profile = await boundedJsonFetch('https://api.github.com/user', { headers });
  const emails = await boundedJsonFetch('https://api.github.com/user/emails?per_page=100', { headers });
  const verified = Array.isArray(emails) && (emails.find(email => email?.verified === true && email.primary === true) || emails.find(email => email?.verified === true));
  if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || !verified || typeof verified.email !== 'string' || !verified.email.includes('@')) throw new Error('Verified identity required');
  const picture = /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url || '') ? profile.avatar_url : '';
  return normalize({ sub: profile.id, email: verified.email, name: profile.name || profile.login, picture, login: profile.login }, 'github');
}

export async function handleBrowserAuth(request, env, { verifyGoogleIdToken }) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    if (path === '/api/auth/session' && request.method === 'GET') {
      const session = await browserSession(request, env);
      // A slow anonymous read may finish after a new sign-in. Reads never
      // mutate cookies, so that older response cannot clear the new session.
      return json(result(session));
    }
    if (['/api/auth/google', '/api/auth/logout'].includes(path) && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ ok: false, code: 'invalid_origin', error: 'Reload this page to sign in securely.' }, 403);
      if (!env.OAUTH_KV) return json({ ok: false, code: 'auth_unavailable', error: 'Remembered sign-in is not configured.' }, 503);
      if (path === '/api/auth/logout') {
        await revokeSession(request, env);
        return json(result(null), 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
      }
      if (!env.GOOGLE_CLIENT_ID) return json({ ok: false, code: 'auth_unavailable', error: 'Google sign-in is not configured.' }, 503);
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ ok: false, code: 'invalid_request', error: 'Send a JSON sign-in request.' }, 400);
      let body;
      try { body = JSON.parse(await boundedText(request, 16384, { timeoutMs: 8000 })); }
      catch (error) {
        if (error instanceof RangeError) throw error;
        return json({ ok: false, code: 'invalid_request', error: 'Send a valid JSON sign-in request.' }, 400);
      }
      const identity = await verifyGoogleIdToken(body?.credential, env);
      if (!identity?.verified) return json({ ok: false, code: 'invalid_credential', error: 'Your Google sign-in expired. Try again.' }, 401);
      const issued = await issueSession(request, env, normalize(identity, 'google'));
      return json(result(issued.session), 200, { 'Set-Cookie': issued.value });
    }
    if (path === '/api/auth/github' && request.method === 'GET') {
      if (!githubConfigured(env)) return json({ ok: false, code: 'auth_unavailable', error: 'GitHub sign-in is not configured.' }, 503);
      const state = random(), verifier = random(), digest = await hash(state);
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'), url.origin);
      await env.OAUTH_KV.put(`github-state:${digest}`, JSON.stringify({ verifier, returnTo, expiresAt: Date.now() + STATE_SECONDS * 1000 }), { expirationTtl: STATE_SECONDS });
      const target = new URL('https://github.com/login/oauth/authorize');
      for (const [key, value] of Object.entries({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: callbackUrl(request, env), scope: 'read:user user:email', state, code_challenge: challenge, code_challenge_method: 'S256' })) target.searchParams.set(key, value);
      return redirect(target.href, [cookie(STATE_COOKIE, state, STATE_SECONDS)]);
    }
    if (path === '/api/auth/github/callback' && request.method === 'GET') {
      const clear = cookie(STATE_COOKIE, '', 0), state = url.searchParams.get('state');
      let transaction = null;
      if (tokenValid(state) && cookieValue(request, STATE_COOKIE) === state && env.OAUTH_KV) {
        const key = `github-state:${await hash(state)}`;
        transaction = await stored(env, key);
        // Consume before contacting the provider, including denial and failure.
        await env.OAUTH_KV.delete(key);
      }
      const destination = new URL(safeReturnTo(transaction?.returnTo, url.origin), url.origin);
      if (!transaction || transaction.expiresAt <= Date.now() || !tokenValid(transaction.verifier) || !githubConfigured(env)) {
        destination.searchParams.set('auth_error', 'expired');
        return redirect(destination.href, [clear]);
      }
      if (url.searchParams.has('error')) {
        destination.searchParams.set('auth_error', 'cancelled');
        return redirect(destination.href, [clear]);
      }
      try {
        const identity = await githubIdentity(request, env, url.searchParams.get('code'), transaction.verifier);
        const issued = await issueSession(request, env, identity);
        destination.searchParams.set('auth', 'success');
        destination.searchParams.delete('auth_error');
        return redirect(destination.href, [clear, issued.value]);
      } catch {
        destination.searchParams.set('auth_error', 'provider_unavailable');
        return redirect(destination.href, [clear]);
      }
    }
    return json({ ok: false, error: 'Authentication endpoint not found.' }, 404);
  } catch (error) {
    return json({ ok: false, code: error instanceof RangeError ? 'request_too_large' : 'auth_unavailable', error: error instanceof RangeError ? 'Sign-in request is too large.' : 'Could not complete sign-in. Try again.' }, error instanceof RangeError ? 413 : 503);
  }
}
