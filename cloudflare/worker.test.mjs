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

/// Keyed in-memory R2 stand-in for share/group tests.
function mockR2Store() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { json: async () => JSON.parse(v), text: async () => v };
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  };
}

function createMultiKeyEnv(initialEntries = null) {
  const bucket = mockR2Store();
  if (initialEntries) bucket.put('leaderboard.json', JSON.stringify(initialEntries));
  return { LEADERBOARD_BUCKET: bucket, LEADERBOARD_SECRET: '' };
}

const req = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Request(`https://tokens.benebsworth.com${path}`, {
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

    // create without token → 401
    const denied = await worker.fetch(req('/api/share/create', {
      method: 'POST',
      body: { handle: 'share_dev', scope: 'group' }
    }), env);
    assert.equal(denied.status, 401);

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
