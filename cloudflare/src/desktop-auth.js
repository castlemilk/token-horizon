import { boundedText } from './request-body.js';
import { browserIdentity, identityOwnerId, identityOwns, sameOrigin, sessionsConfigured } from './browser-auth.js';

// A browser approves one native request. The native app proves possession of
// its verifier before receiving a credential that only publishes one profile.
const REQUEST_SECONDS = 600, GRANT_SECONDS = 90 * 86400;
const PRIVATE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...PRIVATE, ...headers } });
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validGrant = value => typeof value === 'string' && /^thd_[a-f0-9]{64}$/.test(value);
const validIdentity = identity => ['google', 'github'].includes(identity?.provider) && typeof identity.sub === 'string' && Boolean(identity.sub);
const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const hash = async value => hex(await digest(value));
const challengeFor = async value => btoa(String.fromCharCode(...await digest(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function normalizedHandle(value) {
  if (typeof value !== 'string' || value.length > 66) return '';
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/.test(handle) && !['.', '..'].includes(handle) ? handle : '';
}
function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}
export class DesktopAuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new DesktopAuthError(status, code, message); };
async function r2Stored(env, key) {
  const object = await env.LEADERBOARD_BUCKET.get(key);
  return object ? JSON.parse(await object.text()) : null;
}
const recordOptions = { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } };
async function mirror(env, key, value, expirationTtl) {
  // KV is a TTL mirror; its eventual consistency never decides native auth.
  // A temporary mirror failure must not strand a consent or newly issued grant.
  try { await env.OAUTH_KV.put(key, JSON.stringify(value), { expirationTtl }); } catch {}
}
async function profiles(env) {
  const object = await env.LEADERBOARD_BUCKET.get('leaderboard.json');
  if (!object) return [];
  const entries = JSON.parse(await object.text());
  if (!Array.isArray(entries)) throw new Error('Invalid profile storage');
  return entries;
}
async function decision(env, id) {
  return await r2Stored(env, `desktop-auth/decisions/${id}.json`);
}
async function spent(env, id) {
  return Boolean(await env.LEADERBOARD_BUCKET.get(`desktop-auth/exchanged/${id}.json`));
}
async function removeTicketRecords(env, id) {
  await Promise.all([
    env.LEADERBOARD_BUCKET.delete(`desktop-auth/decisions/${id}.json`),
    env.LEADERBOARD_BUCKET.delete(`desktop-auth/exchanged/${id}.json`)
  ]);
}
const cleanupCursors = new WeakMap();
async function pruneExpiredRecords(env) {
  // Bounded pages rotate through the three private collections so long-lived
  // active grants cannot permanently hide expired records later in the list.
  // Exchange markers remain until their ten-minute ticket can no longer work.
  let cursors = cleanupCursors.get(env.LEADERBOARD_BUCKET);
  if (!cursors) { cursors = {}; cleanupCursors.set(env.LEADERBOARD_BUCKET, cursors); }
  for (const kind of ['requests', 'grants', 'decisions']) {
    const prefix = `desktop-auth/${kind}/`;
    const listed = await env.LEADERBOARD_BUCKET.list({ prefix, limit: 20, ...(cursors[kind] ? { cursor: cursors[kind] } : {}) });
    cursors[kind] = listed.truncated ? listed.cursor : undefined;
    for (const object of listed.objects.slice(0, 20)) {
      const match = /^desktop-auth\/(requests|grants|decisions)\/([a-f0-9]{64})\.json$/.exec(object.key);
      if (!match) continue;
      const record = await r2Stored(env, object.key);
      if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt > Date.now()) continue;
      await env.LEADERBOARD_BUCKET.delete(object.key);
      if (kind === 'decisions') await removeTicketRecords(env, match[2]);
      if (kind === 'requests') await env.OAUTH_KV.delete(`desktop-request:${match[2]}`);
      if (kind === 'grants') await env.OAUTH_KV.delete(`desktop-grant:${match[2]}`);
    }
  }
}
async function ticket(env, id) {
  if (!validId(id)) fail(400, 'invalid_request', 'Start a new connection from Token Horizon.');
  const transaction = await r2Stored(env, `desktop-auth/requests/${id}.json`);
  if (!transaction || !Number.isFinite(transaction.expiresAt) || transaction.expiresAt <= Date.now()) {
    // Only an expired decision allows deletion of the one-use marker.
    const record = await decision(env, id);
    if (record && record.expiresAt <= Date.now()) await removeTicketRecords(env, id);
    fail(410, 'connection_expired', 'This connection expired. Click Sync in Token Horizon to try again.');
  }
  return transaction;
}
async function body(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) fail(400, 'invalid_request', 'Send a JSON connection request.');
  try {
    const parsed = JSON.parse(await boundedText(request, 4096, { timeoutMs: 8000 }));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'invalid_request', 'Send a valid connection request.');
    return parsed;
  } catch (error) {
    if (error instanceof RangeError || error instanceof DesktopAuthError) throw error;
    fail(400, 'invalid_request', 'Send a valid connection request.');
  }
}

// A configured edge limiter supplies global abuse controls. The bounded local
// fallback protects this isolate without persisting IP addresses or secrets.
const localLimits = new Map();
async function rateLimit(request, env, operation) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return;
  const key = `${operation}:${await hash(ip)}`;
  if (env.DESKTOP_AUTH_RATE_LIMIT) {
    if (!(await env.DESKTOP_AUTH_RATE_LIMIT.limit({ key })).success) fail(429, 'rate_limited', 'Too many connection requests. Wait a minute and try again.');
    return;
  }
  const now = Date.now(), maximum = operation === 'start' ? 5 : 120;
  let value = localLimits.get(key);
  if (!value || value.until <= now) {
    value = { count: 0, until: now + 60000 };
    if (localLimits.size >= 1024) localLimits.delete(localLimits.keys().next().value);
    localLimits.set(key, value);
  }
  if (++value.count > maximum) fail(429, 'rate_limited', 'Too many connection requests. Wait a minute and try again.');
}
async function grant(request, env) {
  const token = bearer(request);
  if (!validGrant(token) || !env.OAUTH_KV) fail(401, 'auth_required', 'Your desktop connection expired. Click Sync to sign in again.');
  const tokenHash = await hash(token), key = `desktop-grant:${tokenHash}`;
  // A missing authoritative record includes revocation. Never fall back to a
  // cached KV value, which could resurrect a revoked credential at another edge.
  const r2Key = `desktop-auth/grants/${tokenHash}.json`, value = await r2Stored(env, r2Key);
  if (!value || value.scope !== 'profile:publish' || !validIdentity(value.identity) || !normalizedHandle(value.handle) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) fail(401, 'auth_required', 'Your desktop connection expired. Click Sync to sign in again.');
  return { ...value, key, r2Key };
}

// This seam is called only by the usage publisher. Never let a desktop bearer
// participate in general browser/account management authentication.
export async function desktopPublishIdentity(request, env, handle) {
  if (!bearer(request).toLowerCase().startsWith('thd_')) return null;
  try {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/api/leaderboard', '/leaderboard'].includes(path)) fail(403, 'invalid_scope', 'This desktop connection only publishes usage.');
    const value = await grant(request, env);
    if (!normalizedHandle(handle) || normalizedHandle(handle) !== value.handle) fail(403, 'profile_mismatch', 'Reconnect Token Horizon before publishing a different profile.');
    return { identity: value.identity, handle: value.handle, claimTokenHash: value.claimTokenHash || null };
  } catch (error) {
    if (error instanceof DesktopAuthError) throw error;
    fail(503, 'auth_unavailable', 'Could not verify your desktop connection. Try Sync again.');
  }
}

export async function handleDesktopAuth(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/desktop/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PRIVATE });
  try {
    if (!env.OAUTH_KV || !env.LEADERBOARD_BUCKET) fail(503, 'auth_unavailable', 'Desktop sign-in is not configured. Try again later.');
    if (path === '/api/desktop/start' && request.method === 'POST') {
      if (!sessionsConfigured(env)) fail(503, 'auth_unavailable', 'Account sign-in is not configured.');
      await rateLimit(request, env, 'start');
      const input = await body(request), handle = normalizedHandle(input.handle);
      if (!handle) fail(400, 'invalid_handle', 'Use a profile handle with up to 64 letters, numbers, dots, underscores or hyphens.');
      if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) fail(400, 'invalid_request', 'Start a new connection from Token Horizon.');
      if (input.claimToken !== undefined && (typeof input.claimToken !== 'string' || !input.claimToken || input.claimToken.length > 512 || /[\u0000-\u001f\u007f]/.test(input.claimToken))) fail(400, 'invalid_request', 'The saved profile credential is invalid.');
      const id = random(), expiresAt = Date.now() + REQUEST_SECONDS * 1000;
      const transaction = { challenge: input.challenge, handle, claimTokenHash: input.claimToken ? await hash(input.claimToken) : null, expiresAt };
      await env.LEADERBOARD_BUCKET.put(`desktop-auth/requests/${id}.json`, JSON.stringify(transaction), recordOptions);
      await mirror(env, `desktop-request:${id}`, transaction, REQUEST_SECONDS);
      const cleanup = pruneExpiredRecords(env).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(cleanup); else await cleanup;
      const authorizationUrl = new URL('/connect', url.origin); authorizationUrl.searchParams.set('desktop', id);
      return json({ ok: true, id, authorizationUrl: authorizationUrl.href, expiresAt });
    }
    if (path === '/api/desktop/request' && request.method === 'GET') {
      await rateLimit(request, env, 'request');
      const id = url.searchParams.get('id'), transaction = await ticket(env, id), result = await decision(env, id);
      const status = await spent(env, id) ? 'exchanged' : result?.status || 'pending';
      return json({ ok: true, id, handle: result?.handle || transaction.handle, app: { name: 'Token Horizon', description: 'Publish your usage from this Mac' }, expiresAt: transaction.expiresAt, status });
    }
    if (path === '/api/desktop/approve' && request.method === 'POST') {
      if (!sameOrigin(request)) fail(403, 'invalid_origin', 'Reload this page to connect securely.');
      await rateLimit(request, env, 'approve');
      const input = await body(request), transaction = await ticket(env, input.id);
      if (!['allow', 'deny'].includes(input.decision)) fail(400, 'invalid_request', 'Choose whether to connect Token Horizon.');
      if (await spent(env, input.id) || await decision(env, input.id)) fail(409, 'connection_complete', 'This connection was already completed. Return to Token Horizon.');
      const handle = input.decision === 'deny' ? transaction.handle : normalizedHandle(input.handle === undefined ? transaction.handle : input.handle);
      if (!handle) fail(400, 'invalid_handle', 'Choose a valid profile handle.');
      let claimTokenHash = null, identity = null;
      if (input.decision === 'allow') {
        identity = await browserIdentity(request, env);
        if (!validIdentity(identity)) fail(401, 'auth_required', 'Sign in to connect Token Horizon.');
        const existing = (await profiles(env)).find(entry => String(entry.handle).toLowerCase() === handle);
        if (existing?.claimed && !identityOwns(existing, identity)) fail(403, 'profile_owned', `@${handle} belongs to another account. Choose one of your profiles or a new handle.`);
        if (existing && !existing.claimed) {
          if (handle !== transaction.handle || !existing.claimTokenHash || !equal(existing.claimTokenHash, transaction.claimTokenHash)) fail(403, 'claim_required', `Open this connection from the app that created @${handle}, or choose a new handle.`);
          claimTokenHash = transaction.claimTokenHash;
        }
      }
      const status = input.decision === 'allow' ? 'approved' : 'denied';
      // R2's create condition makes the first human decision authoritative.
      // KV alone cannot provide atomic consent or one-use exchange guarantees.
      const written = await env.LEADERBOARD_BUCKET.put(`desktop-auth/decisions/${input.id}.json`, JSON.stringify({ status, handle, ...(status === 'approved' ? { identity, ownerId: identityOwnerId(identity), claimTokenHash } : {}), expiresAt: transaction.expiresAt }), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      if (!written) fail(409, 'connection_complete', 'This connection was already completed. Return to Token Horizon.');
      return json({ ok: true, status, handle });
    }
    if (path === '/api/desktop/exchange' && request.method === 'POST') {
      await rateLimit(request, env, 'exchange');
      const input = await body(request), transaction = await ticket(env, input.id);
      if (typeof input.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || !equal(await challengeFor(input.verifier), transaction.challenge)) fail(401, 'invalid_verifier', 'Start a new connection from Token Horizon.');
      const result = await decision(env, input.id);
      if (!result) return json({ ok: true, status: 'pending' }, 202, { 'Retry-After': '2' });
      if (result.status === 'denied') fail(403, 'connection_denied', 'Connection cancelled. Click Sync to try again.');
      if (result.status !== 'approved' || !validIdentity(result.identity) || result.ownerId !== identityOwnerId(result.identity) || result.expiresAt <= Date.now()) fail(410, 'connection_expired', 'This connection expired. Click Sync to try again.');
      const marker = await env.LEADERBOARD_BUCKET.put(`desktop-auth/exchanged/${input.id}.json`, JSON.stringify({ expiresAt: transaction.expiresAt }), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      if (!marker) fail(409, 'connection_complete', 'This connection was already used. Click Sync to reconnect.');
      const accessToken = `thd_${random()}`, expiresAt = Date.now() + GRANT_SECONDS * 1000;
      const tokenHash = await hash(accessToken), value = { scope: 'profile:publish', handle: result.handle, identity: result.identity, claimTokenHash: result.claimTokenHash, expiresAt };
      await env.LEADERBOARD_BUCKET.put(`desktop-auth/grants/${tokenHash}.json`, JSON.stringify(value), recordOptions);
      await mirror(env, `desktop-grant:${tokenHash}`, value, GRANT_SECONDS);
      return json({ ok: true, status: 'connected', accessToken, handle: result.handle, user: result.identity, expiresAt });
    }
    if (path === '/api/desktop/revoke' && request.method === 'POST') {
      const value = await grant(request, env);
      await env.LEADERBOARD_BUCKET.delete(value.r2Key);
      // Authority is already revoked even if the TTL mirror cannot be deleted.
      try { await env.OAUTH_KV.delete(value.key); } catch {}
      return json({ ok: true, status: 'disconnected' });
    }
    return json({ ok: false, code: 'not_found', error: 'Desktop connection endpoint not found.' }, 404);
  } catch (error) {
    if (error instanceof DesktopAuthError) return json({ ok: false, code: error.code, error: error.message }, error.status);
    if (error instanceof RangeError) return json({ ok: false, code: 'request_too_large', error: 'Connection request is too large.' }, 413);
    return json({ ok: false, code: 'auth_unavailable', error: 'Could not complete the desktop connection. Try again.' }, 503);
  }
}
