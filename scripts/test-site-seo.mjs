import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import test from 'node:test';

// Validate the published artifacts themselves. No browser, network, production
// credentials or copy snapshots are needed to catch broken share/search layers.
const siteRoot = fileURLToPath(new URL('../docs/', import.meta.url));
const origin = 'https://token-horizon.dev';
const pages = [
  ['index.html', '/', 'SoftwareApplication'],
  ['leaderboard.html', '/leaderboard', 'CollectionPage'],
  ['models/index.html', '/models', 'CollectionPage'],
  ['docs/index.html', '/docs/', 'TechArticle'],
  ['blog/index.html', '/blog/', 'Blog'],
  ['blog/why-token-horizon.html', '/blog/why-token-horizon.html', 'BlogPosting'],
  ['blog/pricing-evidence.html', '/blog/pricing-evidence.html', 'BlogPosting'],
  ['connect/index.html', '/connect', null]
];
const files = new Map(await Promise.all(pages.map(async ([path]) => [path, await readFile(resolve(siteRoot, path), 'utf8')])));

function decodeEntities(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()];
    const hex = entity[1].toLowerCase() === 'x';
    return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function attributes(tag) {
  const result = {};
  for (const [, key, double, single, unquoted] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[key.toLowerCase()] = decodeEntities(double ?? single ?? unquoted);
  }
  return result;
}

function head(html, label) {
  const matches = [...html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/gi)];
  assert.equal(matches.length, 1, `${label}: one complete head`);
  const source = matches[0][1].replace(/<!--[\s\S]*?-->/g, '');
  const metas = [...source.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => attributes(tag));
  const links = [...source.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => attributes(tag));
  const titles = [...source.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  assert.equal(titles.length, 1, `${label}: one title`);
  const title = decodeEntities(titles[0][1]).trim();
  assert.ok(title.length >= 12 && title.includes('Token Horizon'), `${label}: recognizable title`);
  const meta = key => {
    const values = metas.filter(item => (item.name ?? item.property)?.toLowerCase() === key);
    assert.equal(values.length, 1, `${label}: one ${key} tag`);
    assert.ok(values[0].content?.trim(), `${label}: nonempty ${key}`);
    return values[0].content;
  };
  const link = rel => links.filter(item => item.rel?.toLowerCase().split(/\s+/).includes(rel));
  const schemas = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, tag]) => attributes(tag).type === 'application/ld+json')
    .map(([, , data]) => JSON.parse(data));
  return { title, meta, link, schemas };
}

function canonicalUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.origin, origin, `${label}: canonical production origin`);
  assert.ok(!url.username && !url.password && !url.hash, `${label}: no credentials or fragment`);
  return url;
}

function localAsset(value, page, label) {
  assert.ok(value && !value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value), `${label}: relative URL works on project-page mirrors`);
  const pageUrl = new URL(page, new URL('../docs/', import.meta.url));
  const assetUrl = new URL(value, pageUrl);
  const path = fileURLToPath(assetUrl);
  assert.ok(path.startsWith(siteRoot.endsWith(sep) ? siteRoot : siteRoot + sep), `${label}: stays inside site assets`);
  return path;
}

function pngDimensions(data, label) {
  assert.ok(data.length >= 45, `${label}: complete PNG header and terminator`);
  assert.ok(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label}: real PNG signature`);
  assert.equal(data.readUInt32BE(8), 13, `${label}: standard IHDR length`);
  assert.equal(data.toString('ascii', 12, 16), 'IHDR', `${label}: IHDR is first`);
  let offset = 8, hasData = false, hasEnd = false;
  while (offset < data.length) {
    assert.ok(offset + 12 <= data.length, `${label}: complete chunk header`);
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= data.length, `${label}: chunk data is not truncated`);
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      assert.equal(length, 0, `${label}: empty IEND`);
      assert.equal(offset + 12, data.length, `${label}: IEND terminates file`);
      hasEnd = true;
    }
    offset += length + 12;
  }
  assert.ok(hasData && hasEnd, `${label}: contains image data and terminator`);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function schemaNodes(value) {
  if (Array.isArray(value)) return value.flatMap(schemaNodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(schemaNodes)];
}

test('Static pages have one coherent canonical and complete social/search metadata', async () => {
  for (const [path, route, schemaType] of pages) {
    const page = head(files.get(path), path);
    const links = page.link('canonical');
    assert.equal(links.length, 1, `${path}: one canonical link`);
    const canonical = canonicalUrl(links[0].href, path);
    assert.equal(canonical.href, origin + route, `${path}: canonical matches its public route`);
    const description = page.meta('description');
    assert.ok(description.length >= 40 && description.length <= 320, `${path}: useful concise description`);
    assert.match(page.meta('theme-color'), /^#[\da-f]{6}$/i, `${path}: valid theme color`);
    const robots = page.meta('robots').toLowerCase().split(/\s*,\s*/);
    assert.ok(robots.includes(schemaType ? 'index' : 'noindex'), `${path}: correct indexing policy`);
    assert.ok(!robots.includes(schemaType ? 'noindex' : 'index'), `${path}: no contradictory indexing policy`);
    assert.equal(page.meta('og:title'), page.title, `${path}: OG title matches page`);
    assert.equal(page.meta('twitter:title'), page.title, `${path}: Twitter title matches page`);
    assert.equal(page.meta('og:description'), description, `${path}: OG description matches page`);
    assert.equal(page.meta('twitter:description'), description, `${path}: Twitter description matches page`);
    assert.equal(page.meta('og:site_name'), 'Token Horizon', `${path}: brand name`);
    assert.equal(page.meta('og:type'), schemaType === 'BlogPosting' ? 'article' : 'website', `${path}: correct social object type`);
    assert.equal(page.meta('og:url'), canonical.href, `${path}: social URL matches canonical`);
    const image = canonicalUrl(page.meta('og:image'), path + ' preview');
    assert.equal(page.meta('og:image:secure_url'), image.href, `${path}: secure preview URL`);
    assert.equal(page.meta('twitter:image'), image.href, `${path}: same image across social surfaces`);
    assert.equal(page.meta('twitter:card'), 'summary_large_image', `${path}: large social card`);
    assert.equal(page.meta('og:image:type'), 'image/png', `${path}: declared PNG type`);
    assert.equal(page.meta('og:image:width'), '1200', `${path}: declared preview width`);
    assert.equal(page.meta('og:image:height'), '630', `${path}: declared preview height`);
    assert.ok(page.meta('og:image:alt').length >= 20, `${path}: meaningful image alternative`);
    assert.equal(page.meta('twitter:image:alt'), page.meta('og:image:alt'), `${path}: shared accessible alternative`);
    const data = await readFile(resolve(siteRoot, '.' + image.pathname));
    assert.deepEqual(pngDimensions(data, path + ' preview'), [1200, 630]);
    assert.ok(data.length > 1024 && data.length < 1024 * 1024, `${path}: preview has useful image data and stays under 1 MB`);
  }
});

test('Structured data describes the actual page and private connect has no public schema', () => {
  for (const [path, route, expectedType] of pages) {
    const page = head(files.get(path), path);
    assert.equal(page.schemas.length, expectedType ? 1 : 0, `${path}: appropriate schema presence`);
    if (!expectedType) continue;
    const schema = page.schemas[0];
    assert.equal(schema['@context'], 'https://schema.org', `${path}: schema context`);
    const nodes = schemaNodes(schema);
    const relevant = nodes.filter(node => node['@type'] === expectedType);
    assert.ok(relevant.length > 0, `${path}: ${expectedType} describes the page`);
    const primary = relevant.find(node => node.url === origin + route);
    assert.ok(primary, `${path}: primary schema is tied to its canonical URL`);
    assert.ok(primary.name || primary.headline, `${path}: primary schema has a name`);
    assert.ok(primary.description?.length >= 40, `${path}: primary schema has an accurate description`);
    assert.ok(nodes.every(node => !('aggregateRating' in node) && !('review' in node)), `${path}: no fabricated reviews or ratings`);
    if (expectedType === 'BlogPosting') {
      assert.match(primary.datePublished, /^\d{4}-\d{2}-\d{2}(?:T.*)?$/, `${path}: valid publication date`);
      assert.ok(files.get(path).includes(primary.datePublished.slice(0, 10)), `${path}: publication date agrees with visible article`);
      assert.equal(page.meta('article:published_time').slice(0, 10), primary.datePublished.slice(0, 10), `${path}: article metadata agrees with schema`);
      assert.equal(primary.headline, decodeEntities(files.get(path).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').trim(), `${path}: schema headline agrees with visible article`);
    }
  }
});

test('Every page links real, correctly sized icons and a mirror-safe manifest', async () => {
  const manifests = new Set();
  for (const [path] of pages) {
    const page = head(files.get(path), path);
    const icons = page.link('icon');
    assert.ok(icons.some(item => item.type === 'image/svg+xml') && icons.some(item => item.type === 'image/png') && icons.some(item => /\.ico(?:\?|$)/.test(item.href)), `${path}: vector, PNG and ICO fallbacks`);
    assert.equal(page.link('apple-touch-icon').length, 1, `${path}: Apple touch icon`);
    assert.equal(page.link('mask-icon').length, 1, `${path}: Safari pinned-tab mark`);
    assert.equal(page.link('manifest').length, 1, `${path}: one manifest`);
    for (const rel of ['icon', 'apple-touch-icon', 'mask-icon', 'manifest']) {
      for (const item of page.link(rel)) {
        const asset = localAsset(item.href, path, `${path} ${rel}`);
        const data = await readFile(asset);
        if (rel === 'manifest') { manifests.add(asset); continue; }
        if (item.type === 'image/png' || rel === 'apple-touch-icon') {
          const sizes = item.sizes?.match(/^(\d+)x(\d+)$/);
          assert.ok(sizes, `${path}: explicit PNG size`);
          assert.deepEqual(pngDimensions(data, asset), sizes.slice(1).map(Number), `${path}: actual icon dimensions match declared size`);
        } else if (item.type === 'image/svg+xml' || rel === 'mask-icon') {
          assert.match(data.toString(), /<svg\b[^>]*\bviewBox\s*=/, `${path}: scalable vector mark`);
        } else if (/\.ico$/.test(asset)) {
          assert.ok(data.length >= 22 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1, `${path}: genuine ICO header`);
          const count = data.readUInt16LE(4);
          assert.ok(count > 0 && data.length >= 6 + count * 16, `${path}: complete ICO directory`);
          for (let index = 0; index < count; index++) {
            const row = 6 + index * 16;
            const length = data.readUInt32LE(row + 8), offset = data.readUInt32LE(row + 12);
            assert.ok(length > 0 && offset >= 6 + count * 16 && offset + length <= data.length, `${path}: ICO image exists within file`);
          }
        }
      }
    }
  }
  assert.equal(manifests.size, 1, 'All pages share the same platform manifest');
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.name, 'Token Horizon');
    const relative = path.slice(siteRoot.length).replace(/^[/\\]/, '');
    for (const key of ['id', 'start_url', 'scope']) localAsset(manifest[key], relative, `manifest ${key}`);
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest includes multiple icon sizes');
    const sizes = new Set();
    for (const icon of manifest.icons) {
      assert.equal(icon.type, 'image/png', 'Manifest declares actual PNG icons');
      const size = icon.sizes?.match(/^(\d+)x(\d+)$/);
      assert.ok(size, 'Manifest declares explicit icon dimensions');
      const asset = localAsset(icon.src, relative, 'Manifest icon');
      assert.deepEqual(pngDimensions(await readFile(asset), asset), size.slice(1).map(Number));
      assert.equal(size[1], size[2], 'Manifest icons are square');
      sizes.add(Number(size[1]));
    }
    assert.ok(sizes.has(192) && sizes.has(512), 'Manifest includes standard large platform icons');
  }
});

function xmlText(value, label) {
  assert.ok(!/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[\da-fA-F]+);)/.test(value), `${label}: XML special characters are escaped`);
  assert.ok(!/[<>]/.test(value), `${label}: no nested or injected markup`);
  return decodeEntities(value).trim();
}

function wellFormedXml(xml) {
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? [];
  assert.equal(tokens.join(''), xml, 'Sitemap has no malformed XML tokens');
  const stack = [];
  let roots = 0;
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) { xmlText(token, 'Sitemap text'); continue; }
    const closing = token.match(/^<\/([A-Za-z_][\w:.-]*)\s*>$/);
    if (closing) { assert.equal(stack.pop(), closing[1], 'Sitemap XML tags are correctly nested'); continue; }
    const opening = token.match(/^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
    assert.ok(opening, 'Sitemap contains only valid XML elements');
    assert.match(opening[2], /^(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/, 'Sitemap XML attributes are quoted');
    if (!stack.length) { roots++; assert.equal(opening[1], 'urlset', 'Sitemap root is urlset'); }
    if (!opening[3]) stack.push(opening[1]);
  }
  assert.equal(roots, 1, 'Sitemap has exactly one root');
  assert.equal(stack.length, 0, 'Sitemap XML elements are closed');
}

test('Sitemap contains only unique canonical public pages and implemented collection tabs', async () => {
  const xml = await readFile(resolve(siteRoot, 'sitemap.xml'), 'utf8');
  assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'Sitemap has no external entity declarations');
  wellFormedXml(xml);
  assert.match(xml, /<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/);
  assert.match(xml, /<\/urlset>\s*$/);
  const entries = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/g)];
  assert.ok(entries.length > 0, 'Sitemap has public entries');
  assert.equal((xml.match(/<loc\b/g) ?? []).length, entries.length, 'Each sitemap entry has exactly one location');
  const publicCanonical = new Set(pages.filter(([, , schema]) => schema).map(([, route]) => origin + route));
  const visited = new Set();
  for (const [, entry] of entries) {
    const locs = [...entry.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/g)];
    assert.equal(locs.length, 1, 'One location per sitemap entry');
    const loc = xmlText(locs[0][1], 'Sitemap location');
    const url = canonicalUrl(loc, 'Sitemap');
    assert.ok(!visited.has(url.href), `No duplicate sitemap URL: ${url.href}`);
    visited.add(url.href);
    assert.ok(!/^\/(?:login|connect|oauth|invite|s|workspace|billing|settings|api|mcp)(?:\/|$)/.test(url.pathname), 'Private, auth and report routes stay out of the sitemap');
    if (publicCanonical.has(url.href)) continue;
    const keys = [...url.searchParams.keys()];
    assert.equal(keys.length, 1, `${url.href}: one intentional public view parameter`);
    if (url.pathname === '/models') {
      assert.equal(keys[0], 'tab');
      assert.ok(['cheapest', 'providers', 'plans'].includes(url.searchParams.get('tab')), 'Model tab is a canonical public collection');
    } else {
      assert.equal(url.pathname, '/leaderboard', `${url.href}: sitemap route has a real public head or collection`);
      assert.equal(keys[0], 'view');
      assert.ok(['teams', 'leagues'].includes(url.searchParams.get('view')), 'Leaderboard view is a canonical public collection');
    }
  }
  for (const url of publicCanonical) assert.ok(visited.has(url), `${url}: public static page is discoverable`);
  for (const route of ['/models?tab=cheapest', '/models?tab=providers', '/models?tab=plans', '/leaderboard?view=teams', '/leaderboard?view=leagues']) {
    assert.ok(visited.has(origin + route), `${route}: public collection is discoverable`);
  }
});

function robotGroups(text) {
  const groups = [];
  let group = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key) && value) {
      group.rules.push({ allow: key === 'allow', value });
    }
  }
  return groups;
}

function robotsAllow(groups, agent, path) {
  const candidates = groups.map(group => ({ group, specificity: Math.max(-1, ...group.agents.map(token => token === '*' ? 0 : agent.toLowerCase().includes(token) ? token.length : -1)) }));
  const specificity = Math.max(-1, ...candidates.map(item => item.specificity));
  const applicable = candidates.filter(item => item.specificity === specificity && specificity >= 0).flatMap(item => item.group.rules);
  const matching = applicable.filter(rule => {
    const pattern = rule.value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + pattern).test(path);
  }).sort((a, b) => b.value.replace(/\*/g, '').length - a.value.replace(/\*/g, '').length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

test('Robots advertises the sitemap and permits public rendering assets/data and profile previews', async () => {
  const text = await readFile(resolve(siteRoot, 'robots.txt'), 'utf8');
  const directives = [...text.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gmi)];
  assert.equal(directives.length, 1, 'One sitemap directive');
  assert.equal(canonicalUrl(directives[0][1], 'Robots sitemap').href, origin + '/sitemap.xml');
  const groups = robotGroups(text);
  assert.ok(groups.some(group => group.agents.includes('*')), 'Robots includes a default policy');
  const publicResources = [
    '/', '/models', '/models?tab=plans', '/leaderboard', '/docs/', '/blog/', '/u/benebsworth',
    '/favicon.ico', '/favicon-32x32.png', '/favicon-48x48.png', '/apple-touch-icon.png', '/site.webmanifest',
    '/assets/favicon.svg', '/assets/og.png', '/assets/og-models.png', '/assets/brands/openai.svg',
    '/fonts/HubotSansVF-Regular.ttf', '/fonts/JetBrainsMono-Regular.ttf',
    '/landing.css', '/horizon-system.css', '/discovery.css', '/profile.css', '/ui-updates.js',
    '/vendor/tanstack-charts.js', '/vendor/dicebear.js', '/vendor/fuse.js', '/data/models.json',
    '/api/models/catalog', '/api/models/usage', '/api/leaderboard?period=today&historyDays=30',
    '/api/providers?days=30', '/api/season', '/api/config',
    '/api/user/benebsworth', '/api/og/profile/benebsworth.png', '/api/og/share/public-report.png', '/api/avatar/benebsworth'
  ];
  for (const agent of ['Googlebot', 'Googlebot-Image']) {
    for (const resource of publicResources) assert.ok(robotsAllow(groups, agent, resource), `${agent} can access ${resource}`);
  }
});
