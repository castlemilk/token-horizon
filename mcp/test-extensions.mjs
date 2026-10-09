import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_URI, extensionTools, callExtension, readExtensionResource } from './extensions.mjs';
const models = [{id:'openai/model-a',name:'Model A',provider:'OpenAI',inputPerM:2,outputPerM:8,description:'PRIVATE_PROMPT'}];
const context = (mode='local', failure='') => ({mode, read:async key=>{
 if(key===failure) throw new Error('PRIVATE_KEY');
 return {catalog:{models},usage:{tokensToday:12,prompt:'PRIVATE_PROMPT'},traces:[{id:'r1',model:'m',usage:{inputTokens:12,source:'reported',prompt:'PRIVATE_PROMPT'},requestBody:'PRIVATE_PROMPT',responseBody:'PRIVATE_RESPONSE',errorMessage:'PRIVATE_KEY'}],community:{total:2,kpis:{totalTokens:12,prompt:'PRIVATE_PROMPT'}}}[key];
}});
test('Entrypoints and mentions advertise read-only app contracts',()=>{
 assert.deepEqual(extensionTools[0]._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
 for(const tool of extensionTools) assert.equal(tool.annotations.readOnlyHint,true);
 assert.deepEqual(extensionTools[2]._meta['openai/extensions'],{'mentions/search':{}});
});
test('Entrypoint returns immediately without reading a data source',async()=>{
 const result=await callExtension('token_horizon_app',{}, {mode:'local',read:()=>{throw new Error('Entrypoint must not read')}});
 assert.equal(result.pending,true);
});
test('Mentions return exact scoped resources and reject arbitrary input',async()=>{
 const result=await callExtension('token_horizon_search_mentions',{query:'model a'},context());
 assert.equal(result.items[0].uri,'tokenhorizon://models/openai%2Fmodel-a');
 const resource=await readExtensionResource(result.items[0].uri,context());
 assert.equal(JSON.parse(resource.contents[0].text).model.id,'openai/model-a');
 assert(!JSON.stringify(resource).includes('PRIVATE'));
 for(const uri of ['https://evil.example','file:///etc/passwd','tokenhorizon://models/%ZZ','tokenhorizon://models/missing','tokenhorizon://models/openai%2Fmodel-a?extra=1']) await assert.rejects(readExtensionResource(uri,context()));
 await assert.rejects(callExtension('token_horizon_search_mentions',{query:'a',url:'https://evil.example'},context()));
 await assert.rejects(callExtension('token_horizon_search_mentions',{query:'x'.repeat(201)},context()));
});
test('Local scope excludes content; partial failures never become zero usage',async()=>{
 const result=await callExtension('token_horizon_overview',{},context());
 assert.equal(result.usage.tokensToday,12);assert.equal(result.traces[0].usage.inputTokens,12);
 assert(!JSON.stringify(result).includes('PRIVATE'));
 const partial=await callExtension('token_horizon_overview',{},context('local','usage'));
 assert.equal(partial.usage,undefined);assert.equal(partial.models.length,1);assert.equal(partial.warnings.length,1);
 assert(!JSON.stringify(partial).includes('PRIVATE_KEY'));
});
test('Hosted scope never requests device traces or usage',async()=>{
 const c=context('hosted'), reads=[];const read=c.read;c.read=key=>{reads.push(key);return read(key)};
 const result=await callExtension('token_horizon_overview',{},c);
 assert.deepEqual(reads,['community','catalog']);assert.deepEqual(result.traces,[]);
 assert.equal(result.community.kpis.totalTokens,12);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('UI resources are self-contained and prohibit network domains',async()=>{
 const resource=await readExtensionResource(APP_URI,context());const item=resource.contents[0];
 assert.equal(item.mimeType,'text/html;profile=mcp-app');
 assert.deepEqual(item._meta.ui.csp,{connectDomains:[],resourceDomains:[],frameDomains:[]});
 assert.match(item.text,/Usage observatory/);assert.match(item.text,/Add metadata to context/);
});
