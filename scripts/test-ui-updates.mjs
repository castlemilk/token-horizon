import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Fully intercepted fixtures: the release notice never reads a real account,
// contacts production, or executes the HTML returned by its public check.
const ORIGIN = 'https://token-horizon.dev';
const root = path.resolve('docs');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const scriptV1 = 'window.fixtureShellBuild = "v1";';
const scriptV2 = 'window.fixtureShellBuild = "v2"; fetch("/api/private-write", {method:"POST"});';
const user = { provider: 'google', sub: 'update-fixture', name: 'Release Builder', email: 'release@example.com', picture: '' };
const credential = 'fixture.' + Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.unsigned';
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

function simpleDocument(script = scriptV1, cssVersion = '1') {
  return `<!doctype html><html><head><meta charset="utf-8"><style id="token-horizon-shell-styles">body{font-family:sans-serif}</style><link rel="stylesheet" data-ui-style href="./auth.css?v=${cssVersion}"></head><body><main><input id="draft" aria-label="Unsaved draft"><button id="fixture-signin">Sign in</button><div id="fixture-auth"></div></main><div id="modal-backdrop"></div><script id="token-horizon-shell">${script}</script><script src="./ui-updates.js?v=fixture" defer></script></body></html>`;
}

async function fixture({ full = false, mode = 'same', heldBody = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: '__Host-th-session', value: 'opaque-private-fixture', domain: 'token-horizon.dev', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ heldBody, mode }) => {
    const fetchNative = window.fetch.bind(window), nowNative = Date.now.bind(Date);
    const intervalNative = window.setInterval.bind(window), clearIntervalNative = window.clearInterval.bind(window);
    window.fixtureReleaseIntervals = new Set();
    window.setInterval = (callback, milliseconds, ...args) => {
      const id = intervalNative(callback, milliseconds, ...args);
      if (milliseconds === 300000) window.fixtureReleaseIntervals.add(id);
      return id;
    };
    window.clearInterval = id => { window.fixtureReleaseIntervals.delete(id); clearIntervalNative(id); };
    window.fixtureClockOffset = 0;
    Date.now = () => nowNative() + window.fixtureClockOffset;
    window.fixtureHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fixtureHidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.fixtureHidden ? 'hidden' : 'visible' });
    window.fixtureUpdateFetches = [];
    window.fixtureBodyAbort = false;
    window.fixtureNotModified = false;
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === '/leaderboard.html') {
        const record = { url: url.href, method: options.method || 'GET', credentials: options.credentials, cache: options.cache, headers: Object.fromEntries(new Headers(options.headers || {})), bounded: Boolean(options.signal), aborted: false };
        window.fixtureUpdateFetches.push(record);
        options.signal?.addEventListener('abort', () => { record.aborted = true; }, { once: true });
        if (['header-oversized', 'non-html', 'http-error'].includes(mode)) return Promise.resolve(new Response('Unused public body', { status: mode === 'http-error' ? 503 : 200, headers: { 'Content-Type': mode === 'non-html' ? 'application/json' : 'text/html', ...(mode === 'header-oversized' ? { 'Content-Length': String(2 * 1024 * 1024) } : {}) } }));
        if (window.fixtureNotModified) return Promise.resolve(new Response(null, { status: 304, headers: { ETag: '"shell-v1"' } }));
        if (heldBody) {
          const stream = new ReadableStream({
            start(controller) {
              options.signal?.addEventListener('abort', () => { window.fixtureBodyAbort = true; controller.error(new DOMException('Fixture deadline', 'AbortError')); }, { once: true });
            },
            // A stalled peer must not make cleanup wait for cancellation.
            cancel() { return new Promise(() => {}); }
          });
          return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/html', ETag: '"shell-v1"' } }));
        }
      }
      return fetchNative(input, options);
    };
  }, { heldBody, mode });
  const page = await context.newPage();
  const errors = [], requests = [], unexpected = [];
  let currentMode = mode, signedIn = false, navigations = 0;
  const fullSource = full ? await fs.readFile(path.join(root, 'leaderboard.html'), 'utf8') : '';
  const servedSource = () => full
    ? fullSource.replace(/(<script\b[^>]*id="token-horizon-shell"[^>]*>)/, `$1${currentMode === 'changed' ? '\n// fixture release changed\n' : ''}`)
    : (currentMode === 'oversized' ? '<!--' + 'x'.repeat(2 * 1024 * 1024) + '-->' : '') + simpleDocument(['changed', 'oversized'].includes(currentMode) ? scriptV2 : scriptV1, currentMode === 'css' ? '2' : '1');
  page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(o){window.fixtureGoogleCallback=o.callback},renderButton(host){const button=document.createElement('button');button.textContent='Continue with fixture Google';button.onclick=()=>window.fixtureGoogleCallback({credential:${JSON.stringify(credential)}});host.append(button)},prompt(){},cancel(){},disableAutoSelect(){}}}};` }));
  await page.route(ORIGIN + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), headers: await request.allHeaders(), resource: request.resourceType() });
    if (url.pathname === '/leaderboard.html' && request.resourceType() !== 'document') return route.fulfill({ status: 200, contentType: 'text/html', headers: { ETag: '"shell-v1"', 'Cache-Control': 'public, max-age=0, must-revalidate' }, body: servedSource() });
    if (url.pathname === '/api/config') return json(route, { googleClientId: 'fixture.apps.googleusercontent.com', googleAuth: true, githubAuth: false, webSessions: true });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated: signedIn, user: signedIn ? user : null, expiresAt: signedIn ? Date.now() + 30 * 86400000 : null });
    if (url.pathname === '/api/auth/google') { signedIn = true; return json(route, { ok: true, authenticated: true, user, expiresAt: Date.now() + 30 * 86400000 }); }
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: [] });
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    if (url.pathname === '/leaderboard') {
      const source = full ? fullSource : simpleDocument();
      return route.fulfill({ status: 200, contentType: 'text/html', body: source });
    }
    const file = path.resolve(root, url.pathname.slice(1));
    if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
    try { return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route(/https?:\/\/(?!token-horizon\.dev\/|accounts\.google\.com\/).*/, route => { unexpected.push(route.request().url()); return route.abort(); });
  await page.goto(ORIGIN + '/leaderboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.TokenHorizonUIUpdates));
  return {
    page, context, errors, requests,
    mode(next) { currentMode = next; },
    navigations() { return navigations; },
    async elapsed() { await page.evaluate(() => { window.fixtureClockOffset += 301000; }); },
    async check() { return page.evaluate(() => window.TokenHorizonUIUpdates.check()); },
    async close() { await context.close(); assert.deepEqual(errors, [], 'The release detector must not throw'); assert.deepEqual(unexpected, [], 'Fixtures must not contact outside services'); }
  };
}

try {
  console.log('UI release checks: same public shell, cookie-free revalidation, conditional 304 and hidden-tab throttling...');
  {
    const f = await fixture();
    try {
      await f.check();
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0);
      const reads = f.requests.filter(request => request.path === '/leaderboard.html');
      assert.equal(reads.length, 1);
      assert.equal(reads[0].headers.cookie, undefined, 'The public release check cannot send an account cookie');
      assert.equal(reads[0].method, 'GET');
      const options = (await f.page.evaluate(() => window.fixtureUpdateFetches))[0];
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-cache');
      assert.equal(options.bounded, true, 'The request must have a deadline');
      assert.equal(new URL(options.url).origin, ORIGIN);
      await f.check();
      assert.equal((await f.page.evaluate(() => window.fixtureUpdateFetches)).length, 1, 'Fresh checks reuse their five-minute deadline');
      await f.elapsed();
      await f.page.evaluate(() => { window.fixtureHidden = true; });
      await f.check();
      assert.equal((await f.page.evaluate(() => window.fixtureUpdateFetches)).length, 1, 'Hidden tabs perform no release polling');
      await f.page.evaluate(() => { window.fixtureHidden = false; window.fixtureNotModified = true; });
      await f.check();
      const conditional = (await f.page.evaluate(() => window.fixtureUpdateFetches)).at(-1);
      assert.equal(conditional.headers['if-none-match'], '"shell-v1"');
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0, '304 keeps the existing shell');
    } finally { await f.close(); }
  }

  console.log('UI release notice: changed source is compared without execution, automatic navigation, or draft loss...');
  {
    const f = await fixture();
    try {
      await f.check();
      await f.page.locator('#draft').fill('An unsaved report audience');
      await f.page.evaluate(() => { localStorage.setItem('fixture-draft', 'keep me'); });
      f.mode('changed'); await f.elapsed(); await f.check();
      await f.page.waitForSelector('[data-ui-update]');
      assert.match(await f.page.locator('[data-ui-update]').innerText(), /New version ready/i);
      assert.equal(await f.page.locator('[data-ui-reload]').count(), 1);
      assert.equal(await f.page.evaluate(() => window.fixtureShellBuild), 'v1', 'Fetched scripts must never execute');
      assert.equal(f.requests.some(request => request.method !== 'GET'), false, 'A release check cannot submit private changes');
      assert.equal(f.navigations(), 1, 'A release notice cannot navigate without the user choosing Reload');
      assert.equal(await f.page.locator('#draft').inputValue(), 'An unsaved report audience');
      assert.equal(await f.page.evaluate(() => localStorage.getItem('fixture-draft')), 'keep me');
      await f.page.getByRole('button', { name: 'Dismiss update notice', exact: true }).click();
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0);
      await f.page.evaluate(() => window.TokenHorizonUIUpdates.mount());
      await f.elapsed(); await f.check();
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0, 'Dismissal remains respected for the same release');
      f.mode('css'); await f.elapsed(); await f.check();
      await f.page.waitForSelector('[data-ui-update]');
      assert.equal(f.navigations(), 1, 'A different release can be announced without navigating');
      await Promise.all([f.page.waitForEvent('framenavigated'), f.page.locator('[data-ui-reload]').click()]);
      assert.equal(f.navigations(), 2, 'Reload navigates only after explicit activation');
      assert.equal(await f.page.evaluate(() => localStorage.getItem('fixture-draft')), 'keep me', 'Reload cannot erase saved drafts');
    } finally { await f.close(); }
  }

  console.log('UI release notice: a local stylesheet revision is enough to detect an updated design...');
  {
    const f = await fixture({ mode: 'css' });
    try { await f.check(); await f.page.waitForSelector('[data-ui-update]'); assert.equal(f.navigations(), 1); }
    finally { await f.close(); }
  }

  console.log('UI release checks: an oversized document cannot bypass the bounded public read...');
  {
    const f = await fixture({ mode: 'oversized' });
    try {
      await f.check();
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0, 'An over-budget response must be rejected before source comparison');
      assert.equal(await f.page.evaluate(() => window.fixtureShellBuild), 'v1');
    } finally { await f.close(); }
  }

  console.log('UI release checks: oversized headers, non-HTML bodies and failed HTTP responses cancel the fetch...');
  for (const mode of ['header-oversized', 'non-html', 'http-error']) {
    const f = await fixture({ mode });
    try {
      await f.check();
      const reads = await f.page.evaluate(() => window.fixtureUpdateFetches);
      assert.equal(reads.length, 1);
      assert.equal(reads[0].aborted, true, mode + ' must cancel the unread response');
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0);
    } finally { await f.close(); }
  }

  console.log('UI release checks: returning from the back-forward cache restarts one bounded polling loop...');
  {
    const f = await fixture();
    try {
      assert.equal(await f.page.evaluate(() => window.fixtureReleaseIntervals.size), 1);
      await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await f.page.evaluate(() => window.fixtureReleaseIntervals.size), 0);
      await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      assert.equal(await f.page.evaluate(() => window.fixtureReleaseIntervals.size), 1, 'A cached return must resume release polling');
      await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      assert.equal(await f.page.evaluate(() => window.fixtureReleaseIntervals.size), 1, 'Repeated show events cannot accumulate polling loops');
    } finally { await f.close(); }
  }

  console.log('UI release notice: the modal manager keeps Reload reachable inside the active auth dialog...');
  {
    const f = await fixture({ full: true, mode: 'changed' });
    try {
      await f.page.waitForSelector('#signin-btn');
      await f.check(); await f.page.waitForSelector('[data-ui-update]');
      await f.page.locator('#signin-btn').click();
      await f.page.waitForSelector('.signin-modal [data-ui-update]');
      assert.equal(await f.page.locator('[data-ui-update]').count(), 1, 'Moving the notice must not duplicate it');
      assert.equal(await f.page.locator('.signin-modal [data-ui-reload]').count(), 1);
      const semantics = await f.page.locator('.signin-modal').evaluate(node => ({ focusInside: node.contains(document.activeElement), locked: document.body.style.overflow }));
      assert.equal(semantics.focusInside, true); assert.equal(semantics.locked, 'hidden');
      await f.page.keyboard.press('Escape');
      await f.page.waitForFunction(() => !document.querySelector('#modal-backdrop').classList.contains('open'));
      await f.page.waitForSelector('[data-ui-update]');
      assert.equal(await f.page.locator('#modal-backdrop [data-ui-update]').count(), 0);
      assert.equal(f.navigations(), 1);
      await f.page.locator('#signin-btn').click();
      await f.page.waitForSelector('.signin-modal [data-ui-update]');
      await f.page.getByRole('button', { name: 'Dismiss update notice', exact: true }).click();
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0);
      assert.equal(await f.page.locator('.signin-modal').evaluate(node => node.contains(document.activeElement)), true, 'Dismissing a focused notice must restore focus inside the modal');
      await f.page.keyboard.press('Tab');
      assert.equal(await f.page.locator('.signin-modal').evaluate(node => node.contains(document.activeElement)), true, 'The next Tab cannot escape to the page behind the modal');
    } finally { await f.close(); }
  }

  console.log('UI release checks: a stalled response body expires while Google sign-in remains usable...');
  {
    const f = await fixture({ full: true, heldBody: true });
    try {
      await f.page.waitForSelector('#signin-btn');
      const started = Date.now();
      const pending = f.check();
      await f.page.waitForFunction(() => window.fixtureUpdateFetches.length === 1);
      await f.page.locator('#signin-btn').click();
      await f.page.getByRole('button', { name: 'Continue with fixture Google', exact: true }).click();
      await f.page.waitForSelector('#user-chip');
      assert.equal(f.requests.filter(request => request.path === '/api/auth/google' && request.method === 'POST').length, 1);
      await pending;
      assert(Date.now() - started < 8000, 'Body consumption must share the bounded request deadline');
      assert.equal(await f.page.evaluate(() => window.fixtureBodyAbort), true);
      assert.equal(await f.page.locator('[data-ui-update]').count(), 0, 'A timed-out check cannot claim that a release exists');
      assert.equal(f.navigations(), 1);
    } finally { await f.close(); }
  }
  console.log('UI release detector checks passed.');
} finally { await browser.close(); }
