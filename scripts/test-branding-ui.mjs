import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveChromium } from './playwright.mjs';

// Real UI and committed images, synthetic publications only. Route interception
// keeps provider access, production, and account mutations out of these checks.
const origin = 'https://token-horizon.dev', docsRoot = path.resolve('docs');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const catalogSources = JSON.parse(await fs.readFile(path.join(docsRoot, 'assets/brands/catalog-sources.json'), 'utf8'));
const catalogGroups = ['cloudflare', 'vercel', 'github', 'groq', 'huggingface', 'microsoft', 'azure', 'aws', 'cohere', 'nvidia', 'togetherai', 'fireworksai', 'deepinfra', 'perplexity'];
assert.deepEqual(Object.keys(catalogSources.providers).sort(), [...catalogGroups].sort(), 'Every official catalog provider group has a rendered fixture');
const aliasGroups = {
  cloudflare: ['cloudflare-workers-ai', 'cloudflare-ai-gateway', 'Cloudflare Workers AI'],
  vercel: ['v0'], github: ['github-copilot', 'GitHub Copilot'],
  aws: ['amazon', 'amazon-bedrock', 'bedrock', 'AWS'],
  azure: ['azure-cognitive-services', 'Azure cognitive services'],
  togetherai: ['together', 'together-ai'], fireworksai: ['fireworks', 'fireworks-ai'],
  huggingface: ['hugging-face', 'Hugging Face']
};
const providerCases = [
  { provider: 'OpenRouter', model: 'claude-branding', name: 'A OpenRouter Claude', key: 'openrouter', asset: 'openrouter.svg' },
  { provider: 'opencode-go', model: 'gpt-branding', name: 'B OpenCode GPT', key: 'opencode', asset: 'opencode.svg' },
  { provider: 'Ollama', model: 'qwen-branding', name: 'C Ollama Qwen', key: 'ollama', asset: 'ollama.svg', local: true },
  { provider: 'mlx', model: 'llama-branding', name: 'D MLX Llama', key: 'mlx', asset: 'mlx.svg', local: true },
  { provider: 'xai', model: 'grok-branding', name: 'E xAI Grok', key: 'xai', asset: 'xai.svg' },
  { provider: '', model: 'claude-inferred', name: 'F Inferred Anthropic', key: 'anthropic', asset: 'anthropic.svg' },
  { provider: 'unknown', model: 'gpt-inferred', name: 'G Inferred OpenAI', key: 'openai', asset: 'openai.svg' },
  { provider: 'other', model: 'gemini-inferred', name: 'H Inferred Google', key: 'google', asset: 'google.png' },
  { provider: 'future-gateway', model: 'claude-custom', name: 'I Custom Gateway Claude', neutral: true },
  { provider: 'kimi', model: 'kimi-branding', name: 'J Kimi', key: 'kimi', asset: 'kimi.ico' },
  { provider: 'hf', model: 'claude-ambiguous-initials', name: 'K Ambiguous HF', neutral: true },
  { provider: 'constructor', model: 'claude-inherited-constructor', name: 'K Constructor Provider', neutral: true },
  { provider: '__proto__', model: 'claude-inherited-prototype', name: 'K Prototype Provider', neutral: true },
  ...[
    ['alibaba', 'alibaba.svg'], ['zhipu', 'zhipu.svg'], ['agy', 'agy.png'], ['upstage', 'upstage.avif'],
    ['deepseek', 'deepseek.svg'], ['meta', 'meta.svg'], ['mistral', 'mistral.svg'], ['minimax', 'minimax.svg'], ['qwen', 'qwen.svg']
  ].map(([key, asset]) => ({ provider: key, model: 'claude-explicit-' + key, name: 'L Core ' + key, key, asset })),
  ...catalogGroups.flatMap(key => [key, ...(aliasGroups[key] || [])].map((provider, index) => ({
    provider, model: 'claude-platform-' + key + '-' + index,
    name: 'Platform ' + key + ' ' + index, key, asset: catalogSources.providers[key].file
  })))
].map((value, index) => ({ ...value, id: (value.provider || 'unreported').toLowerCase() + '/' + value.model, index }));
const publishedModels = providerCases.filter(value => value.key && value.provider && !['other', 'unknown'].includes(value.provider)).map(value => ({ provider: value.provider, model: value.model, tokensAll: 1000, tokensToday: 100, requests: 5, costAll: .1 }));
const entry = {
  id: 'fixture:aurora', handle: 'aurora', team: 'Orbit Studio', tokensAll: 10000, tokens7d: 3000,
  tokensToday: 600, requestsAll: 30, updatedAt: Date.now() / 1000, league: 'grandmaster', division: 1,
  breakdown: { models: publishedModels, projects: [], sessions: [], daily: [], modelHistory: [] }
};
const standings = [
  { handle: 'aurora', league: 'grandmaster', division: 1 },
  { handle: 'sol', league: 'MASTER', division: 2 },
  { handle: 'unpublished', league: 'future-tier', division: 3 }
].map((value, index) => ({
  rank: index + 1, league: value.league, division: value.division, score: 600 - index * 100,
  scoreFormatted: String(600 - index * 100), relativePercent: 100 - index * 10,
  requestsFormatted: '30', costFormatted: '$0.30',
  entry: { ...entry, handle: value.handle, league: value.league, division: value.division }
}));
const catalog = { schemaVersion: 1, count: providerCases.length, providers: [], models: providerCases.map(value => ({
  id: value.id, name: value.name, provider: value.provider, providerName: value.provider || 'Not reported',
  isLocal: Boolean(value.local), contextK: 128, inputPerM: value.local ? null : 2,
  outputPerM: value.local ? null : 8, capabilities: { toolCall: true }
})) };
const browser = await (await resolveChromium()).launch({ channel: 'chrome', headless: true });

async function fixture({ width = 1440, failedAsset = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], unexpected = [], mutations = [], requests = [];
  let releaseAsset;
  const heldAsset = new Promise(resolve => { releaseAsset = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(url.pathname);
    // The landing page resolves published installers without contacting GitHub in this fixture.
    if (request.method() === 'GET' && request.url() === 'https://api.github.com/repos/castlemilk/token-horizon/releases?per_page=20') return json(route, []);
    if (url.origin === 'https://accounts.google.com') return route.abort();
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { mutations.push(url.pathname); return route.fulfill({ status: 405, body: '' }); }
    if (url.pathname === failedAsset) { await heldAsset; return route.abort(); }
    if (url.pathname === '/api/config') return json(route, { ok: true, googleClientId: '', googleAuth: false, githubAuth: false, webSessions: true, canonicalUrl: origin });
    if (url.pathname === '/api/auth/session') return json(route, { ok: true, authenticated: false, user: null });
    if (url.pathname === '/api/leaderboard') return json(route, { ok: true, period: 'today', leaderboard: standings, total: standings.length, kpis: {}, movers: {}, usageHistory: { providers: [], points: [] } });
    if (url.pathname.startsWith('/api/user/')) return json(route, { ok: true, handle: entry.handle, entry, rank: 1, total: 3, ranks: { all: 1 }, standing: { league: 'grandmaster', division: 1, mmr: 2900 }, rankHistory: [], achievements: [] });
    if (url.pathname === '/api/models/catalog' || url.pathname === '/data/models.json') return json(route, catalog);
    if (url.pathname === '/api/models/usage') return json(route, { ok: true, models: [] });
    if (url.pathname.startsWith('/api/')) return json(route, {});
    const relative = url.pathname === '/' ? 'index.html' : ['/leaderboard', '/leaderboard.html', '/models'].includes(url.pathname) || url.pathname.startsWith('/u/') ? 'leaderboard.html' : url.pathname.slice(1);
    const file = path.resolve(docsRoot, relative);
    if (!file.startsWith(docsRoot + path.sep)) return route.fulfill({ status: 404, body: '' });
    try {
      let body = await fs.readFile(file);
      if (relative === 'leaderboard.html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/" />'));
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, requests, releaseAsset, async close() {
    releaseAsset(); await context.close();
    assert.deepEqual(errors, [], 'Branding must not throw browser errors');
    assert.deepEqual(unexpected, [], 'Branding fixtures cannot contact other services');
    assert.deepEqual(mutations, [], 'Viewing branding must not mutate account or publication data');
  } };
}

async function settled(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function assertImage(locator, asset) {
  await locator.scrollIntoViewIfNeeded();
  await locator.waitFor({ state: 'visible' });
  const handle = await locator.elementHandle();
  try { await locator.page().waitForFunction(image => image.complete && image.naturalWidth > 0, handle, { timeout: 3000 }); }
  finally { await handle.dispose(); }
  assert.equal(await locator.evaluate(image => image.complete && image.naturalWidth > 0), true, 'Committed asset must load: ' + asset);
  const expected = '/assets/' + (asset.endsWith('.png') && ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'].some(key => asset === key + '.png') ? 'leagues/' : 'brands/') + asset;
  assert.equal(new URL(await locator.getAttribute('src'), origin + '/').pathname, expected, 'Brand revisions may change the query, not the asset identity');
}

async function footprint(locator) {
  return locator.evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; });
}

async function modelRow(page, value) {
  // Filtering mounts each real row even when the catalog exceeds the virtual
  // list's visible range. This exercises the resolver through the product UI.
  await page.locator('#mx-q').fill(value.name);
  await page.waitForFunction(query => mxState().query === query, value.name);
  await settled(page);
  const row = page.locator('.mx-row[data-mx-id="' + value.id + '"]');
  await row.waitFor({ state: 'visible' });
  return row;
}

async function noOverflow(page, width, description) {
  const size = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  assert.equal(size.viewport, width);
  assert(size.document <= width + 1, description + ' must fit ' + width + 'px, got ' + size.document + 'px');
}

try {
  console.log('League identity: default builder rows keep named shields on compact and desktop layouts...');
  {
    const f = await fixture();
    try {
      await f.page.goto(origin + '/leaderboard'); await f.page.waitForSelector('#lb-table [data-handle="aurora"] .builder-league');
      for (const width of [1440, 768, 390, 320]) {
        await f.page.setViewportSize({ width, height: 1100 }); await settled(f.page);
        const badge = f.page.locator('#lb-table [data-handle="aurora"] .builder-league');
        assert(await badge.isVisible(), 'The default builder cell shows league identity at ' + width + 'px');
        assert.match(await badge.innerText(), /Grandmaster\s+I/);
        const icon = badge.locator('.league-icon'), bounds = await icon.boundingBox();
        assert.equal(bounds.width, 26); assert.equal(bounds.height, 26);
        assert(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'The shield remains within the visible builder column at ' + width + 'px');
        await assertImage(icon.locator('img'), 'grandmaster.png');
        if ([390, 1440].includes(width)) {
          await f.page.waitForFunction(() => [...document.querySelectorAll('.league-icon img')].filter(image => image.getClientRects().length).every(image => image.complete && image.naturalWidth > 0));
          await f.page.screenshot({ path: width === 390 ? '/tmp/token-horizon-restored-shields-mobile.png' : '/tmp/token-horizon-restored-shields-desktop.png', animations: 'disabled' });
        }
      }
      const uppercase = f.page.locator('#lb-table [data-handle="sol"] .builder-league');
      assert.match(await uppercase.innerText(), /Master\s+II/); await assertImage(uppercase.locator('img'), 'master.png');
      const unknown = f.page.locator('#lb-table [data-handle="unpublished"] .builder-league');
      assert.match(await unknown.innerText(), /unpublished|not published/i);
      assert.doesNotMatch(await unknown.innerText(), /Bronze/i);
      assert.equal(await unknown.locator('img[src*="assets/leagues"]').count(), 0, 'An unknown tier cannot assert a real league');
      await f.page.locator('#community-metrics').click(); await f.page.waitForSelector('.community-table.more-metrics');
      const metricIcon = f.page.locator('#lb-table [data-handle="aurora"] .chip.league .league-icon');
      assert.equal((await metricIcon.boundingBox()).width, 17, 'Expanded metrics retain the full league column');
      assert.doesNotMatch(await f.page.locator('#lb-table [data-handle="unpublished"]').innerText(), /Bronze/i, 'Expanded metrics cannot invent a league for an unpublished tier');
      assert(await f.page.locator('#lb-table [data-handle="aurora"] .builder-league').isVisible());
      await f.page.locator('#community-metrics').click(); await f.page.waitForSelector('.community-table:not(.more-metrics)');
      assert(await f.page.locator('#lb-table [data-handle="aurora"] .builder-league').isVisible());
      for (const key of ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster']) {
        const tier = f.page.locator('.community-ladder [data-league="' + key + '"] .league-icon');
        await assertImage(tier.locator('img'), key + '.png');
        assert.deepEqual(await footprint(tier), { width: 44, height: 44 }, 'Ladder crests retain readable size: ' + key);
      }
    } finally { await f.close(); }
  }

  console.log('Provider identity: explicit gateways, subscriptions and local runners retain their branding across model families...');
  {
    const f = await fixture();
    try {
      await f.page.goto(origin + '/models'); await f.page.waitForSelector('#mx-rows .mx-row');
      for (const value of providerCases) {
        const row = await modelRow(f.page, value);
        const logo = row.locator('.prov-logo'); assert(await logo.isVisible(), value.name + ' has visible branding');
        if (value.key) assert.equal(await logo.getAttribute('data-provider'), value.key, 'Brand identity for ' + value.name);
        if (value.asset) await assertImage(logo.locator('img'), value.asset);
        else {
          assert.equal(await logo.locator('img').count(), 0, 'Unprovided official assets use neutral initials');
          assert((await logo.innerText()).trim().length > 0, 'Neutral branding must remain recognizable');
          assert.equal(await logo.locator('svg').count(), 0, 'Neutral branding cannot imitate an unrelated provider');
          assert.notEqual(await logo.getAttribute('data-provider'), 'anthropic');
          assert.notEqual(await logo.getAttribute('data-provider'), 'meta');
        }
      }
      await f.page.locator('#mx-q').fill('');
      await f.page.waitForFunction(() => mxState().query === ''); await settled(f.page);
      await f.page.locator('.mx-row[data-mx-id="' + providerCases[0].id + '"]').waitFor({ state: 'visible' });
      await f.page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#mx-scroll').scrollTop = 0; }); await settled(f.page);
      await f.page.waitForFunction(() => [...document.querySelectorAll('.mx-row .prov-logo img')].every(image => image.complete && image.naturalWidth > 0));
      await f.page.screenshot({ path: '/tmp/token-horizon-provider-logos.png', animations: 'disabled' });
    } finally { await f.close(); }
  }

  console.log('Profile identity: the league crest and raw provider inventory marks survive responsive layouts...');
  {
    const f = await fixture();
    try {
      await f.page.goto(origin + '/u/aurora'); await f.page.waitForSelector('#profile-shell');
      for (const width of [1440, 390]) {
        await f.page.setViewportSize({ width, height: 1100 }); await settled(f.page);
        const crest = f.page.locator('.profile-crest .league-icon'); await assertImage(crest.locator('img'), 'grandmaster.png');
        assert.deepEqual(await footprint(crest), width <= 480 ? { width: 88, height: 88 } : { width: 124, height: 124 });
        for (const [key, asset] of [['openrouter', 'openrouter.svg'], ['opencode', 'opencode.svg'], ['ollama', 'ollama.svg']]) {
          const image = f.page.locator('.profile-inventory .profile-model-provider .prov-logo[data-provider="' + key + '"] img');
          await assertImage(image, asset);
        }
        const mlx = f.page.locator('.profile-inventory .profile-model-provider .prov-logo[data-provider="mlx"]');
        assert(await mlx.isVisible(), 'MLX inventory retains the actual local runner identity');
        await assertImage(mlx.locator('img'), 'mlx.svg');
      }
    } finally { await f.close(); }
  }

  console.log('Landing identity: the tool strip and tour retain real product marks without horizontal overflow...');
  {
    const f = await fixture();
    const stripAssets = ['openai.svg', 'claude.png', 'gemini.svg', 'kimi.ico', 'ollama.svg'];
    const tourAssets = {
      Codex: 'openai.svg', Claude: 'claude.png', 'Claude Sonnet': 'claude.png',
      Kimi: 'kimi.ico', Ollama: 'ollama.svg', GPT: 'openai.svg', Gemini: 'gemini.svg', Qwen: 'qwen.svg'
    };
    try {
      await f.page.goto(origin + '/'); await f.page.waitForSelector('#tour-screen[data-scene="notch"]');
      // Phone widths swap the scene buttons for one native <select> control.
      const pickScene = async scene => {
        if (await f.page.locator('.scene-select').isVisible()) await f.page.locator('button[data-scene="' + scene + '"]').click();
        else await f.page.locator('#tour-feature').selectOption(scene);
        await f.page.waitForSelector('#tour-screen[data-scene="' + scene + '"]'); await settled(f.page);
      };
      for (const width of [320, 390, 768, 1142, 1440]) {
        await f.page.setViewportSize({ width, height: 1100 }); await settled(f.page);
        const strip = f.page.locator('.provider-strip');
        await strip.scrollIntoViewIfNeeded();
        assert.equal(await strip.locator('.tool-mark img').count(), stripAssets.length, 'Supported tools retain individual product marks');
        for (let index = 0; index < stripAssets.length; index++) {
          const mark = strip.locator('.tool-mark').nth(index), box = await mark.boundingBox();
          await assertImage(mark.locator('img'), stripAssets[index]);
          assert(box.x >= -1 && box.x + box.width <= width + 1, 'Tool marks remain within the page at ' + width + 'px');
          assert(box.width >= 20 && box.height >= 20, 'Strip marks retain a readable footprint');
        }
        await noOverflow(f.page, width, 'The supported tools strip');
        for (const scene of ['notch', 'widgets', 'dashboard', 'limits', 'local', 'traces', 'models']) {
          await pickScene(scene);
          const brands = f.page.locator('#tour-screen .product-brand');
          for (let index = 0; index < await brands.count(); index++) {
            const brand = brands.nth(index), label = (await brand.innerText()).trim();
            assert(tourAssets[label], 'Tour provider has a declared product identity: ' + label);
            await assertImage(brand.locator('img'), tourAssets[label]);
          }
          await noOverflow(f.page, width, 'The ' + scene + ' feature tour');
        }
        if ([390, 1440].includes(width)) {
          await pickScene('notch');
          await f.page.evaluate(() => window.scrollTo(0, 0));
          await f.page.screenshot({ path: width === 390 ? '/tmp/token-horizon-branding-landing-mobile.png' : '/tmp/token-horizon-branding-landing-desktop.png', animations: 'disabled' });
        }
      }
    } finally { await f.close(); }
  }

  console.log('Asset recovery: a failed image leaves stable footprints and an honest, visible fallback...');
  for (const kind of ['shield', 'provider', 'light-provider']) {
    const assetPath = kind === 'shield' ? '/assets/leagues/grandmaster.png' : '/assets/brands/' + (kind === 'provider' ? 'openrouter.svg' : 'google.png');
    const f = await fixture({ failedAsset: assetPath });
    try {
      const selector = kind === 'shield' ? '#lb-table [data-handle="aurora"] .builder-league .league-icon' : '.mx-row[data-mx-id="' + (kind === 'provider' ? 'openrouter/claude-branding' : 'other/gemini-inferred') + '"] .prov-logo';
      const requested = f.page.waitForRequest(request => new URL(request.url()).pathname === assetPath);
      await f.page.goto(origin + (kind === 'shield' ? '/leaderboard' : '/models'), { waitUntil: 'domcontentloaded' });
      if (kind !== 'shield') await modelRow(f.page, providerCases.find(value => value.id === (kind === 'provider' ? 'openrouter/claude-branding' : 'other/gemini-inferred')));
      const icon = f.page.locator(selector); await icon.waitFor({ state: 'visible' });
      const before = await footprint(icon); await requested;
      f.releaseAsset(); await f.page.waitForSelector(selector + '.fallback');
      assert.deepEqual(await footprint(icon), before, 'Image failure cannot shift the ' + kind + ' footprint');
      assert.equal(await icon.locator('img').isVisible(), false);
      if (kind === 'shield') {
        assert(await icon.locator('.league-fallback svg').isVisible(), 'A league image failure retains the league-colored shield');
      } else {
        assert((await icon.innerText()).trim().length > 0, 'A provider image failure shows readable initials');
        assert.equal(await icon.locator('svg').count(), 0, 'A provider failure cannot revive an invented brand imitation');
        assert.equal(await icon.getAttribute('data-provider'), kind === 'provider' ? 'openrouter' : 'google');
        if (kind === 'light-provider') {
          const contrast = await icon.evaluate(node => {
            const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
            const luminance = value => channels(value).reduce((total, channel, index) => total + channel * [.2126, .7152, .0722][index], 0);
            const background = luminance(getComputedStyle(node).backgroundColor);
            const foreground = luminance(getComputedStyle(node.querySelector('.glyph-text')).color);
            return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
          });
          assert(contrast >= 4.5, 'A failed image on a light brand tile keeps readable initials');
        }
      }
    } finally { await f.close(); }
  }
  console.log('Branding browser checks passed.');
} finally { await browser.close(); }
