import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import worker from '../cloudflare/src/index.js';
import { resolveChromium } from './playwright.mjs';

// Hermetic: the actual worker serves nested invite HTML and every browser
// request is fulfilled from repository assets or fixtures. Never uses a real
// Google session, production API, clipboard, or recipient.
const ORIGIN = 'https://token-horizon.dev';
const TOKEN = 'a'.repeat(48);
const TEAM = { id: 'b'.repeat(32), name: 'Moonshot Club', memberCount: 3, role: 'member' };
const invite = { token: TOKEN, url: `${ORIGIN}/invite/${TOKEN}`, createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, revoked: false };
const expires = Math.floor(Date.now() / 1000) + 3600;
const credential = subject => `header.${Buffer.from(JSON.stringify({ sub: subject, email: `${subject}@example.com`, name: subject, exp: expires })).toString('base64url')}.signature`;
const session = subject => ({ sub: subject, email: `${subject}@example.com`, name: subject, credential: credential(subject) });
const assetsRoot = path.resolve('docs');
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const errors = [];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };

async function assetResponse(request) {
  const { pathname } = new URL(request.url);
  const relative = ['/leaderboard', '/teams'].includes(pathname) ? 'leaderboard.html' : pathname.slice(1);
  const target = path.resolve(assetsRoot, relative);
  if (!target.startsWith(assetsRoot + path.sep)) return new Response('', { status: 404 });
  try { return new Response(await fs.readFile(target), { headers: { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' } }); }
  catch { return new Response('', { status: 404 }); }
}

async function setup({ signedIn = '', conflict = false, rejectedInvite = false, stallConfig = false, holdJoin = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(saved => {
    if (saved) localStorage.setItem('th_google_session', JSON.stringify(saved));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.testCopiedInvite = value; } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async value => { window.testSharedInvite = value; } });
  }, signedIn ? session(signedIn) : null);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  const uiState = { team: null, invites: [], joins: [], pendingJoin: null };
  const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
  await page.route('https://accounts.google.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(options){window.testGoogleCallback=options.callback},renderButton(host){const button=document.createElement('button');button.textContent='Continue with test Google';button.onclick=()=>window.testGoogleCallback({credential:${JSON.stringify(credential('friend'))}});host.append(button)},prompt(){},disableAutoSelect(){}}}};` }));
  await page.route(`${ORIGIN}/**`, async route => {
    const req = route.request(), url = new URL(req.url());
    const item = { path: url.pathname, method: req.method(), token: req.headers()['x-google-token'], body: req.postDataJSON() };
    requests.push(item);
    if (url.pathname === '/api/config') return stallConfig ? new Promise(() => {}) : fulfill(route, { googleClientId: 'test-invite.apps.googleusercontent.com' });
    if (url.pathname === `/api/team/invites/${TOKEN}`) return rejectedInvite
      ? fulfill(route, { error: 'This invite has been retired. Ask your friend for a fresh link.', code: 'invite_revoked' }, 410)
      : fulfill(route, { ok: true, team: TEAM, expiresAt: invite.expiresAt });
    if (url.pathname === '/api/account/team') return fulfill(route, { ok: true, team: uiState.team, invites: uiState.invites });
    if (url.pathname === '/api/team/invites' && req.method() === 'POST') {
      uiState.team = { ...TEAM, name: item.body.name || TEAM.name, role: 'owner', memberCount: 1 };
      uiState.invites = [{ ...invite }];
      return fulfill(route, { ok: true, team: uiState.team, invites: uiState.invites });
    }
    if (url.pathname === '/api/team/invites/revoke') {
      uiState.invites = uiState.invites.map(row => ({ ...row, revoked: true }));
      return fulfill(route, { ok: true, team: uiState.team, invites: uiState.invites });
    }
    if (url.pathname === '/api/team/join') {
      uiState.joins.push(item);
      if (holdJoin) { uiState.pendingJoin = route; return; }
      if (conflict && item.body.confirmSwitch !== true) return fulfill(route, { code: 'team_switch_required', error: 'Joining Moonshot Club will move you from Earth Crew.' }, 409);
      uiState.team = { ...TEAM };
      return fulfill(route, { ok: true, team: uiState.team, invites: [], alreadyMember: false });
    }
    if (url.pathname === '/api/account/profiles') return fulfill(route, { profiles: [] });
    if (url.pathname === '/api/providers') return fulfill(route, { providers: [], teams: [], total: 0, history: { providers: [], points: [] }, insights: {} });
    if (url.pathname === '/api/models/catalog') return fulfill(route, { models: [{ id: 'openai/fixture-model', name: 'Fixture model', provider: 'openai', providerName: 'OpenAI', inputPerM: 1, outputPerM: 3, category: 'balanced' }], providers: [], count: 1 });
    if (url.pathname === '/api/models/usage') return fulfill(route, { ok: true, models: [] });
    if (url.pathname === '/api/leaderboard') return fulfill(route, { ok: true, leaderboard: [], total: 0, kpis: { totalTokens: 0, totalCost: 0, activeDevs: 0, maxStreakDays: 0 }, movers: { gains: [], improved: [] }, usageHistory: { providers: [], points: [] } });
    if (url.pathname.startsWith('/api/')) return fulfill(route, { error: 'Fixture endpoint not found' }, 404);
    const response = await worker.fetch(new Request(req.url(), { headers: { accept: req.headers().accept || 'text/html' } }), { ASSETS: { fetch: assetResponse } });
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  // Keep unanticipated third-party traffic out of a regression run.
  await page.route(/https?:\/\/(?!token-horizon\.dev\/|accounts\.google\.com\/).*/, route => route.abort());
  return { page, context, requests, uiState, fulfill };
}

async function openInvite(page) {
  await page.goto(`${ORIGIN}/invite/${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-ti-join]');
}

try {
  console.log('Invites: public nested route loads independently; no membership mutation on arrival...');
  {
    const { page, context, requests } = await setup({ stallConfig: true });
    await openInvite(page);
    assert.match(await page.locator('#view').innerText(), /Moonshot Club/);
    assert.equal(requests.some(row => row.path === '/api/leaderboard'), false);
    assert.equal(requests.some(row => row.path === '/api/team/join'), false);
    assert.equal(await page.locator('base').getAttribute('href'), '/');
    assert.equal(requests.some(row => row.path === '/team-invites.js'), true);
    assert.equal(requests.some(row => row.path.startsWith('/invite/') && row.path.endsWith('.js')), false);
    await context.close();
  }

  console.log('Invites: cancelled sign-in cannot join; signing in resumes the intended invite once...');
  {
    const { page, context, uiState } = await setup();
    await openInvite(page);
    await page.locator('[data-ti-join]').click();
    await page.waitForSelector('.signin-modal');
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    assert.equal(uiState.joins.length, 0);
    await page.evaluate(saved => { setGoogleSession(saved); completeSignIn(); }, session('friend'));
    await page.waitForSelector('[data-ti-join]');
    assert.equal(uiState.joins.length, 0, 'cancelled pending invite survived sign-in');
    await page.evaluate(() => { setGoogleSession(null); });
    await page.waitForSelector('[data-ti-join]');
    await page.locator('[data-ti-join]').click();
    await page.getByRole('button', { name: 'Continue with test Google', exact: true }).click();
    await page.waitForSelector('[data-ti-continue]');
    assert.equal(uiState.joins.length, 1);
    assert.equal(uiState.joins[0].body.token, TOKEN);
    assert.equal(uiState.joins[0].token, credential('friend'));
    assert.match(await page.locator('#view').innerText(), /Moonshot Club/);
    await page.locator('[data-ti-continue]').click();
    await page.waitForSelector('[data-invite-friends]');
    await page.waitForFunction(() => document.querySelector('.team-invite-banner strong')?.textContent === 'Moonshot Club');
    assert.match(page.url(), /\/teams(?:\?|$)/);
    assert.equal(new URL(page.url()).pathname, '/teams', 'continuing did not use the canonical team URL');
    await page.reload();
    await page.waitForSelector('[data-invite-friends]');
    assert.equal(await page.locator('[data-ti-join]').count(), 0);
    await context.close();
  }

  console.log('Invites: a pending join cannot repaint the model explorer after navigation...');
  {
    const { page, context, uiState, fulfill } = await setup({ signedIn: 'friend', holdJoin: true });
    await openInvite(page);
    const pending = page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/join');
    await page.locator('[data-ti-join]').click();
    await pending;
    await page.evaluate(() => navigate('models'));
    await page.waitForSelector('.mx-row');
    await fulfill(uiState.pendingJoin, { ok: true, team: TEAM, invites: [] });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.mx-row').count(), 1);
    assert.equal(await page.locator('.ti-invite-page').count(), 0);
    assert.equal(await page.evaluate(() => state.view), 'models');
    await context.close();
  }

  console.log('Invites: owners create, copy and retire a team link without publishing a profile...');
  {
    const { page, context, uiState } = await setup({ signedIn: 'alice' });
    await page.goto(`${ORIGIN}/teams`);
    await page.waitForSelector('[data-team-empty-invite]');
    await page.locator('[data-team-empty-invite]').click();
    await page.waitForSelector('[name="teamName"]');
    await page.locator('[name="teamName"]').fill('Moonshot Club');
    await page.locator('[data-ti-create] button[type="submit"]').click();
    await page.waitForSelector('[data-ti-copy]');
    assert.equal(uiState.team.role, 'owner');
    await page.locator('[data-ti-copy]').first().click();
    assert.equal(await page.evaluate(() => window.testCopiedInvite), invite.url);
    await page.locator('[data-ti-revoke]').first().click();
    await page.waitForSelector('[data-ti-new-link]');
    assert.equal(uiState.invites[0].revoked, true);
    await context.close();
  }

  console.log('Invites: moving teams requires an explicit second confirmation...');
  {
    const { page, context, uiState } = await setup({ signedIn: 'friend', conflict: true });
    await openInvite(page);
    await page.locator('[data-ti-join]').click();
    await page.getByRole('button', { name: 'Switch team & join', exact: true }).waitFor();
    assert.equal(uiState.joins.length, 1);
    assert.equal(uiState.joins[0].body.confirmSwitch, false);
    assert.match(await page.locator('#view').innerText(), /Earth Crew/);
    await page.getByRole('button', { name: 'Switch team & join', exact: true }).click();
    await page.waitForSelector('[data-ti-continue]');
    assert.equal(uiState.joins.length, 2);
    assert.equal(uiState.joins[1].body.confirmSwitch, true);
    await context.close();
  }

  console.log('Invites: errors are actionable; successful profileless join is responsive and respects reduced motion...');
  {
    const { page, context, uiState } = await setup({ signedIn: 'friend' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openInvite(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.locator('[data-ti-join]').click();
    await page.waitForSelector('[data-ti-continue]');
    assert.equal(uiState.joins.length, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#view *')].some(el => getComputedStyle(el).animationName !== 'none')), false);
    await context.close();
    const rejected = await setup({ rejectedInvite: true });
    await rejected.page.goto(`${ORIGIN}/invite/${TOKEN}`);
    await rejected.page.waitForSelector('[data-ti-retry]');
    assert.match(await rejected.page.locator('#view').innerText(), /fresh link/);
    assert.equal(await rejected.page.locator('[data-ti-join]').count(), 0);
    assert.equal(rejected.uiState.joins.length, 0);
    await rejected.context.close();
  }

  console.log('Invites: refreshing the same identity cannot leave a successful join spinning...');
  {
    const { page, context, uiState, fulfill } = await setup({ signedIn: 'friend', holdJoin: true });
    await openInvite(page);
    const pending = page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/join');
    await page.locator('[data-ti-join]').click();
    await pending;
    await page.evaluate(() => setGoogleSession({ ...state.googleSession }));
    await fulfill(uiState.pendingJoin, { ok: true, team: TEAM, invites: [] });
    await page.waitForSelector('[data-ti-continue]');
    assert.equal(uiState.joins.length, 1);
    assert.equal(await page.locator('[data-ti-join]').count(), 0);
    await context.close();
  }

  console.log('Invites: a pending join cannot paint success for a different signed-in account...');
  {
    const { page, context, uiState, fulfill } = await setup({ signedIn: 'alice', holdJoin: true });
    await openInvite(page);
    const pending = page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/join');
    await page.locator('[data-ti-join]').click();
    await pending;
    assert.equal(uiState.joins.length, 1);
    await page.evaluate(saved => { setGoogleSession(saved); completeSignIn(); }, session('bob'));
    await page.waitForSelector('[data-ti-join]');
    await fulfill(uiState.pendingJoin, { ok: true, team: TEAM, invites: [] });
    await page.waitForFunction(() => state.googleSession?.sub === 'bob');
    assert.equal(await page.locator('[data-ti-continue]').count(), 0);
    assert.equal(await page.evaluate(() => teamInviteResult), null);
    assert.equal(uiState.joins.length, 1, 'identity switch silently joined the new account');
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log('✅ TEAM INVITE ROUTING, SIGN-IN, OWNERSHIP AND RESPONSIVE TESTS PASSED');
} finally { await browser.close(); }
