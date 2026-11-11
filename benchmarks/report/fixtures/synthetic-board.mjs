/**
 * A synthetic board for layout and behaviour checks. Every result in it is INVENTED. The models, tasks and categories
 * are the real registry's; the scores, costs, timings, iterations and captures are made up with a fixed formula, so the
 * same build always gives the same board. The board is built through the real buildBoard() and carries
 * source.synthetic = true, which makes the page show a banner. It is never a benchmark result and must never be
 * published as one.
 *
 * Shape of the invented data:
 *   - three Claude tiers (Opus, Sonnet, Haiku), each at three effort levels, on every task, scored by scorer version 2.
 *     Cost and time rise with effort. A few cells are partial (some iterations failed), so partial cells are shown.
 *   - a non-Claude priced model (Kimi K2.7) on every task, scored by version 2, so the all-models group has a priced
 *     non-Claude model on the frontier;
 *   - two earlier Claude models (Opus 4.8, Sonnet 4.6) scored by version 1, on the eleven tasks that have version 1
 *     records (the four classic tasks and the seven smoke tasks), so the earlier-runs scope has its own task set;
 *   - one model whose every iteration failed (no completed iteration anywhere);
 *   - one model with no per-token price (a free route, with a usage block that is not a cost);
 *   - one model with low coverage (one headline task only);
 *   - one model whose positive price is under review (not plotted, no cost).
 *
 * Captures: every headline cell of a version 2 model has captures, except one model that has none, and one cell whose
 * capture was taken from an earlier output (out of date, not shown). The capture images are placeholders; shoot.mjs
 * draws them, labelled as placeholders, when it renders the board.
 *
 * Used by report/shoot.mjs, which renders it and asserts the layout. Run it directly to print a summary:
 *   npx tsx report/fixtures/synthetic-board.mjs
 */
import { createHash } from 'node:crypto'
import * as registry from '../../lib/lab/llm-benchmark/registry.ts'
import { buildBoard } from '../../lib/lab/report/board.ts'
import { safeFileName } from '../../lib/lab/report/artifact-js.ts'

export const SYNTHETIC_NOTE = 'Invented results for layout checks. Not benchmark results.'
export const SYNTHETIC_NOW = '2026-11-10T12:00:00.000Z'

const TIERS = [
  { base: 'claude-opus-5-5', name: 'Opus', levels: ['low', 'high', 'xhigh'], score: 80, cost: 0.06 },
  { base: 'claude-sonnet-5-5', name: 'Sonnet', levels: ['low', 'medium', 'xhigh'], score: 72, cost: 0.03 },
  { base: 'claude-haiku-5-5', name: 'Haiku', levels: ['low', 'high', 'xhigh'], score: 58, cost: 0.01 }
]
const EFFORT_OFFSET = { low: -6, medium: -2, high: 0, xhigh: 3 }
/** Cost and time rise with effort: the effort charts are not flat. */
const EFFORT_COST = { low: 1, medium: 1.6, high: 2.6, xhigh: 4 }
const EFFORT_TIME = { low: 1, medium: 1.5, high: 2.2, xhigh: 3 }
const CHECKS = [
  { name: 'page renders', maxPoints: 10 },
  { name: 'reacts to input', maxPoints: 20 }
]
const WOBBLE = [-4, -1, 0, 1, 4]
/** Cells with some iterations failed: "model|task" -> completed iterations and the recorded reason. */
const PARTIAL = {
  'claude-haiku-5-5-xhigh|car-racer': { completed: 3, reason: 'timeout' },
  'claude-sonnet-5-5-low|voxel-lighthouse': { completed: 4, reason: 'model_error' },
  'claude-opus-5-5-xhigh|sector-clock': { completed: 4, reason: 'timeout' },
  'kimi-k2.7|orbit-lab': { completed: 2, reason: 'timeout' }
}
/** A model with no capture at all, and one capture taken from an earlier output (out of date). */
const NO_CAPTURES = new Set(['kimi-k2.7'])
const OUT_OF_DATE = 'claude-haiku-5-5-high|tic-tac-toe'
const HORIZON_TASKS = new Set(['orbit-lab', 'pathfinding-lab', 'rlc-response-lab', 'bicycle-blueprint', 'sector-clock', 'kanban-keyboard-undo', 'seat-pricing'])

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v * 10) / 10)) }
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
/** The invented output a cell stands for. Its hash is what a capture is matched against. */
const outputOf = (modelId, taskId) => `<!doctype html><html lang="en"><head><title>synthetic ${modelId} ${taskId}</title></head><body></body></html>`

/** One invented cell. `completed` iterations of `iterations`; scores around `score`. */
function cell({ taskId, modelId, score, completed = 5, iterations = 5, costUsd = null, usage = null, provider, taskIndex, createdAt, scorerVersion = 2, timeMult = 1, reason }) {
  const values = Array.from({ length: completed }, (_, k) => clamp(score + WOBBLE[(k + taskIndex) % WOBBLE.length]))
  const failed = iterations - completed
  const iterationCheckResults = Array.from({ length: completed }, (_, k) => [
    { name: CHECKS[0].name, passed: true, points: CHECKS[0].maxPoints, maxPoints: CHECKS[0].maxPoints },
    { name: CHECKS[1].name, passed: k % 3 !== 0, points: k % 3 !== 0 ? CHECKS[1].maxPoints : 0, maxPoints: CHECKS[1].maxPoints }
  ])
  const decode = provider !== 'Local'
  return {
    taskId,
    modelId,
    score: completed ? clamp(values.reduce((a, b) => a + b, 0) / completed) : 0,
    runtimeMs: completed ? Math.round((40000 + taskIndex * 3000) * timeMult) : 0,
    tokensIn: completed ? 1800 + taskIndex * 90 : 0,
    tokensOut: completed ? Math.round((9000 + taskIndex * 400) * timeMult) : 0,
    costUsd: costUsd ?? 0,
    iterations,
    iterationsSucceeded: completed,
    iterationScores: values,
    iterationCheckResults: completed ? iterationCheckResults : undefined,
    status: completed === iterations ? 'success' : completed === 0 ? 'fail' : 'partial',
    failureReason: failed > 0 ? (reason ?? (completed === 0 ? 'model_error' : 'timeout')) : null,
    telemetry: decode && completed ? { meanTtftMs: 900 + taskIndex * 40, meanTokensPerSec: Math.round((60 - taskIndex) / timeMult * 10) / 10, rateKind: 'decode', cacheHits: 0, retries: 0 } : { cacheHits: 0, retries: 0 },
    usage,
    createdAt,
    source: 'live',
    scorerVersion,
    output: outputOf(modelId, taskId)
  }
}

/**
 * Captures for the cells whose captures the board should show: the headline cells of version 2 models, except the
 * models in NO_CAPTURES. Paths are as capture.mjs writes them (relative to the report folder); the cell whose capture
 * is out of date carries the hash of an earlier output, so the board must not attach it.
 */
export function syntheticSignals(results, tasks) {
  const headline = new Set(tasks.filter((t) => t.pluginId).map((t) => t.id))
  const cells = {}
  for (const r of results) {
    if (r.source !== 'live' || r.scorerVersion < 2 || !headline.has(r.taskId) || NO_CAPTURES.has(r.modelId)) continue
    const key = `${r.modelId}|${r.taskId}`
    const base = `dist/gallery/${safeFileName(r.taskId)}/${safeFileName(r.modelId)}`
    const posed = HORIZON_TASKS.has(r.taskId)
    cells[key] = {
      outputSha256: key === OUT_OF_DATE ? sha256('an output the record no longer has') : sha256(r.output),
      poseId: posed ? r.taskId : null,
      shots: [`${base}-a.jpg`, `${base}-b.jpg`],
      captures: [
        { viewport: '1024 x 720', afterLoadMs: 1500, posed },
        { viewport: '390 x 844', afterLoadMs: 1500, posed }
      ]
    }
  }
  return { cells }
}

/**
 * Builds the synthetic board through the real buildBoard, with the real registry's models and tasks. The target is the
 * build the board is for (private by default; the public target drops earlier runs and smoke without version 2 data).
 */
export function buildSyntheticBoard(target = 'private') {
  const tasks = registry.BENCHMARK_TASKS
  const taskIds = tasks.map((t) => t.id)
  // Headline tasks have a plugin id; smoke tasks do not. The eleven pre-v2 tasks are the non-horizon ones.
  const headlineIds = tasks.filter((t) => t.pluginId).map((t) => t.id)
  const earlierIds = tasks.filter((t) => !HORIZON_TASKS.has(t.id)).map((t) => t.id)
  const results = []
  const day = '2026-11-08T00:00:00.000Z'

  // Claude tiers: every effort level on every task, scored by version 2.
  for (const tier of TIERS) {
    for (const level of tier.levels) {
      const modelId = `${tier.base}-${level}`
      taskIds.forEach((taskId, ti) => {
        const key = `${modelId}|${taskId}`
        const partial = PARTIAL[key]
        const score = tier.score + EFFORT_OFFSET[level] + (ti % 3) * 2 - 2
        results.push(cell({
          taskId, modelId, provider: 'Anthropic', taskIndex: ti, score,
          costUsd: tier.cost * EFFORT_COST[level] * (1 + ti * 0.02),
          timeMult: EFFORT_TIME[level],
          usage: { inputTokens: 1800, outputTokens: 9000, source: 'reported' },
          createdAt: day,
          completed: partial ? partial.completed : 5,
          reason: partial ? partial.reason : undefined
        }))
      })
    }
  }

  // A non-Claude priced model on every task, version 2.
  taskIds.forEach((taskId, ti) => {
    results.push(cell({
      taskId, modelId: 'kimi-k2.7', provider: 'Moonshot AI', taskIndex: ti, score: 70 + (ti % 4) - 1,
      costUsd: 0.03 * (1 + ti * 0.02), usage: { inputTokens: 1800, outputTokens: 9000, source: 'reported' }, createdAt: day,
      completed: PARTIAL[`kimi-k2.7|${taskId}`] ? PARTIAL[`kimi-k2.7|${taskId}`].completed : 5,
      reason: PARTIAL[`kimi-k2.7|${taskId}`] ? PARTIAL[`kimi-k2.7|${taskId}`].reason : undefined
    }))
  })

  // Earlier runs: two older Claude models on the eleven pre-v2 tasks, scored by version 1. Not comparable with the others.
  for (const [modelId, score, cost] of [['claude-opus-4-8', 74, 0.05], ['claude-sonnet-4-6', 66, 0.02]]) {
    earlierIds.forEach((taskId, ti) => {
      results.push(cell({
        taskId, modelId, provider: 'Anthropic', taskIndex: ti, score: score + (ti % 3) - 1,
        costUsd: cost * (1 + ti * 0.02), usage: { inputTokens: 1800, outputTokens: 9000, source: 'reported' },
        createdAt: day, scorerVersion: 1
      }))
    })
  }

  // Every iteration failed: no completed iteration on any task. The failed iterations were billed, so the cell keeps its cost.
  taskIds.forEach((taskId, ti) => {
    results.push(cell({
      taskId, modelId: 'claude-fable-5', provider: 'Anthropic', taskIndex: ti, score: 0, completed: 0, createdAt: day,
      costUsd: 0.25, usage: { inputTokens: 1800, outputTokens: 9000, source: 'reported' }
    }))
  })

  // No per-token price: a free route whose usage block must not become a cost.
  headlineIds.slice(0, 6).forEach((taskId, ti) => {
    results.push(cell({
      taskId, modelId: 'nemotron-3-super', provider: 'OpenRouter', taskIndex: ti, score: 64 + ti,
      costUsd: 0.02, usage: { inputTokens: 1800, outputTokens: 9000, source: 'reported' }, createdAt: day
    }))
  })

  // Low coverage: one headline task only (the first headline task of the registry).
  results.push(cell({ taskId: headlineIds[0], modelId: 'gpt-5', provider: 'OpenAI', taskIndex: 0, score: 76, costUsd: 0.04, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' }, createdAt: day }))

  // Price under review: a positive registry price below one cent per million tokens.
  headlineIds.slice(0, 6).forEach((taskId, ti) => {
    results.push(cell({ taskId, modelId: 'gemini-3.6-flash', provider: 'OpenRouter', taskIndex: ti, score: 70 + ti, costUsd: 0.0002, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' }, createdAt: day }))
  })

  // The records above use the registry's model ids and tasks, so buildBoard accepts them.
  return buildBoard({
    results,
    models: registry.BENCHMARK_MODELS,
    tasks,
    categories: registry.BENCHMARK_CATEGORIES,
    signals: syntheticSignals(results, tasks),
    now: SYNTHETIC_NOW,
    resultsSha256: 'synthetic',
    synthetic: true,
    target
  })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const b = buildSyntheticBoard()
  console.log(`synthetic board: ${b.source.synthetic ? 'synthetic' : 'NOT synthetic'}, ${b.models.length} models, ${b.cells.length} cells`)
  console.log(`  effort bases: ${[...new Set(b.models.filter((m) => m.effort).map((m) => m.baseModelId))].join(', ')}`)
  console.log(`  scope tasks: ${Object.entries(b.scopeTasks).map(([s, ids]) => `${s} ${ids.length}`).join(', ')}`)
  console.log(`  captures: ${Object.entries(b.cells.reduce((acc, c) => ({ ...acc, [c.captureStatus]: (acc[c.captureStatus] || 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  console.log(`  ${SYNTHETIC_NOTE}`)
}
