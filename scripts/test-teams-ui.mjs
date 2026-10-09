import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Exercise real team markup, navigation, assets and shared theme using public
// fixtures. No production account, invite or membership is created or changed.
const origin = 'https://token-horizon.dev', docsRoot = path.resolve('docs');
const TEAM_ID = 'b'.repeat(32);
const today = Math.floor(Date.now() / 86400000) * 86400;
const dailyHistory = [
  { day: today - 31 * 86400, tokens: 90000 },
  { day: today - 10 * 86400, tokens: 10000 },
  { day: today - 3 * 86400, tokens: 5000 },
  { day: today - 86400, tokens: 2000 }
];
const users = Array.from({ length: 6 }, (_, index) => ({ handle: index === 0 ? 'pilot' : 'crew' + index, tokensAll: 1000000, avatarUrl: '', avatarStyle: 'identicon' }));
const longName = 'InterstellarObservabilityAndModelOptimisationCollectiveWithAnUnusuallyLongTeamName';
const teams = [
  { team: 'Unassigned', tokens: 99000000000, cost: 900, members: 100, users, providers: {}, daily: [{ day: today, tokens: 99000000 }] },
  { team: 'Aurora', teamId: TEAM_ID, tokens: 2000000000, tokensToday: 200000000, tokens7d: 400000000, cost: 120, members: 9, users, providers: { openai: 2000000, anthropic: 1000000 }, daily: dailyHistory },
  { team: longName, teamId: 'long-crew', tokens: 1500000000, tokensToday: 350000000, tokens7d: 600000000, cost: 70, members: 12, users: [{ handle: 'stellar', tokensAll: 1000 }], providers: { google: 1000000 }, daily: [{ day: today - 8 * 86400, tokens: 3000 }, { day: today - 86400, tokens: 6000 }] },
  { team: 'Aurora', tokens: 1000000000, tokensToday: 100000000, tokens7d: 200000000, cost: 25, members: 2, users: [{ handle: 'legacy-pilot' }], providers: { openai: 500000000 }, daily: [{ day: today - 3 * 86400, tokens: 500 }] },
  { team: 'Small crew', teamId: 'small-crew', tokens: 500000000, tokensToday: 150000000, tokens7d: 300000000, cost: 20, members: 1, users: [{ handle: 'solo' }], providers: {}, daily: [{ day: today, tokens: 500 }] },
  // A real team can use this name; only the synthetic unassigned bucket is excluded.
  { team: 'Unassigned', teamId: 'real-unassigned', tokens: 2000000, tokensToday: 0, tokens7d: 1000000, cost: 1, members: 1, users: [{ handle: 'named-crew' }], providers: {}, daily: [{ day: today - 86400, tokens: 1000 }] }
];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ data = teams, width = 1440, colorScheme = 'light', reducedMotion = 'reduce', hold = false, fail = false, role = '', holdSession = false, holdAccount = false, holdMotion = false, daily = dailyHistory, charts = true, motion = true, hasTouch = false, iconActions = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme, locale: 'en-US', reducedMotion, hasTouch });
  const page = await context.newPage(), errors = [], requests = [];
  let release, releaseSession, releaseAccount, releaseMotion, failure = fail;
  const user = role ? { provider: 'github', sub: '42', login: 'pilot', name: 'Pilot', email: 'pilot@example.com' } : null;
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'Cache-Control': 'max-age=30' } });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const mirror = url.pathname.startsWith('/project/');
    const assetPath = mirror ? url.pathname.slice('/project'.length) : url.pathname;
    requests.push({ path: url.pathname, search: url.search, method: request.method() });
    if (url.origin !== origin) return route.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return json(route, { error: 'This fixture never mutates teams.' }, 405);
    if (!charts && assetPath === '/vendor/tanstack-charts.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* Optional chart runtime unavailable. */' });
    if (!motion && assetPath === '/team-blackhole.js') return route.abort();
    if (!iconActions && assetPath === '/icon-actions.js') return route.abort();
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: '', webSessions: true, googleAuth: false, githubAuth: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') {
      const send = () => json(route, { ok: true, authenticated: Boolean(user), user, expiresAt: user ? Date.now() + 86400000 : null });
      if (holdSession) { releaseSession = send; return; }
      return send();
    }
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: user ? [{ handle: 'pilot' }] : [] });
    if (url.pathname === '/api/account/team') {
      const send = () => json(route, { ok: true, team: role ? { id: TEAM_ID, name: 'Aurora', role, memberCount: 18 } : null, invites: [] });
      if (holdAccount) { releaseAccount = send; return; }
      return send();
    }
    if (url.pathname === '/api/team/' + TEAM_ID) return json(route, {
      ok: true,
      team: { id: TEAM_ID, name: 'Aurora', memberCount: 18 },
      stats: { ...teams[1], publishedProfiles: teams[1].members, daily }
    });
    if (url.pathname === '/api/providers') {
      const send = () => failure ? json(route, { error: 'Usage is temporarily unavailable.' }, 503) : json(route, { teams: data, providers: [], history: { points: [], providers: [] } });
      if (hold) { release = send; return; }
      return send();
    }
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { points: [], providers: [] } });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, { schemaVersion: 1, count: 1, providers: [], models: [{ id: 'anthropic/fixture-model', name: 'Fixture Anthropic Model', provider: 'anthropic', providerName: 'Anthropic', contextK: 128, inputPerM: 1, outputPerM: 5, capabilities: { toolCall: true } }] });
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/user/')) {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      return json(route, { ok: true, handle, entry: { handle, tokensAll: 1000000, tokensToday: 1000, tokens7d: 100000, costAll: 1, breakdown: { models: [], projects: [], sessions: [], daily: [], modelHistory: [] } }, rank: 1, ranks: {}, rankHistory: [] });
    }
    if (url.pathname.startsWith('/api/')) return json(route, {});
    if (mirror && ['/teams', '/models'].includes(assetPath)) return route.fulfill({ contentType: 'text/html', body: '<script>location.replace(location.pathname+"/"+location.search+location.hash)</script>' });
    const relative = assetPath === '/' ? 'index.html' : ['/leaderboard', '/leaderboard.html'].includes(assetPath) || !mirror && ['/teams', '/teams/', '/models', '/models/'].includes(assetPath) || /^\/(?:u|t)\//.test(assetPath) ? 'leaderboard.html' : ['/teams', '/teams/'].includes(assetPath) ? 'teams/index.html' : assetPath === '/models/' ? 'models/index.html' : assetPath.endsWith('/') ? assetPath.slice(1) + 'index.html' : assetPath.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html' && !mirror) body = Buffer.from(body.toString().replace('<head>', '<head><base href="/"/>'));
      const send = () => route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
      if (holdMotion && assetPath === '/team-blackhole.js') { releaseMotion = send; return; }
      return send();
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, requests, async release() { assert(release, 'Provider request must be pending'); hold = false; await release(); }, async releaseSession() { assert(releaseSession, 'Remembered-session request must be pending'); holdSession = false; await releaseSession(); }, async releaseAccount() { assert(releaseAccount, 'Membership request must be pending'); holdAccount = false; await releaseAccount(); }, async releaseMotion() { assert(releaseMotion, 'Optional motion module must be pending'); holdMotion = false; await releaseMotion(); }, recover() { failure = false; }, async close() {
    await context.close(); assert.deepEqual(errors, [], 'Teams must not throw browser errors');
    assert.equal(requests.some(request => !['GET', 'HEAD'].includes(request.method)), false, 'Teams must not mutate account or membership data');
  } };
}

async function open(page) {
  await page.goto(origin + '/leaderboard?view=teams', { waitUntil: 'domcontentloaded' });
  await page.locator('.tm-page').waitFor();
}
async function settled(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function assertRadioSelection(group, attribute, value) {
  assert.equal(await group.getAttribute('role'), 'radiogroup', 'A single-choice control declares its radio group');
  const radios = await group.locator(`[${attribute}]`).evaluateAll((nodes, attribute) => nodes.map(node => ({
    value: node.getAttribute(attribute), tag: node.tagName, role: node.getAttribute('role'), checked: node.getAttribute('aria-checked'), tabIndex: node.tabIndex
  })), attribute);
  assert(radios.length > 0 && radios.every(radio => radio.tag === 'BUTTON' && radio.role === 'radio'), 'Every choice is an operable button with radio semantics');
  assert.deepEqual(radios.filter(radio => radio.checked === 'true').map(radio => radio.value), [String(value)], 'Exactly the selected choice is checked');
  assert(radios.every(radio => radio.checked === (radio.value === String(value) ? 'true' : 'false')), 'Every radio exposes its selected or unselected state');
  assert.deepEqual(radios.filter(radio => radio.tabIndex === 0).map(radio => radio.value), [String(value)], 'Only the selected radio participates in the tab order');
  assert(radios.every(radio => radio.tabIndex === (radio.value === String(value) ? 0 : -1)), 'Unselected radios use roving tabindex');
}
async function selectRadioKey(group, attribute, key, value) {
  const selected = group.locator(`[${attribute}][aria-checked="true"]`);
  await selected.focus(); await selected.press(key);
  await assertRadioSelection(group, attribute, value);
  assert.equal(await group.locator(`[${attribute}="${value}"]`).evaluate(node => node === document.activeElement), true, `${key} moves focus with selection`);
}
async function assertTouchTargets(locator, description) {
  const targets = await locator.evaluateAll(nodes => nodes.map(node => ({ label: node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert(targets.length > 0 && targets.every(target => target.width >= 44 && target.height >= 44), `${description} keep 44px touch targets: ${JSON.stringify(targets)}`);
}
async function assertIconActions(group, description) {
  const actions = group.locator('[data-icon-action]');
  const details = await actions.evaluateAll(nodes => nodes.map(node => {
    const ids = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const described = ids.map(id => document.getElementById(id)).find(element => element?.closest('[role="tooltip"]'));
    const tooltip = described?.closest('[role="tooltip"]');
    const visibleText = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (!text.textContent.trim() || text.parentElement.closest('svg,[role="tooltip"]')) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      const rect = range.getBoundingClientRect(), style = getComputedStyle(text.parentElement);
      if (rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.clipPath === 'none' && style.clip === 'auto') visibleText.push(text.textContent.trim());
    }
    return { name: node.getAttribute('aria-label'), tag: node.tagName, ids, tooltipId: tooltip?.id, role: tooltip?.getAttribute('role'), description: described?.textContent.trim(), icons: [...node.querySelectorAll('svg')].map(svg => ({ hidden: svg.getAttribute('aria-hidden'), focusable: svg.getAttribute('focusable') })), visibleText };
  }));
  assert(details.length > 0, description + ': icon actions exist');
  for (const item of details) {
    assert(item.name && item.name.trim(), description + ': every native action has an accessible name');
    assert(['A', 'BUTTON', 'SUMMARY'].includes(item.tag), description + ': actions retain native link, button or disclosure semantics');
    assert.equal(item.role, 'tooltip', description + ': description resolves to a persistent tooltip');
    assert(item.description.length >= 24 && item.description !== item.name, description + ': description explains the action in detail');
    assert.equal(item.icons.length, 1, description + ': one authored SVG identifies the action');
    assert(item.icons.every(icon => icon.hidden === 'true' && icon.focusable === 'false'), description + ': SVG is decorative to assistive technology');
    assert.deepEqual(item.visibleText, [], description + ': action has no visible label text');
  }
  assert.equal(new Set(details.map(item => item.tooltipId)).size, details.length, description + ': descriptions have unique IDs');
  await assertTouchTargets(actions, description);
  return details;
}
async function actionTooltip(action) {
  const id = await action.evaluate(node => (node.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.closest('[role="tooltip"]')?.id).find(Boolean));
  assert(id, 'Icon action has a persistent tooltip description');
  return action.page().locator(`[id="${id}"]`);
}
async function assertTooltipFits(page, tooltip, description) {
  await tooltip.waitFor({ state: 'visible' });
  assert.equal(await tooltip.getAttribute('data-open') !== null, true, description + ': tooltip is open');
  assert.equal(await page.locator('[role="tooltip"][data-open]').count(), 1, description + ': only one description opens at once');
  const bounds = await tooltip.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, description + ': tooltip stays in the viewport ' + JSON.stringify(bounds));
  assert.equal(await tooltip.evaluate(node => node.parentElement === document.body), true, description + ': tooltip is portaled outside clipped toolbar ancestors');
  assert.equal(await tooltip.locator('button,a[href],input,select,[tabindex="0"]').count(), 0, description + ': tooltip does not add interactive tab stops');
}
async function assertDayReading(inspector, reading, day, tokens) {
  const text = await reading.innerText();
  const date = new Date(day * 1000), iso = date.toISOString().slice(0, 10);
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  assert(text.includes(iso) || text.includes(label), `The persistent reading names the selected UTC day ${iso}: ${text}`);
  if (tokens > 0) assert(text.includes(tokens.toLocaleString('en-US')), `The day reading exposes the exact reported ${tokens} tokens: ${text}`);
  else assert.match(text, /No reported usage|Not reported/i, 'An unreported day is described without inventing a measured zero');
  assert(await inspector.evaluate(node => Boolean(node.getAttribute('aria-label') || node.labels?.length)), 'The native range inspector has an accessible name');
  assert(await inspector.getAttribute('aria-valuetext'), 'The native range inspector exposes a readable selected value');
}
async function assertCommunityDailyTable(history, days, total) {
  const table = history.locator('table');
  const summary = await table.evaluate(node => {
    const headers = [...node.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
    const totalColumn = headers.findIndex(header => /\btotal\b/i.test(header));
    const rows = [...node.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent.trim()));
    return { headers, totalColumn, rows, total: totalColumn < 0 ? null : rows.reduce((sum, row) => sum + (Number(row[totalColumn].replaceAll(',', '')) || 0), 0) };
  });
  assert.equal(summary.rows.length, days, 'The community table covers every UTC day in the selected window');
  assert(summary.totalColumn >= 0, 'The daily table names its combined total column separately from the team series');
  assert.equal(summary.total, total, 'Readable combined daily totals agree with the time-series window');
  assert(summary.headers.length >= 3, 'Team series remain readable beside combined daily totals');
  return summary;
}
async function assertRankingsDestination(page, prefix = '') {
  const url = new URL(page.url());
  assert([prefix + '/teams', prefix + '/teams/', prefix + '/leaderboard', prefix + '/leaderboard.html'].includes(url.pathname), 'Team ranking links use a public Teams route, including static mirrors');
  assert.equal(await page.evaluate(() => state.view), 'teams', 'Team ranking links preserve the Teams view');
  if (url.pathname.endsWith('/leaderboard') || url.pathname.endsWith('/leaderboard.html')) assert.equal(url.searchParams.get('view'), 'teams', 'Static dashboard URLs name the Teams view');
  assert.equal(url.hash, '#tm-rankings-title', 'The ranking fragment remains shareable');
  await page.waitForFunction(() => document.activeElement?.id === 'tm-rankings-title');
  const target = await page.locator('#tm-rankings-title').evaluate(node => ({ tag: node.tagName, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, height: innerHeight }));
  assert.match(target.tag, /^H[1-6]$/, 'The fragment targets a real section heading');
  assert(target.top >= 0 && target.bottom <= target.height, 'The ranking heading is visible after asynchronous rendering');
}

async function modifierClickHandled(page, key, selector = '.tm-page [data-team-anchor="tm-rankings-title"]') {
  return page.evaluate(({ key, selector }) => {
    const anchor = document.querySelector(selector);
    let handled;
    document.addEventListener('click', event => { handled = event.defaultPrevented; event.preventDefault(); }, { once: true });
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, [key]: true }));
    return handled;
  }, { key, selector });
}

try {
  console.log('Teams: the old homepage fragment and public ranking links survive asynchronous rendering…');
  {
    const ui = await fixture({ hold: true });
    await ui.page.goto(origin + '/#tm-rankings-title', { waitUntil: 'domcontentloaded' });
    await ui.page.getByRole('status').filter({ hasText: 'Loading team rankings' }).waitFor();
    await ui.release();
    await ui.page.locator('.tm-ranking').waitFor();
    await assertRankingsDestination(ui.page);
    assert.equal(ui.requests.some(request => request.path === '/api/leaderboard'), false, 'The repaired fragment reads team data directly');
    await ui.close();
  }
  {
    const ui = await fixture();
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const link = ui.page.locator('.tm-page [data-team-anchor="tm-rankings-title"]').first();
    assert.equal(new URL(await link.getAttribute('href'), ui.page.url()).href, origin + '/leaderboard?view=teams#tm-rankings-title', 'A legacy Teams entry keeps a complete native rankings URL in its compact header');
    for (const key of ['ctrlKey', 'metaKey']) assert.equal(await modifierClickHandled(ui.page, key), false, 'Modified links retain native new-tab behavior');
    await link.focus(); await link.press('Enter');
    await assertRankingsDestination(ui.page);
    await ui.close();
  }
  for (const prefix of ['', '/project']) for (const [anchor, parameters] of [
    ['tm-rankings-title', ''], ['tm-analytics', '?teamChart=history&teamDays=119']
  ]) {
    const ui = await fixture({ hold: true });
    await ui.page.goto(origin + prefix + '/' + parameters + '#' + anchor, { waitUntil: 'domcontentloaded' });
    await ui.page.getByRole('status').filter({ hasText: 'Loading team rankings' }).waitFor();
    await ui.release(); await ui.page.locator('.tm-ranking').waitFor();
    const recovered = new URL(ui.page.url());
    assert([prefix + '/teams', prefix + '/teams/', prefix + '/leaderboard.html'].includes(recovered.pathname), 'Legacy homepage fragments recover inside their Worker or static mirror base');
    assert.equal(await ui.page.evaluate(() => state.view), 'teams');
    assert.equal(recovered.hash, '#' + anchor);
    await ui.page.waitForFunction(anchor => document.activeElement?.id === anchor, anchor);
    if (anchor === 'tm-rankings-title') await assertRankingsDestination(ui.page, prefix);
    else {
      assert.equal(recovered.searchParams.get('teamChart'), 'history', 'Homepage recovery retains the selected team chart mode');
      assert.equal(recovered.searchParams.get('teamDays'), '119', 'Homepage recovery retains the shared history window');
      assert.equal(await ui.page.locator('[data-team-community-total]').innerText(), '118.0k');
    }
    assert.equal(ui.requests.some(request => request.path === '/api/leaderboard'), false, 'Recovered team URLs use the public aggregate without community leaderboard reads');
    await ui.close();
  }
  for (const options of [{ data: [teams[0]] }, { fail: true }]) {
    const ui = await fixture(options);
    await ui.page.goto(origin + '/leaderboard?view=teams#tm-rankings-title', { waitUntil: 'domcontentloaded' });
    await assertRankingsDestination(ui.page);
    assert.equal(await ui.page.locator('.tm-ranking').count(), 0, 'The fragment remains valid when standings are empty or unavailable');
    await ui.close();
  }

  console.log('Teams: a compact heading leads to standings and the remembered introduction mounts only while open…');
  {
    const ui = await fixture();
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor(); await settled(ui.page);
    assert.equal(await ui.page.locator('.tm-page').getByRole('heading', { name: /^Teams\.?$/, level: 1 }).count(), 1, 'Teams has a compact, unambiguous page heading');
    const toggle = ui.page.locator('[data-team-intro-toggle]'), introduction = ui.page.locator('#tm-introduction');
    assert.equal(await ui.page.getByRole('button', { name: 'About teams', exact: true }).count(), 1);
    assert.equal(await toggle.getAttribute('aria-controls'), 'tm-introduction');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'New visitors start with the introduction collapsed');
    assert.equal(await ui.page.getByRole('link', { name: 'Rankings', exact: true }).count(), 1, 'The compact header keeps a named standings action');
    assert.equal(await ui.page.getByRole('link', { name: 'Analytics', exact: true }).count(), 1, 'The compact header keeps a named analytics action');
    assert.equal(await ui.page.locator('[data-team-hero-invite]:visible').count(), 1, 'The collapsed page keeps one reachable crew action');
    assert.equal(await introduction.getAttribute('hidden'), '');
    assert.equal(await introduction.isVisible(), false);
    assert.equal(await ui.page.locator('[data-team-blackhole] canvas,.th-team-hole-providers').count(), 0, 'Collapsed introduction does not mount a decorative scene');
    assert.equal(await ui.page.evaluate(() => teamMotionHandles.size), 0);
    assert.equal(ui.requests.some(request => request.path.endsWith('/team-blackhole.js') || request.path.endsWith('/vendor/three.js')), false, 'Collapsed Teams does not load its optional scene runtime');
    await assertTouchTargets(toggle, 'The About teams disclosure');
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    await toggle.focus(); await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await introduction.getAttribute('hidden'), null);
    assert.equal(await introduction.isVisible(), true);
    await ui.page.waitForFunction(() => teamMotionHandles.size === 1);
    await ui.page.evaluate(() => { window.__fixtureIntroMotion = [...teamMotionHandles][0]; });
    assert.equal(await introduction.locator('.th-team-hole-provider').count(), 6, 'Opening About teams preserves the existing provider horizon');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Opening introduction is independent of team data and account requests');
    await ui.page.reload({ waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-ranking').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'The expanded introduction preference survives a reload');
    assert.equal(await introduction.isVisible(), true);
    await ui.page.waitForFunction(() => teamMotionHandles.size === 1);
    await ui.page.evaluate(() => { window.__fixtureIntroMotion = [...teamMotionHandles][0]; });
    const close = introduction.getByRole('button', { name: 'Close team introduction', exact: true });
    await assertTouchTargets(close, 'The introduction close control');
    await close.focus(); await close.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await introduction.getAttribute('hidden'), '');
    assert.equal(await introduction.isVisible(), false);
    await ui.page.waitForFunction(() => window.__fixtureIntroMotion.state === 'destroyed' && teamMotionHandles.size === 0);
    assert.equal(await ui.page.locator('[data-team-blackhole] canvas,.th-team-hole-providers').count(), 0, 'Closing releases the scene and its mounted provider layer');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'Closing returns keyboard focus to the visible disclosure');
    const runtimes = ui.requests.filter(request => request.path.endsWith('/team-blackhole.js')).length;
    await ui.page.reload({ waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-ranking').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Closing remains remembered on the next visit');
    assert.equal(await introduction.isVisible(), false);
    assert.equal(ui.requests.filter(request => request.path.endsWith('/team-blackhole.js')).length, runtimes, 'Remembered collapsed visits do not reload the scene runtime');
    await ui.page.locator('[data-team-expand="id:' + TEAM_ID + '"]').click();
    await ui.page.locator('[data-team-ranking]').first().click();
    await ui.page.locator('#community-team').waitFor();
    await ui.page.locator('[data-explore-direct="teams"]').click();
    await ui.page.locator('.tm-ranking').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'The introduction preference survives an in-app route round trip');
    assert.equal(await introduction.isVisible(), false);
    await toggle.click();
    await ui.page.waitForFunction(() => teamMotionHandles.size === 1);
    assert.equal(await introduction.isVisible(), true, 'A dismissed introduction remains deliberately reopenable');
    await ui.close();
  }
  {
    const ui = await fixture({ holdMotion: true });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const request = ui.page.waitForRequest(request => new URL(request.url()).pathname === '/team-blackhole.js');
    await ui.page.locator('[data-team-intro-toggle]').click(); await request;
    await ui.page.locator('#tm-introduction').getByRole('button', { name: 'Close team introduction', exact: true }).click();
    await ui.releaseMotion();
    await ui.page.waitForFunction(() => Boolean(window.TokenHorizonTeamMotion)); await settled(ui.page);
    assert.equal(await ui.page.evaluate(() => teamMotionHandles.size), 0, 'A late optional module cannot mount after the introduction has closed');
    assert.equal(await ui.page.locator('.th-team-hole-providers,[data-team-blackhole] canvas').count(), 0, 'An in-flight scene load cannot populate the collapsed introduction');
    await ui.page.locator('[data-team-intro-toggle]').click();
    await ui.page.waitForFunction(() => teamMotionHandles.size === 1);
    assert.equal(await ui.page.locator('#tm-introduction .th-team-hole-provider').count(), 6, 'A later deliberate reopen uses the completed optional module');
    await ui.close();
  }

  console.log('Teams: SVG actions expose persistent names and detailed desktop tooltips in both themes…');
  for (const colorScheme of ['light', 'dark']) {
    const ui = await fixture({ colorScheme });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor(); await settled(ui.page);
    const group = ui.page.getByRole('group', { name: 'Team actions', exact: true });
    const descriptions = await assertIconActions(group, 'Directory toolbar');
    assert.deepEqual(descriptions.map(item => item.name), ['Rankings', 'Analytics', 'Create your crew', 'About teams']);
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'Descriptions start closed');
    const rankings = group.getByRole('link', { name: 'Rankings', exact: true }), rankingTooltip = await actionTooltip(rankings);
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    await rankings.hover(); await assertTooltipFits(ui.page, rankingTooltip, colorScheme + ' hover');
    assert.match(await rankingTooltip.textContent(), /ranking|standing/i, 'Rankings description explains the destination');
    await rankingTooltip.hover(); await ui.page.waitForTimeout(250);
    assert.notEqual(await rankingTooltip.getAttribute('data-open'), null, 'Pointer can read the tooltip without crossing a dismissal gap');
    await ui.page.mouse.move(0, 0); await rankingTooltip.waitFor({ state: 'hidden' });
    const about = group.getByRole('button', { name: 'About teams', exact: true }), aboutTooltip = await actionTooltip(about);
    await about.focus(); await assertTooltipFits(ui.page, aboutTooltip, colorScheme + ' keyboard focus');
    await ui.page.mouse.move(0, 0); await ui.page.waitForTimeout(250);
    assert.notEqual(await aboutTooltip.getAttribute('data-open'), null, 'Keyboard focus keeps its description available');
    await about.press('Escape'); await aboutTooltip.waitFor({ state: 'hidden' });
    assert(await about.evaluate(node => document.activeElement === node), 'Escape dismisses the description without losing focus');
    assert.equal(await about.getAttribute('aria-expanded'), 'false', 'Tooltip inspection never activates its action');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Tooltip inspection does not read or mutate team data');
    const analytics = group.getByRole('link', { name: 'Analytics', exact: true }), analyticsTooltip = await actionTooltip(analytics);
    await analytics.focus(); await assertTooltipFits(ui.page, analyticsTooltip, colorScheme + ' second action');
    assert.equal(await aboutTooltip.getAttribute('data-open'), null, 'Opening another action dismisses the prior tooltip');
    await ui.page.evaluate(() => window.scrollBy(0, 150));
    await ui.page.waitForFunction(() => !document.querySelector('[role="tooltip"][data-open]'));
    await analytics.click();
    await ui.page.waitForFunction(() => document.activeElement?.id === 'tm-analytics');
    assert.equal(new URL(ui.page.url()).hash, '#tm-analytics', 'The SVG analytics link keeps the native destination');
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'Activation closes floating descriptions');
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor();
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'New crew routes do not inherit a stale floating tooltip');
    const detailGroup = ui.page.getByRole('group', { name: 'Team actions', exact: true });
    await assertIconActions(detailGroup, 'Public crew toolbar');
    const share = detailGroup.locator('summary[aria-label="Share team"]');
    assert.equal(await share.evaluate(node => node.tagName), 'SUMMARY', 'Sharing retains the native details disclosure');
    await share.focus(); await assertTooltipFits(ui.page, await actionTooltip(share), colorScheme + ' share disclosure');
    await share.press('Enter');
    assert.equal(await ui.page.locator('.tm-share-panel').getAttribute('open'), '', 'Keyboard activation expands the public share controls');
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'Native sharing activation closes its description');
    await ui.close();
  }

  console.log('Teams: first touch activates SVG actions; hold descriptions and cancelled drags remain usable…');
  for (const width of [320, 390, 430]) for (const colorScheme of ['light', 'dark']) {
    const ui = await fixture({ width, colorScheme, hasTouch: true });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor(); await settled(ui.page);
    const group = ui.page.getByRole('group', { name: 'Team actions', exact: true });
    await assertIconActions(group, `${width}px ${colorScheme} toolbar`);
    const about = group.getByRole('button', { name: 'About teams', exact: true }), tooltip = await actionTooltip(about);
    await about.tap();
    assert.equal(await about.getAttribute('aria-expanded'), 'true', 'The first tap opens the introduction instead of consuming the tap for a tooltip');
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'A normal tap does not leave an overlay over the action');
    await ui.page.getByRole('button', { name: 'Close team introduction', exact: true }).tap();
    await ui.page.keyboard.press('Escape');
    await about.scrollIntoViewIfNeeded();
    const client = await ui.page.context().newCDPSession(ui.page);
    try {
      const center = async () => { const r = await about.boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }; };
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await center()] });
      await assertTooltipFits(ui.page, tooltip, `${width}px ${colorScheme} hold`);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settled(ui.page);
      assert.equal(await about.getAttribute('aria-expanded'), 'false', 'Releasing a held description does not activate the disclosure');
      await ui.page.keyboard.press('Escape');
      for (const cancel of ['move', 'cancel']) {
        const start = await center();
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
        if (cancel === 'move') {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: start.x + 20 }] });
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await ui.page.waitForTimeout(500);
        assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, cancel + ' cancels the hold timer');
        assert.equal(await about.getAttribute('aria-expanded'), 'false', cancel + ' does not accidentally activate the action');
        await about.tap(); assert.equal(await about.getAttribute('aria-expanded'), 'true', 'A subsequent tap still activates after ' + cancel);
        await ui.page.getByRole('button', { name: 'Close team introduction', exact: true }).tap(); await ui.page.keyboard.press('Escape');
      }
    } finally { await client.detach(); }
    await about.blur(); await about.focus(); await assertTooltipFits(ui.page, tooltip, `${width}px ${colorScheme} keyboard description`);
    await about.press('Escape'); assert(await about.evaluate(node => document.activeElement === node), 'Touch devices preserve keyboard dismissal focus');
    await group.getByRole('link', { name: 'Rankings', exact: true }).tap(); await assertRankingsDestination(ui.page);
    await group.getByRole('link', { name: 'Analytics', exact: true }).tap(); await ui.page.waitForFunction(() => document.activeElement?.id === 'tm-analytics');
    await group.getByRole('button', { name: 'Create your crew', exact: true }).tap(); await ui.page.locator('.signin-modal').waitFor();
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'The first crew tap opens sign-in without a tooltip gate');
    assert.equal(ui.requests.some(request => !['GET', 'HEAD'].includes(request.method)), false, 'Tooltips and first-tap actions never create membership or invitations');
    await ui.close();
  }

  console.log('Teams: skip navigation preserves public crew routes and unavailable motion leaves usable static artwork…');
  {
    const ui = await fixture();
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor(); await settled(ui.page);
    const skip = ui.page.getByRole('link', { name: 'Skip to content', exact: true });
    const destination = new URL(await skip.evaluate(node => node.href));
    assert.equal(destination.pathname, '/t/' + TEAM_ID, 'The skip link preserves the public team route despite the document base URL');
    assert.equal(destination.hash, '#view');
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    await skip.focus(); await skip.press('Enter');
    await ui.page.waitForFunction(() => document.activeElement?.id === 'view');
    assert.equal(new URL(ui.page.url()).pathname, '/t/' + TEAM_ID, 'Skip to content never leaves the public team profile');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Skip navigation is an in-document action');
    await ui.close();
  }
  for (const route of ['/leaderboard?view=teams', '/t/' + TEAM_ID]) {
    const ui = await fixture({ motion: false });
    const failedMotion = ui.page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/team-blackhole.js' });
    await ui.page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await ui.page.locator(route.startsWith('/t/') ? '.tm-public-stats' : '.tm-ranking').waitFor();
    if (!route.startsWith('/t/')) await ui.page.locator('[data-team-intro-toggle]').click();
    await failedMotion; await settled(ui.page);
    assert.equal(await ui.page.evaluate(() => Boolean(window.TokenHorizonTeamMotion)), false, 'The fixture exercises a failed optional motion module');
    const artwork = ui.page.locator('[data-team-blackhole] .tm-hole-static');
    assert.equal(await artwork.count(), 1, 'Static SVG artwork ships without the optional runtime');
    assert.equal(await artwork.isVisible(), true, 'The static horizon remains visible after a module failure');
    const toggle = ui.page.locator('[data-team-motion-toggle]');
    assert.equal(await toggle.isDisabled(), true, 'Unavailable animation cannot expose an enabled pause control');
    assert.equal(await toggle.isVisible(), false, 'The unavailable motion control is hidden from users');
    assert(await ui.page.locator(route.startsWith('/t/') ? '.tm-detail-analytics' : '.tm-ranking').isVisible(), 'Team data remains readable when decorative motion cannot load');
    await ui.close();
  }

  console.log('Teams: loading is independent of the community leaderboard and recovers from real endpoint errors…');
  {
    const ui = await fixture({ hold: true });
    await open(ui.page);
    await ui.page.getByRole('status').filter({ hasText: 'Loading team rankings' }).waitFor();
    assert.equal(ui.requests.some(request => request.path === '/api/leaderboard'), false, 'Teams must not await unrelated community data');
    await ui.release();
    await ui.page.locator('.tm-ranking').waitFor();
    await ui.close();
  }
  {
    const ui = await fixture({ fail: true });
    await open(ui.page);
    await ui.page.getByRole('alert').filter({ hasText: 'Team data couldn’t load.' }).waitFor();
    assert.equal(await ui.page.getByText('Your crew could be first.', { exact: true }).count(), 0, 'Failure must not masquerade as empty teams');
    ui.recover();
    await ui.page.getByRole('button', { name: 'Try again', exact: true }).click();
    await ui.page.locator('.tm-ranking').waitFor();
    assert(ui.requests.filter(request => request.path === '/api/providers').length >= 2, 'Retry must read fresh provider data');
    await ui.close();
  }

  console.log('Teams: real totals, canonical identities, local filters, keyboard details and provider marks…');
  {
    const ui = await fixture();
    await open(ui.page);
    await ui.page.locator('.tm-ranking').waitFor();
    assert.equal(await ui.page.locator('.tm-row').count(), 5, 'Only the synthetic Unassigned aggregate is excluded');
    assert.equal(await ui.page.locator('.tm-leader-team h2').innerText(), 'Aurora');
    assert.equal(await ui.page.locator('.tm-leader-usage>strong').innerText(), '2.00B');
    assert.equal(await ui.page.locator('.team-invite-banner').isVisible(), false, 'Signed-out visitors reach analytics without a duplicate invite banner');
    assert.match(await ui.page.locator('.tm-community-stats').innerText(), /5[\s\S]*25[\s\S]*5\.00B/);
    await ui.page.locator('#view').focus(); await ui.page.keyboard.press('/');
    assert.equal(await ui.page.locator('#tm-search').evaluate(node => node === document.activeElement), true, 'The search shortcut targets the visible team search');
    assert.equal(await ui.page.locator('#tm-search').inputValue(), '', 'The shortcut focuses search without typing a slash');
    const canonical = ui.page.locator(`[data-team-expand="id:${TEAM_ID}"]`);
    await canonical.focus(); await canonical.press('Enter');
    assert.equal(await canonical.getAttribute('aria-expanded'), 'true');
    const details = ui.page.locator('#' + await canonical.getAttribute('aria-controls'));
    assert.match(await details.innerText(), /Top 6 of 9 published profiles/);
    assert.deepEqual(await details.locator('.tm-provider-share').allTextContents(), ['67%', '33%'], 'Mix uses reported provider data, never fabricated missing usage');
    assert.equal(await details.locator('.prov-logo[data-provider="openai"] img').count(), 1);
    assert.equal(await details.locator('.prov-logo[data-provider="anthropic"] img').count(), 1);
    await canonical.press('Enter');
    assert.equal(await details.isVisible(), false);
    await ui.page.getByLabel('Sort teams').selectOption('profiles');
    assert.equal(await ui.page.locator('.tm-team-name>strong').first().evaluate(node => {
      const name = node.cloneNode(true); name.querySelectorAll('[aria-hidden="true"]').forEach(decoration => decoration.remove()); return name.textContent.trim();
    }), longName, 'The sorted first row retains its full name independently of its decorative team icon');
    assert.match(await ui.page.locator('.tm-rank').first().innerText(), /Rank\s*02/, 'Sorting cannot rewrite usage ranks');
    const reads = ui.requests.filter(request => request.path === '/api/providers').length;
    await ui.page.getByLabel('Search teams or profiles').fill('legacy-pilot');
    assert.equal(await ui.page.locator('.tm-row').count(), 1);
    assert.equal(await ui.page.locator('[data-team-expand="legacy:Aurora"]').count(), 1, 'Equal labels never collapse canonical and legacy teams');
    await ui.page.getByLabel('Search teams or profiles').fill('does-not-exist');
    await ui.page.getByRole('heading', { name: 'No matching teams' }).waitFor();
    await ui.page.getByRole('button', { name: 'Clear search', exact: true }).click();
    assert.equal(await ui.page.locator('.tm-row').count(), 5);
    assert.equal(ui.requests.filter(request => request.path === '/api/providers').length, reads, 'Searching and sorting must be local');
    await canonical.click();
    await details.locator('[data-team-ranking]').click();
    await ui.page.locator('#community-team').waitFor();
    assert.equal(await ui.page.evaluate(() => state.teamFilter), TEAM_ID);
    assert.equal(new URL(ui.page.url()).searchParams.get('period'), 'all');
    await ui.close();
  }

  console.log('Teams: published window comparisons and per-profile usage remain independent of all-time standings…');
  {
    const ui = await fixture();
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const analytics = ui.page.locator('.tm-analytics');
    await analytics.waitFor();
    const windowGroup = analytics.getByRole('radiogroup', { name: 'Team comparison window', exact: true });
    const metricGroup = analytics.getByRole('radiogroup', { name: 'Team comparison metric', exact: true });
    assert.equal(await analytics.locator('.tm-comparison-panel [data-team-window]').count(), 3, 'Window controls stay inside the comparison surface they operate on');
    await assertRadioSelection(windowGroup, 'data-team-window', 'all');
    await assertRadioSelection(metricGroup, 'data-team-metric', 'total');
    const providerInstrument = analytics.locator('[data-team-provider-instrument]');
    const providerReading = providerInstrument.locator('[data-team-provider-reading]');
    const providerBasis = await providerReading.innerText();
    assert.match(await analytics.locator('.tm-mix-panel').innerText(), /all.time/i, 'Provider usage clearly names its all-time basis');
    const firstKey = () => analytics.locator('[data-team-comparison]').first().getAttribute('data-team-key');
    const firstValue = () => analytics.locator('[data-team-comparison-value]').first().innerText();
    assert.equal(await firstKey(), 'id:' + TEAM_ID, 'All-time total comparisons start with the reported leading team');
    assert.match(await firstValue(), /2\.00B/, 'A team’s all-time comparison matches its published total');
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    const week = analytics.locator('[data-team-window="week"]');
    await week.focus(); await week.press('Space');
    await assertRadioSelection(windowGroup, 'data-team-window', 'week');
    assert.equal(await firstKey(), 'id:long-crew', 'Last 7 days compares the published seven-day totals');
    assert.match(await firstValue(), /600(?:\.0)?M/);
    const perProfile = analytics.locator('[data-team-metric="profile"]');
    await perProfile.focus(); await perProfile.press('Enter');
    await assertRadioSelection(metricGroup, 'data-team-metric', 'profile');
    assert.equal(await firstKey(), 'id:small-crew', 'Per-profile comparison divides by published profiles, including crews with one profile');
    assert.match(await firstValue(), /300(?:\.0)?M/);
    await analytics.locator('[data-team-window="today"]').click();
    assert.equal(await firstKey(), 'id:small-crew');
    assert.match(await firstValue(), /150(?:\.0)?M/);
    assert.equal(await ui.page.locator('.tm-leader-team h2').innerText(), 'Aurora', 'Analytics controls do not relabel all-time standings');
    assert.equal(await ui.page.locator('.tm-leader-usage>strong').innerText(), '2.00B');
    assert.equal(await ui.page.locator('.tm-row').count(), 5, 'Analytics use the same real teams as the standings');
    assert.equal(await providerReading.innerText(), providerBasis, 'Comparison windows and metrics do not relabel all-time provider usage');
    await selectRadioKey(windowGroup, 'data-team-window', 'ArrowRight', 'week');
    await selectRadioKey(windowGroup, 'data-team-window', 'End', 'all');
    await selectRadioKey(windowGroup, 'data-team-window', 'ArrowRight', 'today');
    await selectRadioKey(windowGroup, 'data-team-window', 'ArrowLeft', 'all');
    await selectRadioKey(windowGroup, 'data-team-window', 'Home', 'today');
    await selectRadioKey(metricGroup, 'data-team-metric', 'ArrowLeft', 'total');
    await selectRadioKey(metricGroup, 'data-team-metric', 'ArrowLeft', 'profile');
    await selectRadioKey(metricGroup, 'data-team-metric', 'Home', 'total');
    await selectRadioKey(metricGroup, 'data-team-metric', 'End', 'profile');
    await selectRadioKey(metricGroup, 'data-team-metric', 'ArrowRight', 'total');
    assert.equal(await providerReading.innerText(), providerBasis, 'Keyboard comparison selection also preserves the provider basis');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Window and metric comparisons use one public aggregate without refetching profiles');
    await ui.close();
  }
  {
    const data = teams.map((team, index) => {
      if (index !== 1) return team;
      const copy = { ...team }; delete copy.tokensToday; delete copy.tokens7d; return copy;
    });
    const ui = await fixture({ data });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const analytics = ui.page.locator('.tm-analytics');
    await analytics.locator('[data-team-window="today"]').click();
    const missing = analytics.locator(`[data-team-key="id:${TEAM_ID}"] [data-team-comparison-value]`);
    assert.equal(await missing.innerText(), 'Not published', 'Older published profiles without a recent scalar are distinct from measured zero');
    assert.equal(await analytics.locator('[data-team-key="id:real-unassigned"] [data-team-comparison-value]').innerText(), '0', 'A measured zero remains a real value');
    assert.match(await analytics.locator('.tm-comparison-summary').innerText(), /600\.0M[\s\S]*1 team missing this window/, 'Partial totals disclose missing window coverage');
    await ui.close();
  }
  {
    const data = [
      { ...teams[1], members: 3, tokensToday: 0, tokens7d: 300000000, recentWindowProfiles: { today: 0, week: 1 } },
      { ...teams[4], tokensToday: 0, tokens7d: 0, recentWindowProfiles: { today: 1, week: 1 } }
    ];
    const ui = await fixture({ data });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const analytics = ui.page.locator('.tm-analytics');
    const partial = analytics.locator(`[data-team-key="id:${TEAM_ID}"]`);
    await analytics.locator('[data-team-window="today"]').click();
    assert.equal(await partial.locator('[data-team-comparison-value]').innerText(), 'Not published', 'A zero aggregate with no reporting profiles cannot claim measured zero');
    assert.equal(await analytics.locator('[data-team-key="id:small-crew"] [data-team-comparison-value]').innerText(), '0', 'A reporting profile makes zero an actual published value');
    await analytics.locator('[data-team-window="week"]').click();
    await analytics.locator('[data-team-metric="profile"]').click();
    assert.match(await partial.locator('[data-team-comparison-value]').innerText(), /300\.0M\s*\/ profile/, 'Recent per-profile averages divide by profiles reporting the selected window');
    assert.match(await partial.innerText(), /1 of 3 profiles shared this window/, 'The team comparison discloses its partial profile coverage');
    assert.match(await analytics.locator('.tm-comparison-summary').innerText(), /partial/i, 'The combined comparison marks partial recent windows');
    await analytics.locator('[data-team-window="all"]').click();
    assert.match(await partial.locator('[data-team-comparison-value]').innerText(), /666\.7M\s*\/ profile/, 'All-time per-profile comparison includes all published profiles');
    await ui.close();
  }

  console.log('Teams: community analytics switch between comparisons and published time series without refetching…');
  {
    const ui = await fixture();
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor(); await settled(ui.page);
    const analytics = ui.page.locator('.tm-analytics');
    const mode = analytics.getByRole('radiogroup', { name: 'Team analytics view', exact: true });
    await assertRadioSelection(mode, 'data-team-analytics-view', 'comparison');
    assert.deepEqual(await mode.locator('button').allTextContents(), ['Comparison', 'Over time'], 'Analytics modes have clear visible labels');
    await analytics.locator('[data-team-window="week"]').click();
    await analytics.locator('[data-team-metric="profile"]').click();
    const comparisonKey = await analytics.locator('[data-team-comparison]').first().getAttribute('data-team-key');
    const comparisonValue = await analytics.locator('[data-team-comparison-value]').first().innerText();
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length, url = ui.page.url();
    const providerBasis = await analytics.locator('[data-team-provider-reading]').innerText();
    await selectRadioKey(mode, 'data-team-analytics-view', 'End', 'history');
    const history = analytics.locator('[data-team-community-history]');
    await history.waitFor();
    const windowGroup = history.getByRole('radiogroup', { name: 'Team history window', exact: true });
    await assertRadioSelection(windowGroup, 'data-team-community-days', '30');
    assert.match(await history.innerText(), /UTC/, 'Shared daily charts explain their UTC basis');
    assert.match(await history.locator('[data-team-community-total]').innerText(), /^28(?:\.0|\.00)?k$/i, 'Thirty-day history adds reported daily totals, excluding the synthetic Unassigned bucket');
    assert(await history.getByText(/^Other(?:\s*\(\d+ teams?\))?$/).count() > 0, 'More than four positive team histories retain a named Other aggregate');
    const legend = history.locator('.tm-history-legend');
    const legendNames = await legend.locator(':scope > span').allTextContents();
    assert.equal(legendNames.length, 5, 'Four named teams and Other bound the displayed community series');
    assert.equal(await legend.locator('img,svg,[data-provider-link],[data-model-link]').count(), 0, 'The team legend uses team names rather than provider or model logos');
    assert.equal(await legend.locator('i.is-other').evaluate(node => getComputedStyle(node).borderTopStyle), 'dashed', 'Other has a distinct dashed line key');
    await history.getByText('View daily values', { exact: true }).click();
    const table = await assertCommunityDailyTable(history, 30, 28000);
    assert(table.headers.some(header => /^Other\b/.test(header)), 'The grouped Other series has readable daily values');
    assert.equal(table.headers.filter(header => /Aurora/.test(header)).length, 2, 'Equal-named canonical and legacy teams retain separate readable series');
    assert.equal(table.rows[0][table.totalColumn], 'Not reported', 'A day without any publication is a gap rather than a fabricated zero');
    const reportedDate = new Date((today - 86400) * 1000).toISOString().slice(0, 10);
    const reportedRow = table.rows.find(row => row[0] === reportedDate);
    assert(reportedRow, 'The readable series include yesterday’s published UTC day');
    assert.deepEqual(reportedRow.filter((_, index) => index !== 0 && index !== table.totalColumn).map(value => Number(value.replaceAll(',', ''))).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b), [1000, 2000, 6000], 'Per-team and Other daily values preserve the actual reports beside their combined total');
    await selectRadioKey(windowGroup, 'data-team-community-days', 'Home', '7');
    assert.match(await history.locator('[data-team-community-total]').innerText(), /^15(?:\.0|\.00)?k$/i);
    await selectRadioKey(windowGroup, 'data-team-community-days', 'ArrowRight', '30');
    await selectRadioKey(windowGroup, 'data-team-community-days', 'End', '119');
    assert.match(await history.locator('[data-team-community-total]').innerText(), /^118(?:\.0|\.00)?k$/i);
    assert.deepEqual(await legend.locator(':scope > span').allTextContents(), legendNames, 'Team series identities stay stable between history windows');
    await selectRadioKey(windowGroup, 'data-team-community-days', 'ArrowRight', '7');
    await selectRadioKey(windowGroup, 'data-team-community-days', 'ArrowLeft', '119');
    await selectRadioKey(windowGroup, 'data-team-community-days', 'ArrowLeft', '30');
    const inspector = history.locator('input[data-team-community-day-inspector]');
    const reading = history.locator('[data-team-community-day-reading]');
    assert.equal(await inspector.getAttribute('type'), 'range');
    assert.equal(await inspector.getAttribute('max'), '29');
    const chart = history.locator('div.ts-chart[data-chart-id]');
    await chart.waitFor();
    const chartNode = await chart.elementHandle(), readingNode = await reading.elementHandle();
    const mounts = await ui.page.evaluate(() => window.__thPerf.chartMounts);
    await inspector.focus(); await inspector.press('Home');
    await assertDayReading(inspector, reading, today - 29 * 86400, 0);
    await inspector.press('ArrowRight');
    assert.equal(await inspector.inputValue(), '1');
    await inspector.press('End');
    await assertDayReading(inspector, reading, today, 500);
    await inspector.press('ArrowLeft');
    await assertDayReading(inspector, reading, today - 86400, 9000);
    const exactSeries = await history.locator('[data-team-community-day-values] dl > div').evaluateAll(nodes => nodes.map(node => ({ name: node.querySelector('dt').textContent.trim(), value: node.querySelector('dd').textContent.trim() })));
    assert.deepEqual(exactSeries.map(series => Number(series.value.replaceAll(',', ''))).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b), [1000, 2000, 6000], 'The inspector exposes each displayed team or Other value beside the exact combined count');
    assert.equal(exactSeries.filter(series => series.value === 'Not reported').length, 2, 'Unknown team values stay labelled in the persistent day inspector');
    await history.locator('[data-team-community-peak]').click();
    assert.equal(await inspector.inputValue(), '19', 'Community peak selection jumps to the actual largest combined report');
    await assertDayReading(inspector, reading, today - 10 * 86400, 10000);
    await inspector.evaluate(node => { node.value = '26'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); });
    await assertDayReading(inspector, reading, today - 3 * 86400, 5500);
    assert.equal(await chart.evaluate((node, previous) => node === previous, chartNode), true, 'Community day inspection preserves its mounted chart host');
    assert.equal(await reading.evaluate((node, previous) => node === previous, readingNode), true, 'The shared daily reading stays on one persistent surface');
    assert.equal(await ui.page.evaluate(() => window.__thPerf.chartMounts), mounts, 'Inspector changes do not remount the time-series chart');
    await history.getByText('View daily values', { exact: true }).click();
    await assertCommunityDailyTable(history, 30, 28000);
    await selectRadioKey(mode, 'data-team-analytics-view', 'Home', 'comparison');
    await assertRadioSelection(analytics.getByRole('radiogroup', { name: 'Team comparison window', exact: true }), 'data-team-window', 'week');
    await assertRadioSelection(analytics.getByRole('radiogroup', { name: 'Team comparison metric', exact: true }), 'data-team-metric', 'profile');
    assert.equal(await analytics.locator('[data-team-comparison]').first().getAttribute('data-team-key'), comparisonKey, 'Returning to comparison restores the selected scalar ranking');
    assert.equal(await analytics.locator('[data-team-comparison-value]').first().innerText(), comparisonValue, 'Returning to comparison restores the selected per-profile value');
    await selectRadioKey(mode, 'data-team-analytics-view', 'ArrowRight', 'history');
    assert.equal(await chart.evaluate((node, previous) => node === previous, chartNode), true, 'Returning to the same history window reuses the pooled chart host');
    assert.equal(await ui.page.evaluate(() => window.__thPerf.chartMounts), mounts, 'Switching modes preserves content-identical chart pooling');
    await selectRadioKey(mode, 'data-team-analytics-view', 'ArrowLeft', 'comparison');
    assert.equal(await analytics.locator('[data-team-provider-reading]').innerText(), providerBasis, 'Analytics modes leave the reported all-time provider basis intact');
    assert.equal(ui.page.url(), url, 'Community history is an in-place analytics mode');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Modes, windows and inspector use one public aggregate without refetching');
    assert.equal(ui.requests.some(request => request.path.startsWith('/api/user/') || request.path.startsWith('/api/team/')), false, 'Community history never fans out to profile or team-detail requests');
    await ui.close();
  }

  console.log('Teams: shared Over time links preserve their window and analytics anchor across navigation…');
  {
    const ui = await fixture();
    await ui.page.goto(origin + '/leaderboard?view=teams#tm-analytics', { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.locator('[data-team-analytics-view="history"]').click();
    await ui.page.locator('[data-team-community-days="119"]').click();
    const shared = new URL(ui.page.url());
    assert.equal(shared.searchParams.get('view'), 'teams');
    assert.equal(shared.searchParams.get('teamChart'), 'history', 'The shared URL selects the Over time view');
    assert.equal(shared.searchParams.get('teamDays'), '119', 'The shared URL records the chosen history window');
    assert.equal(shared.hash, '#tm-analytics', 'Selecting a view and window preserves the team analytics anchor');
    await ui.page.goto(shared.href, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('[data-team-community-history]').waitFor();
    const analytics = ui.page.locator('.tm-analytics');
    await assertRadioSelection(analytics.getByRole('radiogroup', { name: 'Team analytics view', exact: true }), 'data-team-analytics-view', 'history');
    await assertRadioSelection(analytics.getByRole('radiogroup', { name: 'Team history window', exact: true }), 'data-team-community-days', '119');
    assert.equal(await analytics.locator('[data-team-community-total]').innerText(), '118.0k', 'Loading a shared history URL restores the selected daily aggregate');
    await ui.page.waitForFunction(() => document.activeElement?.id === 'tm-analytics');
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    await analytics.locator('[data-team-analytics-view="comparison"]').click();
    const comparison = new URL(ui.page.url());
    assert.equal(comparison.searchParams.get('teamChart'), null, 'Returning to comparison removes the history mode parameter');
    assert.equal(comparison.searchParams.get('teamDays'), null, 'Returning to comparison removes the history window parameter');
    assert.equal(comparison.searchParams.get('view'), 'teams');
    assert.equal(comparison.hash, '#tm-analytics', 'Returning to comparison keeps the analytics destination shareable');
    await assertRadioSelection(analytics.getByRole('radiogroup', { name: 'Team analytics view', exact: true }), 'data-team-analytics-view', 'comparison');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Restoring comparison from a shared history link needs no new public data request');
    await ui.close();
  }

  console.log('Teams: incomplete shared history is labelled partial and missing history is distinct from reported zero…');
  {
    const data = [{ ...teams[1] }, { ...teams[2], daily: [] }, { ...teams[4], daily: [{ day: today, tokens: 0 }] }];
    const ui = await fixture({ data });
    await open(ui.page); await ui.page.locator('[data-team-analytics-view="history"]').click();
    const history = ui.page.locator('[data-team-community-history]');
    assert.match(await history.locator('.tm-comparison-summary').innerText(), /partial history:\s*2 of 3 teams published daily values/i, 'Incomplete daily data discloses how many teams published history in the total summary');
    assert.match(await history.locator('[data-team-community-total]').innerText(), /^17(?:\.0|\.00)?k$/i, 'Missing histories do not alter reported team sums');
    const inspector = history.locator('[data-team-community-day-inspector]'), reading = history.locator('[data-team-community-day-reading]');
    await inspector.focus(); await inspector.press('End');
    assert.match(await reading.innerText(), /0\s+(?:reported\s+)?tokens/i, 'A team that explicitly reports zero keeps a measured zero day');
    assert.doesNotMatch(await reading.innerText(), /No reported usage/i, 'Reported zero is not described as absent publication');
    await history.getByText('View daily values', { exact: true }).click();
    const table = await assertCommunityDailyTable(history, 30, 17000);
    assert.equal(table.rows.at(-1)[table.totalColumn], '0', 'The readable daily total retains an explicitly reported zero');
    assert.equal(table.rows[0][table.totalColumn], 'Not reported', 'The same table distinguishes an unknown date from published zero');
    await ui.close();
  }
  {
    const noHistory = { ...teams[2] }; delete noHistory.daily;
    const ui = await fixture({ data: [{ ...teams[1], daily: [] }, noHistory] });
    await open(ui.page); await ui.page.locator('[data-team-analytics-view="history"]').click();
    const history = ui.page.locator('[data-team-community-history]');
    assert.match(await history.innerText(), /(?:no|not|hasn.t|unavailable).*?(?:published|history)|(?:history|daily).*?(?:not|hasn.t|unavailable)/i, 'An entirely unpublished community history is described as unavailable');
    assert.equal(await history.locator('[data-team-community-total]').innerText(), '—', 'No published history cannot present a fabricated zero total');
    assert.equal(await history.locator('[data-team-community-day-inspector]').count(), 0, 'Unavailable shared history does not offer an inspector');
    assert.equal(await history.locator('[data-chart-id],[data-chart-fallback]').count(), 0, 'Unavailable shared history does not draw fabricated daily bars');
    await ui.close();
  }
  {
    const ui = await fixture({ data: [{ ...teams[1], daily: [{ day: today, tokens: 0 }] }, { ...teams[2], daily: [] }] });
    await open(ui.page); await ui.page.locator('[data-team-analytics-view="history"]').click();
    const history = ui.page.locator('[data-team-community-history]');
    assert.equal(await history.locator('[data-team-community-total]').innerText(), '0', 'Explicitly published zero remains different from missing history');
    assert.doesNotMatch(await history.innerText(), /daily history hasn.t been published|history is unavailable/i);
    await ui.close();
  }
  {
    const ui = await fixture({ charts: false });
    await open(ui.page); await ui.page.locator('[data-team-analytics-view="history"]').click();
    const history = ui.page.locator('[data-team-community-history]');
    assert.equal(await ui.page.evaluate(() => Boolean(window.TanStackCharts)), false, 'Community history exercises the optional vendor fallback');
    for (const [days, total, display] of [[7, 15000, '15.0k'], [30, 28000, '28.0k'], [119, 118000, '118.0k']]) {
      await history.locator(`[data-team-community-days="${days}"]`).click();
      await history.locator('[data-chart-fallback] svg').waitFor();
      const fallback = history.locator('svg.tm-line-fallback');
      assert.equal(await fallback.locator('path').count(), 5, 'The optional vendor fallback preserves four team lines and Other');
      assert.equal(await fallback.locator('path[stroke-dasharray]').count(), 1, 'The SVG fallback keeps Other as a dashed line');
      assert(await fallback.locator('circle title').count() > 0, 'Published fallback points expose exact reported daily values');
      assert((await fallback.locator('path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))).every(path => !path.includes('L')), 'Isolated fixture reports stay separated by null publication gaps in the fallback lines');
      assert.equal(await history.locator('[data-team-community-total]').innerText(), display, 'SVG fallback keeps the selected published total');
      assert.equal(await history.locator('[data-team-community-day-inspector]').count(), 1, 'SVG fallback keeps native daily inspection');
      await history.getByText('View daily values', { exact: true }).click();
      await assertCommunityDailyTable(history, days, total);
    }
    assert.equal(ui.requests.some(request => request.path.startsWith('/api/user/') || request.path.startsWith('/api/team/')), false, 'Fallback history also avoids fanout');
    await ui.close();
  }

  console.log('Teams: provider instruments select persistent published readings without navigation or refetching…');
  for (const route of ['/leaderboard?view=teams', '/t/' + TEAM_ID]) {
    const ui = await fixture();
    await ui.page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    const instrument = ui.page.locator(route.startsWith('/t/') ? '.tm-team-page [data-team-provider-instrument]' : '.tm-mix-panel [data-team-provider-instrument]');
    await instrument.waitFor(); await settled(ui.page);
    const group = instrument.getByRole('radiogroup'), reading = instrument.locator('[data-team-provider-reading]');
    const readingNode = await reading.elementHandle();
    const url = ui.page.url(), reads = ui.requests.filter(request => request.path.startsWith('/api/')).length;
    await assertRadioSelection(group, 'data-team-provider', 'openai');
    await instrument.locator('[data-team-provider="anthropic"]').click();
    await assertRadioSelection(group, 'data-team-provider', 'anthropic');
    assert.match(await reading.innerText(), /Anthropic/, 'Selecting a mark names the provider in the persistent reading');
    assert.match(await reading.innerText(), /1(?:\.0{1,2})?M|1,000,000/i, 'The provider reading shows reported token usage');
    assert.match(await reading.innerText(), route.startsWith('/t/') ? /33(?:\.\d+)?\s*%/ : /(?:0(?:\.\d+)?|<\s*1)\s*%/, 'The provider reading shows its share of the actual aggregate');
    const catalog = instrument.locator('a[data-provider-link="anthropic"]');
    assert.equal(await catalog.count(), 1, 'Provider selection keeps a separate provider catalog link');
    const catalogUrl = new URL(await catalog.getAttribute('href'), ui.page.url());
    assert.equal(catalogUrl.pathname.replace(/\/$/, ''), '/models', 'Directory and public crew provider catalog links use the canonical model route');
    assert.equal(catalogUrl.searchParams.get('provider'), 'anthropic');
    if (route.startsWith('/t/')) {
      await ui.page.waitForTimeout(2800);
      assert.match(await reading.innerText(), /Anthropic/, 'A provider reading stays selected beyond the demo watch timeout');
    }
    await selectRadioKey(group, 'data-team-provider', 'Home', 'openai');
    assert.match(await reading.innerText(), /OpenAI/);
    if (route.startsWith('/t/')) {
      assert.match(await reading.innerText(), /2(?:\.0{1,2})?M|2,000,000/i);
      assert.match(await reading.innerText(), /67(?:\.\d+)?\s*%|66\.\d+\s*%/);
    }
    await selectRadioKey(group, 'data-team-provider', 'ArrowRight', 'anthropic');
    await selectRadioKey(group, 'data-team-provider', 'ArrowLeft', 'openai');
    const finalProvider = await group.locator('[data-team-provider]').last().getAttribute('data-team-provider');
    await selectRadioKey(group, 'data-team-provider', 'End', finalProvider);
    await selectRadioKey(group, 'data-team-provider', 'ArrowRight', 'openai');
    assert.equal(await reading.evaluate((node, previous) => node === previous, readingNode), true, 'Inspection updates the existing reading rather than replacing its surface');
    assert.equal(ui.page.url(), url, 'Inspecting a provider never navigates away from team analytics');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Provider inspection uses published aggregates without fetching profiles or catalog data');
    await ui.close();
  }

  console.log('Teams: provider catalog links work as delegated actions and copied native links beneath static mirrors…');
  for (const [prefix, native] of [['', false], ['/project', true]]) {
    const ui = await fixture();
    await ui.page.goto(origin + prefix + '/teams', { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.locator('.tm-mix-panel [data-team-provider="anthropic"]').click();
    const catalog = ui.page.locator('.tm-mix-panel a[data-provider-link="anthropic"]');
    const href = await catalog.evaluate(node => node.href), target = new URL(href);
    assert.equal(target.pathname, prefix + '/models');
    assert.equal(target.searchParams.get('provider'), 'anthropic');
    for (const key of ['ctrlKey', 'metaKey']) assert.equal(await modifierClickHandled(ui.page, key, '.tm-mix-panel a[data-provider-link="anthropic"]'), false, 'Provider catalog links retain native modified-click behavior');
    if (native) await ui.page.goto(href, { waitUntil: 'domcontentloaded' });
    else await catalog.click();
    await ui.page.locator('#mx-rows .mx-row').waitFor();
    assert.equal(await ui.page.evaluate(() => state.view), 'models');
    assert.equal(await ui.page.evaluate(() => mxState().provider), 'anthropic', 'The provider filter survives delegated or native navigation');
    const modelRow = ui.page.locator('#mx-rows .mx-row').first();
    await modelRow.scrollIntoViewIfNeeded();
    assert.match(await modelRow.innerText(), /Fixture Anthropic Model/, 'The real visible catalog row names the filtered model');
    assert(new URL(ui.page.url()).pathname.startsWith(prefix + '/'), 'Provider navigation preserves its site namespace');
    await ui.close();
  }

  console.log('Teams: public crew history uses published day buckets, accessible charts and explicit empty history…');
  {
    const ui = await fixture();
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor();
    assert.deepEqual(await ui.page.locator('.tm-public-stats dd').allTextContents(), ['18', '9', '2.00B', '2'], 'Account memberships and published profile counts remain distinct');
    const analytics = ui.page.locator('.tm-detail-analytics');
    await analytics.waitFor();
    const dayGroup = analytics.getByRole('radiogroup', { name: 'Team activity window', exact: true });
    await assertRadioSelection(dayGroup, 'data-team-days', '30');
    await analytics.locator('[data-team-days="7"]').click();
    await analytics.getByRole('img', { name: /daily team tokens.*published tokens/i }).waitFor();
    const historyTotal = analytics.locator('[data-team-history-total]');
    assert.match(await historyTotal.innerText(), /7(?:\.00|\.0)?k/i, 'The seven-day chart sums only published day buckets in its window');
    const thirty = analytics.locator('[data-team-days="30"]');
    await thirty.focus(); await thirty.press('Space');
    await assertRadioSelection(dayGroup, 'data-team-days', '30');
    assert.match(await historyTotal.innerText(), /17(?:\.0|\.00)?k/i);
    await analytics.getByText('View daily values', { exact: true }).click();
    assert.equal(await analytics.locator('tbody tr').count(), 30, 'Chart values have a readable daily table for the selected UTC window');
    assert.equal(await analytics.locator('tbody td').evaluateAll(cells => cells.reduce((sum, cell) => sum + Number(cell.textContent.replaceAll(',', '')), 0)), 17000, 'Accessible values and visual totals agree');
    await analytics.locator('[data-team-days="119"]').click();
    assert.match(await historyTotal.innerText(), /107(?:\.0|\.00)?k/i);
    await selectRadioKey(dayGroup, 'data-team-days', 'Home', '7');
    assert.match(await historyTotal.innerText(), /7(?:\.00|\.0)?k/i, 'Home immediately selects and paints the seven-day history');
    await selectRadioKey(dayGroup, 'data-team-days', 'ArrowRight', '30');
    await selectRadioKey(dayGroup, 'data-team-days', 'End', '119');
    assert.match(await historyTotal.innerText(), /107(?:\.0|\.00)?k/i, 'End immediately selects the full published history window');
    await selectRadioKey(dayGroup, 'data-team-days', 'ArrowRight', '7');
    await selectRadioKey(dayGroup, 'data-team-days', 'ArrowLeft', '119');
    assert.equal(ui.requests.some(request => request.path.startsWith('/api/user/')), false, 'Team history never fans out into member profile reads');
    assert.equal(ui.requests.some(request => request.path === '/api/leaderboard'), false, 'Crew analytics paint without community rankings');
    await ui.close();
  }
  {
    const ui = await fixture({ daily: [] });
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor();
    const analytics = ui.page.locator('.tm-detail-analytics');
    assert.match(await analytics.innerText(), /history.*(?:not|hasn.t).*published|no.*published.*(?:daily|history)|daily.*(?:not|hasn.t).*published/i, 'Missing published history is described as unavailable');
    assert.equal(await analytics.getByRole('img', { name: /daily.*tokens|tokens.*daily|daily.*usage/i }).count(), 0, 'A missing history is never drawn as a fabricated zero chart');
    assert.equal(await analytics.locator('[data-team-day-inspector]').count(), 0, 'Unpublished history has no fabricated day inspector');
    assert.equal(await analytics.locator('[data-team-peak-day]').count(), 0, 'Unpublished history cannot offer a peak-day action');
    await ui.close();
  }
  {
    const ui = await fixture();
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    const analytics = ui.page.locator('.tm-detail-analytics');
    const inspector = analytics.locator('input[data-team-day-inspector]');
    const reading = analytics.locator('[data-team-day-reading]');
    await inspector.waitFor(); await settled(ui.page);
    assert.equal(await inspector.getAttribute('type'), 'range', 'Daily inspection uses native keyboard and touch input');
    assert.equal(await inspector.getAttribute('min'), '0');
    assert.equal(await inspector.getAttribute('max'), '29', 'The inspector covers the exact selected history window');
    const chart = analytics.locator('.tm-history-chart div.ts-chart[data-chart-id]');
    await chart.waitFor();
    await ui.page.waitForFunction(() => window.__thPerf.chartMounts > 0);
    const chartNode = await chart.elementHandle(), readingNode = await reading.elementHandle();
    const mounts = await ui.page.evaluate(() => window.__thPerf.chartMounts);
    const reads = ui.requests.filter(request => request.path.startsWith('/api/')).length, url = ui.page.url();
    await inspector.focus(); await inspector.press('Home');
    assert.equal(await inspector.inputValue(), '0', 'Home selects the first day through the native range behavior');
    await assertDayReading(inspector, reading, today - 29 * 86400, 0);
    await inspector.press('ArrowRight');
    assert.equal(await inspector.inputValue(), '1', 'ArrowRight advances exactly one reported-day position');
    await assertDayReading(inspector, reading, today - 28 * 86400, 0);
    await inspector.press('End');
    assert.equal(await inspector.inputValue(), '29', 'End selects the last UTC day');
    await assertDayReading(inspector, reading, today, 0);
    await inspector.press('ArrowLeft');
    assert.equal(await inspector.inputValue(), '28', 'ArrowLeft selects the previous UTC day');
    await assertDayReading(inspector, reading, today - 86400, 2000);
    await analytics.locator('[data-team-peak-day]').click();
    assert.equal(await inspector.inputValue(), '19', 'The peak action selects the true peak within the current window');
    await assertDayReading(inspector, reading, today - 10 * 86400, 10000);
    await inspector.evaluate(node => { node.value = '26'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); });
    await assertDayReading(inspector, reading, today - 3 * 86400, 5000);
    assert.equal(await chart.evaluate((node, previous) => node === previous, chartNode), true, 'Changing the inspected point preserves the existing chart host');
    assert.equal(await reading.evaluate((node, previous) => node === previous, readingNode), true, 'The day reading remains a stable persistent surface');
    assert.equal(await ui.page.evaluate(() => window.__thPerf.chartMounts), mounts, 'Native range changes and peak inspection do not remount the chart');
    assert.equal(ui.page.url(), url, 'Daily inspection stays on the public crew route');
    assert.equal(ui.requests.filter(request => request.path.startsWith('/api/')).length, reads, 'Daily inspection and peak selection make no API or profile reads');
    await analytics.getByText('View daily values', { exact: true }).click();
    assert.equal(await analytics.locator('tbody td').evaluateAll(cells => cells.reduce((sum, cell) => sum + Number(cell.textContent.replaceAll(',', '')), 0)), 17000, 'Inspecting a day cannot change the accessible table sum');
    await ui.close();
  }
  {
    const ui = await fixture({ daily: [dailyHistory[0]] });
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor();
    const analytics = ui.page.locator('.tm-detail-analytics');
    await analytics.getByRole('heading', { name: 'No published activity in this window.' }).waitFor();
    assert.equal(await analytics.locator('[data-team-history-total]').innerText(), '0', 'History outside the selected window is distinct from unpublished history');
    await analytics.locator('[data-team-days="119"]').click();
    assert.match(await analytics.locator('[data-team-history-total]').innerText(), /90(?:\.0|\.00)?k/i, 'A longer window reveals the actual older published usage');
    await ui.close();
  }
  {
    const ui = await fixture({ charts: false });
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-public-stats').waitFor();
    const analytics = ui.page.locator('.tm-detail-analytics');
    assert.equal(await ui.page.evaluate(() => Boolean(window.TanStackCharts)), false, 'The fixture exercises the optional chart fallback');
    for (const [days, total, peak] of [[7, '7.0k', '5.0k'], [30, '17.0k', '10.0k']]) {
      await analytics.locator(`[data-team-days="${days}"]`).click();
      const fallback = analytics.locator('[data-chart-fallback] svg');
      await fallback.waitFor();
      assert.equal(await fallback.count(), 1, 'Unavailable optional charts preserve the public history SVG');
      assert((await fallback.textContent()).includes(peak), 'Fallback chart scale follows the largest published day in the selected window');
      assert.equal(await analytics.locator('[data-team-history-total]').innerText(), total, 'Fallback totals follow the selected window');
      await analytics.getByRole('img', { name: /daily team tokens.*published tokens/i }).waitFor();
      await analytics.getByText('View daily values', { exact: true }).click();
      assert.equal(await analytics.locator('tbody tr').count(), days, 'The fallback preserves readable values for the selected day range');
    }
    await ui.close();
  }

  console.log('Teams: responsive details and long names fit 320px–1440px in both palettes…');
  for (const width of [320, 390, 768, 1440]) for (const colorScheme of ['light', 'dark']) {
    const ui = await fixture({ width, colorScheme });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.locator('[data-team-expand="id:long-crew"]').click();
    await settled(ui.page);
    const layout = await ui.page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.tm-row-summary,.tm-row-details:not([hidden]),.tm-controls,.team-invite-banner,.tm-head,.tm-analytics,[data-team-comparison]')];
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, widths: nodes.map(node => ({ name: node.className, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left })), foreground: getComputedStyle(document.querySelector('.tm-page')).color, background: getComputedStyle(document.body).backgroundColor };
    });
    assert(layout.document <= layout.viewport + 1, `${colorScheme} team page overflows at ${width}px: ${JSON.stringify(layout)}`);
    assert(layout.widths.every(node => node.right <= width + 1 && node.left >= -1), 'Team controls and details stay inside viewport');
    assert.notEqual(layout.foreground, layout.background, 'Theme cannot hide text against its surface');
    await assertTouchTargets(ui.page.locator('.tm-profile:visible'), 'Published profile links');
    await assertTouchTargets(ui.page.locator('.tm-mix-panel [data-team-provider]:visible'), 'Provider selectors');
    await ui.page.locator('[data-team-analytics-view="history"]').click();
    const community = ui.page.locator('[data-team-community-history]');
    await community.locator('[data-team-community-days="119"]').click();
    await settled(ui.page);
    const communityLayout = await community.evaluate(node => ({ document: document.documentElement.scrollWidth, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }));
    assert(communityLayout.document <= width + 1 && communityLayout.right <= width + 1 && communityLayout.left >= -1, `${colorScheme} shared time series overflows at ${width}px: ${JSON.stringify(communityLayout)}`);
    await assertTouchTargets(ui.page.locator('[data-team-analytics-view]:visible'), 'Analytics mode controls');
    await assertTouchTargets(community.locator('[data-team-community-days]:visible'), 'Shared history window controls');
    await community.locator('[data-team-community-day-inspector]').focus();
    await community.locator('[data-team-community-day-inspector]').press('End');
    await assertDayReading(community.locator('[data-team-community-day-inspector]'), community.locator('[data-team-community-day-reading]'), today, 500);
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    await ui.page.locator('.tm-detail-analytics [data-team-days="119"]').click();
    await settled(ui.page);
    const historyLayout = await ui.page.locator('.tm-detail-analytics').evaluate(node => ({ document: document.documentElement.scrollWidth, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }));
    assert(historyLayout.document <= width + 1 && historyLayout.right <= width + 1 && historyLayout.left >= -1, `${colorScheme} crew history overflows at ${width}px: ${JSON.stringify(historyLayout)}`);
    await assertTouchTargets(ui.page.locator('.tm-team-page [data-team-provider]:visible'), 'Public team provider selectors');
    await ui.close();
  }

  console.log('Teams: empty state and membership-aware invite actions remain honest…');
  {
    const ui = await fixture({ data: [teams[0]] });
    await open(ui.page);
    await ui.page.getByRole('heading', { name: 'Your crew could be first.' }).waitFor();
    assert.equal(await ui.page.locator('.tm-ranking').count(), 0);
    await ui.page.getByRole('button', { name: 'Create your team', exact: true }).click();
    await ui.page.locator('.signin-modal').waitFor();
    await ui.close();
  }
  for (const role of ['owner', 'member']) {
    const ui = await fixture({ role, holdSession: true, holdAccount: true });
    await open(ui.page);
    await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.waitForFunction(() => state.authStatus === 'checking');
    assert.equal(await ui.page.locator('.team-invite-banner > div > strong').innerText(), 'Bring your friends into orbit.', 'Public team rankings must paint without awaiting a remembered account');
    assert.equal(await ui.page.locator('.team-invite-banner').isVisible(), false, 'The duplicate invite banner stays hidden while remembered membership is unresolved');
    assert.equal(ui.requests.some(request => request.path === '/api/account/team'), false, 'Personal team data waits for verified authentication');
    const crew = ui.page.locator('.tm-directory-actions [data-team-hero-invite]');
    assert.equal(await crew.getAttribute('aria-label'), 'Create your crew', 'Unconfirmed membership keeps the initial accessible crew action');
    const initialText = await (await actionTooltip(crew)).textContent();
    const membershipRead = ui.page.waitForRequest(request => new URL(request.url()).pathname === '/api/account/team');
    await ui.releaseSession();
    await membershipRead;
    const initialDescription = await crew.getAttribute('aria-describedby');
    assert.equal(await ui.page.locator('.team-invite-banner').isVisible(), false, 'Verified sign-in still waits for confirmed crew membership before revealing the banner');
    assert.equal(await ui.page.locator('.tm-ranking > li').count(), 5, 'A pending membership read never blocks public team standings');
    await ui.releaseAccount();
    await ui.page.waitForFunction(() => document.querySelector('.team-invite-banner > div > strong')?.textContent === 'Aurora');
    assert.equal(await ui.page.locator('.team-invite-banner').isVisible(), true, 'Confirmed team membership reveals the crew-specific invite surface');
    assert.match(await ui.page.locator('.team-invite-banner').innerText(), /18 members in your crew/);
    assert.equal(await ui.page.locator('[data-invite-friends]').getAttribute('aria-label'), role === 'owner' ? 'Invite friends' : 'Your team');
    assert.equal(await crew.getAttribute('aria-label'), 'Your crew', 'Authenticated membership updates the accessible crew action');
    assert.equal(await crew.getAttribute('aria-describedby'), initialDescription, 'Auth updates preserve the persistent description association');
    assert.notEqual(await (await actionTooltip(crew)).textContent(), initialText, 'The crew description reflects confirmed membership');
    await assertIconActions(ui.page.getByRole('group', { name: 'Team actions', exact: true }), 'Authenticated directory toolbar');
    await assertIconActions(ui.page.locator('.team-invite-banner'), 'Authenticated crew banner');
    await crew.click(); await ui.page.locator('[data-ti-close]').waitFor();
    assert.equal(await ui.page.locator('[role="tooltip"][data-open]').count(), 0, 'The crew SVG action opens management and closes its tooltip');
    await ui.page.goto(origin + '/t/' + TEAM_ID, { waitUntil: 'domcontentloaded' });
    const manage = ui.page.locator('[data-team-manage-slot] [data-team-manage]');
    await manage.waitFor();
    assert.equal(await manage.getAttribute('aria-label'), 'Your crew', 'The public crew page retains the confirmed management action name');
    await assertIconActions(ui.page.getByRole('group', { name: 'Team actions', exact: true }), 'Authenticated public crew toolbar');
    await manage.click(); await ui.page.locator('[data-ti-close]').waitFor();
    await ui.close();
  }
  console.log('Teams: unavailable tooltip script retains native actions and confirmed crew labels…');
  for (const role of ['owner', 'member']) {
    const ui = await fixture({ role, width: 390, holdSession: true, iconActions: false });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    const group = ui.page.getByRole('group', { name: 'Team actions', exact: true });
    assert.equal(await group.locator('[data-icon-action]').count(), 0, 'The optional tooltip script is genuinely unavailable in this fixture');
    const crew = group.getByRole('button', { name: 'Create your crew', exact: true });
    assert.match(await crew.getAttribute('title'), /create|invite/i, 'Native fallback still explains the initial action');
    await ui.releaseSession();
    const confirmedCrew = group.getByRole('button', { name: 'Your crew', exact: true });
    await confirmedCrew.waitFor();
    assert.match(await confirmedCrew.getAttribute('title'), /crew|membership|invite/i, 'Native fallback description follows confirmed membership');
    await group.getByRole('link', { name: 'Rankings', exact: true }).click(); await assertRankingsDestination(ui.page);
    await group.getByRole('button', { name: 'About teams', exact: true }).click();
    assert.equal(await ui.page.locator('#tm-introduction').isVisible(), true, 'Native fallback disclosure remains usable');
    await ui.page.getByRole('button', { name: 'Close team introduction', exact: true }).click();
    await confirmedCrew.click(); await ui.page.locator('[data-ti-close]').waitFor();
    await ui.close();
  }
  console.log('Team leaderboard UI tests passed.');
} finally { await browser.close(); }
