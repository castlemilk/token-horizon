// Bundles the dashboard's chart + avatar runtimes into docs/vendor/.
// Run with: npm run vendor   (installs devDependencies first)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function bundle(entry, outfile, banner) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    minify: true,
    target: ['es2020'],
    legalComments: 'none',
    outfile: path.join(root, outfile),
    banner: { js: banner }
  });
  console.log(`✓ wrote ${outfile}`);
}

await bundle(
  'scripts/vendor-entry.js',
  'docs/vendor/tanstack-charts.js',
  '/* @tanstack/charts v0.18.0 — vendored for Token Horizon; rebuild: npm run vendor */'
);

await bundle(
  'scripts/dicebear-entry.js',
  'docs/vendor/dicebear.js',
  '/* @dicebear/core v9 + selected styles — vendored for Token Horizon; rebuild: npm run vendor */'
);

await bundle(
  'scripts/fuse-entry.js',
  'docs/vendor/fuse.js',
  '/* fuse.js — vendored for Token Horizon model search; rebuild: npm run vendor */'
);

await bundle(
  'scripts/table-entry.js',
  'docs/vendor/tanstack-table.js',
  '/* @tanstack/table-core v9 — vendored for Token Horizon model sorting; rebuild: npm run vendor */'
);

await bundle(
  'scripts/three-entry.js',
  'docs/vendor/three.js',
  '/* Three.js r181 (MIT) — selected primitives for Token Horizon; rebuild: npm run vendor */'
);
// Upstream GLSL strings contain trailing spaces; normalize the generated file.
const threeBundle = path.join(root, 'docs/vendor/three.js');
await fs.writeFile(threeBundle, (await fs.readFile(threeBundle, 'utf8')).replace(/[\t ]+$/gm, ''));
await fs.copyFile(path.join(root, 'node_modules/three/LICENSE'), path.join(root, 'docs/vendor/three.LICENSE.txt'));
