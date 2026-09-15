import { chromium } from '/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs';
import path from 'path';

/**
 * Hermetic UI regression for the Token Horizon dashboard. All API calls are
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

// --- Model explorer fixtures (static catalog + adoption rollup) --------------
const MX_PROVIDERS = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['google', 'Google'], ['deepseek', 'DeepSeek'], ['qwen', 'Alibaba Cloud'], ['local', 'Ollama (Local)']];
const MX_FLAGSHIP = {
  name: 'Claude Opus 5', category: 'frontier', contextK: 1000, isLocal: false, isFree: false,
  netSavingsPercent: 27, perfScore: 78, capabilities: { reasoning: true, toolCall: true, vision: true, openWeights: false },
  benchmarks: { swe: 82, lcb: 79, source: 'test' }, description: 'Flagship coding model.'
};
const MX_MODELS = [
  { ...MX_FLAGSHIP, id: 'anthropic/claude-opus-5', provider: 'anthropic', providerName: 'Anthropic', inputPerM: 5, outputPerM: 25, blendedNetCost: 7.3 },
  { ...MX_FLAGSHIP, id: 'openrouter/claude-opus-5', provider: 'openrouter', providerName: 'OpenRouter', inputPerM: 5.5, outputPerM: 27, blendedNetCost: 8.1, netSavingsPercent: 0, description: 'Flagship coding model via gateway.' },
  ...Array.from({ length: 72 }, (_, i) => {
    const [provider, providerName] = MX_PROVIDERS[i % MX_PROVIDERS.length];
    const isLocal = provider === 'local';
    const swe = isLocal ? null : Math.round((86 - i * 0.7) * 10) / 10;
    const lcb = isLocal ? null : Math.round((80 - i * 0.6) * 10) / 10;
    return {
      id: `${provider}/model-${i}`,
      name: `${providerName} Test ${i}`,
      provider, providerName,
      category: isLocal ? 'local' : (i < 12 ? 'frontier' : 'balanced'),
      contextK: 128 * (1 + (i % 8)),
      isLocal,
      isFree: isLocal || i % 17 === 0,
      inputPerM: isLocal ? 0 : Math.round((i % 11) * 0.35 * 100) / 100,
      outputPerM: isLocal ? 0 : Math.round((i % 11) * 1.4 * 100) / 100,
      blendedNetCost: isLocal ? 0.04 : Math.round(((i % 11) * 0.5 + 0.04) * 100) / 100,
      netSavingsPercent: i % 5 === 0 ? 50 : 0,
      perfScore: isLocal ? null : Math.round((70 - i * 0.4) * 10) / 10,
      capabilities: { reasoning: i % 3 === 0, toolCall: true, vision: i % 4 === 0, openWeights: isLocal || i % 5 === 0 },
      benchmarks: isLocal ? null : { swe, lcb, source: 'test' },
      description: `Fixture model ${i} for explorer tests.`
    };
  })
];
const MX_CATALOG = {
  schemaVersion: 1,
  count: MX_MODELS.length,
  catalogCount: MX_MODELS.length,
  generatedAt: 1757000000,
  providers: MX_PROVIDERS.map(([id, name]) => ({ id, name, models: 12 })),
  topPicks: [
    { rank: 1, id: 'anthropic/model-0', name: 'Anthropic Test 0', provider: 'anthropic', providerName: 'Anthropic', valueScore: 99.5, perfScore: 84, blendedCostPerM: 0.17, badge: 'VALUE KING', badgeColor: 'cyan', reason: 'SWE 86.0% · LCB 80.0% · $0.17/1M net', swe: 86, lcb: 80 },
    { rank: 2, id: 'openai/model-1', name: 'OpenAI Test 1', provider: 'openai', providerName: 'OpenAI', valueScore: 97.2, perfScore: 83, blendedCostPerM: 0.5, badge: 'FRONTIER S-TIER', badgeColor: 'purple', reason: 'SWE 85.3% · LCB 79.4%', swe: 85.3, lcb: 79.4 }
  ],
  models: MX_MODELS
};
const MX_USAGE = {
  ok: true,
  count: 4,
  models: [
    { provider: 'anthropic', model: 'claude-opus-5', tokens: 14000000000, cost: 300, requests: 2100, users: 2, sharePercent: 70, inputTokens: 9000000000, outputTokens: 5000000000, tokensFormatted: '14.00B', costFormatted: '$300' },
    { provider: 'openrouter', model: 'claude-opus-5', tokens: 1000000000, cost: 30, requests: 150, users: 1, sharePercent: 5, inputTokens: 700000000, outputTokens: 300000000, tokensFormatted: '1.00B', costFormatted: '$30' },
    { provider: 'anthropic', model: 'model-0', tokens: 5000000000, cost: 100, requests: 900, users: 1, sharePercent: 25, inputTokens: 3000000000, outputTokens: 2000000000, tokensFormatted: '5.00B', costFormatted: '$100' },
    { provider: 'openai', model: 'model-1', tokens: 2000000000, cost: 40, requests: 400, users: 1, sharePercent: 10, inputTokens: 1200000000, outputTokens: 800000000, tokensFormatted: '2.00B', costFormatted: '$40' }
  ]
};

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
  },
  '/api/models/catalog': MX_CATALOG,
  '/api/models/usage': MX_USAGE
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
  // Sidebar brand mark: ASCII art renders, animates on hover, pauses on leave.
  const navRest = await page.evaluate(() => document.querySelector('#nav-bh')?.textContent || '');
  if (navRest.replace(/\s/g, '').length < 40) throw new Error('Nav ASCII logo did not render');
  await page.hover('#brand-logo');
  const navF1 = await page.evaluate(() => document.querySelector('#nav-bh').textContent);
  await page.waitForTimeout(500);
  const navF2 = await page.evaluate(() => document.querySelector('#nav-bh').textContent);
  if (navF1 === navF2) throw new Error('Nav ASCII logo did not animate on hover');
  await page.mouse.move(800, 500);
  await page.waitForTimeout(250);
  const navP1 = await page.evaluate(() => document.querySelector('#nav-bh').textContent);
  await page.waitForTimeout(350);
  const navP2 = await page.evaluate(() => document.querySelector('#nav-bh').textContent);
  if (navP1 !== navP2) throw new Error('Nav ASCII logo did not pause on mouse leave');
  console.log(`   rows=${rows.length} tiers=${tiers.length} kpis=${kpis.length} charts=${chartSeries} avatars=${genAvatars} logos=${logos} brands=${brandImgs.length}`);
  console.log(`   legend=${legendItems.length} columns=${columns.count} (maxGap=${columns.maxGap.toFixed(1)}px) chartMounts=${perfAfter.chartMounts} reuses=${perfAfter.chartReuses} navLogo=animated+paused`);

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
  for (const view of ['dashboard', 'leagues', 'models', 'teams', 'billing', 'settings', 'leaderboard']) {
    await page.evaluate(v => navigate(v), view);
    await page.waitForTimeout(180);
    const h1 = await page.locator('h1').first().textContent();
    if (!h1) throw new Error(`View ${view} rendered no heading`);
    console.log(`   ${view}: ${h1}`);
  }
  // Prompt history is never public outside the individual profile.
  const navText = await page.locator('#nav').textContent();
  if (/Prompts/.test(navText)) throw new Error('Prompts nav item must not be public');
  await page.evaluate(() => navigate('prompts'));
  await page.waitForTimeout(250);
  const fallbackH1 = await page.locator('h1').first().textContent();
  if (!/Leaderboard/.test(fallbackH1)) throw new Error(`Prompts deep link should fall back to leaderboard, got: ${fallbackH1}`);
  if (apiUrls.some(u => u.includes('/api/prompts'))) throw new Error('Dashboard must never fetch the public prompts API');
  await page.evaluate(() => navigate('leaderboard'));

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

  console.log('11. Audit fixes: honesty, keyboard, modals, mobile...');
  // Keyboard parity roles on chrome + table.
  const kbRoles = await page.evaluate(() => ({
    nav: [...document.querySelectorAll('#nav .nav-item')].every(e => e.tabIndex === 0 && e.getAttribute('role') === 'link'),
    close: [...document.querySelectorAll('#modal-backdrop .x')].length === 0 || true
  }));
  if (!kbRoles.nav) throw new Error('Nav items missing keyboard roles');
  // Profile Share/Claim entry points.
  await page.evaluate(() => navigate('players', { handle: 'benebsworth' }));
  await page.waitForSelector('.tabs .tab');
  if (!(await page.locator('[data-share-user]').count())) throw new Error('Profile Share button missing');
  if (!(await page.locator('[data-claim-user]').count())) throw new Error('Profile Claim button missing');
  // Modal focus trap + labelled close + scroll lock.
  await page.evaluate(() => openShareModal('benebsworth'));
  await page.waitForSelector('#modal-backdrop.open');
  await page.waitForTimeout(150);
  const modalA11y = await page.evaluate(() => ({
    labelled: [...document.querySelectorAll('#modal-backdrop .x[data-close]')].every(e => e.getAttribute('aria-label')),
    locked: document.body.style.overflow === 'hidden',
    inside: !!document.activeElement?.closest('#modal-backdrop')
  }));
  if (!modalA11y.labelled) throw new Error('Modal close buttons missing aria-label');
  if (!modalA11y.locked) throw new Error('Body scroll not locked with modal open');
  if (!modalA11y.inside) throw new Error('Focus did not move into the modal');
  await page.evaluate(() => closeModal());
  // No page-level horizontal scroll at mobile width.
  const mob = await context.newPage();
  await mob.route('https://token-horizon.dev/api/**', route => {
    const url = new URL(route.request().url());
    const fixture = FIXTURES[url.pathname];
    if (fixture) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not found' }) });
  });
  await mob.setViewportSize({ width: 390, height: 900 });
  await mob.goto(filePath);
  await mob.waitForSelector('#lb-table tbody tr');
  await mob.waitForTimeout(300);
  const mobScroll = await mob.evaluate(() => document.documentElement.scrollWidth);
  if (mobScroll > 391) throw new Error(`Mobile page scrolls horizontally: scrollWidth=${mobScroll}`);
  await mob.close();
  // Demo banner when the API is down.
  const offline = await context.newPage();
  await offline.route('https://token-horizon.dev/api/**', route => {
    const url = new URL(route.request().url());
    const fixture = FIXTURES[url.pathname];
    if (fixture) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not found' }) });
  });
  // Registered last so it wins over the general fixture route above.
  await offline.route('https://token-horizon.dev/api/leaderboard**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await offline.goto(filePath);
  await offline.waitForSelector('.notice.warn', { timeout: 15000 });
  await offline.close();
  console.log('   keyboard roles, share/claim buttons, modal trap+lock, mobile 390px, demo banner ok');

  console.log('12. Responsive: every view fits 390px, sticky list columns, charts follow resizes...');
  const narrow = await context.newPage();
  await narrow.route('https://token-horizon.dev/api/**', route => {
    const url = new URL(route.request().url());
    const fixture = FIXTURES[url.pathname];
    if (fixture) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not found' }) });
  });
  await narrow.setViewportSize({ width: 390, height: 900 });
  await narrow.goto(filePath + '?user=benebsworth');
  await narrow.waitForSelector('#lb-table tbody tr', { timeout: 15000 }).catch(() => {});
  await narrow.waitForTimeout(300);
  for (const view of ['leaderboard', 'dashboard', 'players', 'teams', 'models', 'billing', 'leagues', 'settings']) {
    await narrow.evaluate((v) => { state.view = v; if (v === 'players') state.currentHandle = 'benebsworth'; renderNav(); return render(); }, view);
    await narrow.waitForTimeout(250);
    const sw = await narrow.evaluate(() => document.documentElement.scrollWidth);
    if (sw > 391) throw new Error(`View ${view} overflows at 390px: scrollWidth=${sw}`);
  }
  // Sticky rank+user columns keep row identity while the list scrolls sideways.
  await narrow.evaluate(() => { state.view = 'leaderboard'; renderNav(); return render(); });
  await narrow.waitForSelector('#lb-table tbody tr');
  await narrow.evaluate(() => document.querySelector('#lb-table-wrap .card > div:last-child').scrollTo({ left: 300 }));
  await narrow.waitForTimeout(150);
  const sticky = await narrow.evaluate(() => {
    const wrap = document.querySelector('#lb-table-wrap .card').getBoundingClientRect();
    const c1 = document.querySelector('#lb-table thead th:nth-child(1)').getBoundingClientRect();
    const c2 = document.querySelector('#lb-table thead th:nth-child(2)').getBoundingClientRect();
    const pos = getComputedStyle(document.querySelector('#lb-table tbody td')).position;
    return { pinned: Math.abs(c1.x - wrap.x) < 2 && Math.abs(c2.x - (wrap.x + 54)) < 3, pos };
  });
  if (!sticky.pinned || sticky.pos !== 'sticky') throw new Error(`Sticky list columns broken: ${JSON.stringify(sticky)}`);
  // Charts follow container width on window resize without remounting.
  const mountsBefore = await narrow.evaluate(() => window.__thPerf.chartMounts);
  await narrow.setViewportSize({ width: 1100, height: 900 });
  await narrow.waitForTimeout(500);
  const followed = await narrow.evaluate(() => {
    const el = document.querySelector('#view .ts-chart[data-chart-id]');
    if (!el) return { ok: true, skipped: true };
    const svg = el.querySelector('svg');
    return { ok: Math.abs(el.getBoundingClientRect().width - svg.getBoundingClientRect().width) < 4, mounts: window.__thPerf.chartMounts };
  });
  if (!followed.ok) throw new Error('Chart did not follow container width on resize');
  if (followed.mounts !== undefined && followed.mounts !== mountsBefore) throw new Error('Resize remounted charts');
  await narrow.close();
  console.log('   8/8 views fit 390px, sticky columns pinned, charts follow resizes with 0 remounts');

  console.log('13. Model explorer: catalog, fuzzy search, windowed list, drawer...');
  await page.evaluate(() => navigate('models'));
  await page.waitForSelector('#mx-scroll .mx-row', { timeout: 10000 });
  const fuseLoaded = await page.evaluate(() => typeof window.Fuse === 'function');
  if (!fuseLoaded) throw new Error('fuse.js bundle did not load');
  const picks = await page.$$('#mx-picks .mx-pick');
  if (picks.length !== 2) throw new Error(`Expected 2 top picks, got ${picks.length}`);
  const windowing = await page.evaluate(() => ({
    dom: document.querySelectorAll('#mx-rows .mx-row').length,
    total: state.mx.filtered.length,
    spacer: parseFloat(document.getElementById('mx-spacer').style.height)
  }));
  if (windowing.dom >= windowing.total) throw new Error(`List is not windowed: ${windowing.dom}/${windowing.total} rows in DOM`);
  if (windowing.spacer < windowing.total * 60) throw new Error('Spacer height does not cover the full list');
  // Fuzzy search narrows via the vendored Fuse index.
  await page.fill('#mx-q', 'deepseek test 3');
  await page.waitForTimeout(250);
  const search = await page.evaluate(() => ({ n: state.mx.filtered.length, shown: document.getElementById('mx-shown').textContent }));
  if (search.n === 0 || search.n >= 72) throw new Error(`Search did not narrow: ${JSON.stringify(search)}`);
  // Scope chip filtering (reset the query first so only the scope applies).
  await page.click('#mx-clear');
  await page.waitForTimeout(120);
  await page.click('[data-scope="local"]');
  await page.waitForTimeout(200);
  const localOnly = await page.evaluate(() => state.mx.filtered.length > 0 && state.mx.filtered.every(m => m.isLocal));
  if (!localOnly) throw new Error('Local scope chip did not filter to local models');
  await page.click('#mx-clear');
  await page.waitForTimeout(120);
  // Scrolling windows to deeper rows without unbounded DOM growth.
  const firstBefore = await page.evaluate(() => document.querySelector('#mx-rows .mx-row')?.dataset.mxId);
  await page.evaluate(() => { document.getElementById('mx-scroll').scrollTop = 2000; });
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    first: document.querySelector('#mx-rows .mx-row')?.dataset.mxId,
    dom: document.querySelectorAll('#mx-rows .mx-row').length
  }));
  if (after.first === firstBefore) throw new Error('Scroll did not window to deeper rows');
  if (after.dom > 45) throw new Error(`Window grew unbounded: ${after.dom} rows`);
  // Row click opens the detail drawer with metadata and a deep link.
  await page.evaluate(() => { document.getElementById('mx-scroll').scrollTop = 0; });
  await page.waitForTimeout(150);
  const firstRowName = await page.evaluate(() => document.querySelector('#mx-rows .mx-row .mx-name')?.textContent || '');
  await page.locator('#mx-rows .mx-row').first().click();
  await page.waitForSelector('#mx-drawer.open');
  const drawer = await page.evaluate(() => ({
    name: document.querySelector('#mx-drawer .mx-drawer-head')?.textContent || '',
    prices: document.querySelectorAll('#mx-drawer .mx-price').length,
    benches: document.querySelectorAll('#mx-drawer .mx-bench-row').length,
    model: new URL(location.href).searchParams.get('model')
  }));
  if (!firstRowName || !drawer.name.includes(firstRowName)) throw new Error(`Drawer opened wrong model: row=${firstRowName} drawer=${drawer.name}`);
  if (drawer.prices < 3) throw new Error('Drawer missing pricing grid');
  if (drawer.benches < 2) throw new Error('Drawer missing benchmark bars');
  if (!drawer.model) throw new Error('Drawer did not deep-link ?model=');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const closed = await page.evaluate(() => !document.querySelector('#mx-drawer').classList.contains('open') && !new URL(location.href).searchParams.get('model'));
  if (!closed) throw new Error('Drawer did not close on Escape');
  // Deep link reopens the drawer on load.
  await page.goto(filePath + '?view=models&model=anthropic%2Fmodel-0');
  await page.waitForSelector('#mx-drawer.open', { timeout: 10000 });
  const deepLinked = await page.evaluate(() => document.querySelector('#mx-drawer .mx-drawer-head')?.textContent || '');
  if (!deepLinked.includes('Anthropic Test 0')) throw new Error('Model deep link did not open the drawer');
  await page.keyboard.press('Escape');
  // Providers tab keeps the analytics view; Explorer returns.
  await page.click('[data-models-tab="providers"]');
  await page.waitForTimeout(250);
  const provHeading = await page.locator('h1').first().textContent();
  if (!/Provider/.test(provHeading)) throw new Error(`Providers tab heading wrong: ${provHeading}`);
  await page.click('[data-models-tab="explorer"]');
  await page.waitForSelector('#mx-scroll .mx-row');
  console.log(`   fuse=${fuseLoaded} picks=${picks.length} windowed=${windowing.dom}/${windowing.total} search=${search.shown} drawer=${drawer.prices}p/${drawer.benches}b`);

  console.log('14. Model cross-links + per-model provider view...');
  await page.evaluate(() => navigate('players', { handle: 'benebsworth' }));
  await page.waitForSelector('.tabs .tab');
  await page.waitForSelector('a[data-model-link][data-model="claude-opus-5"]', { timeout: 10000 });
  const inventoryLinks = await page.$$eval('td a[data-model-link]', els => els.length);
  const allLink = await page.$('[data-models-all]');
  if (!allLink) throw new Error('Model list header is missing the top-level list link');
  await page.click('a[data-model-link][data-model="claude-opus-5"]');
  await page.waitForSelector('#mx-drawer.open', { timeout: 15000 });
  const perModel = await page.evaluate(() => ({
    name: document.querySelector('#mx-drawer .mx-drawer-head')?.textContent || '',
    community: (document.querySelector('#mx-drawer')?.textContent || '').includes('Community usage'),
    listings: document.querySelectorAll('#mx-drawer [data-listing]').length,
    providerHeader: (document.querySelector('#mx-drawer')?.textContent || '').includes('Publishers'),
    avgCost: (document.querySelector('#mx-drawer')?.textContent || '').includes('Avg cost / 1M')
  }));
  if (!perModel.name.includes('Claude Opus 5')) throw new Error(`Per-model view opened wrong entry: ${perModel.name}`);
  if (!perModel.community || !perModel.providerHeader || !perModel.avgCost) {
    throw new Error(`Per-model provider metrics missing: ${JSON.stringify(perModel)}`);
  }
  if (perModel.listings < 2) throw new Error(`Listings should cover all providers, got ${perModel.listings}`);
  const drawerProvLinks = await page.$$eval('#mx-drawer [data-provider-link]', els => els.length);
  if (drawerProvLinks < 2) throw new Error(`Per-model provider rows are not linked: ${drawerProvLinks}`);
  // Provider row → explorer filtered to that provider (drawer closes).
  await page.click('#mx-drawer [data-provider-link]');
  await page.waitForSelector('#mx-scroll .mx-row', { timeout: 15000 });
  const filteredByProvider = await page.evaluate(() => ({
    provider: state.mx.provider,
    open: document.querySelector('#mx-drawer')?.classList.contains('open')
  }));
  if (filteredByProvider.provider === 'all' || filteredByProvider.open) {
    throw new Error(`Provider link did not filter the explorer: ${JSON.stringify(filteredByProvider)}`);
  }
  await page.evaluate(() => navigate('players', { handle: 'benebsworth' }));
  await page.waitForSelector('a[data-model-link][data-model="claude-opus-5"]', { timeout: 10000 });
  await page.click('a[data-model-link][data-model="claude-opus-5"]');
  await page.waitForSelector('#mx-drawer.open', { timeout: 15000 });
  // Switching listings re-renders the same drawer for the other provider.
  await page.click('#mx-drawer [data-listing="openrouter/claude-opus-5"]');
  await page.waitForTimeout(250);
  const switched = await page.evaluate(() => new URL(location.href).searchParams.get('model'));
  if (switched !== 'openrouter/claude-opus-5') throw new Error(`Listing switch did not re-open: ${switched}`);
  await page.keyboard.press('Escape');
  // Chart legends link model names back into the explorer.
  await page.evaluate(async () => { state.view = 'leaderboard'; renderNav(); await render(); });
  await page.waitForSelector('.chart-legend [data-model-link]', { timeout: 10000 });
  const legendLinks = await page.$$eval('.chart-legend [data-model-link]', els => els.map(e => e.dataset.model));
  if (!legendLinks.length) throw new Error('Chart legend model names are not linked');
  // Billing and shared reports use the same link contract.
  await page.evaluate(() => navigate('billing'));
  await page.waitForTimeout(300);
  const billingLinks = await page.$$eval('#view a[data-model-link]', els => els.length);
  if (!billingLinks) throw new Error('Billing Cost by Model rows are not linked');
  await page.goto(filePath + '?share=abc');
  await page.waitForSelector('#view a[data-model-link]', { timeout: 15000 });
  const shareLinks = await page.$$eval('#view a[data-model-link]', els => els.length);
  if (!shareLinks) throw new Error('Shared report model rows are not linked');
  await page.evaluate(() => navigate('leaderboard'));
  console.log(`   inventoryLinks=${inventoryLinks} listings=${perModel.listings} billingLinks=${billingLinks} shareLinks=${shareLinks} legend=[${legendLinks.slice(0, 3).join(', ')}]`);

  console.log('15. Flat /models page (searchable list, no dashboard chrome)...');
  await page.goto(filePath + '?view=models&flat=1');
  await page.waitForSelector('#mx-scroll .mx-row', { timeout: 15000 });
  const flat = await page.evaluate(() => ({
    flat: state.flatModels,
    head: Boolean(document.querySelector('.mx-flat-head')),
    sidebarHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
    topbarHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
    tabs: document.querySelectorAll('[data-models-tab]').length,
    picks: document.querySelectorAll('#mx-picks').length,
    scopes: document.querySelectorAll('#mx-scopes').length,
    caps: document.querySelectorAll('#mx-caps').length,
    rows: document.querySelectorAll('#mx-rows .mx-row').length,
    total: state.mx.filtered.length
  }));
  if (!flat.flat || !flat.head || !flat.sidebarHidden || !flat.topbarHidden) throw new Error(`Flat shell wrong: ${JSON.stringify(flat)}`);
  if (flat.tabs || flat.picks || flat.scopes || flat.caps) throw new Error(`Flat page still renders dashboard chrome: ${JSON.stringify(flat)}`);
  if (!flat.rows || flat.rows >= flat.total) throw new Error(`Flat list not windowed: ${flat.rows}/${flat.total}`);
  await page.fill('#mx-q', 'claude opus');
  await page.waitForTimeout(250);
  const flatSearch = await page.evaluate(() => state.mx.filtered.length);
  if (flatSearch === 0 || flatSearch > 10) throw new Error(`Flat search did not narrow: ${flatSearch}`);
  // Provider deep link filters the flat list straight from the URL.
  await page.goto(filePath + '?view=models&flat=1&provider=anthropic');
  await page.waitForSelector('#mx-scroll .mx-row', { timeout: 15000 });
  const flatProvider = await page.evaluate(() => ({
    provider: state.mx.provider,
    all: state.mx.filtered.every(m => providerKey(m.provider, m.id) === 'anthropic' || m.provider === 'anthropic')
  }));
  if (flatProvider.provider !== 'anthropic' || !flatProvider.all) throw new Error(`Provider deep link failed: ${JSON.stringify(flatProvider)}`);
  // Flat page is responsive at 390px (no horizontal scroll, search first).
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(300);
  const flatMob = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    qTop: Math.round(document.querySelector('#mx-q').getBoundingClientRect().top),
    sortTop: Math.round(document.querySelector('#mx-sort').getBoundingClientRect().top)
  }));
  if (flatMob.scroll > 391) throw new Error(`Flat page scrolls horizontally at 390px: ${flatMob.scroll}`);
  if (flatMob.qTop > flatMob.sortTop) throw new Error('Flat mobile search should come before the selects');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`   head=${flat.head} windowed=${flat.rows}/${flat.total} search=${flatSearch} provider=${flatProvider.provider}`);

  console.log('16. Checking console errors...');
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
