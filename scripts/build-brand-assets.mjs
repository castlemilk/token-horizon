import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Resvg, initWasm } from '../cloudflare/node_modules/@resvg/resvg-wasm/index.mjs';

// Build-time only. Every public icon and social card is local and deterministic;
// request handlers never fetch artwork, load fonts, or generate these PNGs.
// The mark is the optical horizon-cut circle from docs/horizon-system.css.
const root = path => new URL('../' + path, import.meta.url);
const check = process.argv.includes('--check');
const palette = { mineral: '#F3F4EF', graphite: '#121714', mint: '#B6F2CF', muted: '#56635A', rule: '#CDD3CC', forest: '#235E43', panel: '#1C241F' };
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (x, y, value, color = palette.muted, size = 13) => `<text x="${x}" y="${y}" font-family="JetBrains Mono" font-size="${size}" letter-spacing="1.5" fill="${color}">${esc(value)}</text>`;
const text = (x, y, value, size = 24, color = palette.graphite, weight = 400, extra = '') => `<text x="${x}" y="${y}" font-family="Token Horizon Sans" font-size="${size}" font-weight="${weight}" fill="${color}" ${extra}>${esc(value)}</text>`;
const rect = (x, y, width, height, fill, radius = 0, extra = '') => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" ${extra}/>`;
const line = (x1, y1, x2, y2, color = palette.rule, extra = '') => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" ${extra}/>`;
const markPath = 'M2 11a10.05 10.05 0 0 1 20 0H2Zm0 2h20A10.05 10.05 0 0 1 2 13Z';
const mark = (x, y, size, fill = palette.mint) => `<g transform="translate(${x} ${y}) scale(${size / 24})"><path d="${markPath}" fill="${fill}"/></g>`;
const svg = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
const icon = (size, rounded = false) => svg(size, size,
  rect(0, 0, size, size, palette.graphite, rounded ? size * .23 : 0)
  + mark(size * .15, size * .15, size * .7, palette.mineral));

const [wasm, ...fonts] = await Promise.all([
  'cloudflare/node_modules/@resvg/resvg-wasm/index_bg.wasm',
  'cloudflare/fonts/TokenHorizonSans-Regular.ttf',
  'cloudflare/fonts/TokenHorizonSans-SemiBold.ttf',
  'cloudflare/fonts/JetBrainsMono-Regular.ttf'
].map(path => readFile(root(path))));
await initWasm(wasm);
function raster(source) {
  const renderer = new Resvg(source, { font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Token Horizon Sans' } });
  const image = renderer.render();
  try { return Buffer.from(image.asPng()); }
  finally { image.free(); renderer.free(); }
}
async function output(path, contents) {
  if (check) {
    assert.deepEqual(await readFile(root(path)), Buffer.from(contents), `${path} is stale. Run node scripts/build-brand-assets.mjs.`);
  } else await writeFile(root(path), contents);
  console.log(`${check ? 'Verified' : 'Built'} ${path} (${Buffer.byteLength(contents)} bytes)`);
}
function ico(images) {
  // PNG-backed ICO entries are supported by current desktop browsers and Windows.
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

await output('docs/assets/favicon.svg', icon(64, true));
await output('docs/assets/safari-pinned-tab.svg', svg(24, 24, `<path d="${markPath}" fill="#000"/>`));
await output('docs/favicon-32x32.png', raster(icon(32, true)));
await output('docs/favicon-48x48.png', raster(icon(48, true)));
await output('docs/favicon.ico', ico([16, 32, 48, 64].map(size => ({ size, png: raster(icon(size, true)) }))));
for (const [path, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await output('docs/' + path, raster(icon(size)));
}
await output('docs/site.webmanifest', JSON.stringify({
  id: './', name: 'Token Horizon', short_name: 'Token Horizon',
  description: 'One clear view of AI usage, models and local observability.',
  start_url: './', scope: './', display: 'browser', lang: 'en',
  background_color: palette.mineral, theme_color: palette.graphite,
  icons: [192, 512].map(size => ({ src: `./icon-${size}.png?v=20261001-2`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' }))
}, null, 2) + '\n');

const embedded = {};
for (const path of ['brands/openai.svg', 'brands/anthropic.svg', 'brands/google.svg', 'brands/deepseek.svg', 'brands/mistral.svg', 'brands/ollama.svg', 'leagues/bronze.png', 'leagues/gold.png', 'leagues/grandmaster.png']) {
  const data = await readFile(root('docs/assets/' + path));
  embedded[path] = `data:image/${path.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${data.toString('base64')}`;
}
const image = (path, x, y, width, height = width, extra = '') => `<image x="${x}" y="${y}" width="${width}" height="${height}" href="${embedded[path]}" ${extra}/>`;

const cardPanel = contents => rect(722, 170, 406, 330, palette.graphite, 12) + contents;
const sampleBars = (x, y, width, heights, dark = true) => {
  const step = width / heights.length;
  return heights.map((height, index) => rect(x + index * step, y - height, step - 6, height, index % 3 === 0 ? (dark ? palette.mint : palette.forest) : (dark ? '#536C5E' : '#ABBDAF'), 2)).join('');
};
const heatmap = (x, y, columns = 14, size = 12, gap = 4) => {
  const fills = ['#28352D', '#385946', '#638F73', palette.mint];
  return Array.from({ length: columns * 4 }, (_, index) => rect(x + (index % columns) * (size + gap), y + Math.floor(index / columns) * (size + gap), size, size, fills[(index * 11 + Math.floor(index / columns) * 3) % 7 % 4], 2)).join('');
};

function illustration(kind) {
  if (kind === 'landing') return cardPanel(
    tag(750, 200, 'AT A GLANCE', '#CDD3CC', 11)
    + rect(795, 220, 260, 40, '#070A08', 13)
    + mark(810, 227, 24) + text(843, 246, 'Tokens · costs · limits', 15, palette.mineral)
    + rect(750, 281, 158, 155, palette.panel, 8) + tag(766, 310, 'USAGE', '#A5B8AB', 10)
    + sampleBars(766, 414, 126, [38, 54, 30, 73, 62, 88], true)
    + rect(923, 281, 177, 155, palette.panel, 8) + tag(939, 310, 'ACTIVITY', '#A5B8AB', 10)
    + heatmap(939, 330, 9, 12, 4)
    + text(750, 474, 'Notch. Widgets. Dashboard.', 18, palette.mineral)
  );
  if (kind === 'leaderboard') return cardPanel(
    tag(750, 201, 'YOUR NEXT LEAGUE', '#CDD3CC', 11)
    + image('leagues/bronze.png', 750, 265, 87)
    + image('leagues/gold.png', 845, 233, 136)
    + image('leagues/grandmaster.png', 989, 265, 87)
    + text(794, 394, 'Progress, together.', 25, palette.mineral, 600)
    + line(750, 415, 1100, 415, '#35423A')
    + text(750, 451, 'Activity', 16, '#B8C7BD') + text(1045, 451, 'Leagues', 16, '#B8C7BD')
    + sampleBars(829, 474, 150, [15, 23, 20, 31, 34, 39, 43], true)
  );
  if (kind === 'models') {
    const entries = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral'], ['ollama', 'Ollama']];
    return cardPanel(tag(750, 201, 'CLOUD + LOCAL', '#CDD3CC', 11) + entries.map(([key, label], index) => {
      const x = 750 + (index % 3) * 121, y = 230 + Math.floor(index / 3) * 115;
      const path = 'brands/' + key + '.svg';
      const padding = key === 'openai' ? -12 : 13;
      return `<clipPath id="logo-${key}">${rect(x + 21, y, 64, 64, '#FFF', 10)}</clipPath>`
        + rect(x + 21, y, 64, 64, key === 'google' ? '#FFF' : '#252A2A', 10, 'stroke="#35423A"')
        + image(path, x + 21 + padding, y + padding, 64 - padding * 2, 64 - padding * 2, `clip-path="url(#logo-${key})"`)
        + text(x + 53, y + 89, label, 16, palette.mineral, 400, 'text-anchor="middle"');
    }).join('') + text(750, 475, 'Capabilities. Prices. Plans.', 18, '#B8C7BD'));
  }
  if (kind === 'docs') return cardPanel(
    tag(750, 201, 'FROM INSTALL TO INTEGRATION', '#CDD3CC', 10)
    + [['01', 'Install', 'brew install --cask token-horizon'], ['02', 'Inspect', 'th stats'], ['03', 'Connect', 'Local API + MCP tools']].map(([number, label, command], index) => {
      const y = 231 + index * 80;
      return tag(750, y + 17, number, palette.mint, 12) + text(785, y + 18, label, 21, palette.mineral, 600)
        + `<text x="785" y="${y + 42}" font-family="JetBrains Mono" font-size="12" fill="#A5B8AB">${esc(command)}</text>`
        + (index < 2 ? line(750, y + 59, 1100, y + 59, '#35423A') : '');
    }).join('')
  );
  if (kind === 'blog' || kind === 'why-token-horizon') return cardPanel(
    tag(750, 201, 'NOTES FROM THE HORIZON', '#CDD3CC', 10)
    + rect(812, 249, 206, 189, '#35423A', 5) + rect(801, 236, 206, 189, '#E1E8E1', 5)
    + mark(824, 259, 44, palette.forest)
    + rect(824, 324, 127, 7, palette.graphite, 3) + rect(824, 342, 156, 5, '#849388', 2)
    + rect(824, 357, 147, 5, '#849388', 2) + rect(824, 372, 114, 5, '#849388', 2)
    + text(750, 475, kind === 'why-token-horizon' ? 'Provider-reported or absent.' : 'Build. Measure. Understand.', 18, '#B8C7BD')
  );
  if (kind === 'pricing-evidence') return cardPanel(
    tag(750, 201, 'THREE DISTINCT PRICING STATES', '#CDD3CC', 10)
    + [['Free', 'Explicit evidence'], ['Plan-covered', 'Included in a subscription'], ['Unpriced', 'No published price']].map(([label, detail], index) => {
      const y = 239 + index * 79;
      return rect(750, y, 350, 61, '#28352D', 6)
        + text(768, y + 26, label, 21, index === 0 ? palette.mint : palette.mineral, 600)
        + text(768, y + 47, detail, 14, '#A5B8AB');
    }).join('')
    + tag(750, 478, 'EVIDENCE FIRST.', palette.mint, 11)
  );
  if (kind === 'connect') return cardPanel(
    tag(750, 201, 'ONE LOCAL SOURCE OF TRUTH', '#CDD3CC', 10)
    + `<path d="M817 306H1015M915 306V412" stroke="#637C6A" stroke-width="2"/>`
    + rect(750, 266, 98, 80, '#28352D', 8) + text(799, 313, 'CLI', 25, palette.mineral, 600, 'text-anchor="middle"')
    + rect(982, 266, 98, 80, '#28352D', 8) + text(1031, 313, 'MCP', 25, palette.mineral, 600, 'text-anchor="middle"')
    + rect(875, 266, 80, 80, palette.mint, 40) + mark(885, 276, 60, palette.graphite)
    + rect(835, 387, 160, 48, '#28352D', 8) + text(915, 417, 'Your tools', 19, palette.mineral, 400, 'text-anchor="middle"')
    + text(750, 475, 'The same view. In your workflow.', 17, '#B8C7BD')
  );
  return cardPanel(
    tag(750, 201, kind === 'workspace' ? 'YOUR PRIVATE WORKSPACE' : 'YOUR ACCOUNT', '#CDD3CC', 11)
    + `<circle cx="925" cy="324" r="104" fill="none" stroke="#33463A"/><circle cx="925" cy="324" r="82" fill="none" stroke="#526B5B"/><circle cx="925" cy="324" r="60" fill="#070A08"/>`
    + mark(879, 278, 92, palette.mint)
    + `<path d="M781 323H1070" stroke="${palette.mint}" stroke-width="2"/>`
    + text(925, 469, kind === 'workspace' ? 'Private by default.' : 'Your data. Your call.', 23, palette.mineral, 600, 'text-anchor="middle"')
  );
}

const cards = [
  { id: 'landing', file: 'og', eyebrow: 'LOCAL AI OBSERVABILITY', title: ['Every token.', 'Every model.', 'One clear view.'], description: ['AI usage, costs and plan limits.', 'At your notch. On your desktop.'], footer: 'LOCAL TRACKING · OPTIONAL SHARING' },
  { id: 'leaderboard', eyebrow: 'THE TOKEN HORIZON COMMUNITY', title: ['Build alongside', 'the community.'], description: ['Follow usage, activity and league progress.', 'Share the stats you choose.'], footer: 'COMMUNITY · LEAGUES · ACTIVITY' },
  { id: 'models', eyebrow: 'THE OPEN MODEL CATALOG', title: ['Find the model', 'that fits.'], description: ['Compare models, providers and pricing.', 'Explore capabilities and subscription plans.'], footer: 'MODELS · PROVIDERS · PRICING · PLANS' },
  { id: 'docs', eyebrow: 'THE TOKEN HORIZON GUIDE', title: ['Your next token,', 'accounted for.'], description: ['Install, configure and connect your tools.', 'Understand your usage and your data.'], footer: 'INSTALL · LOCAL API · MCP · GATEWAY' },
  { id: 'blog', eyebrow: 'FROM THE TOKEN HORIZON BLOG', title: ['A clearer view', 'of AI.'], description: ['Product updates and engineering notes.', 'Ideas for more observable AI workflows.'], footer: 'UPDATES · ENGINEERING · OBSERVABILITY' },
  { id: 'why-token-horizon', eyebrow: 'FROM THE TOKEN HORIZON BLOG', title: ['Why Token', 'Horizon exists.'], description: ['A local-first view of your AI usage.', 'Honest numbers. Evidence behind every model.'], footer: 'VISION · LOCAL-FIRST OBSERVABILITY' },
  { id: 'pricing-evidence', eyebrow: 'PRICING EVIDENCE', title: ['Why zero', 'isn’t zero.'], description: ['Free, plan-covered and unpriced.', 'Different states. Different evidence.'], footer: 'CATALOG · PRICING · EVIDENCE' },
  { id: 'connect', eyebrow: 'TOKEN HORIZON IN YOUR WORKFLOW', title: ['One view.', 'Every workflow.'], description: ['Connect your CLI, coding agents and tools.', 'Explore Token Horizon through MCP.'], footer: 'CLI · API · MCP · CONNECTORS' },
  { id: 'workspace', eyebrow: 'YOUR TOKEN HORIZON WORKSPACE', title: ['The full picture.', 'Yours to explore.'], description: ['Usage, traces and optimisation insights.', 'Sign in to view your private workspace.'], footer: 'PRIVATE WORKSPACE · YOUR DATA' },
  { id: 'login', eyebrow: 'WELCOME TO TOKEN HORIZON', title: ['Your data.', 'Your call.'], description: ['Connect your profile and your team.', 'Choose what you share with the community.'], footer: 'PROFILE · TEAMS · OPTIONAL SHARING' }
];

for (const card of cards) {
  const name = card.file || `og-${card.id}`;
  const titleY = card.title.length === 3 ? 260 : 278;
  const titleSize = card.title.length === 3 ? 67 : 65;
  const body = rect(0, 0, 1200, 630, palette.mineral)
    + rect(0, 0, 1200, 106, palette.graphite)
    + mark(68, 29, 48, palette.mineral) + text(130, 66, 'Token Horizon', 30, palette.mineral, 600, 'letter-spacing="-1"')
    + tag(940, 62, 'token-horizon.dev', '#A5B8AB', 13)
    + tag(72, 182, card.eyebrow, palette.forest, 12)
    + card.title.map((value, index) => text(68, titleY + index * 70, value, titleSize, palette.graphite, 600, 'letter-spacing="-2.8"')).join('')
    + card.description.map((value, index) => text(72, 451 + index * 31, value, 22, palette.muted)).join('')
    + illustration(card.id)
    + line(72, 542, 1128, 542)
    + tag(72, 584, card.footer, palette.muted, 12)
    + mark(1098, 559, 32, palette.forest);
  const source = svg(1200, 630, body);
  const png = raster(source);
  assert.equal(png.readUInt32BE(16), 1200, `${name}: PNG width`);
  assert.equal(png.readUInt32BE(20), 630, `${name}: PNG height`);
  assert.ok(png.length < 250_000, `${name}: keep previews lightweight`);
  await output(`docs/assets/${name}.svg`, source);
  await output(`docs/assets/${name}.png`, png);
}
