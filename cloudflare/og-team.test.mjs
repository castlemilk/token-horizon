import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { buildTeamOgModel, renderTeamOgSvg, TEAM_OG_VERSION } from './src/og-team.js';

const team = { id: 'a'.repeat(32), name: 'Orbital Crew', memberCount: 23, logoUrl: '/api/team/logo/' + 'a'.repeat(32) + '?v=1', logoUpdatedAt: 123 };
const stats = { tokens: 3456789000, tokensFormatted: 'UNTRUSTED PRESENTATION VALUE', publishedProfiles: 7, providers: { anthropic: 1800000000, openai: 1100000000, google: 500000000, deepseek: 50000000, kimi: 6789000 }, users: [{ handle: 'private-in-this-card', ownerId: 'PRIVATE OWNER', email: 'PRIVATE EMAIL' }] };
const coral = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGN4G+r3Hx9mGBkKAG8Uo8FWIl3AAAAAAElFTkSuQmCC';
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];

test('team cards distinguish authoritative joined membership from public usage profiles', () => {
  const model = buildTeamOgModel(team, stats);
  assert.equal(model.members, 23, 'Joined members come from the authoritative membership record');
  assert.equal(model.publishedProfiles, 7, 'Published profiles are separate from members');
  assert.equal(model.providerCount, 5);
  assert.equal(model.tokens, stats.tokens);
  const svg = renderTeamOgSvg(team, stats);
  assert.match(svg, /data-team-members="23"/);
  assert.match(svg, /23 joined members/);
  assert.match(svg, /PUBLIC PROFILES/);
  assert.match(svg, />3\.46B<\/text>/);
  assert.match(svg, /Orbital Crew/);
  assert.match(svg, /Token Horizon/);
  for (const secret of ['PRIVATE OWNER', 'PRIVATE EMAIL', 'private-in-this-card', 'UNTRUSTED PRESENTATION VALUE']) assert.ok(!svg.includes(secret));
  assert.ok(TEAM_OG_VERSION.startsWith('team-horizon-'));
});

test('a new team celebrates its real roster without inventing published activity', () => {
  const model = buildTeamOgModel({ ...team, memberCount: 1 }, { tokens: 0, publishedProfiles: 0, providers: {} });
  assert.equal(model.members, 1);
  assert.equal(model.tokensAvailable, true);
  const svg = renderTeamOgSvg({ ...team, memberCount: 1 }, { tokens: 0, publishedProfiles: 0, providers: {} });
  assert.match(svg, /1 joined member · Token Horizon/);
  assert.match(svg, />MEMBER<\/text>/);
  assert.match(svg, /story starts with its first public profile/);
  assert.match(svg, /data-team-logo="monogram"/);
  assert.doesNotMatch(svg, /data-provider-share=|data-heatmap-day=|data-chart-day=|data-team-logo="custom"/);
  assert.equal((svg.match(/data-team-tokens="true"[^>]*>0<\/text>/g) || []).length, 1);
});

test('unavailable counts remain unavailable and malformed values never create invalid SVG', () => {
  const model = buildTeamOgModel({}, {});
  assert.equal(model.memberCountAvailable, false);
  assert.equal(model.profilesAvailable, false);
  assert.equal(model.tokensAvailable, false);
  assert.match(renderTeamOgSvg({}, {}), /data-team-members="unavailable"/);
  for (const value of [-10, NaN, Infinity, 'not a number', null, undefined]) {
    const svg = renderTeamOgSvg({ name: 'New team', memberCount: value }, { tokens: value, publishedProfiles: value, providers: { bad: value } });
    assert.doesNotMatch(svg, /NaN|Infinity|width="-/);
    assert.match(svg, /data-team-tokens="true"[^>]*>—<\/text>/);
  }
});

test('provider share is measured, totals are preserved, and lower providers group into Other', () => {
  const model = buildTeamOgModel(team, stats);
  assert.equal(model.mix.length, 5);
  assert.deepEqual(model.mix.map(row => row.provider), ['anthropic', 'openai', 'google', 'deepseek', 'other']);
  assert.equal(model.mix.at(-1).tokens, stats.providers.kimi);
  assert.equal(model.mix.reduce((sum, row) => sum + row.tokens, 0), stats.tokens);
  assert.ok(Math.abs(model.mix.reduce((sum, row) => sum + row.share, 0) - 1) < .000001);
  const svg = renderTeamOgSvg(team, stats);
  const bars = [...svg.matchAll(/<rect\b(?=[^>]*data-provider-share=)[^>]*>/g)].map(([tag]) => ({ x: Number(attribute(tag, 'x')), width: Number(attribute(tag, 'width')) }));
  assert.equal(bars.length, 5);
  assert.ok(Math.abs(bars.reduce((sum, bar) => sum + bar.width, 0) - 1104) < .01);
  assert.equal(bars[0].x, 48);
  assert.ok(Math.abs(bars.at(-1).x + bars.at(-1).width - 1152) < .01);
  assert.match(svg, /OF ATTRIBUTED TOKENS/);
  const partial = renderTeamOgSvg(team, { ...stats, tokens: 9000000000, providers: { openai: 100 } });
  assert.match(partial, />9B<\/text>/, 'Incomplete provider attribution cannot change the canonical team total');
  assert.match(partial, /100% OF ATTRIBUTED TOKENS/);
});

test('extreme provider values still produce finite, non-negative share geometry', () => {
  const providers = Object.fromEntries(Array.from({ length: 20 }, (_, index) => ['provider' + index, Number.MAX_SAFE_INTEGER]));
  const model = buildTeamOgModel(team, { ...stats, providers });
  assert.ok(Math.abs(model.mix.reduce((sum, row) => sum + row.share, 0) - 1) < .000001);
  const svg = renderTeamOgSvg(team, { ...stats, providers });
  assert.doesNotMatch(svg, /NaN|Infinity|width="-/);
});

test('official provider paths are embedded without network assets and OpenAI has a cropped canvas', async () => {
  const svg = renderTeamOgSvg(team, { ...stats, providers: { openai: 100, anthropic: 90, google: 80, deepseek: 70 } });
  for (const name of ['openai', 'anthropic', 'google', 'deepseek']) {
    const source = await readFile(new URL(`../docs/assets/brands/${name}.svg`, import.meta.url), 'utf8');
    const firstPath = source.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1];
    assert.ok(firstPath && svg.includes(firstPath), `${name} uses its existing official path`);
    assert.match(svg, new RegExp(`data-provider-mark="${name}"`));
  }
  assert.match(svg, /viewBox="177 177 361 361"/, 'OpenAI source whitespace is cropped for a centered equal-size mark');
  assert.doesNotMatch(svg, /href="https?:|href="\/assets\//);
});

test('long Unicode team names and hostile labels stay bounded and escaped', () => {
  for (const name of ['A very long creative autonomous software engineering collective!!!', '宇宙探検隊'.repeat(12), 'Orbital 🚀 Crew 🛰️ ' + 'é'.repeat(42)]) {
    const svg = renderTeamOgSvg({ ...team, name }, stats);
    const nameTags = [...svg.matchAll(/<text\b(?=[^>]*data-team-name="true")[^>]*>/g)].map(([tag]) => tag);
    assert.ok(nameTags.length >= 1 && nameTags.length <= 3);
    assert.ok(nameTags.every(tag => Number(attribute(tag, 'y')) < 264));
    assert.ok(nameTags.every(tag => Number(attribute(tag, 'font-size')) >= 30));
    assert.ok(svg.includes(name.replace(/&/g, '&amp;')), 'The full public name remains available in the accessible title');
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
  const hostile = renderTeamOgSvg({ ...team, name: '<script>alert(1)</script> & "Crew"\u0000' }, { ...stats, providers: { 'evil" onload="alert(1)<script>': 100 } });
  assert.doesNotMatch(hostile, /<script>|<[^>]*\s(?:onload|onclick)="|\u0000/);
  assert.match(hostile, /&lt;script&gt;/);
});

test('unresolved, unsupported or malformed custom logos use the crisp monogram fallback', () => {
  const baseline = renderTeamOgSvg(team, stats);
  for (const source of [
    undefined, null, '', {}, 'https://images.example.com/team.png', '/api/team/logo/' + team.id,
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=',
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=',
    'data:image/png;base64,aGVsbG8=', 'data:image/png;base64,%%%',
    coral + '" onload="alert(1)', 'data:image/png;base64,' + 'a'.repeat(540000)
  ]) {
    assert.equal(renderTeamOgSvg(team, stats, { logoDataUri: source }), baseline);
  }
  assert.match(baseline, /data-team-logo="monogram"[^>]*>OC<\/text>/);
  assert.doesNotMatch(baseline, /data-team-logo="custom"|<image|onload=/);
});

test('a resolved custom logo has square, centered contain bounds and never exposes a source URL', async () => {
  for (const source of [coral, 'data:image/jpeg;base64,' + (await readFile(new URL('./fixtures/og-avatar.jpg', import.meta.url))).toString('base64')]) {
    const svg = renderTeamOgSvg(team, stats, { logoDataUri: source });
    const tag = svg.match(/<image\b(?=[^>]*data-team-logo="custom")[^>]*>/)?.[0];
    assert.ok(tag);
    assert.equal(attribute(tag, 'href'), source);
    assert.equal(attribute(tag, 'preserveAspectRatio'), 'xMidYMid meet');
    assert.equal(attribute(tag, 'width'), attribute(tag, 'height'));
    assert.equal(Number(attribute(tag, 'x')) + Number(attribute(tag, 'width')) / 2, 96);
    assert.equal(Number(attribute(tag, 'y')) + Number(attribute(tag, 'height')) / 2, 159);
    assert.doesNotMatch(svg, /\/api\/team\/logo\/|logoUpdatedAt|data-team-logo="monogram"/);
  }
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function landscapeLogo() {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length, 0); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 16 }, () => [237, 85, 78, 255]).flat())])));
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

let rasterReady;
async function raster(svg) {
  if (!rasterReady) rasterReady = (async () => {
    const module = await import('./node_modules/@resvg/resvg-wasm/index.mjs');
    const [wasm, ...fonts] = await Promise.all([
      readFile(new URL('./node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)),
      readFile(new URL('./fonts/TokenHorizonSans-Regular.ttf', import.meta.url)),
      readFile(new URL('./fonts/TokenHorizonSans-SemiBold.ttf', import.meta.url)),
      readFile(new URL('./fonts/JetBrainsMono-Regular.ttf', import.meta.url))
    ]);
    await module.initWasm(wasm);
    return { module, fonts };
  })();
  const { module, fonts } = await rasterReady;
  const renderer = new module.Resvg(svg, { fitTo: { mode: 'original' }, font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Token Horizon Sans' } });
  let image;
  try {
    image = renderer.render();
    return { png: Buffer.from(image.asPng()), pixels: image.pixels.slice() };
  } finally { image?.free(); renderer.free(); }
}
const rgb = (pixels, x, y) => [...pixels.subarray((y * 1200 + x) * 4, (y * 1200 + x) * 4 + 3)];

test('real 1200×630 PNG paints the actual logo, provider mix, typography and opaque canvas', async () => {
  const { png, pixels } = await raster(renderTeamOgSvg(team, stats, { logoDataUri: coral }));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length > 10000 && png.length < 400000);
  assert.deepEqual(rgb(pixels, 96, 159), [237, 85, 78], 'Logo bytes reach the PNG center');
  assert.deepEqual(rgb(pixels, 52, 160), [255, 255, 255], 'Logo receives deliberate padding inside its square');
  assert.deepEqual(rgb(pixels, 60, 437), [217, 119, 87], 'Actual Anthropic attribution paints its brand color');
  assert.equal(pixels[(20 * 1200 + 20) * 4 + 3], 255);
  let paintedTitle = 0;
  for (let y = 130; y < 180; y++) for (let x = 166; x < 650; x++) {
    if (rgb(pixels, x, y).every(channel => channel > 200)) paintedTitle++;
  }
  assert.ok(paintedTitle > 500, 'Bundled display typography paints substantial team-name pixels');
});

test('landscape logos are centered and retain their real aspect ratio in encoded pixels', async () => {
  const { pixels } = await raster(renderTeamOgSvg(team, stats, { logoDataUri: landscapeLogo() }));
  assert.deepEqual(rgb(pixels, 96, 159), [237, 85, 78]);
  assert.deepEqual(rgb(pixels, 60, 159), [237, 85, 78], 'The full wide mark remains visible');
  assert.deepEqual(rgb(pixels, 96, 130), [255, 255, 255], 'No stretch or edge-cropping fills the space above');
  assert.deepEqual(rgb(pixels, 96, 185), [255, 255, 255], 'Contain letterboxing is symmetric below');
  let minY = Infinity, maxY = -1;
  for (let y = 121; y < 197; y++) if (rgb(pixels, 96, y).join(',') === '237,85,78') { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  assert.ok(maxY - minY + 1 >= 18 && maxY - minY + 1 <= 20, '16×4 source paints at its 4:1 aspect ratio');
  assert.ok(Math.abs((minY + maxY + 1) / 2 - 159) <= .5, 'Visible logo pixels are vertically centered');
});
