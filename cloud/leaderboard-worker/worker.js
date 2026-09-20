/**
 * Token Horizon leaderboard cloud backend — Cloudflare Worker + R2.
 *
 * Zero dependencies. Replaces the Google Sheets backend as the recommended
 * remote: Apps Script cold-starts (5–15s) on every sync are what made the
 * leaderboard feel slow. This serves one small JSON blob from the edge with
 * proper cache headers, so reads are ~50ms and usually edge-cached.
 *
 * API contract (stable — Swift client, MCP, and docs/leaderboard.html rely on it):
 *   GET  /leaderboard  -> { leaderboard: [entry...], updatedAt, count }
 *                         + ETag + `Cache-Control: public, max-age=60,
 *                           stale-while-revalidate=300`. Honors If-None-Match (304).
 *   GET  /api/leaderboard[?period=&team=]
 *                      -> { leaderboard, total, period, updatedAt, count };
 *                         optional server-side team filter; `period` is echoed
 *                         (clients sort locally). Same cache headers.
 *   POST /leaderboard (alias: POST /api/leaderboard)
 *                      <- JSON entry, `Authorization: Bearer <TOKEN>`
 *                      -> { ok: true, id, count }
 *   GET  /health       -> { ok: true, backend: "r2", entries: N }
 *
 * Entry shape mirrors Swift `LeaderboardEntry` (camelCase keys). `updatedAt`
 * is epoch seconds (float ok). Stored entries always get `isLocal: false —
 * locality is a viewer-side concept.
 *
 * Write safety: single-blob read-modify-write. Fine for a team board with a
 * handful of writers publishing every few minutes; concurrent POSTs can
 * theoretically clobber each other (last write wins the merge). Do not use
 * for high-frequency multi-writer telemetry.
 */

const R2_KEY = 'leaderboard/v1.json';
const MAX_ENTRIES = 500;
const PRUNE_AFTER_DAYS = 120;

/* ------------------------------------------------------------------ */
/* Pure helpers (also exercised by worker.test.mjs under plain node).  */
/* ------------------------------------------------------------------ */

/** Normalize/validate an incoming entry. Returns null when unusable. */
export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const handle = String(raw.handle ?? '').replace(/^@+/, '').trim();
  if (!handle) return null;
  const num = (v) => {
    const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  let updatedAt = num(raw.updatedAt ?? raw.updated_at);
  if (updatedAt > 1e12) updatedAt = Math.floor(updatedAt / 1000); // tolerate epoch ms
  if (!updatedAt) updatedAt = Math.floor(Date.now() / 1000);
  return {
    id: String(raw.id ?? `remote:${handle}`).slice(0, 128),
    handle: handle.slice(0, 64),
    team: String(raw.team ?? '').slice(0, 64),
    tokensToday: Math.floor(num(raw.tokensToday)),
    tokens7d: Math.floor(num(raw.tokens7d)),
    tokensAll: Math.floor(num(raw.tokensAll)),
    costToday: num(raw.costToday),
    cost7d: num(raw.cost7d),
    costAll: num(raw.costAll),
    streakDays: Math.floor(num(raw.streakDays)),
    topModel: String(raw.topModel ?? raw.top_model ?? '').slice(0, 128),
    hardware: String(raw.hardware ?? '').slice(0, 128),
    isLocal: false,
    updatedAt,
  };
}

/** Merge one entry into the list (match by id, else append). */
export function mergeEntry(list, entry) {
  const out = Array.isArray(list) ? list.slice() : [];
  const idx = out.findIndex((e) => e && e.id === entry.id);
  if (idx >= 0) out[idx] = entry;
  else out.push(entry);
  return out;
}

/** Drop entries stale beyond PRUNE_AFTER_DAYS and cap length (newest first). */
export function pruneEntries(list, nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = nowSec - PRUNE_AFTER_DAYS * 86400;
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && (e.updatedAt ?? 0) >= cutoff)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_ENTRIES);
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', ...headers},
  });
}

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

async function readBoard(env) {
  const obj = await env.LEADERBOARD_BUCKET.get(R2_KEY);
  if (!obj) return {entries: [], updatedAt: null};
  try {
    const data = await obj.json();
    return {entries: Array.isArray(data.entries) ? data.entries : [], updatedAt: data.updatedAt ?? null};
  } catch {
    return {entries: [], updatedAt: null};
  }
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

async function handleGet(request, env, {api = false} = {}) {
  const {entries, updatedAt} = await readBoard(env);
  let out = entries;
  let team = '';
  let period = 'all';
  if (api) {
    const url = new URL(request.url);
    team = (url.searchParams.get('team') ?? '').trim();
    const rawPeriod = (url.searchParams.get('period') ?? '').trim().toLowerCase();
    if (['today', 'week', 'all', 'streak'].includes(rawPeriod)) period = rawPeriod;
    if (team) {
      const needle = team.toLowerCase();
      out = out.filter((e) => String(e.team ?? '').toLowerCase().includes(needle));
    }
  }
  const body = api
    ? JSON.stringify({leaderboard: out, total: out.length, period, updatedAt, count: out.length})
    : JSON.stringify({leaderboard: out, updatedAt, count: out.length});
  const etag = `"${await sha256Hex(new TextEncoder().encode(body))}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {status: 304, headers: cors({ETag: etag})});
  }
  return new Response(body, {
    headers: cors({
      'Content-Type': 'application/json; charset=utf-8',
      ETag: etag,
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    }),
  });
}

async function handlePost(request, env) {
  const token = env.LEADERBOARD_TOKEN ?? '';
  const auth = request.headers.get('Authorization') ?? '';
  if (!token || auth !== `Bearer ${token}`) {
    return json({error: 'unauthorized'}, 401, cors());
  }
  let raw;
  try {
    raw = await request.json();
  } catch {
    return json({error: 'invalid JSON body'}, 400, cors());
  }
  const entry = sanitizeEntry(raw);
  if (!entry) return json({error: 'entry requires a non-empty handle'}, 422, cors());
  const {entries} = await readBoard(env);
  const merged = pruneEntries(mergeEntry(entries, entry));
  const nowSec = Math.floor(Date.now() / 1000);
  await env.LEADERBOARD_BUCKET.put(
    R2_KEY,
    JSON.stringify({version: 1, updatedAt: nowSec, entries: merged}),
    {httpMetadata: {contentType: 'application/json; charset=utf-8'}}
  );
  return json({ok: true, id: entry.id, count: merged.length}, 200, cors());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors()});
    if (url.pathname === '/health' && request.method === 'GET') {
      let count = 0;
      try {
        count = (await readBoard(env)).entries.length;
      } catch { /* R2 misconfigured -> still report, entries unknown */ }
      return json({ok: true, backend: 'r2', entries: count}, 200, cors());
    }
    if (url.pathname === '/leaderboard' && request.method === 'GET') return handleGet(request, env);
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') return handleGet(request, env, {api: true});
    if (url.pathname === '/leaderboard' && request.method === 'POST') return handlePost(request, env);
    if (url.pathname === '/api/leaderboard' && request.method === 'POST') return handlePost(request, env);
    return json({error: 'not found'}, 404, cors());
  },
};
