import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './src/index.js';
import { updateProfileEntries, ProfileStorageError } from './src/leaderboard-storage.js';

const origin = 'https://token-horizon.dev';
const secret = 'fixture-write-secret';
const today = Math.floor(Date.now() / 86400000) * 86400;
const firstDay = today - 2 * 86400, secondDay = today - 86400;

// Capture both bytes and ETag at get(), as R2 does. A barrier deliberately lets
// two handlers read the same version before either conditional write proceeds.
function versionedR2(initial = []) {
  const objects = new Map(), versions = new Map();
  const stats = { writes: 0, puts: 0, conflicts: 0, conditions: [] };
  let barrier, hook;
  function seed(key, value, metadata = {}) {
    objects.set(key, { value, metadata });
    versions.set(key, (versions.get(key) || 0) + 1);
  }
  if (initial !== null) seed('leaderboard.json', JSON.stringify(initial));
  const bucket = {
    stats,
    read() { const value = objects.get('leaderboard.json')?.value; return value === undefined ? null : JSON.parse(value); },
    inject(entries) { seed('leaderboard.json', JSON.stringify(entries)); },
    seed,
    beforeNextWrite(callback) { hook = callback; },
    barrier(count = 2) {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      barrier = { left: count, promise, release };
    },
    async get(key) {
      const object = objects.get(key), etag = String(versions.get(key));
      if (key === 'leaderboard.json' && barrier) {
        const active = barrier;
        if (--active.left === 0) { barrier = null; active.release(); }
        await active.promise;
      }
      if (!object) return null;
      return {
        etag,
        text: async () => typeof object.value === 'string' ? object.value : new TextDecoder().decode(object.value),
        json: async () => JSON.parse(object.value),
        arrayBuffer: async () => new Uint8Array(object.value).buffer,
        httpMetadata: object.metadata,
      };
    },
    async put(key, value, options = {}) {
      if (key === 'leaderboard.json') {
        stats.puts++;
        stats.conditions.push(options.onlyIf);
        assert(options.onlyIf, 'Every profile write must be conditional');
        if (hook) { const callback = hook; hook = null; await callback(bucket); }
      }
      const condition = options.onlyIf;
      if ((condition?.etagDoesNotMatch === '*' && objects.has(key)) ||
          (condition?.etagMatches !== undefined && condition.etagMatches !== String(versions.get(key)))) {
        if (key === 'leaderboard.json') stats.conflicts++;
        return null;
      }
      seed(key, value, options.httpMetadata);
      if (key === 'leaderboard.json') stats.writes++;
      return { etag: String(versions.get(key)) };
    },
    async list({ prefix = '' } = {}) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async delete(key) { objects.delete(key); versions.delete(key); },
  };
  return bucket;
}

function entry(handle, day = firstDay, tokens = 10, extra = {}) {
  return {
    id: 'fixture:' + handle, handle, tokensAll: 500, tokens7d: 500, tokensToday: 0,
    claimed: false, updatedAt: today, streakDays: 1,
    breakdown: {
      models: [{ provider: 'openai', model: 'A', tokensAll: 500 }],
      history: [{ day, tokens, cost: 1 }], daily: [{ day, tokens, cost: 1 }],
      modelHistory: [{ provider: 'openai', model: 'A', points: [{ day, tokens }] }],
      hourlyHistory: [{ hour: day + 12 * 3600, tokens, cost: 1 }],
    },
    ...extra,
  };
}
function environment(entries = []) {
  return { LEADERBOARD_BUCKET: versionedR2(entries), LEADERBOARD_SECRET: secret };
}
function call(env, path, body, headers = {}) {
  return worker.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {} });
}
const publish = (env, value, headers = { 'X-Leaderboard-Secret': secret }) => call(env, '/api/leaderboard', value, headers);
async function success(response) { assert.equal(response.status, 200, await response.clone().text()); return response.json(); }

test('CAS creates only an absent document and retries concurrent first writers', { timeout: 5000 }, async () => {
  const bucket = versionedR2(null), env = { LEADERBOARD_BUCKET: bucket };
  bucket.barrier();
  const responses = await Promise.all(['a', 'b'].map(handle => updateProfileEntries(env, entries => ({
    entries: [...entries, { handle }], response: new Response(handle),
  }))));
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['a', 'b']);
  assert.deepEqual(bucket.read().map(row => row.handle).sort(), ['a', 'b']);
  assert.equal(bucket.stats.conflicts, 1);
  assert.deepEqual(bucket.stats.conditions.slice(0, 2), [{ etagDoesNotMatch: '*' }, { etagDoesNotMatch: '*' }]);
  assert.ok(bucket.stats.conditions.at(-1).etagMatches);
});

test('storage reads fail closed without publishing starter or empty profiles', async () => {
  for (const bucket of [
    { async get() { throw new Error('private diagnostic'); }, async put() { assert.fail('Unexpected write'); } },
    { async get() { return { etag: '1', text: async () => '{bad JSON' }; }, async put() { assert.fail('Unexpected write'); } },
    { async get() { return { etag: '1', text: async () => '{}' }; }, async put() { assert.fail('Unexpected write'); } },
    { async get() { return { text: async () => '[]' }; }, async put() { assert.fail('Unexpected write'); } },
  ]) {
    await assert.rejects(updateProfileEntries({ LEADERBOARD_BUCKET: bucket }, () => assert.fail('Reducer must not run')), error => error instanceof ProfileStorageError && error.status === 503);
  }
});

test('CAS retries are bounded and expose a retryable conflict without reporting success', async () => {
  let puts = 0;
  const env = { LEADERBOARD_BUCKET: { async get() { return { etag: '1', text: async () => '[]' }; }, async put() { puts++; return null; } } };
  await assert.rejects(updateProfileEntries(env, entries => ({ entries, response: new Response('ok') }), 3), error => error.code === 'sync_conflict' && error.status === 503);
  assert.equal(puts, 3);
});

test('failed or unacknowledged R2 writes cannot be reported as successful syncs', async () => {
  for (const put of [async () => { throw new Error('private R2 diagnostic'); }, async () => undefined]) {
    const env = { LEADERBOARD_BUCKET: { async get() { return { etag: '1', text: async () => '[]' }; }, put } };
    await assert.rejects(updateProfileEntries(env, entries => ({ entries, response: new Response('ok') })), error => error.code === 'storage_unavailable' && error.status === 503);
  }
});

test('concurrent API updates to different profiles preserve both writes', { timeout: 5000 }, async () => {
  const env = environment([entry('a'), entry('b')]);
  env.LEADERBOARD_BUCKET.barrier();
  await Promise.all([
    publish(env, entry('a', secondDay, 21)),
    publish(env, entry('b', secondDay, 34)),
  ].map(async request => success(await request)));
  for (const [handle, tokens] of [['a', 21], ['b', 34]]) {
    assert.equal(env.LEADERBOARD_BUCKET.read().find(row => row.handle === handle).breakdown.daily.find(point => point.day === secondDay).tokens, tokens);
  }
  assert.equal(env.LEADERBOARD_BUCKET.stats.conflicts, 1);
  assert.equal(env.LEADERBOARD_BUCKET.stats.writes, 2);
});

test('concurrent same-profile syncs preserve disjoint daily, model, and exact hourly buckets', { timeout: 5000 }, async () => {
  const env = environment([entry('a', firstDay, 10, { claimed: true, ownerId: 'google:owner' })]);
  env.LEADERBOARD_BUCKET.barrier();
  await Promise.all([entry('a', firstDay, 21), entry('a', secondDay, 34)].map(async value => success(await publish(env, value))));
  const breakdown = env.LEADERBOARD_BUCKET.read()[0].breakdown;
  assert.deepEqual(breakdown.daily.map(point => [point.day, point.tokens]), [[firstDay, 21], [secondDay, 34]]);
  assert.deepEqual(breakdown.modelHistory[0].points.map(point => [point.day, point.tokens]), [[firstDay, 21], [secondDay, 34]]);
  assert.deepEqual(breakdown.hourlyHistory.map(point => [point.hour, point.tokens]), [[firstDay + 12 * 3600, 21], [secondDay + 12 * 3600, 34]]);
  assert.equal(env.LEADERBOARD_BUCKET.stats.conflicts, 1);
});

test('a profile claimed during a CAS conflict rejects the previously anonymous publisher', async () => {
  const env = environment([entry('a')]);
  env.LEADERBOARD_SECRET = '';
  const claimed = entry('a', secondDay, 88, { claimed: true, ownerId: 'google:new-owner' });
  env.LEADERBOARD_BUCKET.beforeNextWrite(bucket => bucket.inject([claimed]));
  const response = await publish(env, entry('a', firstDay, 21), {});
  assert.equal(response.status, 403);
  assert.deepEqual(env.LEADERBOARD_BUCKET.read(), [claimed]);
  assert.equal(env.LEADERBOARD_BUCKET.stats.puts, 1, 'Ownership failure must abort before a second write');
});

test('older collectedAt fails after a newer snapshot wins a concurrent write', async () => {
  const collectedAt = Date.now() / 1000 - 20;
  const env = environment([entry('a', firstDay, 10, { collectedAt })]);
  const newer = entry('a', secondDay, 55, { collectedAt: collectedAt + 10 });
  env.LEADERBOARD_BUCKET.beforeNextWrite(bucket => bucket.inject([newer]));
  const response = await publish(env, entry('a', firstDay, 21, { collectedAt: collectedAt + 5 }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'stale_snapshot');
  assert.deepEqual(env.LEADERBOARD_BUCKET.read(), [newer]);
});

test('invalid collection markers cannot bypass snapshot ordering or counter checks', async () => {
  for (const collectedAt of ['old', String(Date.now() / 1000), -1, Date.now() / 1000 + 3600]) {
    const before = entry('a', firstDay, 10, { collectedAt: Date.now() / 1000 - 10 });
    const env = environment([before]);
    const response = await publish(env, entry('a', secondDay, 1, { collectedAt, tokensAll: 1 }));
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).code, 'invalid_snapshot');
    assert.deepEqual(env.LEADERBOARD_BUCKET.read(), [before]);
    assert.equal(env.LEADERBOARD_BUCKET.stats.puts, 0);
  }
});

test('a valid one-model snapshot does not discard late history from a multi-model profile', async () => {
  const previous = entry('a');
  previous.breakdown.models.push({ provider: 'anthropic', model: 'B', tokensAll: 100 });
  const env = environment([previous]);
  await success(await publish(env, entry('a', secondDay, 55)));
  const breakdown = env.LEADERBOARD_BUCKET.read()[0].breakdown;
  assert.deepEqual(breakdown.daily.map(point => point.tokens), [10, 55]);
  assert.deepEqual(breakdown.hourlyHistory.map(point => point.tokens), [10, 55]);
});

test('public GET backfill never writes the shared profile document', async () => {
  for (const initial of [null, [{ handle: 'legacy', tokensAll: 100, tokensToday: 10 }]]) {
    const env = environment(initial), before = env.LEADERBOARD_BUCKET.read();
    await success(await call(env, '/api/leaderboard'));
    assert.equal(env.LEADERBOARD_BUCKET.stats.puts, 0);
    assert.deepEqual(env.LEADERBOARD_BUCKET.read(), before);
  }
});

const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'storage-race-fixture', alg: 'RS256', use: 'sig' };
async function googleToken() {
  const b64 = value => Buffer.from(value).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const input = b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid })) + '.' + b64(JSON.stringify({
    sub: 'owner', email: 'owner@example.test', email_verified: true, name: 'Fixture',
    aud: 'storage-fixture', iss: 'https://accounts.google.com', iat: now, exp: now + 3600,
  }));
  return input + '.' + b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input)));
}

test('claim retries retain usage that arrived after the first read', async () => {
  const env = { ...environment([entry('a')]), GOOGLE_CLIENT_ID: 'storage-fixture', GOOGLE_JWKS: JSON.stringify({ keys: [jwk] }) };
  env.LEADERBOARD_BUCKET.beforeNextWrite(bucket => bucket.inject([entry('a', secondDay, 88)]));
  await success(await call(env, '/api/claim', { handle: 'a', googleToken: await googleToken() }));
  const profile = env.LEADERBOARD_BUCKET.read()[0];
  assert.equal(profile.ownerId, 'google:owner');
  assert.equal(profile.breakdown.daily[0].tokens, 88);
  assert.equal(env.LEADERBOARD_BUCKET.stats.conflicts, 1);
});

test('avatar retries retain concurrently published usage', async () => {
  const env = environment([entry('a')]);
  env.LEADERBOARD_BUCKET.beforeNextWrite(bucket => bucket.inject([entry('a', secondDay, 88)]));
  await success(await call(env, '/api/profile/avatar', { handle: 'a', avatarStyle: 'bottts' }, { 'X-Leaderboard-Secret': secret }));
  const profile = env.LEADERBOARD_BUCKET.read()[0];
  assert.equal(profile.avatarStyle, 'bottts');
  assert.equal(profile.breakdown.daily[0].tokens, 88);
  assert.equal(env.LEADERBOARD_BUCKET.stats.conflicts, 1);
});

test('Sheets imports preserve concurrent profiles and history instead of replacing the document', async t => {
  const nativeFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  globalThis.fetch = async request => {
    assert.equal(String(request), 'https://sheet.example.test/export');
    return new Response('handle,tokensAll\na,999\nnew,12\n', { status: 200 });
  };
  const env = environment([entry('a')]);
  env.LEADERBOARD_BUCKET.beforeNextWrite(bucket => bucket.inject([entry('a', secondDay, 88)]));
  const body = await success(await call(env, '/api/sync-sheets', { sheet_url: 'https://sheet.example.test/export' }));
  const profiles = env.LEADERBOARD_BUCKET.read();
  assert.equal(profiles.find(row => row.handle === 'a').breakdown.daily[0].tokens, 88);
  assert.equal(profiles.find(row => row.handle === 'new').tokensAll, 12);
  assert.equal(body.syncedCount, 1);
  assert.equal(body.skippedCount, 1);
  assert.equal(env.LEADERBOARD_BUCKET.stats.conflicts, 1);
});
