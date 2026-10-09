import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Exercise the real dashboard and local bundles without Google, production,
// the daemon, or real profile data. The publication predates the test date;
// missing trailing rows must remain empty instead of shifting old usage.
const ORIGIN = 'https://token-horizon.dev';
const docsRoot = path.resolve('docs');
const publicationDay = Date.UTC(2026, 8, 12) / 1000;
const sourceDays = Array.from({ length: 105 }, (_, i) => publicationDay - (118 - i) * 86400 + 14 * 3600);
const daily = sourceDays.map(day => ({ day, tokens: 7500, cost: .25 }));
const modelHistory = [
  { provider: 'anthropic', model: 'claude-opus-5', points: sourceDays.map(day => ({ day, tokens: 4000, cost: .15 })) },
  { provider: 'openai', model: 'gpt-5-codex', points: sourceDays.map(day => ({ day, tokens: 2500, cost: .08 })) }
];
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const entry = {
  id: 'fixture:aurora', handle: 'aurora', team: 'Orbit Studio', avatarUrl: avatar,
  tokensAll: 1250000, tokens7d: 42500, tokensToday: 7500,
  costAll: 42, cost7d: 1.5, costToday: .25, requestsAll: 250,
  inputTokensAll: 800000, outputTokensAll: 450000,
  updatedAt: publicationDay + 12 * 3600, streakDays: 8,
  league: 'master', division: 2, mmr: 2250, efficiency: 78,
  // Hardware is intentionally missing; an unknown machine cannot become Apple Silicon.
  breakdown: {
    daily, modelHistory, history: daily.slice(-7), activeDays: 105, totalSessions: 2,
    models: [
      { provider: 'anthropic', model: 'claude-opus-5', tokensAll: 750000, tokensToday: 4000, sharePercent: 60, requests: 150, costAll: 25, inputTokens: 500000, outputTokens: 250000 },
      { provider: 'openai', model: 'gpt-5-codex', tokensAll: 400000, tokensToday: 2500, sharePercent: 32, requests: 80, costAll: 12, inputTokens: 250000, outputTokens: 150000 }
    ],
    sessions: [{ at: sourceDays.at(-1) + 3600, title: '', provider: 'anthropic', model: 'claude-opus-5', tokens: 4000, requests: 1 }],
    projects: [{ project: 'observatory', tokens: 500000, cost: 15, sessions: 2 }],
    hourly: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  }
};
const profile = {
  ok: true, handle: 'aurora', entry, rank: 3, total: 24, percentile: 90,
  ranks: { today: 3, week: 4, all: 3, streak: 6 }, teamRank: 1, teamTotal: 3,
  league: 'master', division: 2, mmr: 2250, efficiency: 78, rankDelta7d: 2,
  inputTokensAll: entry.inputTokensAll, outputTokensAll: entry.outputTokensAll, requestsAll: entry.requestsAll,
  standing: { league: 'master', division: 2, mmr: 2250, mmrToNext: 150, progressWithinLeague: .65 },
  achievements: [{ id: 'century', title: 'Century Club', detail: '100 requests logged', icon: '💬' }],
  rankHistory: [], season: { displayName: 'Season 3 — Ascension' }
};
const wrongEntry = { ...entry, handle: 'wrong-person', team: 'Wrong Team' };
const leaderboard = { ok: true, total: 1, period: 'today', kpis: {}, movers: {}, leaderboard: [{ rank: 1, entry: wrongEntry, league: 'master', division: 2, mmr: 2250, percentile: 100 }] };
const catalog = {
  schemaVersion: 1, count: 2, providers: [], generatedAt: publicationDay,
  models: entry.breakdown.models.map(m => ({ id: m.provider + '/' + m.model, name: m.model, provider: m.provider, providerName: m.provider === 'anthropic' ? 'Anthropic' : 'OpenAI', contextK: 200, inputPerM: 2, outputPerM: 10, capabilities: { toolCall: true } }))
};
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function setup({ user = 'ready', standings = 'ready', width = 1440, reducedMotion = 'no-preference', publishedProfile = profile, preview = 'ready', clipboard = 'ready', nativeShare = false, auth = 'legacy', oauthReturn = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion });
  await context.addInitScript(({ clipboard, nativeShare }) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
      if (clipboard === 'blocked') throw new DOMException('Clipboard unavailable', 'NotAllowedError');
      window.testCopiedProfile = value;
    } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: nativeShare ? async value => {
      window.testNativeProfile = value;
      throw new DOMException('Share sheet cancelled', 'AbortError');
    } : undefined });
  }, { clipboard, nativeShare });
  if (oauthReturn) await context.addInitScript(saved => {
    sessionStorage.setItem('th_auth_return', JSON.stringify({ ...saved, at: Date.now() }));
  }, oauthReturn);
  if (user === 'body') await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.testProfileRead = { retry: false, headers: 0, aborts: 0 };
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/user/aurora' && !window.testProfileRead.retry) {
        window.testProfileRead.headers++;
        const stream = new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true,"entry":'));
          options.signal.addEventListener('abort', () => {
            window.testProfileRead.aborts++;
            controller.error(new DOMException('Profile body aborted', 'AbortError'));
          }, { once: true });
        } });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return nativeFetch(input, options);
    };
  });
  const page = await context.newPage();
  const errors = [], requests = [], submittedClaims = [];
  const modernAuth = auth !== 'legacy';
  const authIdentity = { provider: auth === 'github' ? 'github' : 'google', sub: 'fixture-account', email: 'fixture@example.test', name: 'Fixture Builder', login: 'fixture' };
  const session = authenticated => ({ ok: true, authenticated, expiresAt: Date.now() + 3600000, user: authenticated ? authIdentity : null });
  let userState = user, releaseUser, releaseStandings;
  const userWait = new Promise(resolve => { releaseUser = resolve; });
  const standingsWait = new Promise(resolve => { releaseStandings = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('https://accounts.google.com/**', route => route.abort());
  await page.route(ORIGIN + '/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: modernAuth ? 'fixture-client' : '', googleAuth: modernAuth, webSessions: modernAuth, githubAuth: modernAuth, canonicalUrl: ORIGIN });
    if (url.pathname === '/api/auth/session') return json(route, session(auth === 'remembered' || auth === 'github'));
    if (url.pathname === '/api/auth/google') return json(route, session(true));
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: [] });
    if (url.pathname === '/api/claim') {
      const claim = route.request().postDataJSON();
      submittedClaims.push(claim);
      if (userState === 'missing') return json(route, { ok: false, error: `Profile @${claim.handle} not found to claim` }, 404);
      return json(route, { ok: true, handle: claim.handle, entry: { ...entry, handle: claim.handle, claimed: true } });
    }
    if (url.pathname === '/api/user/aurora') {
      if (userState === 'held') await userWait;
      if (userState === 'missing') return json(route, { ok: false, error: 'Profile not found' }, 404);
      if (userState === 'error') return json(route, { ok: false, error: 'Temporarily unavailable' }, 503);
      if (userState === 'mismatch') return json(route, { ...profile, handle: wrongEntry.handle, entry: wrongEntry });
      return json(route, publishedProfile);
    }
    if (url.pathname === '/api/user/sol') return json(route, { ...profile, handle: 'sol', entry: { ...entry, handle: 'sol', team: 'Solar Studio' } });
    if (url.pathname === '/api/leaderboard') {
      if (standings === 'held') await standingsWait;
      if (standings === 'error') return json(route, { ok: false, error: 'Unavailable' }, 503);
      return json(route, leaderboard);
    }
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/og/profile/')) return preview === 'ready'
      ? route.fulfill({ contentType: 'image/png', body: await fs.readFile(path.join(docsRoot, 'assets/og.png')) })
      : route.fulfill({ status: 503, body: '' });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    const relative = url.pathname.startsWith('/u/') || ['/leaderboard', '/models', '/login'].includes(url.pathname) ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route(/https?:\/\/(?!token-horizon\.dev\/|accounts\.google\.com\/).*/, route => route.abort());
  return {
    page, context, errors, requests, submittedClaims,
    recover: () => { userState = 'ready'; releaseUser(); },
    close: async () => { releaseUser(); releaseStandings(); await context.close(); assert.deepEqual(errors, [], 'Profile route must not throw browser errors'); }
  };
}

async function assertLoaded(page, timeout = 2500) {
  await page.waitForSelector('#profile-shell', { timeout });
  assert.equal(await page.locator('.pf-loading, .pf-load-error').count(), 0);
  assert.match(await page.locator('#view h1').innerText(), /@?aurora/);
  assert.doesNotMatch(await page.locator('#view').innerText(), /wrong-person|Wrong Team|Apple Silicon|undefined|NaN/);
}

try {
  console.log('Profile first load: the direct user response paints independently of stalled or failed standings...');
  for (const standings of ['held', 'error']) {
    const fixture = await setup({ standings });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(fixture.page);
      assert(fixture.requests.includes('/api/user/aurora'));
      assert.equal(fixture.requests.filter(p => p === '/api/leaderboard').length, 0, 'A direct profile must not read standings before the Comparisons tab');
      assert.match(await fixture.page.locator('.profile-identity').innerText(), /Orbit Studio/);
      const summaries = fixture.page.locator('.profile-totals');
      assert.deepEqual(await summaries.locator('strong').allTextContents(), await fixture.page.evaluate(() => [1250000, 7500, 42500].map(fmtTokens)), 'Aggregate totals use the published values rather than recomputing local windows from UTC daily rows');
      assert.deepEqual(await summaries.locator('small').allTextContents(), ['Across published usage', 'At latest publication', 'Trailing published week']);
      assert.doesNotMatch(await summaries.innerText(), /20\d\d|UTC|–|—/, 'Owner-local aggregate windows must not acquire an inferred UTC date range');
      assert.equal(await fixture.page.locator('.profile-identity .avatar img').getAttribute('src'), avatar);
    } finally { await fixture.close(); }
  }

  console.log('Profile overview: measured provider chart, dated keyboard calendar and league/provider rail...');
  {
    const fixture = await setup();
    const { page } = fixture;
    try {
      await page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(page);
      await page.waitForSelector('.profile-chart svg');
      const chart = await page.locator('.profile-chart').boundingBox();
      const calendar = await page.locator('.profile-calendar').boundingBox();
      const rail = await page.locator('.profile-rail').boundingBox();
      assert(chart && calendar && rail);
      assert(calendar.y >= chart.y + chart.height - 1, 'Usage calendar belongs in a second row beneath the chart');
      assert(rail.x >= chart.x + chart.width - 1, 'League/provider summary belongs in the desktop side rail');
      const legend = await page.locator('.profile-chart-legend').innerText();
      assert.match(legend, /Anthropic/); assert.match(legend, /OpenAI/);
      assert.match(legend, /Unattributed/, 'Daily usage missing a provider split must retain a visible remainder');
      const colors = await page.locator('.profile-chart-legend i').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
      assert(new Set(colors).size >= 2, 'Providers need distinct chart colors');
      await page.waitForFunction(() => [...document.querySelectorAll('.profile-rail .league-icon img')].some(img => img.complete && img.naturalWidth > 0));
      for (const [provider, share] of [['anthropic', '60.0%'], ['openai', '32.0%'], ['unattributed', '8.0%']]) {
        assert((await page.locator('[data-profile-provider="' + provider + '"]').innerText()).includes(share), 'Provider shares use the published all-time total');
      }
      const cells = page.locator('.profile-calendar .cal-cell');
      assert.equal(await cells.count(), 119);
      const tips = await cells.evaluateAll(nodes => nodes.map(node => node.dataset.tip || ''));
      assert(tips.some(tip => tip.includes('7.5k tokens')), 'Timezone-offset published activity must retain measured daily usage');
      const activeDay = Math.floor(sourceDays.at(-1) / 86400) * 86400;
      const labels = await page.evaluate(days => days.map(day => new Date(day * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })), [publicationDay, activeDay]);
      assert(tips.some(tip => tip.startsWith(labels[0] + ' — no ') && tip.endsWith('usage')), 'Trailing empty days remain anchored at the publication date: ' + JSON.stringify(tips.slice(-7)));
      const calendarDays = await page.locator('.profile-calendar [data-cal-day]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.calDay)));
      assert.equal(Math.max(...calendarDays), publicationDay, 'A stale publication must not be rebased to the current date');
      const day = page.locator('[data-cal-day="' + activeDay + '"]');
      assert.equal(await day.getAttribute('role'), 'button');
      assert.equal(await day.getAttribute('tabindex'), '0');
      assert((await day.getAttribute('aria-label')).startsWith(labels[1] + ' — 7.5k'), 'A calendar control announces its date and measured usage');
      await day.focus(); await day.press('Enter');
      await page.waitForSelector('#modal-backdrop.open');
      assert.match(await page.locator('#modal-backdrop').innerText(), /7\.5k tokens/);
      const dayModelLinks = await page.locator('#modal-backdrop [data-model-link]').evaluateAll(nodes => nodes.map(node => node.dataset.model));
      assert.deepEqual([...new Set(dayModelLinks)].sort(), ['claude-opus-5', 'gpt-5-codex']);
      await page.locator('#modal-backdrop [data-close]').first().click();
      // The six existing detail routes must preserve their selection and content.
      const tabs = ['overview', 'usage', 'prompts', 'projects', 'comparisons', 'achievements'];
      assert.equal(await page.locator('.tabs .tab[data-tab]').count(), tabs.length);
      for (const tab of tabs.slice(1)) {
        await page.locator('.tab[data-tab="' + tab + '"]').click();
        await page.waitForFunction(expected => state.profileTab === expected, tab);
        await page.waitForSelector('.tab[data-tab="' + tab + '"][aria-selected="true"]');
        assert.equal(await page.locator('.tab[data-tab="' + tab + '"]').getAttribute('aria-selected'), 'true');
        assert.match(await page.locator('#view h1').innerText(), /aurora/);
        assert.doesNotMatch(await page.locator('#view').innerText(), /undefined|NaN/);
      }
      await page.locator('.tab[data-tab="overview"]').click();
      const opener = page.getByRole('button', { name: 'Share profile', exact: true });
      assert.equal(await opener.getAttribute('aria-describedby'), 'profile-share-hint');
      assert.match(await page.locator('#profile-share-hint').innerText(), /chart, heatmap and league/);
      await opener.click();
      await page.waitForSelector('.profile-share-modal');
      assert.match(await page.locator('#profile-share-description').innerText(), /@aurora.*provider chart.*activity heatmap.*league/);
      await page.waitForSelector('#profile-share-preview-frame.ready');
      assert.match(await page.locator('#profile-share-preview').getAttribute('src'), /\/api\/og\/profile\/aurora\.png\?v=/);
      assert.deepEqual(await page.locator('#profile-share-preview').evaluate(img => [img.naturalWidth, img.naturalHeight]), [1200, 630]);
      assert.equal(await page.locator('#profile-share-link').inputValue(), ORIGIN + '/u/aurora');
      assert.equal(await page.locator('.signin-modal').count(), 0, 'A public profile can be shared without signing in');
      await page.locator('[data-copy-profile="aurora"]').click();
      assert.equal(await page.evaluate(() => window.testCopiedProfile), ORIGIN + '/u/aurora');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.profile-share-modal', { state: 'detached' });
      assert.equal(await opener.evaluate(button => button === document.activeElement), true, 'Closing returns keyboard focus to Share profile');
      await page.locator('[data-share-user="aurora"]').click();
      await page.waitForSelector('.signin-modal');
      assert.match(await page.locator('.signin-modal').innerText(), /Sharing @aurora/);
      await page.locator('.signin-modal [data-close]').first().click();
      await page.locator('#profile-shell [data-model-link]').first().click();
      await page.waitForSelector('#mx-drawer.open');
      assert.match(await page.locator('#mx-drawer').innerText(), /claude-opus-5/);
    } finally { await fixture.close(); }
  }

  console.log('Public profile sharing: mobile sizing, failed previews, clipboard fallback and cancelled native share...');
  {
    const fixture = await setup({ width: 360, preview: 'error', clipboard: 'blocked', nativeShare: true });
    try {
      const { page } = fixture;
      await page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(page);
      await page.getByRole('button', { name: 'Share profile', exact: true }).click();
      await page.waitForSelector('.profile-share-modal');
      await page.waitForFunction(() => document.querySelector('.share-preview-pending')?.textContent.includes('profile link is ready'));
      const box = await page.locator('.profile-share-modal').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 360, 'The dialog stays inside a small mobile viewport');
      await page.getByRole('button', { name: 'Share…', exact: true }).click();
      assert.equal(await page.evaluate(() => window.testNativeProfile.url), ORIGIN + '/u/aurora');
      assert.equal(await page.evaluate(() => window.testCopiedProfile), undefined, 'Cancelling a native share does not copy a link');
      await page.getByRole('button', { name: 'Copy profile link', exact: true }).click();
      assert.deepEqual(await page.locator('#profile-share-link').evaluate(input => [input === document.activeElement, input.selectionStart, input.selectionEnd]), [true, 0, (ORIGIN + '/u/aurora').length], 'Blocked clipboard selects the complete link for manual copy');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.profile-share-modal').count(), 0);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    } finally { await fixture.close(); }
  }

  console.log('SPA search metadata: profile, model tabs and private sign-in follow the visible route...');
  {
    const fixture = await setup();
    try {
      const { page } = fixture;
      await page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(page);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), ORIGIN + '/u/aurora');
      assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'), /\/api\/og\/profile\/aurora\.png/);
      assert.doesNotMatch(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
      assert.equal(JSON.parse(await page.locator('#th-seo-schema').textContent()).mainEntity.name, '@aurora');
      await page.locator('[data-explore-trigger="models"]').click();
  await page.locator('[data-explore-panel] [data-explore-link="explorer"]').click();
      await page.waitForSelector('#mx-q');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), ORIGIN + '/models');
      assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'), /\/assets\/og-models\.png/);
      assert.doesNotMatch(await page.locator('#th-seo-schema').textContent(), /aurora|Person|ProfilePage/);
      await page.locator('[data-models-tab="plans"]').click();
      await page.waitForSelector('[data-models-tab="plans"][aria-selected="true"]');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), ORIGIN + '/models?tab=plans');
      await page.goto(ORIGIN + '/login', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-page');
      assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
      assert.equal(await page.locator('#th-seo-schema').count(), 0, 'Private sign-in does not inherit public profile or catalog schema');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), ORIGIN + '/login');
      assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'), /\/assets\/og-login\.png/);
      await page.getByRole('link', { name: 'Explore without signing in' }).click();
      await page.waitForSelector('.community-periods');
      assert.doesNotMatch(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), ORIGIN + '/leaderboard');
      assert.equal(await page.locator('meta[property="og:image"]').count(), 1);
      assert.equal(await page.locator('meta[name="twitter:image"]').count(), 1);
    } finally { await fixture.close(); }
  }

  console.log('Desktop claim links: sign-in resumes the saved handle and waits for manual confirmation...');
  {
    const fixture = await setup({ auth: 'signed-out' });
    const { page } = fixture;
    try {
      await page.goto(ORIGIN + '/leaderboard?view=players&user=aurora&claim=1', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.signin-modal');
      assert.match(await page.locator('.signin-modal').innerText(), /Claiming @aurora/);
      assert.deepEqual(fixture.submittedClaims, [], 'Opening a claim link must not claim automatically');
      await page.evaluate(() => handleGoogleCredential({ credential: 'fixture.' + btoa(JSON.stringify({ email: 'fixture@example.test', sub: 'fixture-account', exp: Math.floor(Date.now() / 1000) + 3600 })) + '.signature' }));
      await page.waitForSelector('#claim-submit');
      assert.equal(await page.locator('.signin-modal').count(), 0);
      assert.match(await page.locator('#modal-backdrop h2').innerText(), /Claim @aurora/);
      assert.match(await page.locator('#modal-backdrop').innerText(), /After claiming, desktop publishing requires an authorized app write token/);
      assert.equal(await page.locator('#claim-token').getAttribute('type'), 'password');
      assert.equal(await page.locator('#claim-token').inputValue(), '', 'The native credential must not be transferred through a browser URL');
      assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
      assert.deepEqual(fixture.submittedClaims, [], 'Sign-in must not claim automatically');
      await page.locator('#claim-submit').click();
      await page.waitForSelector('#claim-submit', { state: 'detached' });
      assert.deepEqual(fixture.submittedClaims, [{ handle: 'aurora' }], 'Manual confirmation sends the exact handle and no saved token');
      assert.doesNotMatch(page.url(), /claimToken|fixture-account/);
    } finally { await fixture.close(); }
  }
  {
    const fixture = await setup({ auth: 'remembered', user: 'missing' });
    try {
      await fixture.page.goto(ORIGIN + '/leaderboard?view=players&user=aurora&claim=1', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('#claim-submit');
      assert.equal(await fixture.page.locator('.signin-modal').count(), 0, 'Remembered browser identity goes straight to the manual dialog');
      assert.match(await fixture.page.locator('#modal-backdrop').innerText(), /Use Sync now.*before claiming a new handle/);
      assert.deepEqual(fixture.submittedClaims, []);
      await fixture.page.locator('#claim-submit').click();
      await fixture.page.getByText('Profile @aurora not found to claim', { exact: true }).waitFor();
      assert.equal(await fixture.page.locator('#claim-submit').count(), 1, 'A not-yet-published handle keeps the dialog open for recovery');
    } finally { await fixture.close(); }
  }
  {
    const handle = '名字/<img>&signin=1#part';
    const claimPath = '/leaderboard?' + new URLSearchParams({ view: 'players', user: handle, claim: '1' });
    const fixture = await setup({ auth: 'github', oauthReturn: { path: claimPath, resume: { type: 'claim', handle } } });
    try {
      await fixture.page.goto(ORIGIN + claimPath + '&auth=success', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('#claim-submit');
      assert.equal(await fixture.page.locator('#modal-backdrop h2').innerText(), 'Claim @' + handle);
      assert.equal(await fixture.page.locator('#modal-backdrop img').count(), 0, 'A handle is escaped as text');
      assert.doesNotMatch(fixture.page.url(), /auth=success/);
      assert.equal(await fixture.page.evaluate(() => sessionStorage.getItem('th_auth_return')), null, 'OAuth continuation is consumed once');
      assert.deepEqual(fixture.submittedClaims, [], 'GitHub return only opens confirmation');
      await fixture.page.locator('#claim-submit').click();
      await fixture.page.waitForSelector('#claim-submit', { state: 'detached' });
      assert.deepEqual(fixture.submittedClaims, [{ handle }], 'OAuth resumes the full handle rather than an ASCII prefix');
    } finally { await fixture.close(); }
  }

  console.log('Profile provider attribution: gateway and subscription providers survive model names without redistributing unknown usage...');
  {
    const gatewayProfile = { ...profile, entry: { ...entry, breakdown: {
      ...entry.breakdown,
      models: entry.breakdown.models.map((model, index) => ({ ...model, provider: index ? 'opencode-go' : 'openrouter' })),
      modelHistory: modelHistory.map((series, index) => ({ ...series, provider: index ? 'opencode-go' : 'openrouter' }))
    } } };
    const fixture = await setup({ publishedProfile: gatewayProfile });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(fixture.page);
      const legend = await fixture.page.locator('.profile-chart-legend').innerText();
      assert.match(legend, /OpenRouter/); assert.match(legend, /OpenCode/); assert.match(legend, /Unattributed/);
      assert.doesNotMatch(legend, /Anthropic|OpenAI/, 'Model family must not replace an explicitly reported usage provider');
      assert.equal(await fixture.page.locator('[data-profile-provider="openrouter"]').count(), 1);
      assert.equal(await fixture.page.locator('[data-profile-provider="opencode"]').count(), 1);
      assert.equal(await fixture.page.locator('[data-profile-provider="anthropic"], [data-profile-provider="openai"]').count(), 0);
      assert.match(await fixture.page.locator('.profile-inventory tbody').innerText(), /OpenRouter/);
      assert.match(await fixture.page.locator('.profile-inventory tbody').innerText(), /OpenCode/);
      const unknown = await fixture.page.locator('[data-profile-provider="unattributed"] .profile-provider-bar i').evaluate(node => getComputedStyle(node).backgroundColor);
      const unknownChart = await fixture.page.locator('.profile-chart-legend > span').filter({ hasText: 'Unattributed' }).locator('i').evaluate(node => getComputedStyle(node).backgroundColor);
      assert.equal(unknown, 'rgb(166, 177, 168)', 'Unassigned all-time usage must retain the neutral color');
      assert.equal(unknownChart, unknown, 'Unassigned daily usage uses the same neutral color');
    } finally { await fixture.close(); }
  }

  console.log('Profile historical fallback: empty daily arrays and missing publication timestamps anchor to actual history...');
  for (const source of ['history', 'modelHistory']) {
    const fallbackEntry = { ...entry, updatedAt: undefined, breakdown: { ...entry.breakdown, daily: [], history: source === 'history' ? daily : [] } };
    const fixture = await setup({ publishedProfile: { ...profile, entry: fallbackEntry } });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await assertLoaded(fixture.page);
      const anchor = Math.floor(sourceDays.at(-1) / 86400) * 86400;
      const days = await fixture.page.locator('.profile-calendar [data-cal-day]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.calDay)));
      assert.equal(Math.max(...days), anchor, source + ' must use the latest published date, even when daily is an empty array');
      const label = await fixture.page.evaluate(day => new Date(day * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }), anchor);
      assert.equal(await fixture.page.locator('.profile-published time').innerText(), label);
      const active = fixture.page.locator('[data-cal-day="' + anchor + '"]');
      assert((await active.getAttribute('aria-label')).includes(source === 'history' ? '7.5k tokens' : '6.5k tokens'), source + ' supplies the measured fallback daily total');
      await active.focus(); await active.press('Enter');
      await fixture.page.waitForSelector('#modal-backdrop.open');
      assert.match(await fixture.page.locator('#modal-backdrop').innerText(), source === 'history' ? /7\.5k tokens/ : /6\.5k tokens/);
    } finally { await fixture.close(); }
  }

  console.log('Profile missing/error states: unrelated leaderboard rows are never substituted, and retry recovers...');
  for (const user of ['missing', 'error', 'mismatch']) {
    const fixture = await setup({ user });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('.pf-load-error');
      assert.equal(await fixture.page.locator('#profile-shell, .pf-loading').count(), 0);
      assert.doesNotMatch(await fixture.page.locator('#view').innerText(), /wrong-person|Wrong Team|1\.25M|1\.3M|No players yet/);
      assert.equal(await fixture.page.evaluate(() => state.profileLoad.status), user === 'mismatch' ? 'error' : user);
      if (user === 'error') {
        fixture.recover();
        await fixture.page.locator('#pf-retry').click();
        await assertLoaded(fixture.page);
        assert.equal(fixture.requests.filter(p => p === '/api/user/aurora').length, 2);
      }
    } finally { await fixture.close(); }
  }

  console.log('Profile route races: an old held request cannot replace a newer profile...');
  {
    const fixture = await setup({ user: 'held' });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('.pf-loading');
      await fixture.page.evaluate(() => navigate('players', { handle: 'sol' }));
      await fixture.page.waitForFunction(() => document.querySelector('#profile-shell h1')?.textContent === '@sol');
      const staleResponse = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/aurora');
      fixture.recover();
      await (await staleResponse).finished();
      await fixture.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await fixture.page.locator('#view h1').innerText(), '@sol');
      assert.equal(await fixture.page.evaluate(() => state.user.handle), 'sol');
      assert.equal(await fixture.page.evaluate(() => state.profileLoad.handle), 'sol');
    } finally { await fixture.close(); }
  }

  console.log('Profile response deadline: an unfinished JSON body becomes retryable instead of spinning forever...');
  {
    const fixture = await setup({ user: 'body' });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('.pf-load-error', { timeout: 6500 });
      const reads = await fixture.page.evaluate(() => window.testProfileRead);
      assert.equal(reads.headers, 1); assert.equal(reads.aborts, 1);
      assert.equal(await fixture.page.locator('.pf-loading, #profile-shell').count(), 0);
      await fixture.page.evaluate(() => { window.testProfileRead.retry = true; });
      await fixture.page.locator('#pf-retry').click();
      await assertLoaded(fixture.page);
    } finally { await fixture.close(); }
  }

  console.log('Profile skeleton/reduced motion and phone layout remain usable at 390px and 320px...');
  {
    const fixture = await setup({ user: 'held', width: 390, reducedMotion: 'reduce' });
    try {
      await fixture.page.goto(ORIGIN + '/u/aurora', { waitUntil: 'domcontentloaded' });
      await fixture.page.waitForSelector('.pf-loading[role="status"]');
      assert.equal(await fixture.page.locator('.pf-loading').getAttribute('aria-busy'), 'true');
      const loadingAnimations = await fixture.page.locator('.pf-loading, .pf-loading .skeleton').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().filter(animation => animation.playState === 'running').map(animation => animation.effect.getTiming().duration)));
      assert(loadingAnimations.every(duration => typeof duration === 'number' && duration <= 1), 'Reduced motion must disable the profile loading animation');
      fixture.recover();
      await assertLoaded(fixture.page);
      for (const width of [390, 320]) {
        await fixture.page.setViewportSize({ width, height: 844 });
        for (const tab of ['overview', 'usage', 'prompts', 'projects', 'comparisons', 'achievements']) {
          await fixture.page.locator('.tab[data-tab="' + tab + '"]').click();
          await fixture.page.waitForSelector('.tab[data-tab="' + tab + '"][aria-selected="true"]');
          const overflow = await fixture.page.evaluate(() => ({ body: document.documentElement.scrollWidth, width: innerWidth, shell: document.querySelector('#profile-shell').scrollWidth, box: document.querySelector('#profile-shell').clientWidth }));
          assert(overflow.body <= overflow.width + 1 && overflow.shell <= overflow.box + 1, 'Profile ' + tab + ' overflows at ' + width + 'px: ' + JSON.stringify(overflow));
        }
      }
    } finally { await fixture.close(); }
  }
  console.log('Profile UI regression passed.');
} finally { await browser.close(); }
