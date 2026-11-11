import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  BenchmarkModel,
  BenchmarkResult,
  BenchmarkTask,
  IterationCheckResult,
} from '../llm-benchmark/types'
import * as registry from '../llm-benchmark/registry'
import { bootstrapInterval, buildBoard, fnv1a, type BuildInput } from './board'

/**
 * Regression tests for the defects found in review. Each block names the
 * defect it pins, so a later change that reintroduces it fails here.
 */

const NOW = '2026-11-10T12:00:00.000Z'
const CLASSIC = 'community-tasks'

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

const CATEGORIES = [{ slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' }]

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

const DECODE = { meanTtftMs: 300, meanTokensPerSec: 50, rateKind: 'decode' as const, cacheHits: 0, retries: 0 }

describe('defect: command-line routes showed first-output timings as token timings', () => {
  it('a decode-labelled record on a command-line provider keeps no TTFT or tokens/s', () => {
    const models = [model('codex', 'Codex Model', { provider: 'Codex' }), model('api', 'API Model', { provider: 'OpenAI' })]
    const tasks = [task('c1')]
    const board = buildBoard(world([
      full('c1', 'codex', 80, { telemetry: { ...DECODE, meanTokensPerSec: 90000 } }),
      full('c1', 'api', 80, { telemetry: DECODE }),
    ], models, tasks))
    const codex = board.cells.find((c) => c.modelId === 'codex')!
    expect(codex.ttftMs).toBeNull()
    expect(codex.tokensPerSec).toBeNull()
    expect(board.cells.find((c) => c.modelId === 'api')!.ttftMs).toBe(300)
    const s = board.summaries.find((x) => x.modelId === 'codex' && x.scope === 'headline')!
    expect(s.medianTtftMs).toBeNull()
    expect(s.medianTokensPerSec).toBeNull()
  })

  it('a first token after 90% of the runtime is not a decode timing, on any route', () => {
    const models = [model('api', 'API Model', { provider: 'OpenAI' })]
    const tasks = [task('c1')]
    const board = buildBoard(world([
      full('c1', 'api', 80, { runtimeMs: 1000, telemetry: { ...DECODE, meanTtftMs: 950, meanTokensPerSec: 5000 } }),
    ], models, tasks))
    const cell = board.cells[0]
    expect(cell.ttftMs).toBeNull()
    expect(cell.tokensPerSec).toBeNull()
  })

  it('the speed insight never names a command-line model', () => {
    const models = [model('codex', 'Codex Model', { provider: 'Codex' }), model('api', 'API Model', { provider: 'OpenAI' })]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world(['c1', 'c2'].flatMap((t) => [
      full(t, 'codex', 80, { telemetry: { ...DECODE, meanTokensPerSec: 90000, meanTtftMs: 10 } }),
      full(t, 'api', 80, { telemetry: { ...DECODE, meanTokensPerSec: 60, meanTtftMs: 400 } }),
    ]), models, tasks))
    const speed = board.insights.headline.all.find((i) => i.id === 'speed')!
    expect(speed.body).not.toContain('Codex Model')
    expect(speed.body).toContain('API Model')
  })
})

describe('defect: an all-failed cell carried runtime 0 and output tokens 0', () => {
  it('the cell has no runtime or token measurement; the median ignores it, and the output mean counts its billed tokens', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      full('c1', 'm', 80, { runtimeMs: 1000, tokensOut: 200, tokensIn: 100 }),
      rec({ taskId: 'c2', modelId: 'm', score: 0, status: 'fail', iterationsSucceeded: 0, runtimeMs: 0, tokensOut: 0, tokensIn: 0 }),
    ], models, tasks))
    const failed = board.cells.find((c) => c.taskId === 'c2')!
    expect(failed.runtimeMs).toBeNull()
    expect(failed.tokensOut).toBeNull()
    expect(failed.tokensIn).toBeNull()
    const s = board.summaries.find((x) => x.modelId === 'm' && x.scope === 'headline')!
    expect(s.medianRuntimeMs).toBe(1000)
    // The failed cell's billed output (0 in this fixture) is one of the two cells: (40 + 0) / 2.
    expect(s.outputTokensPerTask).toBe(20)
  })

  it('a median over one completed cell (1000 ms) and one all-failed cell is 1000, not 500', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      full('c1', 'm', 80, { runtimeMs: 1000 }),
      rec({ taskId: 'c2', modelId: 'm', score: 0, status: 'fail', iterationsSucceeded: 0, runtimeMs: 0 }),
    ], models, tasks))
    expect(board.summaries.find((x) => x.scope === 'headline')!.medianRuntimeMs).toBe(1000)
  })
})

describe('defect: mean score when run counted all-failed cells as zero', () => {
  it('the mean counts completed iterations only: one completed cell at 100 and one all-failed cell give 100', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      rec({ taskId: 'c1', modelId: 'm', score: 100, status: 'partial', iterationScores: [100], iterationsSucceeded: 1 }),
      rec({ taskId: 'c2', modelId: 'm', score: 0, status: 'fail', iterationsSucceeded: 0 }),
    ], models, tasks))
    const s = board.summaries.find((x) => x.scope === 'headline')!
    expect(s.meanScore).toBe(100)
    // The all-trials mean still counts the failures: (20 + 0) / 2.
    expect(s.meanScoreAllTrials).toBe(10)
    expect(s.successRate).toBeCloseTo(1 / 10, 12)
  })

  it('is the plain mean over tasks of each completed cell\'s score, not weighted by iterations (changed in round two)', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      rec({ taskId: 'c1', modelId: 'm', score: 90, iterationScores: [90, 90, 90, 90], iterationsSucceeded: 4, status: 'partial' }),
      rec({ taskId: 'c2', modelId: 'm', score: 60, iterationScores: [60], iterationsSucceeded: 1, status: 'partial' }),
    ], models, tasks))
    // (90 + 60) / 2 = 75: each task counts once, whatever its number of completed iterations.
    expect(board.summaries.find((x) => x.scope === 'headline')!.meanScore).toBeCloseTo(75, 9)
  })

  it('is null when no cell has a completed iteration', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1')]
    const board = buildBoard(world([rec({ taskId: 'c1', modelId: 'm', score: 0, status: 'fail', iterationsSucceeded: 0 })], models, tasks))
    expect(board.summaries.find((x) => x.scope === 'headline')!.meanScore).toBeNull()
  })
})

describe('defect: a cell-level bootstrap kept the same cells in every resample', () => {
  it('single-iteration cells with spread scores give a wide interval, not a zero-width one', () => {
    const scores = [3, 3, 52, 97, 100, 100, 100]
    const iv = bootstrapInterval(scores.map((s) => [s]), fnv1a('kimi|smoke'))!
    expect(iv).not.toBeNull()
    expect(iv[1] - iv[0]).toBeGreaterThan(20)
    expect(iv[0]).toBeLessThan(50)
    expect(iv[1]).toBeGreaterThan(80)
  })

  it('a two-point sample gives the analytic 95% interval within tolerance', () => {
    // 50 cells at 0 and 50 at 100: the mean of 100 draws has sd 50 / sqrt(100) = 5, so the 95% interval is 50 +/- 9.8.
    const samples = [...Array(50).fill([0]), ...Array(50).fill([100])] as number[][]
    const iv = bootstrapInterval(samples, fnv1a('two-point'))!
    expect(iv[0]).toBeGreaterThan(40.2 - 1.5)
    expect(iv[0]).toBeLessThan(40.2 + 1.5)
    expect(iv[1]).toBeGreaterThan(59.8 - 1.5)
    expect(iv[1]).toBeLessThan(59.8 + 1.5)
  })

  it('is not clamped to the reported mean', () => {
    const iv = bootstrapInterval([[0], [0], [0], [0], [0], [0], [100]], fnv1a('skew'))!
    expect(iv[0]).toBeGreaterThan(-1)
    expect(iv[1]).toBeLessThan(101)
    expect(iv[1] - iv[0]).toBeGreaterThan(0)
  })

  it('a model whose cells are all constant keeps a degenerate interval at the value', () => {
    expect(bootstrapInterval([[80, 80, 80, 80, 80, 80]], 1)).toEqual([80, 80])
  })
})

describe('defect: the top finding claimed a lead with no interval to support it', () => {
  it('says the lead is not established when the leader has fewer than six iteration values', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = [
      ...['c1', 'c2', 'c3', 'c4'].map((id) =>
        rec({ taskId: id, modelId: 'alpha', score: 80, iterations: 1, iterationScores: [80], iterationsSucceeded: 1 })
      ),
      ...['c1', 'c2', 'c3', 'c4'].map((id) => full(id, 'beta', 60)),
    ]
    const top = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'top')!
    expect(top.body).toContain('20.0 points ahead of Beta')
    expect(top.body).toContain('so the lead is not established')
  })
})

describe('defect: a tied widest spread named only the first task', () => {
  it('names both tasks when two tasks share the widest gap', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = [task('c1'), task('c2')]
    const results = ['c1', 'c2'].flatMap((id) => [full(id, 'alpha', 90), full(id, 'beta', 60)])
    const spread = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'spread')!
    expect(spread.body).toContain('Task c1 and Task c2 share the widest spread among covered configurations, a gap of 30.0 points.')
    expect(spread).toMatchObject({ figure: '30.0', figureUnit: 'pts' })
  })

  it('says a low end with no completed iteration had none', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = [task('c1')]
    const results = [
      full('c1', 'alpha', 90),
      rec({ taskId: 'c1', modelId: 'beta', score: 0, status: 'fail', iterationsSucceeded: 0 }),
    ]
    const spread = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'spread')!
    expect(spread.body).toContain('Beta had no completed iteration (0.0)')
  })
})

describe('summary and source counts', () => {
  it('cost per task is the mean over measured cells only, and pricedCells counts them', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      full('c1', 'm', 80, { costUsd: 0.2, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
      full('c2', 'm', 80, { costUsd: 0 }),
    ], models, tasks))
    const s = board.summaries.find((x) => x.scope === 'headline')!
    expect(s.costPerAttempt).toBeCloseTo(0.04, 12)
    expect(s.pricedCells).toBe(1)
    expect(s.tasksCovered).toBe(2)
  })

  it('counts requested and completed iterations, fallback cells and dropped check rows that threw', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const threw: IterationCheckResult[][] = [
      [{ name: '', passed: false, points: 0, maxPoints: 0, detail: 'threw: check timeout after 6000ms' }],
      [{ name: '', passed: false, points: 0, maxPoints: 0, detail: 'threw: check timeout after 6000ms' }],
    ]
    const board = buildBoard(world([
      full('c1', 'm', 80, {
        iterationCheckResults: [[{ name: 'a', passed: true, points: 10, maxPoints: 10 }]],
      }),
      rec({
        taskId: 'c2', modelId: 'm', score: 50, iterationScores: [50, 50, 0, 0, 0], iterationsSucceeded: 2, status: 'partial',
        iterationCheckResults: threw.map((row) => [...row, { name: 'code-fallback', passed: false, points: 0, maxPoints: 0, kind: 'fallback' }]),
      }),
    ], models, tasks))
    expect(board.source.iterationsRequested).toBe(10)
    expect(board.source.iterationsCompleted).toBe(7)
    expect(board.source.fallbackCells).toBe(1)
    expect(board.cells.find((c) => c.taskId === 'c2')!.checkRowsThrew).toBe(2)
    expect(board.source.cellsWithCheckRows).toBe(1)
  })
})

describe('the board built from the real results.json', () => {
  const resultsPath = fileURLToPath(new URL('../llm-benchmark/results.json', import.meta.url))
  it.skipIf(!existsSync(resultsPath))('no summary has a zero median runtime, and no zero-width interval spans different cell scores', () => {
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
    const board = buildBoard({
      results,
      models: registry.BENCHMARK_MODELS,
      tasks: registry.BENCHMARK_TASKS,
      categories: registry.BENCHMARK_CATEGORIES,
      now: NOW,
      resultsSha256: 'test',
    })
    for (const s of board.summaries) {
      if (s.medianRuntimeMs !== null) expect(s.medianRuntimeMs, `${s.modelId} ${s.scope}`).toBeGreaterThan(0)
      if (s.interval && s.interval[1] - s.interval[0] === 0) {
        const inScopeTask = (taskId: string) => {
          const t = board.tasks.find((x) => x.id === taskId)
          if (!t) return false
          if (s.scope === 'earlier') return true
          return s.scope === 'headline' ? t.headline : t.suite === 'smoke'
        }
        const cells = board.cells.filter((c) => c.modelId === s.modelId && inScopeTask(c.taskId))
        const spread = new Set(cells.map((c) => c.scoreAllTrials))
        expect(spread.size, `${s.modelId} ${s.scope} zero-width interval over varied cells`).toBeLessThanOrEqual(1)
      }
    }
    for (const c of board.cells) {
      if (c.succeeded === 0) {
        expect(c.runtimeMs, `${c.modelId} ${c.taskId}`).toBeNull()
        expect(c.tokensOut, `${c.modelId} ${c.taskId}`).toBeNull()
      }
    }
  })
})

// ── Round two: data rules ───────────────────────────────────────────────────

import { pricingOf, GROUP_KEYS, SCOPE_KEYS } from './board'

const realBoard = () => {
  const resultsPath = fileURLToPath(new URL('../llm-benchmark/results.json', import.meta.url))
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
  return buildBoard({
    results,
    models: registry.BENCHMARK_MODELS,
    tasks: registry.BENCHMARK_TASKS,
    categories: registry.BENCHMARK_CATEGORIES,
    now: NOW,
    resultsSha256: 'test',
  })
}

describe('rule B1: cost is measured only for a model with a positive per-token price', () => {
  it('a model with no per-token price keeps a null cost, even when its record carries a usage block', () => {
    const models = [model('free', 'Free Route', { provider: 'OpenRouter', costPer1kInputUsd: 0, costPer1kOutputUsd: 0 })]
    const tasks = [task('c1')]
    const board = buildBoard(world([full('c1', 'free', 80, { costUsd: 0.5, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } })], models, tasks))
    expect(board.models[0].pricing).toBe('no-per-token-price')
    expect(board.cells[0].costUsd).toBeNull()
    expect(board.summaries.find((s) => s.scope === 'headline')!.costPerAttempt).toBeNull()
  })

  it('a priced model with a reported zero cost has a null cost, so no $0 point reaches the chart', () => {
    const models = [model('priced', 'Priced', { costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002 })]
    const tasks = [task('c1')]
    const board = buildBoard(world([full('c1', 'priced', 80, { costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } })], models, tasks))
    expect(board.cells[0].costUsd).toBeNull()
  })

  it('a priced model with a positive cost keeps it', () => {
    const models = [model('priced', 'Priced', { costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002 })]
    const tasks = [task('c1')]
    const board = buildBoard(world([full('c1', 'priced', 80, { costUsd: 0.03, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } })], models, tasks))
    expect(board.models[0].pricing).toBe('priced')
    expect(board.cells[0].costUsd).toBe(0.03)
  })

  it('the real board: every cost is on a priced model', () => {
    const board = realBoard()
    const pricing = new Map(board.models.map((m) => [m.id, m.pricing]))
    for (const c of board.cells) {
      if (c.costUsd !== null) expect(pricing.get(c.modelId), c.modelId).toBe('priced')
    }
    for (const m of board.models.filter((x) => x.pricing === 'no-per-token-price')) {
      expect(board.cells.filter((c) => c.modelId === m.id && c.costUsd !== null).length, m.id).toBe(0)
    }
  })
})

describe('rule B2: a positive price under one cent per million tokens is under review', () => {
  it('pricingOf classifies the three states at the threshold', () => {
    expect(pricingOf({ costPer1kInputUsd: 0, costPer1kOutputUsd: 0 })).toBe('no-per-token-price')
    expect(pricingOf({ costPer1kInputUsd: 0.0000015, costPer1kOutputUsd: 0.0000075 })).toBe('price-under-review')
    expect(pricingOf({ costPer1kInputUsd: 0.0000099, costPer1kOutputUsd: 0 })).toBe('price-under-review')
    expect(pricingOf({ costPer1kInputUsd: 0.00001, costPer1kOutputUsd: 0 })).toBe('priced')
    expect(pricingOf({ costPer1kInputUsd: 0.00035, costPer1kOutputUsd: 0.00105 })).toBe('priced')
  })

  it('the real board: Gemini 3.6 Flash (OpenRouter) is priced after the repricing, not under review, and each cell cost is its recorded tokens at the registry price', () => {
    const board = realBoard()
    const gemini = board.models.find((m) => m.id === 'gemini-3.6-flash')
    // Registry price now $0.75 per million input and $3.75 per million output tokens (it was 500 times too low before).
    expect(gemini?.pricing).toBe('priced')
    expect(gemini?.priceInPerM).toBe(0.75)
    expect(gemini?.priceOutPerM).toBe(3.75)
    expect(board.source.priceUnderReview).not.toContain(gemini!.name)
    // Independent recompute from the raw records: cost = tokensIn x $0.75/M + tokensOut x $3.75/M.
    const resultsPath = fileURLToPath(new URL('../llm-benchmark/results.json', import.meta.url))
    const raw = JSON.parse(readFileSync(resultsPath, 'utf8')) as Array<{ modelId: string; taskId: string; tokensIn: number; tokensOut: number; source?: string }>
    const records = raw.filter((r) => r.modelId === 'gemini-3.6-flash' && r.source === 'live')
    const cells = board.cells.filter((c) => c.modelId === 'gemini-3.6-flash')
    expect(records).toHaveLength(8)
    expect(cells).toHaveLength(8)
    for (const r of records) {
      const cell = cells.find((c) => c.taskId === r.taskId)!
      expect(cell.costUsd, r.taskId).toBeCloseTo((r.tokensIn * 0.75 + r.tokensOut * 3.75) / 1e6, 9)
    }
  })
})

describe('rule B3: mean score when run is a plain mean over tasks, so it can never sit below the all-trials mean', () => {
  it('the real board: for every summary, the all-trials mean never exceeds the mean when run (exact, no allowance)', () => {
    const board = realBoard()
    expect(board.summaries.length).toBeGreaterThan(0)
    let compared = 0
    for (const s of board.summaries) {
      if (s.meanScore === null) continue
      compared += 1
      expect(s.meanScoreAllTrials, `${s.modelId} ${s.scope}`).toBeLessThanOrEqual(s.meanScore + 1e-9)
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('the real board: meanScore is the plain mean of the completed cells (checked for every summary)', () => {
    const board = realBoard()
    for (const s of board.summaries) {
      const inScope = (suite: string) =>
        s.scope === 'earlier' ? true
          : s.scope === 'headline' ? suite !== 'smoke'
            : s.scope === 'horizon' ? suite === 'horizon'
              : suite === 'smoke'
      const done = board.cells.filter((c) => c.modelId === s.modelId && inScope(c.suite) && (c.succeeded ?? 0) > 0)
      const expected = done.length ? done.reduce((a, c) => a + c.score, 0) / done.length : null
      if (expected === null) expect(s.meanScore).toBeNull()
      else expect(s.meanScore!, `${s.modelId} ${s.scope}`).toBeCloseTo(expected, 9)
    }
  })

  it('a model with one completed cell at 100 and one at 0 completed: mean when run 100, all-trials 50', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      full('c1', 'm', 100),
      rec({ taskId: 'c2', modelId: 'm', score: 0, status: 'fail', iterationsSucceeded: 0 }),
    ], models, tasks))
    const s = board.summaries.find((x) => x.scope === 'headline')!
    expect(s.meanScore).toBe(100)
    expect(s.meanScoreAllTrials).toBe(50)
  })
})

describe('rule B4: findings for every scope and model group, with the coverage and sample rules', () => {
  it('the real board has a findings set for every scope and group key', () => {
    const board = realBoard()
    for (const scope of SCOPE_KEYS) {
      for (const group of GROUP_KEYS) {
        expect(board.insights[scope][group], `${scope}/${group}`).toBeDefined()
      }
    }
  })

  it('every real finding has an explicit figure and figure unit, and an anchor', () => {
    const board = realBoard()
    for (const scope of SCOPE_KEYS) for (const group of GROUP_KEYS) {
      for (const i of board.insights[scope][group]) {
        expect(i.figure.length, i.id).toBeGreaterThan(0)
        expect(i.figureUnit.length, i.id).toBeGreaterThan(0)
        expect(i.anchor.length, i.id).toBeGreaterThan(0)
      }
    }
  })

  it('a model covering one task of four is never named in a finding', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta'), model('thin', 'Thin')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = [
      ...['c1', 'c2', 'c3', 'c4'].flatMap((id) => [full(id, 'alpha', 70), full(id, 'beta', 60)]),
      full('c1', 'thin', 99),
    ]
    const board = buildBoard(world(results, models, tasks))
    const all = board.insights.headline.all
    for (const i of all) expect(`${i.body} ${i.title}`).not.toContain('Thin')
    expect(all.find((i) => i.id === 'top')!.body).toContain('Alpha leads at 70.0')
  })

  it('the sample clause counts the requested iterations behind an all-trials number, failed ones included', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = [
      ...['c1', 'c2', 'c3', 'c4'].map((id) => full(id, 'alpha', 80)),
      rec({ taskId: 'c1', modelId: 'beta', score: 0, status: 'fail', iterationsSucceeded: 0 }),
      ...['c2', 'c3', 'c4'].map((id) => full(id, 'beta', 60)),
    ]
    const board = buildBoard(world(results, models, tasks))
    const top = board.insights.headline.all.find((i) => i.id === 'top')!
    // 4 + 4 tasks of 5 iterations = 40 requested. Beta's c1 cell completed none, but its failed iterations
    // count as zero in the all-trials score, so they are part of the number and of the clause.
    expect(top.body).toContain('(2 configurations covering at least 80% of the headline tasks, 40 requested iterations)')
  })

  it('the speed clause counts completed iterations, because its medians are over completed iterations', () => {
    const models = [model('alpha', 'Alpha', { provider: 'OpenAI' })]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const timed = (id: string) => full(id, 'alpha', 80, {
      telemetry: { meanTtftMs: 300, meanTokensPerSec: 50, rateKind: 'decode', cacheHits: 0, retries: 0 },
    })
    const results = [...['c1', 'c2', 'c3'].map(timed), rec({ taskId: 'c4', modelId: 'alpha', score: 0, status: 'fail', iterationsSucceeded: 0, telemetry: { rateKind: 'decode', cacheHits: 0, retries: 0 } })]
    const speed = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'speed')!
    expect(speed.body).toContain('(1 configuration covering at least 80% of the headline tasks, 15 completed iterations)')
  })

  it('the figure is set from the data, not from the sentence: a finding has no regex-derived figure', () => {
    const models = [model('alpha', 'Alpha'), model('beta', 'Beta')]
    const tasks = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))
    const results = ['c1', 'c2', 'c3', 'c4'].flatMap((id) => [full(id, 'alpha', 80), full(id, 'beta', 60)])
    const top = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'top')!
    expect(top.figure).toBe('80.0')
    expect(top.figureUnit).toBe('pts')
    expect(top.body).toContain('Alpha leads at 80.0 all-trials score')
  })
})

describe('cost and tokens are per attempt, so iteration counts do not change the comparison', () => {
  /** Two models that differ only in how many iterations each ran on the same task. */
  function iterationWorld(over: { oneCost: number; fiveCost: number }) {
    const models = [model('one', 'One'), model('five', 'Five')]
    const tasks = [task('c1')]
    const results = [
      rec({
        taskId: 'c1', modelId: 'one', score: 80, iterations: 1, iterationScores: [80], iterationsSucceeded: 1,
        costUsd: over.oneCost, tokensOut: 100, tokensIn: 10,
        usage: { inputTokens: 10, outputTokens: 100, source: 'reported' },
      }),
      rec({
        taskId: 'c1', modelId: 'five', score: 80, iterations: 5, iterationScores: [80, 80, 80, 80, 80], iterationsSucceeded: 5,
        costUsd: over.fiveCost, tokensOut: 500, tokensIn: 50,
        usage: { inputTokens: 50, outputTokens: 500, source: 'reported' },
      }),
    ]
    return buildBoard(world(results, models, tasks))
  }

  it('models that differ only in iteration count have the same cost and output tokens per run', () => {
    const board = iterationWorld({ oneCost: 0.1, fiveCost: 0.5 })
    const all = (id: string) => board.summaries.find((s) => s.modelId === id && s.scope === 'headline')!
    expect(all('one').costPerAttempt).toBeCloseTo(0.1, 12)
    expect(all('five').costPerAttempt).toBeCloseTo(0.1, 12)
    expect(all('one').outputTokensPerTask).toBe(100)
    expect(all('five').outputTokensPerTask).toBe(100)
    // The totals are kept as totals, and are not used for the comparison.
    expect(all('five').totalCostUsd).toBeCloseTo(0.5, 12)
  })

  it('the frontier is drawn on cost per run: a model that is cheap per run stays on it', () => {
    // Totals say "five" costs 1.0 and is dominated by "one" (0.5, score 90). Per run, "five" costs 0.2.
    const models = [model('one', 'One'), model('five', 'Five')]
    const tasks = [task('c1')]
    const board = buildBoard(world([
      rec({ taskId: 'c1', modelId: 'one', score: 90, iterations: 1, iterationScores: [90], iterationsSucceeded: 1,
        costUsd: 0.5, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
      rec({ taskId: 'c1', modelId: 'five', score: 80, iterations: 5, iterationScores: [80, 80, 80, 80, 80], iterationsSucceeded: 5,
        costUsd: 1.0, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
    ], models, tasks))
    const five = board.summaries.find((s) => s.modelId === 'five' && s.scope === 'headline')!
    const one = board.summaries.find((s) => s.modelId === 'one' && s.scope === 'headline')!
    expect(five.costPerAttempt).toBeCloseTo(0.2, 12)
    expect(one.costPerAttempt).toBeCloseTo(0.5, 12)
    expect(five.onFrontier).toBe(true)
    expect(one.onFrontier).toBe(true)
  })

  it('a cell that ran no iteration keeps its billed cost per attempt, and its tokens are not counted', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1'), task('c2')]
    const board = buildBoard(world([
      full('c1', 'm', 80, { costUsd: 0.2, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
      rec({ taskId: 'c2', modelId: 'm', score: 0, iterations: 5, iterationScores: [], iterationsSucceeded: 0, status: 'fail',
        costUsd: 0.3, tokensOut: 999, usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } }),
    ], models, tasks))
    const s = board.summaries.find((x) => x.scope === 'headline')!
    // c1 is 0.2 over 5 iterations (0.04 per attempt). c2 is a failed cell: its iterations were still billed (0.3 over
    // 5, 0.06 per attempt), so it is in the mean: (0.04 + 0.06) / 2. Its tokens are not counted: none completed.
    expect(s.pricedCells).toBe(2)
    expect(s.costPerAttempt).toBeCloseTo((0.2 / 5 + 0.3 / 5) / 2, 12)
    expect(board.cells.find((c) => c.taskId === 'c2')!.tokensOut).toBeNull()
  })
})

describe('insight sentences name only the cells they are about, and use the scope word', () => {
  const six = (passed: boolean, name = 'k'): IterationCheckResult[][] =>
    Array.from({ length: 6 }, () => [{ name, passed, points: passed ? 10 : 0, maxPoints: 10 }])

  it('a check with fewer than six runs is never named as the lowest pass rate', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1')]
    const results = [
      rec({ taskId: 'c1', modelId: 'm', score: 0, iterations: 1, iterationScores: [0], iterationsSucceeded: 1,
        iterationCheckResults: [[{ name: 'k', passed: false, points: 0, maxPoints: 10 }]], costUsd: 0 }),
    ]
    const board = buildBoard(world(results, models, tasks))
    expect(board.insights.headline.all.find((i) => i.id === 'check')).toBeUndefined()
  })

  it('the check sample counts only the models and completed iterations that carry the check', () => {
    const models = [model('m', 'M'), model('n', 'N')]
    const tasks = [task('c1')]
    const results = [
      rec({ taskId: 'c1', modelId: 'm', score: 0, iterations: 6, iterationScores: [0, 0, 0, 0, 0, 0], iterationsSucceeded: 6,
        iterationCheckResults: six(false), costUsd: 0 }),
      rec({ taskId: 'c1', modelId: 'n', score: 80, iterations: 5, iterationScores: [80, 80, 80, 80, 80], iterationsSucceeded: 5,
        costUsd: 0 }),
    ]
    const check = buildBoard(world(results, models, tasks)).insights.headline.all.find((i) => i.id === 'check')!
    expect(check.body).toContain('passed in 0.0% of 6 runs. Named check rows')
    expect(check.body).toContain('(pooled over 1 configuration covering at least 80% of the headline tasks; 6 of 6 completed iterations in those cells recorded this check).')
    expect(check.figure).toBe('0.0')
  })

  it('the spread sentence uses the scope word: "No task", not "No headline task", in the earlier-runs scope', () => {
    const models = [model('m', 'M'), model('n', 'N')]
    const tasks = [task('c1')]
    const results = [
      full('c1', 'm', 100, { costUsd: 0, scorerVersion: 1 }),
      full('c1', 'n', 50, { costUsd: 0, scorerVersion: 1 }),
    ]
    const spread = buildBoard(world(results, models, tasks)).insights.earlier.all.find((i) => i.id === 'spread')!
    expect(spread.body).toMatch(/No task had every covered configuration that ran it at 95 or more \(2 configurations covering at least 80% of the 1 earlier task, \d+ requested iterations\)\.$/)
    expect(spread.body).not.toContain('headline task')
  })

  it('no value finding is written when only one model is covered: there is nothing to be cheaper than', () => {
    const models = [model('m', 'M')]
    const tasks = [task('c1')]
    const board = buildBoard(world([full('c1', 'm', 80, { costUsd: 0.1 })], models, tasks))
    expect(board.insights.headline.all.find((i) => i.id === 'value')).toBeUndefined()
    expect(board.insights.headline.all.find((i) => i.id === 'top')).toBeDefined()
  })

  it('the value sentence reads "with an all-trials score of", never "for a 8.6 all-trials score"', () => {
    const models = [model('a', 'A'), model('b', 'B')]
    const tasks = [task('c1')]
    const board = buildBoard(world([
      full('c1', 'a', 80, { costUsd: 0.5 }),
      full('c1', 'b', 78, { costUsd: 0.1 }),
    ], models, tasks))
    const value = board.insights.headline.all.find((i) => i.id === 'value')!
    expect(value.body).toContain('with an all-trials score of 78.0')
    expect(value.body).not.toMatch(/for a \d/)
  })
})
