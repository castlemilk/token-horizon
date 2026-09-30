import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Hermetic UI coverage: no production requests, real Google credentials, or
// real clipboard writes. PNG rendering itself is covered by test-og-png.mjs.
const ORIGIN = 'https://token-horizon.dev';
const assetsRoot = path.resolve('docs');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const tokenExpiry = Math.floor(Date.now() / 1000) + 3600;
const credential = subject => 'header.' + Buffer.from(JSON.stringify({ sub: subject, email: subject + '@example.com', name: subject, exp: tokenExpiry })).toString('base64url') + '.signature';
const session = subject => ({ sub: subject, email: subject + '@example.com', name: subject, credential: credential(subject) });
const publishedAt = Math.floor(Date.now() / 1000);
const publicationDay = Math.floor(publishedAt / 86400) * 86400;
// Nonzero midnight offset reproduces a publisher in a different timezone;
// the last two weeks intentionally have no rows, so the publication anchor
// must still retain their zero-activity cells.
const daily = Array.from({ length: 105 }, (_, i) => ({ day: publicationDay - (118 - i) * 86400 + 14 * 3600, tokens: 7500 }));
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const errors = [];

async function setup({ signedIn = '', privateReport = false, denied = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
  await context.addInitScript(saved => {
    if (saved) localStorage.setItem('th_google_session', JSON.stringify(saved));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.testCopiedShare = value; } } });
  }, signedIn ? session(signedIn) : null);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requests = [], shares = [];
  const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(options){window.testGoogleCallback=options.callback},renderButton(host){const button=document.createElement('button');button.textContent='Continue with test Google';button.onclick=()=>window.testGoogleCallback({credential:${JSON.stringify(credential('owner'))}});host.append(button)},prompt(){},disableAutoSelect(){}}}};` }));
  await page.route(ORIGIN + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const record = { path: url.pathname, method: request.method(), token: request.headers()['x-google-token'], body: request.postDataJSON() };
    requests.push(record);
    if (url.pathname === '/api/config') return fulfill(route, { googleClientId: 'test-share.apps.googleusercontent.com' });
    if (url.pathname === '/api/leaderboard') return fulfill(route, { leaderboard: [], kpis: {}, movers: [], mostImproved: [], total: 0 });
    if (url.pathname === '/api/account/team') return fulfill(route, { ok: true, team: null, invites: [] });
    if (url.pathname === '/api/account/profiles') return fulfill(route, { profiles: [] });
    if (url.pathname === '/api/share/create') {
      const id = 'share' + String(shares.length + 1).padStart(3, '0');
      const created = { id, ...record.body };
      shares.push(created);
      return fulfill(route, { ok: true, share: created, url: ORIGIN + '/s/' + id });
    }
    if (url.pathname.startsWith('/api/og/share/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (url.pathname.startsWith('/api/shared/')) {
      if (privateReport && !record.token) return fulfill(route, { code: 'auth_required', error: 'Sign in to view this report.' }, 401);
      if (privateReport && record.token !== credential('owner')) return fulfill(route, { code: 'share_access_denied', error: 'This report is shared with another account.' }, 403);
      if (denied) return fulfill(route, { code: 'share_access_denied', error: 'You do not have access.' }, 403);
      return fulfill(route, { ok: true, share: { id: 'private001', scope: 'people', options: { includeLeagueRank: false }, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
        report: { handle: 'Anonymous', tokensAll: 1250000, tokensAllFormatted: '1.25M', tokens7d: 40000, tokensToday: 0, updatedAt: publishedAt, streakDays: 8, daily, history: [{ day: publicationDay - 14 * 86400, tokens: 12345 }], models: [] } });
    }
    if (url.pathname.startsWith('/api/')) return fulfill(route, {});
    const relative = url.pathname === '/leaderboard' || url.pathname.startsWith('/s/') ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(assetsRoot, relative);
    if (!file.startsWith(assetsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route(/https?:\/\/(?!token-horizon\.dev\/|accounts\.google\.com\/).*/, route => route.abort());
  return { page, context, requests, shares };
}

try {
  console.log('Share preview: no image request until creation; draft changes cannot copy an old link...');
  {
    const { page, context, requests, shares } = await setup({ signedIn: 'owner' });
    await page.goto(ORIGIN + '/leaderboard', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => state.googleConfig === 'ready');
    await page.evaluate(() => openShareModal('alice'));
    assert.equal(await page.locator('#share-copy-link').isDisabled(), true);
    assert.equal(requests.some(item => item.path.startsWith('/api/og/')), false);
    await page.locator('[data-scope="people"]').click();
    assert.equal(await page.locator('#share-public-toggle').getAttribute('aria-checked'), 'false');
    await page.locator('#share-audience-input').fill('@owner');
    await page.locator('#share-audience-input').press('Enter');
    assert.match(await page.locator('#share-audience-pills').innerText(), /@owner/);
    await page.locator('#share-now').click();
    await page.waitForSelector('#share-preview-frame.ready');
    assert.equal(shares[0].handle, 'alice');
    assert.deepEqual(shares[0].audience, ['@owner']);
    assert.equal(shares[0].publicLink, false);
    assert.equal(await page.locator('#share-og-preview').getAttribute('src'), ORIGIN + '/api/og/share/share001.png');
    assert.match(await page.locator('.share-preview-label').innerText(), /Private links/);
    await page.locator('#share-copy-link').click();
    assert.equal(await page.evaluate(() => window.testCopiedShare), ORIGIN + '/s/share001');

    await page.locator('[data-opt="anonymizeNames"]').click();
    assert.equal(await page.locator('#share-copy-link').isDisabled(), true);
    assert.equal(await page.locator('#share-og-preview').count(), 0);
    assert.match(await page.locator('#share-audience-pills').innerText(), /@owner/);
    await page.locator('#share-now').click();
    await page.waitForSelector('#share-preview-frame.ready');
    assert.equal(shares[1].options.anonymizeNames, true);
    assert.equal(await page.locator('#share-og-preview').getAttribute('src'), ORIGIN + '/api/og/share/share002.png');
    await page.locator('#share-expiry').selectOption('7');
    assert.equal(await page.locator('#share-copy-link').isDisabled(), true);
    assert.equal(await page.locator('#share-og-preview').count(), 0);

    await page.evaluate(() => openShareModal('bob'));
    assert.equal(await page.locator('#share-copy-link').isDisabled(), true);
    assert.equal(await page.locator('#share-og-preview').count(), 0);
    assert.doesNotMatch(await page.locator('#share-audience-pills').innerText(), /@owner/);
    await page.locator('[data-scope="public"]').click();
    await page.locator('#share-now').click();
    await page.waitForSelector('#share-preview-frame.ready');
    assert.equal(shares[2].handle, 'bob');
    assert.equal(await page.locator('#share-og-preview').getAttribute('src'), ORIGIN + '/api/og/share/share003.png');
    await page.locator('[data-scope="private"]').click();
    assert.equal(await page.locator('#share-public-toggle').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#share-copy-link').isDisabled(), true);
    assert.match(await page.locator('#share-modal').innerText(), /Only your signed-in account/);
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.locator('#share-modal').evaluate(modal => modal.scrollWidth > modal.clientWidth + 1);
    assert.equal(overflow, false, 'The share dialog must fit a phone viewport');
    await context.close();
  }

  console.log('Private report: sign-in resumes one authenticated, uncached read and keeps rank hidden...');
  {
    const { page, context, requests } = await setup({ privateReport: true });
    await page.goto(ORIGIN + '/s/private001', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.signin-modal');
    assert.match(await page.locator('#view').innerText(), /Sign in to open this report/);
    await page.getByRole('button', { name: 'Continue with test Google', exact: true }).click();
    await page.waitForSelector('.kpi-value');
    const reads = requests.filter(item => item.path === '/api/shared/private001');
    assert.equal(reads.length, 2);
    assert.equal(reads[0].token, undefined);
    assert.equal(reads[1].token, credential('owner'));
    assert.match(await page.locator('#view').innerText(), /1.25M/);
    assert.doesNotMatch(await page.locator('#view').innerText(), /Rank|League|undefined/);
    const calendarTips = await page.locator('.cal-cell[data-tip]').evaluateAll(cells => cells.map(cell => cell.dataset.tip));
    assert.equal(await page.locator('.cal-cell').count(), 119);
    assert(calendarTips.some(tip => tip.includes('7.5k tokens')), 'Timezone-offset activity must retain its nonzero tokens');
    const lastDayLabel = await page.evaluate(day => new Date(day * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }), publicationDay);
    assert(calendarTips.includes(lastDayLabel + ' — no usage'), 'The published endpoint must retain trailing zero-activity days');
    assert.equal(await page.locator('[data-cal-day]').count(), 0, 'Shared calendar cells must not open another profile drilldown');
    await page.evaluate(() => renderSharedReport('private001'));
    assert.equal(requests.filter(item => item.path === '/api/shared/private001').length, 3);
    assert.equal(await page.evaluate(() => state.view), 'shared');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#user-chip').click();
    await page.waitForSelector('#shared-report-signin');
    assert.equal(await page.locator('.kpi-value').count(), 0, 'Signing out must clear the report data');
    assert.equal(await page.locator('.signin-modal').count(), 0, 'Signing out must not open sign-in again');
    await page.evaluate(saved => setGoogleSession(saved), session('stranger'));
    await page.waitForFunction(() => document.querySelector('#view').textContent.includes("You don't have access yet"));
    assert.equal(await page.locator('.kpi-value').count(), 0, 'Switching accounts cannot retain the previous report');
    await page.evaluate(saved => setGoogleSession(saved), session('owner'));
    await page.waitForSelector('.kpi-value');
    assert.match(await page.locator('#view').innerText(), /1.25M/);
    await context.close();
  }

  console.log('Private report: denied recipients get a clear recovery action...');
  {
    const { page, context } = await setup({ signedIn: 'stranger', denied: true });
    await page.goto(ORIGIN + '/s/denied001', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#shared-report-signin');
    assert.match(await page.locator('#view').innerText(), /You don't have access yet/);
    assert.equal(await page.locator('.kpi-value').count(), 0);
    await page.locator('#shared-report-signin').click();
    await page.waitForSelector('.signin-modal');
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.locator('#shared-report-back').click();
    await page.waitForFunction(() => location.pathname === '/leaderboard');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Share preview and private report UI checks passed.');
} finally { await browser.close(); }
