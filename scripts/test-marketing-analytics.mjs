import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const original = readFileSync(new URL('../docs/marketing-analytics.js', import.meta.url), 'utf8');
function setup({ enabled = true, path = '/', search = '', hash = '', dnt, gpc, origin = 'https://token-horizon.dev' } = {}) {
 const controls = {};
 const listeners = {};
 for (const name of ['[data-allow]', '[data-revoke]', '[role=status]']) controls[name] = { disabled: name.includes('revoke'), addEventListener(type, fn) { this[type] = fn; } };
 const root = { hidden: true, querySelector: name => controls[name] };
 const scripts = [];
 const window = { addEventListener(type, fn) { listeners[type] = fn; } };
 const location = { origin, pathname: path, search, hash };
 const context = { window, location, navigator: { doNotTrack: dnt, globalPrivacyControl: gpc }, document: { getElementById: () => root, head: { append: s => scripts.push(s) }, createElement: () => ({}) } };
 runInNewContext(enabled ? original.replace("enabled: false, measurementId: ''", "enabled: true, measurementId: 'G-TEST123'") : original, context);
 return { ...context, root, scripts, listeners, allow: controls['[data-allow]'], revoke: controls['[data-revoke]'] };
}
for (const options of [{enabled:false}, {path:'/leaderboard'}, {path:'/models'}, {search:'?token=secret'}, {hash:'#secret'}, {dnt:'1'}, {gpc:true}, {origin:'https://preview.example'}]) {
 const t=setup(options); assert.equal(t.root.hidden,true); assert.equal(t.scripts.length,0);
}
{
 const t=setup(); assert.equal(t.scripts.length,0); t.allow.click(); t.allow.click(); assert.equal(t.scripts.length,1);
 t.scripts[0].onload(); const commands=t.window.dataLayer.map(x=>Array.from(x));
 assert.equal(commands.filter(x=>x[0]==='event').length,1);
 assert.equal(commands.find(x=>x[0]==='config')[2].send_page_view,false);
 assert.equal(commands.find(x=>x[0]==='event')[2].page_referrer,'');
 t.revoke.click(); assert.equal(t.window['ga-disable-G-TEST123'],true); assert.equal(t.window.dataLayer.length,0);
 t.allow.click(); assert.equal(t.scripts.length,1);
}
{
 const t=setup(); t.allow.click(); t.revoke.click(); t.scripts[0].onload();
 assert.equal(t.window.dataLayer.length,0); assert.equal(t.window['ga-disable-G-TEST123'],true);
}
for (const event of ['hashchange','pagehide','popstate']) {
 const t=setup(); t.allow.click(); t.listeners[event](); t.scripts[0].onload(); assert.equal(t.window.dataLayer.length,0);
}
{
 const t=setup(); t.allow.click(); t.scripts[0].onerror(); assert.equal(t.window['ga-disable-G-TEST123'],true);
}
assert.match(readFileSync(new URL('../docs/index.html', import.meta.url),'utf8'), /id="marketing-analytics" hidden/);
console.log('Marketing analytics: 15 consent, scope, loading and withdrawal cases passed (mock vendor only).');
