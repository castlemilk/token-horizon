import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Exercise the real public chrome with local API/asset fixtures. No browser
// accounts, production data, external navigation, or provider login is used.
const origin = 'https://token-horizon.dev', docsRoot = path.resolve('docs');
const widths = [320, 390, 768, 1024, 1100, 1200, 1201, 1280, 1440, 1920];
const longUser = {
  provider: 'github', sub: '42', login: 'aurora', picture: '',
  name: 'Aurora Alexandria Montgomery of the Interstellar Observability and Model Optimisation Collective',
  email: 'aurora.alexandria.montgomery@interstellar-observability.example.com'
};
const entry = {
  id: 'fixture:aurora', handle: 'aurora', tokensAll: 42000, tokens7d: 12000, tokensToday: 3000,
  requestsAll: 12, updatedAt: Date.now() / 1000,
  breakdown: { models: [], projects: [], sessions: [], daily: [], modelHistory: [] }
};
const catalog = { schemaVersion: 1, count: 1, providers: [], models: [
  { id: 'openai/fixture-model', name: 'Fixture Model', provider: 'openai', providerName: 'OpenAI', contextK: 128, inputPerM: 2, outputPerM: 8, capabilities: { toolCall: true } }
] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ user = null, width = 1440, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion });
  const page = await context.newPage(), errors = [], unexpected = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(){},renderButton(host,options){const button=document.createElement('button');button.type='button';button.textContent='Continue with fixture Google';button.style.width=options.width+'px';host.append(button)},cancel(){},disableAutoSelect(){}}}};` });
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { mutations.push(url.pathname); return json(route, { ok: false, error: 'Navigation fixtures do not mutate data.' }, 405); }
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: 'navigation-fixture.apps.googleusercontent.com', googleAuth: true, githubAuth: true, webSessions: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated: Boolean(user), user, expiresAt: user ? Date.now() + 86400000 : null });
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: user ? [{ handle: entry.handle, displayName: user.name }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: null, invites: [] });
    if (url.pathname === '/api/share/list') return json(route, { ok: true, shares: [], groups: [], activity: [] });
    if (url.pathname.startsWith('/api/user/')) return json(route, { ok: true, handle: entry.handle, entry, rank: 1, total: 1, ranks: { today: 1, week: 1, all: 1, streak: 1 }, rankHistory: [], achievements: [] });
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    const relative = ['/leaderboard', '/leaderboard.html', '/models', '/models/', '/login'].includes(url.pathname) || url.pathname.startsWith('/u/') ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, async close() {
    await context.close();
    assert.deepEqual(errors, [], 'Navigation must not throw browser errors');
    assert.deepEqual(unexpected, [], 'Navigation fixtures must not contact other services');
    assert.deepEqual(mutations, [], 'Navigation must not mutate accounts or profile data');
  } };
}

async function open(page, route, authenticated = false) {
  await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => state.googleConfig === 'ready' && state.authStatus === 'ready');
  await page.waitForSelector(authenticated ? '#user-chip' : '#signin-btn');
  await page.locator('#discovery-header').waitFor({ state: 'visible' });
  await settle(page);
}

async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function assertLayout(page, authenticated, expanded = false) {
  const authSelector = authenticated ? '#user-chip' : '#signin-btn';
  const geometry = await page.evaluate(({ authSelector, expanded }) => {
    const header = document.querySelector('#discovery-header'), auth = document.querySelector(authSelector);
    const nav = document.querySelector('#discovery-navigation'), toggle = document.querySelector('#discovery-menu-toggle');
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const bounds = node => { const rect = node.getBoundingClientRect(); return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const controls = [...header.querySelectorAll('.discovery-brand, #discovery-menu-toggle, #discovery-navigation > a, #auth-slot > button, #user-chip')].filter(visible);
    const wrapped = [];
    for (const control of controls) {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || !visible(node.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const rows = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => Math.round(rect.top));
        if (new Set(rows).size > 1) wrapped.push(node.textContent.trim());
      }
    }
    const center = auth.getBoundingClientRect();
    const hit = document.elementFromPoint(center.x + center.width / 2, center.y + center.height / 2);
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, header: bounds(header), auth: bounds(auth), authHome: auth.closest('#discovery-actions')?.id, authInNav: Boolean(nav?.contains(auth)), authReachable: auth.contains(hit), navVisible: visible(nav), toggleVisible: visible(toggle), toggleExpanded: toggle?.getAttribute('aria-expanded'), toggleControls: toggle?.getAttribute('aria-controls'), bounds: controls.map(node => ({ label: node.textContent.trim(), ...bounds(node) })), wrapped, expanded };
  }, { authSelector, expanded });
  assert(geometry.documentWidth <= geometry.viewport + 1, 'Page overflow at ' + geometry.viewport + 'px: ' + JSON.stringify(geometry));
  assert.equal(geometry.authHome, 'discovery-actions', 'Authentication stays in the separate header actions');
  assert.equal(geometry.authInNav, false, 'Collapsed navigation cannot hide the account control');
  assert.equal(geometry.authReachable, true, 'Authentication remains clickable at ' + geometry.viewport + 'px');
  assert.deepEqual(geometry.wrapped, [], 'Header control text wrapped at ' + geometry.viewport + 'px');
  for (const box of [geometry.header, geometry.auth, ...geometry.bounds]) assert(box.x >= -1 && box.right <= geometry.viewport + 1, 'Header control escaped the viewport: ' + JSON.stringify(box));
  assert.equal(geometry.toggleControls, 'discovery-navigation');
  assert.equal(geometry.toggleVisible, geometry.viewport <= 1200, 'Navigation disclosure visibility at ' + geometry.viewport + 'px');
  assert.equal(geometry.navVisible, geometry.viewport > 1200 || expanded, 'Navigation link visibility at ' + geometry.viewport + 'px');
  assert.equal(geometry.toggleExpanded, String(expanded), 'Navigation expanded state at ' + geometry.viewport + 'px');
  assert(geometry.header.height <= 90, 'The header must retain one compact row');
  if (authenticated && geometry.viewport <= 650) {
    const avatar = page.locator('#user-chip > .avatar');
    assert(await avatar.isVisible(), 'The compact account control must show the user avatar');
    const avatarBounds = await avatar.boundingBox();
    assert(avatarBounds.width >= 24 && avatarBounds.height >= 24, 'The compact avatar must retain a recognizable size');
  }
  return geometry;
}

async function assertMenuClosed(page) {
  assert.equal(await page.locator('#discovery-menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#discovery-menu-toggle').getAttribute('aria-label'), 'Open navigation');
  assert.equal(await page.locator('#discovery-navigation').isVisible(), false);
  assert.equal(await page.locator('#discovery-navigation').getAttribute('hidden'), '');
}

try {
  console.log('Public navigation: anonymous and long signed-in identities fit all compact and desktop widths...');
  for (const user of [null, longUser]) {
    const f = await fixture({ user });
    try {
      await open(f.page, '/leaderboard', Boolean(user));
      for (const width of widths) {
        await f.page.setViewportSize({ width, height: 1000 }); await settle(f.page);
        await assertLayout(f.page, Boolean(user));
        if (width <= 1200) {
          await f.page.locator('#discovery-menu-toggle').click();
          await assertLayout(f.page, Boolean(user), true);
          assert.equal(await f.page.locator('#discovery-menu-toggle').getAttribute('aria-label'), 'Close navigation');
          assert.equal(await f.page.locator('#discovery-navigation > a').count(), 8, 'Compact menus retain all destinations');
          if (user && width === 390) await f.page.screenshot({ path: '/tmp/token-horizon-nav-mobile.png', animations: 'disabled' });
          await f.page.locator('#discovery-menu-toggle').click(); await assertMenuClosed(f.page);
        }
        if (user && width === 1440) await f.page.screenshot({ path: '/tmp/token-horizon-nav-desktop.png', animations: 'disabled' });
      }
      // Leaving public chrome must move the existing auth slot, and keyboard
      // focus must follow the visible route rather than its hidden disclosure.
      await f.page.setViewportSize({ width: 390, height: 1000 }); await settle(f.page);
      await f.page.locator('#discovery-menu-toggle').focus(); await f.page.keyboard.press('Enter');
      await f.page.locator('[data-public-view="dashboard"]').focus(); await f.page.keyboard.press('Enter');
      await f.page.waitForFunction(() => state.view === 'dashboard');
      assert.equal(await f.page.locator('#discovery-header').isVisible(), false);
      assert.equal(await f.page.evaluate(() => document.querySelector('#auth-slot').parentElement.classList.contains('topbar')), true, 'Workspace owns the same auth slot outside the public header');
      assert.equal(await f.page.locator(user ? '#user-chip' : '#signin-btn').isVisible(), true, 'Workspace retains the account control');
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'view', 'Keyboard navigation into Workspace focuses the visible content');
      await f.page.locator('#nav [data-view="leaderboard"]').focus(); await f.page.keyboard.press('Enter');
      await f.page.waitForFunction(() => state.view === 'leaderboard'); await settle(f.page);
      assert.equal(await f.page.locator('#auth-slot').count(), 1, 'Moving between surfaces cannot duplicate authentication');
      await assertLayout(f.page, Boolean(user));
    } finally { await f.close(); }
  }

  console.log('Public navigation: model, login and profile routes share reachable account controls...');
  for (const [route, width, user, loaded] of [
    ['/models', 390, null, '#mx-rows .mx-row'], ['/login', 390, null, '#login-page'],
    ['/u/aurora', 768, longUser, '#profile-shell'], ['/u/aurora', 1440, longUser, '#profile-shell']
  ]) {
    const f = await fixture({ width, user });
    try {
      await open(f.page, route, Boolean(user)); await f.page.waitForSelector(loaded); await assertLayout(f.page, Boolean(user));
      if (user) {
        await f.page.locator('#user-chip').click(); await f.page.waitForSelector('#account-menu:not([hidden])');
        assert.match(await f.page.locator('#account-menu').innerText(), /Manage connections|Sign out/);
        const accountBounds = await f.page.locator('#account-menu').boundingBox();
        assert(accountBounds.x >= -1 && accountBounds.x + accountBounds.width <= width + 1, 'Account actions remain inside the viewport');
        if (width <= 1200) {
          await f.page.locator('#discovery-menu-toggle').click();
          assert.equal(await f.page.locator('#account-menu').isVisible(), false, 'Navigation closes the account popover');
          assert.equal(await f.page.locator('#user-chip').getAttribute('aria-expanded'), 'false');
          await f.page.locator('#user-chip').click();
          await assertMenuClosed(f.page);
          assert.equal(await f.page.locator('#account-menu').isVisible(), true, 'Account actions close compact navigation');
        }
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'user-chip');
      } else {
        await f.page.locator('#signin-btn').click();
        if (route === '/login') assert.equal(await f.page.locator('.signin-modal').count(), 0, 'Login focuses its existing chooser');
        else { await f.page.waitForSelector('.signin-modal'); await f.page.keyboard.press('Escape'); }
      }
    } finally { await f.close(); }
  }

  console.log('Compact navigation: keyboard, Escape, outside clicks, route changes and desktop resizing settle correctly...');
  {
    const f = await fixture({ width: 390 });
    try {
      await open(f.page, '/leaderboard');
      const toggle = f.page.locator('#discovery-menu-toggle'), links = f.page.locator('#discovery-navigation > a');
      await toggle.focus(); await f.page.keyboard.press('Shift+Tab');
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'signin-btn', 'A hidden menu does not enter the keyboard tab order');
      await toggle.focus(); await f.page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await links.first().isVisible());
      assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.publicView), 'models', 'Opening navigation focuses its first link');
      await f.page.keyboard.press('Escape'); await assertMenuClosed(f.page);
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'discovery-menu-toggle', 'Escape returns focus to the menu control');
      await f.page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      // A native link must be reachable without a mouse and remain a link,
      // rather than requiring menu-specific keyboard conventions.
      await links.first().focus(); await f.page.keyboard.press('Tab');
      assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.publicView), 'leaderboard');
      await f.page.keyboard.press('Shift+Tab');
      assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.publicView), 'models');
      await f.page.keyboard.press('Enter'); await f.page.waitForSelector('#mx-rows .mx-row');
      await assertMenuClosed(f.page); assert.equal(await f.page.evaluate(() => state.view), 'models');
      assert.equal(await f.page.locator('[data-public-view="models"]').getAttribute('aria-current'), 'page');
      await toggle.click();
      // A focusable outside control represents other content on the page. It
      // must receive the click's focus instead of the disclosure stealing it.
      await f.page.evaluate(() => {
        const outside = document.createElement('button'); outside.type = 'button'; outside.id = 'fixture-outside-control'; outside.textContent = 'Outside control';
        outside.style.cssText = 'position:fixed;bottom:20px;left:20px'; document.body.append(outside);
      });
      await f.page.locator('#fixture-outside-control').click();
      await assertMenuClosed(f.page);
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'fixture-outside-control', 'An outside click preserves the clicked control’s focus');
      await f.page.evaluate(() => document.querySelector('#fixture-outside-control').remove());
      await toggle.click();
      // Model a non-focusable outside click that leaves the nav link focused,
      // as can happen when another click handler cancels native focus behavior.
      await f.page.evaluate(() => document.querySelector('#view').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await assertMenuClosed(f.page);
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'discovery-menu-toggle', 'Closing cannot leave keyboard focus inside hidden navigation');
      await toggle.click(); await f.page.setViewportSize({ width: 1440, height: 1000 }); await settle(f.page);
      await assertLayout(f.page, false);
      assert.equal(await f.page.locator('#discovery-navigation').getAttribute('hidden'), null, 'Desktop navigation has no hidden attribute');
      await f.page.setViewportSize({ width: 390, height: 1000 }); await settle(f.page); await assertMenuClosed(f.page);
      await toggle.click(); await f.page.locator('#signin-btn').click(); await f.page.waitForSelector('.signin-modal');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Opening sign-in settles compact navigation');
      await f.page.keyboard.press('Escape');
      await assertLayout(f.page, false);
    } finally { await f.close(); }
  }

  console.log('Compact navigation: reduced motion keeps menu state immediate and destinations usable...');
  {
    const f = await fixture({ width: 320, reducedMotion: 'reduce' });
    try {
      await open(f.page, '/leaderboard'); await f.page.locator('#discovery-menu-toggle').click();
      await assertLayout(f.page, false, true);
      const motion = await f.page.locator('#discovery-header').evaluate(header => [...header.querySelectorAll('*')].filter(node => node.getClientRects().length).map(node => ({ animation: getComputedStyle(node).animationName, animationDuration: parseFloat(getComputedStyle(node).animationDuration), transitionDuration: Math.max(...getComputedStyle(node).transitionDuration.split(',').map(Number.parseFloat)) })));
      assert(motion.every(value => (value.animation === 'none' || value.animationDuration <= .001) && value.transitionDuration <= .001), 'Reduced-motion navigation must not retain visible animation or transition delays');
      await f.page.keyboard.press('Escape'); await assertMenuClosed(f.page);
    } finally { await f.close(); }
  }
  console.log('Navigation browser checks passed.');
} finally { await browser.close(); }
