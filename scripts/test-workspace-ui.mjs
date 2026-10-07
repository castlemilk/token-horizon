import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// All traffic is intercepted. These exercise identity selection and the real
// workspace controller, not an authenticated production browser session.
const file = 'https://token-horizon.dev/leaderboard.html';
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
const mutations = [];
const externalRequests = [];
const identity = (provider = 'github') => ({ provider, sub: `${provider}-alice`, email: 'alice@example.com', name: 'Alice' });
const owned = handle => ({ handle, displayName: handle === 'alice' ? 'Alice' : 'Laptop' });

async function setup({ signedIn = false, stallConfig = false, serverSessions = false, user = identity(), profiles = [owned('alice')], holdSession = false, holdProfiles = false, configError = false, sessionError = false, profilesError = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // No fixture may escape to a live service. Specific local handlers below take precedence.
  await context.route('**/*', route => { externalRequests.push(route.request().url()); return route.abort(); });
  if (signedIn) await context.addInitScript(() => localStorage.setItem('th_google_session', JSON.stringify({ email: 'alice@example.com', name: 'Alice' })));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (request.isNavigationRequest()) console.error('Fixture navigation failed:', request.url(), request.failure()?.errorText); });
  const requests = [];
  await page.route('https://token-horizon.dev/**', async route => {
    const url = new URL(route.request().url());
    // The Worker preserves historic root query links to the SPA as well.
    const relative = ['/leaderboard', '/leaderboard.html', '/models', '/teams'].includes(url.pathname) || url.pathname === '/' && url.searchParams.has('view') ? 'leaderboard.html' : url.pathname.slice(1);
    const filePath = path.resolve('docs', relative);
    if (!filePath.startsWith(path.resolve('docs') + path.sep)) return route.abort();
    try {
      let body = await fs.readFile(filePath);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/"/>'));
      const contentType = ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' })[path.extname(filePath)] || 'application/octet-stream';
      await route.fulfill({ contentType, body });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.google={accounts:{id:{initialize(){},renderButton(){},cancel(){},disableAutoSelect(){}}}};' }));
  const pending = { session: [], profiles: [] };
  const failed = { config: configError, session: sessionError, profiles: profilesError };
  const held = { session: holdSession, profiles: holdProfiles };
  let publishedProfiles = profiles;
  const respond = (kind, send) => held[kind] ? new Promise(resolve => pending[kind].push(async () => { await send(); resolve(); })) : send();
  await page.route('https://token-horizon.dev/api/**', route => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push({ path: url.pathname, search: url.search, method: req.method(), token: req.headers()['x-google-token'] });
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (!['GET', 'HEAD'].includes(req.method())) { mutations.push({ path: url.pathname, method: req.method() }); return json({ error: 'Fixture permits read-only requests' }, 405); }
    if (url.pathname === '/api/config') return stallConfig ? new Promise(() => {}) : failed.config ? json({ error: 'Configuration unavailable' }, 503) : json(serverSessions ? { googleClientId: 'fixture-client', webSessions: true, githubAuth: true } : { googleClientId: '' });
    if (url.pathname === '/api/auth/session') return respond('session', () => failed.session ? json({ error: 'Session service unavailable' }, 503) : json({ ok: true, authenticated: Boolean(user), user, expiresAt: Date.now() + 86400000 }));
    if (url.pathname === '/api/account/profiles') {
      if (serverSessions) return respond('profiles', () => failed.profiles ? json({ error: 'Owned profiles unavailable' }, 503) : json({ profiles: publishedProfiles }));
      const isBob = req.headers()['x-google-token'] === 'google:bob@example.com';
      return json({ profiles: [{ handle: isBob ? 'bob' : 'alice', displayName: isBob ? 'Bob' : 'Alice' }] });
    }
    if (url.pathname === '/api/share/list') return json({ shares: [], groups: [], activity: [] });
    if (url.pathname === '/api/leaderboard') return json({ entries: [{ ...profile('community-winner').entry, rank: 1 }] });
    if (url.pathname.startsWith('/api/user/') && !url.pathname.endsWith('/missing')) return json(profile(url.pathname.split('/').at(-1)));
    return json({ error: 'Profile not found' }, 404);
  });
  return { page, context, requests,
    setProfiles(value) { publishedProfiles = value; },
    recover(kind) { failed[kind] = false; },
    async release(kind) { held[kind] = false; await Promise.all(pending[kind].splice(0).map(send => send())); }
  };
}

const reads = (requests, pathName) => requests.filter(r => r.path === pathName);
const snapshots = requests => requests.filter(r => r.path.startsWith('/api/user/'));
const communityReads = requests => requests.filter(r => /^\/api\/(leaderboard|providers|models\/usage)(\/|$)/.test(r.path));
async function waitRead(requests, pathName) {
  for (let i = 0; i < 100 && !reads(requests, pathName).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(reads(requests, pathName).length, `Expected read ${pathName}`);
}
async function waitState(page, value) {
  try { await page.waitForSelector(`.tw-account-state[data-tw-state="${value}"]`, { timeout: 8000 }); }
  catch (error) { console.error('Workspace state diagnostic:', await page.evaluate(() => ({ text: document.querySelector('.th-workspace')?.innerText, authStatus: state.authStatus, session: Boolean(state.googleSession), accountStatus: workspaceAccount?.status }))); throw error; }
}
async function assertClosedPreview(page) {
  assert.equal(await page.locator('[data-tw-public-preview]').getAttribute('open'), null);
  assert.equal(await page.locator('[data-tw-handle]').isVisible(), false);
}
async function assertOwned(page, handle, view = 'dashboard') {
  await page.waitForFunction(value => document.querySelector('.tw-footnote')?.textContent.includes(`@${value}`), handle);
  assert.equal(await page.locator('[data-tw-profile]').inputValue(), handle);
  assert.match(await page.locator('.tw-heading').innerText(), /Your published usage/);
  assert.equal(new URL(page.url()).searchParams.get('view'), view);
}

try {
  console.log('Workspace: anonymous chooser never selects a leaderboard participant...');
  {
    const { page, context, requests } = await setup();
    await page.goto(file + '?view=dashboard');
    await waitState(page, 'signed-out');
    assert.equal(await page.locator('[data-tw-handle]').isVisible(), true);
    assert.equal(await page.locator('[data-tw-public-preview]').count(), 0);
    assert.equal(requests.some(r => r.path.includes('leaderboard') || r.path.includes('/api/user/')), false);
    assert.equal(await page.locator('[data-tw-model-table]').count(), 0);
    await page.locator('[data-tw-handle]').fill('alice');
    await page.locator('[data-tw-handle]').press('Enter');
    await page.waitForSelector('[data-tw-tab="overview"]');
    assert.match(page.url(), /user=alice/);
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), 'alice');
    await context.close();
  }

  console.log('Workspace: session and profile discovery never flash signed-out or empty states...');
  {
    const fixture = await setup({ serverSessions: true, profiles: [], holdSession: true, holdProfiles: true });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=dashboard');
    await waitState(page, 'checking');
    assert.equal(await page.locator('.th-workspace').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.tw-account-state').getAttribute('role'), 'status');
    assert.equal(await page.locator('[data-tw-handle], [data-tw-signin], [data-tw-state="empty"]').count(), 0);
    assert.equal(reads(requests, '/api/account/profiles').length, 0);
    assert.equal(snapshots(requests).length, 0);
    await fixture.release('session');
    await waitRead(requests, '/api/account/profiles');
    await waitState(page, 'profiles-loading');
    // Repeated renders must share the in-flight owned-profile lookup.
    await page.evaluate(() => { render(); });
    await waitState(page, 'profiles-loading');
    assert.equal(reads(requests, '/api/account/profiles').length, 1);
    assert.equal(await page.locator('[data-tw-handle], [data-tw-signin], [data-tw-state="empty"]').count(), 0);
    await fixture.release('profiles');
    await waitState(page, 'empty');
    assert.match(await page.locator('.tw-account-state').innerText(), /signed in with GitHub/);
    assert.equal(await page.locator('[data-tw-signin]').count(), 0);
    await assertClosedPreview(page);
    assert.equal(await page.getByRole('link', { name: 'How to publish a profile' }).count(), 1);
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    assert.equal(snapshots(requests).length, 0);
    assert.equal(communityReads(requests).length, 0);
    fixture.setProfiles([owned('alice')]);
    await page.locator('[data-tw-retry]').click();
    await assertOwned(page, 'alice');
    assert.equal(reads(requests, '/api/account/profiles').length, 2, 'Retry must invalidate the owned-profile cache');
    assert.equal(new URL(page.url()).searchParams.has('user'), false, 'automatic discovery must not turn into an explicit URL choice');
    await context.close();
  }

  console.log('Workspace: only a sole verified owned profile opens automatically for either provider...');
  for (const provider of ['google', 'github']) {
    const { page, context, requests } = await setup({ serverSessions: true, user: identity(provider) });
    await page.goto(file + '?view=dashboard');
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    assert.equal(await page.locator('[data-tw-signin], [data-tw-handle], .tw-preview-scope').count(), 0);
    assert.equal(snapshots(requests).length, 1);
    assert.equal(reads(requests, '/api/account/profiles').length, 1);
    assert.equal(communityReads(requests).length, 0);
    await page.locator('#nav [data-view="billing"]').click();
    await assertOwned(page, 'alice', 'billing');
    assert.equal(await page.locator('[data-tw-tab="models"]').getAttribute('aria-current'), 'page');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    await page.locator('#nav [data-view="dashboard"]').click();
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    assert.equal(snapshots(requests).length, 1, 'adjacent Workspace routes must reuse the chosen snapshot');
    await page.reload();
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    assert.equal(snapshots(requests).length, 2);
    await context.close();
  }

  console.log('Workspace: multiple owned profiles require intentional selection, and public previews remain distinct...');
  {
    const { page, context, requests } = await setup({ serverSessions: true, profiles: [owned('alice'), owned('laptop')] });
    await page.goto(file + '?view=dashboard');
    await waitState(page, 'choose');
    assert.deepEqual(await page.locator('.tw-owned-profiles [data-tw-select-owned]').evaluateAll(nodes => nodes.map(n => n.dataset.twSelectOwned)), ['alice', 'laptop']);
    assert.equal(snapshots(requests).length, 0);
    assert.equal(await page.locator('[data-tw-signin]').count(), 0);
    await assertClosedPreview(page);
    await page.locator('[data-tw-select-owned="laptop"]').focus();
    await page.keyboard.press('Enter');
    await assertOwned(page, 'laptop');
    assert.equal(new URL(page.url()).searchParams.get('user'), 'laptop');
    assert.deepEqual(snapshots(requests).map(r => r.path), ['/api/user/laptop']);
    await page.locator('#nav [data-view="billing"]').click();
    await assertOwned(page, 'laptop', 'billing');
    assert.equal(new URL(page.url()).searchParams.get('user'), 'laptop');
    await page.locator('#nav [data-view="dashboard"]').click();
    await assertOwned(page, 'laptop');
    assert.equal(new URL(page.url()).searchParams.get('user'), 'laptop');
    assert.deepEqual(snapshots(requests).map(r => r.path), ['/api/user/laptop']);
    await page.locator('[data-tw-profile]').selectOption('alice');
    await assertOwned(page, 'alice');
    assert.deepEqual(snapshots(requests).map(r => r.path), ['/api/user/laptop', '/api/user/alice']);
    await page.evaluate(() => navigate('dashboard', { resetWorkspace: true }));
    await waitState(page, 'choose');
    await page.locator('[data-tw-public-preview] summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-tw-handle]').isVisible(), true);
    await page.locator('[data-tw-handle]').fill('@visitor');
    await page.locator('[data-tw-handle]').press('Enter');
    await page.waitForSelector('[data-tw-tab="overview"]');
    assert.match(await page.locator('.tw-heading').innerText(), /Public profile preview · @visitor/);
    assert.match(await page.locator('.tw-profile').innerText(), /Published profile/);
    assert.equal(new URL(page.url()).searchParams.get('user'), 'visitor');
    assert.equal(await page.locator('.tw-preview-scope').count(), 1);
    await page.locator('[data-tw-home]').click();
    await waitState(page, 'choose');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    assert.equal(communityReads(requests).length, 0);
    await context.close();
  }

  console.log('Workspace: explicit public snapshots do not wait for identity or get replaced by owned discovery...');
  {
    const fixture = await setup({ serverSessions: true, holdSession: true, holdProfiles: true });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=dashboard&user=visitor');
    await page.waitForSelector('[data-tw-tab="overview"]');
    assert.match(await page.locator('.tw-heading').innerText(), /Public profile preview · @visitor/);
    assert.equal(reads(requests, '/api/account/profiles').length, 0);
    await fixture.release('session');
    await page.waitForFunction(() => isGoogleSessionValid());
    await fixture.release('profiles');
    await page.waitForFunction(() => document.querySelector('[data-tw-profile] option[value="alice"]'));
    assert.match(await page.locator('.tw-heading').innerText(), /Public profile preview · @visitor/);
    assert.deepEqual(snapshots(requests).map(r => r.path), ['/api/user/visitor']);
    await page.locator('[data-tw-home]').click();
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    await context.close();
  }

  console.log('Workspace: auth, owned-profile, and public-snapshot failures stay distinguishable and recoverable...');
  for (const failure of ['config', 'session', 'profiles']) {
    const fixture = await setup({ serverSessions: true, [`${failure}Error`]: true });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=dashboard');
    await waitState(page, 'account-error');
    assert.equal(await page.locator('.tw-account-state').getAttribute('role'), 'alert');
    assert.match(await page.locator('#tw-state-title').innerText(), failure === 'profiles' ? /Your profiles couldn’t load/ : /Sign-in couldn’t be checked/);
    assert.equal(await page.locator('[data-tw-state="empty"], [data-tw-state="signed-out"]').count(), 0);
    assert.equal(snapshots(requests).length, 0);
    if (failure !== 'profiles') assert.equal(reads(requests, '/api/account/profiles').length, 0);
    await assertClosedPreview(page);
    fixture.recover(failure);
    await page.locator('[data-tw-retry]').click();
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    await context.close();
  }
  {
    const fixture = await setup({ serverSessions: true, profilesError: true });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=dashboard&user=visitor');
    await page.waitForSelector('.tw-alert');
    assert.match(await page.locator('.tw-heading').innerText(), /Public profile preview · @visitor/);
    assert.match(await page.locator('.tw-alert').innerText(), /public snapshot is still available/);
    assert.equal(await page.locator('[data-tw-state="snapshot-error"]').count(), 0);
    fixture.recover('profiles');
    await page.locator('[data-tw-retry]').click();
    await page.waitForFunction(() => !document.querySelector('.tw-alert') && document.querySelector('[data-tw-profile] option[value="alice"]'));
    assert.deepEqual(snapshots(requests).map(r => r.path), ['/api/user/visitor', '/api/user/visitor'], 'Retry refreshes the same public snapshot instead of selecting an owned profile');
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), 'visitor');
    await context.close();
  }
  {
    const { page, context, requests } = await setup({ serverSessions: true });
    await page.goto(file + '?view=dashboard&user=missing');
    await waitState(page, 'snapshot-error');
    assert.match(await page.locator('#tw-state-title').innerText(), /Couldn’t open @missing/);
    assert.match(await page.locator('.tw-account-state').innerText(), /Profile not found/);
    assert.equal(await page.locator('[data-tw-model-table]').count(), 0);
    assert.ok(snapshots(requests).length > 0);
    assert.ok(snapshots(requests).every(r => r.path === '/api/user/missing'), 'A failed explicit snapshot must never fall back to an owned profile');
    await page.locator('[data-tw-home]').click();
    await assertOwned(page, 'alice');
    assert.equal(new URL(page.url()).searchParams.has('user'), false);
    await context.close();
  }

  console.log('Model costs: owned data uses the Workspace models tab without community endpoints...');
  for (const handles of [[], ['alice'], ['alice', 'laptop']]) {
    const fixture = await setup({ serverSessions: true, profiles: handles.map(owned) });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=billing');
    if (handles.length !== 1) {
      await waitState(page, handles.length ? 'choose' : 'empty');
      assert.equal(snapshots(requests).length, 0);
      assert.equal(communityReads(requests).length, 0);
      assert.equal(reads(requests, '/api/share/list').length, 0);
      await assertClosedPreview(page);
      if (!handles.length) { await context.close(); continue; }
      await page.locator('[data-tw-select-owned="laptop"]').click();
    }
    await assertOwned(page, handles.length === 1 ? 'alice' : 'laptop', 'billing');
    assert.equal(await page.locator('[data-tw-tab="models"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('[data-tw-search]').isVisible(), true);
    assert.match(await page.locator('[data-tw-model-table]').innerText(), /alpha-model[\s\S]*beta-model/);
    assert.equal(new URL(page.url()).searchParams.has('user'), handles.length > 1);
    assert.equal(communityReads(requests).length, 0);
    assert.equal(reads(requests, '/api/share/list').length, 0);
    // Reauthentication of the same principal must rerender this private route too,
    // and a 401 from the older session object must not invalidate the renewed one.
    let expiredRequest;
    await page.route('https://token-horizon.dev/api/billing-old-session', route => { expiredRequest = route; });
    const oldRequestSeen = page.waitForRequest('https://token-horizon.dev/api/billing-old-session');
    await page.evaluate(() => { window.oldBillingRead = api('/api/billing-old-session', { headers: googleHeaders() }).catch(() => {}); });
    await oldRequestSeen;
    await page.evaluate(() => { window.billingBeforeAuth = document.querySelector('.th-workspace'); setGoogleSession({ ...state.googleSession, expiresAt: Date.now() + 172800000 }); completeSignIn(); });
    await page.waitForFunction(() => document.querySelector('.th-workspace') !== window.billingBeforeAuth);
    await page.waitForSelector('[data-tw-tab="models"][aria-current="page"]');
    await expiredRequest.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'auth_required', error: 'Expired old session' }) });
    await page.evaluate(() => window.oldBillingRead);
    assert.equal(await page.evaluate(() => isGoogleSessionValid()), true);
    assert.equal(await page.locator('[data-tw-profile]').inputValue(), handles.length === 1 ? 'alice' : 'laptop');
    assert.equal(communityReads(requests).length, 0);
    await context.close();
  }

  console.log('Report sharing: only verified owned selections may read private report metadata...');
  {
    const fixture = await setup({ serverSessions: true, profiles: [owned('alice'), owned('laptop')], holdSession: true, holdProfiles: true });
    const { page, context, requests } = fixture;
    await page.goto(file + '?view=settings&user=community-winner');
    await waitRead(requests, '/api/auth/session');
    assert.equal(reads(requests, '/api/account/profiles').length, 0);
    assert.equal(reads(requests, '/api/share/list').length, 0);
    await fixture.release('session');
    await page.waitForFunction(() => isGoogleSessionValid());
    assert.equal(reads(requests, '/api/share/list').length, 0);
    await fixture.release('profiles');
    await page.waitForSelector('#settings-profile');
    assert.equal(await page.locator('#settings-profile').inputValue(), '');
    assert.deepEqual(await page.locator('#settings-profile option').evaluateAll(nodes => nodes.map(n => n.value)), ['', 'alice', 'laptop']);
    assert.equal(await page.locator('#settings-share-new, #new-group-btn').count(), 0);
    assert.equal(reads(requests, '/api/share/list').length, 0);
    await page.locator('#settings-profile').selectOption('laptop');
    await page.waitForFunction(() => document.querySelector('#settings-share-new')?.disabled === false);
    assert.deepEqual(reads(requests, '/api/share/list').map(r => new URLSearchParams(r.search).get('handle')), ['laptop']);
    assert.equal(new URL(page.url()).searchParams.get('user'), 'laptop');
    assert.equal(snapshots(requests).length, 0);
    assert.equal(communityReads(requests).length, 0);
    assert.doesNotMatch(await page.locator('#view').innerText(), /Default Sharing Rules|Permissions Matrix/);
    await context.close();
  }
  for (const handles of [[], ['alice']]) {
    const { page, context, requests } = await setup({ serverSessions: true, profiles: handles.map(owned) });
    await page.goto(file + '?view=settings&user=community-winner');
    await page.getByRole('heading', { name: 'Report sharing', exact: true }).waitFor();
    assert.equal(await page.locator('#settings-signin').count(), 0);
    assert.equal(await page.locator('#settings-share-new, #new-group-btn').count(), handles.length ? 2 : 0);
    if (handles.length) {
      assert.equal(await page.locator('#settings-share-new').isDisabled(), false);
      assert.equal(await page.locator('#new-group-btn').isDisabled(), false);
    }
    assert.deepEqual(reads(requests, '/api/share/list').map(r => new URLSearchParams(r.search).get('handle')), handles);
    if (!handles.length) assert.match(await page.locator('#view').innerText(), /No published profiles are linked/);
    else assert.match(await page.locator('#view').innerText(), /Sharing reports for @alice/);
    assert.equal(snapshots(requests).length, 0);
    assert.equal(communityReads(requests).length, 0);
    assert.doesNotMatch(await page.locator('#view').innerText(), /Default Sharing Rules|Permissions Matrix/);
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
  assert.deepEqual(mutations, [], 'Fixture must never mutate an account or published data');
  assert.deepEqual(externalRequests, [], 'Fixture traffic must remain hermetic');
  console.log('✅ WORKSPACE IDENTITY, DATA, PRIVACY AND RESPONSIVE TESTS PASSED');
} finally { await browser.close(); }
