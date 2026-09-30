import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveChromium } from './playwright.mjs';

// All traffic is intercepted. These exercise identity selection and the real
// workspace controller, not an authenticated production browser session.
const file = pathToFileURL(path.resolve('docs/leaderboard.html')).href;
const today = Math.floor(Date.now() / 86400000) * 86400;
const profile = handle => ({ handle, entry: {
  handle, updatedAt: Date.now() / 1000 - 172800, tokensToday: 12000, tokens7d: 36000,
  tokensAll: 72000, costToday: 0, cost7d: 0, costAll: 0,
  requestsAll: 42, inputTokensAll: 42000, outputTokensAll: 12000,
  breakdown: {
    models: [
      { model: 'alpha-model', provider: 'anthropic', tokensAll: 60000, inputTokens: 36000, outputTokens: 10000, costAll: 0, requests: 30 },
      { model: 'beta-model', provider: 'openai', tokensAll: 12000, inputTokens: 6000, outputTokens: 2000, costAll: 0, requests: 12 }
    ],
    modelHistory: [{ model: 'alpha-model', provider: 'anthropic', points: [1, 2, 3].map(i => ({ day: today - (3 - i) * 86400, tokens: i * 1000 })) }],
    sessions: [{ title: '', model: 'alpha-model', provider: 'anthropic', tokens: 8000, cost: 0, at: today + 1000 }],
    projects: [{ project: 'a-real-project', tokens: 72000, cost: 0, sessions: 1 }],
    tools: [{ tool: 'codex', tokensAll: 72000 }]
  }
} });
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const errors = [];

async function setup({ signedIn = false, stallConfig = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (signedIn) await context.addInitScript(() => localStorage.setItem('th_google_session', JSON.stringify({ email: 'alice@example.com', name: 'Alice' })));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://token-horizon.dev/api/**', route => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push({ path: url.pathname, token: req.headers()['x-google-token'] });
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/config') return stallConfig ? new Promise(() => {}) : json({ googleClientId: '' });
    if (url.pathname === '/api/account/profiles') {
      const isBob = req.headers()['x-google-token'] === 'google:bob@example.com';
      return json({ profiles: [{ handle: isBob ? 'bob' : 'alice', displayName: isBob ? 'Bob' : 'Alice' }] });
    }
    if (url.pathname.startsWith('/api/user/') && !url.pathname.endsWith('/missing')) return json(profile(url.pathname.split('/').at(-1)));
    return json({ error: 'Profile not found' }, 404);
  });
  return { page, context, requests };
}

try {
  console.log('Workspace: anonymous chooser never selects a leaderboard participant...');
  {
    const { page, context, requests } = await setup();
    await page.goto(file + '?view=dashboard');
    await page.waitForSelector('[data-tw-handle]');
    assert.equal(requests.some(r => r.path.includes('leaderboard') || r.path.includes('/api/user/')), false);
    assert.equal(await page.locator('[data-tw-model-table]').count(), 0);
    await page.locator('[data-tw-handle]').fill('alice');
    await page.locator('[data-tw-handle]').press('Enter');
    await page.waitForSelector('[data-tw-tab="overview"]');
    assert.match(page.url(), /user=alice/);
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), 'alice');
    await context.close();
  }

  console.log('Workspace: explicit profile loads independently; privacy, search, tabs and mobile...');
  {
    const { page, context, requests } = await setup({ stallConfig: true });
    await page.goto(file + '?view=dashboard&user=alice', { waitUntil: 'commit' });
    await page.waitForSelector('[data-tw-tab="overview"]', { timeout: 1500 });
    const content = await page.locator('.th-workspace').innerText();
    assert.match(content, /Private session/);
    assert.match(content, /Historical snapshot/);
    assert.match(content, /zero, hidden, or unavailable/);
    assert.match(content, /Cache reads[\s\S]*Not published/);
    assert.doesNotMatch(content, /\$0\.00|User Activity Deep Dive|Cache hit rate/);
    assert.equal(requests.some(r => r.path.includes('leaderboard')), false);
    assert.equal(await page.locator('a[href="tokenhorizon://dashboard"]').count() > 0, true);
    await page.locator('[data-tw-tab="models"]').click();
    await page.locator('[data-tw-search]').fill('beta');
    assert.equal(await page.locator('[data-tw-model-table] tbody tr').count(), 1);
    assert.match(await page.locator('[data-tw-model-table]').innerText(), /beta-model/);
    await page.locator('[data-tw-search]').fill('');
    await page.locator('[data-tw-sort]').selectOption('name');
    assert.match(await page.locator('[data-tw-model-table] tbody tr').first().innerText(), /alpha-model/);
    await page.locator('[data-tw-tab="activity"]').click();
    assert.match(await page.locator('.th-workspace').innerText(), /a-real-project/);
    assert.match(await page.locator('.th-workspace').innerText(), /codex/);
    await page.locator('[data-tw-tab="optimize"]').click();
    assert.match(await page.locator('.th-workspace').innerText(), /No savings are assumed/);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ['overview', 'models', 'activity', 'optimize']) {
      await page.locator(`[data-tw-tab="${tab}"]`).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${tab} overflows mobile`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.th-workspace *')].some(el => getComputedStyle(el).animationName !== 'none')), false);
    await context.close();
  }

  console.log('Workspace: owner discovery follows the session; invalid profile never falls back...');
  {
    const { page, context, requests } = await setup({ signedIn: true });
    await page.goto(file + '?view=dashboard');
    await page.waitForSelector('[data-tw-tab="overview"]');
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), 'alice');
    let expiredRequest;
    await page.route('https://token-horizon.dev/api/old-session', route => { expiredRequest = route; });
    const oldRequestSeen = page.waitForRequest('https://token-horizon.dev/api/old-session');
    await page.evaluate(() => { window.oldSessionRead = api('/api/old-session', { headers: googleHeaders() }).catch(() => {}); });
    await oldRequestSeen;
    await page.evaluate(() => { setGoogleSession(null); setGoogleSession({ email: 'bob@example.com', name: 'Bob' }); completeSignIn(); });
    await page.waitForFunction(() => document.querySelector('.tw-footnote')?.textContent.includes('@bob'));
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), 'bob');
    assert.equal(await page.locator('[data-tw-profile] option[value="alice"]').count(), 0);
    await expiredRequest.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'auth_required', error: 'Expired' }) });
    await page.evaluate(() => window.oldSessionRead);
    assert.equal(await page.evaluate(() => state.googleSession?.email), 'bob@example.com', 'old 401 signed out the new account');
    assert.deepEqual(requests.filter(r => r.path === '/api/account/profiles').map(r => r.token), ['google:alice@example.com', 'google:bob@example.com']);
    await page.evaluate(() => navigate('dashboard', { handle: 'missing' }));
    await page.waitForSelector('[data-tw-retry]');
    assert.equal(await page.locator('[data-tw-model-table]').count(), 0);
    assert.match(await page.locator('.th-workspace').innerText(), /Profile not found/);
    await context.close();
  }
  console.log('Workspace: custom API cannot receive saved sign-in credentials...');
  {
    const { page, context } = await setup({ signedIn: true });
    const remoteRequests = [];
    await page.route('https://untrusted-api.invalid/**', route => {
      remoteRequests.push(route.request().headers());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ googleClientId: '' }) });
    });
    await page.goto(file + '?view=dashboard&api=https%3A%2F%2Funtrusted-api.invalid');
    await page.waitForSelector('[data-tw-retry]');
    assert.match(await page.locator('.th-workspace').innerText(), /custom API address/);
    assert.equal(remoteRequests.length, 1, 'only public configuration may use the override');
    assert.equal(remoteRequests.some(headers => headers['x-google-token'] || headers.authorization), false);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('✅ WORKSPACE IDENTITY, DATA, PRIVACY AND RESPONSIVE TESTS PASSED');
} finally { await browser.close(); }
