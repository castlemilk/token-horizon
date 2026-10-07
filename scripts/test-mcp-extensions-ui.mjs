import assert from 'node:assert/strict';
import { resolveChromium } from './playwright.mjs';
import { overviewHTML } from '../mcp/ui/overview.generated.mjs';
const browser=await(await resolveChromium()).launch({channel:'chrome',headless:true});
const metadata={mode:'local',source:'Local fixture metadata; not published',privacy:'Prompts and credentials excluded',pending:false,warnings:[],models:[{id:'openai/a',name:'Model A',provider:'OpenAI',inputPerM:2,outputPerM:8},{id:'local/b',name:'Unknown price',provider:'Local',priceKnown:false}],usage:{tokensToday:17},traces:[{model:'Model A',provider:'openai',durationMs:34,usage:{inputTokens:9,outputTokens:8},completionState:'complete',usageCoverage:'reported'}]};
try {
 for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());requests.push(url.pathname);
   assert.equal(url.origin,'https://mcp-fixture.invalid');
   return route.fulfill({contentType:'text/html',body:url.pathname==='/app'?overviewHTML:`<!doctype html><style>body{margin:0}iframe{border:0;width:100%;height:880px}</style><script>
   window.calls=[];window.addEventListener('message',event=>{const m=event.data;if(!m||m.jsonrpc!=='2.0'||!m.method)return;window.calls.push(m);const reply=result=>event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
   if(m.method==='ui/initialize')reply({protocolVersion:m.params.protocolVersion,hostInfo:{name:'Fixture host',version:'1'},hostCapabilities:{serverTools:{},updateModelContext:{},sendMessage:{}},hostContext:{theme:'dark',displayMode:'inline'}});
   else if(m.method==='ui/notifications/initialized')event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:'metadata'}],structuredContent:${JSON.stringify({mode:'local',source:metadata.source,pending:true})}}},'*');
   else if(m.method==='tools/call')reply({content:[{type:'text',text:'metadata'}],structuredContent:${JSON.stringify(metadata)}});
   else if(m.id!==undefined)reply({});});</script><iframe src='/app'></iframe>`});
  });
  await page.goto('https://mcp-fixture.invalid/');const app=page.frameLocator('iframe');
  await app.locator('#status').filter({hasText:'Metadata ready'}).waitFor();
  assert.equal((await page.evaluate(()=>calls)).filter(c=>c.method==='tools/call').length,1,'Pending entrypoint hydrates once');
  assert.equal(await app.locator('html').getAttribute('data-theme'),'dark');
  assert.match(await app.locator('#content').innerText(),/Not reported/);
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light','openai/deepLink':{url:'/usage'}}},'*'));
  await app.locator('[data-tab="usage"][aria-pressed="true"]').waitFor();
  assert.equal(await app.locator('html').getAttribute('data-theme'),'light');assert.match(await app.locator('#content').innerText(),/17/);
  await app.locator('[data-tab="models"]').click();
  await app.locator('#search').fill('Model A');assert.equal(await app.locator('tbody tr').count(),1);
  await app.locator('[data-tab="traces"]').click();assert.match(await app.locator('#content').innerText(),/complete \/ reported/);
  assert.equal((await page.evaluate(()=>calls)).filter(c=>c.method==='ui/update-model-context'||c.method==='ui/message').length,0,'No automatic context or conversation writes');
  await app.locator('#context').click();await app.locator('#status').filter({hasText:'added to conversation context'}).waitFor();
  await app.locator('#ask').click();await page.waitForFunction(()=>calls.some(c=>c.method==='ui/message'));
  const calls=await page.evaluate(()=>calls);assert(calls.some(c=>c.method==='ui/update-model-context'));assert(calls.some(c=>c.method==='ui/message'));
  assert.deepEqual(errors,[]);assert.deepEqual(requests,['/','/app']);
  const metrics=await app.locator('body').evaluate(node=>({width:node.scrollWidth,viewport:innerWidth}));assert(metrics.width<=metrics.viewport+1,'App body fits viewport');
  await page.screenshot({path:`/tmp/token-horizon-mcp-${width}.png`});await context.close();
 }
 console.log('MCP UI: SDK handshake, host theme, filtering, trace scope, explicit context/message actions and responsive layout passed.');
}finally{await browser.close();}
