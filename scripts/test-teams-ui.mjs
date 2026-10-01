import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Exercise real team markup, navigation, assets and shared theme using public
// fixtures. No production account, invite or membership is created or changed.
const origin = 'https://token-horizon.dev', docsRoot = path.resolve('docs');
const users = Array.from({ length: 6 }, (_, index) => ({ handle: index === 0 ? 'pilot' : 'crew' + index, tokensAll: 1000000, avatarUrl: '', avatarStyle: 'identicon' }));
const longName = 'InterstellarObservabilityAndModelOptimisationCollectiveWithAnUnusuallyLongTeamName';
const teams = [
  { team: 'Unassigned', tokens: 99000000000, cost: 900, members: 100, users, providers: {} },
  { team: 'Aurora', teamId: 'canonical-aurora', tokens: 2000000000, cost: 120, members: 9, users, providers: { openai: 2000000, anthropic: 1000000 } },
  { team: longName, teamId: 'long-crew', tokens: 1500000000, cost: 70, members: 12, users: [{ handle: 'stellar', tokensAll: 1000 }], providers: { google: 1000000 } },
  { team: 'Aurora', tokens: 1000000000, cost: 25, members: 2, users: [{ handle: 'legacy-pilot' }], providers: { openai: 500000000 } },
  { team: 'Small crew', teamId: 'small-crew', tokens: 500000000, cost: 20, members: 1, users: [{ handle: 'solo' }], providers: {} },
  // A real team can use this name; only the synthetic unassigned bucket is excluded.
  { team: 'Unassigned', teamId: 'real-unassigned', tokens: 2000000, cost: 1, members: 1, users: [{ handle: 'named-crew' }], providers: {} }
];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ data = teams, width = 1440, colorScheme = 'light', hold = false, fail = false, role = '', holdSession = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], requests = [];
  let release, releaseSession, failure = fail;
  const user = role ? { provider: 'github', sub: '42', login: 'pilot', name: 'Pilot', email: 'pilot@example.com' } : null;
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'Cache-Control': 'max-age=30' } });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method() });
    if (url.origin !== origin) return route.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return json(route, { error: 'This fixture never mutates teams.' }, 405);
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: '', webSessions: true, googleAuth: false, githubAuth: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') {
      const send = () => json(route, { ok: true, authenticated: Boolean(user), user, expiresAt: user ? Date.now() + 86400000 : null });
      if (holdSession) { releaseSession = send; return; }
      return send();
    }
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: user ? [{ handle: 'pilot' }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: role ? { id: 'canonical-aurora', name: 'Aurora', role, memberCount: 18 } : null, invites: [] });
    if (url.pathname === '/api/providers') {
      const send = () => failure ? json(route, { error: 'Usage is temporarily unavailable.' }, 503) : json(route, { teams: data, providers: [], history: { points: [], providers: [] } });
      if (hold) { release = send; return; }
      return send();
    }
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, leaderboard: [], total: 0, kpis: {}, movers: {}, usageHistory: { points: [], providers: [] } });
    if (url.pathname.startsWith('/api/user/')) {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      return json(route, { ok: true, handle, entry: { handle, tokensAll: 1000000, tokensToday: 1000, tokens7d: 100000, costAll: 1, breakdown: { models: [], projects: [], sessions: [], daily: [], modelHistory: [] } }, rank: 1, ranks: {}, rankHistory: [] });
    }
    if (url.pathname.startsWith('/api/')) return json(route, {});
    const relative = ['/leaderboard', '/leaderboard.html'].includes(url.pathname) || url.pathname.startsWith('/u/') ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/"/>'));
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, requests, async release() { assert(release, 'Provider request must be pending'); hold = false; await release(); }, async releaseSession() { assert(releaseSession, 'Remembered-session request must be pending'); holdSession = false; await releaseSession(); }, recover() { failure = false; }, async close() {
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

try {
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
    assert.match(await ui.page.locator('.tm-community-stats').innerText(), /5[\s\S]*25[\s\S]*5\.00B/);
    const canonical = ui.page.locator('[data-team-expand="id:canonical-aurora"]');
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
    assert.equal(await ui.page.locator('.tm-team-name>strong').first().innerText(), longName);
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
    assert.equal(await ui.page.evaluate(() => state.teamFilter), 'canonical-aurora');
    assert.equal(new URL(ui.page.url()).searchParams.get('period'), 'all');
    await ui.close();
  }

  console.log('Teams: responsive details and long names fit 320px–1440px in both palettes…');
  for (const width of [320, 390, 768, 1440]) for (const colorScheme of ['light', 'dark']) {
    const ui = await fixture({ width, colorScheme });
    await open(ui.page); await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.locator('[data-team-expand="id:long-crew"]').click();
    await settled(ui.page);
    const layout = await ui.page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.tm-row-summary,.tm-row-details:not([hidden]),.tm-controls,.team-invite-banner,.tm-head')];
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, widths: nodes.map(node => ({ name: node.className, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left })), foreground: getComputedStyle(document.querySelector('.tm-page')).color, background: getComputedStyle(document.body).backgroundColor };
    });
    assert(layout.document <= layout.viewport + 1, `${colorScheme} team page overflows at ${width}px: ${JSON.stringify(layout)}`);
    assert(layout.widths.every(node => node.right <= width + 1 && node.left >= -1), 'Team controls and details stay inside viewport');
    assert.notEqual(layout.foreground, layout.background, 'Theme cannot hide text against its surface');
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
    const ui = await fixture({ role, holdSession: true });
    await open(ui.page);
    await ui.page.locator('.tm-ranking').waitFor();
    await ui.page.waitForFunction(() => state.authStatus === 'checking');
    assert.equal(await ui.page.locator('.team-invite-banner strong').innerText(), 'Bring your friends into orbit.', 'Public team rankings must paint without awaiting a remembered account');
    assert.equal(ui.requests.some(request => request.path === '/api/account/team'), false, 'Personal team data waits for verified authentication');
    await ui.releaseSession();
    await ui.page.waitForFunction(() => document.querySelector('.team-invite-banner strong')?.textContent === 'Aurora');
    assert.match(await ui.page.locator('.team-invite-banner').innerText(), /18 members in your crew/);
    assert.equal((await ui.page.locator('[data-invite-friends]').innerText()).trim(), role === 'owner' ? 'Invite friends' : 'Your team');
    await ui.close();
  }
  console.log('Team leaderboard UI tests passed.');
} finally { await browser.close(); }
