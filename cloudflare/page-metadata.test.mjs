import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.js';
import { connectPage, pageHeaders } from './src/connect-page.js';

const origin = 'https://token-horizon.dev';
const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="/old/">
<title>Old collection</title><meta data-th-seo name="description" content="Old description">
<link data-th-seo rel="canonical" href="${origin}/leaderboard">
<meta data-th-seo property="og:title" content="Old collection"><meta data-th-seo property="og:image" content="old.png">
<meta name="twitter:card" content="summary"><meta name="robots" content="index, follow">
<script type="application/ld+json" id="th-seo-schema">{"name":"Old collection"}</script>
<link rel="icon" href="./assets/favicon.svg?v=20261001-2">
<script>window.preloadPublicData=true;</script></head><body><div id="view">Application shell</div></body></html>`;

function environment(entries = null) {
  const requests = [];
  let reads = 0;
  const store = new Map(entries === null ? [] : [['leaderboard.json', JSON.stringify(entries)]]);
  return { requests, get reads() { return reads; },
    env: {
      ASSETS: { async fetch(request) { requests.push(request); return new Response(shell, { headers: {
        'Content-Type': 'text/html;charset=utf-8', ETag: '"unmodified-shell"',
        'Last-Modified': 'Wed, 30 Sep 2026 00:00:00 GMT', 'Content-Length': String(shell.length),
        'Content-Encoding': 'gzip', 'Accept-Ranges': 'bytes', Vary: 'Accept-Encoding'
      } }); } },
      LEADERBOARD_BUCKET: { async get(key) { reads++; if (entries === null) throw new Error('Static metadata must never read usage storage');
        return store.has(key) ? { text: async () => store.get(key), json: async () => JSON.parse(store.get(key)) } : null; },
        async put(key, value) { store.set(key, value); } }
    }
  };
}
const get = (env, path, init = {}) => worker.fetch(new Request(origin + path, { headers: { Accept: 'text/html' }, ...init }), env);
const metaValue = (html, name) => html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)="${name}")[^>]*content="([^"]*)"`, 'i'))?.[1];
const canonical = html => html.match(/<link\b(?=[^>]*rel="canonical")[^>]*href="([^"]*)"/i)?.[1];
const schema = html => JSON.parse(html.match(/<script\b(?=[^>]*id="th-seo-schema")[^>]*>([\s\S]*?)<\/script>/i)?.[1] || 'null');

describe('Server page metadata', () => {
  it('unfurls model collections and tabs without fetching usage or the catalog', async () => {
    const f = environment();
    for (const [path, expected, title] of [
      ['/models?provider=openai&model=openai%2Fgpt-5&utm_source=share', '/models', 'AI Model Explorer'],
      ['/models?tab=cheapest', '/models?tab=cheapest', 'Compare AI Model Prices'],
      ['/models?tab=providers', '/models?tab=providers', 'AI Model Providers'],
      ['/models?tab=plans&plan=example', '/models?tab=plans', 'AI Subscription Plans'],
      ['/leaderboard?view=models&tab=plans', '/models?tab=plans', 'AI Subscription Plans'],
      ['/?view=models&tab=cheapest', '/models?tab=cheapest', 'Compare AI Model Prices']
    ]) {
      const response = await get(f.env, path), html = await response.text();
      assert.equal(response.status, 200, path);
      assert.equal(canonical(html), origin + expected, path);
      assert.ok(metaValue(html, 'og:title').startsWith(title), path);
      assert.match(metaValue(html, 'og:image'), /\/assets\/og-models\.png\?v=20261001-2$/);
      assert.equal(metaValue(html, 'og:image:width'), '1200');
      assert.equal(metaValue(html, 'og:image:height'), '630');
      assert.equal(metaValue(html, 'twitter:card'), 'summary_large_image');
      assert.equal(schema(html)['@type'], 'CollectionPage');
      assert.equal(schema(html).url, origin + expected);
      assert.equal(new URL(f.requests.at(-1).url).pathname, '/leaderboard');
      assert.ok(!/Old collection|old\.png|Old description/.test(html));
      for (const key of ['ETag', 'Last-Modified', 'Content-Length', 'Content-Encoding', 'Accept-Ranges']) assert.equal(response.headers.get(key), null);
    }
    assert.equal(f.reads, 0);
    assert.equal(f.requests.length, 6, 'Only one static document fetch per route');
  });

  it('uses one canonical and schema, keeps charset early and preserves startup scripts', async () => {
    const f = environment(), response = await get(f.env, '/leaderboard?period=week&team=Example');
    const html = await response.text();
    assert.equal(canonical(html), origin + '/leaderboard');
    assert.match(metaValue(html, 'og:title'), /AI Usage Leaderboard/);
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
    assert.equal((html.match(/property="og:image"/g) || []).length, 1);
    assert.equal((html.match(/id="th-seo-schema"/g) || []).length, 1);
    assert.equal((html.match(/<base /g) || []).length, 1);
    assert.ok(html.indexOf('<meta charset="utf-8">') < 1024);
    assert.ok(html.includes('<script>window.preloadPublicData=true;</script>'));
    assert.ok(html.includes('./assets/favicon.svg?v=20261001-2'));
    assert.equal(response.headers.get('Vary'), 'Accept-Encoding, Accept');
  });

  it('keeps auth and account shells out of search without leaking tokens or inherited schema', async () => {
    const f = environment();
    for (const path of ['/login?returnTo=/u/me', '/leaderboard?view=dashboard', '/leaderboard?view=billing',
      '/leaderboard?view=settings', '/?signin=1', '/leaderboard?share=secret-report',
      '/invite/secret-invite', '/?invite=secret-invite', '/models?signin=1', '/?view=models&share=secret-report',
      '/models?view=billing', '/models?view=dashboard', '/models?view=settings',
      '/leaderboard?view=dashboard&user=public_builder', '/u/public_builder?view=settings',
      '/?user=public_builder&view=dashboard']) {
      const response = await get(f.env, path), html = await response.text();
      assert.match(metaValue(html, 'robots'), /noindex/);
      assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
      assert.equal(schema(html), null);
      assert.doesNotMatch(html, /secret-report|secret-invite|Old collection|old\.png/);
      assert.match(metaValue(html, 'og:image'), /\/assets\/og-(login|workspace|leaderboard)\.png/);
      if (path.startsWith('/login')) assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=600');
      if (/view=(dashboard|billing|settings)|share=|\/invite\//.test(path)) assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    }
    assert.equal(f.reads, 0);
  });

  it('HEAD transforms a full anonymous asset and drops invalid conditional and account headers', async () => {
    const f = environment();
    for (const path of ['/models?tab=plans', '/leaderboard', '/login', '/invite/private']) {
      const response = await get(f.env, path, { method: 'HEAD', headers: {
        Accept: 'text/html', Cookie: '__Host-th-session=secret', Authorization: 'Bearer secret',
        'X-Google-Token': 'secret', 'If-None-Match': '"unmodified-shell"',
        'If-Modified-Since': 'Wed, 30 Sep 2026 00:00:00 GMT', Range: 'bytes=0-100'
      } });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
      assert.equal(f.requests.at(-1).method, 'GET');
      for (const name of ['Cookie', 'Authorization', 'X-Google-Token', 'If-None-Match', 'If-Modified-Since', 'Range']) assert.equal(f.requests.at(-1).headers.get(name), null);
    }
  });

  it('document rewrites reject unsupported methods before requesting the static shell', async () => {
    const f = environment();
    for (const path of ['/models', '/?view=models', '/invite/private']) {
      const response = await get(f.env, path, { method: 'POST', body: 'unsupported' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
    }
    assert.equal(f.requests.length, 0);
  });

  it('public profiles keep their dynamic card and anonymous public schema; missing profiles are noindex', async () => {
    const f = environment([{ handle: 'public_builder', tokensAll: 123456, tokensToday: 1200,
      ownerId: 'SecretOwner', googleEmail: 'secret@example.com', claimed: true, team: 'Public Crew', streakDays: 3 }]);
    const response = await get(f.env, '/u/public_builder?utm_source=share'), html = await response.text();
    assert.match(metaValue(html, 'og:image'), /\/api\/og\/profile\/public_builder\.png\?v=horizon-/);
    assert.equal(canonical(html), origin + '/u/public_builder');
    assert.equal(schema(html)['@type'], 'ProfilePage');
    assert.equal(schema(html).mainEntity.name, '@public_builder');
    assert.doesNotMatch(html, /SecretOwner|secret@example\.com|Old collection/);
    const missing = await get(f.env, '/u/nobody'), missingHtml = await missing.text();
    assert.equal(missing.status, 200, 'SPA still renders its not-found state');
    assert.match(metaValue(missingHtml, 'robots'), /noindex/);
    assert.equal(schema(missingHtml), null);
    assert.equal(metaValue(missingHtml, 'og:image'), undefined);
  });

  it('connector and authorization heads are private, branded and never echo transaction IDs', () => {
    for (const mode of ['connect', 'authorize']) {
      const html = connectPage({ mode, handle: 'secret-nonce', clientName: 'Sample client' });
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(metaValue(head, 'robots'), /noindex/);
      assert.equal(canonical(head), origin + (mode === 'authorize' ? '/oauth/authorize' : '/connect'));
      assert.match(metaValue(head, 'og:image'), /og-connect\.png\?v=20261001-2/);
      assert.ok(head.includes('favicon-48x48.png?v=20261001-2'));
      assert.ok(head.includes('site.webmanifest?v=20261001-2'));
      assert.doesNotMatch(head, /secret-nonce|Sample client|th-seo-schema/);
    }
    assert.match(pageHeaders().get('X-Robots-Tag'), /noindex/);
    assert.equal(pageHeaders().get('Cache-Control'), 'no-store');
  });

  it('keeps profile and shared-report URLs canonical on Worker preview aliases in HTML, JSON and text', async () => {
    const preview = 'https://token-horizon-leaderboard.preview.workers.dev';
    const f = environment([{ handle: 'public_builder', tokensAll: 123456, tokensToday: 1200, streakDays: 3 }]);
    await f.env.LEADERBOARD_BUCKET.put('shares/public123.json', JSON.stringify({ id: 'public123', handle: 'public_builder', scope: 'public', publicLink: true, options: {} }));
    await f.env.LEADERBOARD_BUCKET.put('shares/private123.json', JSON.stringify({ id: 'private123', handle: 'public_builder', scope: 'private', options: {} }));
    for (const path of ['/u/public_builder', '/s/public123', '/s/private123']) {
      const html = await (await worker.fetch(new Request(preview + path, { headers: { Accept: 'text/html' } }), f.env)).text();
      assert.equal(canonical(html), origin + path);
      assert.equal(metaValue(html, 'og:url'), origin + path);
      assert.ok(metaValue(html, 'og:image').startsWith(preview + '/api/og/'), 'Preview image keeps its own serving host');
      const data = await (await worker.fetch(new Request(preview + path + '?format=json'), f.env)).json();
      assert.equal(data.url, origin + path);
      assert.ok(data.image.startsWith(preview + '/api/og/'));
      const text = await (await worker.fetch(new Request(preview + path + '?format=text'), f.env)).text();
      assert.doesNotMatch(text, /preview\.workers\.dev/);
      if (path !== '/s/private123') assert.match(text, /token-horizon\.dev\/u\/public_builder/);
    }
  });

  it('public JSON can hydrate crawled pages without indexing raw API documents', async () => {
    const f = environment([]);
    const response = await get(f.env, '/api/leaderboard');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.match(response.headers.get('Content-Type'), /application\/json/);
  });
});
