#!/usr/bin/env npx tsx
/**
 * CAPTURE step of the static benchmark report.
 *
 * Renders stored model-written HTML artifacts in headless Chromium, with the network blocked, and
 * writes two images per cell and the measurements behind them:
 *
 *   report/dist/gallery/<taskId>/<modelId>-a.jpg   capture 1: 1024 x 720 viewport, 768 x 540 JPEG
 *   report/dist/gallery/<taskId>/<modelId>-b.jpg   capture 2: 390 x 844 viewport, 250 x 540 JPEG
 *   report/data/signals.json                        per-cell measurements and the capture notes
 *
 * The artifact is never written out as a file and never reaches the report page. The report page shows
 * only the images and the stored numbers. Each capture is taken after the task's showcase pose (pose.ts
 * under plugins/horizon-suite/tasks/<id>/, when the task has one), so every model's artifact for a task
 * is shown in the same state. A task without a pose is captured in the state the artifact reaches on load.
 *
 * Model-written HTML is untrusted. It only ever runs inside this headless browser. The browser cannot reach
 * the network: every connection goes to a proxy that is not listening, WebRTC may not send UDP outside that
 * proxy, and every request is also aborted at the route level (see report/capture-browser.mjs). The isolation
 * test, report/capture-isolation-test.mjs, checks this with a hostile artifact. It is never opened in a
 * normal browser.
 *
 * Usage (from the benchmarks directory):
 *   npx tsx report/capture.mjs                       # default cell set
 *   npx tsx report/capture.mjs --models a,b --tasks x,y --limit 5
 *   npx tsx report/capture.mjs --force               # re-capture unchanged cells
 *   npx tsx report/capture.mjs --concurrency 1       # sequential (rAF figures are quieter)
 *
 * Options:
 *   --models a,b      model ids. Default: every Anthropic model in the registry, plus the
 *                     8 other models with the highest mean live score over tasks that have
 *                     a pluginId. The default also takes every scorer-version-2 cell of a
 *                     browser-scored task, whatever its model, so the report's current cells
 *                     all have captures. --models turns that off.
 *   --tasks a,b       task ids. Default: every browser-scored (behavioral) task.
 *   --limit N         keep the first N selected cells (sorted by task, then model).
 *   --force           re-capture even when the stored outputSha256 is unchanged.
 *   --concurrency N   pages open at once, 1 to 4 (default 2).
 *
 * Paths in signals.json are relative to the report directory (the folder this script lives in).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BENCHMARK_MODELS, BENCHMARK_TASKS } from '../lib/lab/llm-benchmark/registry.ts'
import { behavioralTaskIds } from '../lib/lab/llm-benchmark/scorers/index.ts'
import { isFullHtmlDoc, withPrelude } from '../lib/lab/llm-benchmark/frame-prelude.ts'
import { resolveSandboxPolicy } from '../lib/lab/llm-benchmark/scorers/sandbox-backend.ts'
import { safeFileName } from '../lib/lab/report/artifact-js.ts'
import { CURRENT_SCORER_VERSION } from '../lib/lab/report/board.ts'
import { captureContextOptions, captureLaunchOptions } from './capture-browser.mjs'

// Playwright reads PLAYWRIGHT_BROWSERS_PATH when it is first imported, so it is set
// before the dynamic import in main(). The shared benchmark cache holds the binary.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), 'Library/Caches/ms-playwright-benchmarks')

const REPORT_DIR = dirname(fileURLToPath(import.meta.url))
const BENCH_DIR = join(REPORT_DIR, '..')
const RESULTS_PATH = join(BENCH_DIR, 'lib/lab/llm-benchmark/results.json')
const SIGNALS_PATH = join(REPORT_DIR, 'data/signals.json')
const DIST_DIR = join(REPORT_DIR, 'dist')
const GALLERY_DIR = join(DIST_DIR, 'gallery')
const POSE_ROOT = join(BENCH_DIR, 'lib/lab/llm-benchmark/plugins/horizon-suite/tasks')

const DESKTOP = { width: 1024, height: 720 }
const PHONE = { width: 390, height: 844 }
const DESKTOP_SHOT = { width: 768, height: 540 }
const PHONE_SHOT = { width: 250, height: 540 }
const JPEG_QUALITY = 68
const SETTLE_MS = 1500
const RAF_WINDOW_MS = 2000
const CELL_TIMEOUT_MS = 120_000
const MAX_MESSAGES = 20
const MESSAGE_CHARS = 300
const DEFAULT_CONCURRENCY = 2
const EXTRA_ANTHROPIC_RANK_SLOTS = 8
const HELPER_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>'

// ── argument handling ──────────────────────────────────────────────────

function usage(code) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith(' *'))
    .map((l) => l.replace(/^ \* ?/, ''))
    .slice(0, 24)
    .join('\n')
  process.stdout.write(text + '\n')
  process.exit(code)
}

function parseArgs(argv) {
  const opts = { models: undefined, tasks: undefined, limit: undefined, force: false, concurrency: DEFAULT_CONCURRENCY }
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean)
  const positive = (v, flag) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer, got "${v}"`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--models': opts.models = list(value()); break
      case '--tasks': opts.tasks = list(value()); break
      case '--limit': opts.limit = positive(value(), arg); break
      case '--force': opts.force = true; break
      case '--concurrency': opts.concurrency = Math.min(4, positive(value(), arg)); break
      case '--help': case '-h': usage(0); break
      default: throw new Error(`unknown argument "${arg}" (try --help)`)
    }
  }
  return opts
}

// ── selection ──────────────────────────────────────────────────────────

/**
 * The default model set: every Anthropic model, then the top ranked others by
 * mean live score over plugin-contributed tasks. Returns the ranking too so the
 * run can print what it was based on.
 */
function defaultModelSelection(records) {
  const anthropic = BENCHMARK_MODELS.filter((m) => m.company === 'Anthropic').map((m) => m.id)
  const pluginTaskIds = new Set(BENCHMARK_TASKS.filter((t) => t.pluginId).map((t) => t.id))
  const totals = new Map()
  for (const r of records) {
    if (r.source !== 'live' || !pluginTaskIds.has(r.taskId) || !Number.isFinite(r.score)) continue
    if (anthropic.includes(r.modelId)) continue
    const t = totals.get(r.modelId) ?? { sum: 0, n: 0 }
    t.sum += r.score
    t.n += 1
    totals.set(r.modelId, t)
  }
  const ranking = [...totals]
    .map(([id, t]) => ({ id, mean: t.sum / t.n, n: t.n }))
    .sort((a, b) => b.mean - a.mean || a.id.localeCompare(b.id))
  const others = ranking.slice(0, EXTRA_ANTHROPIC_RANK_SLOTS).map((r) => r.id)
  return { models: [...anthropic, ...others], ranking }
}

/**
 * One record per model and browser-scored task (the newest, should there ever be two), HTML outputs only. A record is
 * selected when its model is in modelIds, or, with `allCurrent`, when it is scored by the current scorer (version 2 or
 * later), whatever its model.
 */
function selectCells(records, modelIds, taskIds, browserTasks, allCurrent) {
  const modelSet = new Set(modelIds)
  const taskSet = new Set(taskIds)
  const newest = new Map()
  for (const r of records) {
    if (r.source !== 'live') continue
    if (!taskSet.has(r.taskId) || !browserTasks.has(r.taskId)) continue
    const current = allCurrent && (r.scorerVersion ?? 1) >= CURRENT_SCORER_VERSION
    if (!modelSet.has(r.modelId) && !current) continue
    if (typeof r.output !== 'string' || !isFullHtmlDoc(r.output)) continue
    const key = `${r.modelId}|${r.taskId}`
    const prev = newest.get(key)
    if (!prev || String(r.createdAt) > String(prev.createdAt)) newest.set(key, r)
  }
  return [...newest.values()].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.modelId.localeCompare(b.modelId))
}

/**
 * The showcase pose of every horizon task that has one: pose.ts exports a JavaScript source string,
 * evaluated in the artifact page after load. Tasks without a pose are not listed.
 */
async function loadPoses(taskIds) {
  const poses = new Map()
  for (const id of taskIds) {
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const file = join(POSE_ROOT, id, 'pose.ts')
    if (!existsSync(file)) continue
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.pose === 'string' && mod.pose.trim() !== '') poses.set(id, mod.pose)
  }
  return poses
}

// ── in-page measurements (run inside the artifact page) ────────────────

/** Callbacks per second over a RAF_WINDOW_MS window. A guard timer resolves a stalled page as 0. */
function measureRafInPage(windowMs) {
  return new Promise((resolve) => {
    let frames = 0
    let done = false
    const start = performance.now()
    const finish = () => {
      if (done) return
      done = true
      const elapsed = (performance.now() - start) / 1000
      resolve(elapsed > 0 ? frames / elapsed : 0)
    }
    const tick = () => {
      if (done) return
      frames += 1
      if (performance.now() - start < windowMs) requestAnimationFrame(tick)
      else finish()
    }
    requestAnimationFrame(tick)
    setTimeout(finish, windowMs + 500)
  })
}

function domFactsInPage() {
  return {
    domElements: document.querySelectorAll('*').length,
    hasCanvas: document.querySelector('canvas') !== null,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }
}

// ── in-helper measurements (the helper page never runs artifact code) ──

/**
 * Parse the artifact text with DOMParser (inert: scripts do not run and nothing
 * is fetched) and count the text-level signals. `html` is the raw model output.
 */
function measureTextInHelper(html) {
  const named = (s) => typeof s === 'string' && s.trim() !== ''
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '')
  const doc = new DOMParser().parseFromString(html, 'text/html')

  const labelsFor = new Map()
  for (const label of doc.querySelectorAll('label[for]')) {
    const id = label.getAttribute('for')
    labelsFor.set(id, [...(labelsFor.get(id) ?? []), label])
  }

  const hasName = (el) => {
    if (named(el.getAttribute('aria-label'))) return true
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').trim()
    if (labelledBy && labelledBy.split(/\s+/).some((id) => named(text(doc.getElementById(id))))) return true
    if (named(el.getAttribute('title'))) return true
    const tag = el.tagName.toLowerCase()
    if (tag === 'button') {
      if (named(text(el))) return true
      for (const img of el.querySelectorAll('img[alt]')) if (named(img.getAttribute('alt'))) return true
      for (const svgTitle of el.querySelectorAll('svg > title')) if (named(text(svgTitle))) return true
      return false
    }
    // input
    const type = (el.getAttribute('type') ?? 'text').toLowerCase()
    if (type === 'image') return named(el.getAttribute('alt'))
    if ((type === 'button' || type === 'submit' || type === 'reset') && named(el.getAttribute('value'))) return true
    if (el.id && (labelsFor.get(el.id) ?? []).some((l) => named(text(l)))) return true
    const wrapping = el.closest('label')
    return wrapping !== null && named(text(wrapping))
  }

  const buttons = [...doc.querySelectorAll('button')]
  const inputs = [...doc.querySelectorAll('input')].filter(
    (i) => (i.getAttribute('type') ?? '').toLowerCase() !== 'hidden'
  )
  const unnamedControls = [...buttons, ...inputs].filter((el) => !hasName(el)).length

  return {
    inlineScripts: [...doc.querySelectorAll('script')].filter((s) => !s.hasAttribute('src')).length,
    inlineStyles: doc.querySelectorAll('style').length,
    hasLang: named(doc.documentElement.getAttribute('lang')),
    imagesMissingAlt: [...doc.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt')).length,
    unnamedControls,
  }
}

/**
 * Downscale a PNG screenshot to the given size and encode it as JPEG at quality 68.
 * Uses createImageBitmap on a Blob, which is never tainted, so getImageData works.
 * Also counts the distinct colours on a coarse grid: 2 or fewer means flat.
 */
function scaleInHelper({ pngBase64, width, height, quality }) {
  return (async () => {
    const bin = atob(pngBase64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)
    const seen = new Set()
    for (let y = 0; y < height; y += 12) {
      for (let x = 0; x < width; x += 12) {
        const o = (y * width + x) * 4
        seen.add(((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4))
      }
    }
    return { jpegDataUrl: canvas.toDataURL('image/jpeg', quality / 100), distinctColours: seen.size }
  })()
}

// ── one cell ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const truncate = (s) => String(s ?? '').slice(0, MESSAGE_CHARS)
const round1 = (n) => Math.round(n * 10) / 10
const round100 = (ms) => Math.round(ms / 100) * 100

function emptySignals() {
  return {
    pageErrors: [],
    consoleErrors: [],
    blockedRequests: null,
    poseError: null,
    rafPerSec: null,
    domElements: null,
    hasCanvas: null,
    overflowsAt1024: null,
    overflowsAt390: null,
    bytes: null,
    lines: null,
    inlineScripts: null,
    inlineStyles: null,
    hasLang: null,
    imagesMissingAlt: null,
    unnamedControls: null,
  }
}

/**
 * Loads the artifact in the page, waits, applies the task's showcase pose when it has one, waits again.
 * Returns when the screenshot may be taken, with the load time and whether the pose was applied.
 * A pose that throws, or reports that it did not apply, is recorded and the capture still goes ahead.
 */
async function showArtifact(page, loaded, pose, signals) {
  await page.setContent(loaded, { waitUntil: 'domcontentloaded', timeout: 10_000 })
  const loadedAt = Date.now()
  await sleep(SETTLE_MS)
  let posed = false
  if (pose) {
    try {
      const result = await page.evaluate(`(${pose})()`)
      const notApplied = result === false || (result !== null && typeof result === 'object' && result.ok === false)
      if (notApplied) signals.poseError = 'pose reported that it did not apply'
      else posed = true
    } catch (e) {
      signals.poseError = truncate(e instanceof Error ? e.message : String(e))
    }
    await sleep(SETTLE_MS)
  }
  return { loadedAt, posed }
}

/**
 * Capture one artifact in its own browser context. Never throws: any failure is
 * returned as `error`, with whatever was measured before it.
 *
 * `state.context` is set as soon as the context exists, so the caller can close
 * it when the cell runs over its time limit.
 */
async function captureCell(browser, policy, html, pose, state, stats) {
  const signals = emptySignals()
  const shots = []
  const captures = []
  const blockedHosts = new Map()
  let blocked = 0
  let error

  const context = await browser.newContext(captureContextOptions(DESKTOP))
  state.context = context
  try {
    // Second layer, after the proxy: every request is aborted except about:blank and data: URLs.
    await context.route('**/*', (route) => {
      const url = route.request().url()
      if (url === 'about:blank' || url.startsWith('data:')) return route.continue()
      blocked += 1
      let host = '(unparsed)'
      try {
        host = new URL(url).host || url.slice(0, 40)
      } catch {
        // keep the placeholder
      }
      blockedHosts.set(host, (blockedHosts.get(host) ?? 0) + 1)
      return route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', (ws) => {
      blocked += 1
      ws.close({ code: 1008, reason: 'blocked by capture' })
    })

    // The helper page runs no artifact code. It parses, scales and measures.
    const helper = await context.newPage()
    await helper.setContent(HELPER_HTML)

    const page = await context.newPage()
    let recording = true
    page.on('pageerror', (e) => {
      if (recording && signals.pageErrors.length < MAX_MESSAGES) signals.pageErrors.push(truncate(e.message))
    })
    page.on('console', (msg) => {
      if (recording && msg.type() === 'error' && signals.consoleErrors.length < MAX_MESSAGES) {
        signals.consoleErrors.push(truncate(msg.text()))
      }
    })
    // An artifact that calls alert()/confirm() would otherwise freeze the page.
    page.on('dialog', (d) => d.dismiss().catch(() => {}))

    const loaded = policy.preludeParity ? withPrelude(html) : html

    // Capture 1: the desktop viewport, after the showcase pose.
    await page.setViewportSize(DESKTOP)
    const desktop = await showArtifact(page, loaded, pose, signals)
    const shotA = await page.screenshot({ type: 'png', timeout: 15_000 })
    const afterA = round100(Date.now() - desktop.loadedAt)
    const scaledA = await helper.evaluate(scaleInHelper, {
      pngBase64: shotA.toString('base64'),
      ...DESKTOP_SHOT,
      quality: JPEG_QUALITY,
    })
    shots.push({ buffer: Buffer.from(scaledA.jpegDataUrl.split(',')[1], 'base64'), colours: scaledA.distinctColours })
    captures.push({ viewport: `${DESKTOP.width} x ${DESKTOP.height}`, afterLoadMs: afterA, posed: desktop.posed })

    signals.rafPerSec = round1(await page.evaluate(measureRafInPage, RAF_WINDOW_MS))
    const dom = await page.evaluate(domFactsInPage)
    signals.domElements = dom.domElements
    signals.hasCanvas = dom.hasCanvas
    signals.overflowsAt1024 = dom.scrollWidth > dom.innerWidth

    // Text-level facts, from the raw model output.
    const text = await helper.evaluate(measureTextInHelper, html)
    signals.bytes = Buffer.byteLength(html, 'utf8')
    signals.lines = html.split('\n').length
    Object.assign(signals, {
      inlineScripts: text.inlineScripts,
      inlineStyles: text.inlineStyles,
      hasLang: text.hasLang,
      imagesMissingAlt: text.imagesMissingAlt,
      unnamedControls: text.unnamedControls,
    })

    // Requests blocked up to here: the desktop phase.
    signals.blockedRequests = blocked

    // Capture 2: the phone viewport, the artifact loaded again at that width and posed the same way.
    recording = false
    await page.setViewportSize(PHONE)
    const phone = await showArtifact(page, loaded, pose, signals)
    const narrow = await page.evaluate(domFactsInPage)
    signals.overflowsAt390 = narrow.scrollWidth > narrow.innerWidth
    const shotB = await page.screenshot({ type: 'png', timeout: 15_000 })
    const afterB = round100(Date.now() - phone.loadedAt)
    const scaledB = await helper.evaluate(scaleInHelper, {
      pngBase64: shotB.toString('base64'),
      ...PHONE_SHOT,
      quality: JPEG_QUALITY,
    })
    shots.push({ buffer: Buffer.from(scaledB.jpegDataUrl.split(',')[1], 'base64'), colours: scaledB.distinctColours })
    captures.push({ viewport: `${PHONE.width} x ${PHONE.height}`, afterLoadMs: afterB, posed: phone.posed })

    await page.close().catch(() => {})
    await helper.close().catch(() => {})
  } catch (e) {
    error = `${e instanceof Error ? e.message : String(e)}`.split('\n')[0].slice(0, 400)
  } finally {
    await context.close().catch(() => {})
    state.context = undefined
  }
  for (const [host, n] of blockedHosts) stats.blockedHosts.set(host, (stats.blockedHosts.get(host) ?? 0) + n)
  return { signals, shots, captures, error }
}

function removeStaleShots(paths) {
  for (const p of paths) rmSync(p, { force: true })
}

// ── driver ─────────────────────────────────────────────────────────────

function loadSignals() {
  if (!existsSync(SIGNALS_PATH)) return { generatedAt: null, cells: {} }
  try {
    const doc = JSON.parse(readFileSync(SIGNALS_PATH, 'utf8'))
    return { generatedAt: doc.generatedAt ?? null, cells: doc.cells ?? {} }
  } catch (e) {
    console.warn(`warning: ${SIGNALS_PATH} is unreadable (${e.message}); starting it fresh`)
    return { generatedAt: null, cells: {} }
  }
}

function saveSignals(doc) {
  mkdirSync(dirname(SIGNALS_PATH), { recursive: true })
  const tmp = `${SIGNALS_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
  renameSync(tmp, SIGNALS_PATH)
}

function dirSize(dir) {
  if (!existsSync(dir)) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        bytes += statSync(p).size
        files += 1
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`)

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const policy = resolveSandboxPolicy()
  if (policy.backend !== 'chromium') {
    throw new Error(`capture needs the local chromium backend; BENCH_SANDBOX resolves to "${policy.backend}"`)
  }

  const records = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'))
  const browserTasks = behavioralTaskIds(BENCHMARK_TASKS)
  const registeredModels = new Set(BENCHMARK_MODELS.map((m) => m.id))
  const registeredTasks = new Set(BENCHMARK_TASKS.map((t) => t.id))

  let modelIds
  let ranking = []
  if (opts.models) {
    modelIds = opts.models
    for (const id of modelIds) if (!registeredModels.has(id)) console.warn(`warning: model "${id}" is not in the registry`)
  } else {
    const def = defaultModelSelection(records)
    modelIds = def.models
    ranking = def.ranking
  }

  let taskIds
  if (opts.tasks) {
    taskIds = opts.tasks.filter((id) => {
      if (!registeredTasks.has(id)) {
        console.warn(`warning: task "${id}" is not in the registry; ignored`)
        return false
      }
      if (!browserTasks.has(id)) {
        console.warn(`warning: task "${id}" is not browser-scored; ignored`)
        return false
      }
      return true
    })
  } else {
    taskIds = [...browserTasks]
  }

  // The default takes every current-scorer cell of a browser-scored task as well as the model selection; --models turns that off.
  let cells = selectCells(records, modelIds, taskIds, browserTasks, opts.models === undefined)
  if (opts.limit !== undefined) cells = cells.slice(0, opts.limit)
  const currentCells = cells.filter((c) => (c.scorerVersion ?? 1) >= CURRENT_SCORER_VERSION).length
  const poses = await loadPoses(new Set(cells.map((c) => c.taskId)))

  console.log(`results: ${records.length} records; models: ${modelIds.length}; tasks: ${taskIds.length}`)
  if (ranking.length > 0) {
    const top = ranking.slice(0, EXTRA_ANTHROPIC_RANK_SLOTS)
    console.log(
      `default extra models (mean live score on plugin tasks): ` +
        top.map((r) => `${r.id} ${r.mean.toFixed(1)} (n=${r.n})`).join(', ')
    )
  }
  console.log(`showcase poses: ${poses.size} tasks (${[...poses.keys()].sort().join(', ') || 'none'})`)
  console.log(`cells selected: ${cells.length} (${currentCells} scorer-version-${CURRENT_SCORER_VERSION} or later); concurrency ${opts.concurrency}; force=${opts.force}`)
  if (cells.length === 0) {
    console.log('nothing to capture')
    return
  }

  const doc = loadSignals()
  const stats = { captured: 0, skipped: 0, failed: [], blank: [], blockedHosts: new Map(), cellMs: [], posed: 0 }
  const started = Date.now()

  const { chromium } = await import('playwright')
  const browser = await chromium.launch(captureLaunchOptions())
  let next = 0
  let done = 0

  async function runCell(cell) {
    const key = `${cell.modelId}|${cell.taskId}`
    const safeModel = safeFileName(cell.modelId)
    const safeTask = safeFileName(cell.taskId)
    const shotRels = [`dist/gallery/${safeTask}/${safeModel}-a.jpg`, `dist/gallery/${safeTask}/${safeModel}-b.jpg`]
    const outputSha256 = sha256(cell.output)
    const pose = poses.get(cell.taskId) ?? null

    const prev = doc.cells[key]
    const unchanged =
      prev &&
      prev.outputSha256 === outputSha256 &&
      !prev.error &&
      Array.isArray(prev.captures) &&
      prev.captures.length === 2 &&
      prev.poseId === (pose ? cell.taskId : null) &&
      shotRels.every((p) => existsSync(join(REPORT_DIR, p)))
    if (!opts.force && unchanged) {
      stats.skipped += 1
      done += 1
      console.log(`[${String(done).padStart(3)}/${cells.length}] ${cell.modelId} ${cell.taskId} skipped (unchanged)`)
      return
    }

    const t0 = Date.now()
    const state = {}
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cell timed out after ${CELL_TIMEOUT_MS} ms`)), CELL_TIMEOUT_MS)
    })
    let outcome
    try {
      outcome = await Promise.race([captureCell(browser, policy, cell.output, pose, state, stats), timeout])
    } catch (e) {
      await state.context?.close().catch(() => {})
      outcome = { signals: emptySignals(), shots: [], captures: [], error: e.message }
    } finally {
      clearTimeout(timer)
    }
    const ms = Date.now() - t0
    stats.cellMs.push(ms)

    const { signals, error, captures } = outcome
    if (captures.some((c) => c.posed)) stats.posed += 1
    const absShots = shotRels.map((p) => join(REPORT_DIR, p))
    if (error) {
      removeStaleShots(absShots)
      stats.failed.push({ key, error })
    } else {
      mkdirSync(join(GALLERY_DIR, safeTask), { recursive: true })
      outcome.shots.forEach((shot, i) => writeFileSync(absShots[i], shot.buffer))
      stats.captured += 1
      if (outcome.shots.every((s) => s.colours <= 2)) stats.blank.push(key)
    }

    doc.cells[key] = {
      outputSha256,
      poseId: pose ? cell.taskId : null,
      signals,
      shots: error ? [] : shotRels,
      captures: error ? [] : captures,
      ...(error ? { error } : {}),
    }
    doc.generatedAt = new Date().toISOString()
    saveSignals(doc)

    done += 1
    const flat = error ? '' : ` flat=${outcome.shots.map((s) => (s.colours <= 2 ? 'y' : 'n')).join('')}`
    const errs = `pageErrors=${signals.pageErrors.length} consoleErrors=${signals.consoleErrors.length}`
    const blocked = `blocked=${signals.blockedRequests ?? '-'}`
    const posed = pose ? ` pose=${captures.length && captures[0].posed ? 'y' : 'n'}` : ''
    const tail = error ? `  ERROR: ${error}` : ''
    console.log(
      `[${String(done).padStart(3)}/${cells.length}] ${cell.modelId} ${cell.taskId} ${ms}ms ${errs} ${blocked}${posed}${flat}${tail}`
    )
  }

  try {
    const workers = Array.from({ length: Math.min(opts.concurrency, cells.length) }, async () => {
      while (next < cells.length) {
        const cell = cells[next++]
        await runCell(cell)
      }
    })
    await Promise.all(workers)
  } finally {
    await browser.close().catch(() => {})
  }

  // ── summary ──
  const gallery = dirSize(GALLERY_DIR)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const sortedMs = [...stats.cellMs].sort((a, b) => a - b)
  const median = sortedMs.length ? sortedMs[Math.floor(sortedMs.length / 2)] : 0
  const hostRank = [...stats.blockedHosts].sort((a, b) => b[1] - a[1]).slice(0, 8)

  console.log('')
  console.log('── summary ──')
  console.log(`cells selected:  ${cells.length}`)
  console.log(`captured:        ${stats.captured}`)
  console.log(`skipped:         ${stats.skipped} (unchanged output; --force re-captures)`)
  console.log(`posed:           ${stats.posed} of ${stats.captured} captured cells had the showcase pose applied`)
  console.log(`failed:          ${stats.failed.length}`)
  for (const f of stats.failed) console.log(`   - ${f.key}: ${f.error}`)
  console.log(`flat captures:   ${stats.blank.length} of ${stats.captured} (both shots 2 or fewer colours on a 12px grid)`)
  for (const k of stats.blank) console.log(`   - ${k}`)
  console.log(`blocked hosts:   ${hostRank.length === 0 ? 'none' : hostRank.map(([h, n]) => `${h} ${n}`).join(', ')}`)
  console.log(
    `dist/gallery:    ${gallery.files} files, ${fmtBytes(gallery.bytes)}  (${relative(BENCH_DIR, GALLERY_DIR)})`
  )
  console.log(`cell time:       median ${median} ms; wall clock ${elapsed} s`)
  console.log(`signals:         ${relative(BENCH_DIR, SIGNALS_PATH)} (${Object.keys(doc.cells).length} cells)`)
}

main().catch((e) => {
  console.error(`capture failed: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
