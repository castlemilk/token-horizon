import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { connectPage } from '../cloudflare/src/connect-page.js';
import { resolveChromium } from './playwright.mjs';

// Exercise the real public chrome with local API/asset fixtures. No browser
// accounts, production data, external navigation, or provider login is used.
const origin = 'https://token-horizon.dev', docsRoot = path.resolve('docs');
const widths = [320, 390, 430, 768, 1024, 1100, 1200, 1201, 1280, 1440, 1920];
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
const TEAM_ID = 'b'.repeat(32), today = Math.floor(Date.now() / 86400000) * 86400;
const team = { team: 'Aurora', teamId: TEAM_ID, tokens: 42000, tokens7d: 12000, tokensToday: 3000, members: 1, providers: { openai: 42000 }, users: [entry], daily: [{ day: today - 2 * 86400, tokens: 1000 }, { day: today, tokens: 2000 }] };
const catalog = { schemaVersion: 1, count: 1, providers: [], plans: [{ id: 'fixture-plan', name: 'Fixture Plan', provider: 'openai' }], models: [
  { id: 'openai/fixture-model', name: 'Fixture Model', provider: 'openai', providerName: 'OpenAI', contextK: 128, inputPerM: 2, outputPerM: 8, plans: ['fixture-plan'], capabilities: { toolCall: true } }
] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const focusRingSamples = [];

async function fixture({ user = null, width = 1440, reducedMotion = 'no-preference', colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion, colorScheme });
  const page = await context.newPage(), errors = [], unexpected = [], mutations = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const mirror = url.pathname.startsWith('/project/'), assetPath = mirror ? url.pathname.slice('/project'.length) : url.pathname;
    const read = { path: url.pathname, search: url.search, method: request.method(), resource: request.resourceType() };
    requests.push(read);
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(){},renderButton(host,options){const button=document.createElement('button');button.type='button';button.textContent='Continue with fixture Google';button.style.width=options.width+'px';host.append(button)},cancel(){},disableAutoSelect(){}}}};` });
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    const connectionListRead = url.pathname === '/oauth/connections' && request.method() === 'POST' && new URLSearchParams(request.postData()).get('action') === 'list';
    if (!['GET', 'HEAD'].includes(request.method()) && !connectionListRead) { mutations.push(url.pathname); return json(route, { ok: false, error: 'Navigation fixtures do not mutate data.' }, 405); }
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: 'navigation-fixture.apps.googleusercontent.com', googleAuth: true, githubAuth: true, webSessions: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated: Boolean(user), user, expiresAt: user ? Date.now() + 86400000 : null });
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: user ? [{ handle: entry.handle, displayName: user.name }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: null, invites: [] });
    if (url.pathname === '/api/share/list') return json(route, { ok: true, shares: [], groups: [], activity: [] });
    if (url.pathname.startsWith('/api/user/')) {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      return json(route, { ok: true, handle, entry: { ...entry, handle }, rank: 1, total: 1, ranks: { today: 1, week: 1, all: 1, streak: 1 }, rankHistory: [], achievements: [] });
    }
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname === '/api/providers') return json(route, { teams: [team], providers: [], history: { points: [], providers: [] } });
    if (url.pathname === '/api/team/' + TEAM_ID) return json(route, { ok: true, team: { id: TEAM_ID, name: team.team, memberCount: 1 }, stats: { ...team, publishedProfiles: 1 } });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname === '/oauth/connections') return json(route, { connections: [], cursor: null });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    if (url.pathname === '/connect' || url.pathname === '/oauth/authorize') return route.fulfill({ contentType: 'text/html', body: connectPage({ mode: url.pathname === '/connect' ? 'connect' : 'authorize', clientId: 'navigation-fixture.apps.googleusercontent.com', handle: 'fixture-transaction', clientName: 'Fixture tools', redirect: 'localhost:4567/callback', githubAuth: true, webSessions: true, error: url.searchParams.get('error') ? 'This fixture connection expired.' : '' }) });
    // page.route does not re-intercept a server redirect chain. A fresh native
    // location replacement keeps directory canonicalisation fully hermetic.
    if (mirror && ['/models', '/teams', '/login'].includes(assetPath)) return route.fulfill({ contentType: 'text/html', body: '<script>location.replace(location.pathname+"/"+location.search+location.hash)</script>' });
    if (!mirror && assetPath === '/login/') return route.fulfill({ contentType: 'text/html', body: '<script>location.replace(location.pathname.slice(0,-1)+location.search+location.hash)</script>' });
    const relative = assetPath === '/' ? 'index.html'
      : ['/leaderboard', '/leaderboard.html', '/login'].includes(assetPath) || /^\/(?:u|t)\//.test(assetPath) || !mirror && ['/models', '/models/', '/teams', '/teams/'].includes(assetPath) ? 'leaderboard.html'
      : assetPath === '/models/' ? 'models/index.html' : ['/teams', '/teams/'].includes(assetPath) ? 'teams/index.html' : assetPath.endsWith('/') ? assetPath.slice(1) + 'index.html' : assetPath.slice(1);
    const file = path.resolve(docsRoot, relative);
    read.file = relative;
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html' && !mirror) body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch (error) { read.fileError = error.message; return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, requests, async close() {
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

async function assertSignInFocusContrast(link) {
  // Traverse from the preceding native control so this measures keyboard
  // :focus-visible, rather than merely assigning programmatic focus.
  await link.focus(); await link.press('Shift+Tab'); await link.page().keyboard.press('Tab');
  const sample = await link.evaluate(node => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const over = (layer, background) => layer.slice(0, 3).map((value, index) => value * (layer[3] ?? 1) + background[index] * (1 - (layer[3] ?? 1)));
    const luminance = color => color.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    // The positive outline offset places the ring over the header, outside the
    // button fill. Composite transparent ancestors to find that painted color.
    const layers = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) layers.unshift(rgba(getComputedStyle(ancestor).backgroundColor));
    const background = layers.reduce((color, layer) => over(layer, color), [255, 255, 255]);
    const style = getComputedStyle(node), ring = over(rgba(style.outlineColor), background);
    const ringLight = luminance(ring), backgroundLight = luminance(background);
    return { path: location.pathname, theme: document.documentElement.dataset.theme, width: innerWidth, focused: document.activeElement === node, focusVisible: node.matches(':focus-visible'), outline: style.outlineStyle, thickness: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), color: style.outlineColor, background, contrast: (Math.max(ringLight, backgroundLight) + .05) / (Math.min(ringLight, backgroundLight) + .05) };
  });
  assert(sample.focused && sample.focusVisible, 'Native keyboard traversal focuses the account action: ' + JSON.stringify(sample));
  assert(sample.outline !== 'none' && sample.thickness >= 2 && sample.offset >= 1, 'Keyboard Sign in has a visible ring separated from its fill: ' + JSON.stringify(sample));
  assert(sample.contrast >= 3, 'Sign in focus ring has at least 3:1 contrast against its adjacent header: ' + JSON.stringify(sample));
  focusRingSamples.push(sample);
}

async function assertPublicSignIn(page, { label = 'Sign in', prefix = '', embedded = false } = {}) {
  const link = page.locator('a.th-nav-signin[data-nav-signin]');
  assert.equal(await link.count(), 1, 'Public header has one persistent native account link');
  assert.equal(await page.getByRole('link', { name: label, exact: true }).count(), 1, 'The account action has its visible accessible name');
  const details = await link.evaluate(node => {
    const rect = node.getBoundingClientRect(), label = node.querySelector('[data-nav-signin-label]'), style = getComputedStyle(label);
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { href: node.href, raw: node.getAttribute('href'), outsideMenu: !node.closest('#main-nav,#nav-links'), header: Boolean(node.closest('header,#site-nav')), label: label.textContent.trim(), labelVisible: label.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none', svg: [...node.querySelectorAll('svg')].map(svg => ({ hidden: svg.getAttribute('aria-hidden'), focusable: svg.getAttribute('focusable'), tabIndex: svg.tabIndex })), x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height, reachable: node.contains(hit), viewport: innerWidth, document: document.documentElement.scrollWidth };
  });
  assert(details.header && details.outsideMenu, 'Sign in stays outside collapsed navigation');
  assert.equal(details.label, label); assert.equal(details.labelVisible, true, 'The CTA keeps a visible text label');
  assert.equal(details.svg.length, 1, 'The account CTA has one SVG');
  assert.equal(details.svg[0].hidden, 'true', 'The SVG is decorative; its link owns the accessible name');
  assert(details.svg[0].focusable !== 'true' && details.svg[0].tabIndex < 0, 'The decorative SVG never adds a keyboard tab stop');
  assert(details.width >= 43.5 && details.height >= 43.5, 'The account link retains a 44px primary touch target: ' + JSON.stringify(details));
  assert(details.x >= -1 && details.right <= details.viewport + 1 && details.y >= 0 && details.bottom <= 180 && details.document <= details.viewport + 1 && details.reachable, 'The closed public header keeps Sign in visible and clickable: ' + JSON.stringify(details));
  const url = new URL(details.href);
  if (embedded) {
    assert.equal(details.raw, '#connection-account', 'Connect retains the active embedded authentication flow');
    assert.equal(await page.locator('#connection-account #auth-options,#connection-account #identity').count(), 2, 'The account anchor survives signed-out and signed-in states');
  } else assert.equal(url.pathname, prefix + '/login/', 'Native Sign in href preserves the deployment base');
  const header = page.locator('.site-header,#site-nav,body>header');
  assert.equal(await header.getByRole('link', { name: /^Token Horizon(?: home)?$/, exact: true }).count(), 1, 'The header logo retains its accessible name when compact');
  const brand = header.locator('a.brand').first();
  const logo = await brand.evaluate(node => {
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const painted = element => { const style = getComputedStyle(element), bounds = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && bounds.width >= 16 && bounds.height >= 16; };
    const before = getComputedStyle(node, '::before');
    const pseudo = before.content !== 'none' && before.display !== 'none' && parseFloat(before.width) >= 16 && parseFloat(before.height) >= 16 && before.visibility !== 'hidden';
    return { width: r.width, height: r.height, reachable: node.contains(hit), markVisible: pseudo || [...node.querySelectorAll('img,svg,.brand-mark')].some(painted), compact: innerWidth <= 480 };
  });
  assert(logo.reachable && logo.width >= 43.5 && logo.height >= 43.5, 'The home logo retains its reachable 44px header target: ' + JSON.stringify(logo));
  if (logo.compact) assert.equal(logo.markVisible, true, 'The compact home action paints its horizon mark');
  await assertSignInFocusContrast(link);
  return link;
}

async function assertLoginChooser(page) {
  await page.locator('#login-page').waitFor();
  await page.locator('#signin-gsi-btn button').waitFor();
  assert.equal(await page.locator('#signin-github').isEnabled(), true, 'The existing GitHub chooser remains available');
  assert.equal(await page.locator('#signin-gsi-btn button').isEnabled(), true, 'The existing Google chooser remains available');
  assert.equal(await page.locator('.signin-modal').count(), 0, 'A native login destination uses the existing page chooser');
  assert.equal(await page.locator('[data-nav-signin]').count(), 0, 'The SPA login page does not duplicate the public CTA');
}

async function assertLayout(page, authenticated, expanded = false) {
  assert.equal(await page.locator('[data-nav-signin]').count(), 0, 'SPA authentication remains authoritative without an extra public Sign in link');
  assert.equal(await page.locator('#auth-slot').count(), 1, 'SPA header keeps exactly one authentication slot');
  const authSelector = authenticated ? '#user-chip' : '#signin-btn';
  const geometry = await page.evaluate(({ authSelector, expanded }) => {
    const header = document.querySelector('#discovery-header'), auth = document.querySelector(authSelector);
    const nav = document.querySelector('#discovery-navigation'), toggle = document.querySelector('#discovery-menu-toggle');
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const bounds = node => { const rect = node.getBoundingClientRect(); return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const controls = [...header.querySelectorAll('.discovery-brand, #discovery-menu-toggle, #discovery-navigation > a, #discovery-navigation [data-explore-trigger], #auth-slot > button, #user-chip')].filter(visible);
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

async function assertAccountContrast(page) {
  const samples = await page.locator('#user-chip').evaluate(chip => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const luminance = color => color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    return [...chip.querySelectorAll('strong, small, span[aria-hidden="true"]')].filter(node => node.getClientRects().length).map(node => {
      // Resolve transparent component layers against their actual painted host.
      const layers = [];
      for (let host = node; host; host = host.parentElement) layers.unshift(rgba(getComputedStyle(host).backgroundColor));
      const background = layers.reduce((result, layer) => {
        const alpha = layer[3] ?? 1;
        return layer.slice(0, 3).map((value, index) => value * alpha + result[index] * (1 - alpha));
      }, [255, 255, 255]);
      const style = getComputedStyle(node), foreground = rgba(style.color);
      const alpha = foreground[3] ?? 1;
      const ink = foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
      const light = luminance(ink), dark = luminance(background);
      return { label: node.tagName, color: style.color, background, contrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) };
    });
  });
  assert.equal(samples.length, 3, 'The name, provider subtitle and chevron must remain visible');
  for (const sample of samples) assert(sample.contrast >= 4.5, 'Account text must have AA contrast: ' + JSON.stringify(sample));
}

async function assertExploreDestinations(page, prefix = '') {
  const targets = await page.locator('[data-explore-link],[data-explore-direct="teams"]').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.exploreLink || 'teams', tag: node.tagName, href: node.href })));
  for (const key of ['explorer', 'cheapest', 'providers', 'plans', 'rankings', 'team-standings', 'team-analytics', 'leagues', 'teams']) {
    const links = targets.filter(target => target.key === key);
    assert(links.length > 0 && links.every(link => link.tag === 'A'), `${key} remains a native link destination`);
    for (const link of links) {
      const url = new URL(link.href);
      assert.equal(url.origin, origin, `${key} remains on the fixture origin`);
      assert(url.pathname.startsWith(prefix + '/'), `${key} preserves the ${prefix || 'root'} site base: ${link.href}`);
      if (key === 'teams' || key === 'team-standings') {
        assert.equal(url.pathname, prefix + '/teams', 'Teams links use the canonical route beneath their site base');
        assert.equal(url.hash, '#tm-rankings-title', 'Teams links name the standings destination');
      } else if (key === 'team-analytics') {
        assert.equal(url.pathname, prefix + '/teams');
        assert.equal(url.searchParams.get('teamChart'), 'history');
        assert(['7', '30', '119'].includes(url.searchParams.get('teamDays')));
        assert.equal(url.hash, '#tm-analytics');
      } else if (['cheapest', 'providers', 'plans'].includes(key)) {
        assert.equal(url.pathname, prefix + '/models/', 'Model subviews use the canonical native explorer route');
        assert.equal(url.searchParams.get('tab'), key);
      } else if (key === 'leagues') assert.equal(url.searchParams.get('view'), 'leagues');
    }
  }
}

async function modifiedExploreClickHandled(page, key, selector) {
  return page.evaluate(({ key, selector }) => {
    const anchor = [...document.querySelectorAll(selector)].find(node => node.getClientRects().length);
    if (!anchor) throw new Error('The modified-click fixture requires a visible native link');
    let handled;
    document.addEventListener('click', event => { handled = event.defaultPrevented; event.preventDefault(); }, { once: true });
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, [key]: true }));
    return handled;
  }, { key, selector });
}

async function assertTeamsRoute(page, prefix, anchor, history = false) {
  try { await page.locator('.tm-ranking').waitFor(); }
  catch (error) {
    const route = await page.evaluate(() => ({ url: location.href, view: typeof state === 'object' ? state.view : null, heading: document.querySelector('h1')?.textContent, content: document.querySelector('#view')?.textContent.slice(0, 320) }));
    throw new Error('Teams navigation did not reach its populated standings: ' + JSON.stringify(route), { cause: error });
  }
  await page.waitForFunction(() => state.view === 'teams');
  const url = new URL(page.url());
  assert([prefix + '/teams', prefix + '/teams/', prefix + '/leaderboard.html'].includes(url.pathname), 'Teams navigation retains the canonical or redirected static route');
  assert.equal(url.hash, '#' + anchor);
  await page.waitForFunction(anchor => document.activeElement?.id === anchor, anchor);
  if (history) {
    assert.equal(url.searchParams.get('teamChart'), 'history');
    assert.equal(url.searchParams.get('teamDays'), '30');
    assert.equal(await page.locator('[data-team-analytics-view="history"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('[data-team-community-total]').innerText(), '3.0k');
  }
}

async function openCompactNavigation(page, surface) {
  const menu = page.locator(surface === 'landing' ? '.site-header .menu-toggle' : '#discovery-menu-toggle');
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
}

try {
  console.log('Public Sign in: persistent account actions fit closed phone and desktop headers in both palettes…');
  const publicHeaders = [['/', '.hero'], ['/docs/', '.docs-layout'], ['/blog/', '#site-nav'], ['/blog/why-token-horizon.html', '#site-nav'], ['/blog/pricing-evidence.html', '#site-nav'], ['/connect', '.connection'], ['/oauth/authorize', '#consent-form']];
  for (const colorScheme of ['light', 'dark']) for (const width of [320, 390, 430, 1440]) {
    const f = await fixture({ width, colorScheme, reducedMotion: 'reduce' });
    try {
      for (const [route, loaded] of publicHeaders) {
        await f.page.goto(origin + route, { waitUntil: 'domcontentloaded' }); await f.page.locator(loaded).waitFor(); await settle(f.page);
        assert.equal(await f.page.locator('html').getAttribute('data-theme'), colorScheme, 'The public CTA is checked in the requested palette');
        const embedded = ['/connect', '/oauth/authorize'].includes(route);
        await assertPublicSignIn(f.page, { embedded });
        const menu = f.page.locator('.menu-toggle,#nav-toggle').first();
        if (await menu.count() && await menu.isVisible()) {
          assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'The account CTA needs no menu disclosure');
          if (route !== '/') assert.equal(width <= 1080, true, 'Reading menus use their compact breakpoint');
        }
      }
    } finally { await f.close(); }
  }
  console.log('Sign in focus rings: ' + JSON.stringify({ minimumContrast: Math.min(...focusRingSamples.map(sample => sample.contrast)).toFixed(2), connect320: focusRingSamples.filter(sample => sample.path === '/connect' && sample.width === 320).map(({ theme, color, background, contrast }) => ({ theme, color, background, contrast: contrast.toFixed(2) })) }));

  console.log('Public Sign in: reading and landing breakpoint changes retain account and home actions…');
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ colorScheme, reducedMotion: 'reduce' });
    try {
      for (const [route, sizes, selector, breakpoint] of [['/', [1200, 1201, 1280], '.menu-toggle', 1200], ['/docs/', [1080, 1081], '#nav-toggle', 1080]]) {
        await f.page.goto(origin + route, { waitUntil: 'domcontentloaded' }); await settle(f.page);
        for (const width of sizes) {
          await f.page.setViewportSize({ width, height: 1000 }); await settle(f.page);
          await assertPublicSignIn(f.page);
          assert.equal(await f.page.locator(selector).isVisible(), width <= breakpoint, 'The header switches menus at ' + breakpoint + 'px without hiding account actions');
        }
      }
    } finally { await f.close(); }
  }

  console.log('Public Sign in: keyboard and native links reach canonical and static login without losing query or fragment…');
  for (const prefix of ['', '/project']) for (const route of ['/', '/docs/', '/blog/', '/blog/pricing-evidence.html']) {
    const f = await fixture({ width: 390, reducedMotion: 'reduce' });
    try {
      await f.page.goto(origin + prefix + route, { waitUntil: 'domcontentloaded' }); await settle(f.page);
      const link = await assertPublicSignIn(f.page, { prefix });
      for (const key of ['ctrlKey', 'metaKey']) assert.equal(await modifiedExploreClickHandled(f.page, key, '[data-nav-signin]'), false, 'Sign in preserves native modified clicks');
      await link.press('Enter'); await assertLoginChooser(f.page);
      assert.equal(new URL(f.page.url()).pathname, prefix ? '/project/leaderboard.html' : '/login', 'The native login route matches its deployment');
      const explorer = f.page.getByRole('link', { name: 'Explore without signing in', exact: true });
      assert.equal(new URL(await explorer.evaluate(node => node.href)).pathname, prefix + '/leaderboard.html', 'Anonymous exploration stays inside the same deployment');
      await explorer.click(); await f.page.locator('.discovery-title').waitFor();
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ width: 390, reducedMotion: 'reduce' });
    try {
      const query = '?signin=1&resume=teams&model=openai%2Ffixture-model&custom=one%26two';
      await f.page.goto(origin + '/project/login/' + query + '#crew-destination', { waitUntil: 'domcontentloaded' });
      await assertLoginChooser(f.page);
      const alias = f.requests.find(request => request.path === '/project/leaderboard.html' && request.resource === 'document');
      assert(alias, 'The real static login alias navigates to the project SPA');
      const parameters = new URLSearchParams(alias.search);
      for (const [key, value] of new URLSearchParams(query)) assert.equal(parameters.get(key), value, 'The login alias preserves ' + key);
      assert.equal(parameters.get('view'), 'login');
      assert.equal(new URL(f.page.url()).hash, '#crew-destination', 'The static login alias preserves its fragment');
      const returnUrl = new URL(f.page.url()); returnUrl.searchParams.delete('signin');
      await f.page.locator('#signin-github').click(); await f.page.waitForURL(url => url.pathname === '/api/auth/github');
      assert.equal(new URL(f.page.url()).searchParams.get('returnTo'), returnUrl.pathname + returnUrl.search, 'GitHub continuation retains the static deployment and resumable query');
      assert(f.requests.some(request => request.path === '/api/auth/github' && request.method === 'GET'), 'GitHub starts through the existing read-only authorization destination');
    } finally { await f.close(); }
  }

  console.log('Connect Sign in: account anchors retain transaction fields and signed-in identity without navigation…');
  for (const user of [null, longUser]) for (const route of ['/connect', '/oauth/authorize?client_id=fixture&state=nonce']) {
    const f = await fixture({ width: 320, user, reducedMotion: 'reduce' });
    try {
      await f.page.goto(origin + route, { waitUntil: 'domcontentloaded' }); await f.page.locator('.connection').waitFor();
      await f.page.waitForFunction(expected => document.querySelector('[data-nav-signin-label]')?.textContent === expected, user ? 'Your account' : 'Sign in');
      const link = await assertPublicSignIn(f.page, { label: user ? 'Your account' : 'Sign in', embedded: true });
      const before = new URL(f.page.url()), fields = await f.page.locator('#consent-form input').evaluateAll(nodes => nodes.map(node => ({ name: node.name, value: node.value, checked: node.checked })));
      await link.press('Enter');
      assert.equal(new URL(f.page.url()).pathname, before.pathname); assert.equal(new URL(f.page.url()).search, before.search);
      assert.equal(new URL(f.page.url()).hash, '#connection-account');
      assert.deepEqual(await f.page.locator('#consent-form input').evaluateAll(nodes => nodes.map(node => ({ name: node.name, value: node.value, checked: node.checked }))), fields, 'Sign in anchor preserves the same consent transaction and permissions');
      assert.equal(await f.page.locator(user ? '#identity' : '#auth-options').isVisible(), true, 'The anchor reaches the current account state');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ width: 320, reducedMotion: 'reduce' });
    try {
      await f.page.goto(origin + '/connect?error=fixture', { waitUntil: 'domcontentloaded' }); await f.page.locator('.connection').waitFor();
      const link = f.page.getByRole('link', { name: 'Sign in', exact: true });
      assert.equal(new URL(await link.evaluate(node => node.href)).pathname, '/login', 'Error pages retain a real login destination without a missing account anchor');
      await link.click(); await assertLoginChooser(f.page);
    } finally { await f.close(); }
  }

  console.log('Explore navigation: landing and discovery share anchored menus with native destinations and keyboard focus…');
  for (const prefix of ['', '/project']) for (const surface of ['landing', 'discovery']) {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      if (surface === 'landing') {
        await f.page.goto(origin + prefix + '/', { waitUntil: 'domcontentloaded' });
        await f.page.locator('#main-nav [data-explore-trigger="models"]').waitFor({ state: 'attached' });
      } else await open(f.page, prefix + '/leaderboard.html');
      await settle(f.page);
      const nav = f.page.locator(surface === 'landing' ? '#main-nav' : '#discovery-navigation');
      const models = nav.locator('[data-explore-trigger="models"]'), community = nav.locator('[data-explore-trigger="community"]');
      const panel = f.page.locator('[data-explore-panel]');
      assert.equal(await panel.count(), 1, 'Explore groups reuse one desktop panel');
      const panelNode = await panel.elementHandle();
      assert.equal(await models.evaluate(node => node.tagName), 'BUTTON');
      assert.equal(await community.evaluate(node => node.tagName), 'BUTTON');
      assert.match(await models.innerText(), /Models/); assert.match(await community.innerText(), /Community/);
      assert.equal(await models.getAttribute('aria-expanded'), 'false');
      assert.equal(await community.getAttribute('aria-expanded'), 'false');
      assert.equal(await models.getAttribute('aria-controls'), await panel.getAttribute('id'), 'The Models trigger identifies its shared panel');
      assert.equal(await community.getAttribute('aria-controls'), await panel.getAttribute('id'), 'The Community trigger identifies the same panel');
      await assertExploreDestinations(f.page, prefix);
      await models.focus(); await models.press('ArrowDown');
      await panel.waitFor({ state: 'visible' });
      assert.equal(await models.getAttribute('aria-expanded'), 'true');
      assert.equal(await community.getAttribute('aria-expanded'), 'false');
      assert.equal(await panel.locator('[data-explore-link="explorer"]').evaluate(node => node === document.activeElement), true, 'ArrowDown opens Models and focuses its first native link');
      await f.page.keyboard.press('End');
      assert.equal(await panel.locator('[data-explore-link="plans"]').evaluate(node => node === document.activeElement), true, 'End selects the last Models link');
      await f.page.keyboard.press('Home');
      assert.equal(await panel.locator('[data-explore-link="explorer"]').evaluate(node => node === document.activeElement), true);
      await f.page.keyboard.press('ArrowDown');
      assert.equal(await panel.locator('[data-explore-link="cheapest"]').evaluate(node => node === document.activeElement), true);
      await f.page.keyboard.press('ArrowUp');
      assert.equal(await panel.locator('[data-explore-link="explorer"]').evaluate(node => node === document.activeElement), true);
      await models.focus(); await models.press('ArrowRight');
      assert.equal(await community.evaluate(node => node === document.activeElement), true, 'ArrowRight moves between labelled group triggers');
      await panel.locator('[data-explore-link="team-analytics"]').waitFor();
      assert.equal(await panel.evaluate((node, previous) => node === previous, panelNode), true, 'Group changes keep one anchored panel instance');
      assert.equal(await community.getAttribute('aria-expanded'), 'true');
      assert.equal(await models.getAttribute('aria-expanded'), 'false');
      assert.equal(await panel.locator('[data-explore-link]:visible').count(), 4, 'Community keeps rankings, team standings, analytics and leagues reachable');
      for (const key of ['ctrlKey', 'metaKey']) {
        await community.press('ArrowDown');
        assert.equal(await modifiedExploreClickHandled(f.page, key, '[data-explore-panel] [data-explore-link="team-analytics"]'), false, 'Modified analytics clicks retain native new-tab behavior');
      }
      await community.press('ArrowDown');
      const geometry = await panel.evaluate(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth };
      });
      assert(geometry.left >= -1 && geometry.right <= geometry.viewport + 1 && geometry.top >= 0 && geometry.bottom <= 1000, 'The anchored Explore panel fits the viewport');
      const motion = await panel.evaluate(node => [node, ...node.querySelectorAll('*')].filter(control => control.getClientRects().length).map(control => ({ animation: getComputedStyle(control).animationName, animationDuration: parseFloat(getComputedStyle(control).animationDuration), transition: Math.max(...getComputedStyle(control).transitionDuration.split(',').map(Number.parseFloat)) })));
      assert(motion.every(value => (value.animation === 'none' || value.animationDuration <= .001) && value.transition <= .001), 'The shared Explore panel respects reduced-motion preferences');
      await f.page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
      assert.equal(await community.evaluate(node => node === document.activeElement), true, 'Escape returns focus to the active group trigger');
      assert.equal(await community.getAttribute('aria-expanded'), 'false');
      await models.focus(); await models.press('ArrowDown');
      await panel.locator('[data-explore-link="explorer"]').focus(); await f.page.keyboard.press('Tab');
      assert.equal(await panel.locator('[data-explore-link="cheapest"]').evaluate(node => node === document.activeElement), true, 'Explore links retain natural Tab navigation');
      await f.page.keyboard.press('Shift+Tab');
      assert.equal(await panel.locator('[data-explore-link="explorer"]').evaluate(node => node === document.activeElement), true);
      await panel.locator('[data-explore-link="plans"]').focus(); await f.page.keyboard.press('Tab');
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await panel.evaluate(node => node.contains(document.activeElement)), false, 'Tab can leave Explore without trapping or hiding focus');
      await models.focus(); await models.press('ArrowDown');
      await f.page.evaluate(() => {
        const outside = document.createElement('button'); outside.id = 'fixture-explore-outside'; outside.type = 'button'; outside.textContent = 'Outside Explore'; outside.style.cssText = 'position:fixed;bottom:20px;left:20px'; document.body.append(outside);
      });
      await f.page.locator('#fixture-explore-outside').click(); await panel.waitFor({ state: 'hidden' });
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'fixture-explore-outside', 'Closing Explore preserves outside click focus');
      await f.page.evaluate(() => document.querySelector('#fixture-explore-outside').remove());
      const teamsLink = nav.locator('[data-explore-direct="teams"]');
      for (const key of ['ctrlKey', 'metaKey']) assert.equal(await modifiedExploreClickHandled(f.page, key, (surface === 'landing' ? '#main-nav' : '#discovery-navigation') + ' [data-explore-direct="teams"]'), false, 'Modified Teams clicks retain native new-tab behavior');
      await teamsLink.focus(); await teamsLink.press('Enter');
      try { await assertTeamsRoute(f.page, prefix, 'tm-rankings-title'); }
      catch (error) {
        console.error('Navigation fixture document reads: ' + JSON.stringify(f.requests.filter(request => request.resource === 'document')));
        throw new Error(`${surface} Teams link under ${prefix || 'root'} failed`, { cause: error });
      }
      const discovery = f.page.locator('#discovery-navigation');
      await discovery.locator('[data-explore-trigger="community"]').focus(); await f.page.keyboard.press('ArrowDown');
      await f.page.locator('[data-explore-panel] [data-explore-link="team-analytics"]').click();
      await assertTeamsRoute(f.page, prefix, 'tm-analytics', true);
      await f.page.locator('[data-team-community-days="119"]').click();
      await discovery.locator('[data-explore-trigger="community"]').focus(); await f.page.keyboard.press('ArrowDown');
      const analytics = f.page.locator('[data-explore-panel] [data-explore-link="team-analytics"]');
      assert.equal(new URL(await analytics.evaluate(node => node.href)).searchParams.get('teamDays'), '119', 'The Analytics destination retains the selected valid team-history window');
      assert.equal(new URL(await analytics.evaluate(node => node.href)).hash, '#tm-analytics');
    } finally { await f.close(); }
  }

  console.log('Explore navigation: hover grace crosses the trigger gap and rapid group changes keep one panel…');
  {
    const f = await fixture();
    try {
      await open(f.page, '/leaderboard');
      const models = f.page.locator('[data-explore-trigger="models"]'), community = f.page.locator('[data-explore-trigger="community"]'), panel = f.page.locator('[data-explore-panel]');
      await models.hover(); await panel.waitFor({ state: 'visible' });
      const trigger = await models.boundingBox(), box = await panel.boundingBox();
      await f.page.mouse.move(trigger.x + trigger.width / 2, Math.max(trigger.y + trigger.height + 1, box.y - 3));
      await f.page.waitForTimeout(80);
      assert.equal(await panel.isVisible(), true, 'Brief pointer movement between the trigger and anchored panel has a grace period');
      await panel.locator('[data-explore-link="explorer"]').hover(); await f.page.waitForTimeout(320);
      assert.equal(await panel.isVisible(), true, 'Entering the panel cancels a pending hover close');
      for (const group of [community, models, community, models]) { await group.hover(); assert.equal(await panel.isVisible(), true, 'Rapid trigger switches do not close the shared panel'); }
      assert.equal(await f.page.locator('[data-explore-panel]').count(), 1);
      await f.page.mouse.move(1, 800); await panel.waitFor({ state: 'hidden' });
      assert.equal(await models.getAttribute('aria-expanded'), 'false', 'Leaving both trigger and panel settles the hover disclosure');
    } finally { await f.close(); }
  }

  console.log('Explore navigation: compact touch disclosures and reduced motion keep every destination usable…');
  for (const surface of ['landing', 'discovery']) for (const width of [320, 390, 768]) {
    const f = await fixture({ width, reducedMotion: 'reduce' });
    try {
      if (surface === 'landing') {
        await f.page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await f.page.locator('#main-nav [data-explore-trigger="models"]').waitFor({ state: 'attached' });
      } else await open(f.page, '/leaderboard');
      await openCompactNavigation(f.page, surface);
      const nav = f.page.locator(surface === 'landing' ? '#main-nav' : '#discovery-navigation');
      const models = nav.locator('[data-explore-trigger="models"]'), community = nav.locator('[data-explore-trigger="community"]');
      await models.click();
      const modelLinks = nav.locator('[data-explore-mobile="models"]');
      await modelLinks.waitFor({ state: 'visible' });
      assert.equal(await f.page.locator('[data-explore-panel]').isVisible(), false, 'Compact navigation uses inline disclosures instead of an offscreen desktop panel');
      assert.equal(await models.getAttribute('aria-expanded'), 'true');
      assert.equal(await modelLinks.locator('[data-explore-link]').count(), 4);
      await community.click();
      const communityLinks = nav.locator('[data-explore-mobile="community"]');
      await communityLinks.waitFor({ state: 'visible' });
      assert.equal(await modelLinks.isVisible(), false, 'One compact Explore group expands at a time');
      assert.equal(await models.getAttribute('aria-expanded'), 'false');
      const layout = await nav.evaluate(node => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, right: node.getBoundingClientRect().right, targets: [...node.querySelectorAll('[data-explore-trigger],[data-explore-mobile] a,[data-explore-direct="teams"]')].filter(control => control.getClientRects().length).map(control => ({ label: control.textContent.trim(), width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height, animation: getComputedStyle(control).animationName, animationDuration: parseFloat(getComputedStyle(control).animationDuration), transition: Math.max(...getComputedStyle(control).transitionDuration.split(',').map(Number.parseFloat)) })) }));
      assert(layout.document <= width + 1 && layout.right <= width + 1, `Compact ${surface} navigation fits ${width}px`);
      assert(layout.targets.every(target => target.width >= 44 && target.height >= 44), 'Explore controls and destinations retain 44px touch targets: ' + JSON.stringify(layout.targets));
      assert(layout.targets.every(target => (target.animation === 'none' || target.animationDuration <= .001) && target.transition <= .001), 'Reduced-motion Explore uses immediate control state');
      await communityLinks.locator('[data-explore-link="rankings"]').focus(); await f.page.keyboard.press('Tab');
      assert.equal(await communityLinks.locator('[data-explore-link="team-standings"]').evaluate(node => node === document.activeElement), true, 'Compact destinations retain natural Tab order');
      await f.page.keyboard.press('Escape');
      assert.equal(await nav.evaluate(node => !node.contains(document.activeElement) || document.activeElement.getClientRects().length > 0), true, 'Escape never leaves focus inside hidden compact navigation');
      if (surface === 'discovery') {
        assert.equal(await f.page.locator('#signin-btn').isVisible(), true, 'Explore disclosures do not hide sign-in');
        const theme = f.page.locator('.th-theme-toggle:visible');
        const before = await f.page.locator('html').getAttribute('data-theme'); await theme.click();
        assert.notEqual(await f.page.locator('html').getAttribute('data-theme'), before, 'The theme control remains usable beside Explore');
      }
      await openCompactNavigation(f.page, surface);
      await nav.locator('[data-explore-direct="teams"]').click();
      await assertTeamsRoute(f.page, '', 'tm-rankings-title');
    } finally { await f.close(); }
  }

  console.log('Public routes: profile names, static Models history and catalog filters preserve native URL meaning…');
  {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      await open(f.page, '/u/teams'); await f.page.locator('#profile-shell').waitFor();
      assert.equal(await f.page.evaluate(() => state.view), 'players', 'A profile named teams remains a profile rather than matching the Teams route suffix');
      assert.equal(await f.page.evaluate(() => state.currentHandle), 'teams');
      assert.equal(await f.page.locator('.tm-page').count(), 0);
      assert.equal(await f.page.locator('[data-explore-direct="teams"]').getAttribute('aria-current'), null, 'The Teams destination is not falsely current on /u/teams');
      assert(f.requests.some(request => request.path === '/api/user/teams'), 'The route reads its intended public profile');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      await open(f.page, '/project/leaderboard.html');
      await f.page.locator('[data-explore-trigger="models"]').focus(); await f.page.keyboard.press('ArrowDown');
      await f.page.locator('[data-explore-panel] [data-explore-link="explorer"]').click();
      await f.page.locator('#mx-rows .mx-row').waitFor();
      assert.equal(new URL(f.page.url()).pathname, '/project/models/');
      assert.equal(await f.page.evaluate(() => document.baseURI), origin + '/project/', 'The app pins the static asset base before soft navigation changes its directory');
      await f.page.locator('[data-explore-trigger="community"]').focus(); await f.page.keyboard.press('ArrowDown');
      assert.equal(new URL(await f.page.locator('[data-explore-panel] [data-explore-link="team-standings"]').evaluate(node => node.href)).pathname, '/project/teams', 'Opening Community after a soft Models jump keeps the native Teams namespace');
      assert.equal(new URL(await f.page.locator('[data-explore-direct="teams"]').evaluate(node => node.href)).pathname, '/project/teams');
      await f.page.keyboard.press('Escape');
      await f.page.locator('[data-explore-trigger="models"]').focus(); await f.page.keyboard.press('ArrowDown');
      assert.equal(new URL(await f.page.locator('[data-explore-panel] [data-explore-link="explorer"]').evaluate(node => node.href)).pathname.replace(/\/$/, ''), '/project/models', 'Models does not grow another path segment after soft navigation');
      await f.page.keyboard.press('Escape');
      await f.page.locator('[data-explore-direct="workspace"]').click();
      await f.page.waitForFunction(() => state.view === 'dashboard');
      await f.page.goBack(); await f.page.waitForFunction(() => state.view === 'models');
      await f.page.locator('#mx-rows .mx-row').waitFor();
      assert.equal(new URL(f.page.url()).pathname, '/project/models/', 'Back recognizes Models beneath the preserved static site base');
      assert.equal(await f.page.locator('body').evaluate(node => node.classList.contains('th-flat')), true);
      await f.page.goForward(); await f.page.waitForFunction(() => state.view === 'dashboard');
      assert.equal(new URL(f.page.url()).pathname, '/project/leaderboard.html', 'Forward exits the mirrored Models route into the correct namespace');
      assert.equal(await f.page.locator('#discovery-header').isVisible(), false);
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      await open(f.page, '/leaderboard?period=week');
      assert.equal(await f.page.evaluate(() => state.period), 'week');
      await f.page.locator('[data-explore-trigger="community"]').focus(); await f.page.keyboard.press('ArrowDown');
      await f.page.locator('[data-explore-panel] [data-explore-link="rankings"]').click();
      await f.page.waitForFunction(() => state.view === 'leaderboard' && state.period === 'today');
      assert.equal(new URL(f.page.url()).searchParams.get('period'), null, 'The plain Individual rankings URL has its native default period');
      assert.equal(await f.page.locator('.community-periods [data-period="today"]').getAttribute('aria-pressed'), 'true', 'The rendered ranking period agrees with the plain destination URL');
      await f.page.waitForFunction(() => state.data != null);
      assert(f.requests.some(request => request.path === '/api/leaderboard' && new URLSearchParams(request.search).get('period') === 'today'), 'Returning from week invalidates its payload and reads the actual Today rankings');
    } finally { await f.close(); }
  }
  {
    const f = await fixture({ reducedMotion: 'reduce' });
    try {
      await open(f.page, '/models?provider=openai&plan=fixture-plan');
      await f.page.locator('#mx-rows .mx-row').waitFor();
      await f.page.locator('#mx-scopes [data-scope="local"]').click();
      await f.page.locator('#mx-caps [data-cap="vision"]').click();
      await f.page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('no matching model');
      await f.page.getByLabel('Sort models', { exact: true }).selectOption('name');
      await f.page.waitForFunction(() => mxState().query === 'no matching model');
      assert.deepEqual(await f.page.evaluate(() => ({ provider: mxState().provider, plan: mxState().planFilter, scope: mxState().scope, caps: [...mxState().caps], sort: mxState().sort })), { provider: 'openai', plan: 'fixture-plan', scope: 'local', caps: ['vision'], sort: 'name' });
      await f.page.locator('[data-explore-trigger="models"]').focus(); await f.page.keyboard.press('ArrowDown');
      await f.page.locator('[data-explore-panel] [data-explore-link="explorer"]').click();
      await f.page.locator('#mx-rows .mx-row').waitFor();
      const url = new URL(f.page.url());
      assert.equal(url.searchParams.get('provider'), null); assert.equal(url.searchParams.get('plan'), null);
      assert.deepEqual(await f.page.evaluate(() => ({ provider: mxState().provider, plan: mxState().planFilter, query: mxState().query, scope: mxState().scope, caps: [...mxState().caps], sort: mxState().sort })), { provider: 'all', plan: '', query: '', scope: 'all', caps: [], sort: 'featured' }, 'Plain Explorer resets retained provider, plan, search, scope, capability and sort filters');
      assert.equal(await f.page.getByRole('searchbox', { name: 'Search models', exact: true }).inputValue(), '');
      await f.page.goBack(); await f.page.waitForFunction(() => state.view === 'models' && mxState().planFilter === 'fixture-plan' && mxState().provider === 'openai');
      await f.page.goForward(); await f.page.waitForFunction(() => state.view === 'models' && mxState().planFilter === '' && mxState().provider === 'all');
      assert.equal(new URL(f.page.url()).searchParams.get('provider'), null, 'Forward to an unfiltered model URL cannot retain its previous provider');
      await f.page.locator('#mx-rows .mx-row').waitFor();
    } finally { await f.close(); }
  }

  console.log('Account navigation: Google and GitHub text remains readable across palettes, surfaces and missing theme overlays...');
  for (const provider of ['google', 'github']) {
    const f = await fixture({ user: { ...longUser, provider }, reducedMotion: 'reduce' });
    try {
      await open(f.page, '/leaderboard', true);
      for (const theme of ['light', 'dark']) {
        if (await f.page.locator('html').getAttribute('data-theme') !== theme) await f.page.locator('.th-theme-toggle:visible').click();
        for (const view of ['leaderboard', 'dashboard', 'leaderboard']) {
          if (view === 'dashboard') await f.page.locator('[data-explore-direct="workspace"]').click();
          else if (await f.page.evaluate(() => state.view === 'dashboard')) await f.page.locator('#nav [data-view="leaderboard"]').click();
          await f.page.waitForFunction(view => state.view === view, view); await settle(f.page);
          await f.page.mouse.move(1, 500); await assertAccountContrast(f.page);
          await f.page.locator('#user-chip').hover(); await assertAccountContrast(f.page);
        }
      }
      // The component itself must remain readable if a stale page or interrupted
      // stylesheet request leaves the semantic theme/surface overlays unavailable.
      await f.page.evaluate(() => document.querySelectorAll('link[href*="theme.css"],link[href*="surfaces.css"]').forEach(link => { link.disabled = true; }));
      await settle(f.page); await assertAccountContrast(f.page);
      await f.page.locator('[data-explore-direct="workspace"]').click();
      await f.page.waitForFunction(() => state.view === 'dashboard'); await settle(f.page);
      await f.page.mouse.move(1, 500); await assertAccountContrast(f.page);
      await f.page.locator('#user-chip').hover(); await assertAccountContrast(f.page);
    } finally { await f.close(); }
  }

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
          await assertExploreDestinations(f.page);
          for (const label of [/Docs/, /Workspace/, /GitHub/, /Install app/]) assert(await f.page.locator('#discovery-navigation > a').filter({ hasText: label }).count() > 0, 'Compact menus retain the existing ' + label + ' destination');
          if (user && width === 390) await f.page.screenshot({ path: '/tmp/token-horizon-nav-mobile.png', animations: 'disabled' });
          await f.page.locator('#discovery-menu-toggle').click(); await assertMenuClosed(f.page);
        }
        if (user && width === 1440) await f.page.screenshot({ path: '/tmp/token-horizon-nav-desktop.png', animations: 'disabled' });
      }
      // Mobile account views share the visible navigation and the same auth
      // slot. Desktop account views retain their sidebar and utility bar.
      await f.page.setViewportSize({ width: 390, height: 1000 }); await settle(f.page);
      await f.page.locator('#discovery-menu-toggle').focus(); await f.page.keyboard.press('Enter');
      await f.page.locator('[data-explore-direct="workspace"]').focus(); await f.page.keyboard.press('Enter');
      await f.page.waitForFunction(() => state.view === 'dashboard');
      assert.equal(await f.page.locator('#discovery-header').isVisible(), true);
      assert.equal(await f.page.evaluate(() => document.querySelector('#auth-slot').parentElement.id), 'discovery-actions', 'Mobile Workspace retains the same auth slot in its navigation');
      assert.equal(await f.page.locator(user ? '#user-chip' : '#signin-btn').isVisible(), true, 'Workspace retains the account control');
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'view', 'Keyboard navigation into Workspace focuses the visible content');
      await f.page.setViewportSize({ width: 1440, height: 1000 }); await settle(f.page);
      assert.equal(await f.page.locator('#discovery-header').isVisible(), false);
      assert.equal(await f.page.evaluate(() => document.querySelector('#auth-slot').parentElement.classList.contains('topbar')), true, 'Desktop Workspace retains its account utility bar');
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
      const toggle = f.page.locator('#discovery-menu-toggle'), models = f.page.locator('#discovery-navigation [data-explore-trigger="models"]'), community = f.page.locator('#discovery-navigation [data-explore-trigger="community"]');
      await toggle.focus(); await f.page.keyboard.press('Shift+Tab');
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'signin-btn', 'A hidden menu does not enter the keyboard tab order');
      await toggle.focus(); await f.page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await models.isVisible());
      assert.equal(await models.evaluate(node => node === document.activeElement), true, 'Opening navigation focuses its first operable Explore trigger');
      await f.page.keyboard.press('Escape'); await assertMenuClosed(f.page);
      assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'discovery-menu-toggle', 'Escape returns focus to the menu control');
      await f.page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      // The enhanced groups retain normal Tab order and their destinations
      // remain native links reachable without a mouse.
      await models.focus(); await f.page.keyboard.press('Tab');
      assert.equal(await community.evaluate(node => node === document.activeElement), true);
      await f.page.keyboard.press('Shift+Tab');
      assert.equal(await models.evaluate(node => node === document.activeElement), true);
      await f.page.keyboard.press('Enter');
      const explorer = f.page.locator('#discovery-navigation [data-explore-mobile="models"] [data-explore-link="explorer"]');
      await explorer.focus(); await explorer.press('Enter'); await f.page.waitForSelector('#mx-rows .mx-row');
      await assertMenuClosed(f.page); assert.equal(await f.page.evaluate(() => state.view), 'models');
      assert.equal(await explorer.getAttribute('aria-current'), 'page', 'The current Explorer destination retains its active route indication');
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
