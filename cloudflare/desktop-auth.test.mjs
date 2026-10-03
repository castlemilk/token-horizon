import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import site from './src/index.js';
import { desktopPublishIdentity } from './src/desktop-auth.js';
import { SESSION_COOKIE } from './src/browser-auth.js';
register('./worker-loader.mjs', import.meta.url);
const { default: worker } = await import('./src/worker.js');

const origin = 'https://token-horizon.dev';
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const challenge = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
const identity = { provider: 'google', sub: 'native-owner', email: 'native@example.com', name: 'Aurora', picture: 'https://example.com/aurora.png' };
function environment(entries = []) {
  const kvValues = new Map(), kvOptions = new Map(), r2Values = new Map([['leaderboard.json', JSON.stringify(entries)]]);
  return {
    GOOGLE_CLIENT_ID: 'native-test-client', LEADERBOARD_SECRET: 'server-publisher-secret',
    OAUTH_KV: {
      values: kvValues, options: kvOptions,
      async get(key) { return kvValues.get(key) ?? null; },
      async put(key, value, options) { kvValues.set(key, value); kvOptions.set(key, options); },
      async delete(key) { kvValues.delete(key); }
    },
    LEADERBOARD_BUCKET: {
      values: r2Values,
      async get(key) { const value = r2Values.get(key); return value === undefined ? null : { text: async () => value, etag: '1' }; },
      async put(key, value, options) { if (options?.onlyIf?.etagDoesNotMatch === '*' && r2Values.has(key)) return null; r2Values.set(key, value); return { etag: '1' }; },
      async list({ prefix = '', limit = 1000, cursor = '0' } = {}) {
        const keys = [...r2Values.keys()].filter(key => key.startsWith(prefix)).sort(), start = Number(cursor), next = start + limit;
        return { objects: keys.slice(start, next).map(key => ({ key })), truncated: next < keys.length, cursor: String(next) };
      },
      async delete(key) { r2Values.delete(key); }
    }
  };
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const call = async (env, path, init = {}) => {
  const pending = [], response = await site.fetch(new Request(origin + path, init), env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  return response;
};
async function browserCookie(env, user = identity) {
  const token = crypto.randomUUID().replace(/-/g, '').repeat(2);
  env.OAUTH_KV.values.set(`browser-session:${await hash(token)}`, JSON.stringify({ identity: user, expiresAt: Date.now() + 3600000 }));
  return `${SESSION_COOKIE}=${token}`;
}
async function start(env, handle = 'aurora', extra = {}) {
  const verifier = crypto.randomUUID().replace(/-/g, '').repeat(2);
  const response = await call(env, '/api/desktop/start', post({ handle, challenge: await challenge(verifier), ...extra }));
  assert.equal(response.status, 200, await response.clone().text());
  return { verifier, ...await response.json() };
}
async function approve(env, transaction, extra = {}, user = identity) {
  return await call(env, '/api/desktop/approve', post({ id: transaction.id, decision: 'allow', ...extra }, { Origin: origin, Cookie: await browserCookie(env, user) }));
}
const exchange = (env, transaction, verifier = transaction.verifier) => call(env, '/api/desktop/exchange', post({ id: transaction.id, verifier }));
async function connect(env, handle = 'aurora', extra = {}, user = identity) {
  const transaction = await start(env, handle, extra), approval = await approve(env, transaction, {}, user);
  assert.equal(approval.status, 200, await approval.clone().text());
  const response = await exchange(env, transaction);
  assert.equal(response.status, 200, await response.clone().text());
  return { transaction, response, ...await response.json() };
}
const publish = (env, token, handle, extra = {}) => call(env, '/api/leaderboard', post({ handle, tokensAll: 1234, ...extra }, { Authorization: `Bearer ${token}` }));
const profile = (env, handle) => JSON.parse(env.LEADERBOARD_BUCKET.values.get('leaderboard.json')).find(entry => entry.handle === handle);

test('native S256 request has no URL secrets, waits for browser consent and claims on publish', async () => {
  const env = environment(), transaction = await start(env, '@Aurora', { claimToken: 'native-anonymous-claim' });
  assert.match(transaction.id, /^[a-f0-9]{64}$/);
  assert.equal(transaction.authorizationUrl, `${origin}/connect?desktop=${transaction.id}`);
  assert.ok(transaction.expiresAt > Date.now() + 590000);
  assert.equal(env.OAUTH_KV.options.get(`desktop-request:${transaction.id}`).expirationTtl, 600);
  const stored = [...env.OAUTH_KV.values.values()].join('');
  assert.ok(!stored.includes(transaction.verifier)); assert.ok(!stored.includes('native-anonymous-claim'));
  const request = await call(env, `/api/desktop/request?id=${transaction.id}`), info = await request.json();
  assert.equal(info.handle, 'aurora'); assert.equal(info.status, 'pending'); assert.equal(info.app.name, 'Token Horizon');
  assert.ok(!JSON.stringify(info).includes('challenge')); assert.ok(!JSON.stringify(info).includes('claimToken'));
  assert.match(request.headers.get('Cache-Control'), /private, no-store/);
  const pending = await exchange(env, transaction); assert.equal(pending.status, 202); assert.equal((await pending.json()).status, 'pending');
  const approved = await approve(env, transaction); assert.deepEqual(await approved.json(), { ok: true, status: 'approved', handle: 'aurora' });
  assert.equal(profile(env, 'aurora'), undefined, 'Consent does not publish or create an empty profile');
  const connected = await exchange(env, transaction), credentials = await connected.json();
  assert.equal(connected.status, 200); assert.match(credentials.accessToken, /^thd_[a-f0-9]{64}$/); assert.deepEqual(credentials.user, identity);
  assert.ok(credentials.expiresAt > Date.now() + 89 * 86400000);
  const grantKey = `desktop-grant:${await hash(credentials.accessToken)}`;
  assert.equal(env.OAUTH_KV.options.get(grantKey).expirationTtl, 90 * 86400);
  assert.ok(![...env.OAUTH_KV.values.keys()].join('').includes(credentials.accessToken));
  assert.ok(![...env.OAUTH_KV.values.values()].join('').includes(credentials.accessToken));
  const published = await publish(env, credentials.accessToken, 'aurora'); assert.equal(published.status, 200, await published.clone().text());
  assert.equal(profile(env, 'aurora').claimed, true); assert.equal(profile(env, 'aurora').ownerId, 'google:native-owner');
  assert.equal((await (await call(env, `/api/desktop/request?id=${transaction.id}`)).json()).status, 'exchanged');
});

test('the public desktop connect page uses the desktop UI without creating an MCP management nonce', async () => {
  const env = environment(), transaction = await start(env);
  const page = await worker.fetch(new Request(transaction.authorizationUrl), env, { waitUntil() {} });
  assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /data-mode="desktop"/); assert.ok(html.includes(`data-desktop-id="${transaction.id}"`));
  assert.equal([...env.OAUTH_KV.values.keys()].filter(key => key.startsWith('management:')).length, 0);
  assert.equal(page.headers.get('Set-Cookie'), null);
  assert.equal((await worker.fetch(new Request(origin + '/connect?desktop=invalid'), env, { waitUntil() {} })).status, 400);
});

test('browser approval needs same-origin remembered identity; raw identity fields grant no authority', async () => {
  const env = environment(), transaction = await start(env);
  assert.equal((await call(env, '/api/desktop/approve', post({ id: transaction.id, decision: 'allow', googleUser: identity }, { Origin: origin }))).status, 401);
  for (const badOrigin of ['', 'null', 'https://attacker.example']) {
    const response = await call(env, '/api/desktop/approve', post({ id: transaction.id, decision: 'allow' }, { Cookie: await browserCookie(env), Origin: badOrigin }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'invalid_origin');
  }
  assert.equal((await approve(env, transaction, { decision: 'silently-connect' })).status, 400);
  assert.equal((await exchange(env, transaction)).status, 202);
});

test('a signed-out browser can cancel the ticket without granting account access', async () => {
  const env = environment(), transaction = await start(env);
  const response = await call(env, '/api/desktop/approve', post({ id: transaction.id, decision: 'deny', handle: 'invalid handle' }, { Origin: origin }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, status: 'denied', handle: 'aurora' });
  assert.equal((await exchange(env, transaction)).status, 403);
  assert.equal([...env.OAUTH_KV.values.keys()].filter(key => key.startsWith('desktop-grant:')).length, 0);
});

test('claimed profiles use canonical provider subjects; same email and forceClaim cannot take ownership', async () => {
  const env = environment([{ handle: 'someone-else', claimed: true, ownerId: 'google:someone-else', googleEmail: identity.email }, { handle: 'github-owned', claimed: true, ownerId: 'github:native-owner', accountEmail: identity.email }]);
  for (const handle of ['someone-else', 'github-owned']) {
    const transaction = await start(env, handle), response = await approve(env, transaction, { forceClaim: true });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'profile_owned');
  }
  const transaction = await start(env, 'someone-else'), accepted = await approve(env, transaction, { handle: 'my-new-profile' });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).handle, 'my-new-profile');
  const credentials = await (await exchange(env, transaction)).json();
  assert.equal((await publish(env, credentials.accessToken, 'my-new-profile')).status, 200);
  assert.equal((await publish(env, credentials.accessToken, 'someone-else')).status, 403);
});

test('anonymous profiles require original app claim proof and a handle change cannot transfer that proof', async () => {
  const claimToken = 'original-app-proof', claimTokenHash = await hash(claimToken);
  const entries = ['anonymous', 'another-anonymous'].map(handle => ({ handle, claimed: false, claimTokenHash }));
  const env = environment(entries);
  for (const extra of [{}, { claimToken: 'wrong' }]) {
    const response = await approve(env, await start(env, 'anonymous', extra));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'claim_required');
  }
  const changed = await start(env, 'anonymous', { claimToken });
  assert.equal((await approve(env, changed, { handle: 'another-anonymous' })).status, 403);
  const credentials = await connect(env, 'anonymous', { claimToken });
  assert.equal((await publish(env, credentials.accessToken, 'anonymous')).status, 200);
  assert.equal(profile(env, 'anonymous').ownerId, 'google:native-owner');
  assert.equal(profile(env, 'anonymous').claimTokenHash, undefined);
});

test('existing owner and anonymous proof are checked again at publish after browser approval', async () => {
  const env = environment([{ handle: 'owned', claimed: true, ownerId: 'google:native-owner' }]);
  const credentials = await connect(env, 'owned');
  env.LEADERBOARD_BUCKET.values.set('leaderboard.json', JSON.stringify([{ handle: 'owned', claimed: true, ownerId: 'google:changed-owner' }]));
  assert.equal((await publish(env, credentials.accessToken, 'owned')).status, 403);
  const token = 'original-token', anonymousEnv = environment([{ handle: 'anonymous', claimed: false, claimTokenHash: await hash(token) }]);
  const anonymous = await connect(anonymousEnv, 'anonymous', { claimToken: token });
  anonymousEnv.LEADERBOARD_BUCKET.values.set('leaderboard.json', JSON.stringify([{ handle: 'anonymous', claimed: false, claimTokenHash: await hash('changed-token') }]));
  const response = await publish(anonymousEnv, anonymous.accessToken, 'anonymous'); assert.equal(response.status, 403); assert.equal((await response.json()).code, 'claim_required');
});

test('scoped publication fails closed on current profile read failure without overwriting protected entries', async () => {
  const env = environment([{ handle: 'owned', claimed: true, ownerId: 'google:native-owner', tokensAll: 50 }]), credentials = await connect(env, 'owned');
  const original = env.LEADERBOARD_BUCKET.values.get('leaderboard.json'), get = env.LEADERBOARD_BUCKET.get;
  env.LEADERBOARD_BUCKET.get = async key => {
    if (key === 'leaderboard.json') throw new Error('private upstream storage diagnostics');
    return await get(key);
  };
  const response = await publish(env, credentials.accessToken, 'owned');
  assert.equal(response.status, 503);
  const data = await response.json(); assert.equal(data.code, 'auth_unavailable'); assert.ok(!data.error.includes('private upstream'));
  assert.equal(env.LEADERBOARD_BUCKET.values.get('leaderboard.json'), original);
});

test('wrong verifier, denied consent, repeated decisions, concurrent exchange and replay fail closed', async () => {
  const env = environment(), transaction = await start(env);
  assert.equal((await exchange(env, transaction, 'x'.repeat(64))).status, 401);
  assert.equal((await approve(env, transaction, { decision: 'deny' })).status, 200);
  const denied = await exchange(env, transaction); assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'connection_denied');
  assert.equal((await approve(env, transaction)).status, 409);
  const next = await start(env); assert.equal((await approve(env, next)).status, 200);
  const responses = await Promise.all([exchange(env, next), exchange(env, next)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await exchange(env, next)).status, 409);
  assert.equal([...env.OAUTH_KV.values.keys()].filter(key => key.startsWith('desktop-grant:')).length, 1);
  assert.equal((await approve(env, next, { handle: 'changed' })).status, 409);
});

test('desktop credential is scoped to one publisher and never authorizes management or global writes', async () => {
  const env = environment(), credentials = await connect(env);
  for (const [path, init] of [
    ['/api/account/profiles', { headers: { Authorization: `Bearer ${credentials.accessToken}` } }],
    ['/api/claim', post({ handle: 'other', forceClaim: true }, { Authorization: `Bearer ${credentials.accessToken}` })],
    ['/api/team/invites', post({ name: 'Attack' }, { Authorization: `Bearer ${credentials.accessToken}` })]
  ]) assert.equal((await call(env, path, init)).status, 401, path);
  const mismatch = await publish(env, credentials.accessToken, 'other'); assert.equal(mismatch.status, 403); assert.equal((await mismatch.json()).code, 'profile_mismatch');
  await assert.rejects(desktopPublishIdentity(new Request(origin + '/api/profile/avatar', post({}, { Authorization: `Bearer ${credentials.accessToken}` })), env, 'aurora'), error => error.code === 'invalid_scope');
  assert.equal(await desktopPublishIdentity(new Request(origin + '/api/leaderboard', post({}, { Authorization: 'Bearer ordinary-write-token' })), env, 'aurora'), null);
});

test('invalid or expired desktop credential rejects even without configured global write secret', async () => {
  const env = environment(); delete env.LEADERBOARD_SECRET;
  for (const token of ['thd_invalid', `thd_${'a'.repeat(64)}`, `THD_${'a'.repeat(64)}`]) {
    const response = await publish(env, token, 'aurora'); assert.equal(response.status, 401); assert.equal((await response.json()).code, 'auth_required');
  }
  const credentials = await connect(env), key = `desktop-grant:${await hash(credentials.accessToken)}`, value = JSON.parse(env.OAUTH_KV.values.get(key));
  value.expiresAt = Date.now() - 1;
  env.LEADERBOARD_BUCKET.values.set(`desktop-auth/grants/${await hash(credentials.accessToken)}.json`, JSON.stringify(value));
  assert.equal((await publish(env, credentials.accessToken, 'aurora')).status, 401);
  assert.equal(profile(env, 'aurora'), undefined);
});

test('disconnect revokes the exact desktop grant and leaves browser login intact', async () => {
  const env = environment(), first = await connect(env), second = await connect(env, 'second-profile');
  assert.equal((await call(env, '/api/desktop/revoke', post({}))).status, 401);
  const response = await call(env, '/api/desktop/revoke', post({}, { Authorization: `Bearer ${first.accessToken}` }));
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'disconnected');
  assert.equal((await publish(env, first.accessToken, 'aurora')).status, 401);
  assert.equal((await publish(env, second.accessToken, 'second-profile')).status, 200);
  assert.equal([...env.OAUTH_KV.values.keys()].filter(key => key.startsWith('browser-session:')).length, 2);
});

test('a different edge with stale KV can read a new ticket and immediately publish a new grant', async () => {
  const env = environment(), transaction = await start(env);
  const browserGet = env.OAUTH_KV.get;
  env.OAUTH_KV.get = async key => key.startsWith('desktop-') ? null : await browserGet(key);
  assert.equal((await call(env, `/api/desktop/request?id=${transaction.id}`)).status, 200);
  assert.equal((await exchange(env, transaction)).status, 202);
  assert.equal((await approve(env, transaction)).status, 200);
  const credentials = await (await exchange(env, transaction)).json();
  assert.match(credentials.accessToken, /^thd_[a-f0-9]{64}$/);
  assert.equal((await publish(env, credentials.accessToken, 'aurora')).status, 200);
});

test('a revoked R2 grant cannot be resurrected by a stale positive KV read or mirror deletion failure', async () => {
  const env = environment(), credentials = await connect(env), key = `desktop-grant:${await hash(credentials.accessToken)}`;
  const cached = env.OAUTH_KV.values.get(key);
  env.OAUTH_KV.delete = async () => { throw new Error('KV deletion unavailable'); };
  const response = await call(env, '/api/desktop/revoke', post({}, { Authorization: `Bearer ${credentials.accessToken}` }));
  assert.equal(response.status, 200);
  assert.equal(env.OAUTH_KV.values.get(key), cached, 'A cached mirror still exists at the other edge');
  const publishResponse = await publish(env, credentials.accessToken, 'aurora');
  assert.equal(publishResponse.status, 401); assert.equal((await publishResponse.json()).code, 'auth_required');
});

test('unavailable KV mirrors cannot strand a native request or grant after consent', async () => {
  const env = environment(); env.OAUTH_KV.put = async () => { throw new Error('KV writes unavailable'); };
  const credentials = await connect(env);
  assert.equal((await publish(env, credentials.accessToken, 'aurora')).status, 200);
});

test('expired tickets retire bounded R2 records; stale KV preserves live replay protection', async () => {
  const env = environment(), credentials = await connect(env), id = credentials.transaction.id;
  const kvKey = `desktop-request:${id}`, transaction = env.OAUTH_KV.values.get(kvKey);
  env.OAUTH_KV.values.delete(kvKey);
  assert.equal((await exchange(env, credentials.transaction)).status, 409);
  assert.ok(env.LEADERBOARD_BUCKET.values.has(`desktop-auth/exchanged/${id}.json`), 'Negative KV cache cannot remove a live exchange marker');
  env.OAUTH_KV.values.set(kvKey, transaction);
  assert.equal((await exchange(env, credentials.transaction)).status, 409);
  const expired = JSON.parse(transaction); expired.expiresAt = Date.now() - 1;
  env.LEADERBOARD_BUCKET.values.set(`desktop-auth/requests/${id}.json`, JSON.stringify(expired));
  const r2Key = `desktop-auth/decisions/${id}.json`, result = JSON.parse(env.LEADERBOARD_BUCKET.values.get(r2Key)); result.expiresAt = Date.now() - 1; env.LEADERBOARD_BUCKET.values.set(r2Key, JSON.stringify(result));
  assert.equal((await call(env, `/api/desktop/request?id=${id}`)).status, 410);
  assert.ok(!env.LEADERBOARD_BUCKET.values.has(r2Key)); assert.ok(!env.LEADERBOARD_BUCKET.values.has(`desktop-auth/exchanged/${id}.json`));
});

test('cleanup rotates bounded pages so active grants do not hide expired requests and grants', async () => {
  const env = environment(), now = Date.now();
  for (let index = 0; index < 25; index++) {
    const id = index.toString(16).padStart(64, '0');
    env.LEADERBOARD_BUCKET.values.set(`desktop-auth/grants/${id}.json`, JSON.stringify({ expiresAt: now + 86400000 }));
  }
  const expiredId = 'f'.repeat(64), grantKey = `desktop-auth/grants/${expiredId}.json`, requestKey = `desktop-auth/requests/${expiredId}.json`;
  env.LEADERBOARD_BUCKET.values.set(grantKey, JSON.stringify({ expiresAt: now - 1 }));
  env.LEADERBOARD_BUCKET.values.set(requestKey, JSON.stringify({ expiresAt: now - 1 }));
  await start(env);
  assert.ok(env.LEADERBOARD_BUCKET.values.has(grantKey), 'Only the first twenty grant records are read per start');
  assert.ok(!env.LEADERBOARD_BUCKET.values.has(requestKey));
  await start(env);
  assert.ok(!env.LEADERBOARD_BUCKET.values.has(grantKey), 'Next cleanup reaches the expired grant after active records');
});

test('bounded request formats, handle restrictions, unavailable storage and start abuse return actionable errors', async () => {
  const env = environment(), validChallenge = await challenge('x'.repeat(64));
  for (const handle of ['', '.', '..', 'bad/handle', 'white space', 'a'.repeat(65)]) assert.equal((await call(env, '/api/desktop/start', post({ handle, challenge: validChallenge }))).status, 400);
  for (const value of ['', 'x'.repeat(42), 'x'.repeat(44), '@'.repeat(43)]) assert.equal((await call(env, '/api/desktop/start', post({ handle: 'aurora', challenge: value }))).status, 400);
  assert.equal((await call(env, '/api/desktop/start', { ...post({}), body: '{' })).status, 400);
  assert.equal((await call(env, '/api/desktop/start', post({ handle: 'aurora', challenge: validChallenge, extra: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await call({}, '/api/desktop/start', post({ handle: 'aurora', challenge: validChallenge }))).status, 503);
  for (let index = 0; index < 5; index++) assert.equal((await call(env, '/api/desktop/start', post({ handle: 'aurora', challenge: validChallenge }, { 'CF-Connecting-IP': '198.51.100.42' }))).status, 200);
  assert.equal((await call(env, '/api/desktop/start', post({ handle: 'aurora', challenge: validChallenge }, { 'CF-Connecting-IP': '198.51.100.42' }))).status, 429);
  const broken = { ...env, LEADERBOARD_BUCKET: { async get() { throw new Error('private storage diagnostics'); } } };
  const failure = await publish(broken, `thd_${'b'.repeat(64)}`, 'aurora'); assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes('private storage diagnostics'));
});
