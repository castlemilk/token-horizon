import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';
import { connectPage, pageHeaders } from '../cloudflare/src/connect-page.js';
const origin = 'https://token-horizon.dev', root = path.resolve('docs');
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const google = { provider: 'google', sub: 'google-42', name: 'Aurora Builder', email: 'shared@example.com', picture: '' };
const github = { provider: 'github', sub: '42', name: 'Orbit Builder', email: 'shared@example.com', login: 'orbit-builder', picture: '' };
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
async function fixture({ user = null, mode = 'authorize', exchange = 'ready', width = 1440, remembered = null, holdFirstSession = false, holdFirstConnections = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(value => {
    if (value) localStorage.setItem('th_auth_hint', JSON.stringify(value));
    const write = Storage.prototype.setItem;
    window.authHintWrites = 0;
    Storage.prototype.setItem = function(key, next) { if (this === localStorage && key === 'th_auth_hint') ++window.authHintWrites; return write.call(this, key, next); };
  }, remembered);
  const page = await context.newPage(), errors = [], requests = [];
  let releaseSession, releaseConnections, sessionReads = 0, connectionReads = 0;
  const sessionHeld = new Promise(resolve => { releaseSession = resolve; });
  const connectionsHeld = new Promise(resolve => { releaseConnections = resolve; });
  let currentUser = user, releaseExchange;
  const held = new Promise(resolve => { releaseExchange = resolve; });
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private,no-store' }, body: JSON.stringify(value) });
  const session = () => ({ ok: true, authenticated: Boolean(currentUser), user: currentUser, expiresAt: currentUser ? Date.now() + 86400000 : null });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), headers: request.headers(), body: request.postData() });
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{id:{initialize(opts){window.gsiOptions=opts;window.gsiInitializations=(window.gsiInitializations||[]).concat([{auto_select:opts.auto_select,login_hint:opts.login_hint,button_auto_select:opts.button_auto_select}]);window.gsiCallback=opts.callback},renderButton(host,opts){const b=document.createElement('button');b.textContent='Continue with test Google';b.className='test-gsi';b.style.width=opts.width+'px';b.onclick=()=>window.gsiCallback({credential:'signed-provider-credential'});host.append(b)},prompt(){window.gsiPrompts=(window.gsiPrompts||0)+1},cancel(){},disableAutoSelect(){}}}}` });
    assert.equal(url.origin, origin, 'Fixture cannot contact external services');
    if (url.pathname === '/api/auth/session') { const snapshot = session(); if (++sessionReads === 1 && holdFirstSession) await sessionHeld; return json(route, snapshot); }
    if (url.pathname === '/api/auth/google') { if (exchange === 'held') await held; if (exchange === 'error') return json(route, { error: 'Identity could not be verified.' }, 401); currentUser = google; return json(route, session()); }
    if (url.pathname === '/api/auth/logout') { currentUser = null; return json(route, session()); }
    if (url.pathname === '/api/auth/github') return route.fulfill({ contentType: 'text/html', body: '<main id="github-start">Provider redirect intercepted</main>' });
    if (url.pathname === '/oauth/authorize' && request.method() === 'POST') return json(route, { redirect: origin + '/fixture-return' });
    if (url.pathname === '/fixture-return') return route.fulfill({ contentType: 'text/html', body: '<main id="returned">Connected</main>' });
    if (url.pathname === '/oauth/connections') { const snapshot = { connections: [{ id: 'grant42', name: currentUser?.provider === 'github' ? 'GitHub Tool' : 'Google Tool', destination: 'localhost:8765', scope: ['account:read'] }], cursor: null, name: currentUser?.name }; if (++connectionReads === 1 && holdFirstConnections) await connectionsHeld; return json(route, snapshot); }
    if (url.pathname === '/connect' || url.pathname === '/oauth/authorize') return route.fulfill({ contentType: 'text/html', headers: Object.fromEntries(pageHeaders()), body: connectPage({ mode, clientId: 'test-web-client', handle: 'browser-nonce', githubAuth: true, webSessions: true, clientName: 'Test Connector', redirect: 'localhost:4567' }) });
    const file = path.resolve(root, url.pathname.slice(1));
    if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
    try { return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, context, requests, release: releaseExchange, releaseSession, releaseConnections, setUser(value) { currentUser = value; }, async close() { releaseExchange(); releaseSession(); releaseConnections(); await context.close(); assert.deepEqual(errors, [], 'Connector must not throw browser errors'); } };
}
try {
  console.log('Connector: remembered GitHub identity still requires explicit permission approval...');
  {
    const f = await fixture({ user: github });
    try {
      await f.page.goto(origin + '/oauth/authorize?client_id=test-client&state=client-state&scope=account%3Aread&redirect_uri=http%3A%2F%2Flocalhost%3A4567%2Fcallback');
      await f.page.waitForSelector('#identity:not([hidden])');
      assert.match(await f.page.locator('#identity').innerText(), /Orbit Builder/);
      assert(await f.page.locator('#allow').isEnabled());
      assert.equal(f.requests.filter(request => request.path === '/oauth/authorize' && request.method === 'POST').length, 0);
      assert.equal(f.requests.filter(request => request.path === '/gsi/client').length, 0, 'Cached server login does not load the provider SDK');
      assert.equal(await f.page.locator('input[value="account:manage"]').isChecked(), false);
      await f.page.locator('#allow').click(); await f.page.waitForSelector('#returned');
      const approved = new URLSearchParams(f.requests.find(request => request.path === '/oauth/authorize' && request.method === 'POST').body);
      assert.equal(approved.get('credential'), ''); assert.equal(approved.get('decision'), 'allow'); assert.equal(approved.get('handle'), 'browser-nonce'); assert.deepEqual(approved.getAll('scope'), ['account:read', 'offline_access']);
    } finally { await f.close(); }
  }
  console.log('Connector: Google account remains untrusted until server verification...');
  {
    const f = await fixture({ exchange: 'held' });
    try {
      await f.page.goto(origin + '/oauth/authorize'); await f.page.waitForSelector('.test-gsi');
      assert.equal(await f.page.evaluate(() => window.gsiOptions.nonce), 'browser-nonce');
      await f.page.locator('.test-gsi').click(); await f.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Verifying'));
      assert(await f.page.locator('#allow').isDisabled()); assert.equal(await f.page.locator('#identity:not([hidden])').count(), 0);
      f.release(); await f.page.waitForSelector('#identity:not([hidden])'); assert(await f.page.locator('#allow').isEnabled());
      assert.equal(await f.page.evaluate(() => document.querySelector('#credential').value), '');
      assert.ok(!(await f.page.evaluate(() => JSON.stringify({ ...localStorage }))).includes('signed-provider-credential'));
      assert.equal(f.requests.filter(request => request.path === '/oauth/authorize' && request.method === 'POST').length, 0);
    } finally { await f.close(); }
  }
  console.log('Connector: management remembers sign-in, clears identity on logout, and fits narrow screens...');
  {
    const f = await fixture({ user: github, mode: 'connect', width: 320 });
    try {
      await f.page.goto(origin + '/connect'); await f.page.waitForSelector('.grant'); assert.match(await f.page.locator('.grant').innerText(), /GitHub Tool/);
      const dimensions = await f.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
      await f.page.locator('.change-account').click(); await f.page.waitForSelector('.test-gsi'); assert.equal(await f.page.locator('.grant').count(), 0); assert(await f.page.locator('#identity').isHidden());
      await f.page.locator('.test-gsi').click(); await f.page.waitForSelector('.grant'); assert.match(await f.page.locator('.grant').innerText(), /Google Tool/);
      const secret = await f.page.evaluate(() => localStorage.getItem('th_google_session')); assert.equal(secret, null);
    } finally { await f.close(); }
  }
  console.log('Connector: GitHub preserves the client authorization transaction on return...');
  {
    const f = await fixture();
    try {
      const query = '?client_id=test-client&state=opaque-client-state&scope=account%3Aread&redirect_uri=http%3A%2F%2Flocalhost%3A4567%2Fcallback&auth=success';
      await f.page.goto(origin + '/oauth/authorize' + query); await f.page.waitForSelector('.test-gsi');
      await f.page.locator('#github-signin').click(); await f.page.waitForSelector('#github-start');
      const target = new URL(f.page.url()), returned = new URL(target.searchParams.get('returnTo'), origin);
      assert.equal(returned.pathname, '/oauth/authorize'); assert.equal(returned.searchParams.get('state'), 'opaque-client-state'); assert.equal(returned.searchParams.get('redirect_uri'), 'http://localhost:4567/callback'); assert.equal(returned.searchParams.get('auth'), null);
    } finally { await f.close(); }
  }
  console.log('Connector: stale session and grant reads cannot replace a switched account...');
  for (const held of ['session', 'connections']) {
    const f = await fixture({ user: google, mode: 'connect', holdFirstSession: held === 'session', holdFirstConnections: held === 'connections' });
    try {
      await f.page.goto(origin + '/connect');
      await f.page.waitForFunction(path => window.performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === path) || document.querySelector('#identity')?.textContent.includes('Aurora'), held === 'session' ? '/connect.js' : '/oauth/connections');
      if (held === 'connections') await f.page.waitForSelector('#identity:not([hidden])');
      f.setUser(github);
      const priorGrants = await f.page.evaluate(value => { localStorage.setItem('th_auth_hint', JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key: 'th_auth_hint', newValue: JSON.stringify(value) })); return document.querySelectorAll('.grant').length; }, github);
      assert.equal(priorGrants, 0, 'Prior grants clear before verifying another identity');
      await f.page.waitForSelector('.grant'); assert.match(await f.page.locator('.grant').innerText(), /GitHub Tool/);
      (held === 'session' ? f.releaseSession : f.releaseConnections)();
      await f.page.waitForTimeout(150);
      assert.match(await f.page.locator('#identity').innerText(), /Orbit Builder/);
      assert.match(await f.page.locator('.grant').innerText(), /GitHub Tool/);
      assert.equal(f.requests.filter(request => request.path === '/oauth/authorize' && request.method === 'POST').length, 0);
    } finally { await f.close(); }
  }
  console.log('Connector: provider memory guides the chooser and logout disables silent Google selection...');
  for (const remembered of [github, google]) {
    const f = await fixture({ remembered });
    try {
      await f.page.goto(origin + '/oauth/authorize'); await f.page.waitForSelector('.test-gsi');
      const settings = await f.page.evaluate(() => ({ auto: window.gsiOptions.auto_select, hint: window.gsiOptions.login_hint, prompts: window.gsiPrompts || 0 }));
      assert.equal(settings.auto, remembered.provider === 'google');
      assert.equal(settings.hint, remembered.provider === 'google' ? remembered.email : undefined);
      assert.equal(settings.prompts > 0, remembered.provider === 'google');
      await f.page.locator('.test-gsi').click(); await f.page.waitForSelector('#identity:not([hidden])');
      await f.page.locator('.change-account').click(); await f.page.waitForSelector('.test-gsi');
      const latest = await f.page.evaluate(() => window.gsiInitializations.at(-1));
      assert.equal(latest.auto_select, false); assert.equal(latest.button_auto_select, false); assert.equal(latest.login_hint, undefined);
      assert.equal(await f.page.locator('#allow').isEnabled(), false, 'Logout cannot retain permission approval');
    } finally { await f.close(); }
  }
  console.log('Connector: equivalent cached identity hints do not cause cross-tab refresh loops...');
  {
    const dashboardHint = { provider: google.provider, sub: google.sub, email: google.email, name: google.name, picture: google.picture, login: '' };
    const f = await fixture({ user: google, mode: 'connect', remembered: dashboardHint });
    try {
      await f.page.goto(origin + '/connect'); await f.page.waitForSelector('.grant');
      assert.equal(await f.page.evaluate(() => window.authHintWrites), 0, 'Hydration must preserve an equivalent dashboard-format hint');
      assert.equal(await f.page.evaluate(() => localStorage.getItem('th_auth_hint')), JSON.stringify(dashboardHint));
      const other = await f.context.newPage();
      await other.route('**/*', route => { assert.equal(new URL(route.request().url()).origin, origin); return route.fulfill({ contentType: 'text/html', body: '<main>Other account surface</main>' }); });
      await other.goto(origin + '/fixture-observer');
      await other.evaluate(() => { window.identityEvents = 0; addEventListener('storage', event => { if (event.key === 'th_auth_hint') ++window.identityEvents; }); });
      const verified = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
      // This genuine second-tab write changes serialization, but not identity.
      await other.evaluate(value => localStorage.setItem('th_auth_hint', JSON.stringify(value)), google);
      await verified; await f.page.waitForSelector('.grant'); await f.page.waitForTimeout(150);
      assert.equal(await f.page.evaluate(() => window.authHintWrites), 0, 'Verification must not bounce the same identity into localStorage');
      assert.equal(await other.evaluate(() => window.identityEvents), 0, 'The second tab must not receive a redundant hint write');
      assert.equal(f.requests.filter(request => request.path === '/api/auth/session').length, 2, 'One storage change causes only one additional verification');
      assert.equal(f.requests.filter(request => request.path === '/oauth/connections').length, 2, 'Grant reads must settle after the second verification');
    } finally { await f.close(); }
  }
  console.log('Connector browser checks passed.');
} finally { await browser.close(); }
