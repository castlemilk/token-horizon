import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
import type {
  BenchmarkCategory,
  BenchmarkModel,
  BenchmarkResult,
  BenchmarkTask,
  IterationCheckResult,
} from '../llm-benchmark/types'
import {
  accessFor,
  allTrialsScore,
  baseModelIdOf,
  bootstrapInterval,
  buildBoard,
  cellChecks,
  checkStats,
  cleanFloat,
  costIsMeasured,
  costPerIterationOf,
  fnv1a,
  formatUsd,
  groupFor,
  inScope,
  iterationValues,
  median,
  paretoFrontier,
  suiteOf,
  timingsOf,
  type Board,
  type BuildInput,
} from './board'

// ── Fixtures ─────────────────────────────────────────────────────────────

const CLASSIC = 'community-tasks'
const NOW = '2026-11-10T12:00:00.000Z'
const CATEGORIES: BenchmarkCategory[] = [
  { slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' },
]

function task(id: string, over: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id,
    category: 'advanced-game-building',
    title: `Task ${id}`,
    blurb: '',
    prompt: '',
    runtimeHint: '',
    iterationsDefault: 5,
    methodNotes: '',
    demoComponentName: '',
    slug: id,
    scorer: 'behavioral',
    pluginId: CLASSIC,
    ...over,
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return {
    id,
    name,
    provider: 'OpenRouter',
    costPer1kInputUsd: 0.001,
    costPer1kOutputUsd: 0.002,
    contextWindow: 1000,
    capabilities: '',
    company: 'Acme',
    ...over,
  }
}

function rec(over: Partial<BenchmarkResult> & { taskId: string; modelId: string }): BenchmarkResult {
  return {
    score: 0,
    runtimeMs: 1000,
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0,
    iterations: 5,
    status: 'success',
    createdAt: '2026-11-01T00:00:00.000Z',
    source: 'live',
    scorerVersion: 2,
    ...over,
  }
}

/** A complete five-iteration record with one per-iteration score. */
function full(taskId: string, modelId: string, score: number, over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return rec({
    taskId,
    modelId,
    score,
    iterationScores: [score, score, score, score, score],
    iterationsSucceeded: 5,
    ...over,
  })
}

/** One check row per iteration, passing on the iterations marked true. */
function checkRows(passes: boolean[], name: string, maxPoints = 10): IterationCheckResult[][] {
  return passes.map((p) => [{ name, passed: p, points: p ? maxPoints : 0, maxPoints }])
}

const ALL_PASS = [true, true, true, true, true]

function withWorld(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

/**
 * The main hand-built world.
 *
 * Alpha: 80 on c1 to c4 (cost 0.1 in total over its 5 iterations, so 0.02 per run; decode timings: TTFT 300 ms, 50 tok/s).
 *        Also 100 on the smoke task s1.
 * Beta:  60 on c1, c2, c4; c3 has one failed iteration (4 of 5 succeeded), so its
 *        all-trials score is 48 and beta's headline mean is 57. Cost 1.0 per task,
 *        estimated; wall-clock rate, so no timings.
 * Gamma (Anthropic): 90 on c1 and c2 only (2 of 4, so below 80% coverage). Cost not
 *        measured (zero, no usage block); decode timings: TTFT 120 ms, 30 tok/s.
 *
 * Check k-c1 passes 5 of 5 for alpha, 1 of 5 for beta and 5 of 5 for gamma. Gamma does not cover 80% of the headline
 * tasks, so the check finding pools alpha and beta only: 6 of 10 (60.0%), the lowest over the covering sample.
 */
function mainWorld(): BuildInput {
  const models = [
    model('alpha', 'Alpha', { provider: 'OpenRouter' }),
    model('beta', 'Beta', { provider: 'Agy' }),
    model('gamma', 'Gamma', { provider: 'Agy', company: 'Anthropic' }),
  ]
  const tasks = [
    task('c1', { title: 'Task One' }),
    task('c2', { title: 'Task Two' }),
    task('c3', { title: 'Task Three' }),
    task('c4', { title: 'Task Four' }),
    task('s1', { title: 'Smoke One', pluginId: undefined }),
  ]
  const fallbackRow: IterationCheckResult = { name: 'code-fallback', passed: false, points: 0, maxPoints: 0, kind: 'fallback' }
  const alpha = (taskId: string, score = 80) =>
    full(taskId, 'alpha', score, {
      costUsd: 0.1,
      usage: { inputTokens: 100, outputTokens: 200, source: 'reported' },
      telemetry: { meanTtftMs: 300, meanTokensPerSec: 50, rateKind: 'decode', cacheHits: 0, retries: 0 },
      iterationCheckResults: checkRows(ALL_PASS, `k-${taskId}`).map((row) => [...row, fallbackRow]),
    })
  const beta = (taskId: string) => {
    const base = {
      costUsd: 1.0,
      usage: { inputTokens: 100, outputTokens: 200, source: 'estimated' as const },
      telemetry: { meanTokensPerSec: 20, rateKind: 'wall-clock' as const, cacheHits: 0, retries: 0 },
    }
    if (taskId === 'c3') {
      return rec({
        taskId,
        modelId: 'beta',
        score: 60,
        status: 'partial',
        failureReason: 'model_error',
        iterationScores: [60, 60, 60, 60],
        iterationsSucceeded: 4,
        iterationCheckResults: checkRows([true, true, true, true], 'k-c3'),
        ...base,
      })
    }
    return full(taskId, 'beta', 60, {
      ...base,
      iterationCheckResults: checkRows(taskId === 'c1' ? [true, false, false, false, false] : ALL_PASS, `k-${taskId}`),
    })
  }
  const gamma = (taskId: string) =>
    full(taskId, 'gamma', 90, {
      costUsd: 0,
      telemetry: { meanTtftMs: 120, meanTokensPerSec: 30, rateKind: 'decode', cacheHits: 0, retries: 0 },
      iterationCheckResults: checkRows(ALL_PASS, `k-${taskId}`),
    })
  const results = [
    alpha('c1'),
    alpha('c2'),
    alpha('c3'),
    alpha('c4'),
    alpha('s1', 100),
    beta('c1'),
    beta('c2'),
    beta('c3'),
    beta('c4'),
    gamma('c1'),
    gamma('c2'),
  ]
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'abc123' }
}

/** A finding by id, from the headline scope of the all-models group (or the given group). */
function find(board: Board, id: string, group: 'claude' | 'all' = 'all', scope: 'headline' | 'smoke' | 'earlier' = 'headline') {
  return board.insights[scope][group].find((i) => i.id === id)
}

// ── Seeded records and source ────────────────────────────────────────────

describe('seeded records', () => {
  it('are excluded from cells and counted in source.seededExcluded', () => {
    const base = mainWorld()
    const seeded = rec({ taskId: 'c1', modelId: 'alpha', score: 0, source: 'seeded' })
    const board = buildBoard({ ...base, results: [...base.results, seeded] })
    expect(board.source.seededExcluded).toBe(1)
    expect(board.source.liveRecords).toBe(base.results.length)
    expect(board.source.records).toBe(base.results.length + 1)
    expect(board.cells.find((c) => c.modelId === 'alpha' && c.taskId === 'c1')?.score).toBe(80)
  })
})

// ── Suites and classification ────────────────────────────────────────────

describe('suite assignment', () => {
  const cases: Array<[string, { pluginId?: string }, 'smoke' | 'classic' | 'horizon', boolean]> = [
    ['no pluginId is smoke', {}, 'smoke', false],
    ['empty pluginId is smoke', { pluginId: '' }, 'smoke', false],
    ['horizon prefix is horizon', { pluginId: 'horizon-v1' }, 'horizon', true],
    ['bare horizon is horizon', { pluginId: 'horizon' }, 'horizon', true],
    ['community plugin is classic', { pluginId: 'community-tasks' }, 'classic', true],
    ['visual-games is classic', { pluginId: 'visual-games' }, 'classic', true],
  ]
  it.each(cases)('%s', (_label, t, suite, headline) => {
    expect(suiteOf(t)).toBe(suite)
    expect(inScope(suite, 'headline')).toBe(headline)
  })

  it('the board carries suite and headline flags per task', () => {
    const board = buildBoard(mainWorld())
    expect(board.tasks.find((t) => t.id === 'c1')).toMatchObject({ suite: 'classic', headline: true })
    expect(board.tasks.find((t) => t.id === 's1')).toMatchObject({ suite: 'smoke', headline: false })
    expect(board.suites.map((s) => s.id)).toEqual(['horizon', 'classic', 'smoke'])
  })
})

describe('provider access and group', () => {
  it.each([
    ['OpenAI', 'api'],
    ['Anthropic', 'api'],
    ['Google', 'api'],
    ['Moonshot AI', 'api'],
    ['OpenRouter', 'api'],
    ['Ollama', 'local'],
    ['Local', 'local'],
    ['Agy', 'cli'],
    ['Codex', 'cli'],
    ['Claude Code', 'cli'],
  ] as Array<[string, 'api' | 'cli' | 'local']>)('provider %s is %s', (provider, access) => {
    expect(accessFor(provider)).toBe(access)
  })

  it('group is claude only for Anthropic', () => {
    expect(groupFor('Anthropic')).toBe('claude')
    expect(groupFor('OpenAI')).toBe('other')
    expect(groupFor(undefined)).toBe('other')
  })

  it('an effort variant resolves to its base model, a base model to itself', () => {
    expect(baseModelIdOf({ id: 'delta-high', baseModelId: 'delta-base' })).toBe('delta-base')
    expect(baseModelIdOf({ id: 'delta-base' })).toBe('delta-base')
    const models = [
      model('delta-base', 'Delta Base'),
      model('delta-low', 'Delta Low', { baseModelId: 'delta-base', reasoningEffort: 'low' }),
      model('delta-high', 'Delta High', { baseModelId: 'delta-base', reasoningEffort: 'high' }),
    ]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = ['c1', 'c2', 'c3', 'c4'].flatMap((taskId) => [
      full(taskId, 'delta-low', 50, { costUsd: 0.2, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
      full(taskId, 'delta-high', 70, { costUsd: 0.6, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
    ])
    const board = buildBoard(withWorld(results, models, tasks))
    const low = board.models.find((m) => m.id === 'delta-low')!
    const high = board.models.find((m) => m.id === 'delta-high')!
    expect(low).toMatchObject({ baseModelId: 'delta-base', effort: 'low' })
    expect(high).toMatchObject({ baseModelId: 'delta-base', effort: 'high' })
  })

  it('prices are per million tokens, with float noise removed', () => {
    expect(cleanFloat(0.0000015 * 1000)).toBe(0.0015)
    const alpha = buildBoard(mainWorld()).models.find((m) => m.id === 'alpha')!
    expect(alpha.priceInPerM).toBe(1)
    expect(alpha.priceOutPerM).toBe(2)
  })
})

// ── All-trials score ─────────────────────────────────────────────────────

describe('all-trials score fallbacks', () => {
  const cases: Array<[string, Parameters<typeof allTrialsScore>[0], number]> = [
    ['record scoreAllTrials wins when present', { score: 70, scoreAllTrials: 55.5, iterations: 5, iterationScores: [100, 100, 100, 100, 100] }, 55.5],
    ['iterationScores summed over iterations, failed counted as zero', { score: 90, iterations: 5, iterationScores: [100, 90, 80] }, 54],
    ['iterationScores rounded to one decimal', { score: 100, iterations: 3, iterationScores: [33, 33, 34] }, 33.3],
    ['no iterationScores: score times succeeded over iterations', { score: 90, iterations: 5, iterationsSucceeded: 3 }, 54],
    ['no iterationScores and no succeeded count: score', { score: 90, iterations: 5 }, 90],
  ]
  it.each(cases)('%s', (_label, input, expected) => {
    expect(allTrialsScore(input)).toBe(expected)
  })

  it('pads iteration values with zeros for failed iterations, and is null without them', () => {
    expect(iterationValues({ iterations: 5, iterationScores: [80, 60] })).toEqual([80, 60, 0, 0, 0])
    expect(iterationValues({ iterations: 5 })).toBeNull()
  })

  it('a partial cell gets its all-trials score and succeeded count', () => {
    const c3 = buildBoard(mainWorld()).cells.find((c) => c.modelId === 'beta' && c.taskId === 'c3')!
    expect(c3).toMatchObject({ score: 60, scoreAllTrials: 48, succeeded: 4, failureReason: 'model_error' })
  })
})

// ── Cost ─────────────────────────────────────────────────────────────────

describe('cost: not measured versus zero', () => {
  const cases: Array<[string, number, string | null, boolean]> = [
    ['zero with no usage is not measured', 0, null, false],
    ['zero with estimated usage is not measured', 0, 'estimated', false],
    ['zero with reported usage is a measured zero', 0, 'reported', true],
    ['positive cost is measured without usage', 0.02, null, true],
    ['positive cost is measured with estimated usage', 0.02, 'estimated', true],
  ]
  it.each(cases)('%s', (_label, cost, source, measured) => {
    expect(costIsMeasured(cost, source)).toBe(measured)
  })

  it('costPerIteration is null when not measured and divides when measured', () => {
    expect(costPerIterationOf(0, 5, null)).toBeNull()
    expect(costPerIterationOf(1, 5, null)).toBeCloseTo(0.2, 12)
    expect(costPerIterationOf(0, 5, 'reported')).toBe(0)
    expect(costPerIterationOf(0.5, 5, 'estimated')).toBeCloseTo(0.1, 12)
  })

  it('an unmeasured cell has null cost and the summary has no cost', () => {
    const board = buildBoard(mainWorld())
    const cell = board.cells.find((c) => c.modelId === 'gamma' && c.taskId === 'c1')!
    expect(cell).toMatchObject({ costUsd: null, costPerIteration: null, usageSource: null })
    const summary = board.summaries.find((s) => s.modelId === 'gamma' && s.scope === 'headline')!
    expect(summary).toMatchObject({ costPerAttempt: null, totalCostUsd: null })
  })

  it('a measured cell carries cost and cost per iteration', () => {
    const cell = buildBoard(mainWorld()).cells.find((c) => c.modelId === 'beta' && c.taskId === 'c1')!
    expect(cell.costUsd).toBe(1)
    expect(cell.costPerIteration).toBeCloseTo(0.2, 12)
  })
})

// ── Timings ──────────────────────────────────────────────────────────────

describe('timings', () => {
  const cases: Array<[string, BenchmarkResult['telemetry'], { ttft: number | null; tps: number | null; kind: string | null }]> = [
    ['decode gives TTFT and tokens per second', { meanTtftMs: 300, meanTokensPerSec: 50, rateKind: 'decode', cacheHits: 0, retries: 0 }, { ttft: 300, tps: 50, kind: 'decode' }],
    ['wall-clock gives neither', { meanTtftMs: 300, meanTokensPerSec: 20, rateKind: 'wall-clock', cacheHits: 0, retries: 0 }, { ttft: null, tps: null, kind: 'wall-clock' }],
    ['mixed gives neither', { meanTtftMs: 300, meanTokensPerSec: 20, rateKind: 'mixed', cacheHits: 0, retries: 0 }, { ttft: null, tps: null, kind: 'mixed' }],
    ['no telemetry gives neither', undefined, { ttft: null, tps: null, kind: null }],
  ]
  it.each(cases)('%s', (_label, telemetry, expected) => {
    const t = timingsOf(telemetry)
    expect(t).toEqual({ ttftMs: expected.ttft, tokensPerSec: expected.tps, rateKind: expected.kind })
  })

  it('a wall-clock cell has null timings on the board', () => {
    const board = buildBoard(mainWorld())
    const beta = board.cells.find((c) => c.modelId === 'beta' && c.taskId === 'c1')!
    expect(beta).toMatchObject({ ttftMs: null, tokensPerSec: null, rateKind: 'wall-clock' })
    const alpha = board.cells.find((c) => c.modelId === 'alpha' && c.taskId === 'c1')!
    expect(alpha).toMatchObject({ ttftMs: 300, tokensPerSec: 50 })
  })
})

// ── Checks ───────────────────────────────────────────────────────────────

describe('check aggregation', () => {
  it('ignores fallback rows and rows with maxPoints 0; pass rate is over runs', () => {
    const rows: IterationCheckResult[][] = [
      [
        { name: 'a', passed: true, points: 10, maxPoints: 10 },
        { name: 'no-runtime-errors', passed: false, points: 0, maxPoints: 0 },
        { name: 'code-fallback', passed: false, points: 0, maxPoints: 0 },
        { name: 'fb', passed: true, points: 5, maxPoints: 5, kind: 'fallback' },
      ],
      [
        { name: 'a', passed: false, points: 0, maxPoints: 10 },
        { name: 'b', passed: true, points: 20, maxPoints: 20 },
      ],
      [{ name: 'a', passed: true, points: 10, maxPoints: 10 }],
    ]
    expect(cellChecks(checkStats(rows))).toEqual([
      { name: 'a', passRate: 2 / 3, meanPoints: 20 / 3, maxPoints: 10, runs: 3 },
      { name: 'b', passRate: 1, meanPoints: 20, maxPoints: 20, runs: 1 },
    ])
  })

  it('returns no rows without check results', () => {
    expect(cellChecks(checkStats(undefined))).toEqual([])
  })

  it('a cell reports the aggregated rows and not the fallback', () => {
    const board = buildBoard(mainWorld())
    const beta = board.cells.find((c) => c.modelId === 'beta' && c.taskId === 'c1')!
    expect(beta.checks).toEqual([{ name: 'k-c1', passRate: 0.2, meanPoints: 2, maxPoints: 10, runs: 5 }])
    const alpha = board.cells.find((c) => c.modelId === 'alpha' && c.taskId === 'c1')!
    expect(alpha.checks.map((c) => c.name)).toEqual(['k-c1'])
  })

  it('a task lists each named check with its maximum points', () => {
    const board = buildBoard(mainWorld())
    expect(board.tasks.find((t) => t.id === 'c1')!.checks).toEqual([{ name: 'k-c1', maxPoints: 10 }])
  })
})

// ── Summary statistics ───────────────────────────────────────────────────

describe('median', () => {
  it.each([
    [[3, 1, 2], 2],
    [[4, 1, 3, 2], 2.5],
    [[null, 5, undefined, 7], 6],
    [[null, undefined], null],
    [[], null],
  ] as Array<[Array<number | null | undefined>, number | null]>)('median of %j is %s', (xs, expected) => {
    expect(median(xs)).toBe(expected)
  })
})

describe('bootstrap interval', () => {
  const samples = [
    [60, 60, 60, 60, 0],
    [80, 80, 80, 80, 80],
  ]

  it('is identical on two runs with the same seed', () => {
    const seed = fnv1a('alpha|headline')
    expect(bootstrapInterval(samples, seed)).toEqual(bootstrapInterval(samples, seed))
  })

  it('contains the mean of the cell means', () => {
    const cellMeans = samples.map((s) => s.reduce((a, b) => a + b, 0) / s.length)
    const center = cellMeans.reduce((a, b) => a + b, 0) / cellMeans.length
    expect(center).toBe(64)
    const interval = bootstrapInterval(samples, fnv1a('alpha|headline'))!
    expect(interval[0]).toBeLessThanOrEqual(center)
    expect(interval[1]).toBeGreaterThanOrEqual(center)
  })

  it.each([
    ['fewer than six iteration values is null', [[1, 2, 3, 4, 5]], false],
    ['six iteration values is measured', [[1, 2, 3, 4, 5, 6]], true],
  ] as Array<[string, number[][], boolean]>)('%s', (_label, s, measured) => {
    expect(bootstrapInterval(s, 7) !== null).toBe(measured)
  })

  it('a constant sample gives a degenerate interval at the value', () => {
    expect(bootstrapInterval([[80, 80, 80, 80, 80, 80]], 1)).toEqual([80, 80])
  })

  it('cells without per-iteration values are held fixed and still contain the mean', () => {
    const interval = bootstrapInterval([70, [80, 80, 80, 80, 80, 80]], 3)!
    expect(interval[0]).toBeLessThanOrEqual(75)
    expect(interval[1]).toBeGreaterThanOrEqual(75)
  })

  it('the board interval contains the mean and is identical on two builds', () => {
    const a = buildBoard(mainWorld())
    const b = buildBoard(mainWorld())
    expect(a.summaries).toEqual(b.summaries)
    const beta = a.summaries.find((s) => s.modelId === 'beta' && s.scope === 'headline')!
    expect(beta.meanScoreAllTrials).toBe(57)
    expect(beta.interval![0]).toBeLessThanOrEqual(57)
    expect(beta.interval![1]).toBeGreaterThanOrEqual(57)
    expect(beta.interval![1]).toBeLessThan(80)
  })
})

describe('frontier', () => {
  it('hand-checked set with ties and dominated points', () => {
    const points = [
      { id: 'A', cost: 1, score: 50 },
      { id: 'B', cost: 1, score: 50 },
      { id: 'C', cost: 2, score: 50 },
      { id: 'D', cost: 0.5, score: 40 },
      { id: 'E', cost: 3, score: 70 },
      { id: 'F', cost: 3, score: 60 },
    ]
    expect([...paretoFrontier(points)].sort()).toEqual(['A', 'B', 'D', 'E'])
  })

  it('a model with unmeasured cost is never on the frontier', () => {
    const base = mainWorld()
    const models = [...base.models, model('free', 'Free')]
    const results = [
      ...base.results.filter((r) => r.modelId === 'alpha'),
      ...['c1', 'c2', 'c3', 'c4'].map((taskId) => full(taskId, 'free', 95)),
    ]
    const board = buildBoard(withWorld(results, models, base.tasks))
    const free = board.summaries.find((s) => s.modelId === 'free' && s.scope === 'headline')!
    expect(free).toMatchObject({ tasksCovered: 4, costPerAttempt: null, onFrontier: false })
    expect(board.summaries.find((s) => s.modelId === 'alpha' && s.scope === 'headline')!.onFrontier).toBe(true)
  })

  it('a model below 80 percent coverage is not on the frontier', () => {
    const gamma = buildBoard(mainWorld()).summaries.find((s) => s.modelId === 'gamma' && s.scope === 'headline')!
    expect(gamma).toMatchObject({ tasksCovered: 2, tasksTotal: 4, onFrontier: false })
  })

  it('beta is dominated by alpha (higher cost and lower score)', () => {
    const beta = buildBoard(mainWorld()).summaries.find((s) => s.modelId === 'beta' && s.scope === 'headline')!
    expect(beta.onFrontier).toBe(false)
  })
})

describe('summaries', () => {
  it('a model covers only the tasks in each scope', () => {
    const board = buildBoard(mainWorld())
    expect(board.summaries.find((s) => s.modelId === 'alpha' && s.scope === 'headline')).toMatchObject({ tasksCovered: 4, tasksTotal: 4 })
    expect(board.summaries.find((s) => s.modelId === 'alpha' && s.scope === 'smoke')).toMatchObject({ tasksCovered: 1, tasksTotal: 1, meanScoreAllTrials: 100 })
    // Version 2 records only: the earlier-runs scope holds version 1 records, so it has no summary here.
    expect(board.summaries.find((s) => s.scope === 'earlier')).toBeUndefined()
  })

  it('carries the documented fields for a measured model', () => {
    const board = buildBoard(mainWorld())
    const alpha = board.summaries.find((s) => s.modelId === 'alpha' && s.scope === 'headline')!
    expect(alpha.meanScoreAllTrials).toBe(80)
    expect(alpha.interval).toEqual([80, 80])
    expect(alpha.meanScore).toBe(80)
    expect(alpha.successRate).toBe(1)
    expect(alpha.totalCostUsd).toBeCloseTo(0.4, 12)
    expect(alpha.costPerAttempt).toBeCloseTo(0.02, 12)
    expect(alpha.medianRuntimeMs).toBe(1000)
    expect(alpha.medianTtftMs).toBe(300)
    expect(alpha.medianTokensPerSec).toBe(50)
    expect(alpha.outputTokensPerTask).toBe(40)
    expect(alpha.onFrontier).toBe(true)
  })

  it('a partial model has a completion rate and no timings', () => {
    const beta = buildBoard(mainWorld()).summaries.find((s) => s.modelId === 'beta' && s.scope === 'headline')!
    expect(beta.meanScoreAllTrials).toBe(57)
    expect(beta.successRate).toBeCloseTo(19 / 20, 12)
    expect(beta.medianTtftMs).toBeNull()
    expect(beta.medianTokensPerSec).toBeNull()
  })

  it('throws on a live record for an unknown model or task, and on duplicates', () => {
    const base = mainWorld()
    expect(() => buildBoard({ ...base, results: [...base.results, rec({ taskId: 'c1', modelId: 'nobody' })] })).toThrow(/unknown model "nobody"/)
    expect(() => buildBoard({ ...base, results: [...base.results, rec({ taskId: 'zz', modelId: 'alpha' })] })).toThrow(/unknown task "zz"/)
    expect(() => buildBoard({ ...base, results: [...base.results, rec({ taskId: 'c1', modelId: 'alpha', score: 1 })] })).toThrow(/two live records for alpha\|c1/)
  })

  it('is deterministic for a fixed now and stamps schema and scorer versions', () => {
    const a = buildBoard(mainWorld())
    expect(a).toEqual(buildBoard(mainWorld()))
    expect(a.generatedAt).toBe(NOW)
    expect(a.schemaVersion).toBe(3)
    expect(a.cells.every((c) => c.scorerVersion === 2)).toBe(true)
  })

  it('a record stamped with scorerVersion 2 keeps it', () => {
    const board = buildBoard(withWorld([rec({ taskId: 'c1', modelId: 'alpha', score: 80, scorerVersion: 2, scoreAllTrials: 80 })], [model('alpha', 'Alpha')], [task('c1')]))
    expect(board.cells[0].scorerVersion).toBe(2)
  })

  it('captures are null without a signals file, and join by key when the output hash matches', () => {
    const plain = buildBoard(mainWorld()).cells[0]
    expect(plain).toMatchObject({ captureStatus: 'none', shots: [], captures: [] })
    const output = '<!doctype html><html><body>alpha on c1</body></html>'
    const world = mainWorld()
    const withOutput = { ...world, results: world.results.map((r) => (r.modelId === 'alpha' && r.taskId === 'c1' ? { ...r, output } : r)) }
    const joined = buildBoard({
      ...withOutput,
      signals: {
        cells: {
          'alpha|c1': { outputSha256: sha256(output), shots: ['gallery/c1/alpha-a.jpg'], captures: [{ viewport: '1024 x 720', afterLoadMs: 3000, posed: true }] },
        },
      },
    }).cells.find((c) => c.modelId === 'alpha' && c.taskId === 'c1')!
    expect(joined).toMatchObject({ captureStatus: 'current', shots: ['gallery/c1/alpha-a.jpg'], captures: [{ viewport: '1024 x 720', afterLoadMs: 3000, posed: true }] })
  })

  it('captures taken from an earlier output are not attached: the cell says they are out of date', () => {
    const world = mainWorld()
    const rerun = { ...world, results: world.results.map((r) => (r.modelId === 'alpha' && r.taskId === 'c1' ? { ...r, output: '<html>the new output</html>' } : r)) }
    const board = buildBoard({
      ...rerun,
      signals: {
        cells: {
          'alpha|c1': { outputSha256: sha256('<html>the old output</html>'), shots: ['gallery/c1/alpha-a.jpg'], captures: [{ viewport: '1024 x 720', afterLoadMs: 3000, posed: false }] },
        },
      },
    })
    const cell = board.cells.find((c) => c.modelId === 'alpha' && c.taskId === 'c1')!
    expect(cell).toMatchObject({ captureStatus: 'out-of-date', shots: [], captures: [] })
  })

  it('the board carries no text from the artifacts: the cells have no signals field', () => {
    const board = buildBoard({
      ...mainWorld(),
      signals: { cells: { 'alpha|c1': { outputSha256: sha256('x'), shots: [], captures: [] } } },
    })
    for (const cell of board.cells) expect(Object.keys(cell)).not.toContain('signals')
  })
})

// ── Insights ─────────────────────────────────────────────────────────────

describe('insights', () => {
  it('main world: headline findings for all models are present, in order, with an explicit figure and unit', () => {
    const board = buildBoard(mainWorld())
    expect(board.insights.headline.all.map((i) => i.id)).toEqual(['top', 'value', 'frontier', 'spread', 'check', 'speed', 'reliability'])
    for (const i of board.insights.headline.all) {
      expect(i.figure.length).toBeGreaterThan(0)
      expect(i.figureUnit.length).toBeGreaterThan(0)
    }
  })

  it('top: names the leader and the gap to the next model, with the sample set and requested iterations', () => {
    const top = find(buildBoard(mainWorld()), 'top')!
    expect(top).toMatchObject({ figure: '80.0', figureUnit: 'pts', anchor: 'leaderboard', title: 'Top score, headline tasks' })
    // Alpha has 4 cells and Beta 4, each of 5 requested iterations: 40 behind the two means.
    expect(top.body).toBe(
      'Alpha leads at 80.0 all-trials score. It is 23.0 points ahead of Beta, and their intervals do not overlap (2 configurations covering at least 80% of the headline tasks, 40 requested iterations).'
    )
  })

  it('top: an exact tie is named as a tie that cannot be ranked, not as a leader', () => {
    const base = mainWorld()
    const betaSame = ['c1', 'c2', 'c3', 'c4'].map((taskId) => full(taskId, 'beta', 80))
    const board = buildBoard({
      ...base,
      results: [...base.results.filter((r) => r.modelId !== 'beta'), ...betaSame],
    })
    expect(find(board, 'top')!.body).toContain('Alpha and Beta both score 80.0 on every iteration, so the top cannot be ranked among them (2 configurations covering at least 80% of the headline tasks, 40 requested iterations).')
    expect(find(board, 'top')!.body).not.toContain('leads at')
  })

  it('top, value and frontier are absent when no focus model covers 80 percent of headline tasks', () => {
    // The headline tasks in scope are the four with any headline record. Alpha and Beta run two of them, and
    // Delta runs the other two: no model covers 80 percent of the four.
    const base = mainWorld()
    const delta = model('delta', 'Delta', { company: 'Acme' })
    const board = buildBoard({
      ...base,
      models: [...base.models, delta],
      results: [
        ...base.results.filter((r) => r.taskId === 'c1' || r.taskId === 'c2' || r.taskId === 's1'),
        full('c3', 'delta', 70),
        full('c4', 'delta', 70),
      ],
    })
    expect(board.scopeTasks.headline).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(find(board, 'top')).toBeUndefined()
    expect(find(board, 'value')).toBeUndefined()
    expect(find(board, 'frontier')).toBeUndefined()
    // The check finding pools the covering configurations only, so with none covering it is absent too.
    expect(find(board, 'check')).toBeUndefined()
  })

  it('value: the cheapest configuration within five points of the top', () => {
    const base = mainWorld()
    const betaCheap = ['c1', 'c2', 'c3', 'c4'].map((taskId) => full(taskId, 'beta', 78, { costUsd: 0.05 }))
    const board = buildBoard({ ...base, results: [...base.results.filter((r) => r.modelId !== 'beta'), ...betaCheap] })
    expect(find(board, 'value')!.body).toContain('Beta is the cheapest configuration within 5 points of the top, at $0.0100 per attempt')
    expect(find(board, 'value')).toMatchObject({ figure: '$0.0100', figureUnit: 'per attempt' })
  })

  it('value: the top model is the answer when it is the only one within the margin', () => {
    const board = buildBoard(mainWorld())
    expect(find(board, 'value')!.body).toContain('Alpha is the cheapest configuration within 5 points of the top, at $0.0200 per attempt')
  })

  it('frontier: lists the models on the cost-accuracy frontier with the sample set', () => {
    const frontier = find(buildBoard(mainWorld()), 'frontier')!
    expect(frontier).toMatchObject({ figure: '1 of 2', figureUnit: 'on the frontier' })
    expect(frontier.body).toMatch(
      /^Of 2 configurations in all models with a measured cost that cover at least 80% of the headline tasks, one is on the cost-accuracy frontier: Alpha \(\$0\.0200 per attempt, 80\.0 all-trials score\)\. Dominated, so off the frontier/
    )
    // Beta costs more and scores less than Alpha, so Alpha dominates it: its point score and interval are named.
    expect(frontier.body).toMatch(/ Beta \(\d+\.\d, interval \[\d+\.\d to \d+\.\d\]\) is dominated by Alpha \(80\.0, interval \[\d+\.\d to \d+\.\d\]\)\. Membership compares point scores: differences inside the intervals are not established \(2 configurations covering at least 80% of the headline tasks, 40 requested iterations\)\.$/)
  })

  it('effort: one insight per base model with two effort levels, with the score and cost change', () => {
    const models = [
      model('delta-base', 'Delta Base'),
      model('delta-low', 'Delta Low', { baseModelId: 'delta-base', reasoningEffort: 'low' }),
      model('delta-high', 'Delta High', { baseModelId: 'delta-base', reasoningEffort: 'high' }),
    ]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = ['c1', 'c2', 'c3', 'c4'].flatMap((taskId) => [
      full(taskId, 'delta-low', 50, { costUsd: 0.2, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
      full(taskId, 'delta-high', 70, { costUsd: 0.6, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
    ])
    const effort = find(buildBoard(withWorld(results, models, tasks)), 'effort-delta-base')!
    expect(effort).toMatchObject({ figure: '+20.0', figureUnit: 'pts', title: 'Effort trade-off: Delta Base' })
    expect(effort.body).toContain('Delta Base all-trials scores by effort, with 95% intervals: low 50.0 [50.0 to 50.0] and high 70.0 [70.0 to 70.0].')
    expect(effort.body).toContain('The change from low to high effort, +20.0 points, is established: the two 95% intervals do not overlap.')
    expect(effort.body).toContain('Cost per attempt changes by +$0.0800 ($0.0400 to $0.120) (compared on 4 tasks every effort level ran; 2 configurations covering at least 80% of the headline tasks, 40 requested iterations).')
  })

  it('effort: absent with a single effort level', () => {
    const board = buildBoard(mainWorld())
    expect(board.insights.headline.all.some((i) => i.id.startsWith('effort-'))).toBe(false)
  })

  it('spread: names the widest headline gap among covered models, and the no-task-clears-95 sentence', () => {
    const spread = find(buildBoard(mainWorld()), 'spread')!
    expect(spread.body).toContain(
      'Task Three has the widest spread among covered configurations: Alpha scored 80.0 and Beta scored 48.0, a gap of 32.0 points.'
    )
    expect(spread.body).toContain('No headline task had every covered configuration that ran it at 95 or more (2 configurations covering at least 80% of the headline tasks, 40 requested iterations).')
    expect(spread).toMatchObject({ figure: '32.0', figureUnit: 'pts' })
  })

  it('spread: lists the tasks on which every covered configuration that ran them scored 95 or more', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id, { title: `Task ${id}` }))
    const results = [
      full('c1', 'alpha', 96), full('c1', 'beta', 97),
      full('c2', 'alpha', 96), full('c2', 'beta', 97),
      full('c3', 'alpha', 96), full('c3', 'beta', 60),
      full('c4', 'alpha', 96), full('c4', 'beta', 97),
    ]
    const spread = find(buildBoard(withWorld(results, models, tasks)), 'spread')!
    expect(spread.body).toContain('Task c3 has the widest spread among covered configurations: Alpha scored 96.0 and Beta scored 60.0, a gap of 36.0 points.')
    expect(spread.body).toContain('Every covered configuration that ran Task c1, Task c2 and Task c4 scored 95 or more (2 configurations covering at least 80% of the headline tasks, 40 requested iterations).')
  })

  it('spread: absent when no headline task has two focus models', () => {
    const base = mainWorld()
    expect(find(buildBoard({ ...base, results: base.results.filter((r) => r.modelId === 'alpha') }), 'spread')).toBeUndefined()
  })

  it('check: names the lowest pooled pass rate across the covering configurations only, with the sample and completed iterations', () => {
    // Alpha and Beta cover the four headline tasks; Gamma runs two of them, so its check rows are not pooled. k-c1 passes
    // 5 of 5 for Alpha and 1 of 5 for Beta: 6 of 10 (60.0%), the lowest over the covering sample.
    const check = find(buildBoard(mainWorld()), 'check')!
    expect(check).toMatchObject({ figure: '60.0', figureUnit: '% passed' })
    expect(check.body).toMatch(
      /^The lowest check pass rate is k-c1 \(Task One\), passed in 60\.0% of 10 runs\. Named check rows were recorded for every one of the 8 cells in that sample \(pooled over 2 configurations covering at least 80% of the headline tasks; 10 of \d+ completed iterations in those cells recorded this check\)\.$/
    )
  })
  it('check: absent without check rows', () => {
    const base = mainWorld()
    const board = buildBoard({ ...base, results: base.results.map((r) => ({ ...r, iterationCheckResults: undefined })) })
    expect(find(board, 'check')).toBeUndefined()
  })

  it('speed: uses decode-rate measurements only, and names only covered models', () => {
    const speed = find(buildBoard(mainWorld()), 'speed')!
    expect(speed.body).toMatch(
      /^Among covered API and local routes with measured timings, the lowest median time to first visible token is Alpha at 0\.30 s and the highest median output speed is Alpha at 50\.0 tokens per second\. Command-line agent routes are left out \(1 configuration covering at least 80% of the headline tasks, \d+ completed iterations\)\.$/
    )
    expect(speed).toMatchObject({ figure: '0.30', figureUnit: 's to first visible token' })
  })

  it('speed: absent without decode-rate telemetry', () => {
    const base = mainWorld()
    const board = buildBoard({
      ...base,
      results: base.results.map((r) => ({ ...r, telemetry: { meanTokensPerSec: 20, rateKind: 'wall-clock' as const, cacheHits: 0, retries: 0 } })),
    })
    expect(find(board, 'speed')).toBeUndefined()
  })

  it('reliability: names the models in view with failed iterations and their completion rates', () => {
    const rel = find(buildBoard(mainWorld()), 'reliability')!
    expect(rel.body).toBe(
      '1 of the 2 configurations covering at least 80% of the headline tasks had failed iterations: Beta (95.0% completed; recorded reason model_error) (39 of 40 requested iterations completed).'
    )
    expect(rel).toMatchObject({ figure: '95.0', figureUnit: '% completed' })
  })

  it('reliability: says none when every focus model completed every iteration', () => {
    const base = mainWorld()
    const board = buildBoard({
      ...base,
      results: base.results.map((r) => (r.modelId === 'beta' && r.taskId === 'c3' ? full('c3', 'beta', 60) : r)),
    })
    expect(find(board, 'reliability')!.body).toContain('None of the 2 configurations covering at least 80% of the headline tasks had a failed iteration (40 of 40 requested iterations completed).')
  })

  it('the Claude group is computed under its own key, with its own sample set', () => {
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const models = [
      model('alpha', 'Alpha'),
      model('claude-a', 'Claude A', { company: 'Anthropic' }),
      model('claude-b', 'Claude B', { company: 'Anthropic' }),
    ]
    const results = ['c1', 'c2', 'c3', 'c4'].flatMap((taskId) => [
      full(taskId, 'alpha', 90),
      full(taskId, 'claude-a', 70),
      full(taskId, 'claude-b', 65),
    ])
    const board = buildBoard(withWorld(results, models, tasks))
    const top = find(board, 'top', 'claude')!
    expect(top.body.startsWith('Claude A leads at 70.0 all-trials score')).toBe(true)
    expect(top.body).toContain('(2 configurations covering at least 80% of the headline tasks, 40 requested iterations)')
    expect(top.body).not.toContain('Alpha')
    expect(find(board, 'top', 'all')!.body.startsWith('Alpha leads at 90.0')).toBe(true)
  })

  it('a smoke-only world has no headline findings, and its smoke findings are computed', () => {
    const base = mainWorld()
    const board = buildBoard({ ...base, results: base.results.filter((r) => r.taskId === 's1') })
    expect(board.insights.headline.all).toEqual([])
    expect(board.insights.headline.claude).toEqual([])
    expect(board.summaries.some((s) => s.scope === 'headline')).toBe(false)
    expect(board.insights.smoke.all.length).toBeGreaterThan(0)
  })

  it('a single-model world omits spread and keeps top and reliability', () => {
    const base = mainWorld()
    const board = buildBoard({ ...base, results: base.results.filter((r) => r.modelId === 'alpha') })
    expect(find(board, 'spread')).toBeUndefined()
    expect(find(board, 'top')!.body).toMatch(/^Alpha leads at 80\.0 all-trials score \(1 configuration covering at least 80% of the headline tasks, 20 requested iterations\)\.$/)
    expect(find(board, 'reliability')!.body).toContain('None of the 1 configuration covering at least 80% of the headline tasks had a failed iteration')
  })
})

// ── Dollar format and the per-scope task denominator ─────────────────────

describe('formatUsd: three significant figures, as the tables print', () => {
  it.each([
    [0, '$0'],
    [0.01488, '$0.0149'],
    [0.0347, '$0.0347'],
    [0.1, '$0.100'],
    [1.5, '$1.50'],
    [12.25, '$12.3'],
  ] as Array<[number, string]>)('%s is %s', (x, text) => {
    expect(formatUsd(x)).toBe(text)
  })
})

describe('scope task denominators', () => {
  it('a scope counts only the tasks with a record of its own scorer version', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = [
      full('c1', 'alpha', 80, { scorerVersion: 1 }),
      full('c2', 'alpha', 80, { scorerVersion: 1 }),
      full('c3', 'beta', 70, { scorerVersion: 2 }),
    ]
    const board = buildBoard(withWorld(results, models, tasks))
    expect(board.scopeTasks.earlier).toEqual(['c1', 'c2'])
    expect(board.scopeTasks.headline).toEqual(['c3'])
    expect(board.scopeTasks.smoke).toEqual([])
    expect(board.summaries.find((s) => s.modelId === 'alpha' && s.scope === 'earlier')).toMatchObject({ tasksTotal: 2, tasksCovered: 2 })
  })
})
