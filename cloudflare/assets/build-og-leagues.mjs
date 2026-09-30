import { readFile, writeFile } from 'node:fs/promises';
import { Resvg, initWasm } from '../node_modules/@resvg/resvg-wasm/index.mjs';

// Bake the dashboard's canonical artwork into small, self-contained social-card
// images. This runs at build time: requests perform no asset fetch or resizing.
const leagues = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'];
const root = relative => new URL('../../' + relative, import.meta.url);
await initWasm(await readFile(root('cloudflare/node_modules/@resvg/resvg-wasm/index_bg.wasm')));
const lines = [];
for (const league of leagues) {
  const source = await readFile(root(`docs/assets/leagues/${league}.png`));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><image width="128" height="128" href="data:image/png;base64,${source.toString('base64')}"/></svg>`;
  const renderer = new Resvg(svg, { font: { loadSystemFonts: false } });
  const image = renderer.render();
  try {
    const png = Buffer.from(image.asPng());
    lines.push(`  ${league}: "data:image/png;base64,${png.toString('base64')}"`);
    console.log(`OG league: ${league} · ${source.length} → ${png.length} bytes`);
  } finally {
    image.free();
    renderer.free();
  }
}
const output = `// Generated from docs/assets/leagues/*.png by task web-og-leagues.\n// 128px transparent thumbnails; never fetch external artwork at request time.\nconst icons = {\n${lines.join(',\n')}\n};\n\nexport function ogLeagueIcon(league) {\n  return typeof league === "string" && Object.hasOwn(icons, league) ? icons[league] : "";\n}\n`;
const destination = root('cloudflare/src/og-league-assets.js');
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw new Error('OG league assets differ from the dashboard artwork. Run task web-og-leagues.');
  console.log('OG league assets match the canonical dashboard artwork.');
} else await writeFile(destination, output);
