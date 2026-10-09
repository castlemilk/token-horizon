import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { connectPage } from '../cloudflare/src/connect-page.js';
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
  league: 'silver', mmr: 620, streakDays: 3, costAll: 12.3,
  breakdown: { models: [{ model: 'fixture-model', provider: 'openai', tokensAll: 42000, requests: 12, costAll: 12.3 }], projects: [], sessions: [], daily: [], modelHistory: [] }
};
const catalog = { schemaVersion: 1, count: 1, providers: [], models: [
  { id: 'openai/fixture-model', name: 'Fixture Model', model: 'fixture-model', provider: 'openai', providerName: 'OpenAI', contextK: 128, inputPerM: 2, outputPerM: 8, capabilities: { toolCall: true } }
] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ user = null, width = 1440, reducedMotion = 'reduce', colorScheme = 'light', stored = null, blockedStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion, colorScheme });
  if (stored) await context.addInitScript(value => localStorage.getItem('th-theme') || localStorage.setItem('th-theme', value), stored);
  if (blockedStorage) await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
  const page = await context.newPage(), errors = [], unexpected = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    // The landing page resolves published installers without contacting GitHub in this fixture.
    if (request.method() === 'GET' && request.url() === 'https://api.github.com/repos/castlemilk/token-horizon/releases?per_page=20') return json(route, []);
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(){},renderButton(host,options){const button=document.createElement('button');button.type='button';button.textContent='Continue with fixture Google';button.style.width=options.width+'px';host.append(button)},cancel(){},disableAutoSelect(){}}}};` });
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { mutations.push(url.pathname); return json(route, { ok: false, error: 'Navigation fixtures do not mutate data.' }, 405); }
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: 'navigation-fixture.apps.googleusercontent.com', googleAuth: true, githubAuth: true, webSessions: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated: Boolean(user), user, expiresAt: user ? Date.now() + 86400000 : null });
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: user ? [{ handle: entry.handle, displayName: user.name }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: null, invites: [] });
    if (url.pathname === '/api/share/list') return json(route, { ok: true, shares: [], groups: [], activity: [] });
    if (url.pathname.startsWith('/api/user/')) return json(route, { ok: true, handle: entry.handle, entry, rank: 1, total: 1, ranks: { today: 1, week: 1, all: 1, streak: 1 }, rankHistory: [], achievements: [] });
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [{ rank: 1, score: 3000, scoreFormatted: '3k', costFormatted: '$1', league: 'silver', mmr: 620, percentile: 100, relativePercent: 100, entry }], total: 1, kpis: { totalTokens: 3000, totalCost: 1, activeDevs: 1, maxStreakDays: 3 }, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname === '/api/providers') return json(route, { ok: true, providers: [{ provider: 'openai', tokens: 42000, cost: 12.3, requests: 12, tokensFormatted: '42k', costFormatted: '$12.30' }], teams: [{ teamId: 'crew-fixture', team: 'The Horizon Collective', tokens: 42000, cost: 12.3, members: 1, users: [{ handle: 'aurora', tokensAll: 42000 }], providers: { openai: 42000 } }], history: { points: [], providers: [] } });
    if (url.pathname.startsWith('/api/shared/')) return json(route, { ok: true, report: { handle: entry.handle, tokensAll: 42000, tokensAllFormatted: '42k', streakDays: 3, updatedAt: entry.updatedAt, models: entry.breakdown.models }, share: { scope: 'public', options: {} } });
    if (url.pathname === '/api/season') return json(route, { ok: true, season: { id: '2026-Q4', number: 4, displayName: 'Season 4 — Zenith', start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z', progress: .1, daysRemaining: 82 }, standings: [{ handle: 'aurora', league: 'silver', leagueTitle: 'Silver', leagueColor: '#AEB6C4', tokensFormatted: '42k', mmr: 620, division: 2 }, { handle: 'nova', league: 'bronze', leagueTitle: 'Bronze', leagueColor: '#B0774B', tokensFormatted: '10k', mmr: 300, division: 1 }], distribution: [], rewards: [], climbers: [], promotions: [] });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    if (url.pathname === '/connect') return route.fulfill({ contentType: 'text/html', body: connectPage({}) });
    const relative = ['/leaderboard', '/leaderboard.html', '/models', '/models/', '/login'].includes(url.pathname) || (url.pathname.startsWith('/u/') || url.pathname.startsWith('/s/')) ? 'leaderboard.html' : url.pathname.endsWith('/') ? url.pathname.slice(1) + 'index.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, context, requests: mutations, async close() {
    await context.close();
    assert.deepEqual(errors, [], 'Navigation must not throw browser errors');
    assert.deepEqual(unexpected, [], 'Navigation fixtures must not contact other services');
    assert.deepEqual(mutations, [], 'Navigation must not mutate accounts or profile data');
  } };
}

// CSS theme changes must preserve data, focus, and mounted chart hosts.
const routes = [
  ['/', '.hero'], ['/leaderboard', '.discovery-title'],
  ['/leaderboard?view=teams', '#view h1'], ['/leaderboard?view=leagues', '.ladder'],
  ['/models', '#mx-rows'], ['/models?tab=cheapest', '#view h1'],
  ['/models?tab=providers', '#view h1'], ['/models?tab=plans', '#view h1'],
  ['/u/aurora', '#profile-shell'], ['/login', '#login-page'],
  ['/leaderboard?view=dashboard&user=aurora', '.th-workspace'],
  ['/s/public-fixture', '#view h1'], ['/leaderboard?view=billing', '#view h1'], ['/leaderboard?view=settings', '#view h1'],
  ['/docs/', '.docs-layout'], ['/blog/', '#site-nav'],
  ['/blog/why-token-horizon.html', '#site-nav'], ['/blog/pricing-evidence.html', '#site-nav'],
  ['/connect', '.connection']
];
const settle = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
async function assertHeaderSignIn(page, route) {
  const header = await page.evaluate(() => {
    const visible = element => Boolean(element?.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const publicHeader = document.body.matches('.landing, .reading-page') || location.pathname === '/connect';
    return {
      publicHeader, reading: document.body.matches('.reading-page'), connect: location.pathname === '/connect',
      width: innerWidth, height: innerHeight,
      signedIn: document.querySelector('#identity')?.hidden === false,
      accountSection: Boolean(document.querySelector('#connection-account #auth-options') && document.querySelector('#connection-account #identity')),
      authSlots: document.querySelectorAll('#auth-slot').length,
      authControls: [...document.querySelectorAll('#auth-slot #signin-btn, #auth-slot #user-chip')].map(element => element.tagName),
      menuStates: [...document.querySelectorAll('.menu-toggle, #nav-toggle')].filter(visible).map(element => element.getAttribute('aria-expanded')),
      actions: [...document.querySelectorAll('[data-nav-signin]')].map(element => {
        const rect = element.getBoundingClientRect(), labels = [...element.querySelectorAll('span[data-nav-signin-label]')];
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          tag: element.tagName, className: element.classList.contains('th-nav-signin'), href: element.getAttribute('href'),
          inHeader: Boolean(element.closest('header, #site-nav')), inCollapsedNav: Boolean(element.closest('#main-nav, #nav-links')),
          visible: visible(element), labels: labels.map(label => ({ text: label.textContent.trim(), visible: visible(label) })),
          icons: [...element.querySelectorAll('svg')].map(icon => ({ hidden: icon.getAttribute('aria-hidden'), focusable: icon.getAttribute('focusable'), tabIndex: icon.tabIndex })),
          rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          centerClickable: hit === element || element.contains(hit)
        };
      })
    };
  });
  if (!header.publicHeader) {
    assert.equal(header.actions.length, 0, route + ': SPA keeps its existing account control');
    assert.equal(header.authSlots, 1, route + ': exactly one SPA auth slot');
    assert.deepEqual(header.authControls, ['BUTTON'], route + ': auth slot retains its native Sign in or account button');
    return;
  }
  assert.equal(header.actions.length, 1, route + ': exactly one header Sign in action');
  const action = header.actions[0];
  assert.equal(action.tag, 'A', route + ': header Sign in uses native link semantics');
  assert(action.className && action.inHeader && !action.inCollapsedNav, route + ': Sign in remains outside collapsed navigation');
  assert(action.visible, route + ': header Sign in remains visible');
  assert.deepEqual(action.labels, [{ text: header.connect && header.signedIn ? 'Your account' : 'Sign in', visible: true }], route + ': Sign in has one visible text label');
  assert.equal(await page.getByRole('link', { name: action.labels[0].text, exact: true }).evaluateAll(links => links.filter(link => link.matches('a.th-nav-signin[data-nav-signin]')).length), 1, route + ': visible Sign in label is the accessible name');
  assert.equal(action.icons.length, 1, route + ': Sign in has one decorative SVG');
  assert(action.icons[0].hidden === 'true' && [null, 'false'].includes(action.icons[0].focusable) && action.icons[0].tabIndex < 0, route + ': Sign in SVG is decorative and excluded from tab order');
  assert.equal(action.href, header.connect ? '#connection-account' : header.reading ? '../login/' : './login/', route + ': Sign in points to the account destination');
  if (header.connect) assert(header.accountSection, route + ': Connect account anchor contains sign-in options and identity');
  assert(action.rect.width >= 44 && action.rect.height >= 44, route + ': Sign in has a 44px touch target');
  assert(action.rect.x >= 0 && action.rect.y >= 0 && action.rect.right <= header.width && action.rect.bottom <= header.height, route + ': Sign in stays inside the viewport');
  assert(action.centerClickable, route + ': Sign in center receives pointer input');
  assert(header.menuStates.every(state => state === 'false'), route + ': Sign in is reachable with the header menu closed');
}
async function assertPage(page, expected, route) {
  const ui = await page.evaluate(() => {
    const html = document.documentElement;
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const buttons = [...document.querySelectorAll('[data-theme-control] button')].filter(visible);
    return { theme: html.dataset.theme, scheme: getComputedStyle(html).colorScheme, width: html.scrollWidth, viewport: innerWidth,
      bodyBackground: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color,
      buttons: buttons.map(b => ({ label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), rect: { x: b.getBoundingClientRect().x, right: b.getBoundingClientRect().right, width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height } })) };
  });
  assert.equal(ui.theme, expected, route + ': correct palette');
  assert.equal(ui.scheme, expected, route + ': native controls follow palette');
  assert(ui.width <= ui.viewport + 1, route + ': overflow ' + JSON.stringify(ui));
  assert.equal(ui.buttons.length, 1, route + ': exactly one visible theme control');
  assert.equal(ui.buttons[0].label, expected === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  assert(ui.buttons[0].rect.width >= 44 && ui.buttons[0].rect.height >= 44, 'Theme touch target');
  assert(ui.buttons[0].rect.x >= 0 && ui.buttons[0].rect.right <= ui.viewport, route + ': reachable toggle');
  assert.notEqual(ui.bodyBackground, ui.bodyColor, route + ': content visible');
  await assertHeaderSignIn(page, route);
  if (ui.viewport <= 560 && ['dashboard', 'billing', 'settings', 'shared'].includes(await page.evaluate(() => document.body.dataset.surface))) {
    assert(await page.locator('body.mobile-shell').count(), route + ': account surface uses mobile navigation');
    assert(await page.locator('.sidebar').isHidden(), route + ': desktop sidebar yields to mobile navigation');
    assert(await page.locator('#discovery-menu-toggle').isVisible(), route + ': account navigation remains reachable');
    const header = await page.locator('#discovery-header').boundingBox();
    assert(header && header.height <= 120, route + ': closed account header leaves room for content');
  }
}
try {
  console.log('Themes: all public, account, docs and connector views in both palettes at desktop and 320px...');
  for (const width of [1440, 320]) {
    const f = await fixture({ width });
    try {
      for (const [route, selector] of routes) {
        await f.page.goto(origin + route, { waitUntil: 'domcontentloaded' });
        await f.page.waitForSelector(selector); await settle(f.page);
        const initial = await f.page.evaluate(() => document.documentElement.dataset.theme);
        await assertPage(f.page, initial, route);
        if (route === '/leaderboard?view=leagues') {
          await f.page.locator('button.tier[data-league="silver"]').click();
          await f.page.waitForFunction(() => state.leagueFilter === 'silver' && document.querySelector('button.tier[data-league="silver"]')?.getAttribute('aria-pressed') === 'true');
          await f.page.waitForFunction(() => !document.querySelector('#view table tbody')?.textContent.includes('nova'));
          assert.match(await f.page.locator('#view table tbody').innerText(), /aurora/);
          await f.page.locator('button.tier[data-league="silver"]').click();
          await f.page.waitForFunction(() => document.querySelector('#view table tbody')?.textContent.includes('nova'));
        }
        const shot = ['/', '/leaderboard?view=teams', '/models', '/u/aurora', '/login', '/leaderboard?view=dashboard&user=aurora', '/leaderboard?view=leagues', '/docs/', '/connect'].includes(route);
        const name = route === '/' ? 'landing' : route.replace(/[/?=&]/g, '-');
        if (shot) await f.page.screenshot({ path: `/tmp/th-theme-${name}-${width}-${initial}.png`, fullPage: false, animations: 'disabled' });
        const before = await f.page.evaluate(() => ({ renders: typeof perf === 'object' ? perf.renders : null, mounts: typeof perf === 'object' ? perf.chartMounts : null }));
        await f.page.getByRole('button', { name: initial === 'light' ? 'Switch to dark mode' : 'Switch to light mode', exact: true }).click();
        await settle(f.page);
        const next = initial === 'light' ? 'dark' : 'light'; await assertPage(f.page, next, route);
        const after = await f.page.evaluate(() => ({ renders: typeof perf === 'object' ? perf.renders : null, mounts: typeof perf === 'object' ? perf.chartMounts : null }));
        assert.deepEqual(after, before, route + ': switching theme does not render or remount data charts');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('th-theme')), next);
        if (shot) await f.page.screenshot({ path: `/tmp/th-theme-${name}-${width}-${next}.png`, fullPage: false, animations: 'disabled' });
      }
    } finally { await f.close(); }
  }
  console.log('Themes: system default, stored preference, reload, keyboard, cross-tab and blocked storage...');
  for (const options of [{ colorScheme: 'dark' }, { colorScheme: 'dark', stored: 'light' }, { colorScheme: 'light', stored: 'dark' }, { colorScheme: 'dark', blockedStorage: true }]) {
    const f = await fixture(options);
    try {
      await f.page.goto(origin + '/leaderboard'); await f.page.waitForSelector('.discovery-title');
      const initial = options.stored || options.colorScheme;
      await assertPage(f.page, initial, 'preference');
      const button = f.page.getByRole('button', { name: initial === 'light' ? 'Switch to dark mode' : 'Switch to light mode', exact: true });
      await button.focus(); await f.page.keyboard.press('Enter');
      await assertPage(f.page, initial === 'light' ? 'dark' : 'light', 'keyboard');
      assert.equal(await f.page.evaluate(() => document.activeElement?.matches('[data-theme-control] button')), true, 'Keyboard focus preserved');
      if (!options.blockedStorage) {
        await f.page.reload(); await f.page.waitForSelector('.discovery-title');
        await assertPage(f.page, initial === 'light' ? 'dark' : 'light', 'reload');
        const other = await f.context.newPage();
        await other.goto(origin + '/docs/'); await other.waitForSelector('[data-theme-control] button');
        if (await other.evaluate(() => document.documentElement.dataset.theme) !== 'light') await other.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
        await f.page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        await assertPage(f.page, 'light', 'other tab'); await other.close();
      }
      assert.equal(await f.page.locator('[data-theme-control] button').first().evaluate(b => getComputedStyle(b).animationName), 'none', 'Reduced motion toggle is static');
    } finally { await f.close(); }
  }
  console.log('Theme UI: all assertions passed.');
} finally { await browser.close(); }
