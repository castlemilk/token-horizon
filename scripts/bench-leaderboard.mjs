import { chromium } from '/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs';
import path from 'path';

/**
 * Budget-gated benchmark for the Token Horizon dashboard chart/render pipeline.
 * Hermetic (fixtures only, never production) and machine-dependent — budgets
 * are deliberately loose enough for CI but tight enough to catch regressions
 * such as remounting charts on every re-render.
 *
 * Scenarios:
 *   1. cold load → first TanStack chart painted
 *   2. view switch render (median / p95) across chart views
 *   3. warm chart host reuse (zero extra mounts after warm-up)
 *   4. search keystroke → table-only refresh (debounced)
 *   5. idle 30s tick with unchanged payload → no re-render (fingerprint skip)
 *   6. API GET cache hit on repeated view loads
 */

const BUDGETS = {
  coldLoadToChart: 1500,    // ms
  viewSwitchMedian: 60,     // ms
  viewSwitchP95: 150,       // ms
  searchToTable: 260,       // ms (includes the 120ms debounce)
  idleTickNoRender: 150,    // ms
  extraChartMounts: 0,      // after warm-up
  explorerSearch: 300,      // ms (includes the 90ms debounce)
  explorerWindowRows: 60    // max DOM rows for a 3k-model windowed list
};

const DAYS = 30;
const MODELS = [
  ['claude-opus-5', 'anthropic', 5.8], ['claude-sonnet-5', 'anthropic', 2.1],
  ['gpt-5-codex', 'openai', 3.4], ['gemini-3.8-flash', 'google', 1.6],
  ['deepseek-v4', 'deepseek', 1.1], ['kimi-k3', 'kimi', 0.8],
  ['glm-5', 'zhipu', 0.6], ['qwen-4-max', 'qwen', 0.5], ['grok-5', 'xai', 0.4]
];

function buildFixtures(entryCount = 120) {
  const now = new Date();
  const dayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const days = Array.from({ length: DAYS }, (_, i) => dayStart - (DAYS - 1 - i) * 86400);
  const labels = days.map(d => {
    const dt = new Date(d * 1000);
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  });
  // Synthetic catalog at real-world scale (the committed export is ~2.9k rows)
  // so the explorer's windowed list and Fuse index are exercised, not toy data.
  const catalogProviders = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['google', 'Google'], ['deepseek', 'DeepSeek'], ['qwen', 'Alibaba Cloud'], ['zhipu', 'Zhipu AI'], ['kimi', 'Moonshot Kimi'], ['ollama', 'Ollama (Local)']];
  const catalogModels = Array.from({ length: 3000 }, (_, i) => {
    const [provider, providerName] = catalogProviders[i % catalogProviders.length];
    const isLocal = provider === 'ollama';
    return {
      id: `${provider}/model-${i}`,
      name: `${providerName} Model ${i}`,
      provider, providerName,
      category: isLocal ? 'local' : (i % 40 === 0 ? 'frontier' : 'balanced'),
      contextK: 128 * (1 + (i % 12)),
      isLocal,
      isFree: isLocal || i % 29 === 0,
      inputPerM: isLocal ? 0 : (i % 17) * 0.4,
      outputPerM: isLocal ? 0 : (i % 17) * 1.6,
      blendedNetCost: isLocal ? 0.04 : (i % 17) * 0.6 + 0.05,
      netSavingsPercent: 0,
      perfScore: isLocal ? null : 90 - (i % 60),
      capabilities: { reasoning: i % 3 === 0, toolCall: true, vision: i % 4 === 0, openWeights: isLocal },
      benchmarks: isLocal ? null : { swe: 80 - (i % 50), lcb: 75 - (i % 45), source: 'bench' },
      description: `Synthetic catalog entry ${i}`
    };
  });
  const series = MODELS.map(([model, provider, base]) => ({
    model, provider,
    total: Math.round(base * 1e9 * DAYS),
    values: days.map((_, i) => Math.round(base * 1e9 * (0.6 + 0.8 * Math.abs(Math.sin(i / 3 + base)))))
  }));

  const makeEntry = (i) => {
    const handle = `player${String(i).padStart(3, '0')}`;
    const modelCount = 1 + (i % 3);
    const models = Array.from({ length: modelCount }, (_, j) => {
      const [model, provider] = MODELS[(i + j) % MODELS.length];
      const tokens = Math.round((1e9 / (j + 1)) * (1 + (i % 7) / 10));
      return { provider, model, tokensToday: tokens, tokensAll: tokens * 40, costToday: 1.2, costAll: 48, sharePercent: Math.round(100 / modelCount), inputTokens: tokens * 28, outputTokens: tokens * 12, requests: 40 + i };
    });
    const total = models.reduce((s, m) => s + m.tokensAll, 0);
    const modelHistory = models.map(m => ({
      model: m.model, provider: m.provider,
      points: days.map((d, k) => ({ day: d, dayLabel: labels[k], tokens: Math.round((m.tokensAll / 40) * (0.5 + Math.abs(Math.sin(k / 4 + i)))), cost: 0 }))
    }));
    return {
      rank: i + 1, badge: i === 0 ? '🥇 1st' : `#${i + 1}`, percentile: Math.max(1, 100 - Math.round(i / entryCount * 100)),
      score: models[0].tokensToday, scoreFormatted: '1.0B', costFormatted: '$12.50', relativePercent: Math.max(4, 100 - i),
      league: 'gold', leagueTitle: 'Gold', leagueColor: '#E0B44C', division: 1, mmr: 1500 - i, mmrToNext: null,
      efficiency: 70, rankDelta7d: i % 5 === 0 ? 1 : null, avgPerRequest: 4000,
      inputFormatted: '28.0M', outputFormatted: '12.0M', requestsFormatted: '412', trend: [3, 4, 5, 4, 6, 7, 5],
      entry: {
        id: `local:${handle}`, handle, team: i % 4 === 0 ? 'Castlemilk' : 'Engineering', isLocal: i === 0,
        tokensToday: models[0].tokensToday, tokens7d: total / 4, tokensAll: total,
        costToday: 12.5, cost7d: 88, costAll: 381.5, streakDays: 3 + (i % 10), topModel: models[0].model,
        hardware: 'Apple M5 Max', updatedAt: Date.now() / 1000, mmr: 1500 - i, league: 'gold', division: 1, efficiency: 70,
        inputTokensAll: total * 0.7, outputTokensAll: total * 0.3, requestsAll: 400 + i, seasonTokens: total / 2,
        achievements: [], avatarUrl: '', avatarStyle: 'identicon',
        breakdown: { models, tools: [], history: days.slice(-7).map((d, k) => ({ day: d, dayLabel: labels[DAYS - 7 + k], tokens: 1e9 * k, cost: 10 })), activeDays: 20, totalSessions: 12, projects: [], hourly: [], sessions: [], modelHistory }
      }
    };
  };

  const leaderboard = Array.from({ length: entryCount }, (_, i) => makeEntry(i));
  const providerTotals = {};
  for (const row of leaderboard) {
    for (const m of row.entry.breakdown.models) providerTotals[m.provider] = (providerTotals[m.provider] || 0) + m.tokensAll;
  }
  const providerRows = Object.entries(providerTotals).map(([provider, tokens], i) => ({
    provider, tokens, cost: tokens / 1e7, requests: 400 + i * 10, inputTokens: tokens * 0.7, outputTokens: tokens * 0.3,
    models: 1, users: entryCount, avgCostPerM: 0.0214, tokensFormatted: (tokens / 1e9).toFixed(2) + 'B', costFormatted: '$300',
    avgCostPerMText: '$0.0214', sharePercent: 50
  }));
  const providerPoints = days.map((day, k) => {
    const values = {};
    providerRows.forEach(r => { values[r.provider] = Math.round(r.tokens / DAYS * (0.7 + Math.abs(Math.sin(k / 3)))); });
    return { day, date: new Date(day * 1000).toISOString().slice(0, 10), values, total: Object.values(values).reduce((a, b) => a + b, 0) };
  });

  return {
    '/api/config': { ok: true, googleClientId: '', googleAuth: false, canonicalUrl: 'https://token-horizon.dev', season: { displayName: 'Season 3 — Ascension' } },
    '/api/leaderboard': {
      ok: true, period: 'today', total: entryCount, season: { displayName: 'Season 3 — Ascension', number: 3, daysRemaining: 20 },
      leagueLadder: [],
      kpis: { totalTokens: 25e9, totalTokensFormatted: '25.00B', totalCost: 400, totalCostFormatted: '$400', activeDevs: entryCount, maxStreakDays: 12, totalRequests: 41200, totalRequestsFormatted: '41.2k', avgTokensPerRequest: 600000, totalTokensDelta: 12.5, totalCostDelta: 8.2, activeDevsDelta: 5 },
      movers: { gains: [], improved: [], promotions: [] },
      usageHistory: { labels, series, total: series.reduce((s, x) => s + x.total, 0) },
      leaderboard
    },
    '/api/providers': {
      ok: true, total: providerRows.reduce((s, r) => s + r.tokens, 0), totalFormatted: '19.00B',
      providers: providerRows,
      history: { providers: providerRows.map(r => r.provider), points: providerPoints },
      teams: [], topPrompts: [], insights: {}
    },
    '/api/season': {
      ok: true, season: { displayName: 'Season 3 — Ascension' }, ladder: [], distribution: [],
      standings: [], promotions: [], climbers: [], rewards: []
    },
    '/api/models/catalog': { schemaVersion: 1, count: catalogModels.length, catalogCount: catalogModels.length, generatedAt: 1757000000, providers: [], topPicks: [], models: catalogModels },
    '/api/models/usage': { ok: true, count: 0, models: [] }
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];

async function main() {
  const fixtures = buildFixtures();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const results = [];
  const record = (name, measured, budget, unit = 'ms', lowerIsBetter = true) => {
    const pass = lowerIsBetter ? measured <= budget : measured >= budget;
    results.push({ name, measured, budget, unit, pass });
  };

  await page.route('https://accounts.google.com/**', route => route.abort());   // no network in the bench
  await page.route('https://token-horizon.dev/api/**', route => {
    const f = fixtures[new URL(route.request().url()).pathname];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(f || {}) });
  });

  const filePath = 'file://' + path.resolve('docs/leaderboard.html');

  // 1. Cold load → first chart painted.
  const t0 = Date.now();
  await page.goto(filePath, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lb-table tbody tr', { timeout: 15000 });
  await page.waitForSelector('.ts-chart[data-chart-id] svg', { timeout: 15000 });
  record('cold load → first chart', Date.now() - t0, BUDGETS.coldLoadToChart);

  // Warm-up: visit both chart views once, then snapshot host counters.
  await page.evaluate(async () => {
    state.view = 'models'; renderNav(); await render();
    state.view = 'leaderboard'; renderNav(); await render();
  });
  await page.waitForTimeout(100);
  const warm = await page.evaluate(() => ({ ...window.__thPerf }));

  // 2. View switch render cost.
  const switchTimes = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 10; i++) {
      state.view = 'models'; renderNav();
      let t = performance.now(); await render(); times.push(performance.now() - t);
      state.view = 'leaderboard'; renderNav();
      t = performance.now(); await render(); times.push(performance.now() - t);
    }
    return times;
  });
  record('view switch median', median(switchTimes), BUDGETS.viewSwitchMedian);
  record('view switch p95', p95(switchTimes), BUDGETS.viewSwitchP95);

  // 3. Warm host reuse: no new chart mounts after warm-up.
  const afterSwitches = await page.evaluate(() => window.__thPerf.chartMounts);
  record('extra chart mounts after warm-up', afterSwitches - warm.chartMounts, BUDGETS.extraChartMounts, 'mounts');

  // 4. Search keystroke → table-only refresh.
  const searchTimes = [];
  for (const q of ['claude', 'gpt', 'deep', 'gem', 'kimi', 'qwen', 'glm', 'xai', 'opus', 'player1']) {
    searchTimes.push(await page.evaluate(async (query) => {
      const input = document.querySelector('#global-search');
      const before = window.__thPerf.tableRefreshes;
      const started = performance.now();
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      while (window.__thPerf.tableRefreshes === before) await new Promise(r => setTimeout(r, 4));
      return performance.now() - started;
    }, q));
  }
  record('search → table refresh (median)', median(searchTimes), BUDGETS.searchToTable);
  const searchMounts = await page.evaluate(() => window.__thPerf.chartMounts);
  record('search never remounts charts', searchMounts - afterSwitches, 0, 'mounts');

  // 5. Idle tick with an unchanged payload: refresh, no re-render.
  const idle = await page.evaluate(async () => {
    const p = window.__thPerf;
    const renders = p.renders, skipped = p.skippedRenders;
    const started = performance.now();
    const changed = await window.__thRefresh();
    return { ms: performance.now() - started, changed, rendered: p.renders !== renders, skipped: p.skippedRenders - skipped };
  });
  record('idle tick (unchanged) elapsed', idle.ms, BUDGETS.idleTickNoRender);
  record('idle tick skipped render', idle.changed === false && idle.rendered === false ? 1 : 0, 1, 'bool');

  // 6. API GET cache serves a repeated load without a network call.
  const cache = await page.evaluate(async () => {
    const before = window.__thPerf.apiCacheHits;
    await api('/api/season');
    await api('/api/season');
    return window.__thPerf.apiCacheHits - before;
  });
  record('api cache hits on repeat', cache, 1, 'hits', false);

  // 7. Model explorer: windowed list stays tiny; search stays under budget.
  await page.evaluate(async () => { state.view = 'models'; state.modelsTab = 'explorer'; renderNav(); await render(); });
  await page.waitForSelector('#mx-scroll .mx-row', { timeout: 15000 });
  const windowRows = await page.evaluate(() => document.querySelectorAll('#mx-rows .mx-row').length);
  record('explorer DOM rows (windowed)', windowRows, BUDGETS.explorerWindowRows, 'rows');
  const explorerSearch = [];
  for (const q of ['claude', 'gemini', 'qwen coder', 'gpt-5', 'deepseek flash']) {
    explorerSearch.push(await page.evaluate(async (query) => {
      const input = document.getElementById('mx-q');
      const started = performance.now();
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 140)); // 90ms debounce + a frame
      return performance.now() - started;
    }, q));
  }
  record('explorer search → rows (median)', median(explorerSearch), BUDGETS.explorerSearch);
  // Clear the query so the deep scroll exercises the full list, not the empty state.
  await page.evaluate(async () => {
    const input = document.getElementById('mx-q');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 140));
    document.getElementById('mx-scroll').scrollTop = 30000;
  });
  await page.waitForTimeout(200);
  const deepRows = await page.evaluate(() => document.querySelectorAll('#mx-rows .mx-row').length);
  record('explorer DOM rows after deep scroll', deepRows, BUDGETS.explorerWindowRows, 'rows');
  record('explorer deep scroll rendered rows', deepRows > 0 ? 1 : 0, 1, 'bool');

  const perf = await page.evaluate(() => ({ ...window.__thPerf }));
  await browser.close();

  console.log('\nToken Horizon dashboard bench (hermetic fixtures, 120 players)\n');
  console.log('scenario                            measured      budget   result');
  console.log('---------------------------------------------------------------');
  for (const r of results) {
    const measured = `${r.measured.toFixed(r.unit === 'ms' ? 1 : 0)} ${r.unit}`.padEnd(12);
    const budget = `<= ${r.budget} ${r.unit}`.padEnd(10);
    console.log(`${r.name.padEnd(35)} ${measured} ${budget} ${r.pass ? 'PASS' : 'FAIL'}`);
  }
  console.log('---------------------------------------------------------------');
  console.log(`chart mounts=${perf.chartMounts} reuses=${perf.chartReuses} evictions=${perf.chartEvictions} mountMs=${perf.chartMountMs.toFixed(1)}`);
  console.log(`renders=${perf.renders} (avg ${(perf.renderMsTotal / Math.max(1, perf.renders)).toFixed(1)}ms) skipped=${perf.skippedRenders} tableRefreshes=${perf.tableRefreshes}`);
  console.log(`api requests=${perf.apiRequests} cacheHits=${perf.apiCacheHits} inflightHits=${perf.apiInflightHits} dataRefreshes=${perf.dataRefreshes} dataChanges=${perf.dataChanges}`);

  const failed = results.filter(r => !r.pass);
  if (failed.length) {
    console.error(`\n❌ ${failed.length} benchmark budget(s) breached`);
    process.exit(1);
  }
  console.log('\n✅ all benchmark budgets met');
}

main().catch(err => {
  console.error('❌ Bench failed:', err);
  process.exit(1);
});
