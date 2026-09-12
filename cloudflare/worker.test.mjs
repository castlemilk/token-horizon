import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.js';

function mockR2Bucket(initialEntries = null) {
  let stored = initialEntries ? JSON.stringify(initialEntries) : null;
  return {
    async get(key) {
      if (stored === null) return null;
      return {
        json: async () => JSON.parse(stored),
        text: async () => stored
      };
    },
    async put(key, value) {
      stored = typeof value === 'string' ? value : JSON.stringify(value);
    }
  };
}

function createEnv(initialEntries = null) {
  return {
    LEADERBOARD_BUCKET: mockR2Bucket(initialEntries),
    LEADERBOARD_SECRET: ''
  };
}

/// Keyed in-memory R2 stand-in for share/group/avatar tests.
function mockR2Store() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (v && v.bytes) {
        return {
          json: async () => ({}),
          text: async () => "",
          arrayBuffer: async () => v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.byteLength),
          httpMetadata: { contentType: v.contentType }
        };
      }
      return { json: async () => JSON.parse(v), text: async () => v };
    },
    async put(key, value, opts) {
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        store.set(key, { bytes, contentType: (opts && opts.httpMetadata && opts.httpMetadata.contentType) || "application/octet-stream" });
        return;
      }
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  };
}

function createMultiKeyEnv(initialEntries = null) {
  const bucket = mockR2Store();
  if (initialEntries) bucket.put('leaderboard.json', JSON.stringify(initialEntries));
  return { LEADERBOARD_BUCKET: bucket, LEADERBOARD_SECRET: '' };
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

async function makeGoogleKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { keyPair, jwk };
}

async function makeGoogleToken(keyPair, { clientId, kid = 'test-kid', email = 'user@example.com', sub = '12345', aud, iss = 'https://accounts.google.com', exp, iat, picture = '' } = {}) {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify({
    sub, email, email_verified: true, name: 'Test User', picture,
    aud: aud ?? clientId, iss, iat: iat ?? now, exp: exp ?? now + 3600
  })));
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

function createGoogleEnv(clientId, jwk) {
  return {
    LEADERBOARD_BUCKET: mockR2Bucket(),
    LEADERBOARD_SECRET: '',
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_JWKS: JSON.stringify({ keys: [jwk] })
  };
}

const req = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Request(`https://token-horizon.dev${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

describe('Cloudflare Worker API', () => {
  it('GET /api/health returns service status and storage info', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/health'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, 'token-horizon-cloudflare-leaderboard');
    assert.equal(data.storage, 'Cloudflare R2');
  });

  it('GET /api/leaderboard returns ranked participants and KPIs', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/leaderboard?period=today'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.leaderboard));
    assert.ok(data.leaderboard.length > 0);
    assert.equal(data.period, 'today');
    assert.ok(data.kpis.totalTokens > 0);
  });

  it('GET /api/user/:handle returns user details with rank and breakdown', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/user/benebsworth'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.handle, 'benebsworth');
    assert.equal(data.entry.handle, 'benebsworth');
    assert.ok(data.rank >= 1);
    assert.ok(data.ranks.today >= 1);
    assert.ok(data.entry.breakdown);
    assert.ok(Array.isArray(data.entry.breakdown.models));
    assert.ok(Array.isArray(data.entry.breakdown.history));
  });

  it('GET /api/user returns 404 for unknown user', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/user/nonexistent_user_xyz'), env);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.ok, false);
  });

  it('POST /api/leaderboard: anonymous publish issues claimToken and sets claimed=false', async () => {
    const env = createEnv();
    const payload = {
      handle: 'new_anon_dev',
      tokensToday: 1000000,
      tokensAll: 5000000,
      topModel: 'claude-opus-5',
      hardware: 'Apple M5 Max',
      breakdown: {
        models: [{ provider: 'claude', model: 'claude-opus-5', tokensToday: 1000000, tokensAll: 5000000, sharePercent: 100 }],
        tools: [{ tool: 'claude', tokensToday: 1000000, tokensAll: 5000000 }],
        history: [{ day: 7, dayLabel: 'Today', tokens: 1000000, cost: 15 }]
      }
    };

    const res = await worker.fetch(req('/api/leaderboard', { method: 'POST', body: payload }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.handle, 'new_anon_dev');
    assert.equal(data.claimed, false);
    assert.ok(data.claimToken, 'Should issue a secret claim token');

    const claimToken = data.claimToken;

    // Subsequent anonymous update WITH claimToken should succeed
    const updateRes = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'new_anon_dev',
        tokensToday: 2000000,
        tokensAll: 6000000,
        claimToken: claimToken
      }
    }), env);
    assert.equal(updateRes.status, 200);

    // Subsequent anonymous update WITHOUT claimToken should be rejected (403)
    const badRes = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'new_anon_dev',
        tokensToday: 3000000,
        tokensAll: 7000000
      }
    }), env);
    assert.equal(badRes.status, 403);
  });

  it('GET /api/leaderboard exposes leagues, MMR, efficiency, movers, and season', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/leaderboard?period=all'), env);
    const data = await res.json();
    const top = data.leaderboard[0];
    assert.ok(data.season && data.season.displayName, 'season metadata present');
    assert.ok(Array.isArray(data.leagueLadder) && data.leagueLadder.length === 7);
    assert.ok(top.league && top.leagueTitle && top.division >= 1 && top.division <= 3);
    assert.ok(top.mmr > 0);
    assert.ok(typeof top.efficiency === 'number');
    assert.ok(data.movers && Array.isArray(data.movers.gains) && Array.isArray(data.movers.improved));
    assert.ok('totalTokensDelta' in data.kpis);
  });

  it('GET /api/user enriches with standing, achievements, and rank history', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/user/benebsworth'), env);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.standing.league);
    assert.ok(data.standing.mmr > 0);
    assert.ok(Array.isArray(data.achievements));
    assert.ok(Array.isArray(data.rankHistory));
    assert.ok(data.percentile >= 1 && data.percentile <= 100);
    assert.ok(data.entry.league, 'entry carries the derived league');
  });

  it('GET /api/leaderboard aggregates stacked usage-by-model history', async () => {
    const day = Math.floor(Date.now() / 1000 / 86400) - 1;
    const pts = (a, b) => [{ day, dayLabel: 'D1', tokens: a }, { day: day + 1, dayLabel: 'D2', tokens: b }];
    const model = (provider, id) => ({ provider, model: id, tokensToday: 0, tokensAll: 100, costToday: 0, costAll: 0, sharePercent: 100 });
    const env = createMultiKeyEnv([
      { handle: 'a', tokensAll: 100, breakdown: { models: [model('anthropic', 'm1')], tools: [], history: [], daily: [{ day, dayLabel: 'D1', tokens: 5, cost: 0 }], modelHistory: [{ model: 'm1', provider: 'anthropic', points: pts(10, 20) }] } },
      { handle: 'b', tokensAll: 50, breakdown: { models: [model('anthropic', 'm1'), model('openai', 'm2')], tools: [], history: [], modelHistory: [
        { model: 'm1', provider: 'anthropic', points: pts(5, 7) },
        { model: 'm2', provider: 'openai', points: pts(3, 4) }
      ] } }
    ]);
    const res = await worker.fetch(req('/api/leaderboard?period=all'), env);
    const data = await res.json();
    assert.ok(data.usageHistory);
    assert.equal(data.usageHistory.series.length, 2);
    const m1 = data.usageHistory.series.find(s => s.model === 'm1');
    assert.deepEqual(m1.values, [15, 27]);
    // List responses strip the per-entry series (full payloads keep it).
    assert.equal(data.leaderboard[0].entry.breakdown.modelHistory, undefined);
    assert.equal(data.leaderboard[0].entry.breakdown.daily, undefined);
    const userRes = await worker.fetch(req('/api/user/a'), env);
    const userData = await userRes.json();
    assert.ok(Array.isArray(userData.entry.breakdown.daily));
    assert.equal(userData.entry.breakdown.daily.length, 1);
  });

  it('GET /api/leaderboard honors the historyDays window', async () => {
    const end = Math.floor(Date.now() / 1000 / 86400);
    const points = Array.from({ length: 20 }, (_, i) => ({ day: (end - 19 + i) * 86400, dayLabel: 'D' + i, tokens: 100 + i }));
    const model = { provider: 'anthropic', model: 'm1', tokensAll: 1000, tokensToday: 100, costToday: 0, costAll: 0, sharePercent: 100 };
    const env = createMultiKeyEnv([
      { handle: 'h1', tokensAll: 1000, breakdown: { models: [model], tools: [], history: [], modelHistory: [{ model: 'm1', provider: 'anthropic', points }] } }
    ]);
    const short = await (await worker.fetch(req('/api/leaderboard?period=all&historyDays=7'), env)).json();
    assert.equal(short.usageHistory.series[0].values.length, 7);
    const long = await (await worker.fetch(req('/api/leaderboard?period=all&historyDays=20'), env)).json();
    assert.equal(long.usageHistory.series[0].values.length, 20);
  });

  it('GET /api/providers uses exact modelHistory and falls back to snapshots for legacy entries', async () => {
    const end = Math.floor(Date.now() / 1000 / 86400);
    const d1 = end - 1, d2 = end;   // snapshot day indices
    const model = (provider, id) => ({ provider, model: id, tokensAll: 100, tokensToday: 0, costToday: 0, costAll: 0, sharePercent: 100 });
    const env = createMultiKeyEnv([
      { handle: 'exact', tokensAll: 100, breakdown: { models: [model('anthropic', 'm1')], tools: [], history: [], modelHistory: [
        // modelHistory days are epoch seconds
        { model: 'm1', provider: 'anthropic', points: [{ day: d1 * 86400, dayLabel: 'D1', tokens: 10 }, { day: d2 * 86400, dayLabel: 'D2', tokens: 20 }] }
      ] }, snapshots: [{ day: d1, providers: { anthropic: 999 } }, { day: d2, providers: { anthropic: 9999 } }] },
      { handle: 'legacy', tokensAll: 100, snapshots: [
        { day: d1, providers: { openai: 100 } },
        { day: d2, providers: { openai: 150 } }
      ] }
    ]);
    const data = await (await worker.fetch(req('/api/providers?days=7'), env)).json();
    const pts = data.history.points;
    const p1 = pts.find(p => p.day === d1), p2 = pts.find(p => p.day === d2);
    assert.equal(p1.values.anthropic, 10);   // exact values win, snapshots ignored
    assert.equal(p2.values.anthropic, 20);
    assert.equal(p1.values.openai, 100);     // legacy baseline = first cumulative day
    assert.equal(p2.values.openai, 50);      // diffed across the publish gap
  });

  it('POST /api/leaderboard merges history monotonically (fresh window cannot truncate)', async () => {
    const endSec = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const makePoints = (days) => days.map((d, i) => ({ day: d, dayLabel: 'D' + i, tokens: 100 + i }));
    const env = createMultiKeyEnv();
    const first = await (await worker.fetch(req('/api/leaderboard', { method: 'POST', body: {
      handle: 'merge_dev', tokensAll: 5000, tokensToday: 100,
      breakdown: { models: [{ provider: 'anthropic', model: 'm1', tokensAll: 5000, tokensToday: 100, sharePercent: 100 }], tools: [], history: [],
        modelHistory: [{ model: 'm1', provider: 'anthropic', points: makePoints([endSec - 2 * 86400, endSec - 86400]) }],
        daily: [{ day: endSec - 2 * 86400, tokens: 100 }, { day: endSec - 86400, tokens: 200 }] }
    } }), env)).json();
    assert.ok(first.claimToken);
    const second = await (await worker.fetch(req('/api/leaderboard', { method: 'POST', body: {
      handle: 'merge_dev', tokensAll: 6000, tokensToday: 150, claimToken: first.claimToken,
      breakdown: { models: [{ provider: 'anthropic', model: 'm1', tokensAll: 6000, tokensToday: 150, sharePercent: 100 }], tools: [], history: [],
        modelHistory: [{ model: 'm1', provider: 'anthropic', points: makePoints([endSec]) }],
        daily: [{ day: endSec, tokens: 300 }] }
    } }), env)).json();
    assert.equal(second.ok, true);
    const user = await (await worker.fetch(req('/api/user/merge_dev'), env)).json();
    assert.deepEqual(user.entry.breakdown.modelHistory[0].points.map(p => p.day), [endSec - 2 * 86400, endSec - 86400, endSec]);
    assert.deepEqual(user.entry.breakdown.daily.map(p => p.day), [endSec - 2 * 86400, endSec - 86400, endSec]);
  });

  it('GET /api/prompts excludes redacted (title-less) activity rows', async () => {
    const day = Math.floor(Date.now() / 1000 / 86400) - 1;
    const env = createMultiKeyEnv([
      { handle: 'a', tokensAll: 100, breakdown: { models: [{ provider: 'anthropic', model: 'm1', tokensAll: 100, tokensToday: 0, sharePercent: 100 }], tools: [], history: [], sessions: [
        { title: 'Code review assistant', provider: 'anthropic', model: 'm1', tokens: 10, cost: 1, requests: 2, at: day * 86400 },
        { title: '', provider: 'openai', model: 'm2', tokens: 5, cost: 0.5, requests: 1, at: day * 86400 }
      ] } }
    ]);
    const res = await worker.fetch(req('/api/prompts'), env);
    const data = await res.json();
    assert.equal(data.count, 1);
    assert.equal(data.prompts[0].title, 'Code review assistant');
  });

  it('GET /api/providers aggregates provider analytics with history and prompts', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/providers?days=30'), env);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.providers) && data.providers.length > 0);
    assert.ok(data.providers[0].tokens > 0);
    assert.ok('avgCostPerMText' in data.providers[0]);
    assert.ok(data.history && Array.isArray(data.history.points));
    assert.ok(Array.isArray(data.teams));
    assert.ok(Array.isArray(data.topPrompts));
  });

  it('GET /api/season returns ladder, distribution, and standings', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/season'), env);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.ladder.length, 7);
    assert.equal(data.distribution.length, 7);
    assert.ok(Array.isArray(data.standings));
    assert.ok(data.season.displayName.startsWith('Season '));
  });

  it('POST /api/leaderboard stamps a rank snapshot and derives league', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'snapshot_dev',
        tokensAll: 2000000,
        tokensToday: 2000000,
        breakdown: { models: [{ provider: 'claude', model: 'x', tokensAll: 2000000, tokensToday: 2000000, sharePercent: 100 }], tools: [], history: [] }
      }
    }), env);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.entry.league, 'platinum'); // 1M-5M tokens
    assert.ok(data.entry.mmr >= 1200 && data.entry.mmr < 1600);
    assert.equal(data.entry.snapshots.length, 1);
    assert.ok(data.entry.snapshots[0].rank >= 1);
    assert.ok(data.entry.snapshots[0].providers.anthropic > 0);
  });

  it('share records: create requires owner, shared report honors privacy options, revoke works', async () => {
    const env = createMultiKeyEnv();
    // anonymous profile → claim token authorises sharing
    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: { handle: 'share_dev', tokensAll: 3000000, tokensToday: 100000, topModel: 'claude-opus-5' }
    }), env);
    const pubData = await pub.json();
    const claimToken = pubData.claimToken;

    // create without token → 401 with a machine-readable code
    const denied = await worker.fetch(req('/api/share/create', {
      method: 'POST',
      body: { handle: 'share_dev', scope: 'group' }
    }), env);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, 'auth_required');

    // create with token → 200 and a public URL
    const created = await worker.fetch(req('/api/share/create', {
      method: 'POST',
      body: {
        handle: 'share_dev',
        claimToken,
        scope: 'group',
        audience: ['Engineering'],
        options: { hideCost: true, anonymizeNames: true, fullTokenCounts: false },
        expiryDays: 7,
        publicLink: true
      }
    }), env);
    assert.equal(created.status, 200);
    const createdData = await created.json();
    assert.ok(createdData.url.includes('/s/'));
    const shareId = createdData.share.id;

    // list with token
    const listed = await worker.fetch(req('/api/share/list?handle=share_dev', {
      headers: { 'X-Claim-Token': claimToken }
    }), env);
    const listedData = await listed.json();
    assert.equal(listedData.ok, true);
    assert.equal(listedData.shares.length, 1);
    assert.equal(listedData.activity.length, 1);

    // public report hides cost and anonymizes
    const shared = await worker.fetch(req('/api/shared/' + shareId), env);
    const sharedData = await shared.json();
    assert.equal(sharedData.ok, true);
    assert.equal(sharedData.report.handle, 'Anonymous');
    assert.equal(sharedData.report.costAll, undefined);
    assert.equal(sharedData.report.tokensAll % 1000, 0);

    // revoke
    const revoked = await worker.fetch(req('/api/share/revoke', {
      method: 'POST',
      body: { handle: 'share_dev', id: shareId, claimToken }
    }), env);
    assert.equal(revoked.status, 200);
    const afterRevoke = await worker.fetch(req('/api/shared/' + shareId), env);
    assert.equal(afterRevoke.status, 410);
  });

  it('profile avatar: upload stores bytes, serves them, and rejects non-owners', async () => {
    const env = createMultiKeyEnv();
    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST', body: { handle: 'avatar_dev', tokensAll: 1000 }
    }), env);
    const token = (await pub.json()).claimToken;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    // no auth → rejected
    const denied = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST', body: { handle: 'avatar_dev', imageDataUrl: `data:image/png;base64,${png}` }
    }), env);
    assert.ok(denied.status === 401 || denied.status === 403);

    const up = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST',
      body: { handle: 'avatar_dev', claimToken: token, imageDataUrl: `data:image/png;base64,${png}` }
    }), env);
    const upData = await up.json();
    assert.equal(upData.ok, true);
    assert.ok(upData.avatarUrl.startsWith('/api/avatar/avatar_dev'));

    const img = await worker.fetch(new Request('https://token-horizon.dev/api/avatar/avatar_dev'), env);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');

    // clear back to a generated avatar
    const cleared = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST', body: { handle: 'avatar_dev', claimToken: token }
    }), env);
    assert.equal((await cleared.json()).avatarUrl, '');

    // invalid payload
    const bad = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST', body: { handle: 'avatar_dev', claimToken: token, imageDataUrl: 'data:text/plain;base64,aGk=' }
    }), env);
    assert.equal(bad.status, 400);
  });

  it('profile avatar: Google photo is associated for the verified owner', async () => {
    const clientId = 'test-client-id.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);
    const good = await makeGoogleToken(keyPair, { clientId, email: 'photo.user@gmail.com', sub: 'photo-1', picture: 'https://lh3.googleusercontent.com/a/sample' });
    // publish with the Google token to claim the profile (and set picture)
    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      headers: { 'X-Google-Token': good },
      body: { handle: 'photo_dev', tokensAll: 1000 }
    }), env);
    assert.equal((await pub.json()).claimed, true);

    // an unrelated account cannot change the photo
    const attacker = await makeGoogleToken(keyPair, { clientId, email: 'attacker@gmail.com', sub: 'attacker-1' });
    const denied = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST', headers: { 'X-Google-Token': attacker },
      body: { handle: 'photo_dev', useGooglePhoto: true }
    }), env);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'not_owner');

    // a rejected/expired credential gets an actionable 401 (re-auth signal)
    const stale = await worker.fetch(req('/api/share/list?handle=photo_dev', {
      headers: { 'X-Google-Token': 'not.a.jwt' }
    }), env);
    assert.equal(stale.status, 401);
    const staleData = await stale.json();
    assert.equal(staleData.code, 'auth_required');
    assert.ok(staleData.error.includes('expired'));

    const ok = await worker.fetch(req('/api/profile/avatar', {
      method: 'POST', headers: { 'X-Google-Token': good },
      body: { handle: 'photo_dev', useGooglePhoto: true }
    }), env);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).avatarUrl.includes('googleusercontent'));
  });

  it('groups CRUD persists per owner', async () => {
    const env = createMultiKeyEnv();
    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: { handle: 'group_dev', tokensAll: 1000 }
    }), env);
    const token = (await pub.json()).claimToken;

    const create = await worker.fetch(req('/api/groups', {
      method: 'POST',
      body: { handle: 'group_dev', claimToken: token, action: 'create', group: { name: 'Engineering', members: ['alice', 'bob'] } }
    }), env);
    const createdData = await create.json();
    assert.equal(createdData.groups.length, 1);
    assert.equal(createdData.groups[0].members.length, 2);

    const list = await worker.fetch(req('/api/groups?handle=group_dev', { headers: { 'X-Claim-Token': token } }), env);
    const listData = await list.json();
    assert.equal(listData.groups[0].name, 'Engineering');

    const del = await worker.fetch(req('/api/groups', {
      method: 'POST',
      body: { handle: 'group_dev', claimToken: token, action: 'delete', group: { id: listData.groups[0].id } }
    }), env);
    assert.equal((await del.json()).groups.length, 0);
  });

  it('canonicalizes www and legacy hosts to token-horizon.dev (API stays served)', async () => {
    const env = createEnv();
    const legacy = await worker.fetch(new Request('https://tokens.benebsworth.com/leaderboard'), env);
    assert.equal(legacy.status, 301);
    assert.ok(legacy.headers.get('location').startsWith('https://token-horizon.dev/leaderboard'));

    const legacyApi = await worker.fetch(new Request('https://tokens.benebsworth.com/api/health'), env);
    assert.equal(legacyApi.status, 200);

    const www = await worker.fetch(new Request('https://www.token-horizon.dev/leaderboard'), env);
    assert.equal(www.status, 301);
    assert.ok(www.headers.get('location').startsWith('https://token-horizon.dev/leaderboard'));
  });

  it('GET /api/config exposes the public Google client ID', async () => {
    const env = createEnv();
    env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    const res = await worker.fetch(req('/api/config'), env);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.googleClientId, 'test-client-id.apps.googleusercontent.com');
    assert.equal(data.googleAuth, true);
    assert.ok(data.canonicalUrl.startsWith('https://'));
  });

  it('Google ID token: verified RS256 token claims a profile', async () => {
    const clientId = 'test-client-id.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);

    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: { handle: 'oauth_dev', tokensAll: 1000000, tokensToday: 1000000 }
    }), env);
    assert.equal((await pub.json()).claimed, false);

    const token = await makeGoogleToken(keyPair, { clientId, email: 'oauth.user@gmail.com', sub: 'oauth-sub-1' });
    const res = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      headers: { 'X-Google-Token': token },
      body: { handle: 'oauth_dev', tokensAll: 2000000, tokensToday: 2000000 }
    }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.claimed, true);
    assert.equal(data.entry.googleEmail, 'oauth.user@gmail.com');
    // Ownership internals are never echoed back over the wire.
    assert.equal(data.entry.ownerId, undefined);
    assert.equal(data.entry.claimTokenHash, undefined);
  });

  it('Google ID token: tampered, expired, wrong-audience, and shorthand tokens are rejected', async () => {
    const clientId = 'test-client-id.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);

    // Claim a profile with a valid token first.
    await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: { handle: 'locked_dev', tokensAll: 1000, tokensToday: 1000 }
    }), env);
    const good = await makeGoogleToken(keyPair, { clientId, email: 'owner@gmail.com', sub: 'owner-1' });
    await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      headers: { 'X-Google-Token': good },
      body: { handle: 'locked_dev', tokensAll: 2000, tokensToday: 2000 }
    }), env);

    const attempt = async (token) => {
      const res = await worker.fetch(req('/api/leaderboard', {
        method: 'POST',
        headers: { 'X-Google-Token': token },
        body: { handle: 'locked_dev', tokensAll: 9999999, tokensToday: 9999999 }
      }), env);
      return res.status;
    };

    // Tampered payload (signature no longer matches).
    const parts = good.split('.');
    const tampered = `${parts[0]}.${b64url(Buffer.from(JSON.stringify({ sub: 'attacker', email: 'attacker@gmail.com', aud: clientId, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600 })))}.${parts[2]}`;
    assert.equal(await attempt(tampered), 403);

    // Expired.
    const expired = await makeGoogleToken(keyPair, { clientId, exp: Math.floor(Date.now() / 1000) - 60 });
    assert.equal(await attempt(expired), 403);

    // Wrong audience (another app's token).
    const wrongAud = await makeGoogleToken(keyPair, { clientId, aud: 'someone-else.apps.googleusercontent.com' });
    assert.equal(await attempt(wrongAud), 403);

    // Legacy shorthand must not work when a client ID is configured.
    assert.equal(await attempt('google:owner@gmail.com'), 403);

    // The owner's real token still works.
    assert.equal(await attempt(good), 200);
  });

  it('POST /api/claim: claims an unclaimed profile using Google login and locks it', async () => {
    const env = createEnv();
    // First, publish an unclaimed profile
    const pubRes = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'claimable_dev',
        tokensToday: 500000,
        tokensAll: 1000000
      }
    }), env);
    const pubData = await pubRes.json();
    assert.equal(pubData.claimed, false);

    // Now claim it with Google login
    const claimRes = await worker.fetch(req('/api/claim', {
      method: 'POST',
      body: {
        handle: 'claimable_dev',
        claimToken: pubData.claimToken,
        googleUser: {
          email: 'verified.user@gmail.com',
          sub: 'google_123456789',
          name: 'Verified User',
          picture: 'https://lh3.googleusercontent.com/a/sample'
        }
      }
    }), env);

    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.ok, true);
    assert.equal(claimData.entry.claimed, true);
    assert.equal(claimData.entry.googleEmail, 'verified.user@gmail.com');
    assert.equal(claimData.entry.avatarUrl, 'https://lh3.googleusercontent.com/a/sample');

    // Anonymous update on the now-claimed profile must be denied with 403
    const anonRes = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'claimable_dev',
        tokensToday: 999999
      }
    }), env);
    assert.equal(anonRes.status, 403);

    // Update by the Google owner must succeed
    const ownerRes = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: {
        handle: 'claimable_dev',
        tokensToday: 1500000,
        googleUser: {
          email: 'verified.user@gmail.com',
          sub: 'google_123456789'
        }
      }
    }), env);
    assert.equal(ownerRes.status, 200);

    // Another Google user trying to claim the same profile must be denied with 409
    const hijackRes = await worker.fetch(req('/api/claim', {
      method: 'POST',
      body: {
        handle: 'claimable_dev',
        googleUser: {
          email: 'attacker@gmail.com',
          sub: 'google_999999999'
        }
      }
    }), env);
    assert.equal(hijackRes.status, 409);
  });
});
