import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import worker from '../cloudflare/src/index.js';
import { renderTeamOgSvg } from '../cloudflare/src/og-team.js';
import { resolveChromium } from './playwright.mjs';

// Full team journey, hermetic: real SPA/module/static artwork and Worker page
// metadata, fixture JSON/data URLs, fake accounts, and an isolated clipboard.
// No production account, recipient, invite, or uploaded file is touched.
const ORIGIN = 'https://token-horizon.dev', ROOT = path.resolve('docs');
const ID = 'b'.repeat(32), OTHER_ID = 'c'.repeat(32), TOKEN = 'a'.repeat(48), REVISION = 'd'.repeat(32);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGN4G+r3Hx9mGBkKAG8Uo8FWIl3AAAAAAElFTkSuQmCC', 'base64');
const TEAM = { id: ID, name: 'InterstellarObservabilityAndModelOptimisationCrew', memberCount: 18, logoUrl: `/api/team/${ID}/logo?v=${REVISION}`, logoUpdatedAt: 123, url: ORIGIN + '/t/' + ID, ogImage: ORIGIN + '/api/og/team/' + ID + '.png' };
const STATS = { tokens: 12000000, tokensFormatted: '12.00M', cost: 10, costFormatted: '$10.00', publishedProfiles: 3, providers: { openai: 9000000, anthropic: 3000000 }, users: [{ handle: 'pilot', tokensAll: 7000000 }, { handle: 'friend', tokensAll: 3000000 }, { handle: 'builder', tokensAll: 2000000 }] };
const INVITE = { token: TOKEN, url: ORIGIN + '/invite/' + TOKEN, createdAt: Date.now(), expiresAt: Date.now() + 86400000, revoked: false };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });
const screenshots = process.env.TEAM_FLOW_SCREENSHOTS === '1';
const ogPreview = screenshots ? await previewPng() : PNG;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = subject => ({ provider: 'github', sub: subject, login: subject, name: subject === 'owner' ? 'Team Owner' : 'Another Owner', email: subject + '@example.test' });

async function previewPng() {
  const { Resvg, initWasm } = await import('../cloudflare/node_modules/@resvg/resvg-wasm/index.mjs');
  const [wasm, ...fonts] = await Promise.all([
    fs.readFile(new URL('../cloudflare/node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)),
    ...['TokenHorizonSans-Regular.ttf', 'TokenHorizonSans-SemiBold.ttf', 'JetBrainsMono-Regular.ttf'].map(name => fs.readFile(new URL('../cloudflare/fonts/' + name, import.meta.url)))
  ]);
  await initWasm(wasm);
  const renderer = new Resvg(renderTeamOgSvg(TEAM, STATS, { logoDataUri: 'data:image/png;base64,' + PNG.toString('base64') }), { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Token Horizon Sans' } });
  let image;
  try { image = renderer.render(); return Buffer.from(image.asPng()); }
  finally { image?.free(); renderer.free(); }
}

async function assets(request) {
  const pathname = new URL(request.url).pathname;
  const file = path.resolve(ROOT, pathname === '/leaderboard' ? 'leaderboard.html' : pathname.slice(1));
  if (!file.startsWith(ROOT + path.sep)) return new Response('', { status: 404 });
  try { return new Response(await fs.readFile(file), { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' } }); }
  catch { return new Response('', { status: 404 }); }
}

function metadataBucket() {
  const records = new Map();
  records.set(`team-membership/teams/${ID}.json`, { id: ID, name: TEAM.name, owner: hash('github:owner'), createdAt: 123, logoRevision: REVISION, logoUpdatedAt: TEAM.logoUpdatedAt });
  const entries = STATS.users.map((row, index) => ({ ...row, id: 'fixture:' + row.handle, ownerId: 'github:' + (index === 0 ? 'owner' : row.handle), claimed: true, team: TEAM.name, teamId: ID, tokensToday: 100, tokens7d: 1000, costAll: 1, updatedAt: Date.now() / 1000, breakdown: { models: [{ provider: index === 0 ? 'anthropic' : 'openai', model: 'fixture-' + index, tokensAll: row.tokensAll }], daily: [], sessions: [], projects: [] } }));
  records.set('leaderboard.json', entries);
  const subjects = ['owner', 'friend', 'builder', ...Array.from({ length: 15 }, (_, i) => 'unpublished-' + i)];
  for (const subject of subjects) {
    const account = hash('github:' + subject);
    records.set(`team-membership/accounts/${account}.json`, { teamId: ID, joinedAt: 123 });
    records.set(`team-membership/members/${ID}/${account}.json`, { account });
  }
  const digest = hash(TOKEN);
  records.set(`team-membership/invite-links/${digest}.json`, { teamId: ID });
  records.set(`team-membership/invites/${ID}/${digest}.json`, { ...INVITE, teamId: ID });
  return {
    async get(key) { const value = records.get(key); return value ? { etag: key, text: async () => JSON.stringify(value) } : null; },
    async list({ prefix }) { return { objects: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async put(key, value) { records.set(key, JSON.parse(value)); return { etag: key }; }
  };
}

async function fixture({ width = 1440, colorScheme = 'light', signedIn = '', deniedClipboard = false, holdTeam = false, holdSession = false, holdUpload = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce' });
  await context.addInitScript(denied => {
    window.testCopied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { if (denied) throw new DOMException('Denied', 'NotAllowedError'); window.testCopied.push(value); } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async value => { window.testShared = value; } });
  }, deniedClipboard);
  const page = await context.newPage(), errors = [], requests = [];
  const ui = { subject: signedIn, team: { ...TEAM, role: 'owner' }, upload: null, uploadReply: null, teamReply: null, sessionReply: null, logo: PNG };
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
  const env = { LEADERBOARD_BUCKET: metadataBucket(), ASSETS: { fetch: assets } };
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const record = { path: url.pathname, method: req.method(), body: req.postData() ? req.postDataJSON() : null, subject: ui.subject };
    requests.push(record);
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: '', webSessions: true, googleAuth: false, githubAuth: true, canonicalUrl: ORIGIN });
    if (url.pathname === '/api/auth/session') {
      const send = () => { holdSession = false; return json(route, { ok: true, authenticated: Boolean(ui.subject), user: ui.subject ? identity(ui.subject) : null, expiresAt: ui.subject ? Date.now() + 86400000 : null }); };
      if (holdSession) { ui.sessionReply = send; return; }
      return send();
    }
    if (url.pathname === '/api/account/profiles') return json(route, { ok: true, profiles: ui.subject ? [{ handle: 'pilot' }] : [] });
    if (url.pathname === '/api/account/team') return json(route, { ok: true, team: ui.subject ? ui.team : null, invites: ui.subject ? [{ ...INVITE }] : [] });
    if (url.pathname === '/api/team/' + ID) {
      const send = () => { holdTeam = false; return json(route, { ok: true, team: { ...TEAM, ...(ui.team.id === ID ? ui.team : {}) }, stats: STATS }); };
      if (holdTeam) { ui.teamReply = send; return; }
      return send();
    }
    if (url.pathname === '/api/team/invites/' + TOKEN) return json(route, { ok: true, team: { ...TEAM }, expiresAt: INVITE.expiresAt });
    if (/^\/api\/team\/[a-f0-9]{32}\/logo$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: ui.logo });
    if (url.pathname.startsWith('/api/og/team/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ogPreview });
    if (url.pathname === '/api/team/logo' && req.method() === 'POST') {
      const changed = { ...ui.team, logoUrl: record.body.clear ? '' : `/api/team/${ui.team.id}/logo?v=${'e'.repeat(32)}`, logoUpdatedAt: ui.team.logoUpdatedAt + 1 };
      const send = async () => {
        if (ui.subject === record.subject) {
          ui.team = changed;
          if (record.body.image) ui.logo = Buffer.from(record.body.image.split(',')[1], 'base64');
        }
        await json(route, { ok: true, team: changed });
      };
      ui.upload = record;
      if (holdUpload) { ui.uploadReply = send; return; }
      return send();
    }
    if (url.pathname === '/api/providers') return json(route, { teams: [{ ...STATS, teamId: ID, team: TEAM.name, members: STATS.publishedProfiles, memberCount: TEAM.memberCount, logoUrl: TEAM.logoUrl, logoUpdatedAt: TEAM.logoUpdatedAt }], providers: [], history: { providers: [], points: [] }, insights: {} });
    if (url.pathname === '/api/leaderboard') return json(route, { leaderboard: [], kpis: {}, movers: {}, usageHistory: { providers: [], points: [] }, total: 0 });
    if (url.pathname === '/api/models/catalog') return json(route, { models: [{ id: 'openai/fixture', name: 'Fixture', provider: 'openai', inputPerM: 1, outputPerM: 3 }], providers: [], count: 1 });
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/user/')) { const handle = decodeURIComponent(url.pathname.split('/').pop()); return json(route, { ok: true, handle, entry: { handle, tokensAll: 100, tokensToday: 0, tokens7d: 10, costAll: 0, breakdown: { models: [], daily: [], modelHistory: [], sessions: [], projects: [] } }, rank: 1, ranks: {}, rankHistory: [] }); }
    if (url.pathname.startsWith('/api/')) return json(route, { error: 'Unexpected fixture endpoint' }, 404);
    const response = await worker.fetch(new Request(req.url(), { headers: { accept: req.headers().accept || 'text/html' } }), env);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  return { page, context, requests, ui, async close() { await context.close(); assert.deepEqual(errors, [], 'Team pages and dialogs do not throw browser errors'); assert.equal(requests.some(row => row.path === '/vendor/three.js'), false, 'Reduced motion never downloads Three.js'); } };
}

async function openTeam(f) {
  await f.page.goto(ORIGIN + '/t/' + ID, { waitUntil: 'domcontentloaded' });
  await f.page.locator('.tm-public-stats').waitFor();
  await f.page.waitForFunction(() => document.querySelector('[data-team-blackhole]')?.dataset.motionState === 'static');
}
async function ownerManager(f) {
  await f.page.waitForFunction(() => state.googleSession?.serverSession);
  await f.page.evaluate(() => openInviteFriends());
  await f.page.locator('dialog [data-ti-logo]').waitFor();
  await f.page.waitForFunction(() => !document.querySelector('dialog .ti-manager-body')?.hasAttribute('aria-busy'));
}
async function settled(page) { await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
const mutations = f => f.requests.filter(row => !['GET', 'HEAD'].includes(row.method));

async function assertSemanticSurface(page, selector, label) {
  const palette = await page.locator(selector).evaluate(scope => {
    const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--th-surface)'; scope.append(probe);
    const expected = getComputedStyle(probe).backgroundColor; probe.remove();
    const background = getComputedStyle(scope).backgroundColor;
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const effectiveBackground = node => {
      while (node) {
        const color = getComputedStyle(node).backgroundColor, channels = rgb(color);
        if (channels.length === 3 || channels[3] > .99) return channels.slice(0, 3);
        node = node.parentElement;
      }
      return rgb(background).slice(0, 3);
    };
    const luminance = channels => channels.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, index) => sum + c * [.2126, .7152, .0722][index], 0);
    const labels = [...scope.querySelectorAll('h1,h2,h3,p,summary,strong,small,button,label,input,time,.ti-privacy-note,.ti-crew-line>span,.ti-invite-meta>span')].filter(node => (node.textContent.trim() || node.value) && getComputedStyle(node).display !== 'none' && !node.disabled && node.type !== 'file').map(node => {
      const foreground = rgb(getComputedStyle(node).color).slice(0, 3), back = effectiveBackground(node);
      const a = luminance(foreground), b = luminance(back);
      return { text: (node.textContent.trim() || node.value).slice(0, 70), foreground, background: back, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
    return { expected, background, labels };
  });
  assert.equal(palette.background, palette.expected, `${label} uses the actual semantic surface after lazy styles load`);
  assert(palette.labels.length > 5, `${label} covers multiple real headings, controls and supporting labels`);
  for (const item of palette.labels) assert(item.contrast >= 4.5, `${label} label fails AA contrast: ${JSON.stringify(item)}`);
}

async function sourceImage(page, format = 'png', landscape = false) {
  const result = await page.evaluate(({ format, landscape }) => {
    const canvas = document.createElement('canvas'); canvas.width = landscape ? 192 : 48; canvas.height = 48;
    const context = canvas.getContext('2d'); context.fillStyle = '#ed554e'; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/' + format);
  }, { format, landscape });
  return { name: `fixture.${format}`, mimeType: `image/${format}`, buffer: Buffer.from(result.split(',')[1], 'base64') };
}
async function inspectNormalized(page, source) {
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3] > 250) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
    return { width: canvas.width, height: canvas.height, minX, maxX, minY, maxY, center: [...data.slice(center, center + 4)] };
  }, source);
}

try {
  console.log('Team flow: crawler metadata and public data load independently of sign-in and community rankings…');
  {
    const f = await fixture({ holdTeam: true, holdSession: true, signedIn: 'owner' });
    await f.page.goto(ORIGIN + '/t/' + ID, { waitUntil: 'domcontentloaded' });
    await f.page.waitForFunction(() => document.querySelector('meta[property="og:title"]')?.content.includes('18 members'));
    assert.match(await f.page.title(), /18 members/);
    assert.equal(await f.page.locator('link[rel="canonical"]').getAttribute('href'), TEAM.url);
    assert.match(await f.page.locator('meta[property="og:image"]').getAttribute('content'), new RegExp('/api/og/team/' + ID + '\\.png\\?v=team-horizon-'));
    assert.match(await f.page.locator('meta[property="og:image:alt"]').getAttribute('content'), /custom team icon/);
    await f.page.waitForFunction(() => document.querySelector('.tm-loading-label'));
    assert(f.ui.teamReply, 'Team read is independently in flight');
    await f.ui.teamReply();
    await f.page.locator('.tm-public-stats').waitFor();
    assert.deepEqual(await f.page.locator('.tm-public-stats dd').allTextContents(), ['18', '3', '12.0M', '2']);
    assert.equal(f.requests.some(row => row.path === '/api/leaderboard'), false);
    assert.equal(mutations(f).length, 0, 'Visiting a profile never joins, creates, uploads, or revokes');
    await f.ui.sessionReply();
    await f.page.locator('[data-team-manage]').waitFor();
    assert.equal(await f.page.locator('.tm-team-icon img').getAttribute('src'), ORIGIN + TEAM.logoUrl);
    assert.equal(await f.page.locator('.tm-team-icon img').evaluate(node => getComputedStyle(node).objectFit), 'contain');
    assert.match(await f.page.locator('meta[property="og:description"]').getAttribute('content'), /18 members/);
    await f.close();
  }

  console.log('Team flow: provider/profile links and public sharing preserve canonical team identity…');
  {
    const f = await fixture(); await openTeam(f);
    assert.equal(await f.page.locator('[data-handle-link]').count(), 3);
    assert.equal(await f.page.locator('[data-team-provider]').count(), 2);
    const provider = f.page.locator('[data-team-provider-catalog] a');
    assert.match(await provider.getAttribute('href'), /provider=openai/);
    await f.page.locator('.tm-share-panel summary').click();
    assert.equal(await f.page.locator('#tm-share-link').inputValue(), TEAM.url);
    assert.match(await f.page.locator('.tm-share-body>img').getAttribute('alt'), /member count, team icon and published token usage/);
    await f.page.locator('[data-team-copy-public]').click();
    assert.deepEqual(await f.page.evaluate(() => window.testCopied), [TEAM.url]);
    await f.page.locator('[data-team-native-share]').click();
    assert.equal(await f.page.evaluate(() => window.testShared.url), TEAM.url);
    assert.equal(mutations(f).length, 0, 'Copying public links cannot mutate membership');
    await f.page.locator('[data-handle-link="pilot"]').click();
    await f.page.waitForFunction(() => state.view === 'players' && state.currentHandle === 'pilot');
    assert.match(f.page.url(), /\/u\/pilot$/);
    await f.close();
  }
  {
    const f = await fixture({ deniedClipboard: true }); await openTeam(f);
    await f.page.locator('.tm-share-panel summary').click(); await f.page.locator('[data-team-copy-public]').click();
    assert.match(await f.page.locator('.tm-share-status').innerText(), /Select and copy/);
    const selection = await f.page.locator('#tm-share-link').evaluate(node => ({ active: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd, length: node.value.length }));
    assert(selection.active && selection.start === 0 && selection.end === selection.length, 'Denied clipboard selects the full public URL for manual copy');
    await f.close();
  }

  console.log('Team flow: public landing, share disclosure and icon manager fit mobile in both palettes…');
  for (const width of screenshots ? [320, 390, 1440] : [320, 390]) for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ width, colorScheme, signedIn: 'owner' }); await openTeam(f);
    await f.page.locator('.tm-share-panel summary').click(); await settled(f.page);
    assert.equal(await f.page.evaluate(() => document.documentElement.dataset.theme), colorScheme);
    const overflow = await f.page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, hero: document.querySelector('.tm-orbit-hero').getBoundingClientRect().right, share: document.querySelector('.tm-share-body').scrollWidth, shareWidth: document.querySelector('.tm-share-body').clientWidth }));
    assert(overflow.document <= width + 1 && overflow.hero <= width + 1 && overflow.share <= overflow.shareWidth + 1, `${width}px ${colorScheme} public team/share overflow: ${JSON.stringify(overflow)}`);
    if (screenshots && width !== 320) await f.page.screenshot({ path: `/tmp/th-team-flow-page-${width}-${colorScheme}.png` });
    await ownerManager(f); await f.page.locator('.ti-team-share summary').click(); await settled(f.page);
    await assertSemanticSurface(f.page, '.ti-manager-content', `${width}px ${colorScheme} manager`);
    const dialog = await f.page.locator('dialog').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }));
    assert(dialog.scrollWidth <= dialog.width + 1 && dialog.right <= width + 1 && dialog.left >= -1, `${width}px ${colorScheme} team manager overflow: ${JSON.stringify(dialog)}`);
    if (screenshots && width !== 320) { await f.page.locator('.ti-logo-editor').scrollIntoViewIfNeeded(); await f.page.screenshot({ path: `/tmp/th-team-flow-manager-${width}-${colorScheme}.png` }); }
    await f.close();
  }

  console.log('Team flow: owner uploads PNG/WebP through bounded PNG normalization, preserving square and landscape marks…');
  {
    const f = await fixture({ signedIn: 'owner' }); await openTeam(f); await ownerManager(f);
    const oldPreview = await f.page.locator('.ti-team-share-preview').getAttribute('src');
    for (const [format, landscape] of [['png', false], ['png', true], ['webp', true]]) {
      const file = await sourceImage(f.page, format, landscape);
      const post = f.page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/logo' && req.method() === 'POST');
      await f.page.locator('[data-ti-logo]').setInputFiles(file); await post;
      await f.page.waitForFunction(() => !document.querySelector('dialog .ti-manager-body')?.hasAttribute('aria-busy'));
      assert.equal(f.ui.upload.body.teamId, ID, 'Every icon write is bound to the manager’s team identity');
      assert.match(f.ui.upload.body.image, /^data:image\/png;base64,/);
      const decoded = await inspectNormalized(f.page, f.ui.upload.body.image);
      assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
      assert(decoded.center[0] >= 230 && decoded.center[1] >= 75 && decoded.center[2] >= 65, 'Actual source mark remains visible after browser encoding');
      assert(Math.abs((decoded.minX + decoded.maxX + 1) / 2 - 256) <= 1 && Math.abs((decoded.minY + decoded.maxY + 1) / 2 - 256) <= 1, 'Source pixel bounds are centered in the square');
      const ratio = (decoded.maxX - decoded.minX + 1) / (decoded.maxY - decoded.minY + 1);
      assert(Math.abs(ratio - (landscape ? 4 : 1)) < .05, `Actual logo aspect ratio is preserved: ${ratio}`);
      assert.equal(await f.page.locator('.ti-logo-preview img').evaluate(node => getComputedStyle(node).objectFit), 'contain');
    }
    assert.notEqual(await f.page.locator('.ti-team-share-preview').getAttribute('src'), oldPreview, 'Uploaded icon advances the public OG preview revision');
    const post = f.page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/logo' && req.method() === 'POST');
    await f.page.locator('[data-ti-logo-clear]').click(); await post;
    await f.page.locator('.ti-logo-preview .ti-team-monogram').waitFor();
    assert.deepEqual(f.ui.upload.body, { teamId: ID, clear: true });
    assert.equal(await f.page.locator('[data-ti-logo-clear]').count(), 0);
    await f.close();
  }

  console.log('Team flow: refreshing the same account session keeps its open manager usable…');
  {
    const f = await fixture({ signedIn: 'owner' }); await openTeam(f); await ownerManager(f);
    await f.page.evaluate(() => setGoogleSession({ ...state.googleSession }));
    const file = await sourceImage(f.page);
    const post = f.page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/logo' && req.method() === 'POST');
    await f.page.locator('[data-ti-logo]').setInputFiles(file); await post;
    await f.page.waitForFunction(() => !document.querySelector('dialog .ti-manager-body')?.hasAttribute('aria-busy'));
    assert.equal(f.ui.upload.body.teamId, ID);
    assert.match(await f.page.locator('dialog').innerText(), /InterstellarObservability/);
    await f.close();
  }

  console.log('Team flow: rejected files preserve current icon and do not start an upload…');
  {
    const f = await fixture({ signedIn: 'owner' }); await openTeam(f); await ownerManager(f);
    const before = await f.page.locator('.ti-logo-preview img').getAttribute('src');
    for (const [file, error] of [[{ name: 'hostile.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, 'Choose a PNG'], [{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') }, 'couldn’t be opened'], [{ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) }, 'smaller than 8 MB']]) {
      await f.page.locator('[data-ti-logo]').setInputFiles(file);
      await f.page.waitForFunction(error => document.querySelector('dialog .ti-error[role="alert"]')?.textContent.includes(error), error);
      assert.equal(f.requests.some(row => row.path === '/api/team/logo'), false);
      assert.equal(await f.page.locator('.ti-logo-preview img').getAttribute('src'), before);
    }
    assert.match(await f.page.locator('dialog .ti-error').innerText(), /smaller than 8 MB/);
    await f.close();
  }

  console.log('Team flow: account switching during image decode blocks the old upload before authentication is sent…');
  {
    const f = await fixture({ signedIn: 'owner' }); await openTeam(f); await ownerManager(f);
    const file = await sourceImage(f.page, 'png', true);
    await f.page.evaluate(() => {
      const original = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        if (!this.src.startsWith('blob:')) return original.call(this);
        return original.call(this).then(() => new Promise(resolve => { window.testDecodeRelease = resolve; window.testDecodeHeld = true; }));
      };
    });
    await f.page.locator('[data-ti-logo]').setInputFiles(file);
    await f.page.waitForFunction(() => window.testDecodeHeld);
    f.ui.subject = 'other'; f.ui.team = { ...TEAM, id: OTHER_ID, name: 'Another Crew', logoUrl: '', role: 'owner' };
    await f.page.evaluate(user => setGoogleSession({ ...user, serverSession: true, expiresAt: Date.now() + 86400000 }), identity('other'));
    await ownerManager(f);
    await f.page.evaluate(() => window.testDecodeRelease());
    await settled(f.page);
    assert.equal(f.requests.some(row => row.path === '/api/team/logo'), false, 'Old file cannot authenticate using the new account');
    assert.match(await f.page.locator('dialog').innerText(), /Another Crew/);
    assert.equal(await f.page.locator('.ti-logo-preview img').count(), 0);
    await f.close();
  }
  console.log('Team flow: a delayed upload response cannot repaint or refresh another account’s manager…');
  {
    const f = await fixture({ signedIn: 'owner', holdUpload: true }); await openTeam(f); await ownerManager(f);
    const file = await sourceImage(f.page);
    const post = f.page.waitForRequest(req => new URL(req.url()).pathname === '/api/team/logo' && req.method() === 'POST');
    await f.page.locator('[data-ti-logo]').setInputFiles(file); await post;
    await f.page.waitForFunction(() => document.querySelector('dialog .ti-manager-body')?.hasAttribute('aria-busy'));
    assert(f.ui.uploadReply, 'The upload response is deliberately held');
    f.ui.subject = 'other'; f.ui.team = { ...TEAM, id: OTHER_ID, name: 'Another Crew', logoUrl: '', role: 'owner' };
    await f.page.evaluate(user => setGoogleSession({ ...user, serverSession: true, expiresAt: Date.now() + 86400000 }), identity('other'));
    await ownerManager(f);
    const reads = f.requests.filter(row => row.path === '/api/account/team').length;
    await f.ui.uploadReply(); await settled(f.page);
    assert.match(await f.page.locator('dialog').innerText(), /Another Crew/);
    assert.equal(await f.page.locator('.ti-logo-preview img').count(), 0);
    assert.equal(f.requests.filter(row => row.path === '/api/account/team').length, reads, 'Stale upload does not read or invalidate the new account');
    await f.close();
  }

  console.log('Team flow: invite arrival keeps custom identity and reduced-motion artwork without loading Three.js…');
  for (const [width, colorScheme] of screenshots ? [[320, 'dark'], [1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']] : [[320, 'dark']]) {
    const f = await fixture({ width, colorScheme });
    await f.page.goto(ORIGIN + '/invite/' + TOKEN, { waitUntil: 'domcontentloaded' });
    await f.page.locator('[data-ti-join]').waitFor();
    await f.page.waitForFunction(() => document.querySelector('[data-team-blackhole]')?.dataset.motionState === 'static');
    assert.equal(await f.page.locator('.ti-arrival-icon img').getAttribute('src'), TEAM.logoUrl);
    assert.equal(await f.page.locator('.ti-arrival-icon img').evaluate(node => getComputedStyle(node).objectFit), 'contain');
    assert.equal(await f.page.locator('.th-team-hole-provider').count(), 6);
    assert.equal(f.requests.some(row => row.path === '/vendor/three.js'), false, 'Reduced motion does not download the heavy runtime');
    assert.equal(await f.page.locator('[data-team-blackhole] canvas').count(), 0);
    assert.equal(mutations(f).length, 0, 'Invite arrival remains a public read until deliberate acceptance');
    await settled(f.page);
    await assertSemanticSurface(f.page, '.ti-invite-content', `${width}px ${colorScheme} invite`);
    assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Invite identity and artwork fit a 320px screen');
    if (screenshots && width !== 320) await f.page.screenshot({ path: `/tmp/th-team-flow-invite-${width}-${colorScheme}.png` });
    await f.close();
  }
  console.log('Team flow UI checks passed.');
} finally { await browser.close(); }
