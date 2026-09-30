import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Resvg, initWasm } from '../cloudflare/node_modules/@resvg/resvg-wasm/index.mjs';
import { buildOgModel, renderProfileOgSvg, renderRestrictedOgSvg } from '../cloudflare/src/og-card.js';

// The worker's SVG response tests intentionally avoid dynamic wasm/font module
// imports. Exercise the same actual rasterizer and bundled fonts here, without
// a network listener, injected production renderer, or system-font fallback.
const fromRoot = relative => new URL('../' + relative, import.meta.url);
const [wasm, ...fontBuffers] = await Promise.all([
  readFile(fromRoot('cloudflare/node_modules/@resvg/resvg-wasm/index_bg.wasm')),
  readFile(fromRoot('cloudflare/fonts/TokenHorizonSans-Regular.ttf')),
  readFile(fromRoot('cloudflare/fonts/TokenHorizonSans-SemiBold.ttf')),
  readFile(fromRoot('cloudflare/fonts/JetBrainsMono-Regular.ttf')),
  readFile(fromRoot('cloudflare/fonts/JetBrainsMono-Bold.ttf')),
  readFile(fromRoot('cloudflare/fonts/JetBrainsMono-ExtraBold.ttf'))
]);
await initWasm(wasm);

// Browser @font-face aliases are unavailable to resvg. Compare the declared
// SVG families with the fonts' actual names so display type cannot silently
// fall back to the mono default while still producing a valid PNG.
function fontFamilyNames(font) {
  const data = Buffer.from(font);
  const names = [];
  for (let index = 0; index < data.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    if (data.toString('ascii', record, record + 4) !== 'name') continue;
    const base = data.readUInt32BE(record + 8);
    const stringBase = base + data.readUInt16BE(base + 4);
    for (let row = 0; row < data.readUInt16BE(base + 2); row++) {
      const offset = base + 6 + row * 12;
      if (![1, 16].includes(data.readUInt16BE(offset + 6))) continue;
      const platform = data.readUInt16BE(offset);
      const length = data.readUInt16BE(offset + 8);
      const start = stringBase + data.readUInt16BE(offset + 10);
      names.push(new TextDecoder(platform === 0 || platform === 3 ? 'utf-16be' : 'utf-8').decode(data.subarray(start, start + length)));
    }
  }
  return names;
}

function markedRects(svg, attribute) {
  return [...svg.matchAll(new RegExp(`<rect\\b(?=[^>]*\\b${attribute}=")[^>]*>`, 'g'))].map(([tag]) => {
    const value = name => tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
    return { x: Number(value('x')), y: Number(value('y')), width: Number(value('width')), height: Number(value('height')), fill: value('fill'), provider: value('data-chart-provider'), day: value('data-chart-day') };
  });
}

function rasterize(svg, label, { fonts = fontBuffers, checkTwoRows = false, checkProviderColors = false } = {}) {
  if (fonts.length) {
    const available = new Set(fonts.flatMap(fontFamilyNames));
    const declared = new Set([...svg.matchAll(/font-family="([^"]+)"/g)].map(match => match[1]));
    for (const family of declared) assert.ok(available.has(family), `${label}: '${family}' must match a bundled font's real family`);
  }
  const started = performance.now();
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'JetBrains Mono' }
  });
  const image = renderer.render();
  try {
    const png = Buffer.from(image.asPng());
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `${label}: PNG signature`);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${label}: PNG header`);
    assert.equal(png.readUInt32BE(16), 1200, `${label}: encoded width`);
    assert.equal(png.readUInt32BE(20), 630, `${label}: encoded height`);
    assert.equal(image.width, 1200);
    assert.equal(image.height, 630);
    assert.ok(png.byteLength > 5000 && png.byteLength < 1_000_000, `${label}: useful, bounded image size (${png.byteLength})`);
    const pixels = image.pixels;
    assert.equal(pixels.byteLength, 1200 * 630 * 4);
    if (checkTwoRows) {
      const bars = markedRects(svg, 'data-chart-day').filter(rect => rect.width >= 4 && rect.height >= 4);
      const cells = markedRects(svg, 'data-heatmap-day').filter(rect => !['#F3F4EF', '#E1E6DE'].includes(rect.fill));
      assert.ok(bars.length > 0, `${label}: actual tokens produce visible chart bars`);
      assert.ok(cells.length > 0, `${label}: actual tokens produce visible heatmap cells`);
      assert.ok(Math.max(...bars.map(rect => rect.y + rect.height)) < Math.min(...cells.map(rect => rect.y)), `${label}: chart is above the heatmap`);
      for (const rect of [...bars.slice(0, 5), ...cells.slice(0, 5)]) {
        assert.ok(rect.x >= 416 && rect.x + rect.width <= 1200, `${label}: both data rows remain beside the profile panel`);
        const x = Math.floor(rect.x + rect.width / 2), y = Math.floor(rect.y + rect.height / 2);
        const offset = (y * 1200 + x) * 4;
        assert.notDeepEqual([...pixels.subarray(offset, offset + 3)], [243, 244, 239], `${label}: each row paints visible activity pixels`);
        assert.equal(pixels[offset + 3], 255, `${label}: activity is visible in the encoded raster`);
      }
    }
    if (checkProviderColors) {
      const segments = markedRects(svg, 'data-chart-provider').filter(rect => rect.width >= 4 && rect.height >= 4);
      assert.ok(new Set(segments.map(rect => rect.provider)).size >= 2, `${label}: measured usage paints multiple providers`);
      for (const provider of new Set(segments.map(rect => rect.provider))) {
        const rect = segments.find(segment => segment.provider === provider);
        const x = Math.floor(rect.x + rect.width / 2), y = Math.floor(rect.y + rect.height / 2);
        const offset = (y * 1200 + x) * 4;
        const color = rect.fill.match(/^#([0-9a-f]{6})$/i);
        assert.ok(color, `${label}: provider ${provider} has a concrete shared palette color`);
        const expected = [0, 2, 4].map(index => parseInt(color[1].slice(index, index + 2), 16));
        assert.deepEqual([...pixels.subarray(offset, offset + 3)], expected, `${label}: ${provider} color reaches actual PNG pixels`);
        assert.equal(pixels[offset + 3], 255, `${label}: provider color is opaque`);
      }
    }
    const colors = new Set();
    for (let offset = 0; offset < pixels.length; offset += 52) {
      colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`);
    }
    assert.ok(colors.size > 5, `${label}: image contains visible content`);
    console.log(`OG PNG: ${label} · ${png.byteLength} bytes · ${(performance.now() - started).toFixed(1)} ms`);
    return png;
  } finally {
    image.free();
    renderer.free();
  }
}

const { values: arguments_ } = parseArgs({ options: { preview: { type: 'string' }, 'restricted-preview': { type: 'string' } } });
const snapshotDay = Math.floor(Date.now() / 86400000) * 86400;
const daily = Array.from({ length: 119 }, (_, index) => ({
  day: snapshotDay - (118 - index) * 86400,
  tokens: index % 8 === 0 ? 0 : (index % 11 + 1) * 12000
}));
const entry = {
  handle: 'orbit_builder', team: 'Orbital Crew', hardware: 'M4 Max',
  updatedAt: snapshotDay + 43200,
  tokensToday: 1230000, tokens7d: 9870000, tokensAll: 234560000,
  costToday: 8.5, costAll: 132.25, streakDays: 17, requestsAll: 1234,
  ownerId: 'google:private-owner', googleEmail: 'private@example.com', claimTokenHash: 'private-token-hash',
  breakdown: {
    daily,
    history: daily.slice(-14),
    models: [
      { provider: 'anthropic', model: 'private-model-a', tokensAll: 180000000, requests: 1000 },
      { provider: 'openai', model: 'private-model-b', tokensAll: 54560000, requests: 234 }
    ],
    modelHistory: [
      { provider: 'anthropic', model: 'private-model-a', points: daily.map(point => ({ day: point.day, tokens: Math.floor(point.tokens * .62) })) },
      { provider: 'openai', model: 'private-model-b', points: daily.map(point => ({ day: point.day, tokens: Math.floor(point.tokens * .30) })) },
      { provider: 'google', model: 'private-model-c', points: daily.map(point => ({ day: point.day, tokens: point.tokens - Math.floor(point.tokens * .62) - Math.floor(point.tokens * .30) })) }
    ],
    sessions: [{ title: 'PRIVATE PROMPT CONTENT MUST NEVER APPEAR', at: snapshotDay, tokens: 9000 }],
    projects: [{ project: 'PRIVATE PROJECT MUST NEVER APPEAR', tokens: 8000 }]
  }
};
const standing = {
  league: 'grandmaster', leagueTitle: 'Grandmaster', leagueColor: '#235E43', division: 1, mmr: 2400,
};
const modelOptions = {
  rank: 3, rankToday: 2, total: 42, standing,
  season: { displayName: 'Orbit Season' },
  normalizeProvider: provider => provider,
  fullTokenCounts: true, providerBreakdown: true, includeLeagueRank: true
};

const model = buildOgModel(entry, modelOptions);
assert.equal(model.calendarDays.length, 119);
assert.equal(model.calendarAvailable, true);
assert.equal(model.chartDays.length, 30);
assert.equal(model.chartAvailable, true);
assert.equal(model.chartProviderAvailable, true);
assert.equal(model.chartProviders.length, 3);
assert.equal(model.chartDays.at(-1).day, Math.floor(snapshotDay / 86400));
for (const point of model.chartDays) {
  assert.equal(point.segments.reduce((total, segment) => total + segment.tokens, 0), point.tokens, 'Actual provider segments reconcile with the published daily total');
  for (const segment of point.segments) {
    assert.equal(segment.color, model.chartProviders.find(provider => provider.provider === segment.provider)?.color, 'Daily provider bars share their legend colors');
  }
}
assert.ok(model.calendarDays.some(point => point.tokens > 0 && point.level > 0), 'Real daily tokens contribute heatmap activity');
assert.equal(model.mix.length, 2);
const fullSvg = renderProfileOgSvg(model);
assert.match(fullSvg, /orbit_builder/);
assert.match(fullSvg, /Token Horizon/i);
assert.match(fullSvg, /heatmap|activity/i);
for (const secret of ['private-owner', 'private@example.com', 'private-token-hash', 'PRIVATE PROMPT', 'PRIVATE PROJECT']) {
  assert.equal(fullSvg.includes(secret), false, `OG excludes ${secret}`);
}
const profilePng = rasterize(fullSvg, 'provider-colored usage chart and 119-day heatmap', { checkTwoRows: true, checkProviderColors: true });
if (arguments_.preview) {
  await writeFile(arguments_.preview, profilePng);
  console.log(`OG preview written: ${arguments_.preview}`);
}

const emptyEntry = { handle: 'new_builder', updatedAt: snapshotDay, tokensAll: 0, tokensToday: 0, breakdown: {} };
const emptyModel = buildOgModel(emptyEntry, modelOptions);
assert.equal(emptyModel.calendarDays.length, 119);
assert.equal(emptyModel.calendarAvailable, false);
assert.equal(emptyModel.chartAvailable, false);
assert.ok(emptyModel.chartDays.every(point => point.tokens === 0), 'Missing chart activity is not fabricated');
assert.ok(emptyModel.calendarDays.every(point => point.tokens === 0), 'Missing activity is not fabricated');
const emptySvg = renderProfileOgSvg(emptyModel);
assert.match(emptySvg, /new_builder/);
rasterize(emptySvg, 'profile without activity');

const unknownDate = buildOgModel({ handle: 'unknown_date', breakdown: { models: { malformed: true } } }, modelOptions);
assert.equal(unknownDate.calendarAvailable, false);
const unknownDateSvg = renderProfileOgSvg(unknownDate);
assert.match(unknownDateSvg, /Publication date unavailable/);
assert.doesNotMatch(unknownDateSvg, />\s*(?:Sep|Oct|Nov|Dec|Jan)(?:\s+\d+)?\s*<\/text>/, 'Unknown dates do not display an epoch-based calendar');
rasterize(unknownDateSvg, 'unknown publication and malformed model data');

const hostileEntry = { ...entry, handle: 'long_' + 'name'.repeat(35), team: 'Team <script>alert(1)</script> & Friends', hardware: 'M4\u0000Max' };
const hostileSvg = renderProfileOgSvg(buildOgModel(hostileEntry, modelOptions));
assert.doesNotMatch(hostileSvg, /<script>|\u0000/);
rasterize(hostileSvg, 'long identity and escaped input');

const anonymizedSvg = renderProfileOgSvg(buildOgModel(entry, {
  ...modelOptions, anonymize: true, hideCost: true,
  includeLeagueRank: false, providerBreakdown: false, fullTokenCounts: false
}));
assert.match(anonymizedSvg, /Anonymous/);
for (const privateValue of [entry.handle, entry.team, entry.hardware, 'Grandmaster', 'Anthropic', 'OpenAI']) {
  assert.equal(anonymizedSvg.includes(privateValue), false, `Anonymized card excludes ${privateValue}`);
}
rasterize(anonymizedSvg, 'anonymized public share');

const noProviderModel = buildOgModel(entry, { ...modelOptions, providerBreakdown: false });
assert.equal(noProviderModel.chartProviderAvailable, false);
assert.deepEqual(noProviderModel.chartProviders, []);
assert.ok(noProviderModel.chartDays.every(point => point.segments.length === 0), 'Provider-disabled shares retain no hidden chart attribution');
const noProviderSvg = renderProfileOgSvg(noProviderModel);
assert.doesNotMatch(noProviderSvg, /Anthropic|OpenAI|Google|data-chart-provider="(?:anthropic|openai|google)"/);
rasterize(noProviderSvg, 'public share with provider attribution disabled', { checkTwoRows: true });

const totalOnlyEntry = { ...entry, breakdown: { ...entry.breakdown, modelHistory: undefined } };
const totalOnlyModel = buildOgModel(totalOnlyEntry, modelOptions);
assert.equal(totalOnlyModel.chartProviderAvailable, false);
assert.deepEqual(totalOnlyModel.chartProviders, []);
assert.ok(totalOnlyModel.chartDays.every(point => point.segments.length === 0), 'All-time mix does not invent daily provider allocation');
const totalOnlySvg = renderProfileOgSvg(totalOnlyModel);
assert.doesNotMatch(totalOnlySvg, /data-chart-provider="(?:anthropic|openai|google)"/);
rasterize(totalOnlySvg, 'daily totals without provider history', { checkTwoRows: true });

const restrictedSvg = renderRestrictedOgSvg();
for (const privateValue of [entry.handle, entry.team, entry.hardware, String(entry.tokensAll), String(entry.tokensToday)]) {
  assert.equal(restrictedSvg.includes(privateValue), false, 'Restricted card remains generic');
}
const restrictedPng = rasterize(restrictedSvg, 'restricted share');
if (arguments_['restricted-preview']) {
  await writeFile(arguments_['restricted-preview'], restrictedPng);
  console.log(`Restricted OG preview written: ${arguments_['restricted-preview']}`);
}

// Without usable fonts, geometry and the heatmap still form a valid raster.
// Production uses all bundled fonts; this catches a renderer exception on its
// missing-font path rather than depending on fonts installed on the CI host.
rasterize(fullSvg, 'missing fonts preserve chart geometry', { fonts: [], checkTwoRows: true, checkProviderColors: true });
console.log('OG PNG rasterization checks passed.');
