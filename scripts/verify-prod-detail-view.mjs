import { chromium } from '/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs';

async function verifyProdView() {
  console.log("=== Testing Production Leaderboard UI (token-horizon.dev) ===\n");

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[BROWSER ERROR]:`, msg.text());
  });

  const url = "https://token-horizon.dev/leaderboard";
  console.log(`1. Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle' });

  // Wait for rows
  await page.waitForSelector('.leaderboard-table tbody tr');
  const rows = await page.$$('.leaderboard-table tbody tr');
  console.log(`   Found ${rows.length} participant row(s) on live leaderboard.`);
  if (rows.length !== 1) {
    throw new Error(`Expected exactly 1 real user on leaderboard, found ${rows.length}`);
  }

  const handleText = await page.$eval('.leaderboard-table tbody tr .handle-text', el => el.textContent.trim());
  const rankText = await page.$eval('.leaderboard-table tbody tr .rank-pill', el => el.textContent.trim());
  const volumeText = await page.$eval('.leaderboard-table tbody tr .volume-text', el => el.textContent.trim());
  const isVerified = await page.$eval('.leaderboard-table tbody tr .verified-badge', el => Boolean(el)).catch(() => false);

  console.log(`   Leaderboard Row 1: ${rankText} | ${handleText} | ${volumeText} | Verified: ${isVerified}`);
  if (handleText !== '@benebsworth') throw new Error(`Unexpected handle: ${handleText}`);

  // Click row to open modal
  console.log("\n2. Clicking row to open Detailed Participant Modal...");
  await rows[0].click();
  await page.waitForSelector('#user-detail-modal.active');

  // Verify Header
  const modalHandle = await page.$eval('#detail-handle', el => el.textContent.trim());
  const modalTeam = await page.$eval('#detail-team', el => el.textContent.trim());
  const modalHw = await page.$eval('#detail-hardware', el => el.textContent.trim());
  const modalStreak = await page.$eval('#detail-streak', el => el.textContent.trim());
  const modalVerified = await page.$eval('#detail-claim-badge .verified-badge', el => el.textContent.trim()).catch(() => "none");

  console.log(`   Modal Header:`);
  console.log(`   - Handle: ${modalHandle}`);
  console.log(`   - Team: ${modalTeam}`);
  console.log(`   - Hardware: ${modalHw}`);
  console.log(`   - Streak: ${modalStreak}`);
  console.log(`   - Verification: ${modalVerified}`);

  // Verify KPIs
  const kpiToday = await page.$eval('#detail-kpi-today', el => el.textContent.trim());
  const kpi7d = await page.$eval('#detail-kpi-7d', el => el.textContent.trim());
  const kpiAll = await page.$eval('#detail-kpi-all', el => el.textContent.trim());
  const kpiModel = await page.$eval('#detail-kpi-model', el => el.textContent.trim());

  console.log(`\n3. KPI Summary Boxes:`);
  console.log(`   - TODAY: ${kpiToday}`);
  console.log(`   - 7 DAYS: ${kpi7d}`);
  console.log(`   - ALL-TIME: ${kpiAll}`);
  console.log(`   - TOP MODEL: ${kpiModel}`);

  // Verify 7-Day Activity Histogram
  const barCount = await page.$$eval('#detail-chart-container .hist-bar-col', els => els.length);
  console.log(`\n4. Activity Histogram:`);
  console.log(`   - Rendered Bars: ${barCount}`);
  if (barCount !== 7) throw new Error(`Expected 7 histogram bars, found ${barCount}`);

  // Verify Model Allocation Inventory
  const modelRowCount = await page.$$eval('#detail-models-tbody tr', els => els.length);
  const firstModelName = await page.$eval('#detail-models-tbody tr td:first-child', el => el.textContent.trim());
  console.log(`\n5. Model Inventory Table:`);
  console.log(`   - Total Active Models Rendered: ${modelRowCount}`);
  console.log(`   - Primary Model Entry: ${firstModelName}`);
  if (modelRowCount < 20) throw new Error(`Expected real model count (>=20), found ${modelRowCount}`);

  // Verify Telemetry Tools
  const toolChips = await page.$$eval('#detail-tools-container .tool-chip', els => els.map(e => e.textContent.trim().replace(/\s+/g, ' ')));
  console.log(`\n6. Telemetry Tools:`);
  toolChips.forEach(t => console.log(`   - ${t}`));

  // Verify Deep-link
  console.log("\n7. Verifying Deep-Link directly to user profile (?user=benebsworth)...");
  await page.goto(`${url}?user=benebsworth`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#user-detail-modal.active');
  const deepHandle = await page.$eval('#detail-handle', el => el.textContent.trim());
  console.log(`   Deep link successfully auto-opened modal for: ${deepHandle}`);

  await browser.close();
  console.log("\n🎉 ALL PRODUCTION DETAILED VIEW CHECKS PASSED PERFECTLY!");
}

verifyProdView().catch(err => {
  console.error("❌ Production verification failed:", err);
  process.exit(1);
});
