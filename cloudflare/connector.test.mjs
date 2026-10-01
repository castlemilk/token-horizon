import { register } from 'node:module';
register('./worker-loader.mjs', import.meta.url);
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { default: worker } = await import('./src/worker.js');
const { callTool, handleMcp, READ, MANAGE, redact, ownedBy } = await import('./src/connector.js');
const { verifyGoogleIdToken } = await import('./src/index.js');
const base = 'https://token-horizon.dev';
function kv() {
  const store = new Map();
  return { store,
    async get(key, type) { const v = store.get(key); if (!v || (v.exp && v.exp < Date.now()/1000)) return null; return (type === 'json' || type?.type === 'json') ? JSON.parse(v.value) : v.value; },
    async put(key, value, options = {}) { store.set(key, { value, exp: options.expiration || (options.expirationTtl ? Date.now()/1000 + options.expirationTtl : 0) }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }; }
  };
}
function r2(entries) {
  const store = new Map([['leaderboard.json', JSON.stringify(entries)]]);
  return { store, async get(key) { const v = store.get(key); return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) }; }, async put(key, value) { store.set(key, value); } };
}
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'fixture', alg: 'RS256' };
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function idToken(nonce, extra = {}) {
  const input = `${b64({alg:'RS256',kid:'fixture'})}.${b64({sub:'alice-sub',email:'alice@example.com',email_verified:true,name:'Alice',nonce,aud:'test-client',iss:'https://accounts.google.com',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...extra})}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}
const entries = [
  { handle: 'alice', claimed: true, ownerId: 'google:alice-sub', googleEmail: 'alice@example.com', claimTokenHash: 'secret', tokensAll: 100, breakdown: { models: [{model:'test',tokensAll:100}] } },
  { handle: 'bob', claimed: true, ownerId: 'google:bob-sub', googleEmail: 'bob@example.com', tokensAll: 50, breakdown: { models: [{model:'test',tokensAll:50}] } },
  { handle: 'unclaimed', claimed: false, googleEmail: 'alice@example.com', ownerId: 'google:alice-sub' }
];
const catalog = { models: [{id:'test/a',name:'Model A',provider:'test',inputPerM:2,outputPerM:4,priceFrom:1,priceFromProvider:'gateway',priceFromOutputPerM:3,priceKnown:true},{id:'test/plan',name:'Plan Model',provider:'test',priceKnown:false,priceFrom:0.1,plans:['test-plan']}],plans:[{id:'test-plan',name:'Test plan',providers:['test'],tiers:[]}] };
function env() { return { OAUTH_KV:kv(),LEADERBOARD_BUCKET:r2(structuredClone(entries)),GOOGLE_CLIENT_ID:'test-client',GOOGLE_JWKS:JSON.stringify({keys:[jwk]}),ASSETS:{fetch: async () => Response.json(catalog)} }; }
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const fetchW = (env, path, init = {}) => worker.fetch(new Request(base + path, init), env, ctx());
async function registerClient(env) {
  const response = await fetchW(env, '/oauth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test client',redirect_uris:['http://localhost:4567/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
  assert.equal(response.status,201,await response.clone().text()); return response.json();
}
async function start(env, client, scopes = [READ,'offline_access']) {
  const verifier = 'a'.repeat(64), challenge = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const q = new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],scope:scopes.join(' '),state:'client-state',resource:base+'/mcp',code_challenge:challenge,code_challenge_method:'S256'});
  const res = await fetchW(env,'/oauth/authorize?'+q);
  assert.equal(res.status,200,await res.clone().text());
  const html = await res.text();
  return { verifier, cookie:res.headers.get('set-cookie').split(';')[0],handle:html.match(/data-handle="([^"]+)"/)[1],html,q };
}
async function approve(env, flow, scopes = [READ,'offline_access'], extra = {}) {
  const body = new URLSearchParams({handle:flow.handle,credential:await idToken(flow.handle),decision:'allow'});
  scopes.forEach(s=>body.append('scope',s));
  return fetchW(env,'/oauth/authorize',{method:'POST',headers:{Origin:base,Cookie:flow.cookie,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json',...extra},body});
}
async function exchange(env, client, flow, code, extra = {}) {
  return fetchW(env,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code,code_verifier:flow.verifier,resource:base+'/mcp',...extra})});
}
async function authorized(env, scopes = [READ,'offline_access']) {
  const client = await registerClient(env), flow = await start(env,client,scopes), approved = await approve(env,flow,scopes);
  assert.equal(approved.status,200,await approved.clone().text());
  const redirect = new URL((await approved.json()).redirect); assert.equal(redirect.searchParams.get('state'),'client-state');
  const code = redirect.searchParams.get('code');
  const response = await exchange(env,client,flow,code); assert.equal(response.status,200,await response.clone().text());
  return {client,flow,code,...await response.json()};
}
const rpc = (env,name,args,token,path='/mcp') => fetchW(env,path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:name,params:args})});

test('OAuth metadata, audience challenge and public MCP initialization/tools',async()=>{
  const e=env();
  const meta=await (await fetchW(e,'/.well-known/oauth-authorization-server')).json();
  assert.equal(meta.authorization_endpoint,base+'/oauth/authorize');assert.deepEqual(meta.code_challenge_methods_supported,['S256']);
  const denied=await rpc(e,'tools/list',{});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/oauth-protected-resource/);
  const init=await rpc(e,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}},null,'/mcp/public'); assert.equal(init.status,200);
  const listed=await (await rpc(e,'tools/list',{},null,'/mcp/public')).json();assert.equal(listed.result.tools.length,7);assert.ok(!listed.result.tools.some(t=>t.name==='get_my_account'));
  const result=await (await rpc(e,'tools/call',{name:'search_models',arguments:{query:'Model A'}},null,'/mcp/public')).json();assert.equal(result.result.structuredContent.models[0].id,'test/a');
});
test('PKCE exchange, owner-only reads, least privilege and refresh',async()=>{
  const e=env(), token=await authorized(e);
  const mine=await (await rpc(e,'tools/call',{name:'get_my_account',arguments:{}},token.access_token)).json();assert.deepEqual(mine.result.structuredContent.profiles.map(p=>p.handle),['alice']);
  const other=await (await rpc(e,'tools/call',{name:'get_my_account',arguments:{handle:'bob'}},token.access_token)).json();assert.equal(other.result.isError,true);
  const write=await (await rpc(e,'tools/call',{name:'revoke_share',arguments:{handle:'alice',id:'abc'}},token.access_token)).json();assert.equal(write.result.isError,true);assert.match(write.result.content[0].text,/account:manage/);
  const refresh=await fetchW(e,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client.client_id,refresh_token:token.refresh_token,resource:base+'/mcp'})});assert.equal(refresh.status,200,await refresh.clone().text());assert.notEqual((await refresh.json()).access_token,token.access_token);
});
test('Consent is browser-bound, single-use, origin checked; Google nonce and verified email required',async()=>{
  const e=env(), client=await registerClient(e), flow=await start(e,client);
  assert.equal((await approve(e,flow,undefined,{Cookie:''})).status,400);
  assert.equal((await approve(e,flow,undefined,{Origin:'https://evil.example'})).status,400);
  assert.equal((await approve(e,flow)).status,200);assert.equal((await approve(e,flow)).status,400);
  assert.equal(await verifyGoogleIdToken(await idToken('wrong'),e,flow.handle),null);
  assert.equal(await verifyGoogleIdToken(await idToken(flow.handle,{email_verified:false}),e,flow.handle),null);
  assert.equal(await verifyGoogleIdToken(await idToken(flow.handle,{aud:'other'}),e,flow.handle),null);
});
test('Bad redirect, unsupported scope, plain PKCE, wrong verifier/resource and replay fail closed',async()=>{
  const e=env(), client=await registerClient(e), flow=await start(e,client);
  for(const [key,value] of [['redirect_uri','https://evil.example'],['scope','admin'],['code_challenge_method','plain']]){const q=new URLSearchParams(flow.q);q.set(key,value);const r=await fetchW(e,'/oauth/authorize?'+q);assert.equal(r.status,400);assert.equal(r.headers.get('location'),null);}
  const approved=await approve(e,flow), code=new URL((await approved.json()).redirect).searchParams.get('code');
  assert.equal((await exchange(e,client,flow,code,{code_verifier:'b'.repeat(64)})).status,400);
  assert.equal((await exchange(e,client,flow,code,{resource:'https://evil.example/mcp'})).status,400);
  assert.equal((await exchange(e,client,flow,code)).status,200);assert.equal((await exchange(e,client,flow,code)).status,400);
});
test('No offline scope means no refresh token; cancellation returns access_denied',async()=>{
  const e=env(), token=await authorized(e,[READ]);assert.equal(token.refresh_token,undefined);
  const flow=await start(e,token.client);
  const denied=await fetchW(e,'/oauth/authorize',{method:'POST',headers:{Origin:base,Cookie:flow.cookie,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({handle:flow.handle,decision:'deny'})});assert.equal(denied.status,200);
  assert.equal(new URL((await denied.json()).redirect).searchParams.get('error'),'access_denied');
});
test('Account management only revokes owned reports and strips identity secrets',async()=>{
  const e=env(); await e.LEADERBOARD_BUCKET.put('shares/abc.json',JSON.stringify({id:'abc',handle:'alice',ownerKey:'google:alice-sub',revoked:false}));
  await assert.rejects(callTool('revoke_share',{handle:'bob',id:'abc'},e,ctx(),{sub:'alice-sub'},[READ,MANAGE]),/not owned/);
  await assert.rejects(callTool('revoke_share',{handle:'alice',id:'abc'},e,ctx(),{sub:'alice-sub'},[READ]),/account:manage/);
  const result=await callTool('revoke_share',{handle:'alice',id:'abc'},e,ctx(),{sub:'alice-sub'},[READ,MANAGE]);assert.equal(result.revoked,true);
  assert.equal(ownedBy(entries[2],{sub:'alice-sub'}),false);assert.deepEqual(redact({ownerId:'secret',nested:{googleEmail:'private',tokens:3}}),{nested:{tokens:3}});
});
test('Connection manager requires bound Google login and revokes access plus refresh tokens',async()=>{
  const e=env(), token=await authorized(e);
  const page=await fetchW(e,'/connect'), html=await page.text(), nonce=html.match(/data-handle="([^"]+)"/)[1], cookie=page.headers.get('set-cookie').split(';')[0];
  const fields={handle:nonce,credential:await idToken(nonce),action:'list'};
  const manage=(data,extra={})=>fetchW(e,'/oauth/connections',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams(data)});
  assert.equal((await manage(fields,{Cookie:''})).status,401);
  const list=await (await manage(fields)).json();assert.equal(list.connections.length,1);
  const stranger=await manage({...fields,credential:await idToken(nonce,{sub:'bob-sub',email:'bob@example.com'})});assert.equal((await stranger.json()).connections.length,0);
  assert.equal((await manage({...fields,action:'revoke',id:list.connections[0].id})).status,200);
  assert.equal((await rpc(e,'tools/list',{},token.access_token)).status,401);
  const refresh=await fetchW(e,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client.client_id,refresh_token:token.refresh_token})});assert.equal(refresh.status,400);
});
test('Catalog comparison, plan-only price exclusion, bounded inputs and private tool isolation',async()=>{
  const e=env();assert.equal((await callTool('get_cheapest_models',{},e,ctx())).models.length,1);
  assert.equal((await callTool('compare_models',{ids:['test/a']},e,ctx())).models[0].priceFrom,1);
  const invalid=await (await rpc(e,'tools/call',{name:'search_models',arguments:{limit:100000}},null,'/mcp/public')).json();assert.equal(invalid.result.isError,true);
  const privateCall=await (await rpc(e,'tools/call',{name:'get_my_account',arguments:{}},null,'/mcp/public')).json();assert.equal(privateCall.result.isError,true);
  const privateToken=await authorized(e,[READ,MANAGE]);const publicWithToken=await (await rpc(e,'tools/list',{},privateToken.access_token,'/mcp/public')).json();assert.equal(publicWithToken.result.tools.length,7);
});

test('Chunked oversized requests and unexpected tool fields are rejected',async()=>{
  const e=env();
  const large=await fetchW(e,'/mcp/public',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:'x'.repeat(32769)});assert.equal(large.status,413);
  const invalid=await (await rpc(e,'tools/call',{name:'get_user_profile',arguments:{handle:'alice',url:'http://127.0.0.1:8765'}},null,'/mcp/public')).json();assert.equal(invalid.result.isError,true);
  const preflight=await fetchW(e,'/mcp/public',{method:'OPTIONS'});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
});

test('Remembered Google and GitHub sessions require explicit bound consent and keep grants in separate namespaces', async () => {
  for (const provider of ['google', 'github']) {
    const e = env();
    const sub = provider === 'github' ? '42' : 'alice-sub';
    if (provider === 'github') await e.LEADERBOARD_BUCKET.put('leaderboard.json', JSON.stringify([...entries, { handle: 'github-alice', claimed: true, ownerId: 'github:42', accountEmail: 'alice@example.com', tokensAll: 20 }]));
    let sessionCookie;
    if (provider === 'google') {
      const login = await fetchW(e, '/api/auth/google', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: await idToken() }) });
      assert.equal(login.status, 200); sessionCookie = login.headers.get('Set-Cookie').split(';')[0];
    } else {
      // Provider exchange is covered by browser-auth.test. Seed its opaque,
      // hashed browser session here to focus on real OAuth-provider integration.
      const opaque = 'a'.repeat(64);
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opaque))).toString('hex');
      await e.OAUTH_KV.put('browser-session:' + hash, JSON.stringify({ identity: { provider, sub, email: 'alice@example.com', name: 'GitHub Alice', picture: '' }, expiresAt: Date.now() + 60000 }));
      sessionCookie = '__Host-th-session=' + opaque;
    }
    const client = await registerClient(e), flow = await start(e, client);
    assert.equal([...e.OAUTH_KV.store.keys()].some(key => key.startsWith('grant:')), false);
    const fields = new URLSearchParams({ handle: flow.handle, decision: 'allow', scope: READ });
    const approveSession = cookie => fetchW(e, '/oauth/authorize', { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: fields });
    assert.equal((await approveSession(flow.cookie)).status, 401);
    // A login alone cannot replace the transaction cookie.
    assert.equal((await approveSession(sessionCookie)).status, 400);
    const allowed = await approveSession(flow.cookie + '; ' + sessionCookie); assert.equal(allowed.status, 200, await allowed.clone().text());
    const code = new URL((await allowed.json()).redirect).searchParams.get('code');
    const exchanged = await exchange(e, client, flow, code); assert.equal(exchanged.status, 200);
    const token = (await exchanged.json()).access_token;
    const account = await (await rpc(e, 'tools/call', { name: 'get_my_account', arguments: {} }, token)).json();
    assert.deepEqual(account.result.structuredContent.profiles.map(profile => profile.handle), [provider === 'google' ? 'alice' : 'github-alice']);
    const management = await fetchW(e, '/connect'), html = await management.text();
    const nonce = html.match(/data-handle="([^"]+)"/)[1], managementCookie = management.headers.get('Set-Cookie').split(';')[0];
    const listed = await fetchW(e, '/oauth/connections', { method: 'POST', headers: { Origin: base, Cookie: managementCookie + '; ' + sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle: nonce, action: 'list' }) });
    assert.equal(listed.status, 200); assert.equal((await listed.json()).connections.length, 1);
  }
});
