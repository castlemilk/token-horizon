#!/usr/bin/env node
/**
 * Builds the static benchmark report.
 *
 *   npx tsx report/build.mjs [--no-data] [--now 2026-11-10T12:00:00.000Z]
 *   npx tsx report/build.mjs --target public --out <dir> [--now ...]
 *
 * Targets (--target, or REPORT_TARGET; --out, or REPORT_OUT, names the site folder):
 *   private (default) writes report/dist, the owner's build: every scope and the reproduce commands.
 *   public writes <dir>, the page at token-horizon.dev/benchmarks/: no earlier runs, no harness commands. <dir> may
 *     be outside the repo. It gets only the gallery images its board references; the fonts are served by the site.
 *
 * Steps:
 *   1. runs report/build-data.mjs (writes <out>/data/board.json and board.js for the target)
 *      unless --no-data is passed; --now is passed through to it;
 *   2. copies template/index.html and report.css to the out folder, and report.js; index.html keeps the blocks marked
 *      for this target (<!--@public-->...<!--/@public-->, <!--@private-->...<!--/@private-->) and drops the others;
 *      the public report.css points its fonts at /fonts/;
 *   3. copies the two product fonts into <out>/fonts/ (private only);
 *   4. generates <out>/tokens.css from the light and dark --th-* blocks of docs/theme.css, so the report stays in step
 *      with it;
 *   5. for the public target, copies the gallery images the board references into <out>/gallery/.
 *
 * report/dist/gallery is written by the capture step and is left in place. Bundles from the earlier frame design
 * (dist/artifacts, dist/frame.js) are removed from the private out folder: the page never runs model-written HTML, so
 * nothing of that kind is shipped. Prints the path of the index.html it built.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cssForTarget, forTarget, jsForTarget } from './target.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const benchRoot = resolve(here, '..')
const tokenRoot = resolve(benchRoot, '..')
const templateDir = join(here, 'template')
const privateOut = join(here, 'dist')
const themeCss = join(tokenRoot, 'docs', 'theme.css')
const fontsDir = join(tokenRoot, 'docs', 'fonts')
const FONTS = ['HubotSansVF-Regular.ttf', 'JetBrainsMono-Regular.ttf']
const TARGETS = ['private', 'public']

const argv = process.argv.slice(2)
const noData = argv.includes('--no-data')
const passthrough = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--now') {
    passthrough.push('--now', argv[i + 1])
    i++
  } else if (argv[i].startsWith('--now=')) {
    passthrough.push(argv[i])
  }
}

function argValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

const target = argValue('--target') ?? process.env.REPORT_TARGET ?? 'private'
if (!TARGETS.includes(target)) {
  console.error(`build: --target / REPORT_TARGET must be "private" or "public", not "${target}"`)
  process.exit(1)
}
const outArg = argValue('--out') ?? process.env.REPORT_OUT ?? undefined
if (target === 'public' && !outArg) {
  console.error('build: the public target needs --out <dir> (or REPORT_OUT)')
  process.exit(1)
}
const out = outArg ? resolve(outArg) : privateOut

if (!noData) {
  const run = spawnSync('npx', ['tsx', 'report/build-data.mjs', '--target', target, '--out', out, ...passthrough], {
    cwd: benchRoot,
    stdio: 'inherit'
  })
  if (run.status !== 0) {
    console.error('build: data build failed; the page was not rebuilt')
    process.exit(run.status ?? 1)
  }
}

mkdirSync(out, { recursive: true })
for (const stale of ['artifacts', 'frame.js']) rmSync(join(out, stale), { recursive: true, force: true })

writeFileSync(join(out, 'report.js'), jsForTarget(readFileSync(join(templateDir, 'report.js'), 'utf8'), target))
writeFileSync(join(out, 'index.html'), forTarget(readFileSync(join(templateDir, 'index.html'), 'utf8'), target))
writeFileSync(join(out, 'report.css'), cssForTarget(readFileSync(join(templateDir, 'report.css'), 'utf8'), target))

if (target === 'private') {
  mkdirSync(join(out, 'fonts'), { recursive: true })
  for (const font of FONTS) {
    const src = join(fontsDir, font)
    if (!existsSync(src)) throw new Error(`build: missing font ${src}`)
    copyFileSync(src, join(out, 'fonts', font))
  }
}

/** The --th-* declarations (and colour-scheme) inside the first block that matches. */
function declarations(css, pattern, label) {
  const match = css.match(pattern)
  if (!match) throw new Error(`build: could not find the ${label} block in docs/theme.css`)
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^--th-[\w-]+\s*:/.test(line))
}

const css = readFileSync(themeCss, 'utf8')
const light = declarations(css, /:root,\s*html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/, 'light')
const dark = declarations(css, /\nhtml\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/, 'dark')
if (light.length < 10 || dark.length < 10) throw new Error('build: theme.css blocks look incomplete')
const tokens = [
  '/* Generated by report/build.mjs from docs/theme.css. Do not edit. */',
  ':root, html[data-theme="light"] {',
  '  color-scheme: light;',
  ...light.map((d) => `  ${d}`),
  '}',
  'html[data-theme="dark"] {',
  '  color-scheme: dark;',
  ...dark.map((d) => `    ${d}`),
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root:not([data-theme="light"]) {',
  '    color-scheme: dark;',
  ...dark.map((d) => `    ${d}`),
  '  }',
  '}',
  ''
].join('\n')
writeFileSync(join(out, 'tokens.css'), tokens)

if (target === 'public') {
  // Only the gallery images the board names are shipped. The board is the list: a shot it does not reference stays out.
  const board = JSON.parse(readFileSync(join(out, 'data', 'board.json'), 'utf8'))
  const shots = [...new Set(board.cells.flatMap((c) => c.shots))]
  rmSync(join(out, 'gallery'), { recursive: true, force: true })
  for (const shot of shots) {
    const src = join(privateOut, shot.replace(/^dist\//, ''))
    if (!existsSync(src)) throw new Error(`build: the board names ${shot}, which is not in report/dist; run capture first`)
    const dest = join(out, shot.replace(/^dist\//, ''))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  console.log(`  gallery: ${shots.length} images copied from report/dist/gallery`)
}

const indexPath = join(out, 'index.html')
console.log(`report built (${target}): ${light.length} light and ${dark.length} dark tokens from docs/theme.css`)
console.log(indexPath)
console.log(`open: file://${indexPath}`)
