// Bundles the dashboard's chart + avatar runtimes into docs/vendor/.
// Run with: npm run vendor   (installs devDependencies first)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
