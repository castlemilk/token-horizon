#!/usr/bin/env node
/**
 * Checks that the built report holds no model-written HTML and no frame that could run it.
 *
 *   npx tsx report/dist-check.mjs        (needs report/dist: run report/build.mjs first)
 *
 * The report page never runs model-written HTML (the captures run it once, in headless Chromium, with the network
 * blocked; see report/capture.mjs). So the built page must contain:
 *   1. no "iframe" and no "srcdoc" in its HTML and JavaScript (case-insensitive);
 *   2. no artifact text: three distinctive lines, each taken from a live record whose capture is on the board
 *      (its model and task have a capture of the same output in report/data/signals.json), must not appear
 *      anywhere in report/dist (text files only; the captured JPEGs are images);
 *   3. no dist/artifacts folder and no frame.js.
 *
 * Self-test: the search for artifact text is run on a temporary copy of dist into which one search line has been
 * written. It must find that line, so a search that cannot fail cannot pass. The copy is deleted afterwards.
 *
 * The stored outputs are read only. Nothing from them is printed: the report names each line by record index and
 * its length.
 *
 * Exit code 0 when every check passes; 1 otherwise.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const benchRoot = resolve(here, '..')
const dist = join(here, 'dist')
const resultsPath = join(benchRoot, 'lib/lab/llm-benchmark/results.json')
const signalsPath = join(here, 'data/signals.json')
const { isFullHtmlDoc } = await import('../lib/lab/llm-benchmark/frame-prelude.ts')

const TEXT_EXT = new Set(['.html', '.js', '.css', '.json', '.txt', '.svg', '.mjs'])
const NEEDLES_WANTED = 3

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist-check: report/dist is missing; run npx tsx report/build.mjs first')
  process.exit(1)
}

/** Every text file under a directory, as [path, text]. */
function textFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) textFiles(p, out)
    else if (TEXT_EXT.has(name.slice(name.lastIndexOf('.')).toLowerCase())) out.push([p, readFileSync(p, 'utf8')])
  }
  return out
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * A line that can identify an artifact: 40 to 160 characters with letters, not markup or a bare style or script
 * token, and it occurs once in its own output.
 */
function distinctiveLine(output) {
  const boilerplate = /^(<|\/\*|\/\/|[{}()\[\];]|@|[\w-]+\s*[{:]|html\b|body\b|\*\s*\{|:root|--|meta\b|title\b|doctype)/i
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 40 && l.length <= 160 && /[A-Za-z]{4}/.test(l) && !boilerplate.test(l))
    .find((l) => output.split(l).length === 2) ?? null
}

/**
 * Three search lines, each from a different task, taken from live records whose capture is on the board: the
 * record's output has the same SHA-256 as the one the capture was taken from.
 */
function pickNeedles() {
  if (!existsSync(signalsPath)) return { needles: [], reason: 'report/data/signals.json is missing' }
  const signals = JSON.parse(readFileSync(signalsPath, 'utf8')).cells ?? {}
  const records = JSON.parse(readFileSync(resultsPath, 'utf8'))
  const needles = []
  const tasks = new Set()
  records.forEach((r, index) => {
    if (needles.length >= NEEDLES_WANTED) return
    if (r.source !== 'live' || typeof r.output !== 'string' || !isFullHtmlDoc(r.output)) return
    if (tasks.has(r.taskId)) return
    const sig = signals[`${r.modelId}|${r.taskId}`]
    if (!sig || !Array.isArray(sig.shots) || sig.shots.length === 0) return
    if (sig.outputSha256 !== sha256(r.output)) return
    const line = distinctiveLine(r.output)
    if (!line) return
    needles.push({ index, line })
    tasks.add(r.taskId)
  })
  return { needles, reason: needles.length < NEEDLES_WANTED ? `only ${needles.length} captured live records give a search line` : '' }
}

/** Runs the three checks on a directory and returns the failures as labels. */
function scan(root, { needles, frameDir }) {
  const failures = []
  const files = textFiles(root)
  const pages = files.filter(([p]) => /\.(html|js)$/.test(p))
  const rel = (p) => p.slice(root.length + 1)
  for (const word of ['iframe', 'srcdoc']) {
    const hit = pages.filter(([, text]) => text.toLowerCase().includes(word)).map(([p]) => rel(p))
    if (hit.length) failures.push(`"${word}" in the built HTML or JavaScript: ${hit.join(', ')}`)
  }
  if (existsSync(join(root, 'artifacts'))) failures.push('a dist/artifacts folder')
  if (existsSync(join(root, 'frame.js'))) failures.push('a dist/frame.js')
  needles.forEach(({ index, line }) => {
    const found = files.filter(([, text]) => text.includes(line)).map(([p]) => rel(p))
    if (found.length) failures.push(`artifact text from record ${index} (${line.length} characters): ${found.join(', ')}`)
  })
  return failures
}

const failures = []
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

const { needles, reason } = pickNeedles()
check(needles.length === NEEDLES_WANTED, `${NEEDLES_WANTED} search lines from ${NEEDLES_WANTED} tasks, taken from captured live records${reason ? ' (' + reason + ')' : ''}`)

// Self-test: the scan must find a line written into a copy of dist, or it cannot be trusted to find one in dist.
if (needles.length === NEEDLES_WANTED) {
  const copy = mkdtempSync(join(tmpdir(), 'th-dist-check-'))
  try {
    cpSync(dist, copy, { recursive: true })
    mkdirSync(join(copy, 'data'), { recursive: true })
    writeFileSync(join(copy, 'data', 'self-test.js'), `window.__LEAK__ = ${JSON.stringify(needles[0].line)};\n`)
    const seeded = scan(copy, { needles })
    check(seeded.some((f) => f.includes(`record ${needles[0].index}`)), 'self-test: a search line written into a copy of dist is found')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

const found = scan(dist, { needles })
const frameFailures = found.filter((f) => !f.startsWith('artifact text'))
check(!frameFailures.some((f) => f.startsWith('"iframe"')), 'no "iframe" in the built HTML or JavaScript')
check(!frameFailures.some((f) => f.startsWith('"srcdoc"')), 'no "srcdoc" in the built HTML or JavaScript')
check(!existsSync(join(dist, 'artifacts')), 'no dist/artifacts folder (no artifact bundles)')
check(!existsSync(join(dist, 'frame.js')), 'no dist/frame.js')
for (const { index, line } of needles) {
  const hits = found.filter((f) => f.startsWith(`artifact text from record ${index} `))
  check(hits.length === 0, `artifact text from record ${index} (${line.length} characters) is not in report/dist${hits.length ? ': ' + hits.join('; ') : ''}`)
}

console.log(`${failures.length} failed check(s)`)
process.exitCode = failures.length ? 1 : 0
