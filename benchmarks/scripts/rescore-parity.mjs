#!/usr/bin/env node
/**
 * Rescore parity: does today's behavioural scorer reproduce the check outcomes
 * stored on the board?
 *
 * For every stored record with `source: 'live'`, whose task is behaviourally
 * scored and whose output is an HTML document, the stored output is scored
 * again with the current scorer. The new per-check pass/fail is compared with
 * the stored pass/fail of the iteration that produced the published artifact.
 *
 * Free and local. No model call, no network (every http(s) request the page
 * makes is aborted and counted per record), and results.json is read but never
 * written. Findings go to tmp/rescore-parity.json under the package root.
 *
 * Which stored output? runners/provider.ts writes the stored `output` as the
 * successful iteration's `cleaned` text, which is after cleanOutput AND after
 * dependency inlining (the `clean` event is what the scorer sees). So the stored
 * output is the post-inlining text for any record made by a sweep that inlines.
 * Records written before inlining existed hold the pre-inlining text, and a
 * page that loads a library from a CDN then cannot run here, because the network
 * is blocked. Such differences are labelled `blocked-external-request` when the
 * page asked for an external URL during the rescore.
 *
 * Which iteration? `aggregateRuns` publishes the artifact of the FIRST iteration with
 * the highest score (runners/provider.ts), and writes `iterationScores` and
 * `iterationCheckResults` index-aligned. A record whose two arrays align is
 * compared with the argmax iteration ('iterationScores argmax'). A record with ONE
 * check row is compared with that row. Some records carry more iterationScores
 * than rows; for those the row's iteration is not recorded, and the selection
 * label says so. Any other shape is not comparable and is skipped ('unaligned').
 *
 * A difference where the stored row was a thrown or timed-out check is marked
 * `explained`: a timeout or exception is a fact about that run, not an outcome of
 * the artifact, so a new outcome is not expected to match it.
 *
 * Causes are MEASURED, not read off detail text. For each record with an
 * unexplained difference, the artifact is scored again under each regime in
 * REGIMES, and the record's cause is the first regime whose check outcomes
 * reproduce the stored outcomes exactly. The regimes are the measurement code the
 * board has used (see scorer-changelog.md):
 *   - element-screenshot + pre-2026-10-19 landing check: the element screenshot
 *     capture of commit 30f76c4 and later, with the canvas-only landing-animates
 *     check that landing-page-morph used before commit 95b8011.
 *   - toDataURL + pre-2026-10-19 landing check: the canvas.toDataURL capture
 *     that runChecks used before commit 30f76c4, with the same landing check.
 * A stored breakdown that is empty is `stored-breakdown-empty`, and one with rows
 * that have no name is `stored-breakdown-unnamed`; both are facts about the stored
 * record and are not tested against the regimes. If neither regime reproduces the
 * stored outcomes the cause is `not-reproduced`.
 *
 * Structural points: the doubled-bracket rule changed in scorer version 2 (it
 * reads markup only). The v1 structural rule is copied below so the script can
 * count how many stored artifacts gain structural points from that change. The
 * composite is not compared, because the structural change is deliberate.
 *
 * Usage:
 *   npx tsx scripts/rescore-parity.mjs                       # every browser task
 *   npx tsx scripts/rescore-parity.mjs --tasks n-body-field,tic-tac-toe
 *   npx tsx scripts/rescore-parity.mjs --limit 5             # first 5 per task
 *
 * --tasks  comma-separated task ids (default: every behaviourally scored task)
 * --limit  maximum records compared per task, in file order (default: all)
 *
 * Concurrency is capped at 4 record workers. Scoring itself is serialised by the
 * process-wide scoring lock, so one page renders at a time (a page scored beside
 * others can miss its per-check timer and read as a failure).
 *
 * Exit status: 0 when every compared record ran in the browser; 1 when any
 * record came back with a fallback row (the browser did not run), because a
 * fallback is not a parity result.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BENCHMARK_TASKS } from '../lib/lab/llm-benchmark/registry.ts'
import { SCORER_VERSION } from '../lib/lab/llm-benchmark/scorer-version.ts'
import { behavioralTaskIds } from '../lib/lab/llm-benchmark/scorers/index.ts'
import { behavioralScorer, scoreWithChecksForTesting } from '../lib/lab/llm-benchmark/scorers/behavioral.ts'
import { getChecksForTask } from '../lib/lab/llm-benchmark/scorers/checks.ts'
import { htmlScorer } from '../lib/lab/llm-benchmark/scorers/html.ts'
import { withScoringLock } from '../lib/lab/llm-benchmark/scorers/browser-fallback.ts'
import { closeSandbox, defineCheck } from '../lib/lab/llm-benchmark/scorers/sandbox.ts'
import {
  getSandboxBackend,
  resolveSandboxPolicy,
  setSandboxBackend,
} from '../lib/lab/llm-benchmark/scorers/sandbox-backend.ts'

const CONCURRENCY = 4
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultsPath = join(root, 'lib/lab/llm-benchmark/results.json')
const outPath = join(root, 'tmp/rescore-parity.json')

function parseArgs(argv) {
  const args = { tasks: undefined, limit: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tasks') args.tasks = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--limit') args.limit = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit needs a positive integer')
  }
  return args
}

/**
 * The version-1 structural rule, copied from the version-1 scorers/html.ts so the
 * parity run can measure the structural change. Only the doubled-bracket test
 * differs from the current htmlScorer: it read the whole file.
 */
function legacyStructuralScore(output) {
  const html = output.trim()
  if (!html) return 0
  if (!html.startsWith('<')) return 10
  const tagCounts = (tag) => ({
    opens: html.match(new RegExp(`<${tag}\\b`, 'gi'))?.length ?? 0,
    closes: html.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0,
  })
  const balanced = (tag) => {
    const { opens, closes } = tagCounts(tag)
    return opens > 0 && opens === closes
  }
  const lower = html.toLowerCase()
  let score = 0
  if (lower.includes('<!doctype html') || lower.includes('<html')) score += 10
  if (balanced('html')) score += 10
  if (balanced('body')) score += 10
  if (balanced('script')) score += 25
  const scriptHasCode = /<script\b[^>]*>\s*\S[\s\S]*?<\/script>/i.test(html)
  const visibleText = html.replace(/<[^>]*>/g, '').trim()
  if (scriptHasCode || visibleText.length > 0) score += 15
  const script = tagCounts('script')
  const canvas = tagCounts('canvas')
  const hasGarbage = /<<|>>/.test(html)
  if (!hasGarbage && script.opens === script.closes && canvas.opens === canvas.closes) score += 15
  if (lower.includes('</html>')) score += 10
  if (lower.includes('<canvas') && balanced('canvas')) score += 5
  if (lower.includes('<style') && balanced('style')) score += 5
  return Math.min(100, score)
}

// ---------------------------------------------------------------------------
// The regimes: the measurement code the board has used for the legacy canvas
// tasks. Copied from the git history of the source repo (benebsworth.com):
//   pixelDiffScore            unchanged from the first Playwright scorer (ecd8703)
//   toDataURL capture         runChecks before 30f76c4 (2026-10-16)
//   landing-animates, old     checks.ts before 95b8011 (2026-10-19)
// ---------------------------------------------------------------------------

/** The byte-level change proxy, as the legacy checks computed it. */
function legacyPixelDiffScore(before, after) {
  if (before.length === 0 || after.length === 0) return 0
  const len = Math.min(before.length, after.length)
  if (len < 16) return 0
  let differing = 0
  for (let i = 0; i < len; i += 13) {
    if (before[i] !== after[i]) differing++
  }
  return differing / Math.floor(len / 13)
}

/** The canvas capture runChecks used before commit 30f76c4: canvas.toDataURL, decoded. */
function toDataUrlCapture(page) {
  return async (selector = 'canvas') => {
    const dataUrl = await page.evaluate((sel) => {
      const c = document.querySelector(sel)
      if (!c) return null
      return c.toDataURL('image/png')
    }, selector)
    if (!dataUrl) return undefined
    const data = Buffer.from(dataUrl.split(',', 2)[1] ?? '', 'base64')
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), data }
  }
}

/** landing-animates as it was before commit 95b8011: a canvas diff or a change in body text. */
const LEGACY_LANDING = defineCheck('landing-animates', 35, async (ctx) => {
  const before = await ctx.captureCanvas('canvas').catch(() => undefined)
  const beforeBody = await ctx.page.evaluate(() => document.body.innerText?.length ?? 0)
  await ctx.page.waitForTimeout(1000)
  const afterBody = await ctx.page.evaluate(() => document.body.innerText?.length ?? 0)
  const after = await ctx.captureCanvas('canvas').catch(() => undefined)
  let diff = 0
  if (before && after) diff = legacyPixelDiffScore(before.data, after.data)
  const changed = diff > 0.005 || afterBody !== beforeBody
  return {
    name: 'landing-animates',
    passed: changed,
    points: changed ? 35 : 0,
    maxPoints: 35,
    detail: `pixel diff=${(diff * 100).toFixed(1)}% bodyTextLen before=${beforeBody} after=${afterBody}`,
  }
})

const REGIMES = [
  { id: 'element-screenshot+pre-2026-10-19-landing', capture: 'element', landing: 'legacy' },
  { id: 'toDataURL+pre-2026-10-19-landing', capture: 'toDataURL', landing: 'legacy' },
]

/** The checks a regime scores with: the task's own, with the regime's capture and landing check. */
function checksForRegime(task, regime) {
  const own = getChecksForTask(task)
  const landed = regime.landing === 'legacy'
    ? own.map((check) => (check.checkName === 'landing-animates' ? LEGACY_LANDING : check))
    : own
  if (regime.capture === 'element') return landed
  return landed.map((check) =>
    defineCheck(check.checkName, check.maxPoints, (ctx) =>
      check({ ...ctx, captureCanvas: toDataUrlCapture(ctx.page) })
    )
  )
}

/** Route every http(s) request the artifact makes to an abort, and count it per scoring call. */
const blockedRequests = []
function withoutNetwork(backend) {
  return {
    name: backend.name,
    enforcement: backend.enforcement,
    async launch() {
      const session = await backend.launch()
      return {
        async newContext(options) {
          const context = await session.newContext(options)
          await context.route('**/*', (route) => {
            const url = route.request().url()
            if (/^https?:/i.test(url)) {
              blockedRequests.push(url.slice(0, 160))
              return route.abort()
            }
            return route.continue()
          })
          return context
        },
      }
    },
    close: () => backend.close(),
  }
}

const isDocument = (output) => /<!doctype html|<html[\s>]/i.test(output)
const isThrownOrTimedOut = (row) => /^threw: |check timeout|skipped: batch timeout/.test(row?.detail ?? '')
const isFallback = (row) => row?.kind === 'fallback'
const pick = (row) => ({ passed: row.passed, points: row.points, maxPoints: row.maxPoints, detail: row.detail })

/** The stored iteration the published artifact corresponds to, or null when unaligned. */
function storedIterationOf(record) {
  const rows = record.iterationCheckResults
  const scores = record.iterationScores
  if (rows.length === 1) {
    const aligned = Array.isArray(scores) && scores.length === 1
    return {
      selection: aligned ? 'single row, one iterationScore' : `single row (record has ${Array.isArray(scores) ? scores.length : 0} iterationScores)`,
      index: 0,
    }
  }
  if (Array.isArray(scores) && scores.length === rows.length) {
    let best = 0
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i
    return { selection: 'iterationScores argmax', index: best }
  }
  return null
}

/** Compare the new rows with the stored rows of one iteration, check by check. */
function compareWith(storedRows, newRows) {
  const stored = new Map(storedRows.map((row) => [row.name, row]))
  const fresh = new Map(newRows.map((row) => [row.name, row]))
  const names = [...new Set([...stored.keys(), ...fresh.keys()])]
  const differences = []
  for (const name of names) {
    const s = stored.get(name)
    const n = fresh.get(name)
    if (!s || !n || Boolean(s.passed) !== Boolean(n.passed)) {
      differences.push({
        check: name,
        stored: s ? pick(s) : null,
        new: n ? pick(n) : null,
        explained: Boolean(s && isThrownOrTimedOut(s)),
      })
    }
  }
  return differences
}

async function pool(items, limit, work) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await work(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Score one artifact under the current scorer, serialised with every other
 * scoring call in the process. Returns the result and the requests it blocked.
 */
function scoreCurrent(output, task) {
  return withScoringLock(async () => {
    const before = blockedRequests.length
    const result = await behavioralScorer.scoreWithBreakdown(output, task)
    return { result, blocked: blockedRequests.length - before }
  })
}

/** Score one artifact under a regime, serialised the same way. */
function scoreRegime(output, task, regime) {
  return withScoringLock(() => scoreWithChecksForTesting(output, task, checksForRegime(task, regime)))
}

function countBy(items, key) {
  const counts = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

function pad(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const browserTaskIds = behavioralTaskIds(BENCHMARK_TASKS)
  const taskIds = args.tasks ?? [...browserTaskIds]
  for (const id of taskIds) {
    if (!browserTaskIds.has(id)) throw new Error(`task ${id} is not behaviourally scored`)
  }

  const records = JSON.parse(readFileSync(resultsPath, 'utf8'))
  const policy = resolveSandboxPolicy()
  // The seam is set once for this process: the same policy, with no network.
  setSandboxBackend(withoutNetwork(getSandboxBackend()), policy)

  // Population: every stored record, then the reasons the others are left out.
  const skipped = {}
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  const queued = []
  records.forEach((record, index) => {
    if (record.source !== 'live') return skip('not live')
    if (!browserTaskIds.has(record.taskId)) return skip('task not behaviourally scored')
    if (!taskIds.includes(record.taskId)) return skip('task not selected')
    if (typeof record.output !== 'string' || !isDocument(record.output)) return skip('output is not an HTML document')
    if (!Array.isArray(record.iterationCheckResults) || record.iterationCheckResults.length === 0) {
      return skip('no stored check results')
    }
    queued.push({ record, index })
  })

  // --limit applies per task, in file order.
  const perTaskCount = new Map()
  const toCompare = queued.filter(({ record }) => {
    const n = perTaskCount.get(record.taskId) ?? 0
    if (args.limit !== undefined && n >= args.limit) return false
    perTaskCount.set(record.taskId, n + 1)
    return true
  })

  const tasks = new Map(BENCHMARK_TASKS.map((t) => [t.id, t]))
  const perTask = new Map(taskIds.map((id) => [id, { task: id, compared: 0, identical: 0, differing: 0, unaligned: 0, fallbacks: 0, storedFallback: 0, explainedDifferences: 0, unexplainedDifferences: 0, selections: {} }]))
  const differences = []
  const fallbacks = []
  const structural = { compared: 0, gained: 0, pointsGained: 0, samples: [] }
  const structuralAllLive = { liveHtml: 0, gained: 0, pointsGained: 0 }

  for (const record of records) {
    if (record.source !== 'live' || typeof record.output !== 'string' || !isDocument(record.output)) continue
    const gain = htmlScorer.score(record.output, tasks.get(record.taskId) ?? BENCHMARK_TASKS[0]) - legacyStructuralScore(record.output)
    structuralAllLive.liveHtml++
    if (gain > 0) {
      structuralAllLive.gained++
      structuralAllLive.pointsGained += gain
    }
  }

  await pool(toCompare, CONCURRENCY, async ({ record, index }) => {
    const stats = perTask.get(record.taskId)
    const task = tasks.get(record.taskId)
    const label = `${record.taskId} :: ${record.modelId} :: ${record.createdAt ?? `#${index}`}`
    const picked = storedIterationOf(record)
    if (picked === null) {
      stats.unaligned++
      return
    }
    const { selection, index: storedIndex } = picked
    stats.selections[selection] = (stats.selections[selection] ?? 0) + 1

    const storedRows = record.iterationCheckResults[storedIndex]
    if (storedRows.some(isFallback)) {
      stats.storedFallback++
      return
    }

    let scored
    try {
      scored = await scoreCurrent(record.output, task)
    } catch (err) {
      fallbacks.push({ label, reason: `scoring threw: ${err instanceof Error ? err.message : String(err)}` })
      stats.fallbacks++
      return
    }
    const { result, blocked } = scored
    const fallbackRow = result.checks.find(isFallback)
    if (fallbackRow) {
      fallbacks.push({ label, reason: fallbackRow.detail ?? 'fallback row' })
      stats.fallbacks++
      return
    }

    stats.compared++
    const structuralNew = htmlScorer.score(record.output, task)
    const structuralOld = legacyStructuralScore(record.output)
    structural.compared++
    if (structuralNew > structuralOld) {
      structural.gained++
      structural.pointsGained += structuralNew - structuralOld
      if (structural.samples.length < 20) structural.samples.push({ label, v1: structuralOld, v2: structuralNew })
    }

    const diffs = compareWith(storedRows, result.checks)
    if (diffs.length === 0) {
      stats.identical++
      return
    }
    stats.differing++

    // Measure the cause: which regime reproduces the stored outcomes of every
    // check that is not explained by a stored throw or timeout.
    const unexplained = diffs.filter((d) => !d.explained)
    // A stored breakdown that cannot be compared by name is a fact about the stored
    // record, not about either regime: it is empty, or some of its rows have no name
    // (the names were added after these rows were written).
    // An empty stored breakdown is a structure-only score: the browser ran nothing,
    // so there is no check outcome to compare, whatever the regime. Unnamed rows
    // come from version-1 records that named a failed row after its check function.
    const storedShape = storedRows.length === 0
      ? 'stored-structure-only-fallback'
      : storedRows.some((row) => !row.name) ? 'stored-breakdown-unnamed' : undefined
    let reproducedBy = []
    if (unexplained.length > 0 && storedShape === undefined) {
      for (const regime of REGIMES) {
        const regimeResult = await scoreRegime(record.output, task, regime)
        if (regimeResult.checks.some(isFallback)) continue
        if (compareWith(storedRows, regimeResult.checks).every((d) => d.explained)) reproducedBy.push(regime.id)
      }
    }
    // A regime that reproduces the stored outcome names the cause. Only when none
    // does, a page that asked for an external URL (blocked here) is named as the
    // likely cause: the stored outcome may have relied on that resource.
    // Both regimes share the landing check and differ only in the capture. When
    // both reproduce the stored outcome, the landing check is the cause and the
    // capture is not distinguishable, so the label says so rather than naming the
    // first regime in the list.
    const reproducedCause = reproducedBy.length === 1
      ? reproducedBy[0]
      : reproducedBy.length > 1
        ? 'pre-2026-10-19-landing-check (both captures reproduce)'
        : undefined
    const cause = unexplained.length === 0
      ? 'stored-row-threw-or-timed-out'
      : storedShape ?? reproducedCause ?? (blocked > 0 ? 'blocked-external-request' : 'not-reproduced')

    for (const d of diffs) {
      if (d.explained) stats.explainedDifferences++
      else stats.unexplainedDifferences++
      differences.push({
        label,
        taskId: record.taskId,
        modelId: record.modelId,
        createdAt: record.createdAt,
        iteration: storedIndex,
        selection,
        blockedRequests: blocked,
        reproducedBy,
        cause,
        ...d,
      })
    }
  })

  const blockedByHost = {}
  for (const url of blockedRequests) {
    const host = url.replace(/^https?:\/\//i, '').split('/')[0]
    blockedByHost[host] = (blockedByHost[host] ?? 0) + 1
  }
  const perRecord = [...new Map(differences.map((d) => [d.label, d])).values()]
  const summary = {
    generatedAt: new Date().toISOString(),
    scorerVersion: SCORER_VERSION,
    sandboxPolicy: policy,
    regimes: REGIMES.map((r) => r.id),
    tasks: taskIds,
    limitPerTask: args.limit ?? null,
    population: { storedRecords: records.length, queued: queued.length, compared: toCompare.length, skipped },
    perTask: [...perTask.values()],
    selections: Object.fromEntries(
      [...perTask.values()].reduce((m, s) => {
        for (const [k, v] of Object.entries(s.selections)) m.set(k, (m.get(k) ?? 0) + v)
        return m
      }, new Map())
    ),
    differences,
    causes: countBy(differences, (d) => d.cause),
    causesByRecord: countBy(perRecord, (d) => d.cause),
    fallbacks,
    storedFallbacks: [...perTask.values()].reduce((n, s) => n + s.storedFallback, 0),
    structural: {
      note: 'Count of compared artifacts whose structural score rises under the version-2 doubled-bracket rule (v1 copied in this script).',
      compared: structural.compared,
      gained: structural.gained,
      pointsGained: structural.pointsGained,
      samples: structural.samples,
      allLiveHtmlRecords: structuralAllLive,
    },
    blockedRequests: { total: blockedRequests.length, byHost: blockedByHost },
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')
  printReport(summary)
  console.log(`\nwrote ${outPath}`)

  await closeSandbox()
  if (fallbacks.length > 0) {
    console.error(`${fallbacks.length} record(s) came back with a fallback row; the browser did not run them. Not a parity result.`)
    process.exitCode = 1
  }
}

function printReport(summary) {
  console.log(`scorer version ${summary.scorerVersion}; backend ${summary.sandboxPolicy.backend} (${summary.sandboxPolicy.enforcement})`)
  console.log(`population: ${summary.population.storedRecords} stored, ${summary.population.queued} eligible, ${summary.population.compared} compared (limit ${summary.limitPerTask ?? 'none'} per task)`)
  console.log(`skipped: ${JSON.stringify(summary.population.skipped)}\n`)
  // Unit per column: every count is a number of RECORDS except the two check
  // columns, which count CHECK ROWS across those records.
  const header = ['task', 'compared', 'identical', 'differing', 'checks-explained', 'checks-unexplained', 'fallback', 'stored-fallback', 'unaligned']
  console.log('(records, except checks-explained and checks-unexplained, which count check rows)')
  console.log(header.map((h, i) => pad(h, i === 0 ? 26 : 13)).join(''))
  for (const s of summary.perTask) {
    const row = [s.task, s.compared, s.identical, s.differing, s.explainedDifferences, s.unexplainedDifferences, s.fallbacks, s.storedFallback, s.unaligned]
    console.log(row.map((v, i) => pad(v, i === 0 ? 26 : 13)).join(''))
  }
  const totals = summary.perTask.reduce((t, s) => ({
    compared: t.compared + s.compared, identical: t.identical + s.identical, differing: t.differing + s.differing,
  }), { compared: 0, identical: 0, differing: 0 })
  console.log(`\ntotal: ${totals.compared} compared, ${totals.identical} identical, ${totals.differing} differing`)
  const live = summary.structural.allLiveHtmlRecords
  console.log(`structural: ${summary.structural.gained} of ${summary.structural.compared} compared artifacts gain ${summary.structural.pointsGained} points under the markup-only rule`)
  console.log(`structural, all live HTML records: ${live.gained} of ${live.liveHtml} gain ${live.pointsGained} points`)
  console.log(`blocked http(s) requests: ${summary.blockedRequests.total}`)
  console.log(`selection: ${JSON.stringify(summary.selections)}`)
  console.log(`causes (checks): ${JSON.stringify(summary.causes)}`)
  console.log(`causes (records): ${JSON.stringify(summary.causesByRecord)}`)
  if (summary.differences.length > 0) {
    console.log('\ndifferences:')
    for (const d of summary.differences) {
      console.log(`- ${d.label} [iter ${d.iteration}, ${d.selection}] ${d.check} <${d.cause}>: stored ${d.stored ? (d.stored.passed ? 'pass' : 'fail') : 'absent'} (${d.stored?.detail ?? '-'}) -> new ${d.new ? (d.new.passed ? 'pass' : 'fail') : 'absent'} (${d.new?.detail ?? '-'})${d.explained ? ' [explained: stored row threw or timed out]' : ''}`)
    }
  }
}

await main()
