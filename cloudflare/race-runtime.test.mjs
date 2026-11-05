import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const origin='https://token-horizon.dev', callback='https://assistant.example/callback';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture',alg:'RS256'};
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function idToken(nonce) {
  const input=`${b64({alg:'RS256',kid:'fixture'})}.${b64({sub:'alice-sub',email:'alice@example.test',email_verified:true,name:'Alice',nonce,aud:'fixture-client',iss:'https://accounts.google.com',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}`;
  return `${input}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))).toString('base64url')}`;
}
const assets={
  name:'unused-render-assets',
  setup(builder){
    builder.onResolve({filter:/\.(?:wasm|ttf)$/},args=>({path:args.path,namespace:'fixture-asset'}));
    builder.onLoad({filter:/.*/,namespace:'fixture-asset'},()=>({contents:'export default new Uint8Array()',loader:'js'}));
  },
};
async function bundle(entry) {
  const result=await build({entryPoints:[entry],bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'esm',external:['cloudflare:*','node:*'],plugins:[assets],write:false});
  return result.outputFiles[0].text;
}
const current=await bundle(new URL('./src/worker.js',import.meta.url).pathname);
// The old Worker uses the same pinned provider with its original KV storage.
// Its tiny consent handler supplies only synthetic test identity and props.
const legacyBundle=await build({
  stdin:{resolveDir:new URL('.',import.meta.url).pathname,loader:'js',contents:`
    import OAuthProvider from '@cloudflare/workers-oauth-provider';
    export default new OAuthProvider({
      apiRoute:'/mcp', authorizeEndpoint:'/oauth/authorize', tokenEndpoint:'/oauth/token', clientRegistrationEndpoint:'/oauth/register',
      scopesSupported:['account:read','account:manage','offline_access'], accessTokenTTL:3600, refreshTokenTTL:30*86400,
      resourceMetadata:{resource:'https://token-horizon.dev/mcp',authorization_servers:['https://token-horizon.dev'],scopes_supported:['account:read']},
      apiHandler:{fetch(){return new Response(null,{status:405})}},
      defaultHandler:{async fetch(request,env){
        const auth=await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const grant=await env.OAUTH_PROVIDER.completeAuthorization({request:auth,userId:'${createHash('sha256').update('google:alice-sub').digest('hex')}',scope:['account:read','offline_access'],metadata:{},props:{sub:'alice-sub',provider:'google'}});
        return Response.redirect(grant.redirectTo,302);
      }}
    });
  `},bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'esm',external:['cloudflare:*','node:*'],write:false,
});
const legacy=legacyBundle.outputFiles[0].text;

test('real Worker grants coordinate refresh and keep legacy revocation authoritative',async t=>{
  const common={modules:true,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:{OAUTH_KV:'oauth-shared'},r2Buckets:{LEADERBOARD_BUCKET:'leaderboard-shared'},bindings:{GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_JWKS:JSON.stringify({keys:[jwk]})},serviceBindings:{ASSETS:async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})}};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[
    {...common,name:'new',script:current,routes:['token-horizon.dev/*'],durableObjects:{OAUTH_GRANTS:{className:'OAuthGrantCoordinator',useSQLite:true}}},
    {...common,name:'old',script:legacy},
  ],log:new Log(LogLevel.ERROR)}));
  t.after(()=>mf.dispose());
  const fresh=await mf.getWorker('new'), old=await mf.getWorker('old');
  const send=(which,path,init={})=>which.fetch(`${origin}${path}`,{redirect:'manual',...init});
  async function grant(which,method='none') {
    const reg=await send(which,'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Fixture MCP',redirect_uris:[callback],token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(reg.status,201);const client=await reg.json();
    const verifier=randomBytes(32).toString('base64url');
    const q=new URLSearchParams({client_id:client.client_id,redirect_uri:callback,response_type:'code',state:'fixture',scope:'account:read offline_access',resource:`${origin}/mcp`,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    const page=await send(which,`/oauth/authorize?${q}`);assert.equal(page.status,200,await page.clone().text());
    const handle=(await page.text()).match(/data-handle="([^"]+)"/)[1];
    const form=new URLSearchParams({handle,credential:await idToken(handle),decision:'allow'});form.append('scope','account:read');form.append('scope','offline_access');
    const approved=await send(which,'/oauth/authorize',{method:'POST',headers:{Origin:origin,Cookie:page.headers.get('Set-Cookie').split(';')[0],'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form});
    assert.equal(approved.status,200,await approved.clone().text());
    return {client,verifier,method,code:new URL((await approved.json()).redirect).searchParams.get('code')};
  }
  const tokenRequest=(which,g,fields,secret=g.client.client_secret)=>{
    const headers={'Content-Type':'application/x-www-form-urlencoded'},body=new URLSearchParams(fields);
    if(g.method==='client_secret_basic') headers.Authorization=`Basic ${btoa(`${encodeURIComponent(g.client.client_id)}:${encodeURIComponent(secret)}`)}`;
    else {body.set('client_id',g.client.client_id);if(g.method==='client_secret_post')body.set('client_secret',secret);}
    return send(which,'/oauth/token',{method:'POST',headers,body});
  };
  const exchange=(which,g)=>tokenRequest(which,g,{grant_type:'authorization_code',redirect_uri:callback,code:g.code,code_verifier:g.verifier,resource:`${origin}/mcp`});
  const refresh=(which,g,credential,secret)=>tokenRequest(which,g,{grant_type:'refresh_token',refresh_token:credential,resource:`${origin}/mcp`},secret);
  async function legacyGrant() {
    const reg=await send(old,'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Legacy fixture',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(reg.status,201);const client=await reg.json(),verifier=randomBytes(32).toString('base64url');
    const query=new URLSearchParams({client_id:client.client_id,redirect_uri:callback,response_type:'code',state:'fixture',scope:'account:read offline_access',resource:`${origin}/mcp`,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    const approved=await send(old,`/oauth/authorize?${query}`);assert.equal(approved.status,302);
    return {client,verifier,code:new URL(approved.headers.get('Location')).searchParams.get('code')};
  }
  await t.test('code use and refresh overlap stay consistent after an object restart',async()=>{
    const g=await grant(fresh), responses=await Promise.all([exchange(fresh,g),exchange(fresh,g)]);
    assert.equal(responses.filter(r=>r.status===200).length,1);
    const tokens=await responses.find(r=>r.status===200).json();
    const both=await Promise.all([refresh(fresh,g,tokens.refresh_token),refresh(fresh,g,tokens.refresh_token)]);
    assert.ok(both.every(r=>r.status===200));const next=await both[0].json(),overlap=await both[1].json();assert.equal(overlap.access_token,next.access_token);assert.equal(overlap.refresh_token,next.refresh_token);
    const [user,grantId]=tokens.refresh_token.split(':');
    await mf.unsafeEvictDurableObject('new','OAuthGrantCoordinator',{name:`${user}:${grantId}`});
    const retry=await refresh(fresh,g,tokens.refresh_token);assert.equal(retry.status,200);const recovered=await retry.json();assert.equal(recovered.access_token,next.access_token);assert.equal(recovered.refresh_token,next.refresh_token);assert.ok(recovered.expires_in>0&&recovered.expires_in<=next.expires_in);
    assert.equal((await refresh(fresh,g,next.refresh_token)).status,200);
  });
  await t.test('legacy access remains usable, but stale KV cannot revive a revoked grant',async()=>{
    const g=await legacyGrant(), issued=await exchange(old,g);assert.equal(issued.status,200);const tokens=await issued.json();
    const read=()=>send(fresh,'/mcp',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
    assert.equal((await read()).status,405);
    assert.equal((await refresh(fresh,g,tokens.refresh_token)).status,400);
    const kv=await mf.getKVNamespace('OAUTH_KV','old');
    const [user,grantId]=tokens.refresh_token.split(':'), grantKey=`grant:${user}:${grantId}`;
    const tokenList=await kv.list({prefix:`token:${user}:${grantId}:`});
    const snapshots=await Promise.all([grantKey,...tokenList.keys.map(k=>k.name)].map(async key=>({key,value:await kv.get(key)})));
    const page=await send(fresh,'/connect'), html=await page.text(), nonce=html.match(/data-handle="([^"]+)"/)[1];
    const form=new URLSearchParams({handle:nonce,credential:await idToken(nonce),action:'revoke',id:grantId});
    const revoke=await send(fresh,'/oauth/connections',{method:'POST',headers:{Origin:origin,Cookie:page.headers.get('Set-Cookie').split(';')[0],'Content-Type':'application/x-www-form-urlencoded'},body:form});
    assert.equal(revoke.status,200,await revoke.clone().text());
    for(const item of snapshots) if(item.value) await kv.put(item.key,item.value);
    assert.equal((await read()).status,401);
    assert.equal((await refresh(fresh,g,tokens.refresh_token)).status,400);
  });
  await t.test('a bad confidential-client secret cannot revoke a known retired token',async()=>{
    const g=await grant(fresh,'client_secret_basic'),issued=await exchange(fresh,g);assert.equal(issued.status,200);const a=await issued.json();
    const b=await (await refresh(fresh,g,a.refresh_token)).json();
    const c=await (await refresh(fresh,g,b.refresh_token)).json();
    assert.notEqual((await refresh(fresh,g,a.refresh_token,'wrong-secret')).status,200);
    const next=await refresh(fresh,g,c.refresh_token);assert.equal(next.status,200);const d=await next.json();
    assert.equal((await refresh(fresh,g,a.refresh_token)).status,400);
    assert.equal((await refresh(fresh,g,d.refresh_token)).status,400);
  });
  await t.test('expired grant cleanup removes the index and retains a revocation marker',async()=>{
    const kv=await mf.getKVNamespace('OAUTH_KV','new');
    const namespace=await mf.getDurableObjectNamespace('OAUTH_GRANTS','new');
    const key='grant:synthetic-user:synthetic-grant';
    const actor=namespace.get(namespace.idFromName('synthetic-user:synthetic-grant'));
    const operation=data=>actor.fetch('https://grant.internal/__grant_operation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    await kv.put(key,JSON.stringify({id:'synthetic-grant'}));
    assert.equal((await operation({op:'create',key,record:{value:'{}',expiresAt:Date.now()+300}})).status,204);
    const deadline=Date.now()+5000;let marker;
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,100));
      marker=await (await operation({op:'get',key})).json();
      if(marker.initialized&&!marker.record&&!(await kv.get(key)))break;
    }
    assert.equal(marker.initialized,true);assert.equal(marker.record,undefined);assert.equal(await kv.get(key),null);
  });
});
