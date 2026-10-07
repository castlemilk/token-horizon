import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import worker from './src/index.js';
import { loadTeamLogoDataUri } from './src/team-invites.js';

function mockR2Bucket(initialEntries = null) {
  let stored = initialEntries ? JSON.stringify(initialEntries) : null;
  let version = stored === null ? 0 : 1;
  return {
    async get(key) {
      if (stored === null) return null;
      const value = stored;
      return { json: async () => JSON.parse(value), text: async () => value, etag: String(version) };
    },
    async put(key, value, options) {
      const condition = options?.onlyIf;
      if (condition?.etagDoesNotMatch === '*' && stored !== null) return null;
      if (condition?.etagMatches && condition.etagMatches !== String(version)) return null;
      stored = typeof value === 'string' ? value : JSON.stringify(value);
      return { etag: String(++version) };
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
  const versions = new Map();
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
      return { json: async () => JSON.parse(v), text: async () => v, etag: String(versions.get(key)) };
    },
    async put(key, value, opts) {
      const condition = opts?.onlyIf;
      if (condition?.etagDoesNotMatch === '*' && store.has(key)) return null;
      if (condition?.etagMatches && condition.etagMatches !== String(versions.get(key))) return null;
      versions.set(key, (versions.get(key) || 0) + 1);
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        store.set(key, { bytes, contentType: (opts && opts.httpMetadata && opts.httpMetadata.contentType) || "application/octet-stream" });
        return;
      }
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      return { etag: String(versions.get(key)) };
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const matching = [...store.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = Number(cursor) || 0;
      const page = matching.slice(start, start + limit);
      return { objects: page.map(key => ({ key })), truncated: start + page.length < matching.length, cursor: String(start + page.length) };
    },
    async delete(key) { store.delete(key); versions.delete(key); }
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

async function ogShareFixture() {
  const { keyPair, jwk } = await makeGoogleKeyPair();
  const clientId = 'og-shares.apps.googleusercontent.com';
  const now = Math.floor(Date.now() / 1000);
  const ownerEntry = {
    handle: 'private_owner', claimed: true, ownerId: 'google:og-owner', googleEmail: 'owner@example.com',
    team: 'HiddenTeamXYZ', hardware: 'M999Secret', tokensAll: 712345, tokensToday: 123456, tokens7d: 654321,
    costAll: 42.19, costToday: 7.11, updatedAt: now, mmr: 987, streakDays: 17,
    breakdown: { models: [{ provider: 'anthropic', model: 'SecretModelABC', tokensAll: 712345, requests: 83 }],
      daily: [{ day: now - 86400, tokens: 13579 }], history: [{ day: now - 86400, tokens: 13579, cost: 4.44 }],
      sessions: [{ title: 'SecretPromptABC', tokens: 12345 }] }
  };
  const env = {
    ...createMultiKeyEnv([ownerEntry,
      { handle: 'friend_dev', claimed: true, ownerId: 'google:og-friend', tokensAll: 500, team: 'HiddenTeamXYZ' },
      { handle: 'pretender', claimed: true, ownerId: 'google:og-stranger', googleEmail: 'friend@example.com', tokensAll: 50, team: 'HiddenTeamXYZ' }]),
    GOOGLE_CLIENT_ID: clientId, GOOGLE_JWKS: JSON.stringify({ keys: [jwk] }),
    ASSETS: { async fetch(request) {
      assert.equal(request.method, 'GET', 'metadata injection must fetch complete HTML for HEAD');
      return new Response('<html><head><title>spa</title><meta name="description" content="static"></head><body>spa</body></html>', { headers: { 'Content-Type': 'text/html' } });
    } }
  };
  const owner = await makeGoogleToken(keyPair, { clientId, sub: 'og-owner', email: 'owner@example.com' });
  const friend = await makeGoogleToken(keyPair, { clientId, sub: 'og-friend', email: 'friend@example.com' });
  const stranger = await makeGoogleToken(keyPair, { clientId, sub: 'og-stranger', email: 'stranger@example.com' });
  const call = (path, token, options = {}) => worker.fetch(req(path, { ...options, headers: { ...options.headers, ...(token ? { 'X-Google-Token': token } : {}) } }), env);
  const create = async (body = {}) => {
    const res = await call('/api/share/create', owner, { method: 'POST', body: { handle: ownerEntry.handle, scope: 'private', ...body } });
    assert.equal(res.status, 200);
    return (await res.json()).share;
  };
  return { env, ownerEntry, owner, friend, stranger, call, create,
    token: (sub, extra = {}) => makeGoogleToken(keyPair, { clientId, sub, ...extra }) };
}

async function teamFixture() {
  const { keyPair, jwk } = await makeGoogleKeyPair();
  const clientId = 'team-invites.apps.googleusercontent.com';
  const env = { ...createMultiKeyEnv([]), GOOGLE_CLIENT_ID: clientId, GOOGLE_JWKS: JSON.stringify({ keys: [jwk] }) };
  const token = (sub, extra = {}) => makeGoogleToken(keyPair, { clientId, sub, email: `${sub}@example.com`, ...extra });
  const call = async (path, auth, body) => {
    const response = await worker.fetch(req(path, { ...(body !== undefined ? { method: 'POST', body } : {}), headers: auth ? { 'X-Google-Token': auth } : {} }), env);
    return { response, status: response.status, data: await response.json() };
  };
  return { env, token, call };
}

describe('Account team invites', () => {
  it('requires verified Google auth, keeps owner links private, and joins without manufacturing a profile', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('owner'), friend = await token('friend');
    const expired = await token('owner', { exp: Math.floor(Date.now() / 1000) - 60 });
    const wrongAudience = await token('owner', { aud: 'another-app' });
    for (const auth of ['', expired, wrongAudience, 'google:owner@example.com']) {
      for (const [path, body] of [['/api/account/team', undefined], ['/api/team/invites', { name: 'Orbit Club' }], ['/api/team/join', { token: 'a'.repeat(48) }]]) {
        const result = await call(path, auth, body);
        assert.equal(result.status, 401);
        assert.equal(result.data.code, 'auth_required');
        assert.equal(result.response.headers.get('Cache-Control'), 'private, no-store');
      }
    }
    assert.deepEqual((await call('/api/account/team', owner)).data, { ok: true, team: null, invites: [] });
    const created = await call('/api/team/invites', owner, { name: 'Orbit Club' });
    assert.equal(created.status, 200);
    assert.equal(created.data.team.role, 'owner');
    assert.equal(created.data.team.memberCount, 1);
    assert.match(created.data.team.id, /^[a-f0-9]{32}$/);
    const invite = created.data.invites[0];
    assert.match(invite.token, /^[a-f0-9]{48}$/);
    assert.equal(invite.url, `https://token-horizon.dev/invite/${invite.token}`);
    assert.equal(invite.expiresAt - invite.createdAt, 30 * 86400000);
    const publicInvite = await call(`/api/team/invites/${invite.token}`);
    assert.deepEqual(Object.keys(publicInvite.data).sort(), ['expiresAt', 'ok', 'team']);
    assert.deepEqual(Object.keys(publicInvite.data.team).sort(), ['id', 'logoUpdatedAt', 'logoUrl', 'memberCount', 'name', 'ogImage', 'url']);
    assert.equal(publicInvite.response.headers.get('Referrer-Policy'), 'no-referrer');
    const joined = await call('/api/team/join', friend, { token: invite.token, handle: 'someone-elses-profile' });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.team.role, 'member');
    assert.equal(joined.data.team.memberCount, 2);
    assert.deepEqual(joined.data.invites, []);
    const repeat = await call('/api/team/join', friend, { token: invite.token });
    assert.equal(repeat.data.alreadyMember, true);
    assert.equal(repeat.data.team.memberCount, 2);
    assert.deepEqual((await call('/api/account/profiles', friend)).data, { profiles: [] });
    assert.deepEqual(await (await env.LEADERBOARD_BUCKET.get('leaderboard.json')).json(), []);
    const reused = await call('/api/team/invites', owner, { name: 'Untrusted rename' });
    assert.equal(reused.data.team.name, 'Orbit Club');
    assert.equal(reused.data.invites[0].token, invite.token);
  });

  it('overlays exact account membership on existing/future publishes and keeps equal legacy labels separate', async () => {
    const { token, call } = await teamFixture();
    const owner = await token('crew-owner'), friend = await token('crew-friend');
    await call('/api/leaderboard', owner, { handle: 'captain', team: 'Old label', tokensAll: 1000 });
    const created = await call('/api/team/invites', owner, { name: 'Star Friends' });
    const teamId = created.data.team.id, inviteToken = created.data.invites[0].token;
    assert.equal((await call('/api/user/captain')).data.entry.teamId, teamId);
    await call('/api/team/join', friend, { token: inviteToken });
    const firstPublish = await call('/api/leaderboard', friend, { handle: 'navigator', team: 'Local stale label', teamId: 'f'.repeat(32), tokensAll: 500 });
    assert.equal(firstPublish.data.entry.teamId, teamId);
    assert.equal(firstPublish.data.entry.team, 'Star Friends');
    const nextPublish = await call('/api/leaderboard', friend, { handle: 'navigator', team: 'Another stale label', tokensAll: 600 });
    assert.equal(nextPublish.data.entry.teamId, teamId);
    await call('/api/leaderboard', undefined, { handle: 'label-spoofer', team: 'Star Friends', teamId, tokensAll: 2000 });
    const teams = (await call('/api/teams')).data.teams;
    const canonical = teams.find(team => team.teamId === teamId);
    assert.equal(canonical.members, 2);
    assert.equal(canonical.tokens, 1600);
    assert.equal(teams.filter(team => team.team === 'Star Friends').length, 2);
    const friendDetails = (await call('/api/user/navigator')).data;
    assert.equal(friendDetails.teamTotal, 2);
    assert.equal(friendDetails.teamRank, 2);
    assert.equal((await call('/api/user/label-spoofer')).data.teamTotal, 1);
    const filtered = (await call(`/api/leaderboard?team=${teamId}`)).data;
    assert.equal(filtered.total, 2);
    assert.ok(filtered.leaderboard.every(row => row.entry.teamId === teamId));
    const legacyFiltered = (await call('/api/leaderboard?team=Star%20Friends')).data;
    assert.equal(legacyFiltered.total, 1);
    assert.equal(legacyFiltered.leaderboard[0].entry.handle, 'label-spoofer');
    const ownedAgain = await call('/api/claim', friend, { handle: 'navigator' });
    assert.equal(ownedAgain.data.entry.ownerId, undefined);
    assert.equal(ownedAgain.data.entry.teamId, teamId);
  });

  it('applies a profileless membership on claim and does not enroll an email-only ownership match', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('claim-owner'), friend = await token('claim-friend');
    const created = await call('/api/team/invites', owner, { name: 'Claim Crew' });
    const teamId = created.data.team.id;
    await call('/api/team/join', friend, { token: created.data.invites[0].token });
    const anonymous = await call('/api/leaderboard', undefined, { handle: 'claim-target', tokensAll: 42 });
    const claimed = await call('/api/claim', friend, { handle: 'claim-target', claimToken: anonymous.data.claimToken });
    assert.equal(claimed.data.entry.teamId, teamId);
    const entries = await (await env.LEADERBOARD_BUCKET.get('leaderboard.json')).json();
    entries.push({ handle: 'different-subject', team: 'Independent', tokensAll: 99, claimed: true, ownerId: 'google:another-subject', googleEmail: 'claim-friend@example.com', breakdown: { models: [{ model: 'example', provider: 'openai', tokensAll: 99 }] } });
    await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify(entries));
    const unrelated = (await call('/api/user/different-subject')).data.entry;
    assert.equal(unrelated.team, 'Independent');
    assert.equal(unrelated.teamId, undefined);
    const ownerDetails = await call('/api/account/team', friend);
    assert.equal(ownerDetails.data.team.memberCount, 2);
  });

  it('retires links immediately, rejects expired/invalid links, and only lets the owner manage invitations', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('retire-owner'), friend = await token('retire-friend');
    const created = await call('/api/team/invites', owner, { name: 'Moon Club' });
    const inviteToken = created.data.invites[0].token;
    await call('/api/team/join', friend, { token: inviteToken });
    assert.equal((await call('/api/team/invites/revoke', friend, { token: inviteToken })).status, 403);
    assert.equal((await call('/api/team/invites', friend, { name: 'Hijacked' })).status, 403);
    assert.equal((await call('/api/team/invites/revoke', owner, { token: 'b'.repeat(48) })).status, 404);
    assert.equal((await call('/api/team/invites/not-valid')).status, 404);
    const retired = await call('/api/team/invites/revoke', owner, { token: inviteToken });
    assert.equal(retired.data.invites[0].revoked, true);
    assert.equal((await call(`/api/team/invites/${inviteToken}`)).data.code, 'invite_revoked');
    const stranger = await token('late-friend');
    assert.equal((await call('/api/team/join', stranger, { token: inviteToken })).status, 410);
    const renewed = await call('/api/team/invites', owner, {});
    const active = renewed.data.invites.find(invite => !invite.revoked);
    assert.notEqual(active.token, inviteToken);
    const inviteKeys = (await env.LEADERBOARD_BUCKET.list({ prefix: `team-membership/invites/${created.data.team.id}/` })).objects;
    for (const { key } of inviteKeys) {
      const stored = await (await env.LEADERBOARD_BUCKET.get(key)).json();
      if (stored.token === active.token) await env.LEADERBOARD_BUCKET.put(key, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));
    }
    assert.equal((await call(`/api/team/invites/${active.token}`)).data.code, 'invite_expired');
    assert.equal((await call('/api/team/join', stranger, { token: active.token })).status, 410);
    assert.equal((await call('/api/account/team', friend)).data.team.memberCount, 2);
  });

  it('requires confirmation for members switching teams and keeps owners with their own team', async () => {
    const { token, call } = await teamFixture();
    const firstOwner = await token('first-owner'), secondOwner = await token('second-owner'), friend = await token('switch-friend');
    const first = (await call('/api/team/invites', firstOwner, { name: 'Same Name' })).data;
    const second = (await call('/api/team/invites', secondOwner, { name: 'Same Name' })).data;
    assert.notEqual(first.team.id, second.team.id);
    await call('/api/team/join', friend, { token: first.invites[0].token });
    const pending = await call('/api/team/join', friend, { token: second.invites[0].token });
    assert.equal(pending.status, 409);
    assert.equal(pending.data.code, 'team_switch_required');
    assert.equal((await call('/api/account/team', friend)).data.team.id, first.team.id);
    const switched = await call('/api/team/join', friend, { token: second.invites[0].token, confirmSwitch: true });
    assert.equal(switched.data.team.id, second.team.id);
    assert.equal((await call('/api/account/team', firstOwner)).data.team.memberCount, 1);
    assert.equal((await call('/api/account/team', secondOwner)).data.team.memberCount, 2);
    const ownerCannotMove = await call('/api/team/join', firstOwner, { token: second.invites[0].token, confirmSwitch: true });
    assert.equal(ownerCannotMove.status, 409);
    assert.equal(ownerCannotMove.data.code, 'team_owner');
    assert.equal((await call('/api/account/team', firstOwner)).data.team.id, first.team.id);
  });

  it('keeps simultaneous friends additive and conditionally prevents the same account joining two teams', async () => {
    const { token, call } = await teamFixture();
    const owner = await token('parallel-owner'), otherOwner = await token('parallel-other');
    const first = (await call('/api/team/invites', owner, { name: 'Parallel Crew' })).data;
    const second = (await call('/api/team/invites', otherOwner, { name: 'Other Crew' })).data;
    const friends = await Promise.all(Array.from({ length: 12 }, (_, index) => token(`parallel-friend-${index}`)));
    const joined = await Promise.all(friends.map(auth => call('/api/team/join', auth, { token: first.invites[0].token })));
    assert.ok(joined.every(result => result.status === 200));
    assert.equal((await call('/api/account/team', owner)).data.team.memberCount, 13);
    const racing = await token('racing-account');
    const race = await Promise.all([first, second].map(team => call('/api/team/join', racing, { token: team.invites[0].token })));
    assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
    const current = (await call('/api/account/team', racing)).data.team.id;
    assert.ok(current === first.team.id || current === second.team.id);
    const total = (await call('/api/account/team', owner)).data.team.memberCount + (await call('/api/account/team', otherOwner)).data.team.memberCount;
    assert.equal(total, 15);
  });

  it('bounds request bodies and serves nested invite URLs with working relative assets and private referrers', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('input-owner');
    for (const name of ['', 'x'.repeat(65), 'Bad\nName', 123]) {
      assert.equal((await call('/api/team/invites', owner, { name })).status, 400);
    }
    const tooLarge = await call('/api/team/invites', owner, { name: 'Crew', padding: 'x'.repeat(9000) });
    assert.equal(tooLarge.status, 413);
    let servedPath;
    env.ASSETS = { async fetch(request) { servedPath = new URL(request.url).pathname; return new Response('<!doctype html><html><head><title>Token Horizon</title></head><body></body></html>'); } };
    const response = await worker.fetch(req(`/invite/${'c'.repeat(48)}`), env);
    assert.equal(response.status, 200);
    assert.equal(servedPath, '/leaderboard');
    assert.match(await response.text(), /<base href="\/">/);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  });

  it('repairs the member index when a retry follows a partial storage failure', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('repair-owner'), friend = await token('repair-friend');
    const originalPut = env.LEADERBOARD_BUCKET.put.bind(env.LEADERBOARD_BUCKET);
    let failMemberIndex = true;
    env.LEADERBOARD_BUCKET.put = async (key, ...args) => {
      if (failMemberIndex && key.startsWith('team-membership/members/')) {
        failMemberIndex = false;
        throw new Error('Simulated storage interruption after account commit');
      }
      return await originalPut(key, ...args);
    };
    assert.equal((await call('/api/team/invites', owner, { name: 'Resilient Crew' })).status, 503);
    const recovered = await call('/api/team/invites', owner, { name: 'Resilient Crew' });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.team.memberCount, 1);
    failMemberIndex = true;
    assert.equal((await call('/api/team/join', friend, { token: recovered.data.invites[0].token })).status, 503);
    const joined = await call('/api/team/join', friend, { token: recovered.data.invites[0].token });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.alreadyMember, true);
    assert.equal(joined.data.team.memberCount, 2);
  });

  it('deduplicates shared-owner metadata and reuses it across public reads without delaying the static catalog', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('metadata-owner');
    await call('/api/leaderboard', owner, { handle: 'work-profile', tokensAll: 100 });
    await call('/api/leaderboard', owner, { handle: 'home-profile', tokensAll: 200 });
    await call('/api/team/invites', owner, { name: 'Fast Crew' });
    const originalGet = env.LEADERBOARD_BUCKET.get.bind(env.LEADERBOARD_BUCKET);
    const metadataGets = [];
    env.LEADERBOARD_BUCKET.get = async key => {
      if (key.startsWith('team-membership/')) metadataGets.push(key);
      return await originalGet(key);
    };
    await call('/api/account/profiles', owner);
    await call('/api/models/usage');
    assert.equal(metadataGets.length, 0);
    await call('/api/leaderboard');
    assert.equal(metadataGets.filter(key => key.includes('/accounts/')).length, 1);
    assert.equal(metadataGets.filter(key => key.includes('/teams/')).length, 1);
    const count = metadataGets.length;
    await call('/api/user/work-profile');
    assert.equal(metadataGets.length, count);
    await call('/api/teams');
    const enrichedCount = metadataGets.length;
    assert.equal(enrichedCount, count + 2); // One roster index row + its authoritative account.
    assert.equal(metadataGets.filter(key => key.includes('/teams/')).length, 1);
    await call('/api/teams');
    assert.equal(metadataGets.length, enrichedCount);
    env.ASSETS = { async fetch() { return new Response(JSON.stringify({ models: [] }), { headers: { 'Content-Type': 'application/json' } }); } };
    await call('/api/models/catalog');
    assert.equal(metadataGets.length, enrichedCount);
  });

  it('repairs an invite lookup index when creation is retried after a partial storage failure', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('link-repair-owner');
    const originalPut = env.LEADERBOARD_BUCKET.put.bind(env.LEADERBOARD_BUCKET);
    let failPointer = true;
    env.LEADERBOARD_BUCKET.put = async (key, ...args) => {
      if (failPointer && key.startsWith('team-membership/invite-links/')) {
        failPointer = false;
        throw new Error('Simulated invite lookup index interruption');
      }
      return await originalPut(key, ...args);
    };
    assert.equal((await call('/api/team/invites', owner, { name: 'Restored Link Crew' })).status, 503);
    const recovered = await call('/api/team/invites', owner, { name: 'Restored Link Crew' });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.invites.length, 1);
    const lookup = await call(`/api/team/invites/${recovered.data.invites[0].token}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.team.id, recovered.data.team.id);
  });

  it('keeps public usage available during membership read failures without asserting canonical membership', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('outage-owner');
    const team = (await call('/api/team/invites', owner, { name: 'Available Crew' })).data;
    await call('/api/leaderboard', owner, { handle: 'outage-profile', tokensAll: 4321 });
    const originalGet = env.LEADERBOARD_BUCKET.get.bind(env.LEADERBOARD_BUCKET);
    env.LEADERBOARD_BUCKET.get = async key => {
      if (key.startsWith('team-membership/accounts/')) throw new Error('Simulated membership metadata interruption');
      return await originalGet(key);
    };
    const publicUsage = await call('/api/leaderboard');
    assert.equal(publicUsage.status, 200);
    assert.equal(publicUsage.data.kpis.totalTokens, 4321);
    assert.equal(publicUsage.data.leaderboard[0].entry.teamId, undefined);
    assert.equal(publicUsage.data.leaderboard[0].entry.team, '');
    const models = await call('/api/models/usage');
    assert.equal(models.status, 200);
    assert.equal(models.data.models[0].tokens, 4321);
    assert.equal((await call('/api/team/join', owner, { token: team.invites[0].token })).status, 503);
    assert.equal((await call('/api/leaderboard', owner, { handle: 'outage-profile', tokensAll: 9999 })).status, 500);
    const stored = await (await originalGet('leaderboard.json')).json();
    assert.equal(stored[0].tokensAll, 4321);
    assert.equal(stored[0].teamId, team.team.id);
  });
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
    const day = (Math.floor(Date.now() / 1000 / 86400) - 1) * 86400;
    const pts = (a, b) => [{ day, dayLabel: 'D1', tokens: a }, { day: day + 86400, dayLabel: 'D2', tokens: b }];
    const model = (provider, id) => ({ provider, model: id, tokensToday: 0, tokensAll: 100, costToday: 0, costAll: 0, sharePercent: 100 });
    const env = createMultiKeyEnv([
      { handle: 'a', tokensAll: 100, breakdown: { models: [model('anthropic', 'm1')], tools: [], history: [], daily: [{ day, dayLabel: 'D1', tokens: 10, cost: 0 }], modelHistory: [{ model: 'm1', provider: 'anthropic', points: pts(10, 20) }] } },
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

  it('GET /api/providers uses source buckets and never derives usage dates from cumulative snapshots', async () => {
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
    assert.equal(p1.values.openai, undefined); // Legacy totals have no known usage dates.
    assert.equal(p2.values.openai, undefined);
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

  it('GET /api/prompts is private by default and requires PROMPTS_PUBLIC opt-in', async () => {
    const day = Math.floor(Date.now() / 1000 / 86400) - 1;
    const mk = () => createMultiKeyEnv([
      { handle: 'a', tokensAll: 100, breakdown: { models: [{ provider: 'anthropic', model: 'm1', tokensAll: 100, tokensToday: 0, sharePercent: 100 }], tools: [], history: [], sessions: [
        { title: 'Code review assistant', provider: 'anthropic', model: 'm1', tokens: 10, cost: 1, requests: 2, at: day * 86400 },
        { title: '', provider: 'openai', model: 'm2', tokens: 5, cost: 0.5, requests: 1, at: day * 86400 }
      ] } }
    ]);
    // Default: prompt history is never public.
    const privateEnv = mk();
    const res = await worker.fetch(req('/api/prompts'), privateEnv);
    assert.equal(res.status, 404);
    const providers = await (await worker.fetch(req('/api/providers?days=30'), privateEnv)).json();
    assert.deepEqual(providers.topPrompts, []);
    // Explicit opt-in: only title-bearing (owner-opted-in) sessions surface.
    const publicEnv = { ...mk(), PROMPTS_PUBLIC: '1' };
    const pub = await worker.fetch(req('/api/prompts'), publicEnv);
    assert.equal(pub.status, 200);
    const data = await pub.json();
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

  it('exposes published team window totals without changing all-time cost, provider mix or ordering', async () => {
    const env = createMultiKeyEnv([
      { handle: 'crew-a', team: 'Crew', tokensAll: 600, tokensToday: 12, tokens7d: 110, costAll: 1.25,
        breakdown: { models: [{ provider: 'claude', model: 'a', tokensAll: 600, tokensToday: 999, costAll: 1.25 }] } },
      { handle: 'crew-b', team: 'Crew', tokensAll: 400, tokensToday: 8, tokens7d: 90, costAll: 0,
        breakdown: { models: [{ provider: 'openai', model: 'b', tokensAll: 400 }] } },
      { handle: 'crew-old', team: 'Crew', tokensAll: 100, costAll: 0,
        breakdown: { models: [{ provider: 'claude', model: 'a', tokensAll: 100 }] } },
      { handle: 'other', team: 'Other', tokensAll: 900, tokensToday: 100, tokens7d: 500, costAll: 5,
        breakdown: { models: [{ provider: 'openai', model: 'b', tokensAll: 900 }] } }
    ]);
    for (const path of ['/api/teams', '/api/providers']) {
      const response = await worker.fetch(req(path), env);
      assert.equal(response.status, 200);
      const { teams } = await response.json();
      assert.deepEqual(teams.map(team => team.team), ['Crew', 'Other'], path);
      const crew = teams[0];
      assert.equal(crew.tokens, 1100, path);
      assert.equal(crew.tokensToday, 20, path);
      assert.equal(crew.tokens7d, 200, path);
      assert.deepEqual(crew.recentWindowProfiles, { today: 2, week: 2 }, path);
      assert.equal(crew.cost, 1.25, path);
      assert.equal(crew.members, 3, path);
      assert.equal(crew.publishedProfiles, 3, path);
      assert.deepEqual(crew.providers, { anthropic: 700, openai: 400 }, path);
      assert.equal(teams[1].tokensToday, 100, path);
      assert.equal(teams[1].tokens7d, 500, path);
      assert.deepEqual(teams[1].recentWindowProfiles, { today: 1, week: 1 }, path);
    }
  });

  it('distinguishes missing team windows from explicit zero and reports mixed profile coverage per window', async () => {
    const profile = (handle, team, windows = {}) => ({ handle, team, tokensAll: 100,
      breakdown: { models: [{ model: 'm', provider: 'openai', tokensAll: 100 }] }, ...windows });
    const env = createMultiKeyEnv([
      profile('old', 'No windows'),
      profile('zero', 'Published zero', { tokensToday: 0, tokens7d: 0 }),
      profile('today-only', 'Partial', { tokensToday: 8 }),
      profile('week-only', 'Partial', { tokens7d: 20 }),
      profile('both-zero', 'Partial', { tokensToday: 0, tokens7d: 0 }),
      profile('invalid', 'Invalid windows', { tokensToday: null, tokens7d: 'unavailable' })
    ]);
    for (const path of ['/api/teams', '/api/providers']) {
      const { teams } = await (await worker.fetch(req(path), env)).json();
      const noWindows = teams.find(team => team.team === 'No windows');
      const zero = teams.find(team => team.team === 'Published zero');
      const partial = teams.find(team => team.team === 'Partial');
      const invalid = teams.find(team => team.team === 'Invalid windows');
      assert.deepEqual(noWindows.recentWindowProfiles, { today: 0, week: 0 }, path);
      assert.deepEqual(zero.recentWindowProfiles, { today: 1, week: 1 }, path);
      assert.equal(noWindows.tokensToday, 0, path);
      assert.equal(zero.tokensToday, 0, path);
      assert.equal(noWindows.tokens7d, 0, path);
      assert.equal(zero.tokens7d, 0, path);
      assert.equal(partial.publishedProfiles, 3, path);
      assert.deepEqual(partial.recentWindowProfiles, { today: 2, week: 2 }, path);
      assert.equal(partial.tokensToday, 8, path);
      assert.equal(partial.tokens7d, 20, path);
      assert.deepEqual(invalid.recentWindowProfiles, { today: 0, week: 0 }, path);
      assert.equal(invalid.tokensToday, 0, path);
      assert.equal(invalid.tokens7d, 0, path);
    }
  });

  it('sums published team daily records into UTC buckets without changing ranking totals or filling missing dates', async t => {
    const now = Date.parse('2026-10-02T00:30:00Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    const end = Math.floor(now / 86400000) * 86400, start = end - 118 * 86400;
    const env = createMultiKeyEnv([
      { handle: 'daily-a', team: 'Daily Crew', tokensAll: 600, tokensToday: 12, tokens7d: 110, costAll: 1.25,
        breakdown: { models: [{ provider: 'claude', model: 'a', tokensAll: 600 }], daily: [
          { day: end + 86399, tokens: 10 }, { day: start + 1, tokens: 5 },
          { day: end - 1, tokens: 20 }, { day: end - 2 * 86400, tokens: 0 },
          { day: start - 1, tokens: 99999 }, { day: end + 86400, tokens: 99999 }
        ] } },
      { handle: 'daily-b', team: 'Daily Crew', tokensAll: 400, tokensToday: 8, tokens7d: 90, costAll: 0,
        breakdown: { models: [{ provider: 'openai', model: 'b', tokensAll: 400 }], daily: [
          { day: end - 86400, tokens: 30 }, { day: start + 3600, tokens: 7 }, { day: end + 7200, tokens: 15 }
        ] } },
      { handle: 'daily-old', team: 'Daily Crew', tokensAll: 100,
        breakdown: { models: [{ provider: 'claude', model: 'a', tokensAll: 100 }], history: [{ day: end, tokens: 99999 }] } }
    ]);
    const expected = [{ day: start, tokens: 12 }, { day: end - 2 * 86400, tokens: 0 },
      { day: end - 86400, tokens: 50 }, { day: end, tokens: 25 }];
    for (const path of ['/api/teams', '/api/providers']) {
      const response = await worker.fetch(req(path), env);
      assert.equal(response.status, 200, path);
      const { teams } = await response.json(), crew = teams[0];
      assert.deepEqual(crew.daily, expected, path);
      assert.equal(crew.daily.some(point => point.day === end - 3 * 86400), false, 'Unreported dates stay absent');
      assert.equal(crew.tokens, 1100, path);
      assert.equal(crew.tokensToday, 20, path);
      assert.equal(crew.tokens7d, 200, path);
      assert.deepEqual(crew.recentWindowProfiles, { today: 2, week: 2 }, path);
      assert.equal(crew.cost, 1.25, path);
      assert.equal(crew.members, 3, path);
      assert.equal(crew.publishedProfiles, 3, path);
      assert.deepEqual(crew.providers, { anthropic: 700, openai: 400 }, path);
      assert.deepEqual(crew.users.map(user => user.handle), ['daily-a', 'daily-b', 'daily-old'], path);
    }
  });

  it('bounds team daily history to 119 days and ignores malformed, negative and nonfinite records', async t => {
    const now = Date.parse('2026-10-02T23:59:59Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    const end = Math.floor(now / 86400000) * 86400;
    const profile = (handle, team, daily) => ({ handle, team, tokensAll: 100,
      breakdown: { models: [{ provider: 'openai', model: 'm', tokensAll: 100 }], ...(daily === undefined ? {} : { daily }) } });
    const malformed = [null, false, 'record', [], {}, { day: end }, { tokens: 12 },
      ...[null, true, [], {}, '', ' ', 'NaN', 'Infinity', '1e309', -1].map(tokens => ({ day: end, tokens })),
      ...[null, true, [], {}, '', ' ', 'NaN', 'Infinity', '1e309', -1].map(day => ({ day, tokens: 99999 })),
      { day: end - 119 * 86400, tokens: 99999 }, { day: end + 86400, tokens: 99999 },
      { day: String(end + 1), tokens: '12' }];
    const env = createMultiKeyEnv([
      profile('bounded', 'Bounded', Array.from({ length: 130 }, (_, i) => ({ day: end - i * 86400 + 750, tokens: 1 }))),
      profile('invalid', 'Invalid', malformed),
      profile('missing', 'Unavailable'), profile('empty', 'Unavailable', []),
      profile('object', 'Unavailable', { day: end, tokens: 10 }), profile('string', 'Unavailable', 'not an array'),
      profile('zero', 'Explicit zero', [{ day: end, tokens: 0 }])
    ]);
    for (const path of ['/api/teams', '/api/providers']) {
      const response = await worker.fetch(req(path), env);
      assert.equal(response.status, 200, path);
      const { teams } = await response.json();
      const bounded = teams.find(team => team.team === 'Bounded');
      assert.equal(bounded.daily.length, 119, path);
      assert.deepEqual(bounded.daily[0], { day: end - 118 * 86400, tokens: 1 }, path);
      assert.deepEqual(bounded.daily.at(-1), { day: end, tokens: 1 }, path);
      assert.equal(bounded.daily.reduce((sum, point) => sum + point.tokens, 0), 119, path);
      assert.deepEqual(teams.find(team => team.team === 'Invalid').daily, [{ day: end, tokens: 12 }], path);
      assert.deepEqual(teams.find(team => team.team === 'Unavailable').daily, [], path);
      assert.deepEqual(teams.find(team => team.team === 'Explicit zero').daily, [{ day: end, tokens: 0 }], path);
      assert.equal(teams.every(team => team.tokensToday === 0 && team.tokens7d === 0), true, path);
      assert.equal(teams.every(team => team.recentWindowProfiles.today === 0 && team.recentWindowProfiles.week === 0), true, path);
    }
  });

  it('keeps canonical and same-name legacy daily histories separate and reuses them on public team pages', async t => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    const end = Math.floor(now / 86400000) * 86400;
    const { env, token, call } = await teamFixture();
    const owner = await token('daily-owner'), other = await token('daily-other'), emptyOwner = await token('daily-empty');
    const first = (await call('/api/team/invites', owner, { name: 'Same name' })).data.team;
    const second = (await call('/api/team/invites', other, { name: 'Same name' })).data.team;
    const empty = (await call('/api/team/invites', emptyOwner, { name: 'Empty daily' })).data.team;
    const profile = (handle, ownerId, tokensAll, daily) => ({ handle, team: 'Same name', tokensAll,
      ...(ownerId ? { claimed: true, ownerId: 'google:' + ownerId } : {}),
      breakdown: { models: [{ provider: 'openai', model: 'm', tokensAll }], daily } });
    await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify([
      profile('canonical-a', 'daily-owner', 100, [{ day: end, tokens: 2 }, { day: end - 86400 + 500, tokens: 3 }]),
      profile('canonical-b', 'daily-owner', 200, [{ day: end + 500, tokens: 5 }]),
      profile('canonical-other', 'daily-other', 300, [{ day: end, tokens: 17 }]),
      profile('legacy', '', 400, [{ day: end, tokens: 23 }])
    ]));
    const expected = [{ day: end - 86400, tokens: 3 }, { day: end, tokens: 7 }];
    for (const path of ['/api/teams', '/api/providers']) {
      const { teams } = (await call(path)).data;
      assert.equal(teams.length, 3, path);
      const canonical = teams.find(team => team.teamId === first.id);
      assert.deepEqual(canonical.daily, expected, path);
      assert.equal(canonical.tokens, 300, path);
      assert.equal(canonical.publishedProfiles, 2, path);
      assert.equal(canonical.memberCount, 1, path);
      assert.deepEqual(teams.find(team => team.teamId === second.id).daily, [{ day: end, tokens: 17 }], path);
      assert.deepEqual(teams.find(team => !team.teamId).daily, [{ day: end, tokens: 23 }], path);
      assert.equal(teams.find(team => !team.teamId).tokens, 400, path);
    }
    const detail = await call(`/api/team/${first.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.stats.daily, expected);
    assert.equal(detail.data.stats.tokens, 300);
    assert.equal(detail.data.stats.publishedProfiles, 2);
    const fallback = (await call(`/api/team/${empty.id}`)).data.stats;
    assert.deepEqual(fallback.daily, []);
    assert.equal(fallback.tokens, 0);
    assert.equal(fallback.memberCount, 1);
    assert.equal(fallback.publishedProfiles, 0);
    assert.deepEqual(fallback.recentWindowProfiles, { today: 0, week: 0 });
  });

  it('GET /api/providers keeps precision on tiny $/M rates', async () => {
    const env = createMultiKeyEnv([
      { handle: 'tiny', tokensAll: 19e9, breakdown: { models: [{ provider: 'anthropic', model: 'm1', tokensAll: 19e9, tokensToday: 0, costToday: 0, costAll: 300, sharePercent: 100 }], tools: [], history: [] } }
    ]);
    const data = await (await worker.fetch(req('/api/providers?days=30'), env)).json();
    const row = data.providers.find(r => r.provider === 'anthropic');
    assert.ok(row.avgCostPerM > 0, 'rate must not round to zero');
    assert.equal(row.avgCostPerMText, '$0.0158');
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

  it('account profiles returns only claimed profiles owned by the verified Google subject', async () => {
    const clientId = 'test-account-client.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);
    env.LEADERBOARD_BUCKET = mockR2Bucket([
      { handle: 'zeta', claimed: true, ownerId: 'google:alice-sub', googleEmail: 'alice@example.com', claimTokenHash: 'private', tokensAll: 100 },
      { handle: 'alpha', displayName: 'Alpha workspace', claimed: true, ownerId: 'google:alice-sub' },
      { handle: 'unclaimed', claimed: false, ownerId: 'google:alice-sub' },
      { handle: 'other', claimed: true, ownerId: 'google:bob-sub', googleEmail: 'alice@example.com' },
      { handle: 'email-only', claimed: true, googleEmail: 'alice@example.com' }
    ]);
    const token = await makeGoogleToken(keyPair, { clientId, sub: 'alice-sub', email: 'alice@example.com' });
    const response = await worker.fetch(req('/api/account/profiles?handle=other', { headers: { 'X-Google-Token': token } }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), { profiles: [
      { handle: 'alpha', displayName: 'Alpha workspace' },
      { handle: 'zeta', displayName: 'zeta' }
    ] });
    const stranger = await makeGoogleToken(keyPair, { clientId, sub: 'nobody', email: 'nobody@example.com' });
    const empty = await worker.fetch(req('/api/account/profiles', { headers: { Authorization: `Bearer ${stranger}` } }), env);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { profiles: [] });
  });

  it('account profiles strictly reads R2 without seeding, backfill or starter fallback', async () => {
    const clientId = 'test-account-storage.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);
    const token = await makeGoogleToken(keyPair, { clientId, sub: 'alice-sub', email: 'alice@example.com' });
    const read = () => worker.fetch(req('/api/account/profiles', { headers: { 'X-Google-Token': token } }), env);
    let writes = 0;
    const put = async () => { ++writes; };
    for (const bucket of [undefined,
      { get: async () => { throw new Error('private R2 failure'); }, put },
      { get: async () => ({ text: async () => '{invalid' }), put },
      { get: async () => ({ text: async () => '{"profiles":[]}' }), put }]) {
      env.LEADERBOARD_BUCKET = bucket;
      const response = await read();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(await response.json(), { ok: false, error: 'Could not load your profiles. Try again.' });
    }
    env.LEADERBOARD_BUCKET = { get: async () => null, put };
    assert.deepEqual(await (await read()).json(), { profiles: [] }, 'A missing object is genuinely empty, without starter seeding');
    env.LEADERBOARD_BUCKET = { get: async () => ({ text: async () => JSON.stringify([
      { handle: 'alice', claimed: true, ownerId: 'google:alice-sub' }
    ]) }), put };
    const owned = await read();
    assert.equal(owned.status, 200);
    assert.deepEqual(await owned.json(), { profiles: [{ handle: 'alice', displayName: 'alice' }] });
    assert.equal(writes, 0, 'Private discovery never writes analytics backfills or seed data');
  });

  it('account profiles rejects anonymous, expired and legacy production credentials', async () => {
    const clientId = 'test-account-denied.apps.googleusercontent.com';
    const { keyPair, jwk } = await makeGoogleKeyPair();
    const env = createGoogleEnv(clientId, jwk);
    const expired = await makeGoogleToken(keyPair, { clientId, exp: Math.floor(Date.now() / 1000) - 60 });
    for (const headers of [{}, { 'X-Google-Token': expired }, { 'X-Google-Token': 'google:alice@example.com' }, { 'X-Claim-Token': 'claim-token' }]) {
      const response = await worker.fetch(req('/api/account/profiles', { headers }), env);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'auth_required');
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    }
  });

  it('account profiles retains the existing explicit legacy development auth mode', async () => {
    const env = createEnv([
      { handle: 'dev', claimed: true, ownerId: 'google:dev@example.com' },
      { handle: 'other', claimed: true, ownerId: 'google:other@example.com' }
    ]);
    const response = await worker.fetch(req('/api/account/profiles', { headers: { 'X-Google-Token': 'google:dev@example.com' } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { profiles: [{ handle: 'dev', displayName: 'dev' }] });
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

  it('GET /api/models/catalog proxies the exported static catalog with CORS', async () => {
    const catalog = { schemaVersion: 1, count: 2, models: [{ id: 'openai/gpt-5' }], topPicks: [] };
    const seen = [];
    const env = {
      ...createEnv(),
      ASSETS: {
        async fetch(request) {
          seen.push(new URL(request.url).pathname);
          return new Response(JSON.stringify(catalog), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"catalog-v1"' } });
        }
      }
    };
    const res = await worker.fetch(req('/api/models/catalog'), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('ETag'), '"catalog-v1"');
    const data = await res.json();
    assert.equal(data.count, 2);
    assert.equal(seen[0], '/data/models.json');

    const missing = await worker.fetch(req('/api/models/catalog'), createEnv());
    assert.equal(missing.status, 503);
  });

  it('catalog revalidation forwards validators and preserves a bodyless 304', async () => {
    let assetRequest;
    const modified = 'Wed, 30 Sep 2026 00:00:00 GMT';
    const env = {
      ...createEnv(),
      ASSETS: { async fetch(request) {
        assetRequest = request;
        return new Response(null, { status: 304, headers: { ETag: '"catalog-v1"', 'Last-Modified': modified } });
      } }
    };
    const res = await worker.fetch(req('/api/models/catalog', { headers: {
      'If-None-Match': '"catalog-v1"', 'If-Modified-Since': modified,
      Authorization: 'Bearer should-not-forward'
    } }), env);
    assert.equal(assetRequest.headers.get('If-None-Match'), '"catalog-v1"');
    assert.equal(assetRequest.headers.get('If-Modified-Since'), modified);
    assert.equal(assetRequest.headers.get('Authorization'), null);
    assert.equal(res.status, 304);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('ETag'), '"catalog-v1"');
    assert.equal(res.headers.get('Last-Modified'), modified);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Cache-Control'), /max-age=300/);
  });

  it('GET /api/models/usage aggregates per-model adoption across profiles', async () => {
    const entries = [
      {
        handle: 'a', tokensAll: 100, breakdown: { models: [
          { provider: 'claude', model: 'claude-opus-5', tokensAll: 300, costAll: 9, requests: 3, inputTokens: 200, outputTokens: 100 },
          { provider: 'openai', model: 'gpt-5-codex', tokensAll: 100, costAll: 2, requests: 1, inputTokens: 60, outputTokens: 40 }
        ] }
      },
      {
        handle: 'b', tokensAll: 200, breakdown: { models: [
          { provider: 'anthropic', model: 'claude-opus-5', tokensAll: 100, costAll: 3, requests: 2, inputTokens: 80, outputTokens: 20 }
        ] }
      }
    ];
    const env = createEnv(entries);
    const res = await worker.fetch(req('/api/models/usage'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.models[0].model, 'claude-opus-5');
    assert.equal(data.models[0].provider, 'anthropic');
    assert.equal(data.models[0].tokens, 400);
    assert.equal(data.models[0].users, 2);
    assert.equal(data.models[0].sharePercent, 80);
    assert.equal(data.models[0].inputTokens, 280);
    assert.equal(data.models[0].outputTokens, 120);
    assert.ok(data.models[0].tokensFormatted);
  });

  it('serves the landing root while preserving dashboard query deep links', async () => {
    const seen = [];
    const env = {
      ...createEnv(),
      ASSETS: { async fetch(request) { seen.push(new URL(request.url)); return new Response('ok'); } }
    };
    for (const path of ['/', '/?utm_source=github', '/?campaign=launch']) {
      assert.equal((await worker.fetch(req(path), env)).status, 200);
      assert.equal(seen.at(-1).pathname, '/');
    }
    for (const path of ['/leaderboard.html', '/?view=players', '/?signin=1', '/?share=abc', '/?period=week', '/?view=models&model=openai%2Fgpt-5']) {
      assert.equal((await worker.fetch(req(path), env)).status, 200);
      const target = seen.at(-1);
      assert.equal(target.pathname, '/leaderboard');
      assert.equal(target.search, new URL('https://token-horizon.dev' + path).search);
    }
  });

  it('period deep links render HTML for browsers while legacy JSON requests keep working', async () => {
    const seen = [];
    const env = {
      ...createEnv(),
      ASSETS: { async fetch(request) {
        seen.push(new URL(request.url));
        return new Response('<html>leaderboard</html>', { headers: { 'Content-Type': 'text/html', Vary: 'Accept-Encoding' } });
      } }
    };
    for (const query of ['period=week', 'period=all&team=Engineering', 'format=json']) {
      const html = await worker.fetch(req('/leaderboard?' + query, { headers: { Accept: 'text/html,application/xhtml+xml' } }), env);
      assert.equal(html.headers.get('Content-Type'), 'text/html');
      assert.equal(await html.text(), '<html>leaderboard</html>');
      assert.equal(seen.at(-1).search, '?' + query);
      assert.equal(html.headers.get('Vary'), 'Accept-Encoding, Accept');
    }
    for (const accept of ['application/json', '*/*']) {
      const json = await worker.fetch(req('/leaderboard?period=week', { headers: { Accept: accept } }), env);
      assert.match(json.headers.get('Content-Type'), /application\/json/);
      assert.equal((await json.json()).period, 'week');
      assert.equal(json.headers.get('Vary'), 'Accept');
    }
    const api = await worker.fetch(req('/api/leaderboard?period=week', { headers: { Accept: 'text/html' } }), env);
    assert.equal((await api.json()).period, 'week');
  });

  it('serves canonical Teams through the SPA asset binding with Teams metadata and no usage reads', async () => {
    const source = await readFile(new URL('../docs/leaderboard.html', import.meta.url), 'utf8');
    const seen = [];
    const env = {
      ...createEnv(),
      LEADERBOARD_BUCKET: { async get() { throw new Error('Teams documents must not load usage storage'); } },
      ASSETS: { async fetch(request) {
        seen.push(request);
        const target = new URL(request.url);
        if (target.pathname !== '/leaderboard') return new Response('Missing static document', { status: 404 });
        assert.equal(request.method, 'GET', 'HEAD still fetches a complete document for metadata');
        return new Response(source, { headers: { 'Content-Type': 'text/html', ETag: '"static-document"' } });
      } }
    };
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/teams', '/teams?teamChart=history&teamDays=119&utm_source=share']) {
        const response = await worker.fetch(req(path, { method, headers: { Accept: 'text/html' } }), env);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('Content-Type'), /text\/html/);
        assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=300, must-revalidate');
        assert.equal(response.headers.get('ETag'), null, 'Transformed HTML cannot validate against the raw asset');
        const target = new URL(seen.at(-1).url);
        assert.equal(target.pathname, '/leaderboard');
        assert.equal(target.searchParams.get('view'), 'teams');
        if (path.includes('?')) {
          assert.equal(target.searchParams.get('teamChart'), 'history');
          assert.equal(target.searchParams.get('teamDays'), '119');
          assert.equal(target.searchParams.get('utm_source'), 'share');
        }
        const html = await response.text();
        if (method === 'HEAD') { assert.equal(html, ''); continue; }
        assert.match(html, /id="discovery-navigation"/, 'The binding serves the real SPA shell');
        assert.match(html, /<title>AI Usage Teams · Token Horizon<\/title>/);
        assert.match(html, /rel="canonical" href="https:\/\/token-horizon\.dev\/teams"/);
        assert.match(html, /property="og:url" content="https:\/\/token-horizon\.dev\/teams"/);
        assert.match(html, /<base href="\/">/);
        const schema = JSON.parse(html.match(/<script id="th-seo-schema" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.equal(schema['@type'], 'CollectionPage');
        assert.equal(schema.url, 'https://token-horizon.dev/teams');
        assert.equal(schema['@id'], 'https://token-horizon.dev/teams#page');
      }
    }
    const fetches = seen.length;
    for (const path of ['/teams', '/teams/']) {
      const unsupported = await worker.fetch(req(path, { method: 'POST' }), env);
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get('Allow'), 'GET, HEAD');
    }
    assert.equal(seen.length, fetches, 'Unsupported document methods never reach the asset binding');
  });

  it('canonicalizes Teams aliases without dropping analytics, duplicate, empty or encoded query values', async () => {
    const env = createEnv();
    const remaining = 'teamChart=history&teamDays=7&team=R%26D&tag=one&tag=two&empty=&utm_source=share';
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/leaderboard', '/leaderboard.html']) {
        const response = await worker.fetch(req(path + '?view=teams&' + remaining, { method, headers: { Accept: 'text/html' } }), env);
        assert.equal(response.status, 302);
        const canonical = new URL(response.headers.get('Location'));
        assert.equal(canonical.pathname, '/teams');
        assert.equal(canonical.search, '?' + remaining);
        assert.equal(canonical.hash, '', 'The redirect provides no fragment so browsers inherit their original anchor');
        assert.equal(await response.text(), '');
      }
      const slash = await worker.fetch(req('/teams/?' + remaining, { method }), env);
      assert.equal(slash.status, 301);
      assert.equal(slash.headers.get('Location'), 'https://token-horizon.dev/teams?' + remaining);
    }
    const legacyJson = await worker.fetch(req('/leaderboard?view=teams&period=week', { headers: { Accept: 'application/json' } }), env);
    assert.equal(legacyJson.status, 200, 'Legacy JSON clients retain their API route');
    assert.equal((await legacyJson.json()).period, 'week');
    const api = await worker.fetch(req('/api/teams'), env);
    assert.equal(api.status, 200);
    assert.ok(Array.isArray((await api.json()).teams));
  });

  it('preserves privacy metadata on canonical Teams account and sharing query links', async () => {
    const env = {
      ...createEnv(),
      ASSETS: { async fetch() { return new Response('<html><head><title>Static title</title></head><body>SPA</body></html>', { headers: { 'Content-Type': 'text/html' } }); } }
    };
    for (const path of ['/teams?view=billing', '/teams?share=private-report', '/teams?invite=private-invite']) {
      const response = await worker.fetch(req(path), env), html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
      assert.doesNotMatch(html, /private-report|private-invite|id="th-seo-schema"/);
    }
  });

  it('keeps the static Teams alias relative and replaces history while preserving query values and fragments', async () => {
    const html = await readFile(new URL('../docs/teams/index.html', import.meta.url), 'utf8');
    assert.match(html, /rel="canonical" href="https:\/\/token-horizon\.dev\/teams"/);
    assert.match(html, /href="\.\.\/leaderboard\.html\?view=teams"/, 'A relative fallback link works without JavaScript');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    for (const [base, expectedPath] of [
      ['https://token-horizon.dev/teams/', '/leaderboard.html'],
      ['https://castlemilk.github.io/token-horizon/teams/', '/token-horizon/leaderboard.html'],
      ['https://castlemilk.github.io/token-horizon/teams/index.html', '/token-horizon/leaderboard.html'],
      ['file:///checkout/docs/teams/index.html', '/checkout/docs/leaderboard.html']
    ]) {
      const original = new URL(base + '?teamChart=history&teamDays=30&view=other&tag=one&tag=two&empty=#tm-rankings-title');
      const replaced = [];
      runInNewContext(script, { URL, location: {
        href: original.href, search: original.search, hash: original.hash,
        replace(value) { replaced.push(value); }
      } });
      assert.equal(replaced.length, 1, 'Alias uses one history replacement');
      const target = new URL(replaced[0]);
      assert.equal(target.origin, original.origin);
      assert.equal(target.pathname, expectedPath);
      assert.equal(target.hash, '#tm-rankings-title');
      assert.deepEqual([...target.searchParams], [
        ['teamChart', 'history'], ['teamDays', '30'], ['view', 'teams'], ['tag', 'one'], ['tag', 'two'], ['empty', '']
      ]);
    }
  });

  it('GET /models rewrites to the dashboard models view', async () => {
    let target = null;
    const env = {
      ...createEnv(),
      ASSETS: { async fetch(request) { target = new URL(request.url); return new Response('ok'); } }
    };
    const res = await worker.fetch(req('/models'), env);
    assert.equal(res.status, 200);
    assert.equal(target.pathname, '/leaderboard');
    assert.equal(target.searchParams.get('view'), 'models');
  });

  it('GET /leaderboard?view=models redirects to the canonical /models route', async () => {
    const env = createEnv();
    const res = await worker.fetch(req('/leaderboard?view=models&flat=1&model=openai%2Fgpt-5'), env);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.pathname, '/models');
    assert.equal(loc.searchParams.get('model'), 'openai/gpt-5');
    assert.equal(loc.searchParams.get('view'), null);
    assert.equal(loc.searchParams.get('flat'), null);
    // Plain leaderboard deep links are untouched.
    const plain = await worker.fetch(req('/leaderboard?period=today'), env);
    assert.notEqual(plain.status, 302);
    // The Providers analytics and Plans tabs only exist in the dashboard shell.
    const providers = await worker.fetch(req('/leaderboard?view=models&tab=providers'), env);
    assert.notEqual(providers.status, 302);
    const plans = await worker.fetch(req('/leaderboard?view=models&tab=plans'), env);
    assert.notEqual(plans.status, 302);
    const cheapest = await worker.fetch(req('/leaderboard?view=models&tab=cheapest'), env);
    assert.notEqual(cheapest.status, 302);
    // Trailing slash canonicalizes so relative asset paths keep working.
    const slash = await worker.fetch(req('/models/?provider=deepseek'), env);
    assert.equal(slash.status, 301);
    const slashLoc = new URL(slash.headers.get('location'));
    assert.equal(slashLoc.pathname, '/models');
    assert.equal(slashLoc.searchParams.get('provider'), 'deepseek');
  });

  it('GET /api/og/profile/<handle>.svg renders the quick-view usage card', async () => {
    const res = await worker.fetch(req('/api/og/profile/benebsworth.svg'), createEnv());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg/);
    const svg = await res.text();
    assert.match(svg, /@benebsworth/);
    assert.match(svg, /Token Horizon/);
    assert.match(svg, /GRANDMASTER I/);
    assert.match(svg, /ALL-TIME TOKENS/);
    assert.match(svg, /data-usage-chart="daily-tokens"/);
    assert.match(svg, /Activity heatmap/);
    assert.match(svg, /17 WEEKS \/ UTC/);
    assert.equal((svg.match(/data-heatmap-day=/g) || []).length, 119);
    assert.match(svg, /Anthropic/);
  });

  it('GET /api/og/profile 404s for unknown handles', async () => {
    const res = await worker.fetch(req('/api/og/profile/definitely_nobody.svg'), createEnv());
    assert.equal(res.status, 404);
    const png = await worker.fetch(req('/api/og/profile/definitely_nobody.png'), createEnv());
    assert.equal(png.status, 404);
  });

  it('embeds a saved profile photo without fetching it on metadata, HEAD or warm edge images', async () => {
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGN4G+r3Hx9mGBkKAG8Uo8FWIl3AAAAAAElFTkSuQmCC', 'base64');
    const uri = 'data:image/png;base64,' + photo.toString('base64');
    const entry = { handle: 'photo_owner', avatarUrl: '/api/avatar/photo_owner?v=first', tokensAll: 2000000, tokensToday: 1000, streakDays: 7, updatedAt: 1790812800 };
    const env = createMultiKeyEnv([entry]);
    env.ASSETS = { async fetch() { return new Response('<html><head><title>Token Horizon</title></head></html>', { headers: { 'Content-Type': 'text/html' } }); } };
    await env.LEADERBOARD_BUCKET.put('avatars/photo_owner', photo, { httpMetadata: { contentType: 'image/png' } });
    const get = env.LEADERBOARD_BUCKET.get.bind(env.LEADERBOARD_BUCKET);
    let photoReads = 0;
    env.LEADERBOARD_BUCKET.get = async key => { if (key.startsWith('avatars/')) photoReads++; return get(key); };
    const previous = globalThis.caches;
    const cache = new Map();
    globalThis.caches = { default: {
      async match(request) { return cache.get(request.url)?.clone(); },
      async put(request, response) { cache.set(request.url, response.clone()); }
    } };
    try {
      const metadata = await (await worker.fetch(req('/u/photo_owner?format=json'), env)).json();
      assert.equal(metadata.card.avatarUrl, entry.avatarUrl);
      const head = await worker.fetch(req('/api/og/profile/photo_owner.png', { method: 'HEAD' }), env);
      assert.equal(head.status, 200);
      assert.equal(photoReads, 0, 'Metadata and HEAD do not wait for an optional photo');
      const first = await worker.fetch(req('/api/og/profile/photo_owner.svg'), env);
      const svg = await first.text();
      assert.match(svg, /data-profile-avatar="photo"/);
      assert.ok(svg.includes(uri), 'The saved image bytes reach the card');
      assert.doesNotMatch(svg, /\/api\/avatar\/photo_owner|ownerId|googleEmail|claimTokenHash/);
      assert.equal(photoReads, 1);
      const again = await worker.fetch(req('/api/og/profile/photo_owner.svg?v=old'), env);
      assert.equal(await again.text(), svg);
      assert.equal(photoReads, 1, 'Warm cards avoid photo I/O');
      const revalidated = await worker.fetch(req('/api/og/profile/photo_owner.svg', { headers: { 'If-None-Match': first.headers.get('etag') } }), env);
      assert.equal(revalidated.status, 304);
      assert.equal(photoReads, 1);
      await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify([{ ...entry, avatarUrl: '/api/avatar/photo_owner?v=second' }]));
      const changedMetadata = await (await worker.fetch(req('/u/photo_owner?format=json'), env)).json();
      assert.notEqual(changedMetadata.image, metadata.image, 'Changing the photo version invalidates the card immediately');
      const changed = await worker.fetch(req('/api/og/profile/photo_owner.svg'), env);
      assert.notEqual(changed.headers.get('etag'), first.headers.get('etag'));
      assert.match(await changed.text(), /data-profile-avatar="photo"/);
      assert.equal(photoReads, 2, 'A new photo version resolves new bytes');
    } finally {
      if (previous === undefined) delete globalThis.caches;
      else globalThis.caches = previous;
    }
  });

  it('anonymous and restricted shares neither fetch nor expose a published profile photo', async () => {
    const env = createMultiKeyEnv();
    const publish = await worker.fetch(req('/api/leaderboard', { method: 'POST', body: {
      handle: 'private_photo', avatarUrl: '/api/avatar/private_photo?v=secret-photo', tokensAll: 1000
    } }), env);
    const claimToken = (await publish.json()).claimToken;
    const get = env.LEADERBOARD_BUCKET.get.bind(env.LEADERBOARD_BUCKET);
    let reads = 0;
    env.LEADERBOARD_BUCKET.get = async key => { if (key.startsWith('avatars/')) reads++; return get(key); };
    for (const publicLink of [true, false]) {
      const response = await worker.fetch(req('/api/share/create', { method: 'POST', body: {
        handle: 'private_photo', claimToken, publicLink, options: { anonymizeNames: true }
      } }), env);
      const id = (await response.json()).share.id;
      const image = await worker.fetch(req(`/api/og/share/${id}.svg`), env);
      assert.equal(image.status, 200);
      assert.doesNotMatch(await image.text(), /data-profile-avatar=|private_photo|secret-photo/);
      const metadata = await worker.fetch(req(`/s/${id}?format=json`), env);
      assert.doesNotMatch(await metadata.text(), /private_photo|secret-photo/);
    }
    assert.equal(reads, 0, 'Private photos never load for anonymous or restricted reports');
  });

  it('refreshes external photo validators every five minutes without loading photos for metadata', async () => {
    const env = createMultiKeyEnv([{ handle: 'external_photo', avatarUrl: 'https://lh3.googleusercontent.com/public-photo', tokensAll: 2000000, updatedAt: 1790812800 }]);
    env.ASSETS = { async fetch() { return new Response('<html><head></head></html>', { headers: { 'Content-Type': 'text/html' } }); } };
    const originalNow = Date.now;
    const version = async () => (await (await worker.fetch(req('/u/external_photo?format=json'), env)).json()).image;
    try {
      Date.now = () => 1800000000000;
      const first = await version();
      Date.now = () => 1800000299999;
      assert.equal(await version(), first, 'Unchanged source photos reuse the same card within the cache window');
      Date.now = () => 1800000300000;
      assert.notEqual(await version(), first, 'A same-URL external photo cannot validate an old image indefinitely');
    } finally { Date.now = originalNow; }
  });

  it('an unavailable photo keeps a useful card and cannot poison the image cache', async () => {
    const env = createMultiKeyEnv([{ handle: 'missing_photo', avatarUrl: '/api/avatar/missing_photo?v=none', tokensAll: 2000000, updatedAt: 1790812800 }]);
    const previous = globalThis.caches;
    let writes = 0;
    globalThis.caches = { default: { async match() {}, async put() { writes++; } } };
    try {
      const response = await worker.fetch(req('/api/og/profile/missing_photo.svg'), env);
      assert.equal(response.status, 200);
      const svg = await response.text();
      assert.match(svg, /@missing_photo/);
      assert.match(svg, /ALL-TIME TOKENS/);
      assert.doesNotMatch(svg, /data-profile-avatar=/);
      assert.match(response.headers.get('cache-control'), /max-age=15/);
      assert.equal(response.headers.get('etag'), null, 'Failed-photo fallback is reloaded rather than validating forever');
      assert.equal(writes, 0, 'Failed optional photos are excluded from the edge cache');
    } finally {
      if (previous === undefined) delete globalThis.caches;
      else globalThis.caches = previous;
    }
  });

  it('GET /u/<handle> injects profile OG meta + canonical + base into the SPA', async () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Token Horizon</title><meta name="description" content="orig"></head><body>spa</body></html>';
    const env = {
      ...createEnv(),
      ASSETS: { async fetch() { return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }); } }
    };
    const res = await worker.fetch(req('/u/benebsworth'), env);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<base href="\/">/);
    assert.match(body, /<title>@benebsworth · Grandmaster I · #1 today · Token Horizon<\/title>/);
    assert.match(body, /property="og:image" content="https:\/\/token-horizon\.dev\/api\/og\/profile\/benebsworth\.png\?v=horizon-\d+-[a-f0-9]+"/);
    assert.match(body, /property="og:image:type" content="image\/png"/);
    assert.match(body, /property="og:image:alt" content="[^"]*activity heatmap/);
    assert.match(body, /name="twitter:image:width" content="1200"/);
    assert.equal(res.headers.get('vary'), 'Accept, User-Agent');
    assert.match(body, /property="og:url" content="https:\/\/token-horizon\.dev\/u\/benebsworth"/);
    assert.match(body, /name="twitter:card" content="summary_large_image"/);
    assert.match(body, /rel="canonical" href="https:\/\/token-horizon\.dev\/u\/benebsworth"/);
    // Unknown handles fall through to the plain SPA (its own not-found state).
    const missing = await worker.fetch(req('/u/definitely_nobody'), env);
    assert.equal(missing.status, 200);
    const missingBody = await missing.text();
    assert.doesNotMatch(missingBody, /og:image/);
    assert.match(missingBody, /<base href="\/">/);
  });

  it('GET /api/og/share/<id>.svg honors anonymize + hideCost share options', async () => {
    const env = createMultiKeyEnv();
    const pub = await worker.fetch(req('/api/leaderboard', {
      method: 'POST',
      body: { handle: 'og_dev', tokensAll: 3000000, tokensToday: 100000, costAll: 42, topModel: 'claude-opus-5' }
    }), env);
    const claimToken = (await pub.json()).claimToken;
    const created = await worker.fetch(req('/api/share/create', {
      method: 'POST',
      body: { handle: 'og_dev', claimToken, options: { anonymizeNames: true, hideCost: true }, publicLink: true }
    }), env);
    assert.equal(created.status, 200);
    const id = (await created.json()).share.id;

    const res = await worker.fetch(req(`/api/og/share/${id}.svg`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('X-Robots-Tag'), /noindex/, 'Share previews can unfurl without being indexed as public images');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    const svg = await res.text();
    assert.match(svg, /Anonymous/);
    assert.doesNotMatch(svg, /og_dev/);
    assert.doesNotMatch(svg, /\$42/);

    // Revoked shares stop unfurling.
    await worker.fetch(req('/api/share/revoke', {
      method: 'POST', body: { handle: 'og_dev', id, claimToken }
    }), env);
    assert.equal((await worker.fetch(req(`/api/og/share/${id}.svg`), env)).status, 404);
  });

  it('GET /u/<handle> serves ANSI text to curl, clean text to AI agents, JSON on request', async () => {
    const env = {
      ...createEnv(),
      ASSETS: { async fetch() { return new Response('<html><head><title>spa</title></head></html>', { headers: { 'Content-Type': 'text/html' } }); } }
    };
    const get = (headers) => worker.fetch(new Request('https://token-horizon.dev/u/benebsworth', { headers }), env);

    const curl = await get({ 'User-Agent': 'curl/8.7.1', Accept: '*/*' });
    assert.match(curl.headers.get('content-type'), /text\/plain/);
    const txt = await curl.text();
    assert.match(txt, /\x1b\[96m/);          // ANSI color welcome in terminals
    assert.match(txt, /@benebsworth/);
    assert.match(txt, /TOKEN HORIZON/);
    assert.match(txt, /PROVIDER MIX/);

    const gpt = await get({ 'User-Agent': 'GPTBot/1.2 (+https://openai.com/gptbot)' });
    const gptTxt = await gpt.text();
    assert.match(gptTxt, /@benebsworth/);
    assert.doesNotMatch(gptTxt, /\x1b\[/);   // no escape junk in LLM context

    const json = await get({ Accept: 'application/json', 'User-Agent': 'some-agent' });
    const data = await json.json();
    assert.equal(data.ok, true);
    assert.equal(data.card.handle, 'benebsworth');
    assert.match(data.image, /api\/og\/profile\/benebsworth\.png/);

    // Social unfurlers still get HTML + og:image — they never render text.
    for (const ua of ['Twitterbot/1.0', 'Discordbot/2.0', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'LinkedInBot/1.0', 'WhatsApp/2.24', 'TelegramBot (like TwitterBot)', 'Mastodon/4.0']) {
      const res = await get({ 'User-Agent': ua });
      assert.match(res.headers.get('content-type'), /text\/html/, ua);
      assert.match(await res.text(), /og:image/, ua);
    }
  });

  it('keeps restricted shares generic on every unfurl format, including owner requests', async () => {
    const { owner, stranger, call, create } = await ogShareFixture();
    const share = await create({ audience: ['private-audience@example.com'], groups: ['SecretGroupABC'] });
    const forbidden = /private_owner|HiddenTeamXYZ|M999Secret|712345|123456|654321|Anthropic|SecretModelABC|SecretPromptABC|private-audience|SecretGroupABC|ownerKey|data-heatmap-day/i;
    for (const token of ['', owner, stranger]) {
      for (const path of [`/api/og/share/${share.id}.svg`, `/s/${share.id}`, `/s/${share.id}?format=json`, `/s/${share.id}?format=text`]) {
        const response = await call(path, token);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('cache-control'), /private, no-store/, path);
        assert.doesNotMatch(await response.text(), forbidden, path);
      }
    }
    const anonymous = await call(`/api/shared/${share.id}`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, 'auth_required');
    const wrongAccount = await call(`/api/shared/${share.id}`, stranger);
    assert.equal(wrongAccount.status, 403);
    assert.doesNotMatch(await wrongAccount.text(), forbidden);
    const allowed = await call(`/api/shared/${share.id}`, owner);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('cache-control'), /private, no-store/);
    const data = await allowed.json();
    assert.equal(data.report.tokensAll, 712345);
    for (const field of ['ownerKey', 'audience', 'groups']) assert.equal(data.share[field], undefined);
    assert.doesNotMatch(JSON.stringify(data), /SecretPromptABC/);
  });

  it('authorizes exact claimed handles and saved owner groups; email and team labels cannot grant access', async () => {
    const { call, create, owner, friend, stranger, token } = await ogShareFixture();
    const people = await create({ scope: 'people', audience: ['@friend_dev'] });
    assert.equal((await call(`/api/shared/${people.id}`, friend)).status, 200);
    assert.equal((await call(`/api/shared/${people.id}`, stranger)).status, 403);
    assert.equal((await call(`/api/shared/${people.id}`, await token('og-stranger', { email: 'owner@example.com' }))).status, 403, 'an email-only owner match cannot read a private report');
    const arbitrary = await create({ scope: 'people', audience: ['friend@example.com', 'HiddenTeamXYZ', 'pretended_handle'] });
    assert.equal((await call(`/api/shared/${arbitrary.id}`, friend)).status, 403);
    const groupResponse = await call('/api/groups', owner, { method: 'POST', body: { handle: 'private_owner', group: { name: 'Exact saved group', members: ['friend_dev'] } } });
    const group = (await groupResponse.json()).groups[0];
    const groupShare = await create({ scope: 'group', groups: [group.id] });
    assert.equal((await call(`/api/shared/${groupShare.id}`, friend)).status, 200);
    assert.equal((await call(`/api/shared/${groupShare.id}`, stranger)).status, 403);
    const wrongGroup = await create({ scope: 'group', groups: ['not-a-saved-group'] });
    assert.equal((await call(`/api/shared/${wrongGroup.id}`, friend)).status, 403);
    const orgShare = await create({ scope: 'org' });
    assert.equal((await call(`/api/shared/${orgShare.id}`, friend)).status, 403, 'matching published labels do not prove membership');

    const teamResponse = await call('/api/team/invites', owner, { method: 'POST', body: { name: 'VerifiedCrew' } });
    const team = await teamResponse.json();
    const join = await call('/api/team/join', friend, { method: 'POST', body: { token: team.invites[0].token } });
    assert.equal(join.status, 200);
    assert.equal((await call(`/api/shared/${orgShare.id}`, friend)).status, 200);
    assert.equal((await call(`/api/shared/${orgShare.id}`, stranger)).status, 403);
    const profileless = await token('new-profileless-friend');
    assert.equal((await call('/api/team/join', profileless, { method: 'POST', body: { token: team.invites[0].token } })).status, 200);
    assert.equal((await call(`/api/shared/${orgShare.id}`, profileless)).status, 200, 'verified team members can read before publishing a profile');
  });

  it('lets only the matching claim-token owner read an unclaimed private report', async () => {
    const env = createMultiKeyEnv([]);
    const published = await worker.fetch(req('/api/leaderboard', { method: 'POST', body: { handle: 'unclaimed_og', tokensAll: 123456 } }), env);
    const claimToken = (await published.json()).claimToken;
    const created = await worker.fetch(req('/api/share/create', { method: 'POST', body: { handle: 'unclaimed_og', claimToken, scope: 'private' } }), env);
    const id = (await created.json()).share.id;
    for (const value of ['', 'not-the-token']) {
      const response = await worker.fetch(req(`/api/shared/${id}`, { headers: { 'X-Claim-Token': value } }), env);
      assert.equal(response.status, 401);
      assert.match(response.headers.get('cache-control'), /private, no-store/);
    }
    const allowed = await worker.fetch(req(`/api/shared/${id}`, { headers: { 'X-Claim-Token': claimToken } }), env);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).report.handle, 'unclaimed_og');
  });

  it('public-link capability overrides scope and respects rounded counts, hidden rank/providers/cost/identity everywhere', async () => {
    const { call, create } = await ogShareFixture();
    const share = await create({ publicLink: true, options: { fullTokenCounts: false, providerBreakdown: false, includeLeagueRank: false, anonymizeNames: true, hideCost: true } });
    const response = await call(`/api/shared/${share.id}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.report.tokensAll, 712000);
    assert.equal(data.report.handle, 'Anonymous');
    assert.equal(data.report.daily[0].tokens, 14000);
    for (const key of ['rank', 'percentile', 'league', 'leagueTitle', 'division', 'mmr', 'models', 'costAll', 'hardware']) assert.equal(data.report[key], undefined, key);
    for (const key of ['handle', 'ownerKey', 'audience', 'groups']) assert.equal(data.share[key], undefined, key);
    const svg = await (await call(`/api/og/share/${share.id}.svg`)).text();
    assert.match(svg, /Anonymous/);
    assert.match(svg, /data-heatmap-day=/);
    assert.doesNotMatch(svg, /private_owner|HiddenTeamXYZ|M999Secret|Anthropic|712345|123456|987|OVERALL|GOLD|MMR|42\.19/);
    const json = await (await call(`/s/${share.id}?format=json`)).json();
    assert.equal(json.card.tokensAll, 712000);
    for (const key of ['rank', 'rankToday', 'league', 'mmr', 'percentile']) assert.equal(json.card[key], undefined, key);
    const text = await (await call(`/s/${share.id}?format=text`)).text();
    assert.doesNotMatch(text, /rank|MMR|#undefined|undefined|NaN|private_owner|Anthropic|42\.19/i);
    const html = await (await call(`/s/${share.id}`)).text();
    assert.match(html, /\/api\/og\/share\/[a-zA-Z0-9]+\.png\?v=horizon-/);
    assert.doesNotMatch(html, /private_owner|HiddenTeamXYZ|M999Secret|undefined|gold league/i);
  });

  it('makes expired and revoked share images/report pages uncached and removes all prior metadata', async () => {
    const { env, owner, call, create } = await ogShareFixture();
    for (const expired of [false, true]) {
      const share = await create({ scope: 'public' });
      if (expired) {
        share.expiresAt = Math.floor(Date.now() / 1000) - 10;
        await env.LEADERBOARD_BUCKET.put(`shares/${share.id}.json`, JSON.stringify(share));
      } else await call('/api/share/revoke', owner, { method: 'POST', body: { handle: 'private_owner', id: share.id } });
      for (const method of ['GET', 'HEAD']) {
        const image = await call(`/api/og/share/${share.id}.svg`, '', { method });
        assert.equal(image.status, 404);
        assert.match(image.headers.get('cache-control'), /no-store/);
        assert.doesNotMatch(await image.text(), /private_owner|712345|data-heatmap-day/);
      }
      const report = await call(`/api/shared/${share.id}`);
      assert.equal(report.status, 410);
      assert.match(report.headers.get('cache-control'), /no-store/);
      const page = await call(`/s/${share.id}`);
      assert.match(page.headers.get('cache-control'), /no-store/);
      assert.doesNotMatch(await page.text(), /og:image|private_owner|712345/);
    }
  });

  it('supports HEAD parity without rasterization and cache validators for current profile images', async () => {
    const { call, create } = await ogShareFixture();
    const share = await create({ scope: 'public' });
    for (const path of ['/api/og/profile/private_owner.svg', '/u/private_owner', '/u/private_owner?format=json', '/u/private_owner?format=text', `/api/og/share/${share.id}.svg`, `/s/${share.id}`]) {
      const get = await call(path);
      const head = await call(path, '', { method: 'HEAD' });
      assert.equal(head.status, get.status, path);
      for (const key of ['content-type', 'cache-control', 'etag', 'vary']) assert.equal(head.headers.get(key), get.headers.get(key), `${path}: ${key}`);
      assert.equal(await head.text(), '');
    }
    const png = await call('/api/og/profile/private_owner.png', '', { method: 'HEAD' });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.match(png.headers.get('cache-control'), /s-maxage=300/);
    const svg = await call('/api/og/profile/private_owner.svg');
    const revalidated = await call('/api/og/profile/private_owner.svg', '', { headers: { 'If-None-Match': svg.headers.get('etag') } });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), '');
    const privatePng = await call(`/api/og/share/${share.id}.png`, '', { method: 'HEAD' });
    assert.equal(privatePng.status, 200);
    assert.match(privatePng.headers.get('cache-control'), /private, no-store/);
  });

  it('changes profile image fingerprints on same-hour data or publication changes while keeping unchanged cards stable', async () => {
    const { env, ownerEntry, call } = await ogShareFixture();
    const version = async () => (await (await call('/u/private_owner?format=json')).json()).image;
    const first = await version();
    assert.equal(await version(), first);
    const entries = await (await env.LEADERBOARD_BUCKET.get('leaderboard.json')).json();
    entries[0].tokensToday += 1; // Compact visual number may not visibly change.
    await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify(entries));
    const second = await version();
    assert.notEqual(second, first);
    entries[0].updatedAt = ownerEntry.updatedAt + 1;
    await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify(entries));
    assert.notEqual(await version(), second);
  });

  it('reuses public edge images by current content fingerprint while never caching share capabilities', async () => {
    const previous = globalThis.caches;
    const cache = new Map(), storedKeys = [];
    globalThis.caches = { default: {
      async match(request) { return cache.get(request.url)?.clone(); },
      async put(request, response) { storedKeys.push(request.url); cache.set(request.url, response.clone()); }
    } };
    try {
      const { env, call, create } = await ogShareFixture();
      const first = await call('/api/og/profile/private_owner.svg');
      assert.equal(first.status, 200);
      await call('/api/og/profile/private_owner.svg?v=old-version');
      assert.equal(storedKeys.length, 1);
      const entries = await (await env.LEADERBOARD_BUCKET.get('leaderboard.json')).json();
      entries[0].tokensAll += 100;
      await env.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify(entries));
      await call('/api/og/profile/private_owner.svg?v=old-version');
      assert.equal(storedKeys.length, 2);
      assert.notEqual(storedKeys[0], storedKeys[1]);
      for (const publicLink of [false, true]) {
        const share = await create({ publicLink });
        await call(`/api/og/share/${share.id}.svg`);
        assert.equal(storedKeys.length, 2, 'private and public share URLs both remain outside edge cache');
      }
      globalThis.caches.default.match = async () => { throw new Error('cache unavailable'); };
      assert.equal((await call('/api/og/profile/private_owner.svg')).status, 200);
    } finally {
      if (previous === undefined) delete globalThis.caches;
      else globalThis.caches = previous;
    }
  });

});

const teamPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCbkAAAAASUVORK5CYII=';

describe('Team identity, logo and public share cards', () => {
  it('counts joined accounts separately from published profiles and never exposes private roster identities', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('brand-owner'), friend = await token('brand-friend'), unpublished = await token('brand-unpublished');
    const created = (await call('/api/team/invites', owner, { name: 'Aster Crew' })).data;
    const id = created.team.id, invite = created.invites[0].token;
    await call('/api/team/join', friend, { token: invite });
    await call('/api/team/join', unpublished, { token: invite });
    const beforePublish = await call(`/api/team/${id}`);
    assert.deepEqual(beforePublish.data.stats.recentWindowProfiles, { today: 0, week: 0 });
    await call('/api/leaderboard', owner, { handle: 'aster-work', tokensAll: 400, tokensToday: 20, tokens7d: 180 });
    await call('/api/leaderboard', owner, { handle: 'aster-home', tokensAll: 100, tokensToday: 5, tokens7d: 40 });
    await call('/api/leaderboard', friend, { handle: 'aster-friend', tokensAll: 300, tokensToday: 10, tokens7d: 80 });
    await call('/api/leaderboard', undefined, { handle: 'aster-imposter', team: 'Aster Crew', teamId: id, tokensAll: 9999, tokensToday: 9999, tokens7d: 9999 });
    const details = await call(`/api/team/${id}`);
    assert.equal(details.status, 200);
    assert.equal(details.data.team.memberCount, 3);
    assert.equal(details.data.stats.publishedProfiles, 3);
    assert.equal(details.data.stats.tokens, 800);
    assert.equal(details.data.stats.tokensToday, 35);
    assert.equal(details.data.stats.tokens7d, 300);
    assert.deepEqual(details.data.stats.recentWindowProfiles, { today: 3, week: 3 });
    assert.equal(details.data.stats.members, 3);
    assert.equal(details.data.team.url, `https://token-horizon.dev/t/${id}`);
    assert.equal(details.data.team.ogImage, `https://token-horizon.dev/api/og/team/${id}.png`);
    const publicJson = JSON.stringify(details.data);
    assert.doesNotMatch(publicJson, /brand-owner|brand-friend|brand-unpublished|@example\.com|ownerId|claimToken|invites|joinedAt|accounts\//);
    assert.doesNotMatch(publicJson, new RegExp(invite));
    const canonical = (await call('/api/providers')).data.teams.find(row => row.teamId === id);
    assert.equal(canonical.memberCount, 3);
    assert.equal(canonical.publishedProfiles, 3);
    assert.equal(canonical.tokensToday, 35);
    assert.equal(canonical.tokens7d, 300);
    assert.deepEqual(canonical.recentWindowProfiles, { today: 3, week: 3 });
    const firstCount = canonical.memberCount;
    const fourth = await token('brand-fourth');
    await call('/api/team/join', fourth, { token: invite });
    const next = (await call('/api/teams')).data.teams.find(row => row.teamId === id);
    assert.equal(next.memberCount, firstCount + 1);
    assert.equal(next.members, 3);
    assert.equal(next.publishedProfiles, 3);
    assert.equal(next.tokens, 800);
    assert.equal(next.tokensToday, 35);
    assert.equal(next.tokens7d, 300);
    assert.deepEqual(next.recentWindowProfiles, { today: 3, week: 3 });
    assert.equal((await call(`/api/team/${'f'.repeat(32)}`)).status, 404);
  });

  it('allows only verified team owners to upload validated, bounded raster artwork or clear it', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('icon-owner'), member = await token('icon-member'), stranger = await token('icon-stranger');
    const created = (await call('/api/team/invites', owner, { name: 'Icon Crew' })).data;
    const id = created.team.id;
    await call('/api/team/join', member, { token: created.invites[0].token });
    for (const auth of ['', member, stranger]) {
      const denied = await call('/api/team/logo', auth, { image: teamPng, teamId: id });
      assert.equal(denied.status, auth ? 403 : 401);
    }
    for (const image of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/webp;base64,UklGRg==', 'data:image/png;base64,aGVsbG8=', teamPng.replace('image/png', 'image/jpeg'), 'https://example.com/icon.png']) {
      const invalid = await call('/api/team/logo', owner, { image, teamId: id });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.code, 'invalid_logo');
    }
    assert.equal((await call('/api/team/logo', owner, { image: `data:image/png;base64,${'A'.repeat(540000)}`, teamId: id })).status, 413);
    const uploaded = await call('/api/team/logo', owner, { image: teamPng, teamId: id });
    assert.equal(uploaded.status, 200);
    assert.match(uploaded.data.team.logoUrl, new RegExp(`^/api/team/${id}/logo\\?v=[a-f0-9]{32}$`));
    assert.ok(uploaded.data.team.logoUpdatedAt > 0);
    assert.equal(uploaded.response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await loadTeamLogoDataUri(uploaded.data.team, env), teamPng);
    assert.equal(await loadTeamLogoDataUri({ ...uploaded.data.team, id: 'e'.repeat(32) }, env), '');
    const raw = await worker.fetch(req(uploaded.data.team.logoUrl), env);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('Content-Type'), 'image/png');
    assert.equal(raw.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from(teamPng.split(',')[1], 'base64'));
    const head = await worker.fetch(req(uploaded.data.team.logoUrl, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const unchanged = await worker.fetch(req(uploaded.data.team.logoUrl, { headers: { 'If-None-Match': raw.headers.get('ETag') } }), env);
    assert.equal(unchanged.status, 304);
    const publicInvite = (await call(`/api/team/invites/${created.invites[0].token}`)).data;
    assert.equal(publicInvite.team.logoUrl, uploaded.data.team.logoUrl);
    const replaced = await call('/api/team/logo', owner, { image: teamPng, teamId: id });
    assert.notEqual(replaced.data.team.logoUrl, uploaded.data.team.logoUrl);
    assert.equal((await worker.fetch(req(uploaded.data.team.logoUrl), env)).status, 404);
    assert.equal((await call('/api/team/logo', member, { clear: true, teamId: id })).status, 403);
    const cleared = await call('/api/team/logo', owner, { clear: true, teamId: id });
    assert.equal(cleared.data.team.logoUrl, '');
    assert.equal(cleared.data.team.logoUpdatedAt, 0);
    assert.equal((await worker.fetch(req(replaced.data.team.logoUrl), env)).status, 404);
  });

  it('renders named member-count previews for teams and private invites without leaking join tokens', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('preview-owner'), friend = await token('preview-friend');
    const created = (await call('/api/team/invites', owner, { name: 'Orbit <script> Crew' })).data;
    const id = created.team.id, invite = created.invites[0].token;
    await call('/api/team/join', friend, { token: invite });
    await call('/api/leaderboard', owner, { handle: 'preview-captain', tokensAll: 1234 });
    await call('/api/team/logo', owner, { image: teamPng, teamId: id });
    let credentialForwarded = false;
    env.ASSETS = { async fetch(request) {
      credentialForwarded ||= request.headers.has('Cookie') || request.headers.has('X-Google-Token');
      return new Response('<html><head><title>Old title</title><meta property="og:image" content="old.png"></head><body>shell</body></html>', { headers: { 'Content-Type': 'text/html' } });
    } };
    const teamPage = await worker.fetch(req(`/t/${id}`, { headers: { 'Cookie': 'private-session=secret', 'X-Google-Token': owner } }), env);
    const html = await teamPage.text();
    assert.equal(teamPage.status, 200);
    assert.match(html, /Orbit &lt;script&gt; Crew · 2 members/);
    assert.match(html, new RegExp(`/api/og/team/${id}\\.png\\?v=team-horizon-1-`));
    assert.match(html, new RegExp(`rel="canonical" href="https://token-horizon.dev/t/${id}"`));
    assert.match(html, /<base href="\/">/);
    assert.doesNotMatch(html, /old\.png|private-session|preview-owner|ownerId/);
    assert.equal(credentialForwarded, false);
    const invitePage = await worker.fetch(req(`/invite/${invite}`), env);
    const inviteHtml = await invitePage.text();
    assert.equal(invitePage.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(invitePage.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
    assert.match(inviteHtml, /Join Orbit &lt;script&gt; Crew/);
    assert.match(inviteHtml, /Join 2 members/);
    assert.doesNotMatch(inviteHtml, new RegExp(invite));
    assert.match(inviteHtml, new RegExp(`rel="canonical" href="https://token-horizon.dev/t/${id}"`));
    const joinAlias = await worker.fetch(req(`/join/${invite}`), env);
    assert.equal(joinAlias.status, 302);
    assert.equal(new URL(joinAlias.headers.get('Location')).pathname, `/invite/${invite}`);
    assert.equal(joinAlias.headers.get('Cache-Control'), 'private, no-store');
    const svgResponse = await worker.fetch(req(`/api/og/team/${id}.svg`), env);
    const svg = await svgResponse.text();
    assert.equal(svgResponse.status, 200);
    assert.match(svg, /Orbit &lt;script&gt; Crew/);
    assert.match(svg, /data-team-members="2"/);
    assert.match(svg, /data:image\/png;base64/);
    assert.doesNotMatch(svg, /preview-owner|@example\.com|ownerId|claimToken/);
    const firstEtag = svgResponse.headers.get('ETag');
    const head = await worker.fetch(req(`/api/og/team/${id}.png`, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Type'), 'image/png');
    assert.equal(await head.text(), '');
    const unchanged = await worker.fetch(req(`/api/og/team/${id}.svg`, { headers: { 'If-None-Match': firstEtag } }), env);
    assert.equal(unchanged.status, 304);
    await call('/api/team/join', await token('preview-third'), { token: invite });
    const changed = await worker.fetch(req(`/api/og/team/${id}.svg`, { headers: { 'If-None-Match': firstEtag } }), env);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('ETag'), firstEtag);
    assert.match(await changed.text(), /3 joined members/);
    await call('/api/team/invites/revoke', owner, { token: invite });
    const unavailableInvite = await worker.fetch(req(`/invite/${invite}`), env);
    assert.doesNotMatch(await unavailableInvite.text(), /Orbit|preview-captain/);
    assert.equal((await worker.fetch(req(`/t/${id}`, { method: 'POST', body: {} }), env)).status, 405);
    assert.equal((await worker.fetch(req(`/t/${'f'.repeat(32)}`), env)).status, 404);
  });

  it('keeps the previous logo on a failed update and resolves concurrent owner writes with one current revision', async () => {
    const { env, token, call } = await teamFixture();
    const owner = await token('atomic-logo-owner');
    const team = (await call('/api/team/invites', owner, { name: 'Atomic Icons' })).data.team;
    const first = (await call('/api/team/logo', owner, { image: teamPng, teamId: team.id })).data.team;
    const put = env.LEADERBOARD_BUCKET.put.bind(env.LEADERBOARD_BUCKET);
    let failMetadata = true;
    env.LEADERBOARD_BUCKET.put = async (key, value, options) => {
      if (failMetadata && key === `team-membership/teams/${team.id}.json`) {
        failMetadata = false;
        throw new Error('Simulated metadata commit failure');
      }
      return await put(key, value, options);
    };
    assert.equal((await call('/api/team/logo', owner, { image: teamPng, teamId: team.id })).status, 503);
    assert.equal((await call(`/api/team/${team.id}`)).data.team.logoUrl, first.logoUrl);
    assert.equal((await env.LEADERBOARD_BUCKET.list({ prefix: `team-logos/${team.id}/` })).objects.length, 1);
    let waiting = 0, release;
    const bothAtCommit = new Promise(resolve => { release = resolve; });
    env.LEADERBOARD_BUCKET.put = async (key, value, options) => {
      if (key === `team-membership/teams/${team.id}.json`) {
        if (++waiting === 2) release();
        await bothAtCommit;
      }
      return await put(key, value, options);
    };
    const updates = await Promise.all([1, 2].map(() => call('/api/team/logo', owner, { image: teamPng, teamId: team.id })));
    assert.equal(updates.filter(result => result.status === 200).length, 1);
    assert.equal(updates.filter(result => result.status === 409).length, 1);
    const winningLogo = updates.find(result => result.status === 200).data.team.logoUrl;
    assert.equal((await call(`/api/team/${team.id}`)).data.team.logoUrl, winningLogo);
    assert.equal((await env.LEADERBOARD_BUCKET.list({ prefix: `team-logos/${team.id}/` })).objects.length, 1);
    assert.equal((await worker.fetch(req(winningLogo), env)).status, 200);
  });

  it('does not load logo pixels on page metadata or HEAD and avoids pinning unavailable artwork in the edge cache', async () => {
    const previousCache = globalThis.caches;
    const cache = new Map(), stored = [];
    globalThis.caches = { default: {
      async match(request) { return cache.get(request.url)?.clone(); },
      async put(request, response) { stored.push(request.url); cache.set(request.url, response.clone()); }
    } };
    try {
      const { env, token, call } = await teamFixture();
      const owner = await token('cached-logo-owner');
      const created = (await call('/api/team/invites', owner, { name: 'Cached Crew' })).data;
      await call('/api/team/logo', owner, { image: teamPng, teamId: created.team.id });
      let pixelReads = 0;
      const get = env.LEADERBOARD_BUCKET.get.bind(env.LEADERBOARD_BUCKET);
      env.LEADERBOARD_BUCKET.get = async key => {
        if (key.startsWith('team-logos/')) pixelReads++;
        return await get(key);
      };
      env.ASSETS = { async fetch() { return new Response('<html><head></head><body></body></html>'); } };
      await worker.fetch(req(`/t/${created.team.id}`), env);
      await worker.fetch(req(`/invite/${created.invites[0].token}`), env);
      await worker.fetch(req(`/api/og/team/${created.team.id}.png`, { method: 'HEAD' }), env);
      assert.equal(pixelReads, 0);
      const first = await worker.fetch(req(`/api/og/team/${created.team.id}.svg`), env);
      assert.equal(first.status, 200);
      assert.equal(pixelReads, 1);
      assert.equal(stored.length, 1);
      await worker.fetch(req(`/api/og/team/${created.team.id}.svg?v=obsolete`), env);
      assert.equal(pixelReads, 1);
      assert.equal(stored.length, 1);
      await call('/api/team/logo', owner, { image: teamPng, teamId: created.team.id });
      await worker.fetch(req(`/api/og/team/${created.team.id}.svg?v=obsolete`), env);
      assert.equal(stored.length, 2);
      assert.notEqual(stored[0], stored[1]);
      await call('/api/team/join', await token('cached-logo-friend'), { token: created.invites[0].token });
      await worker.fetch(req(`/api/og/team/${created.team.id}.svg?v=obsolete`), env);
      assert.equal(stored.length, 3);
      const objects = await env.LEADERBOARD_BUCKET.list({ prefix: `team-logos/${created.team.id}/` });
      await env.LEADERBOARD_BUCKET.delete(objects.objects[0].key);
      await call('/api/team/join', await token('cached-logo-other'), { token: created.invites[0].token });
      const absent = await worker.fetch(req(`/api/og/team/${created.team.id}.svg`), env);
      assert.equal(absent.status, 200);
      assert.equal(absent.headers.get('Cache-Control'), 'public, max-age=15, s-maxage=15');
      assert.equal(absent.headers.get('ETag'), null);
      assert.equal(stored.length, 3);
    } finally {
      if (previousCache === undefined) delete globalThis.caches; else globalThis.caches = previousCache;
    }
  });

  it('binds artwork changes to the selected team when a shared browser cookie switches owners in another tab', async () => {
    const { env, token, call } = await teamFixture();
    const originalOwner = await token('cookie-original-owner'), switchedOwner = await token('cookie-switched-owner');
    const first = (await call('/api/team/invites', originalOwner, { name: 'Original Crew' })).data.team;
    const second = (await call('/api/team/invites', switchedOwner, { name: 'Switched Crew' })).data.team;
    const originalLogo = (await call('/api/team/logo', originalOwner, { teamId: first.id, image: teamPng })).data.team.logoUrl;
    const sessions = new Map();
    env.OAUTH_KV = {
      async get(key) { return sessions.get(key) || null; },
      async put(key, value) { sessions.set(key, value); },
      async delete(key) { sessions.delete(key); }
    };
    const browserToken = 'b'.repeat(64);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(browserToken))).toString('hex');
    sessions.set(`browser-session:${digest}`, JSON.stringify({
      identity: { provider: 'google', sub: 'cookie-switched-owner', email: 'switched@example.com' }, expiresAt: Date.now() + 600000
    }));
    for (const body of [{ teamId: first.id, image: teamPng }, { teamId: first.id, clear: true }, { image: teamPng }, { clear: true }]) {
      const response = await worker.fetch(req('/api/team/logo', { method: 'POST',
        headers: { Cookie: `__Host-th-session=${browserToken}`, Origin: 'https://token-horizon.dev' }, body }), env);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'team_changed');
    }
    assert.equal((await call(`/api/team/${first.id}`)).data.team.logoUrl, originalLogo);
    assert.equal((await call(`/api/team/${second.id}`)).data.team.logoUrl, '');
    assert.equal((await env.LEADERBOARD_BUCKET.list({ prefix: 'team-logos/' })).objects.length, 1);
    const deliberate = await worker.fetch(req('/api/team/logo', { method: 'POST',
      headers: { Cookie: `__Host-th-session=${browserToken}`, Origin: 'https://token-horizon.dev' }, body: { teamId: second.id, image: teamPng } }), env);
    assert.equal(deliberate.status, 200);
    assert.match((await deliberate.json()).team.logoUrl, new RegExp(`/api/team/${second.id}/logo`));
  });
});
