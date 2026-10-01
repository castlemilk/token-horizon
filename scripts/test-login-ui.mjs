import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Every browser request is intercepted. This exercises the real login UI and
// session controller without Chrome account access, production, OAuth, or a
// real cookie/credential. Provider callbacks use intentionally unsigned JWTs.
const ORIGIN = 'https://token-horizon.dev';
const docsRoot = path.resolve('docs');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const photo = 'https://avatars.githubusercontent.com/u/42?v=4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const googleUser = { provider: 'google', sub: 'google-fixture', name: 'Aurora Builder', email: 'aurora@example.com', picture: photo };
const githubUser = { provider: 'github', sub: '42', name: 'Orbit Builder', email: 'orbit@example.com', picture: photo, login: 'orbit-builder' };
const publicConfig = { ok: true, googleClientId: 'test-login.apps.googleusercontent.com', googleAuth: true, githubAuth: true, webSessions: true, canonicalUrl: ORIGIN };
const credential = 'test.' + Buffer.from(JSON.stringify({ ...googleUser, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.unsigned';
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ config = 'ready', sdk = 'ready', session = 'ready', exchange = 'ready', account = 'ready', user = null, remembered = null, cachedConfig = null, entryPatch = {}, width = 1440, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion });
  await context.addInitScript(({ remembered, cachedConfig }) => {
    const fetchNative = window.fetch.bind(window);
    window.testAuthFetches = [];
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/account/')) window.testAuthFetches.push({ path: url.pathname, cache: options.cache, credentials: options.credentials });
      return fetchNative(input, options);
    };
    const setStorageItem = Storage.prototype.setItem;
    window.testAuthHintWrites = [];
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === 'th_auth_hint') window.testAuthHintWrites.push(value);
      return setStorageItem.call(this, key, value);
    };
    // Seed once; reloads must exercise persisted mutations rather than restoring
    // the initial fake identity after sign out.
    if (sessionStorage.getItem('login-fixture-seeded')) return;
    sessionStorage.setItem('login-fixture-seeded', '1');
    if (remembered) localStorage.setItem('th_auth_hint', JSON.stringify(remembered));
    if (cachedConfig) localStorage.setItem('th_auth_config', JSON.stringify(cachedConfig));
    window.testAuthHintWrites.length = 0;
  }, { remembered, cachedConfig });
  if (user) await context.addCookies([{ name: '__Host-th-session', value: 'fixture-opaque-cookie', domain: 'token-horizon.dev', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [], requests = [], unexpected = [];
  const waits = new Map();
  const released = new Set();
  const hold = name => {
    if (released.has(name)) return Promise.resolve();
    if (!waits.has(name)) {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      waits.set(name, { promise, release });
    }
    return waits.get(name).promise;
  };
  let configState = config, sessionState = session, exchangeState = exchange, accountState = account, currentUser = user, sdkState = sdk;
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
  const auth = (subject = currentUser) => ({ ok: true, authenticated: Boolean(subject), user: subject, expiresAt: subject ? Date.now() + 30 * 86400000 : undefined });
  await page.route('https://accounts.google.com/**', async route => {
    requests.push({ path: 'google-sdk', url: route.request().url() });
    if (sdkState === 'error') return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(options){window.testGoogleOptions=options;window.testGoogleCallback=options.callback},renderButton(host,options){window.testGoogleButtons=(window.testGoogleButtons||[]).concat(options);const button=document.createElement('button');button.textContent='Continue with test Google';button.className='fixture-google';button.style.width=options.width+'px';button.onclick=()=>window.testGoogleCallback({credential:${JSON.stringify(credential)}});host.append(button)},prompt(){window.testGooglePrompted=(window.testGooglePrompted||0)+1},cancel(){window.testGoogleCancelled=true},disableAutoSelect(){window.testGoogleDisabled=true}}}};` });
  });
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.route(ORIGIN + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const item = { path: url.pathname, url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() ? request.postDataJSON() : null };
    requests.push(item);
    if (url.pathname === '/api/config') {
      if (configState === 'held') await hold('config');
      if (configState === 'error') return json(route, { ok: false, error: 'Configuration temporarily unavailable.' }, 503);
      return json(route, publicConfig);
    }
    if (url.pathname === '/api/auth/session') {
      const reader = currentUser;
      if (sessionState === 'held') await hold('session');
      if (sessionState === 'error') return json(route, { ok: false, error: 'Session temporarily unavailable.' }, 503);
      return json(route, auth(reader));
    }
    if (url.pathname === '/api/auth/google') {
      if (exchangeState === 'held') await hold('exchange');
      if (exchangeState === 'error') return json(route, { ok: false, error: 'The Google account could not be verified.' }, 401);
      currentUser = googleUser;
      await context.addCookies([{ name: '__Host-th-session', value: 'fixture-new-opaque-cookie', domain: 'token-horizon.dev', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      return json(route, auth());
    }
    if (url.pathname === '/api/auth/logout') {
      currentUser = null;
      await context.clearCookies();
      return json(route, auth());
    }
    if (url.pathname === '/api/auth/github') return route.fulfill({ status: 200, contentType: 'text/html', body: '<main id="fixture-github-start">GitHub authorization intercepted</main>' });
    if (url.pathname === '/api/account/profiles') {
      const reader = currentUser;
      if (accountState === 'held') await hold('account');
      return reader
        ? json(route, { ok: true, profiles: [{ handle: reader.provider === 'github' ? 'orbit-builder' : 'aurora', displayName: reader.name }] })
        : json(route, { ok: false, error: 'Sign in required.', code: 'auth_required' }, 401);
    }
    if (url.pathname.startsWith('/api/user/')) {
      const handle = url.pathname.split('/').at(-1);
      return json(route, { ok: true, handle, entry: { id: 'fixture:' + handle, handle, tokensAll: 42000, tokens7d: 12000, tokensToday: 3000, updatedAt: Date.now() / 1000, requestsAll: 12, breakdown: { models: [], projects: [], sessions: [], daily: [], modelHistory: [] }, ...entryPatch } });
    }
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: null, invites: [] });
    if (url.pathname === '/api/share/list') return json(route, { ok: true, shares: [], groups: [], activity: [] });
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname === '/api/models/catalog') return json(route, { schemaVersion: 1, count: 0, providers: [], models: [] });
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/')) return json(route, { ok: false, error: 'Fixture endpoint not found.' }, 404);
    const relative = ['/login', '/leaderboard', '/models'].includes(url.pathname) || url.pathname.startsWith('/u/') ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route(/https?:\/\/(?!token-horizon\.dev\/|accounts\.google\.com\/|avatars\.githubusercontent\.com\/).*/, route => { unexpected.push(route.request().url()); return route.abort(); });
  return {
    page, context, errors, requests,
    recover(name) { if (name === 'config') configState = 'ready'; if (name === 'session') sessionState = 'ready'; if (name === 'exchange') exchangeState = 'ready'; if (name === 'account') accountState = 'ready'; if (name === 'sdk') sdkState = 'ready'; released.add(name); waits.get(name)?.release(); },
    setUser(next) { currentUser = next; },
    async close() { for (const [name, wait] of waits) { released.add(name); wait.release(); } await context.close(); assert.deepEqual(errors, [], 'Login must not throw browser errors'); assert.deepEqual(unexpected, [], 'Regression fixtures must not contact other services'); }
  };
}

async function openLogin(page, suffix = '') {
  await page.goto(ORIGIN + '/login' + suffix, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-page');
}

async function openModal(page) {
  await page.goto(ORIGIN + '/leaderboard', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#signin-btn');
  await page.locator('#signin-btn').click();
  await page.waitForSelector('.signin-modal');
}

async function assertNoOverflow(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert(box, selector + ' must be visible');
  const dimensions = await page.evaluate(selector => {
    const node = document.querySelector(selector);
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, width: node.clientWidth, content: node.scrollWidth };
  }, selector);
  assert(dimensions.document <= dimensions.viewport + 1 && dimensions.content <= dimensions.width + 1, selector + ' overflows: ' + JSON.stringify(dimensions));
}

try {
  console.log('Login surfaces: shared providers, accessible modal focus, bounded black-hole animation and small screens...');
  for (const surface of ['page', 'modal']) {
    const f = await fixture();
    try {
      if (surface === 'page') await openLogin(f.page);
      else await openModal(f.page);
      const selector = surface === 'page' ? '#login-page' : '.signin-modal';
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert.equal(await f.page.locator('#signin-github').count(), 1, 'Both surfaces offer GitHub');
      assert.equal(await f.page.locator('#signin-dev').count(), 0, 'A configured deployment cannot expose unverified dev login');
      assert.doesNotMatch(await f.page.locator(selector).innerText(), /undefined|NaN|TokenArena/);
      if (surface === 'page') {
        await f.page.locator('#signin-btn').click();
        assert.equal(await f.page.locator('.signin-modal').count(), 0, 'The login header should focus the existing chooser');
        assert.equal(await f.page.locator('#signin-gsi').count(), 1, 'A login page cannot create duplicate auth hosts');
      }
      await assertNoOverflow(f.page, selector);
      const options = await f.page.evaluate(() => window.testGoogleOptions && ({ clientId: window.testGoogleOptions.client_id, autoSelect: window.testGoogleOptions.auto_select, fedcmPrompt: window.testGoogleOptions.use_fedcm_for_prompt, fedcmButton: window.testGoogleOptions.use_fedcm_for_button }));
      assert.equal(options.clientId, publicConfig.googleClientId);
      assert.equal(options.autoSelect, true, 'Eligible browser accounts can reuse a prior provider grant');
      assert(options.fedcmPrompt || options.fedcmButton, 'Google uses the browser-supported account chooser');
      if (surface === 'modal') {
        const semantics = await f.page.locator('.signin-modal').evaluate(node => ({ role: node.getAttribute('role'), modal: node.getAttribute('aria-modal'), label: node.getAttribute('aria-labelledby'), locked: document.body.style.overflow, focus: node.contains(document.activeElement) }));
        assert.equal(semantics.role, 'dialog'); assert.equal(semantics.modal, 'true');
        assert(semantics.label && await f.page.locator('#' + semantics.label).count());
        assert.equal(semantics.locked, 'hidden'); assert.equal(semantics.focus, true);
        for (let i = 0; i < 10; i++) {
          await f.page.keyboard.press('Tab');
          assert(await f.page.locator('.signin-modal').evaluate(node => node.contains(document.activeElement)), 'Tab escaped sign-in');
        }
        for (let i = 0; i < 8; i++) {
          await f.page.keyboard.press('Shift+Tab');
          assert(await f.page.locator('.signin-modal').evaluate(node => node.contains(document.activeElement)), 'Reverse Tab escaped sign-in');
        }
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('.signin-modal').count(), 0);
        assert.equal(await f.page.evaluate(() => document.body.style.overflow), '');
        assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'signin-btn', 'Closing restores focus to the opener');
        await f.page.locator('#signin-btn').click();
      }
      for (const width of [390, 320]) {
        await f.page.setViewportSize({ width, height: 844 });
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertNoOverflow(f.page, selector);
        assert(await f.page.locator('#signin-github').isVisible());
        assert(await f.page.locator('#signin-gsi-btn .fixture-google').isVisible());
        const button = await f.page.locator('#signin-gsi-btn .fixture-google').boundingBox();
        const host = await f.page.locator('#signin-gsi-btn').boundingBox();
        assert(button.width <= host.width + 1, 'Google account button must resize rather than clip at ' + width + 'px');
      }
    } finally { await f.close(); }
  }

  console.log('Login animation: motion changes stop the ASCII renderer without hiding sign-in...');
  {
    const f = await fixture();
    try {
      await openModal(f.page);
      await f.page.waitForFunction(() => document.querySelector('.bh-art')?.textContent.replace(/\s/g, '').length > 100);
      const first = await f.page.locator('.bh-art').innerText();
      await f.page.waitForFunction(text => document.querySelector('.bh-art')?.textContent !== text, first, { timeout: 3000 });
      await f.page.locator('[data-auth-motion]').click();
      assert.equal(await f.page.locator('[data-auth-motion]').getAttribute('aria-pressed'), 'true');
      const paused = await f.page.locator('.bh-art').innerText();
      await f.page.waitForTimeout(300);
      assert.equal(await f.page.locator('.bh-art').innerText(), paused, 'Pause stops the renderer');
      await f.page.locator('[data-auth-motion]').click();
      await f.page.waitForFunction(text => document.querySelector('.bh-art')?.textContent !== text, paused, { timeout: 3000 });
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const reduced = await f.page.locator('.bh-art').innerText();
      await f.page.waitForTimeout(300);
      assert.equal(await f.page.locator('.bh-art').innerText(), reduced, 'Changing the OS motion preference stops an already-mounted renderer');
      await f.page.evaluate(() => { window.testDetachedArt = document.querySelector('.bh-art'); });
      await f.page.keyboard.press('Escape');
      await f.page.waitForTimeout(300);
      assert.equal(await f.page.evaluate(() => window.testDetachedArt.textContent), reduced, 'A closed modal cannot continue rendering into a detached node');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      await openLogin(f.page);
      await f.page.waitForFunction(() => document.querySelector('.bh-art')?.textContent.replace(/\s/g, '').length > 100);
      const still = await f.page.locator('.bh-art').innerText();
      await f.page.waitForTimeout(400);
      assert.equal(await f.page.locator('.bh-art').innerText(), still, 'Reduced-motion art must stay still');
      assert.equal(await f.page.locator('.bh-art').getAttribute('aria-hidden'), 'true');
      const transitions = await f.page.locator('#login-page').evaluate(node => [...node.querySelectorAll('*')].filter(el => getComputedStyle(el).animationName !== 'none').map(el => ({ name: getComputedStyle(el).animationName, duration: parseFloat(getComputedStyle(el).animationDuration) })));
      assert(transitions.every(animation => animation.duration <= .001), 'Reduced-motion login CSS retains a visible animation');
    } finally { await f.close(); }
  }

  console.log('Login verification: unsigned provider callback does not become a trusted session before the server accepts it...');
  {
    const f = await fixture({ exchange: 'held' });
    try {
      await openModal(f.page);
      const requestSeen = f.page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/google');
      await f.page.locator('#signin-gsi-btn .fixture-google').click();
      await requestSeen;
      await f.page.waitForSelector('#signin-gsi .auth-provider-skeleton');
      assert.match(await f.page.locator('#signin-gsi .auth-provider-skeleton').innerText(), /Verifying/i);
      assert.equal(await f.page.locator('.user-chip').count(), 0, 'Locally decoded ID data cannot authenticate');
      const exchanges = f.requests.filter(row => row.path === '/api/auth/google');
      assert.equal(exchanges.length, 1); assert.deepEqual(exchanges[0].body, { credential });
      assert.equal(exchanges[0].headers['x-google-token'], undefined);
      await f.page.evaluate(value => { handleGoogleCredential({ credential: value }); }, credential);
      await f.page.waitForTimeout(100);
      assert.equal(f.requests.filter(row => row.path === '/api/auth/google').length, 1, 'A duplicate provider callback cannot launch a second cookie exchange');
      const pendingStorage = await f.page.evaluate(() => JSON.stringify({ ...localStorage }));
      assert(!pendingStorage.includes(credential), 'Provider ID tokens cannot be cached');
      f.recover('exchange');
      await f.page.waitForSelector('.user-chip');
      assert.match(await f.page.locator('.user-chip').innerText(), /Aurora Builder/);
      assert.equal(await f.page.locator('.signin-modal').count(), 0);
      await f.page.waitForFunction(() => !state.authBusy);
      assert.equal(await f.page.locator('#user-chip').isEnabled(), true, 'A completed Google exchange must unlock the account controls');
      await f.page.locator('#user-chip').click();
      await f.page.waitForSelector('#account-menu:not([hidden])');
      assert.equal(await f.page.locator('#user-chip').getAttribute('aria-expanded'), 'true');
      await f.page.locator('#user-chip').click();
      assert.equal(await f.page.locator('#user-chip').getAttribute('aria-expanded'), 'false');
      const storage = await f.page.evaluate(() => ({ hint: JSON.parse(localStorage.getItem('th_auth_hint') || 'null'), raw: JSON.stringify({ ...localStorage }), legacy: localStorage.getItem('th_google_session'), cookie: document.cookie }));
      assert.equal(storage.hint?.email, googleUser.email);
      assert.equal(storage.legacy, null);
      assert(!storage.raw.includes(credential) && !storage.raw.includes('fixture-new-opaque-cookie'));
      assert(!storage.cookie.includes('__Host-th-session'), 'Remembered session remains HttpOnly');
      await f.page.evaluate(() => api('/api/account/profiles', { headers: googleHeaders() }));
      const account = f.requests.filter(row => row.path === '/api/account/profiles').at(-1);
      assert.equal(account.headers['x-google-token'], undefined, 'Server session auth must not leak a legacy provider token');
      assert.match(account.headers.cookie || '', /__Host-th-session=fixture-new-opaque-cookie/);
      const reads = await f.page.evaluate(() => window.testAuthFetches);
      assert(reads.every(read => read.cache === 'no-store'), 'Session and private account requests must never enter the browser cache');
      assert(reads.every(read => read.credentials === 'same-origin'), 'Cookie credentials stay scoped to the application origin');
    } finally { await f.close(); }
  }

  console.log('Login failures: exchange rejection leaves the user signed out with an actionable message...');
  {
    const f = await fixture({ exchange: 'error' });
    try {
      await openModal(f.page);
      await f.page.locator('#signin-gsi-btn .fixture-google').click();
      await f.page.waitForFunction(() => document.querySelector('#signin-status')?.textContent.toLowerCase().includes('verif'));
      assert.equal(await f.page.locator('.user-chip').count(), 0);
      assert.equal(await f.page.locator('.signin-modal').count(), 1);
      assert.equal(await f.page.evaluate(() => localStorage.getItem('th_auth_hint')), null);
      f.recover('exchange');
      await f.page.locator('#signin-gsi-btn .fixture-google').click();
      await f.page.waitForSelector('.user-chip');
      assert.equal(f.requests.filter(row => row.path === '/api/auth/google').length, 2);
    } finally { await f.close(); }
  }

  console.log('Remembered identity: a cached Chrome/provider hint fills the chooser without authorizing an unverified account...');
  {
    // Connector hint field order differs from authHint(), and its empty login
    // field is omitted. Equivalent identity must not create storage events
    // that cause the two surfaces to revalidate one another indefinitely.
    const connectorHint = { provider: googleUser.provider, sub: googleUser.sub, name: googleUser.name, email: googleUser.email, picture: googleUser.picture };
    const f = await fixture({ user: googleUser, remembered: connectorHint });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('.user-chip');
      assert.deepEqual(await f.page.evaluate(() => window.testAuthHintWrites), [], 'Cookie hydration must not rewrite an equivalent connector hint');
      assert.equal(await f.page.evaluate(() => localStorage.getItem('th_auth_hint')), JSON.stringify(connectorHint));
      await f.page.evaluate(async () => { await hydrateAuthSession({ force: true }); await hydrateAuthSession({ force: true }); });
      assert.equal(f.requests.filter(row => row.path === '/api/auth/session').length, 3);
      assert.deepEqual(await f.page.evaluate(() => window.testAuthHintWrites), [], 'Repeated verification of unchanged identity must not notify other tabs');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ session: 'held', user: googleUser, remembered: googleUser });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert.equal(await f.page.locator('.user-chip').count(), 0, 'Cached display data must not assert a verified session');
      assert.match(await f.page.locator('#login-page').innerText(), /Aurora Builder|aurora@example\.com/, 'The remembered identity should make the next account choice familiar');
      assert.equal(await f.page.evaluate(() => window.testGoogleOptions.login_hint), googleUser.email);
      assert.equal(f.requests.some(row => row.path === '/api/account/profiles'), false, 'Hints cannot read private account data');
      assert.equal(await f.page.evaluate(() => window.testGooglePrompted || 0), 0, 'One Tap cannot replace an existing cookie identity while verification is pending');
      f.recover('session');
      await f.page.waitForSelector('.user-chip');
      assert.match(await f.page.locator('.user-chip').innerText(), /Aurora Builder/);
      assert.equal(f.requests.filter(row => row.path === '/api/auth/session').length, 1, 'Session hydration is deduplicated');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ remembered: googleUser });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert.equal(await f.page.locator('.user-chip').count(), 0, 'An expired/missing cookie cannot be restored from a hint');
      assert.equal(await f.page.evaluate(() => isGoogleSessionValid()), false);
      assert.equal(f.requests.some(row => row.path === '/api/account/profiles'), false);
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ remembered: githubUser });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      await f.page.waitForFunction(() => state.authStatus === 'ready');
      const options = await f.page.evaluate(() => ({ auto: window.testGoogleOptions.auto_select, button: window.testGoogleOptions.button_auto_select, hint: window.testGoogleOptions.login_hint, prompts: window.testGooglePrompted || 0 }));
      assert.equal(options.auto, false); assert.equal(options.button, false);
      assert.equal(options.hint, undefined); assert.equal(options.prompts, 0, 'A remembered GitHub preference cannot be replaced by an automatic Google prompt');
      assert.match(await f.page.locator('#signin-remembered').innerText(), /Orbit Builder/);
    } finally { await f.close(); }
  }

  console.log('Auth caching: fresh public configuration paints immediately, while stale/error configuration cannot expose dev login...');
  {
    const f = await fixture({ config: 'held', cachedConfig: { savedAt: Date.now(), config: publicConfig } });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google', { timeout: 2500 });
      assert(await f.page.locator('#signin-github').isVisible(), 'Cached public config makes both providers immediately usable');
      const before = f.requests.filter(row => row.path === '/api/config').length;
      assert(before <= 1, 'Fresh auth config must not spawn repeated network reads');
      f.recover('config');
      await f.page.waitForTimeout(100);
      const cached = await f.page.evaluate(() => JSON.parse(localStorage.getItem('th_auth_config') || 'null'));
      assert.equal(cached?.config?.googleClientId, publicConfig.googleClientId);
      assert(Date.now() - cached.savedAt < 5 * 60000);
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ config: 'error', cachedConfig: { savedAt: Date.now() - 6 * 60000, config: { ...publicConfig, googleClientId: '', githubAuth: false } } });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-config-retry');
      assert.equal(await f.page.locator('#signin-dev').count(), 0, 'A stale cache or configuration error must never activate the development fallback');
      assert.equal(await f.page.locator('.user-chip').count(), 0);
      f.recover('config');
      await f.page.locator('#signin-config-retry').click();
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert.equal(f.requests.filter(row => row.path === '/api/config').length, 2, 'A failed config read must be retried rather than reused from the GET cache');
    } finally { await f.close(); }
  }

  console.log('Provider availability: a blocked Google SDK remains retryable while GitHub and public browsing work...');
  {
    const f = await fixture({ sdk: 'error' });
    try {
      await openModal(f.page);
      await f.page.waitForFunction(() => { const button = document.querySelector('#signin-retry'); return button && !button.disabled; }, null, { timeout: 13000 });
      assert(await f.page.locator('#signin-github').isVisible());
      assert.match(await f.page.locator('#signin-status').innerText(), /unavailable|blocked|load|offline/i);
      f.recover('sdk');
      await f.page.locator('#signin-retry').click();
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert(f.requests.filter(row => row.path === 'google-sdk').length >= 2, 'Retry must reload the failed SDK');
      await f.page.keyboard.press('Escape');
      assert.equal(await f.page.locator('.signin-modal').count(), 0);
      assert.equal(await f.page.locator('#signin-btn').count(), 1);
    } finally { await f.close(); }
  }

  console.log('Sign out: cookie logout purges remembered/private state and suppresses provider auto-selection...');
  {
    const f = await fixture({ user: googleUser, remembered: googleUser });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('.user-chip');
      await f.page.evaluate(() => api('/api/account/profiles', { headers: googleHeaders() }));
      assert(f.requests.filter(row => row.path === '/api/account/profiles').length >= 1);
      await f.page.locator('#user-chip').click();
      await f.page.waitForSelector('#account-menu');
      await f.page.locator('#account-menu').getByRole('button', { name: 'Sign out', exact: true }).click();
      await f.page.waitForSelector('#signin-btn');
      assert.equal(f.requests.filter(row => row.path === '/api/auth/logout').length, 1);
      const storage = await f.page.evaluate(() => ({ hint: localStorage.getItem('th_auth_hint'), legacy: localStorage.getItem('th_google_session'), suppression: sessionStorage.getItem('th_auth_signed_out'), cache: localStorage.getItem('th_auth_config') }));
      assert.equal(storage.hint, null); assert.equal(storage.legacy, null);
      assert.equal(JSON.parse(storage.suppression), true); assert(storage.cache, 'Public config stays cached across sign out');
      assert.equal(await f.page.locator('.user-chip').count(), 0);
      const signedOutRead = await f.page.evaluate(async () => {
        try { return { result: await api('/api/account/profiles', { headers: googleHeaders() }) }; }
        catch (error) { return { error: error.message }; }
      });
      assert(signedOutRead.error && !signedOutRead.result, 'Sign out cannot return the previous account from an API cache');
      await f.page.reload({ waitUntil: 'domcontentloaded' });
      await f.page.waitForSelector('#signin-gsi-btn .fixture-google');
      assert.equal(await f.page.evaluate(() => window.testGoogleOptions.auto_select), false, 'Reload must respect deliberate sign out');
      assert.equal(await f.page.evaluate(() => window.testGoogleOptions.button_auto_select), false);
      assert.equal(await f.page.evaluate(() => window.testGooglePrompted || 0), 0, 'One Tap cannot immediately undo deliberate sign out');
    } finally { await f.close(); }
  }

  console.log('Session recovery: a failed identity check is retryable and cookie-only workspace hydration selects the verified owner...');
  {
    const f = await fixture({ session: 'error', user: googleUser, remembered: googleUser });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('#signin-session-retry');
      assert.equal(await f.page.locator('.user-chip').count(), 0);
      assert.equal(f.requests.some(row => row.path === '/api/account/profiles'), false);
      f.recover('session');
      await f.page.locator('#signin-session-retry').click();
      await f.page.waitForSelector('.user-chip');
      assert.equal(f.requests.filter(row => row.path === '/api/auth/session').length, 2);
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ session: 'held', user: githubUser });
    try {
      await f.page.goto(ORIGIN + '/leaderboard?view=dashboard', { waitUntil: 'domcontentloaded' });
      await f.page.waitForFunction(() => state.webSessions && state.authStatus === 'checking');
      assert.equal(f.requests.some(row => row.path === '/api/account/profiles'), false);
      f.recover('session');
      await f.page.waitForSelector('[data-tw-tab="overview"]');
      assert.equal(await f.page.locator('[data-tw-profile]').inputValue(), 'orbit-builder');
      assert.equal(f.requests.some(row => row.path === '/api/leaderboard'), false, 'Remembered workspace loading remains independent of the leaderboard');
      assert.equal(f.requests.filter(row => row.path === '/api/account/profiles').length, 1, 'Overlapping startup and session renders share the same owned-profile read');
    } finally { await f.close(); }
  }

  console.log('Provider isolation: Google/GitHub accounts sharing an email cannot receive one another’s late private responses or workspace cache...');
  {
    const f = await fixture({ session: 'held', user: googleUser, remembered: googleUser });
    try {
      await openLogin(f.page);
      await f.page.waitForFunction(() => state.authStatus === 'checking');
      f.setUser(githubUser);
      await f.page.evaluate(hint => {
        window.testHydratedNames = [];
        new MutationObserver(() => {
          const name = document.querySelector('#auth-slot .user-chip strong')?.textContent;
          if (name) window.testHydratedNames.push(name);
        }).observe(document.querySelector('#auth-slot'), { childList: true, subtree: true });
        localStorage.setItem('th_auth_hint', JSON.stringify(hint));
        window.dispatchEvent(new StorageEvent('storage', { key: 'th_auth_hint', newValue: JSON.stringify(hint), storageArea: localStorage }));
      }, githubUser);
      f.recover('session');
      await f.page.waitForFunction(() => state.googleSession?.provider === 'github');
      assert.equal(f.requests.filter(row => row.path === '/api/auth/session').length, 2, 'A cross-tab identity update must refresh after the older verification finishes');
      assert.match(await f.page.locator('.user-chip').innerText(), /Orbit Builder/);
      assert(!(await f.page.evaluate(() => window.testHydratedNames)).includes('Aurora Builder'), 'A superseded session cannot briefly hydrate the earlier account');
      // A later login in another tab can make Google eligible again; its
      // subsequent logout must revoke that eligibility in this tab too.
      f.setUser(googleUser);
      await f.page.evaluate(hint => {
        localStorage.setItem('th_auth_hint', JSON.stringify(hint));
        window.dispatchEvent(new StorageEvent('storage', { key: 'th_auth_hint', newValue: JSON.stringify(hint), storageArea: localStorage }));
      }, googleUser);
      await f.page.waitForFunction(() => state.googleSession?.provider === 'google' && window.testGoogleOptions?.auto_select === true);
      const prompts = await f.page.evaluate(() => window.testGooglePrompted || 0);
      f.setUser(null);
      await f.context.clearCookies();
      await f.page.evaluate(() => {
        localStorage.removeItem('th_auth_hint');
        window.dispatchEvent(new StorageEvent('storage', { key: 'th_auth_hint', newValue: null, storageArea: localStorage }));
      });
      await f.page.waitForFunction(() => state.authStatus === 'ready' && !state.googleSession);
      assert.equal(await f.page.locator('.user-chip').count(), 0, 'Another tab’s logout must clear this tab’s verified identity');
      const suppression = await f.page.evaluate(() => ({ signedOut: JSON.parse(sessionStorage.getItem('th_auth_signed_out') || 'null'), auto: window.testGoogleOptions.auto_select, button: window.testGoogleOptions.button_auto_select, hint: window.testGoogleOptions.login_hint, prompts: window.testGooglePrompted || 0 }));
      assert.equal(suppression.signedOut, true);
      assert.equal(suppression.auto, false); assert.equal(suppression.button, false);
      assert.equal(suppression.hint, undefined);
      assert.equal(suppression.prompts, prompts, 'A cross-tab logout must not reopen One Tap or silently sign back in');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ user: googleUser, account: 'held' });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('.user-chip');
      const requestSeen = f.page.waitForRequest(request => new URL(request.url()).pathname === '/api/account/profiles');
      await f.page.evaluate(() => {
        window.testOldAccountRead = api('/api/account/profiles', { headers: googleHeaders() }).then(result => ({ result })).catch(error => ({ error: error.message }));
      });
      await requestSeen;
      f.setUser({ ...githubUser, email: googleUser.email });
      await f.page.evaluate(() => { window.testNewSessionRead = hydrateAuthSession({ force: true }); });
      await f.page.waitForFunction(() => state.googleSession?.provider === 'github');
      f.recover('account');
      await f.page.evaluate(() => window.testNewSessionRead);
      const late = await f.page.evaluate(() => window.testOldAccountRead);
      assert(late.error && !late.result, 'A private response captured under Google must be rejected after switching to GitHub');
      await f.page.evaluate(() => navigate('dashboard'));
      await f.page.waitForSelector('[data-tw-tab="overview"]');
      assert.equal(await f.page.locator('[data-tw-profile]').inputValue(), 'orbit-builder');
      assert.equal(await f.page.locator('[data-tw-profile] option[value="aurora"]').count(), 0);
      assert.match(await f.page.locator('.user-chip').innerText(), /GitHub/);
    } finally { await f.close(); }
  }

  console.log('GitHub: an intentional gated action carries a bounded, relative return path instead of an arbitrary redirect...');
  {
    const f = await fixture();
    try {
      await f.page.goto(ORIGIN + '/leaderboard?view=settings', { waitUntil: 'domcontentloaded' });
      await f.page.waitForSelector('#new-group-btn');
      await f.page.locator('#new-group-btn').click();
      await f.page.waitForSelector('.signin-modal');
      await f.page.locator('#signin-github').click();
      await f.page.waitForSelector('#fixture-github-start');
      const start = f.requests.find(row => row.path === '/api/auth/github');
      assert(start && start.method === 'GET');
      const returnTo = new URL(start.url).searchParams.get('returnTo');
      assert(returnTo?.startsWith('/') && !returnTo.startsWith('//'));
      assert.equal(new URL(returnTo, ORIGIN).origin, ORIGIN);
      assert(!returnTo.includes('signin=') && !returnTo.includes('auth='));
      const pending = await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('th_auth_return') || 'null'));
      assert.equal(pending?.resume?.type, 'group');
      assert.equal(pending.path, returnTo);
      assert(Date.now() - pending.at < 10000);
      assert(!JSON.stringify(pending).includes(credential));
    } finally { await f.close(); }
  }
  for (const returnTo of ['https://untrusted.invalid/steal', '//untrusted.invalid/steal', '/\\untrusted.invalid/steal']) {
    const f = await fixture();
    try {
      await openLogin(f.page, '?returnTo=' + encodeURIComponent(returnTo));
      await f.page.locator('#signin-github').click();
      await f.page.waitForSelector('#fixture-github-start');
      const actual = new URL(f.requests.find(row => row.path === '/api/auth/github').url).searchParams.get('returnTo');
      assert(actual?.startsWith('/') && !actual.startsWith('//'), 'GitHub destination must be a safe app path');
      assert.equal(new URL(actual, ORIGIN).origin, ORIGIN, 'The login page cannot relay a cross-site redirect');
    } finally { await f.close(); }
  }

  console.log('GitHub callback: only the verified provider session can resume the intended UI once...');
  {
    const f = await fixture({ user: githubUser });
    try {
      await f.context.addInitScript(pending => {
        if (sessionStorage.getItem('login-return-seeded')) return;
        sessionStorage.setItem('login-return-seeded', '1');
        sessionStorage.setItem('th_auth_return', JSON.stringify(pending));
      }, { at: Date.now(), path: '/leaderboard?view=settings', resume: { type: 'group' } });
      await f.page.goto(ORIGIN + '/leaderboard?view=settings&auth=success', { waitUntil: 'domcontentloaded' });
      await f.page.waitForSelector('#group-name');
      assert.match(await f.page.locator('.user-chip').innerText(), /Orbit Builder/);
      assert.match(await f.page.locator('.user-chip').innerText(), /GitHub/i);
      assert.equal(await f.page.evaluate(() => sessionStorage.getItem('th_auth_return')), null, 'A resumed action must be consumed');
      assert.equal(new URL(f.page.url()).searchParams.has('auth'), false, 'Provider callback markers must not persist in shareable links');
      await f.page.locator('#modal-backdrop [data-close]').first().click();
      await f.page.reload({ waitUntil: 'domcontentloaded' });
      await f.page.waitForSelector('#new-group-btn');
      assert.equal(await f.page.locator('#group-name').count(), 0);
      assert.equal(f.requests.filter(row => row.path === '/api/auth/google').length, 0);
    } finally { await f.close(); }
  }
  for (const pending of [
    { at: Date.now() - 11 * 60000, path: '/leaderboard?view=settings', resume: { type: 'group' } },
    { at: Date.now(), path: '/leaderboard?view=teams', resume: { type: 'group' } },
    { at: Date.now(), path: '/leaderboard?view=settings', resume: { type: 'javascript', code: 'window.testUnsafeResume=true' } }
  ]) {
    const f = await fixture({ user: githubUser });
    try {
      await f.context.addInitScript(value => sessionStorage.setItem('th_auth_return', JSON.stringify(value)), pending);
      await f.page.goto(ORIGIN + '/leaderboard?view=settings&auth=success', { waitUntil: 'domcontentloaded' });
      await f.page.waitForSelector('.user-chip');
      await f.page.waitForSelector('#new-group-btn');
      assert.equal(await f.page.locator('#group-name').count(), 0, 'Expired, unrelated, and arbitrary actions cannot resume');
      assert.equal(await f.page.evaluate(() => window.testUnsafeResume), undefined);
    } finally { await f.close(); }
  }

  console.log('GitHub management: verified identity claims without an email form; public email matching never grants avatar ownership...');
  {
    const f = await fixture({ user: githubUser, entryPatch: { claimed: true, googleEmail: githubUser.email, googleSub: githubUser.sub } });
    try {
      await openLogin(f.page);
      await f.page.waitForSelector('.user-chip');
      await f.page.evaluate(() => openClaimModal('aurora'));
      await f.page.waitForSelector('#claim-submit');
      assert.equal(await f.page.locator('#claim-email').count(), 0, 'A cookie-verified GitHub account must not be downgraded to email-only identity');
      assert.match(await f.page.locator('#modal-backdrop').innerText(), /Orbit Builder/);
      assert.doesNotMatch(await f.page.locator('#modal-backdrop').innerText(), /Sign in with Google|Google account/);
      await f.page.locator('#modal-backdrop [data-close]').first().click();
      await f.page.evaluate(() => navigate('players', { handle: 'aurora' }));
      await f.page.waitForSelector('#profile-shell');
      await f.page.waitForFunction(() => workspaceAccount?.profiles?.length > 0);
      assert.equal(await f.page.locator('[data-edit-avatar="aurora"]').count(), 0, 'Sharing an email or raw sub with another provider does not make a user the profile owner');
      await f.page.evaluate(() => navigate('players', { handle: 'orbit-builder' }));
      await f.page.waitForSelector('[data-edit-avatar="orbit-builder"]');
      assert.equal(f.requests.some(row => row.path === '/api/claim' || row.path === '/api/profile/avatar'), false, 'Viewing owner controls cannot mutate profiles');
    } finally { await f.close(); }
  }

  console.log('In-page Google actions: verification resumes once and closing sign-in cancels the original action...');
  {
    const f = await fixture();
    try {
      await openModal(f.page);
      await f.page.keyboard.press('Escape');
      await f.page.evaluate(() => {
        window.testResumed = 0;
        requireSignIn({ action: 'Testing an intentional action', onSuccess: () => { window.testResumed++; } });
      });
      await f.page.locator('#signin-gsi-btn .fixture-google').click();
      await f.page.waitForFunction(() => window.testResumed === 1);
      assert.equal(await f.page.locator('.signin-modal').count(), 0);
      await f.page.evaluate(() => completeSignIn());
      await f.page.waitForTimeout(100);
      assert.equal(await f.page.evaluate(() => window.testResumed), 1);
    } finally { await f.close(); }
  }
  {
    const f = await fixture();
    try {
      await openModal(f.page);
      await f.page.keyboard.press('Escape');
      await f.page.evaluate(() => {
        window.testResumed = 0;
        requireSignIn({ action: 'Testing a cancelled action', onSuccess: () => { window.testResumed++; } });
      });
      await f.page.keyboard.press('Escape');
      await f.page.locator('#signin-btn').click();
      await f.page.locator('#signin-gsi-btn .fixture-google').click();
      await f.page.waitForSelector('.user-chip');
      await f.page.waitForTimeout(100);
      assert.equal(await f.page.evaluate(() => window.testResumed), 0, 'A later sign-in must not activate a cancelled action');
    } finally { await f.close(); }
  }

  console.log('Login regression passed.');
} finally { await browser.close(); }
