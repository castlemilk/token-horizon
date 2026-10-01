import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { resolveChromium } from './playwright.mjs';

// Test the authored scene independently of team/auth requests. Only local
// committed assets are served; no user account or team is changed.
const docs = path.resolve('docs');
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/team-blackhole.css"><style>body{margin:0;background:#e6eee3}main{width:min(680px,100%);margin:auto;padding-top:20px}.spacer{height:1800px}</style><main><div data-team-blackhole aria-hidden="true"></div><button id="pause">Pause animation</button></main><div class="spacer"></div><script src="/team-blackhole.js"></script><script>window.motion=TokenHorizonTeamMotion.mount(document.querySelector('[data-team-blackhole]'));</script>`;
const mime = { '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/') {res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
  const filename = path.resolve(docs,url.pathname.slice(1));
  if(!filename.startsWith(docs+path.sep)) {res.writeHead(404);res.end();return;}
  try {const data=await fs.readFile(filename);res.writeHead(200,{'content-type':mime[path.extname(filename)]||'application/octet-stream'});res.end(data);}
  catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await (await resolveChromium()).launch({channel:'chrome',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:3,reducedMotion:'no-preference'});
  const page=await context.newPage(),requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  page.on('request',request=>requests.push(request.url()));
  await page.goto(origin);
  await page.waitForFunction(()=>motion.state==='running'&&motion.frameCount>4);
  assert.equal(await page.locator('.th-team-hole-provider').count(),6);
  assert.equal(await page.locator('[data-team-blackhole] canvas').count(),1);
  const sizes=await page.locator('[data-team-blackhole] canvas').evaluate(canvas=>({pixels:canvas.width,css:canvas.getBoundingClientRect().width}));
  assert(sizes.pixels/sizes.css<=1.51,'Rendering resolution must cap DPR at1.5');
  assert.equal(requests.filter(url=>url.includes('/vendor/three.js')).length,1,'THREE runtime loads once');
  await page.evaluate(()=>{window.sameMotion=TokenHorizonTeamMotion.mount(document.querySelector('[data-team-blackhole]'));});
  assert(await page.evaluate(()=>sameMotion===motion),'Repeated mount reuses existing renderer');
  await page.screenshot({path:'/tmp/th-team-blackhole-desktop.png',fullPage:false});
  await page.evaluate(()=>motion.pause());
  const pausedFrames=await page.evaluate(()=>motion.frameCount);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>motion.frameCount),pausedFrames,'Manual pause cancels RAF');
  await page.evaluate(()=>motion.resume());
  await page.waitForFunction(count=>motion.frameCount>count,pausedFrames);
  await page.evaluate(()=>window.scrollTo(0,1200));
  await page.waitForFunction(()=>motion.state==='paused');
  const offscreen=await page.evaluate(()=>motion.frameCount);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>motion.frameCount),offscreen,'Offscreen animation must not run');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>motion.state==='running');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  const hidden=await page.evaluate(()=>motion.frameCount);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>motion.frameCount),hidden,'Hidden documents must not animate');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(count=>motion.frameCount>count,hidden);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>motion.state==='static');
  const reduced=await page.evaluate(()=>motion.frameCount);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>motion.frameCount),reduced,'Reduced motion must stop spatial movement');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>motion.state==='running');
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(100);
  await page.screenshot({path:'/tmp/th-team-blackhole-mobile.png',fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,'Scene fits narrow viewport');
  await page.evaluate(()=>document.querySelector('[data-team-blackhole]').remove());
  await page.waitForFunction(()=>motion.state==='destroyed');
  assert.equal(await page.locator('canvas').count(),0,'Navigation detaches and disposes the WebGL scene');
  await context.close();
  console.log('✓ WebGL scene, capped resolution, bounded lifecycle, visibility, preferences and detach');

  for(const type of ['reduced','webgl-off']) {
    const staticContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:type==='reduced'?'reduce':'no-preference'});
    if(type==='webgl-off') await staticContext.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(name,...args){return name.startsWith('webgl')?null:original.call(this,name,...args);};});
    const staticPage=await staticContext.newPage(),staticRequests=[];
    staticPage.on('request',request=>staticRequests.push(request.url()));
    staticPage.on('pageerror',error=>errors.push(error.message));
    await staticPage.goto(origin);
    await staticPage.waitForTimeout(250);
    assert.equal(await staticPage.locator('.th-team-hole-provider').count(),6);
    assert.equal(await staticPage.locator('canvas').count(),0,'Fallback remains available without WebGL');
    if(type==='reduced') assert.equal(staticRequests.some(url=>url.includes('/vendor/three.js')),false,'Reduced motion skips GPU runtime download');
    assert.notEqual(await staticPage.locator('.th-team-hole-fallback').evaluate(el=>getComputedStyle(el).opacity),'0');
    await staticContext.close();
  }
  console.log('✓ Reduced-motion and WebGL-off static composition preserve provider marks');
  assert.deepEqual(errors,[],'Scene must render without JS, WebGL shader or asset errors');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
