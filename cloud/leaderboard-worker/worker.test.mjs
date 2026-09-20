// Self-tests for the leaderboard Worker. Run:  node --test worker.test.mjs
// No wrangler/miniflare needed: R2 + crypto are stubbed/real (node>=20 has
// webcrypto global, matching the Workers runtime surface we use).
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import handler, {sanitizeEntry, mergeEntry, pruneEntries, sha256Hex} from './worker.js';

function r2Stub(initial = null) {
  let stored = initial;
  return {
    async get() {
      if (stored === null) return null;
      const text = stored;
      return {json: async () => JSON.parse(text), text: async () => text};
    },
    async put(_key, value) {
      stored = typeof value === 'string' ? value : '{}';
    },
    _peek: () => stored,
  };
}

const req = (path, {method = 'GET', headers = {}, body} = {}) =>
  new Request(`https://lb.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('sanitizeEntry', () => {
  it('rejects missing handle', () => {
    assert.equal(sanitizeEntry(null), null);
    assert.equal(sanitizeEntry({}), null);
    assert.equal(sanitizeEntry({handle: '   '}), null);
  });
  it('normalizes handle, numbers, epoch ms', () => {
    const e = sanitizeEntry({handle: '@ben', tokensToday: '1,234', costToday: '$5.5', updatedAt: 1788849564517, isLocal: true});
    assert.equal(e.handle, 'ben');
    assert.equal(e.tokensToday, 1234);
    assert.equal(e.costToday, 5.5);
    assert.equal(e.updatedAt, 1788849564);
    assert.equal(e.isLocal, false);
  });
  it('clamps negatives, caps lengths', () => {
    const e = sanitizeEntry({handle: 'x'.repeat(200), tokensAll: -5});
    assert.equal(e.handle.length, 64);
    assert.equal(e.tokensAll, 0);
  });
});

describe('mergeEntry + pruneEntries', () => {
  it('replaces by id, appends otherwise', () => {
    const a = {id: 'a', handle: 'a', updatedAt: 10};
    const b = {id: 'b', handle: 'b', updatedAt: 20};
    assert.deepEqual(mergeEntry([a], {...a, tokensToday: 5})[0].tokensToday, 5);
    assert.equal(mergeEntry([a], b).length, 2);
  });
  it('prunes stale + caps newest-first', () => {
    const now = 1_800_000_000;
    const old = {id: 'o', handle: 'o', updatedAt: now - 121 * 86400};
    const list = [old, {id: 'n', handle: 'n', updatedAt: now}];
    const out = pruneEntries(list, now);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'n');
  });
});

describe('sha256Hex', () => {
  it('matches known vector', async () => {
    assert.equal(
      await sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('HTTP surface', () => {
  it('GET empty board + ETag/304 round-trip', async () => {
    const env = {LEADERBOARD_BUCKET: r2Stub(), LEADERBOARD_TOKEN: 's3cret'};
    const r1 = await handler.fetch(req('/leaderboard'), env);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('Cache-Control'), /max-age=60/);
    assert.match(r1.headers.get('Cache-Control'), /stale-while-revalidate/);
    const etag = r1.headers.get('ETag');
    assert.ok(etag && etag.length > 10);
    const body = await r1.json();
    assert.deepEqual(body, {leaderboard: [], updatedAt: null, count: 0});
    const r2 = await handler.fetch(req('/leaderboard', {headers: {'If-None-Match': etag}}), env);
    assert.equal(r2.status, 304);
  });

  it('POST requires bearer token', async () => {
    const env = {LEADERBOARD_BUCKET: r2Stub(), LEADERBOARD_TOKEN: 's3cret'};
    const denied = await handler.fetch(req('/leaderboard', {method: 'POST', body: {handle: 'x'}}), env);
    assert.equal(denied.status, 401);
    const wrong = await handler.fetch(
      req('/leaderboard', {method: 'POST', headers: {Authorization: 'Bearer nope'}, body: {handle: 'x'}}), env);
    assert.equal(wrong.status, 401);
  });

  it('POST merges, persists, GET serves with new ETag', async () => {
    const bucket = r2Stub();
    const env = {LEADERBOARD_BUCKET: bucket, LEADERBOARD_TOKEN: 's3cret'};
    const auth = {Authorization: 'Bearer s3cret'};
    const p1 = await handler.fetch(req('/leaderboard', {method: 'POST', headers: auth, body: {handle: 'ben', tokensToday: 100}}), env);
    assert.equal(p1.status, 200);
    assert.equal((await p1.json()).count, 1);
    // Same id updates in place (no dupes).
    const p2 = await handler.fetch(
      req('/leaderboard', {method: 'POST', headers: auth, body: {id: 'remote:ben', handle: 'ben', tokensToday: 150}}), env);
    assert.equal((await p2.json()).count, 1);
    const g = await handler.fetch(req('/leaderboard'), env);
    const body = await g.json();
    assert.equal(body.count, 1);
    assert.equal(body.leaderboard[0].tokensToday, 150);
    assert.equal(body.leaderboard[0].isLocal, false);
  });

  it('POST rejects handle-less entries (422, never zero-filled)', async () => {
    const env = {LEADERBOARD_BUCKET: r2Stub(), LEADERBOARD_TOKEN: 's3cret'};
    const r = await handler.fetch(
      req('/leaderboard', {method: 'POST', headers: {Authorization: 'Bearer s3cret'}, body: {tokensToday: 5}}), env);
    assert.equal(r.status, 422);
  });

  it('CORS preflight + unknown routes + health', async () => {
    const env = {LEADERBOARD_BUCKET: r2Stub(), LEADERBOARD_TOKEN: 's3cret'};
    const pre = await handler.fetch(req('/leaderboard', {method: 'OPTIONS'}), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
    const h = await handler.fetch(req('/health'), env);
    assert.deepEqual(await h.json(), {ok: true, backend: 'r2', entries: 0});
    const nf = await handler.fetch(req('/nope'), env);
    assert.equal(nf.status, 404);
  });

  it('/api/leaderboard filters by team, echoes period', async () => {
    const bucket = r2Stub();
    const env = {LEADERBOARD_BUCKET: bucket, LEADERBOARD_TOKEN: 's3cret'};
    const auth = {Authorization: 'Bearer s3cret'};
    const post = (body) => req('/leaderboard', {method: 'POST', headers: auth, body});
    await handler.fetch(post({handle: 'ben', team: 'acme', tokensToday: 5}), env);
    await handler.fetch(post({handle: 'amy', team: 'other', tokensToday: 9}), env);

    const all = await (await handler.fetch(req('/api/leaderboard?period=week'), env)).json();
    assert.equal(all.total, 2);
    assert.equal(all.period, 'week');

    const filtered = await (await handler.fetch(req('/api/leaderboard?team=ACME'), env)).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.leaderboard[0].handle, 'ben');

    const badPeriod = await (await handler.fetch(req('/api/leaderboard?period=bogus'), env)).json();
    assert.equal(badPeriod.period, 'all');
    assert.ok((await handler.fetch(req('/api/leaderboard'), env)).headers.get('ETag'));
  });
});
