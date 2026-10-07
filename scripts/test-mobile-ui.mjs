import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectPage } from '../cloudflare/src/connect-page.js';
import { resolveChromium } from './playwright.mjs';

// Real repository HTML/CSS/modules, isolated public and account snapshots.
// No provider login, account mutation, production request, or native app launch.
const ORIGIN = 'https://token-horizon.dev', ROOT = path.resolve('docs');
const TEAM_ID = 'b'.repeat(32), INVITE = 'a'.repeat(48);
const day = Math.floor(Date.now() / 86400000) * 86400;
const longName = 'InterstellarObservabilityAndModelOptimisationCollective';
const user = { provider: 'github', sub: 'fixture', login: 'aurora', name: longName, email: 'aurora.alexandria@interstellar-observability.example.test', picture: '' };
const daily = Array.from({ length: 30 }, (_, i) => ({ day: day - (29 - i) * 86400, tokens: (i + 1) * 1000 }));
const publishedModels = Array.from({ length: 12 }, (_, i) => ({ provider: i % 2 ? 'openai' : 'anthropic', model: `observatory-model-${String(i).padStart(3, '0')}-long-context-reasoning`, tokensAll: (12 - i) * 10000, costAll: (12 - i) * 1.75, inputTokens: 42000, outputTokens: 18000, requests: 30 + i }));
const entry = { id: 'fixture:aurora', handle: 'aurora', displayName: longName, claimed: true, ownerId: 'github:fixture', team: longName, teamId: TEAM_ID, tokensAll: 780000, tokensToday: 30000, tokens7d: 210000, costAll: 136.5, requestsAll: 720, inputTokensAll: 420000, outputTokensAll: 360000, updatedAt: Date.now() / 1000, streakDays: 30, league: 'silver', mmr: 620, avatarStyle: 'identicon', breakdown: {
  models: publishedModels, daily, modelHistory: [{ provider: 'anthropic', model: publishedModels[0].model, points: daily.map(d => ({ ...d })) }],
  sessions: [{ at: day + 3600, title: '', model: publishedModels[0].model, provider: 'anthropic', tokens: 18000, cost: 1.75, requests: 2 }],
  projects: [{ project: longName, tokens: 780000, cost: 136.5, sessions: 12 }], tools: [{ tool: 'codex', tokens: 780000 }], hourly: Array.from({ length: 7 }, () => Array(24).fill(0))
} };
const team = { id: TEAM_ID, name: longName, role: 'owner', memberCount: 18 };
const teams = Array.from({ length: 6 }, (_, i) => ({ team: i ? longName + i : 'Aurora', teamId: i ? String(i).repeat(32) : TEAM_ID, tokens: 780000 - i * 20000, tokensToday: 30000, tokens7d: 210000, cost: 136.5, members: 12, memberCount: 18, users: [{ handle: 'aurora', tokensAll: 780000 }], providers: { openai: 390000, anthropic: 390000 }, daily: daily.map(d => ({ ...d, tokens: d.tokens * (i + 1) })) }));
const catalogModels = Array.from({ length: 160 }, (_, i) => ({ id: `openai/mobile-model-${String(i).padStart(3, '0')}`, name: `Observatory model ${String(i).padStart(3, '0')} — long context reasoning`, model: `mobile-model-${String(i).padStart(3, '0')}`, provider: 'openai', providerName: 'OpenAI', contextK: 128 + i, inputPerM: 1 + i / 100, outputPerM: 3 + i / 100, category: 'balanced', featured: true, sourceProviders: ['openai'], capabilities: { toolCall: true, reasoning: true, vision: true }, benchmarks: { swe: 70, lcb: 65 }, description: 'A published catalog fixture with a realistic name, pricing and capability details.', ...(i === 0 ? { plans: ['fixture-plan'], plan: 'fixture-plan' } : {}) }));
catalogModels.at(-1).name = 'Zirconarium reference model159';
const catalog = { schemaVersion: 1, count: catalogModels.length, catalogCount: catalogModels.length, models: catalogModels, providers: [{ id: 'openai', name: 'OpenAI', models: 160 }], plans: [{ id: 'fixture-plan', providers: ['openai'], name: 'Observatory coding subscription', summary: 'Published monthly plan coverage.', billing: 'monthly', modelCount: 1, tiers: [{ name: 'Pro', priceMonthly: 20, currency: 'USD', usage: 'Monthly AI credit allowance', models: 'Selected reasoning models', features: ['Long context'] }] }] };
// The same model family can be published through multiple providers. Display
// labels may match; the chart's internal stack identity must remain distinct.
const communityHistory = { labels: daily.map(d => new Date(d.day * 1000).toISOString().slice(0, 10)), series: [{ provider: 'openai', model: 'shared-reasoning-model', values: daily.map(() => 1000) }, { provider: 'anthropic', model: 'shared-reasoning-model', values: daily.map(() => 2000) }] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGN4G+r3Hx9mGBkKAG8Uo8FWIl3AAAAAAElFTkSuQmCC', 'base64');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.avif': 'image/avif', '.ico': 'image/x-icon' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const failures = [];
async function check(label, action) {
  try { await action(); }
  catch (error) { failures.push(label + ': ' + error.message); console.error('FAIL ' + failures.at(-1)); }
}

async function fixture(width, theme, { charts = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
  await context.addInitScript(theme => { localStorage.setItem('th-theme', theme); }, theme);
  const page = await context.newPage(), errors = [], requests = [], unexpected = [], mutations = [];
  let authenticated = false;
  page.on('pageerror', e => errors.push(e.message));
  const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === 'https://accounts.google.com') return route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(){},renderButton(host,options){const b=document.createElement('button');b.type='button';b.textContent='Continue with fixture Google';b.style.width=options.width+'px';b.style.height='44px';host.append(b)},cancel(){},disableAutoSelect(){}}}};` });
    if (url.origin === 'https://api.github.com' && url.pathname === '/repos/castlemilk/token-horizon/releases') return json(route, [{ tag_name: 'v0.3.20', published_at: '2026-10-07T00:00:00Z', draft: false, prerelease: false, assets: [] }]);
    if (url.origin !== ORIGIN) { unexpected.push(req.url()); return route.abort(); }
    requests.push({ path: url.pathname, method: req.method() });
    const connectionListRead = url.pathname === '/oauth/connections' && req.method() === 'POST' && new URLSearchParams(req.postData()).get('action') === 'list';
    if (!['GET', 'HEAD'].includes(req.method()) && !connectionListRead) { mutations.push(url.pathname); return json(route, { error: 'Mobile fixtures never mutate accounts.' }, 405); }
    if (!charts && url.pathname === '/vendor/tanstack-charts.js') return route.fulfill({ contentType: 'application/javascript', body: '/* Optional chart vendor unavailable. */' });
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: 'mobile-fixture.apps.googleusercontent.com', googleAuth: true, githubAuth: true, webSessions: true, canonicalUrl: ORIGIN });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated, user: authenticated ? user : null, expiresAt: authenticated ? Date.now() + 86400000 : null });
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: authenticated ? [{ handle: 'aurora', displayName: longName }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: authenticated ? team : null, invites: [] });
    if (url.pathname === '/api/team/' + TEAM_ID) return json(route, { ok: true, team, stats: { ...teams[0], publishedProfiles: 12, daily } });
    if (url.pathname === '/api/team/invites/' + INVITE) return json(route, { ok: true, team, expiresAt: Date.now() + 86400000 });
    if (url.pathname === '/api/team/invites/' + 'e'.repeat(48)) return json(route, { code: 'invite_revoked', error: 'This invite has been retired. Ask for a fresh link.' }, 410);
    if (url.pathname === '/api/share/list') return json(route, { ok: true, shares: [{ id: 'mobile-report', scope: 'people', audience: [user.email], createdAt: day, expiresAt: day + 86400 * 30 }], groups: [{ id: 'mobile-group', name: longName, members: [{ handle: 'aurora' }] }], activity: [{ handle: 'aurora', action: 'shared', scope: 'people', audience: [user.email], at: day }] });
    if (url.pathname.startsWith('/api/user/')) {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      if (handle === 'missing-profile') return json(route, { error: 'Profile not found.' }, 404);
      return json(route, { ok: true, handle, entry: { ...entry, handle }, rank: 1, total: 12, ranks: { today: 1, week: 1, all: 1, streak: 1 }, achievements: [{ id: 'century', title: 'Century Club', detail: '100 published requests', icon: '💬' }], rankHistory: [], standing: { league: 'silver', division: 2, mmr: 620, progressWithinLeague: .5 } });
    }
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [{ rank: 1, score: 30000, scoreFormatted: '30k', costFormatted: '$5', league: 'silver', mmr: 620, percentile: 100, relativePercent: 100, entry }], total: 1, period: url.searchParams.get('period') || 'today', kpis: { totalTokens: 30000, totalCost: 5, activeDevs: 1, maxStreakDays: 30 }, movers: { gains: [], improved: [] }, usageHistory: communityHistory });
    if (url.pathname === '/api/providers') return json(route, { ok: true, providers: [{ provider: 'openai', tokens: 390000, tokensFormatted: '390k', cost: 60, costFormatted: '$60', requests: 360 }, { provider: 'anthropic', tokens: 390000, tokensFormatted: '390k', cost: 76.5, costFormatted: '$76.50', requests: 360 }], teams, history: { providers: ['openai'], points: daily.map(d => ({ date: new Date(d.day * 1000).toISOString().slice(0, 10), values: { openai: d.tokens } })) } });
    if (url.pathname.startsWith('/api/shared/')) {
      if (url.pathname.endsWith('/locked')) return json(route, { code: 'sign_in_required', error: 'Sign in to view this report.' }, 401);
      if (url.pathname.endsWith('/expired')) return json(route, { error: 'This report has expired.' }, 410);
      return json(route, { ok: true, share: { scope: 'public', options: {} }, report: { handle: 'aurora', tokensAll: entry.tokensAll, tokensAllFormatted: '780k', streakDays: 30, updatedAt: entry.updatedAt, models: publishedModels.map(m => ({ ...m, sharePercent: m.tokensAll / entry.tokensAll * 100 })), daily, modelHistory: entry.breakdown.modelHistory } });
    }
    if (url.pathname.startsWith('/api/og/')) return route.fulfill({ contentType: 'image/png', body: PNG });
    if (url.pathname === '/api/season') return json(route, { ok: true, season: { id: '2026-Q4', number: 4, displayName: 'Season 4 — Zenith', start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z', progress: .1, daysRemaining: 82 }, standings: [{ handle: 'aurora', league: 'silver', leagueTitle: 'Silver', leagueColor: '#AEB6C4', tokensFormatted: '780k', mmr: 620, division: 2 }], distribution: [], rewards: [], climbers: [], promotions: [] });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [{ provider: 'openai', model: 'mobile-model-000', tokensAll: 780000, users: 1 }] });
    if (url.pathname === '/oauth/connections') return json(route, { connections: authenticated ? [{ id: 'fixture-grant', name: longName, destination: 'localhost:8765', scope: ['account:read'] }] : [], cursor: null });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    if (url.pathname === '/connect' || url.pathname === '/oauth/authorize') return route.fulfill({ contentType: 'text/html', body: connectPage({ mode: url.pathname === '/connect' ? 'connect' : 'authorize', clientId: 'mobile-fixture', handle: 'fixture-nonce', clientName: longName, redirect: 'localhost:4567/callback/observatory', githubAuth: true, webSessions: true }) });
    const spa = ['/leaderboard', '/leaderboard.html', '/teams', '/teams/', '/models', '/models/', '/login'].includes(url.pathname) || /^\/(u|s|t|invite)\//.test(url.pathname);
    const relative = spa ? 'leaderboard.html' : url.pathname === '/' ? 'index.html' : url.pathname.endsWith('/') ? url.pathname.slice(1) + 'index.html' : url.pathname.slice(1);
    const file = path.resolve(ROOT, relative);
    if (!file.startsWith(ROOT + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (spa) body = Buffer.from(body.toString().replace('<head>', '<head><base href="/"/>'));
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, requests, setAuthenticated(value) { authenticated = value; }, async close() {
    await context.close();
    assert.deepEqual(errors, [], 'Mobile routes must not throw browser errors');
    assert.deepEqual(unexpected, [], 'Mobile fixtures never contact external services');
    assert.deepEqual(mutations, [], 'Opening and inspecting mobile screens never mutates accounts');
  } };
}

const settle = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
async function open(page, route, selector) { await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' }); await page.locator(selector).first().waitFor(); await settle(page); }
async function fit(page, label, theme) {
  const dimensions = await page.evaluate(() => {
    const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[inert]');
    const fields = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,textarea')].filter(visible).map(e => {
      const r = e.getBoundingClientRect(); return { name: e.getAttribute('aria-label') || e.id || e.name, left: r.left, right: r.right, width: r.width };
    });
    const outliers = document.documentElement.scrollWidth > innerWidth + 1 ? [...document.querySelectorAll('main,section,article,aside,div,h1,h2,h3,p,nav,button,summary')].filter(visible).map(e => ({ node: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + String(e.className).split(/\s+/).join('.'), left: Math.round(e.getBoundingClientRect().left), right: Math.round(e.getBoundingClientRect().right), width: Math.round(e.getBoundingClientRect().width) })).filter(r => r.right > innerWidth + 1 && r.width > 0).sort((a, b) => b.right - a.right).slice(0, 10) : [];
    return { width: innerWidth, scroll: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme, fields, outliers };
  });
  assert.equal(dimensions.theme, theme, label + ': selected theme');
  assert(dimensions.scroll <= dimensions.width + 1, label + ': page overflow ' + JSON.stringify(dimensions));
  for (const field of dimensions.fields) assert(field.width > 0 && field.left >= -1 && field.right <= dimensions.width + 1, label + ': input fits ' + JSON.stringify(field));
}
async function touch(page, selector, label, { required = true } = {}) {
  const controls = page.locator(selector), found = [];
  for (let i = 0; i < await controls.count(); i++) {
    const control = controls.nth(i);
    if (!await control.isVisible()) continue;
    const r = await control.boundingBox(); found.push(r);
    assert(r.width >= 43.5 && r.height >= 43.5, label + ': primary touch target ' + JSON.stringify({ text: await control.innerText().catch(() => ''), ...r }));
  }
  if (required) assert(found.length > 0, label + ': primary controls exist');
}
async function accountHeader(page, route) {
  const publicHeader = ['/', '/docs/', '/blog/', '/blog/why-token-horizon.html', '/blog/pricing-evidence.html', '/connect', '/connect/', '/oauth/authorize'].includes(route);
  const link = page.locator('a.th-nav-signin[data-nav-signin]');
  if (!publicHeader) {
    assert.equal(await link.count(), 0, route + ': SPA retains its existing authentication control');
    assert.equal(await page.locator('#auth-slot').count(), 1, route + ': SPA has one authentication slot');
    assert.equal(await page.locator('#auth-slot #signin-btn,#auth-slot #user-chip').count(), 1, route + ': one authoritative Sign in or account button');
    return;
  }
  assert.equal(await link.count(), 1, route + ': one persistent public account link');
  assert.equal(await link.isVisible(), true, route + ': Sign in stays visible with closed navigation');
  assert.equal(await page.getByRole('link', { name: 'Sign in', exact: true }).count(), 1, route + ': account link retains its accessible text');
  assert.equal(await link.locator('[data-nav-signin-label]').innerText(), 'Sign in', route + ': label remains visible on phones');
  const data = await link.evaluate(node => {
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { outsideMenu: !node.closest('#main-nav,#nav-links'), left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: innerWidth, reachable: node.contains(hit), href: node.getAttribute('href') };
  });
  assert(data.outsideMenu && data.reachable && data.left >= -1 && data.right <= data.viewport + 1 && data.top >= 0 && data.bottom < 180, route + ': primary account link fits the initial header ' + JSON.stringify(data));
  await touch(page, '[data-nav-signin]', route + ' Sign in');
  if (['/connect', '/connect/', '/oauth/authorize'].includes(route)) {
    assert.equal(data.href, '#connection-account');
    assert.equal(await page.locator('#connection-account #auth-options,#connection-account #identity').count(), 2, 'The connector account anchor survives authentication');
  } else assert.equal(new URL(await link.evaluate(node => node.href)).pathname, '/login/', route + ': canonical native login destination');
}
async function tables(page, label) {
  // Only tables that genuinely overflow horizontally need a scroll region.
  // Inline links inside data cells deliberately are not blanket 44px targets.
  const handles = await page.locator('table:visible').elementHandles();
  for (const table of handles) {
    const region = await table.evaluateHandle(table => {
      for (let e = table.parentElement; e && e !== document.body; e = e.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 2) return e;
      }
      return null;
    });
    const element = region.asElement();
    if (!element) { await region.dispose(); continue; }
    const data = await element.evaluate(e => ({ label: e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ').trim(), role: e.getAttribute('role'), tab: e.tabIndex, width: e.clientWidth, scroll: e.scrollWidth }));
    assert.equal(data.role, 'region', label + ': overflowing table is a region'); assert(data.label, label + ': table scroll region has a name'); assert.equal(data.tab, 0, label + ': table scroll region accepts keyboard focus');
    await element.evaluate(e => { e.scrollLeft = 0; e.focus(); });
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    try { await page.waitForFunction(e => e.scrollLeft > 0, element, { timeout: 2000 }); }
    catch {
      const after = await element.evaluate(e => ({ connected: e.isConnected, focused: e === document.activeElement, left: e.scrollLeft, width: e.clientWidth, scroll: e.scrollWidth, overflow: getComputedStyle(e).overflowX }));
      assert.fail(label + ': ArrowRight scrolls ' + data.label + ' ' + JSON.stringify(after));
    }
    assert.equal(await page.evaluate(() => scrollX), 0, label + ': keyboard scroll stays inside table');
    await element.evaluate(e => { e.scrollLeft = e.scrollWidth; });
    assert(await element.evaluate(e => e.scrollLeft + e.clientWidth >= e.scrollWidth - 2), label + ': final columns reachable');
    await region.dispose();
  }
}
async function modal(page, selector, label, theme) {
  const box = page.locator(selector); await box.waitFor(); await settle(page); await fit(page, label, theme);
  assert(await box.evaluate(e => e.scrollWidth <= e.clientWidth + 1), label + ': dialog content fits');
  const rect = await box.boundingBox(); assert(rect.x >= -1 && rect.x + rect.width <= (await page.evaluate(() => innerWidth)) + 1, label + ': dialog fits viewport');
  await touch(page, `${selector} button[data-close],${selector} button.x,${selector} .modal-foot button`, label);
}
async function focusedChoice(page, selector, label) {
  const choice = page.locator(selector);
  const data = await choice.evaluate(e => {
    const r = e.getBoundingClientRect(), strip = e.parentElement.getBoundingClientRect();
    return { focused: e === document.activeElement, left: r.left, right: r.right, minimum: Math.max(0, strip.left), maximum: Math.min(innerWidth, strip.right) };
  });
  assert(data.focused, label + ': activation preserves focus');
  assert(data.left >= data.minimum - 1 && data.right <= data.maximum + 1, label + ': focused selected control stays visible ' + JSON.stringify(data));
}
async function navigation(page, label, theme) {
  const menu = page.locator('.menu-toggle:visible,#discovery-menu-toggle:visible,#nav-toggle:visible').first();
  if (!await menu.count()) return;
  await touch(page, '.menu-toggle:visible,#discovery-menu-toggle:visible,#nav-toggle:visible', label + ' menu');
  await menu.focus(); await page.keyboard.press('Enter');
  assert.equal(await menu.getAttribute('aria-expanded'), 'true', label + ': keyboard opens menu');
  if (await page.locator('body.mobile-shell').count()) {
    for (const view of ['billing', 'settings']) {
      const link = page.locator(`[data-explore-direct="${view}"]:visible`); assert(await link.count(), label + ': private menu exposes ' + view);
      await touch(page, `[data-explore-direct="${view}"]:visible`, label + ' ' + view);
      const destination = new URL(await link.getAttribute('href'), page.url()); assert.equal(destination.searchParams.get('view'), view); assert.equal(destination.pathname, '/leaderboard.html');
    }
  }
  const community = page.locator('[data-explore-trigger="community"]:visible').first();
  if (await community.count()) {
    await community.focus(); await page.keyboard.press('Enter');
    assert.equal(await community.getAttribute('aria-expanded'), 'true', label + ': mobile group opens');
    await touch(page, '[data-explore-mobile="community"] a:visible,[data-explore-trigger]:visible', label + ' navigation');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement?.closest('[data-explore-mobile="community"]') !== null), label + ': Tab enters inline links');
    await page.keyboard.press('Escape');
    assert.equal(await community.getAttribute('aria-expanded'), 'false', label + ': Escape collapses group');
    assert(await community.evaluate(e => e === document.activeElement), label + ': group focus restored');
  }
  await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false', label + ': Escape closes menu');
  await fit(page, label + ' closed navigation', theme);
}

const routes = [
  ['/', '.hero'], ['/docs/', '.docs-layout'], ['/blog/', '#site-nav'], ['/blog/why-token-horizon.html', '#site-nav'], ['/blog/pricing-evidence.html', '#site-nav'],
  ['/connect', '.connection'], ['/connect/', '.connection'], ['/oauth/authorize', '#consent-form'],
  ['/leaderboard', '.discovery-title'], ['/leaderboard?view=leagues', '.ladder'], ['/teams', '.tm-page'], ['/t/' + TEAM_ID, '.tm-team-page'],
  ['/models', '#mx-rows .mx-row'], ['/models?tab=cheapest', '.mx-cheap-table'], ['/models?tab=providers', '[data-models-tab="providers"][aria-selected="true"]'], ['/models?tab=plans', '[data-models-tab="plans"][aria-selected="true"]'],
  ['/u/aurora', '#profile-shell'], ['/u/missing-profile', '.pf-load-error'], ['/login', '#login-page'], ['/invite/' + INVITE, '[data-ti-join]'], ['/invite/' + 'e'.repeat(48), '.ti-invite-page'],
  ['/leaderboard?view=dashboard', '[data-tw-handle]'], ['/leaderboard?view=dashboard&user=aurora', '[data-tw-tab="overview"]'], ['/leaderboard?view=billing', '#view h1'], ['/leaderboard?view=settings', '#settings-signin'],
  ['/s/public-mobile', '#view h1'], ['/s/expired', '#view h1']
];

async function interactive(f, width, theme) {
  const p = f.page;
  await check(`${width}px ${theme} catalog interactions`, async () => {
  await open(p, '/models', '#mx-rows .mx-row');
  await touch(p, '#mx-filter-toggle,#mx-q,#mx-sort,[data-models-tab]', 'Catalog controls');
  await p.locator('#mx-filter-toggle').focus(); await p.keyboard.press('Enter');
  assert.equal(await p.locator('#mx-filter-toggle').getAttribute('aria-expanded'), 'true');
  await touch(p, '#mx-scopes [data-scope],#mx-caps [data-cap],#mx-clear', 'Catalog filters'); await fit(p, 'Open catalog filters', theme);
  await p.locator('#mx-q').fill('Zirconarium');
  try { await p.waitForFunction(() => document.querySelectorAll('#mx-rows .mx-row').length === 1, null, { timeout: 5000 }); }
  catch { assert.fail('Catalog search isolates model159: ' + await p.locator('#mx-shown').innerText()); }
  await p.locator('#mx-rows .mx-row').first().scrollIntoViewIfNeeded(); await settle(p);
  assert.match(await p.locator('#mx-rows').innerText(), /159/);
  await p.locator('#mx-q').fill(''); await p.waitForFunction(() => document.querySelectorAll('#mx-rows .mx-row').length > 1, null, { timeout: 5000 });
  assert(await p.locator('#mx-rows .mx-row').count() < catalogModels.length / 2, 'Catalog windowing remains bounded on mobile');
  await touch(p, '#mx-rows .mx-compare-target', 'Catalog comparison targets');
  await p.locator('#mx-rows [data-compare]').nth(0).check(); await p.locator('#mx-rows [data-compare]').nth(1).check();
  await fit(p, 'Model comparison tray', theme); await touch(p, '#mx-compare-open,#mx-compare-clear,[data-uncompare]', 'Model comparison tray');
  await p.locator('#mx-compare-open').click(); await p.locator('#mx-comparison').waitFor(); await fit(p, 'Model comparison dialog', theme); await touch(p, '#mx-comparison-close', 'Model comparison close'); await tables(p, 'Model comparison');
  await p.keyboard.press('Escape'); await p.locator('#mx-comparison').waitFor({ state: 'detached' }); assert(await p.locator('#mx-compare-open').evaluate(e => e === document.activeElement), 'Comparison restores keyboard focus');
  await p.locator('#mx-compare-clear').click();
  await p.locator('#mx-sort').selectOption('name');
  await p.locator('#mx-scroll').scrollIntoViewIfNeeded();
  await p.locator('#mx-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); });
  try { await p.waitForFunction(() => document.querySelector('#mx-rows')?.textContent.includes('159'), null, { timeout: 5000 }); }
  catch { assert.fail('Catalog final virtual row is reachable: ' + JSON.stringify(await p.locator('#mx-scroll').evaluate(e => ({ top: e.scrollTop, height: e.clientHeight, scroll: e.scrollHeight, text: e.textContent.slice(-180) })))); }
  const heights = await p.locator('#mx-rows .mx-row').evaluateAll(rows => rows.map(e => e.getBoundingClientRect().height));
  assert(heights.every(h => Math.abs(h - heights[0]) < 1), 'Virtual rows retain consistent measured heights');
  const last = p.locator('#mx-rows .mx-row').last(); await last.focus(); await p.keyboard.press('Enter'); await p.locator('#mx-drawer.open').waitFor();
  await fit(p, 'Model drawer', theme); await touch(p, '#mx-drawer-close', 'Model drawer close');
  assert(await p.locator('#mx-drawer .mx-drawer-scroll').evaluate(e => e.clientHeight > 0 && e.scrollHeight > e.clientHeight), 'Detailed model drawer scrolls vertically');
  await p.locator('#mx-drawer-close').focus(); await p.keyboard.press('Shift+Tab');
  assert(await p.evaluate(() => document.activeElement?.closest('#mx-drawer.open') !== null), 'Drawer keeps backward keyboard focus inside');
  await p.keyboard.press('Escape'); assert.equal(await p.locator('#mx-drawer.open').count(), 0); assert(await p.locator('#mx-q').evaluate(e => e === document.activeElement), 'Drawer restores catalog focus');
  });

  await check(`${width}px ${theme} profile interactions`, async () => {
  await open(p, '/u/aurora', '#profile-shell'); await touch(p, '.profile-tabs [role="tab"],[data-share-profile],[data-share-user]', 'Profile actions');
  await p.locator('.profile-tabs [data-tab="overview"]').focus(); await p.keyboard.press('End');
  assert(await p.locator('.profile-tabs [data-tab="achievements"]').evaluate(e => e === document.activeElement), 'End reaches final profile tab'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.profile-tabs [data-tab="achievements"]')?.getAttribute('aria-selected') === 'true');
  await focusedChoice(p, '.profile-tabs [data-tab="achievements"]', 'Final profile tab');
  await p.keyboard.press('Home'); await p.keyboard.press('Enter'); await p.waitForFunction(() => document.querySelector('.profile-tabs [data-tab="overview"]')?.getAttribute('aria-selected') === 'true');
  await touch(p, '#profile-day-select', 'Exact activity day');
  await p.locator('#profile-day-select').selectOption(String(day)); await modal(p, '#modal-backdrop .modal', 'Exact activity day detail', theme);
  assert.match(await p.locator('#modal-backdrop .modal').innerText(), /30\.0k tokens/); await p.getByRole('button', { name: 'Close dialog', exact: true }).click();
  for (const tab of ['usage', 'prompts', 'projects', 'comparisons', 'achievements']) {
    await p.locator(`.profile-tabs [data-tab="${tab}"]`).click(); await p.waitForFunction(tab => document.querySelector(`.profile-tabs [data-tab="${tab}"]`)?.getAttribute('aria-selected') === 'true', tab);
    if (tab === 'comparisons') await p.getByText('Loading community comparison…', { exact: true }).waitFor({ state: 'detached' });
    await settle(p);
    await fit(p, 'Profile ' + tab, theme); await tables(p, 'Profile ' + tab);
  }
  await p.locator('[data-share-profile]').click(); await modal(p, '.profile-share-modal', 'Profile share', theme);
  await p.getByRole('button', { name: 'Close share profile', exact: true }).click();
  });

  await check(`${width}px ${theme} team interactions`, async () => {
  await open(p, '/teams', '[data-team-intro-toggle]'); await touch(p, '[data-team-intro-toggle],[data-team-hero-invite]:visible,[data-team-period],[data-team-analytics-view]', 'Team primary controls');
  await p.locator('[data-team-intro-toggle]').click(); await p.locator('#tm-introduction:not([hidden])').waitFor(); await fit(p, 'Expanded team introduction', theme);
  await p.getByRole('button', { name: 'Close team introduction', exact: true }).click();
  await p.locator('[data-team-analytics-view="history"]').click(); await p.locator('[data-team-community-history]').waitFor();
  await touch(p, '[data-team-community-days],[data-team-community-peak],[data-team-community-day-inspector]', 'Team time series');
  await p.locator('[data-team-community-history] summary').click(); await tables(p, 'Daily team values'); await fit(p, 'Team time series', theme);
  const historyTotal = await p.locator('[data-team-community-history] tbody tr td:last-child').evaluateAll(cells => cells.reduce((sum, cell) => sum + Number(cell.textContent.replace(/,/g, '')), 0));
  assert.equal(historyTotal, 9765000, 'Mobile daily table preserves every published team value');
  await p.locator('[data-team-community-day-inspector]').focus(); await p.keyboard.press('Home'); assert.equal(await p.locator('[data-team-community-day-inspector]').inputValue(), '0');
  await p.keyboard.press('End'); assert.equal(await p.locator('[data-team-community-day-inspector]').inputValue(), '29');
  assert.match(await p.locator('[data-team-community-day-reading]').innerText(), /630,000/);
  await open(p, '/t/' + TEAM_ID, '.tm-public-stats');
  await touch(p, '[data-team-days],[data-team-day-inspector],[data-team-peak-day],[data-team-provider]', 'Public team controls');
  const provider = p.locator('[data-team-provider][aria-checked="true"]'); await provider.focus(); await p.keyboard.press('ArrowRight');
  assert.equal(await p.locator('[data-team-provider][aria-checked="true"]').getAttribute('data-team-provider'), 'anthropic');
  assert.match(await p.locator('[data-team-provider-reading]').innerText(), /Anthropic/);
  });

  await check(`${width}px ${theme} workspace interactions`, async () => {
  await open(p, '/leaderboard?view=dashboard', '[data-tw-handle]'); await touch(p, '[data-tw-handle],.tw-handle-form button,[data-tw-signin]', 'Workspace chooser');
  await p.locator('[data-tw-handle]').fill('aurora'); await p.locator('[data-tw-handle]').press('Enter'); await p.locator('[data-tw-tab="overview"]').waitFor();
  for (const tab of ['overview', 'models', 'activity', 'optimize']) {
    const button = p.locator(`[data-tw-tab="${tab}"]`); await button.focus(); await p.keyboard.press('Enter');
    await p.waitForFunction(tab => document.querySelector(`[data-tw-tab="${tab}"]`)?.getAttribute('aria-current') === 'page', tab);
    await focusedChoice(p, `[data-tw-tab="${tab}"]`, 'Workspace ' + tab);
    await touch(p, '[data-tw-tab],[data-tw-period],[data-tw-profile],[data-tw-invite]', 'Workspace ' + tab); await fit(p, 'Workspace ' + tab, theme); await tables(p, 'Workspace ' + tab);
    if (tab === 'models') { await touch(p, '[data-tw-search],[data-tw-sort]', 'Workspace filters'); await p.locator('[data-tw-search]').fill('model-011'); assert.equal(await p.locator('[data-tw-model-table] tbody tr').count(), 1); await p.locator('[data-tw-search]').fill(''); }
  }
  await navigation(p, 'Private workspace', theme);
  });

  await check(`${width}px ${theme} account interactions`, async () => {
  await open(p, '/leaderboard?view=settings', '#settings-signin'); await p.locator('#settings-signin').click(); await modal(p, '.signin-modal', 'Sign-in', theme);
  await p.locator('.signin-modal #signin-github').waitFor(); await touch(p, '.signin-modal #signin-gsi-btn button,.signin-modal #signin-github', 'Sign-in providers'); await p.getByRole('button', { name: 'Not now', exact: true }).click();
  f.setAuthenticated(true);
  await open(p, '/leaderboard?view=settings&user=aurora', '#settings-share-new'); await p.waitForFunction(() => document.querySelector('#view')?.textContent.includes('aurora report'));
  await fit(p, 'Account sharing settings', theme); await tables(p, 'Account settings'); await touch(p, '#settings-share-new,#new-group-btn,[data-revoke]', 'Account settings actions');
  await p.locator('#settings-share-new').click(); await modal(p, '#share-modal', 'Usage report form', theme);
  await touch(p, '#share-now,#share-expiry,#share-audience-input:not([disabled])', 'Report form controls'); await p.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await p.locator('#new-group-btn').click(); await modal(p, '#modal-backdrop .modal', 'Audience form', theme); await touch(p, '#group-name,#group-member-input,#group-member-add,#group-create', 'Audience form controls');
  await p.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await open(p, '/connect', '.grant'); await fit(p, 'Connected applications', theme); await touch(p, '.change-account,.grant button', 'Connection management');
  await open(p, '/oauth/authorize', '#identity:not([hidden])'); await fit(p, 'Connector consent', theme); await touch(p, '#allow,.form-actions button,.permission.optional', 'Connector consent controls');
  assert.equal(f.requests.some(r => r.path === '/oauth/authorize' && r.method === 'POST'), false, 'Reviewing consent never grants access');
  });
  f.setAuthenticated(false);
}

try {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
  const widthFilter = arg('widths') || process.env.MOBILE_WIDTHS, themeFilter = arg('themes') || process.env.MOBILE_THEMES;
  const widths = widthFilter ? widthFilter.split(',').map(Number) : [320, 390, 430];
  const themes = themeFilter ? themeFilter.split(',') : ['light', 'dark'];
  assert(widths.every(n => [320, 390, 430].includes(n)) && themes.every(t => ['light', 'dark'].includes(t)), 'Optional focused run uses supported matrix values');
  for (const width of widths) for (const theme of themes) {
    console.log(`Mobile ${width}px ${theme}: public routes, account surfaces and opened interaction states...`);
    const f = await fixture(width, theme);
    try {
      for (const [route, selector] of routes) {
        await check(`${width}px ${theme} ${route}`, async () => {
        await open(f.page, route, selector); await fit(f.page, route, theme); await tables(f.page, route); await accountHeader(f.page, route);
        await touch(f.page, '[data-theme-control] button:visible', route + ' theme');
        if (['/', '/docs/', '/blog/', '/leaderboard', '/models'].includes(route)) await navigation(f.page, route, theme);
        if (route === '/leaderboard') {
          await touch(f.page, '[data-period],#community-search,#community-team,#community-league,#community-history,#community-metrics', 'Rankings controls');
          assert.equal(await f.page.locator('#view').getByText(/Chart unavailable:/).count(), 0, 'Matching model labels through different providers mount successfully');
          const values = await f.page.locator('.chart-legend .legend-value').allTextContents(); assert.deepEqual(values, ['30.0k', '60.0k'], 'Provider-specific series keep their published totals');
          assert.equal(await f.page.locator('.ts-chart svg,.ts-chart canvas,[data-chart-fallback] svg').count() > 0, true, 'Community chart renders a mounted scene');
        }
        if (route === '/login') { await f.page.locator('#signin-github').waitFor(); await touch(f.page, '#signin-gsi-btn button,#signin-github', 'Login providers'); }
        if (route.startsWith('/invite/') && !route.includes('e'.repeat(48))) await touch(f.page, '[data-ti-join]', 'Join team');
        if (route === '/u/missing-profile') await touch(f.page, '.pf-load-actions button', 'Missing profile recovery');
        });
      }
      await interactive(f, width, theme);
      await check(`${width}px ${theme} locked report`, async () => {
      await open(f.page, '/s/locked', '#view h1');
      if (await f.page.locator('.signin-modal').count()) await f.page.getByRole('button', { name: 'Not now', exact: true }).click();
      await fit(f.page, 'Locked report', theme); await touch(f.page, '#shared-report-signin,#shared-report-back', 'Locked report actions');
      });
    } finally { await check(`${width}px ${theme} isolated fixture`, () => f.close()); }
  }
  console.log(`Mobile: optional chart runtime fallback at 320px in ${themes.join(' and ')}...`);
  for (const theme of themes) {
    const f = await fixture(320, theme, { charts: false });
    try { await check(`320px ${theme} chart fallback`, async () => {
      await open(f.page, '/teams?teamChart=history&teamDays=7#tm-analytics', '[data-team-community-history]');
      assert(await f.page.locator('.tm-community-chart svg').count() > 0, 'Time series has a usable local SVG fallback');
      await f.page.locator('[data-team-community-history] summary').click(); await tables(f.page, 'Fallback daily team values'); await fit(f.page, 'Fallback team chart', theme);
      assert(await f.page.locator('[data-team-community-day-reading]').innerText(), 'Fallback keeps exact daily readout');
    }); } finally { await check(`320px ${theme} fallback isolated fixture`, () => f.close()); }
  }
  assert.equal(failures.length, 0, 'Mobile regression failures:\n' + failures.join('\n'));
  console.log('Mobile UI: all assertions passed.');
} finally { await browser.close(); }
