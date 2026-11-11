#!/usr/bin/env node
/**
 * Builds the static report's data: report/dist/data/board.json and board.js.
 *
 *   npx tsx report/build-data.mjs [--now 2026-11-10T12:00:00.000Z]
 *
 * --target private (default) or public, and --out <dir> (or REPORT_TARGET, REPORT_OUT) pick the build; the public build needs --out.
 * --now (or REPORT_NOW) fixes generatedAt so repeated builds are byte-identical.
 * Without either, generatedAt is the current time. Reads only: results.json,
 * the registry, and report/data/signals.json when it exists. Writes only under
 * report/dist/data/ (or <out>/data/ with --out). Never prints record outputs.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const benchmarksRoot = resolve(here, '..')
const resultsPath = resolve(benchmarksRoot, 'lib/lab/llm-benchmark/results.json')
const signalsPath = resolve(here, 'data/signals.json')
let outDir = resolve(here, 'dist/data')

function argValue(name) {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return undefined
}

const now = argValue('--now') ?? process.env.REPORT_NOW ?? undefined
if (now !== undefined && Number.isNaN(Date.parse(now))) {
  console.error(`build-data: --now / REPORT_NOW is not an ISO timestamp: ${now}`)
  process.exit(1)
}

// The target: "private" (the owner's build, report/dist by default) or "public" (the site page, which needs --out).
const target = argValue('--target') ?? process.env.REPORT_TARGET ?? 'private'
if (target !== 'private' && target !== 'public') {
  console.error(`build-data: --target / REPORT_TARGET must be "private" or "public", not "${target}"`)
  process.exit(1)
}
const outRoot = argValue('--out') ?? process.env.REPORT_OUT ?? undefined
if (target === 'public' && !outRoot) {
  console.error('build-data: the public target needs --out <dir> (or REPORT_OUT)')
  process.exit(1)
}
if (outRoot !== undefined) outDir = resolve(outRoot, 'data')

const { buildBoard } = await import('../lib/lab/report/board.ts')
const registry = await import('../lib/lab/llm-benchmark/registry.ts')

const resultsBytes = readFileSync(resultsPath)
const resultsSha256 = createHash('sha256').update(resultsBytes).digest('hex')
const results = JSON.parse(resultsBytes.toString('utf8'))
if (!Array.isArray(results)) {
  console.error('build-data: results.json is not an array of records')
  process.exit(1)
}

let signals = null
if (existsSync(signalsPath)) {
  signals = JSON.parse(readFileSync(signalsPath, 'utf8'))
}

const board = buildBoard({
  results,
  models: registry.BENCHMARK_MODELS,
  tasks: registry.BENCHMARK_TASKS,
  categories: registry.BENCHMARK_CATEGORIES,
  signals,
  now,
  target,
  resultsSha256,
})

mkdirSync(outDir, { recursive: true })
const json = `${JSON.stringify(board, null, 2)}\n`
writeFileSync(resolve(outDir, 'board.json'), json)
writeFileSync(resolve(outDir, 'board.js'), `window.__BOARD__ = ${JSON.stringify(board)};\n`)

// A positive price under one cent per million tokens is far below every other priced model. It usually
// means a per-token price was entered in a per-1k field. Such a model has no measured cost on the page.
for (const m of board.models) {
  if (m.pricing !== 'price-under-review') continue
  console.warn(`build-data: warning: ${m.id} is priced at ${m.priceInPerM} (input) and ${m.priceOutPerM} (output) USD per million tokens; `
    + 'below the review threshold, so its cost is not measured on the page. Check the registry entry.')
}

const measuredCells = board.cells.length
console.log(`report data built (target ${board.source.target}, schema ${board.schemaVersion}, generatedAt ${board.generatedAt})`)
console.log(`  source: ${board.source.records} records, ${board.source.liveRecords} live, ${board.source.seededExcluded} seeded excluded`)
console.log(`  models: ${board.models.length}`)
console.log(`  tasks: ${board.tasks.length} (${board.tasks.filter((t) => t.headline).length} headline)`)
console.log(`  cells: ${measuredCells}`)
console.log(`  summaries: ${board.summaries.length}`)
console.log(`  signals: ${signals ? 'report/data/signals.json' : 'none (no signals file)'}`)
let findings = 0
for (const scope of Object.keys(board.insights)) {
  for (const group of Object.keys(board.insights[scope])) {
    const n = board.insights[scope][group].length
    findings += n
    console.log(`  insights ${scope}/${group}: ${n}`)
  }
}
console.log(`  insights: ${findings} across scopes and groups`)
console.log(`  wrote ${resolve(outDir, 'board.json')}`)
console.log(`  wrote ${resolve(outDir, 'board.js')}`)
