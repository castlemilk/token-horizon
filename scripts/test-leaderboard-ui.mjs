import { chromium } from '/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs';
import path from 'path';

/**
 * Hermetic UI regression for the TokenArena dashboard. All API calls are
 * intercepted with fixtures, so the test never touches production or the
 * local daemon. Covers every routed view plus the share modal.
 */

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
      { title: 'Code review assistant', provider: 'anthropic', model: 'claude-opus-5', tokens: 1200000, cost: 4.2, requests: 12, at: 1726000000 },
      { title: 'Research summary', provider: 'openai', model: 'gpt-5-codex', tokens: 800000, cost: 2.1, requests: 8, at: 1725990000 }
    ]
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
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));

  await page.route('https://tokens.benebsworth.com/api/**', async route => {
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
  const tiers = await page.$$('.tier');
  if (tiers.length !== 7) throw new Error(`Expected 7 league tiers, found ${tiers.length}`);
  const kpis = await page.$$('.kpi-value');
  if (kpis.length < 4) throw new Error('Missing KPI cards');
  console.log(`   rows=${rows.length} tiers=${tiers.length} kpis=${kpis.length}`);

  console.log('2. Opening player profile from a row...');
  await rows[0].click();
  await page.waitForSelector('.tabs .tab');
  if (!(await page.locator('h1').first().textContent()).includes('Player Profile')) throw new Error('Player profile did not render');
  const stats = await page.$$('.stat');
  if (stats.length < 8) throw new Error(`Expected >=8 stat cards, found ${stats.length}`);
  if (!page.url().includes('user=')) throw new Error('URL missing ?user=');
  console.log(`   stats=${stats.length} url=${page.url()}`);

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
  await page.route('https://tokens.benebsworth.com/api/shared/**', route => route.fulfill({
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

  console.log('8. Checking console errors...');
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
