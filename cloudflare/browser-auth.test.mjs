import { test } from 'node:test';
import assert from 'node:assert/strict';
import site from './src/index.js';
import { handleBrowserAuth, browserIdentity, identityOwnerId, identityOwns, SESSION_COOKIE } from './src/browser-auth.js';
import { boundedText } from './src/request-body.js';
const origin = 'https://token-horizon.dev';
const req = (path, init = {}) => new Request(origin + path, init);
function kv() {
  const values = new Map();
  return { values, async get(key) { return values.get(key) || null; }, async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
}
function r2(entries) {
  const values = new Map([['leaderboard.json', JSON.stringify(entries)]]);
  const versions = new Map();
  return { values, async get(key) { const value = values.get(key); return value === undefined ? null : { text: async () => value, json: async () => JSON.parse(value), etag: String(versions.get(key) || 1) }; },
    async put(key, value, options) { const condition = options?.onlyIf; if (condition?.etagDoesNotMatch === '*' && values.has(key)) return null; if (condition?.etagMatches && condition.etagMatches !== String(versions.get(key) || 1)) return null; values.set(key, value); versions.set(key, (versions.get(key) || 1) + 1); return { etag: String(versions.get(key)) }; },
    async list({ prefix = '' } = {}) { return { objects: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; }, async delete(key) { values.delete(key); } };
}
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'browser-test', alg: 'RS256' };
const b64 = bytes => Buffer.from(bytes).toString('base64url');
async function googleToken(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: 'google-42', email: 'shared@example.com', email_verified: true, name: 'Aurora', picture: 'https://lh3.googleusercontent.com/aurora', aud: 'browser-client', iss: 'https://accounts.google.com', exp: now + 3600, iat: now, ...extra };
  const input = b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid })) + '.' + b64(JSON.stringify(payload));
  return input + '.' + b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(input)));
}
function environment(entries = []) { return { OAUTH_KV: kv(), GOOGLE_CLIENT_ID: 'browser-client', GOOGLE_JWKS: JSON.stringify({ keys: [jwk] }), LEADERBOARD_BUCKET: r2(entries) }; }
const fetchSite = (env, path, init) => site.fetch(req(path, init), env, { waitUntil() {} });
const post = (body, cookie = '', extra = {}) => ({ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
const cookieHeader = response => response.headers.get('Set-Cookie').split(';')[0];
async function googleLogin(env, cookie = '') { const response = await fetchSite(env, '/api/auth/google', post({ credential: await googleToken() }, cookie)); assert.equal(response.status, 200, await response.clone().text()); return { cookie: cookieHeader(response), response, data: await response.json() }; }

test('Google exchanges a signed credential for a private remembered session and rotates it', async () => {
  const env = environment();
  const first = await googleLogin(env);
  assert.equal(first.data.user.provider, 'google'); assert.equal(first.data.user.sub, 'google-42');
  assert.ok(first.data.expiresAt > Date.now() + 29 * 86400000);
  assert.match(first.response.headers.get('Set-Cookie'), /^__Host-th-session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.match(first.response.headers.get('Cache-Control'), /private, no-store/);
  const raw = [...env.OAUTH_KV.values.values()].join(''); assert.ok(!raw.includes('credential')); assert.ok(!raw.includes(await googleToken())); assert.ok(![...env.OAUTH_KV.values.keys()].some(key => key.includes(first.cookie.split('=')[1])));
  const fresh = await fetchSite(env, '/api/auth/session', { headers: { Cookie: first.cookie } }); assert.deepEqual(await fresh.json(), first.data); assert.match(fresh.headers.get('Cache-Control'), /no-store/);
  const second = await googleLogin(env, first.cookie); assert.notEqual(second.cookie, first.cookie); assert.equal(env.OAUTH_KV.values.size, 1);
  assert.equal((await (await fetchSite(env, '/api/auth/session', { headers: { Cookie: first.cookie } })).json()).authenticated, false);
  const logout = await fetchSite(env, '/api/auth/logout', post({}, second.cookie)); assert.equal(logout.status, 200); assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/); assert.equal(env.OAUTH_KV.values.size, 0);
});

test('Origin, malformed input, audience, expiry and verified email fail closed', async () => {
  const env = environment();
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: '' }]) assert.equal((await fetchSite(env, '/api/auth/google', post({ credential: await googleToken() }, '', headers))).status, 403);
  for (const extra of [{ exp: 1 }, { aud: 'other-client' }, { email_verified: false }, { email_verified: undefined }]) assert.equal((await fetchSite(env, '/api/auth/google', post({ credential: await googleToken(extra) }))).status, 401);
  assert.equal((await fetchSite(env, '/api/auth/google', { ...post({}), body: '{' })).status, 400);
  assert.equal((await fetchSite(env, '/api/auth/google', post({ credential: 'x'.repeat(20000) }))).status, 413);
  assert.equal((await fetchSite({ OAUTH_KV: kv() }, '/api/auth/google', post({ credential: 'google:a@example.com' }))).status, 503);
  assert.equal(env.OAUTH_KV.values.size, 0);
});

test('Session expiry, duplicate cookies, storage failure and cross-origin logout cannot authorize', async () => {
  const env = environment(), login = await googleLogin(env);
  assert.equal((await fetchSite(env, '/api/auth/logout', post({}, login.cookie, { Origin: 'https://attacker.example' }))).status, 403); assert.equal(env.OAUTH_KV.values.size, 1);
  assert.equal(await browserIdentity(req('/api/account/team', post({}, login.cookie, { Origin: '' })), env), null);
  assert.equal(await browserIdentity(req('/api/account/team', { headers: { Cookie: login.cookie + '; ' + login.cookie } }), env), null);
  const key = [...env.OAUTH_KV.values.keys()][0], value = JSON.parse(env.OAUTH_KV.values.get(key)); value.expiresAt = Date.now() - 1; env.OAUTH_KV.values.set(key, JSON.stringify(value));
  const expired = await fetchSite(env, '/api/auth/session', { headers: { Cookie: login.cookie } }); assert.equal((await expired.json()).authenticated, false); assert.equal(expired.headers.get('Set-Cookie'), null, 'Session reads cannot clear a newer login cookie');
  const broken = { ...env, OAUTH_KV: { get() { throw new Error('secret storage details'); } } }; const response = await fetchSite(broken, '/api/auth/session', { headers: { Cookie: login.cookie } }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret storage'));
});

async function startGithub(env, returnTo = '/u/aurora?tab=usage') {
  const response = await fetchSite(env, '/api/auth/github?returnTo=' + encodeURIComponent(returnTo)); assert.equal(response.status, 303);
  const location = new URL(response.headers.get('Location')), state = location.searchParams.get('state');
  assert.equal(location.origin, 'https://github.com'); assert.equal(location.searchParams.get('code_challenge_method'), 'S256'); assert.equal(location.searchParams.get('code_challenge').length, 43); assert.equal(location.searchParams.get('scope'), 'read:user user:email'); assert.equal(location.searchParams.get('redirect_uri'), origin + '/api/auth/github/callback');
  return { cookie: cookieHeader(response), state, location, response };
}
const githubEnv = entries => ({ ...environment(entries), GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'server-only-secret' });
async function githubFinish(env, flow, { emailVerified = true, fail = false, responseBytes = 0 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.redirect, 'manual'); assert.ok(options.signal);
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(options.body.get('client_secret'), 'server-only-secret'); assert.equal(options.body.get('code'), 'github-code');
      const verifier = options.body.get('code_verifier'); assert.equal(b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))), flow.location.searchParams.get('code_challenge'));
      if (fail) return new Response('private failure', { status: 302 });
      return Response.json({ access_token: 'never-browser-token', token_type: 'bearer' });
    }
    assert.equal(options.headers.Authorization, 'Bearer never-browser-token');
    if (url === 'https://api.github.com/user') return responseBytes ? new Response('x'.repeat(responseBytes)) : Response.json({ id: 42, login: 'aurora', name: 'Aurora GitHub', avatar_url: 'https://avatars.githubusercontent.com/u/42' });
    if (url === 'https://api.github.com/user/emails?per_page=100') return Response.json([{ email: 'shared@example.com', verified: emailVerified, primary: true }]);
    throw new Error('Unexpected network call');
  };
  try { const response = await fetchSite(env, '/api/auth/github/callback?state=' + flow.state + '&code=github-code', { headers: { Cookie: flow.cookie } }); return { response, calls }; }
  finally { globalThis.fetch = original; }
}

test('GitHub uses bound one-time state + S256 and stores only verified, namespaced identity', async () => {
  const env = githubEnv(), flow = await startGithub(env), { response, calls } = await githubFinish(env, flow);
  assert.equal(response.status, 303); assert.equal(new URL(response.headers.get('Location')).pathname, '/u/aurora'); assert.equal(new URL(response.headers.get('Location')).searchParams.get('tab'), 'usage'); assert.equal(new URL(response.headers.get('Location')).searchParams.get('auth'), 'success');
  const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2); assert.match(cookies[0], /Max-Age=0/); const session = cookies.find(value => value.startsWith(SESSION_COOKIE)).split(';')[0];
  const identity = await browserIdentity(req('/api/account/profiles', { headers: { Cookie: session } }), env); assert.equal(identity.provider, 'github'); assert.equal(identity.sub, '42'); assert.equal(identity.email, 'shared@example.com'); assert.equal(identityOwnerId(identity), 'github:42');
  assert.equal(calls.length, 3); const storage = [...env.OAUTH_KV.values.values()].join(''); assert.ok(!storage.includes('never-browser-token')); assert.ok(!storage.includes('server-only-secret'));
  assert.equal(identityOwns({ ownerId: 'google:42', googleEmail: identity.email }, identity, { legacyEmail: true }), false);
  const replay = await fetchSite(env, '/api/auth/github/callback?state=' + flow.state + '&code=github-code', { headers: { Cookie: flow.cookie } }); assert.equal(new URL(replay.headers.get('Location')).searchParams.get('auth_error'), 'expired');
});

test('GitHub denies missing state binding, unverified email, provider redirects, oversize data and offsite returns', async () => {
  const env = githubEnv();
  const flow = await startGithub(env);
  const mismatch = await fetchSite(env, '/api/auth/github/callback?state=' + flow.state + '&code=github-code'); assert.equal(new URL(mismatch.headers.get('Location')).searchParams.get('auth_error'), 'expired'); assert.equal([...env.OAUTH_KV.values.keys()].filter(key => key.startsWith('browser-session:')).length, 0);
  for (const options of [{ emailVerified: false }, { fail: true }, { responseBytes: 70000 }]) {
    const next = await startGithub(env), { response } = await githubFinish(env, next, options); assert.equal(new URL(response.headers.get('Location')).searchParams.get('auth_error'), 'provider_unavailable'); assert.ok(!response.headers.get('Set-Cookie').includes(SESSION_COOKIE));
  }
  for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/auth/github', '/a\nLocation:bad']) {
    const next = await startGithub(env, returnTo), denied = await fetchSite(env, '/api/auth/github/callback?state=' + next.state + '&error=access_denied', { headers: { Cookie: next.cookie } }); assert.equal(new URL(denied.headers.get('Location')).origin, origin); assert.equal(new URL(denied.headers.get('Location')).pathname, '/leaderboard'); assert.equal(new URL(denied.headers.get('Location')).searchParams.get('auth_error'), 'cancelled');
  }
  const unavailable = await fetchSite(environment(), '/api/auth/github'); assert.equal(unavailable.status, 503);
});

test('Remembered identities work across account, share, avatar, publish and team APIs without widening ownership', async () => {
  const entries = [{ handle: 'google-owned', claimed: true, ownerId: 'google:google-42', googleEmail: 'shared@example.com', tokensAll: 100 }, { handle: 'github-owned', claimed: true, ownerId: 'github:42', accountEmail: 'shared@example.com', tokensAll: 50 }, { handle: 'anonymous', claimed: false, tokensAll: 1 }];
  const env = githubEnv(entries), google = await googleLogin(env), github = await githubFinish(env, await startGithub(env));
  const githubCookie = github.response.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE)).split(';')[0];
  for (const [cookie, handle] of [[google.cookie, 'google-owned'], [githubCookie, 'github-owned']]) {
    const profiles = await fetchSite(env, '/api/account/profiles', { headers: { Cookie: cookie } }); assert.equal(profiles.status, 200); assert.deepEqual((await profiles.json()).profiles.map(item => item.handle), [handle]);
    const sharing = await fetchSite(env, '/api/share/list?handle=' + handle, { headers: { Cookie: cookie } }); assert.equal(sharing.status, 200, await sharing.clone().text());
    const avatar = await fetchSite(env, '/api/profile/avatar', post({ handle, avatarStyle: 'bottts' }, cookie)); assert.equal(avatar.status, 200, await avatar.clone().text());
    const team = await fetchSite(env, '/api/team/invites', post({ name: handle }, cookie)); assert.equal(team.status, 200, await team.clone().text());
    const publicProfile = await fetchSite(env, '/api/user/' + handle); assert.ok(!(await publicProfile.text()).includes('accountEmail'));
    const publish = await fetchSite(env, '/api/leaderboard', post({ handle, tokensAll: 200 }, cookie)); assert.equal(publish.status, 200, await publish.clone().text());
  }
  const other = await fetchSite(env, '/api/profile/avatar', post({ handle: 'google-owned', avatarStyle: 'bottts' }, githubCookie)); assert.equal(other.status, 403);
  env.LEADERBOARD_SECRET = 'publisher-only';
  const takeover = await fetchSite(env, '/api/leaderboard', post({ handle: 'google-owned', tokensAll: 900 }, githubCookie)); assert.equal(takeover.status, 403);
  const trustedPublisher = await fetchSite(env, '/api/leaderboard', post({ handle: 'google-owned', tokensAll: 300 }, '', { 'X-Leaderboard-Secret': 'publisher-only' })); assert.equal(trustedPublisher.status, 200);
  const claimOther = await fetchSite(env, '/api/claim', post({ handle: 'google-owned' }, githubCookie)); assert.equal(claimOther.status, 409);
  const csrf = await fetchSite(env, '/api/team/invites', post({ name: 'Attack' }, githubCookie, { Origin: 'https://evil.example' })); assert.equal(csrf.status, 401);
  const claim = await fetchSite(env, '/api/claim', post({ handle: 'anonymous' }, githubCookie)); assert.equal(claim.status, 200); assert.equal(JSON.parse(env.LEADERBOARD_BUCKET.values.get('leaderboard.json')).find(entry => entry.handle === 'anonymous').ownerId, 'github:42');
});

test('Verified Google mutations preserve existing ownership while discovery uses only canonical principals', async () => {
  const entry = (handle, ownerId, extra = {}) => ({ handle, claimed: true, ownerId,
    googleEmail: 'shared@example.com', claimedAt: 1234, tokensAll: 100, costAll: 12,
    league: 'bronze', division: 3, mmr: 500,
    breakdown: { models: [{ model: 'example-model', provider: 'openai', tokensAll: 100 }] }, ...extra });
  const env = githubEnv([
    entry('legacy-publish', 'google:shared@example.com'),
    entry('legacy-claim', 'google:google_shared@example.com'),
    entry('benebsworth', 'google:benebsworth'),
    entry('exact-google', 'google:google-42'),
    entry('different-google-subject', 'google:another-subject'),
    entry('github-owned', 'github:42', { accountEmail: 'shared@example.com' }),
    entry('secret-publisher', 'google:shared@example.com'),
    entry('github-publisher', 'google:shared@example.com')
  ]);
  const google = await googleLogin(env);
  const owned = async cookie => (await (await fetchSite(env, '/api/account/profiles', { headers: { Cookie: cookie } })).json()).profiles.map(row => row.handle);
  const stored = handle => JSON.parse(env.LEADERBOARD_BUCKET.values.get('leaderboard.json')).find(row => row.handle === handle);
  assert.deepEqual(await owned(google.cookie), ['exact-google'], 'Matching email alone never discovers a legacy or different-subject profile');
  const nativePublish = await fetchSite(env, '/api/leaderboard', post({ handle: 'legacy-publish', tokensAll: 200 }, '', { 'X-Google-Token': await googleToken() }));
  assert.equal(nativePublish.status, 200, await nativePublish.clone().text());
  assert.equal(stored('legacy-publish').ownerId, 'google:shared@example.com');
  assert.equal(stored('legacy-publish').claimedAt, 1234);
  assert.equal(stored('legacy-publish').costAll, 12);
  assert.equal((await nativePublish.json()).entry.ownerId, undefined, 'Ownership metadata remains private');
  for (const handle of ['legacy-claim', 'benebsworth']) {
    const response = await fetchSite(env, '/api/claim', post({ handle }, google.cookie));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).entry.ownerId, undefined);
    assert.equal(stored(handle).ownerId, handle === 'benebsworth' ? 'google:benebsworth' : 'google:google_shared@example.com');
    assert.equal(stored(handle).claimedAt, 1234);
    assert.equal(stored(handle).tokensAll, 100);
  }
  assert.deepEqual(await owned(google.cookie), ['exact-google'], 'Existing mutation compatibility never broadens private profile discovery');
  const exactBefore = env.LEADERBOARD_BUCKET.values.get('leaderboard.json');
  assert.equal((await fetchSite(env, '/api/claim', post({ handle: 'exact-google' }, google.cookie))).status, 200);
  assert.equal(env.LEADERBOARD_BUCKET.values.get('leaderboard.json'), exactBefore, 'An exact-owner claim stays idempotent');
  assert.equal((await fetchSite(env, '/api/claim', post({ handle: 'different-google-subject' }, google.cookie))).status, 200);
  assert.equal(stored('different-google-subject').ownerId, 'google:another-subject', 'An arbitrary canonical subject is not relabeled by matching email');
  assert.equal((await fetchSite(env, '/api/claim', post({ handle: 'github-owned' }, google.cookie))).status, 409);

  const github = await githubFinish(env, await startGithub(env));
  const githubCookie = github.response.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE)).split(';')[0];
  assert.deepEqual(await owned(githubCookie), ['github-owned']);
  assert.equal((await fetchSite(env, '/api/claim', post({ handle: 'legacy-publish' }, githubCookie))).status, 409);
  assert.equal((await fetchSite(env, '/api/leaderboard', post({ handle: 'github-publisher', tokensAll: 300 }, githubCookie))).status, 403);
  env.LEADERBOARD_SECRET = 'publisher-only';
  for (const [handle, cookie] of [['secret-publisher', ''], ['github-publisher', githubCookie]]) {
    const response = await fetchSite(env, '/api/leaderboard', post({ handle, tokensAll: 300 }, cookie, { 'X-Leaderboard-Secret': env.LEADERBOARD_SECRET }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(stored(handle).ownerId, 'google:shared@example.com', 'Write authority without a verified Google owner never migrates ownership');
  }
  const dev = { ...environment([entry('unsigned-dev', 'google:google_shared@example.com')]), GOOGLE_CLIENT_ID: '' };
  const unsigned = await fetchSite(dev, '/api/claim', post({ handle: 'unsigned-dev' }, '', { 'X-Google-Token': 'google:shared@example.com' }));
  assert.equal(unsigned.status, 200);
  assert.equal(JSON.parse(dev.LEADERBOARD_BUCKET.values.get('leaderboard.json'))[0].ownerId, 'google:google_shared@example.com');
});

test('Legacy owner mutations preserve private sharing namespaces without an implicit ownership migration', async () => {
  const entry = (handle, extra = {}) => ({ handle, claimed: true, ownerId: 'google:google_shared@example.com',
    googleEmail: 'shared@example.com', tokensAll: 100, league: 'bronze', division: 3, mmr: 500,
    breakdown: { models: [{ model: 'example-model', tokensAll: 100 }] }, ...extra });
  for (const privateKey of ['groups/google:google_shared_example_com.json',
    'activity/google:google_shared_example_com.json', 'shares-index/legacy-private.json']) {
    const env = environment([entry('legacy-private')]);
    const privateData = JSON.stringify([{ id: 'existing-private-record' }]);
    env.LEADERBOARD_BUCKET.values.set(privateKey, privateData);
    const google = await googleLogin(env);
    for (const route of ['/api/claim', '/api/leaderboard']) {
      const response = await fetchSite(env, route, post({ handle: 'legacy-private', tokensAll: 200 }, google.cookie));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(JSON.parse(env.LEADERBOARD_BUCKET.values.get('leaderboard.json'))[0].ownerId, 'google:google_shared@example.com');
      assert.equal(env.LEADERBOARD_BUCKET.values.get(privateKey), privateData, 'Existing private records stay in their original namespace');
    }
    assert.deepEqual((await (await fetchSite(env, '/api/account/profiles', { headers: { Cookie: google.cookie } })).json()).profiles, []);
  }
  const env = environment([entry('storage-unknown')]);
  const google = await googleLogin(env), get = env.LEADERBOARD_BUCKET.get;
  env.LEADERBOARD_BUCKET.get = async key => {
    if (key.startsWith('groups/')) throw new Error('private state unavailable');
    return get(key);
  };
  assert.equal((await fetchSite(env, '/api/claim', post({ handle: 'storage-unknown' }, google.cookie))).status, 200);
  assert.equal(JSON.parse(env.LEADERBOARD_BUCKET.values.get('leaderboard.json'))[0].ownerId, 'google:google_shared@example.com');

  const unpublished = environment();
  unpublished.LEADERBOARD_BUCKET.values.delete('leaderboard.json');
  const owner = await fetchSite(unpublished, '/api/auth/google', post({ credential: await googleToken({ email: 'ben@benebsworth.com' }) }));
  assert.equal(owner.status, 200);
  const bucketGet = unpublished.LEADERBOARD_BUCKET.get;
  // Existing mutation reads can use a starter fallback on an outage. Claiming
  // that already-claimed fallback must not introduce a stored ownership change.
  unpublished.LEADERBOARD_BUCKET.get = async key => {
    if (key === 'leaderboard.json') throw new Error('leaderboard unavailable');
    return bucketGet(key);
  };
  const claim = await fetchSite(unpublished, '/api/claim', post({ handle: 'benebsworth' }, cookieHeader(owner)));
  assert.equal(claim.status, 200);
  assert.equal(unpublished.LEADERBOARD_BUCKET.values.has('leaderboard.json'), false, 'A fallback seed cannot become a migrated stored account');
});

test('Remembered account profile reads expose storage errors without seeding or private error details', async () => {
  const env = environment(), google = await googleLogin(env);
  let writes = 0;
  env.LEADERBOARD_BUCKET = { async get() { throw new Error('private R2 diagnostic'); }, async put() { ++writes; } };
  const response = await fetchSite(env, '/api/account/profiles', { headers: { Cookie: google.cookie } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), { ok: false, error: 'Could not load your profiles. Try again.' });
  assert.equal(writes, 0);
});

test('Config reports actual providers and /login caches only an anonymous document', async () => {
  const env = environment(); let requested;
  env.ASSETS = { fetch: async request => { requested = request; return new Response('<!doctype html>Anonymous login shell', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public,max-age=0' } }); } };
  const config = await (await fetchSite(env, '/api/config')).json(); assert.equal(config.webSessions, true); assert.equal(config.githubAuth, false);
  const configured = await (await fetchSite(githubEnv(), '/api/config')).json(); assert.equal(configured.githubAuth, true); assert.ok(!JSON.stringify(configured).includes('server-only-secret'));
  const githubOnly = { ...githubEnv(), GOOGLE_CLIENT_ID: '' };
  assert.equal((await fetchSite(githubOnly, '/api/account/profiles', { headers: { 'X-Google-Token': 'google:shared@example.com' } })).status, 401);
  const canonical = await fetchSite(env, '/login/?signin=1'); assert.equal(canonical.status, 301); assert.equal(canonical.headers.get('Location'), 'https://token-horizon.dev/login?signin=1');
  const unsupported = await fetchSite(env, '/login', { method: 'POST' }); assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('Cache-Control'), 'no-store');
  const document = await fetchSite(env, '/login?returnTo=/u/me', { headers: { Cookie: '__Host-th-session=private' } }); assert.equal(new URL(requested.url).pathname, '/leaderboard'); assert.equal(requested.headers.get('Cookie'), null); assert.match(document.headers.get('Cache-Control'), /public/); assert.ok(!(await document.text()).includes('private'));
});

test('Bounded body deadline terminates stalled streams without awaiting cancel', async () => {
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
  const start = Date.now(); await assert.rejects(boundedText(new Response(stream), 100, { timeoutMs: 20 }), /timed out/); assert.ok(Date.now() - start < 1000);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200)); }, cancel() { return new Promise(() => {}); } });
  await assert.rejects(boundedText(new Response(oversized), 100, { timeoutMs: 20 }), RangeError);
});
