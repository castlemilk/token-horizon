import { chromium } from '/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs';
import path from 'path';

/**
 * Hermetic UI regression for the TokenArena dashboard. All API calls are
 * intercepted with fixtures, so the test never touches production or the
 * local daemon. Covers every routed view plus the share modal.
 */

// Local day starts (matching the engine's Calendar.current.startOfDay buckets
// and the dashboard calendar's local grid).
const FIXTURE_DAYS = (() => {
  const now = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  return Array.from({ length: 20 }, (_, i) => start - (19 - i) * 86400);
})();

const entry = (handle, extra = {}) => ({
  id: 'local:' + handle,
  handle,
  team: handle === 'benebsworth' ? 'Castlemilk' : 'Engineering',
  tokensToday: 1234567,
  tokens7d: 7654321,
  tokensAll: 23844909130,
  costToday: 12.5,
  cost7d: 88.2,
  costAll: 381.5,
  streakDays: 9,
  topModel: 'claude-opus-5',
  hardware: 'Apple M5 Max',
  isLocal: handle === 'benebsworth',
  updatedAt: Date.now() / 1000,
  mmr: 2860,
  league: 'grandmaster',
  division: 1,
  efficiency: 87,
  inputTokensAll: 14000000000,
  outputTokensAll: 5000000000,
  requestsAll: 4120,
  seasonTokens: 4200000000,
  achievements: [{ id: 'century', title: 'Century Club', detail: '100+ requests logged', icon: '💬' }],
  breakdown: {
    models: [
      { provider: 'anthropic', model: 'claude-opus-5', tokensToday: 900000, tokensAll: 14000000000, costToday: 9, costAll: 300, sharePercent: 62, inputTokens: 7000000000, outputTokens: 2500000000, requests: 2100 },
      { provider: 'openai', model: 'gpt-5-codex', tokensToday: 300000, tokensAll: 5000000000, costToday: 3, costAll: 81, sharePercent: 24, inputTokens: 2000000000, outputTokens: 900000000, requests: 900 }
    ],
    tools: [],
    history: [
      { day: 1, dayLabel: 'Mon', tokens: 900000000, cost: 20 },
      { day: 2, dayLabel: 'Tue', tokens: 1100000000, cost: 24 },
      { day: 3, dayLabel: 'Wed', tokens: 800000000, cost: 18 },
      { day: 4, dayLabel: 'Thu', tokens: 1300000000, cost: 29 },
      { day: 5, dayLabel: 'Fri', tokens: 1000000000, cost: 22 },
      { day: 6, dayLabel: 'Sat', tokens: 400000000, cost: 9 },
      { day: 7, dayLabel: 'Sun', tokens: 1200000000, cost: 26 }
    ],
    activeDays: 17,
    totalSessions: 12,
    projects: [{ project: 'token-horizon', tokens: 9000000000, cost: 120, sessions: 5 }],
    hourly: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 18 ? 500000 + d * 1000 + h : 0))),
    sessions: [
      { title: 'Code review assistant', provider: 'anthropic', model: 'claude-opus-5', tokens: 1200000, cost: 4.2, requests: 12, at: FIXTURE_DAYS[FIXTURE_DAYS.length - 1] + 3600 },
      { title: '', provider: 'openai', model: 'gpt-5-codex', tokens: 800000, cost: 2.1, requests: 8, at: FIXTURE_DAYS[FIXTURE_DAYS.length - 2] + 7200 }
    ],
    modelHistory: [
      { model: 'claude-opus-5', provider: 'anthropic', points: FIXTURE_DAYS.map((d, i) => ({ day: d, dayLabel: 'D' + i, tokens: 500000000 + i * 10000000, cost: 0 })) },
      { model: 'gpt-5-codex', provider: 'openai', points: FIXTURE_DAYS.map((d, i) => ({ day: d, dayLabel: 'D' + i, tokens: 200000000 + i * 5000000, cost: 0 })) }
    ],
    daily: FIXTURE_DAYS.map((d, i) => ({ day: d, dayLabel: 'D' + i, tokens: 700000000 + i * 15000000, cost: 12 + i })).filter(d => d.tokens > 0)
  },
  snapshots: [
    { day: 1, tokensAll: 20000000000, tokens7d: 5000000, costAll: 300, mmr: 2700, league: 'master', rank: 6, providers: { anthropic: 12000000000 } },
    { day: 8, tokensAll: 23844909130, tokens7d: 7654321, costAll: 381.5, mmr: 2860, league: 'grandmaster', rank: 5, providers: { anthropic: 14000000000 } }
  ],
  ...extra
});

const ranked = (e, rank) => ({
  rank,
  badge: rank === 1 ? '🥇 1st' : '#' + rank,
  percentile: rank === 1 ? 100 : 50,
  score: e.tokensToday,
  scoreFormatted: '1.2M',
  costFormatted: '$12.50',
  relativePercent: rank === 1 ? 100 : 60,
  league: e.league,
  leagueTitle: 'Grandmaster',
  leagueColor: '#F0446B',
  division: e.division,
  mmr: e.mmr,
  mmrToNext: null,
  efficiency: e.efficiency,
  rankDelta7d: rank === 1 ? 2 : -1,
  avgPerRequest: 4100,
  inputFormatted: '1.2M',
  outputFormatted: '400k',
  requestsFormatted: '412',
  trend: [4, 6, 5, 8, 7, 9, 6],
  entry: e
});

const ben = entry('benebsworth');
const sam = entry('samrivera', { isLocal: false, league: 'master', division: 2, mmr: 2120 });
const FIXTURES = {
  '/api/config': {
    ok: true,
    googleClientId: '',
    googleAuth: false,
    canonicalUrl: 'https://token-horizon.dev',
    season: { displayName: 'Season 3 — Ascension' }
  },
  '/api/leaderboard': {
    ok: true,
    period: 'today',
    total: 2,
    season: { id: '2026-Q3', number: 3, name: 'Ascension', displayName: 'Season 3 — Ascension', start: '2026-07-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', daysRemaining: 20, progress: 0.78 },
    leagueLadder: [],
    kpis: { totalTokens: 25000000000, totalTokensFormatted: '25.00B', totalCost: 400, totalCostFormatted: '$400', activeDevs: 2, maxStreakDays: 9, totalRequests: 4120, totalRequestsFormatted: '4.1k', avgTokensPerRequest: 4100, totalTokensDelta: 12.5, totalCostDelta: 8.2, activeDevsDelta: 5 },
    movers: {
      gains: [{ handle: 'samrivera', team: 'Engineering', avatarUrl: '', league: 'master', leagueTitle: 'Master', tokensAll: 5000000, delta: 2000000, deltaFormatted: '2.0M', percent: 40, rank: 2, rankDelta: 1 }],
      drops: [],
      improved: [{ handle: 'samrivera', team: 'Engineering', avatarUrl: '', league: 'master', leagueTitle: 'Master', tokensAll: 5000000, delta: 2000000, deltaFormatted: '2.0M', percent: 40, rank: 2, rankDelta: 1 }],
      promotions: []
    },
    usageHistory: {
      labels: ['Sep 4', 'Sep 5', 'Sep 6', 'Sep 7', 'Sep 8', 'Sep 9', 'Sep 10'],
      series: [
        { model: 'claude-opus-5', provider: 'anthropic', total: 3500000000, values: [400000000, 450000000, 500000000, 520000000, 480000000, 550000000, 600000000] },
        { model: 'gpt-5-codex', provider: 'openai', total: 1400000000, values: [150000000, 180000000, 200000000, 210000000, 190000000, 230000000, 240000000] }
      ],
      total: 4900000000
    },
    leaderboard: [ranked(ben, 1), ranked(sam, 2)]
  },
  '/api/user/benebsworth': {
    ok: true,
    handle: 'benebsworth',
    rank: 1,
    badge: '🥇 1st',
    ranks: { today: 1, week: 1, all: 1, streak: 1 },
    total: 2,
    percentile: 100,
    standing: { league: 'grandmaster', leagueTitle: 'Grandmaster', leagueColor: '#F0446B', division: 1, mmr: 2860, mmrToNext: null, progressWithinLeague: 0.65 },
    league: 'grandmaster',
    division: 1,
    mmr: 2860,
    mmrToNext: null,
    efficiency: 87,
    rankDelta7d: 2,
    teamRank: 1,
    teamTotal: 1,
    requestsAll: 4120,
    inputTokensAll: 14000000000,
    outputTokensAll: 5000000000,
    achievements: [{ id: 'century', title: 'Century Club', detail: '100+ requests logged', icon: '💬' }, { id: 'top_decile', title: 'Top 10%', detail: 'Ranked in the global top 10%', icon: '👑' }],
    rankHistory: [{ day: 1, rank: 6, tokensAll: 20000000000, mmr: 2700, league: 'master' }, { day: 8, rank: 5, tokensAll: 23844909130, mmr: 2860, league: 'grandmaster' }],
    season: { displayName: 'Season 3 — Ascension' },
    entry: ben
  },
  '/api/providers': {
    ok: true,
    total: 19000000000,
    totalFormatted: '19.00B',
    providers: [{ provider: 'anthropic', tokens: 14000000000, cost: 300, requests: 2100, inputTokens: 7000000000, outputTokens: 2500000000, models: 1, users: 2, avgCostPerM: 0.0214, tokensFormatted: '14.00B', costFormatted: '$300', avgCostPerMText: '$0.0214', sharePercent: 73.7 }],
    history: { providers: ['anthropic'], points: [{ day: 1, date: '2026-09-01', values: { anthropic: 1000000000 }, total: 1000000000 }, { day: 2, date: '2026-09-02', values: { anthropic: 1200000000 }, total: 1200000000 }] },
    teams: [{ team: 'Engineering', tokens: 5000000000, cost: 100, members: 2, providers: { anthropic: 4000000000, openai: 1000000000 }, tokensFormatted: '5.00B', costFormatted: '$100', users: [{ handle: 'samrivera', tokensAll: 5000000000, avatarUrl: '' }] }],
    topPrompts: [{ title: 'Code review assistant', provider: 'anthropic', model: 'claude-opus-5', tokens: 1200000, cost: 4.2, handle: 'benebsworth' }],
    insights: { mostUsed: { provider: 'anthropic', sharePercent: 73.7 }, mostEfficient: { provider: 'anthropic', avgCostPerM: 0.02 }, biggestGrowth: { handle: 'samrivera', percent: 40 } }
  },
  '/api/season': {
    ok: true,
    season: { id: '2026-Q3', number: 3, name: 'Ascension', displayName: 'Season 3 — Ascension', start: '2026-07-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', daysRemaining: 20, progress: 0.78 },
    ladder: [],
    distribution: [{ id: 'grandmaster', title: 'Grandmaster', users: 1, tokens: 23844909130, percent: 50, color: '#F0446B' }, { id: 'master', title: 'Master', users: 1, tokens: 5000000000, percent: 50, color: '#B44CF0' }],
    standings: [{ handle: 'benebsworth', team: 'Castlemilk', avatarUrl: '', league: 'grandmaster', leagueTitle: 'Grandmaster', leagueColor: '#F0446B', division: 1, mmr: 2860, tokensAll: 23844909130, tokensFormatted: '23.84B' }],
    promotions: [{ handle: 'samrivera', team: 'Engineering', from: 'Diamond', to: 'Master', at: 1726000000 }],
    climbers: [],
    rewards: [{ icon: '👑', title: 'Higher Token Quotas', detail: 'Larger rate limits for higher leagues.' }]
  },
  '/api/prompts': {
    ok: true,
    count: 2,
    prompts: [
      { title: 'Code review assistant', provider: 'anthropic', model: 'claude-opus-5', tokens: 1200000, cost: 4.2, requests: 12, at: 1726000000, handle: 'benebsworth', team: 'Castlemilk' },
      { title: 'Research summary', provider: 'openai', model: 'gpt-5-codex', tokens: 800000, cost: 2.1, requests: 8, at: 1725990000, handle: 'benebsworth', team: 'Castlemilk' }
    ]
  }
};

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const errors = [];
  const apiUrls = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));
  page.on('request', r => { if (r.url().includes('/api/')) apiUrls.push(r.url()); });

  await page.route('https://token-horizon.dev/api/**', async route => {
    const url = new URL(route.request().url());
    const fixture = FIXTURES[url.pathname];
    if (fixture) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not found' }) });
  });

  const filePath = 'file://' + path.resolve('docs/leaderboard.html');

  console.log('1. Loading leaderboard view...');
  await page.goto(filePath);
  await page.waitForSelector('#lb-table tbody tr');
  const rows = await page.$$('#lb-table tbody tr');
  if (rows.length !== 2) throw new Error(`Expected 2 leaderboard rows, found ${rows.length}`);
  const tiers = await page.$$('.tier[data-league]');
  if (tiers.length !== 7) throw new Error(`Expected 7 league tiers, found ${tiers.length}`);
  // Generated tier badges must load (not fall back to the SVG placeholder).
  const badges = await page.$$eval('.tier[data-league] .league-icon img', els => els.map(e => ({ complete: e.complete, w: e.naturalWidth })));
  if (badges.length !== 7 || badges.some(b => !b.complete || b.w === 0)) {
    throw new Error('League badge assets did not load');
  }
  const kpis = await page.$$('.kpi-value');
  if (kpis.length < 4) throw new Error('Missing KPI cards');
  // TanStack stacked usage-by-model chart (vendored bundle must load).
  await page.waitForSelector('.ts-chart svg', { timeout: 10000 });
  const chartSeries = await page.evaluate(() => state.chartHosts.length);
  if (chartSeries < 1) throw new Error('TanStack chart host was not mounted');
  // DiceBear generated avatars + provider brand marks.
  const genAvatars = await page.$$eval('#lb-table tbody .avatar svg', els => els.length);
  if (genAvatars === 0) throw new Error('DiceBear avatars did not render');
  const logos = await page.$$eval('.prov-logo', els => els.length);
  if (logos === 0) throw new Error('Provider logos did not render');
  // Official brand marks (docs/assets/brands) must load, not fall back to glyphs.
  const brandImgs = await page.$$eval('.prov-logo img', els => els.map(e => ({ complete: e.complete, w: e.naturalWidth })));
  if (brandImgs.length === 0 || brandImgs.some(b => !b.complete || b.w === 0)) {
    throw new Error('Brand logo assets did not load');
  }
  // Chart legend: provider logo + color swatch + description per series.
  const legendItems = await page.$$eval('.chart-legend .legend-item', els => els.map(el => ({
    logo: !!el.querySelector('.prov-logo'),
    swatch: !!el.querySelector('.legend-swatch'),
    name: el.querySelector('.legend-name')?.textContent || '',
    desc: el.querySelector('.legend-desc')?.textContent || ''
  })));
  if (legendItems.length < 2) throw new Error(`Expected >=2 legend items, found ${legendItems.length}`);
  if (legendItems.some(l => !l.logo || !l.swatch || !l.name || !/·/.test(l.desc))) {
    throw new Error(`Legend items missing logo/swatch/description: ${JSON.stringify(legendItems)}`);
  }
  // Dense stacked columns: near-zero gap between adjacent x bands.
  const columns = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('#view .ts-chart svg rect')]
      .filter(r => r.getAttribute('fill') && r.getAttribute('fill') !== 'none' && Number(r.getAttribute('width')) > 1)
      .map(r => ({ x: parseFloat(r.getAttribute('x')), w: parseFloat(r.getAttribute('width')) }));
    const byX = new Map();
    for (const r of rects) {
      const key = Math.round(r.x);
      const cur = byX.get(key) || { left: r.x, right: r.x + r.w };
      cur.left = Math.min(cur.left, r.x);
      cur.right = Math.max(cur.right, r.x + r.w);
      byX.set(key, cur);
    }
    const sorted = [...byX.values()].sort((a, b) => a.left - b.left);
    const gaps = sorted.slice(1).map((c, i) => Math.max(0, c.left - sorted[i].right));
    return { count: sorted.length, maxGap: Math.max(0, ...gaps) };
  });
  if (columns.count < 7) throw new Error(`Expected >=7 chart columns, found ${columns.count}`);
  if (columns.maxGap > 10) throw new Error(`Chart columns are not dense: max gap ${columns.maxGap.toFixed(1)}px`);
  // Warm host reuse: revisiting a chart view adopts the mounted host.
  await page.evaluate(async () => { state.view = 'models'; renderNav(); await render(); });
  await page.evaluate(async () => { state.view = 'leaderboard'; renderNav(); await render(); });
  const perfBefore = await page.evaluate(() => ({ ...window.__thPerf }));
  await page.evaluate(async () => { state.view = 'models'; renderNav(); await render(); });
  await page.evaluate(async () => { state.view = 'leaderboard'; renderNav(); await render(); });
  const perfAfter = await page.evaluate(() => ({ ...window.__thPerf }));
  if (perfAfter.chartMounts !== perfBefore.chartMounts) {
    throw new Error(`Charts remounted on revisit: ${perfBefore.chartMounts} → ${perfAfter.chartMounts} mounts`);
  }
  if (perfAfter.chartReuses <= perfBefore.chartReuses) throw new Error('Chart hosts were not reused on revisit');
  await page.evaluate(async () => { state.view = 'leaderboard'; renderNav(); await render(); });
  // Range pill drives the remote history window.
  if (!apiUrls.some(u => u.includes('historyDays=30'))) throw new Error('Initial load did not request historyDays=30');
  for (let i = 0; i < 4; i++) { await page.click('#range-pill'); await page.waitForTimeout(180); }
  if (!apiUrls.some(u => u.includes('historyDays=7'))) throw new Error('Range pill did not request historyDays=7');
  if (!apiUrls.some(u => u.includes('historyDays=90'))) throw new Error('Range pill did not request historyDays=90');
  console.log(`   rows=${rows.length} tiers=${tiers.length} kpis=${kpis.length} charts=${chartSeries} avatars=${genAvatars} logos=${logos} brands=${brandImgs.length}`);
  console.log(`   legend=${legendItems.length} columns=${columns.count} (maxGap=${columns.maxGap.toFixed(1)}px) chartMounts=${perfAfter.chartMounts} reuses=${perfAfter.chartReuses}`);

  console.log('2. Opening player profile from a row...');
  await page.locator('#lb-table tbody tr').first().click();
  await page.waitForSelector('.tabs .tab');
  if (!(await page.locator('h1').first().textContent()).includes('Player Profile')) throw new Error('Player profile did not render');
  const stats = await page.$$('.stat');
  if (stats.length < 8) throw new Error(`Expected >=8 stat cards, found ${stats.length}`);
  if (!page.url().includes('user=')) throw new Error('URL missing ?user=');
  const calCells = await page.$$eval('.cal-grid .cal-cell', els => els.length);
  if (calCells === 0) throw new Error('GitHub-style calendar heatmap did not render');
  // Per-day drilldown: clicking a day opens the model breakdown modal.
  await page.locator('.cal-grid .cal-cell[data-cal-day]').last().click();
  await page.waitForSelector('#modal-backdrop.open', { timeout: 10000 });
  const dayModels = await page.$$eval('#modal-backdrop .card .bar', els => els.length);
  if (dayModels === 0) throw new Error('Day drilldown did not render model rows');
  const dayHeading = await page.locator('#modal-backdrop h2').textContent();
  await page.evaluate(() => closeModal());
  console.log(`   stats=${stats.length} calendarCells=${calCells} drilldownModels=${dayModels} (${dayHeading}) url=${page.url()}`);

  console.log('3. Switching profile tabs...');
  for (const tab of ['prompts', 'projects', 'comparisons', 'achievements', 'usage']) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(120);
  }
  console.log('   all tabs rendered');

  console.log('4. Deep link ?user=benebsworth...');
  await page.goto(filePath + '?user=benebsworth');
  await page.waitForSelector('.tabs .tab');
  const heroHandle = await page.locator('.card').first().textContent();
  if (!heroHandle.includes('benebsworth')) throw new Error('Deep link did not open benebsworth');
  console.log('   deep link ok');

  console.log('5. Visiting every view...');
  for (const view of ['dashboard', 'leagues', 'models', 'teams', 'prompts', 'billing', 'settings', 'leaderboard']) {
    await page.evaluate(v => navigate(v), view);
    await page.waitForTimeout(180);
    const h1 = await page.locator('h1').first().textContent();
    if (!h1) throw new Error(`View ${view} rendered no heading`);
    console.log(`   ${view}: ${h1}`);
  }

  console.log('6. Share modal...');
  await page.evaluate(() => openShareModal('benebsworth'));
  await page.waitForSelector('#share-modal');
  const scopeCards = await page.$$('[data-scope]');
  if (scopeCards.length !== 5) throw new Error(`Expected 5 scope cards, found ${scopeCards.length}`);
  const optRows = await page.$$('[data-opt]');
  if (optRows.length !== 6) throw new Error(`Expected 6 share options, found ${optRows.length}`);
  await page.click('[data-scope="public"]');
  await page.waitForSelector('#share-modal');
  console.log(`   scopes=${scopeCards.length} options=${optRows.length}`);
  await page.evaluate(() => closeModal());

  console.log('7. Shared report link renders a report view...');
  await page.route('https://token-horizon.dev/api/shared/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      share: { id: 'abc', handle: 'benebsworth', scope: 'public', options: {}, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      report: { handle: 'benebsworth', team: 'Castlemilk', tokensAll: 23844909130, tokensAllFormatted: '23.84B', costAll: 381.5, costAllFormatted: '$382', rank: 1, percentile: 100, league: 'grandmaster', leagueTitle: 'Grandmaster', division: 1, mmr: 2860, streakDays: 9, history: ben.breakdown.history, models: ben.breakdown.models }
    })
  }));
  await page.goto(filePath + '?share=abc');
  await page.waitForSelector('.kpi-value');
  console.log('   shared report rendered');

  console.log('8. Sign-in modal, animated ASCII art, and gated actions...');
  await page.waitForSelector('#signin-btn');
  await page.click('#signin-btn');
  await page.waitForSelector('.signin-modal');
  await page.waitForFunction(() => {
    const el = document.querySelector('.bh-art');
    return el && el.textContent.replace(/\s/g, '').length > 200;
  }, null, { timeout: 8000 });
  const artInfo = await page.evaluate(() => ({
    buildMs: window.__bhBuildMs,
    cols: document.querySelector('.bh-art').textContent.split('\n')[0].length
  }));
  const artAnimated = await page.evaluate(async () => {
    const pre = document.querySelector('.bh-art');
    const a = pre.textContent;
    await new Promise(r => setTimeout(r, 500));
    return pre.textContent !== a;
  });
  if (!artAnimated) throw new Error('ASCII black hole is not animating');
  const benefits = await page.$$eval('.signin-benefit', els => els.length);
  if (benefits < 4) throw new Error(`Expected 4 sign-in benefits, found ${benefits}`);
  if (!(await page.$('#signin-dev'))) throw new Error('Dev sign-in fallback missing');
  await page.click('.signin-modal [data-close]');
  await page.waitForFunction(() => !document.querySelector('.bh-art'));
  // Gated action: New Group while signed out must route into the sign-in modal.
  await page.evaluate(() => navigate('settings'));
  await page.waitForSelector('#new-group-btn');
  await page.click('#new-group-btn');
  await page.waitForSelector('.signin-modal');
  const signInCopy = await page.locator('.signin-modal .modal-head p').textContent();
  if (!signInCopy.includes('Creating groups & teams')) throw new Error(`Sign-in modal missing action context: ${signInCopy}`);
  await page.evaluate(() => closeModal());
  console.log(`   art ${artInfo.cols} cols (built ${artInfo.buildMs}ms), animated=${artAnimated}, benefits=${benefits}, gated copy ok`);

  console.log('9. Google sign-in wiring + resume pending action (stubbed GSI)...');
  let groupBody = null, groupToken = null;
  const gsiPage = await context.newPage();
  await gsiPage.route('https://accounts.google.com/**', route => route.abort());
  await gsiPage.addInitScript(() => {
    window.google = {
      accounts: {
        id: {
          initialize: (cfg) => { window.__gsiInit = cfg; },
          renderButton: (el) => { el.innerHTML = '<div id="fake-gsi">Sign in with Google</div>'; window.__gsiRendered = true; },
          disableAutoSelect: () => { window.__gsiDisabled = true; }
        }
      }
    };
  });
  await gsiPage.route('https://token-horizon.dev/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/config') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, googleClientId: 'test-client-id.apps.googleusercontent.com', googleAuth: true })
      });
    }
    if (url.pathname === '/api/leaderboard') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES['/api/leaderboard']) });
    }
    if (url.pathname === '/api/share/list') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, shares: [], activity: [], groups: [] }) });
    }
    if (url.pathname === '/api/groups') {
      groupBody = route.request().postDataJSON();
      groupToken = route.request().headers()['x-google-token'] || '';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, group: groupBody.group }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await gsiPage.goto(filePath);
  await gsiPage.waitForSelector('#signin-btn');
  await gsiPage.evaluate(() => navigate('settings'));
  await gsiPage.waitForSelector('#new-group-btn');
  await gsiPage.click('#new-group-btn');
  await gsiPage.waitForSelector('.signin-modal');
  await gsiPage.waitForFunction(() => window.__gsiRendered === true, null, { timeout: 10000 });
  const gsiCfg = await gsiPage.evaluate(() => window.__gsiInit);
  if (!gsiCfg || gsiCfg.client_id !== 'test-client-id.apps.googleusercontent.com') {
    throw new Error('GSI was not initialized with the configured client ID');
  }
  if (!(await gsiPage.$('.signin-modal #signin-gsi-btn #fake-gsi'))) {
    throw new Error('GSI button did not render inside the sign-in modal');
  }
  // Complete auth exactly the way the real GSI callback would, and assert the
  // pending New Group action resumes with the session attached.
  await gsiPage.evaluate(() => {
    const payload = btoa(JSON.stringify({ email: 'dev@example.com', name: 'Dev User', sub: 'u-1', exp: Math.floor(Date.now() / 1000) + 3600 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    handleGoogleCredential({ credential: 'x.' + payload + '.y' });
  });
  await gsiPage.waitForSelector('#group-name', { timeout: 10000 });
  await gsiPage.fill('#group-name', 'Platform Team');
  await gsiPage.fill('#group-member-input', 'samrivera');
  await gsiPage.press('#group-member-input', 'Enter');
  await gsiPage.click('#group-create');
  await gsiPage.waitForFunction(() => !document.querySelector('#group-name'), null, { timeout: 10000 });
  if (!groupBody || groupBody.group.name !== 'Platform Team' || !groupBody.group.members.includes('samrivera')) {
    throw new Error('Group create payload was not published correctly');
  }
  if (!groupToken) throw new Error('Group create was not sent with the Google credential');
  const chip = await gsiPage.locator('.user-chip').textContent();
  if (!chip.includes('Dev User')) throw new Error('Signed-in chip did not appear');
  console.log(`   GSI init + ASCII modal + resumed New Group (${groupBody.group.name}: ${groupBody.group.members.join(', ')})`);
  await gsiPage.close();

  console.log('10. Avatar picker modal...');
  await page.evaluate(() => {
    state.googleSession = { email: 'user@example.com', name: 'Test User', sub: 'u1', picture: '' };
    state.googleClientId = '';
    navigate('players', { handle: 'benebsworth' });
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => openAvatarModal('benebsworth'));
  await page.waitForSelector('#avatar-file', { timeout: 10000 });
  const styleTiles = await page.$$eval('[data-avatar-style]', els => els.length);
  if (styleTiles < 3) throw new Error(`Expected generated avatar styles, found ${styleTiles}`);
  const uploadInput = await page.$('#avatar-file');
  if (!uploadInput) throw new Error('Avatar upload input missing');
  console.log(`   generated styles=${styleTiles}, upload + URL + Google options present`);
  await page.evaluate(() => closeModal());

  console.log('11. Checking console errors...');
  const realErrors = errors.filter(e =>
    !e.includes('favicon.ico') &&
    !e.includes('accounts.google.com') &&
    !e.includes('net::ERR_FAILED') &&
    !e.includes('Failed to load resource')
  );
  if (realErrors.length > 0) {
    console.error(realErrors);
    throw new Error('Console errors encountered');
  }
  console.log('   zero console errors');

  await browser.close();
  console.log('\n✅ ALL LEADERBOARD UI TESTS PASSED');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
