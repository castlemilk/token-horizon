import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from '../cloudflare/node_modules/miniflare/dist/src/index.js';

// Exercise native Worker fetch, rather than a Node mock that accepts request
// options unsupported by workerd. Every outbound request stays in this process.
const config = await readFile(new URL('../cloudflare/wrangler.toml', import.meta.url), 'utf8');
const compatibilityDate = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(config)?.[1];
const flags = /^compatibility_flags\s*=\s*(\[[^\n]+\])/m.exec(config)?.[1];
assert.ok(compatibilityDate && flags, 'Use the deployed Worker compatibility configuration');
const compatibilityFlags = JSON.parse(flags);
const source = await readFile(new URL('../cloudflare/src/og-avatar.js', import.meta.url), 'utf8');
const loaderSource = source.replace(/^export (?=(?:async )?function (?:loadOgAvatar|validatedRasterDataUri)\b)/gm, '');
assert.notEqual(loaderSource, source, 'Embed the actual exported avatar loader');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCbkAAAAASUVORK5CYII=', 'base64'));
const expectedPhoto = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const outbound = [];

const mf = new Miniflare(convertV4MiniflareOptions({
  compatibilityDate,
  compatibilityFlags,
  modules: true,
  script: `
    const loadOgAvatar = (() => { ${loaderSource}; return loadOgAvatar; })();
    export default {
      async fetch(request, env) {
        const path = new URL(request.url).pathname;
        const entry = { handle: 'orbit_builder', avatarUrl: 'https://images.example.com' + (path === '/redirect' ? '/redirect' : '/photo.png') };
        const photo = await loadOgAvatar(entry, env, { anonymize: path === '/anonymous' });
        return Response.json({ photo });
      }
    };
  `,
  outboundService: async request => {
    const url = new URL(request.url);
    outbound.push({ path: url.pathname, authorization: request.headers.get('Authorization'), cookie: request.headers.get('Cookie') });
    assert.equal(url.hostname, 'images.example.com', 'All photo I/O uses the hermetic outbound fixture');
    if (url.pathname === '/redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://images.example.com/followed' } });
    }
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  }
}));

try {
  const read = async path => {
    const response = await mf.dispatchFetch(`https://worker.test${path}`);
    assert.equal(response.status, 200);
    return (await response.json()).photo;
  };
  assert.equal(await read('/anonymous'), '', 'Anonymous sharing has no photo');
  assert.equal(outbound.length, 0, 'Anonymous sharing performs no outbound photo I/O');
  assert.equal(await read('/photo'), expectedPhoto, 'Native Worker fetch embeds the available profile photo');
  assert.equal(outbound.length, 1);
  assert.equal(await read('/redirect'), '', 'A redirect safely falls back without loading a photo');
  assert.deepEqual(outbound.map(request => request.path), ['/photo.png', '/redirect'], 'The Worker never follows the redirect');
  assert.ok(outbound.every(request => request.authorization === null && request.cookie === null), 'Photo subrequests carry no authentication or cookies');
  console.log('OG avatar workerd: 3 checks passed (public photo, manual redirect, anonymous privacy).');
} finally {
  await mf.dispose();
}
