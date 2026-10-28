import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBrowserAuth, browserIdentity, identityOwnerId, identityOwns, SESSION_COOKIE } from './src/browser-auth.js';
import { callTool, READ } from './src/connector.js';
import { passwordIdentity } from './src/password-identity.js';

const origin = 'https://token-horizon.dev';
const env = () => {
  const records = new Map();
  return { FIREBASE_API_KEY: 'test-project-key', OAUTH_KV: { records, async put(k,v) { records.set(k,v); }, async get(k) { return records.get(k) || null; }, async delete(k) { records.delete(k); } } };
};
const post = (body, headers = {}) => new Request(origin + '/api/auth/password', { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json', ...headers }, body:JSON.stringify(body) });
const credentials = { email:'review@example.com', password:'only-test-password' };
const verified = { localId:'reviewer-subject', email:'review@example.com', emailVerified:true, displayName:'Review sample' };
async function withProvider(replies, fn) {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://identitytoolkit.googleapis.com');
    assert.equal(endpoint.searchParams.get('key'), 'test-project-key');
    assert.equal(options.redirect, 'manual'); assert.ok(options.signal);
    requests.push({ path:endpoint.pathname, body:JSON.parse(options.body) });
    const reply = replies[requests.length - 1];
    if (reply instanceof Error) throw reply;
    assert.ok(reply, 'unexpected provider call');
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status:reply.status || 200 });
  };
  try { await fn(requests); } finally { globalThis.fetch = original; }
}
const signIn = { body:{ idToken:'provider-id-token', refreshToken:'provider-refresh-token', localId:verified.localId } };
const lookup = user => ({ body:{ users:[user] } });

test('Managed login creates a rotated private session without storing credentials or provider tokens', async () => {
  const environment = env();
  await withProvider([signIn, lookup(verified), signIn, lookup(verified)], async requests => {
    const first = await handleBrowserAuth(post(credentials), environment, {});
    assert.equal(first.status, 200);
    const firstCookie = first.headers.get('Set-Cookie').split(';')[0];
    assert.match(firstCookie, new RegExp(`^${SESSION_COOKIE}=[a-f0-9]{64}$`));
    assert.match(first.headers.get('Cache-Control'), /no-store/);
    assert.match(first.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
    const data = await first.json();
    assert.equal(data.user.provider,'firebase'); assert.equal(data.user.sub,verified.localId);
    assert.equal(identityOwnerId(data.user),'firebase:reviewer-subject');
    const session = await browserIdentity(new Request(origin+'/api/account/profiles',{headers:{Cookie:firstCookie}}),environment);
    assert.deepEqual(session,data.user);
    const second = await handleBrowserAuth(post(credentials,{Cookie:firstCookie}),environment,{});
    assert.equal(second.status,200); assert.notEqual(second.headers.get('Set-Cookie').split(';')[0],firstCookie);
    assert.equal(await browserIdentity(new Request(origin+'/api/auth/session',{headers:{Cookie:firstCookie}}),environment),null);
    assert.equal(environment.OAUTH_KV.records.size,1);
    const saved = [...environment.OAUTH_KV.records.values()].join('') + JSON.stringify(data);
    for (const secret of [credentials.password,'provider-id-token','provider-refresh-token','test-project-key']) assert.ok(!saved.includes(secret));
    assert.equal(requests[0].body.email,credentials.email);
    assert.deepEqual(requests[1].body,{idToken:'provider-id-token'});
  });
});

test('Managed identity rejects unverified, disabled, mismatched and pending-MFA identities', async () => {
  for (const user of [{...verified,emailVerified:false},{...verified,disabled:true},{...verified,localId:'other'},{...verified,email:'other@example.com'}]) {
    await withProvider([signIn,lookup(user)],async () => {
      const environment=env(), response=await handleBrowserAuth(post(credentials),environment,{});
      assert.equal(response.status,401); assert.equal(response.headers.get('Set-Cookie'),null); assert.equal(environment.OAUTH_KV.records.size,0);
    });
  }
  await withProvider([{body:{mfaPendingCredential:'private-mfa'}}],async requests => {
    const response=await handleBrowserAuth(post(credentials),env(),{});
    assert.equal(response.status,401); assert.equal(requests.length,1); assert.ok(!(await response.text()).includes('private-mfa'));
  });
});

test('Provider denial, outage, malformed, oversized and redirect responses expose only safe errors', async () => {
  for (const [reply,status] of [[{status:400,body:{error:{message:'INVALID_LOGIN_CREDENTIALS'}}},401],[{status:400,body:{error:{message:'API_KEY_INVALID private-provider-detail'}}},503],[{status:429,body:{error:{message:'TOO_MANY_ATTEMPTS_TRY_LATER'}}},503],[{body:'broken private-provider-detail'},503],[{body:'x'.repeat(65537)},503],[{status:302,body:''},503],[new Error('private-provider-detail'),503]]) {
    await withProvider([reply],async () => {
      const response=await handleBrowserAuth(post(credentials),env(),{});
      assert.equal(response.status,status); assert.equal(response.headers.get('Set-Cookie'),null);
      const output=await response.text(); assert.ok(!output.includes('private-provider-detail')); assert.ok(!output.includes(credentials.password));
    });
  }
});

test('Origin, content type, input bounds and disabled configuration fail before provider access', async () => {
  await withProvider([],async () => {
    for (const Origin of ['https://attacker.example','null','']) assert.equal((await handleBrowserAuth(post(credentials,{Origin}),env(),{})).status,403);
    assert.equal((await handleBrowserAuth(post(credentials,{'Content-Type':'text/plain'}),env(),{})).status,400);
    assert.equal((await handleBrowserAuth(post({email:credentials.email,password:'x'.repeat(20000)}),env(),{})).status,413);
    for (const body of [{},{...credentials,email:'x'.repeat(321)},{...credentials,password:'x'.repeat(1025)}]) assert.equal((await handleBrowserAuth(post(body),env(),{})).status,401);
    assert.equal((await handleBrowserAuth(post(credentials),{OAUTH_KV:env().OAUTH_KV},{})).status,503);
  });
});

test('Same email never links a managed account to Google, GitHub or another managed subject', async () => {
  const identity={provider:'firebase',sub:verified.localId,email:verified.email};
  for (const ownerId of ['google:'+verified.localId,'github:'+verified.localId,'google:legacy','firebase:someone-else']) {
    const entry={handle:'private-owner',claimed:true,ownerId,googleEmail:verified.email};
    assert.equal(identityOwns(entry,identity,{legacyEmail:true}),false);
    const environment={LEADERBOARD_BUCKET:{async get() { return {async text(){return JSON.stringify([entry]);}}; }}};
    const result=await callTool('get_my_account',{},environment,{},identity,[READ]);
    assert.deepEqual(result.profiles,[]);
    await assert.rejects(callTool('get_my_account',{handle:entry.handle},environment,{},identity,[READ]),/not owned/);
  }
  assert.equal(identityOwns({ownerId:'firebase:'+verified.localId},identity),true);
  assert.equal(identityOwns({ownerId:'google:legacy',googleEmail:verified.email},{provider:'google',sub:'real-google',email:verified.email},{legacyEmail:true}),true);
});
