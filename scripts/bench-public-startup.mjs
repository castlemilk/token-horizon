import { performance } from 'node:perf_hooks';
import { resolveChromium } from './playwright.mjs';

// Read-only, cold-browser smoke benchmark. Measures usable rows, not merely
// HTTP 200 or a loading shell. Run manually against a local preview or release.
const origin = process.argv[2] || 'https://token-horizon.dev';
const runs = Number(process.argv[3] || 3);
if (!/^https?:\/\//.test(origin) || !Number.isInteger(runs) || runs < 1 || runs > 10) {
  throw new Error('Usage: node scripts/bench-public-startup.mjs [origin] [runs:1..10]');
}
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
try {
  for (const [path, selector] of [['/leaderboard', '#lb-table tbody tr'], ['/models', '#mx-rows .mx-row']]) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        const start = performance.now();
        const response = await page.goto(new URL(path, origin).href, { waitUntil: 'commit', timeout: 15000 });
        if (!response.ok()) throw new Error(`${path}: HTTP ${response.status()}`);
        await page.waitForSelector(selector, { timeout: 10000 });
        if (await page.locator('#demo-retry').count()) throw new Error(`${path}: demo data, not live rows`);
        const elapsed = Math.round(performance.now() - start);
        samples.push(elapsed);
        if (errors.length) throw new Error(`${path}: ${errors.join('; ')}`);
        console.log(JSON.stringify({ path, run: i + 1, firstRowsMs: elapsed, rows: await page.locator(selector).count() }));
      } finally { await context.close(); }
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ path, coldBrowserMedianMs: samples[Math.floor(samples.length / 2)], slowestMs: samples.at(-1) }));
  }
} finally { await browser.close(); }
