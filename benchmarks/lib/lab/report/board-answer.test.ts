import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import {
  OUTPUT_CAP_TOKENS,
  buildBoard,
  effortName,
  truncatedIterationsOf,
  type Board,
  type BuildInput,
} from './board'

// Rules the page reads for its answer, its ceiling and truncation notes, its effort verdict and its held-back tasks.
// Each one is set against a small hand-built world, so the sentence and the number it states can be checked together.

const CLASSIC = 'community-tasks'
const NOW = '2026-11-10T12:00:00.000Z'
const CATEGORIES: BenchmarkCategory[] = [
  { slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' },
]

function task(id: string, over: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id, category: 'advanced-game-building', title: `Task ${id}`, blurb: '', prompt: '', runtimeHint: '',
    iterationsDefault: 3, methodNotes: '', demoComponentName: '', slug: id, scorer: 'behavioral', pluginId: CLASSIC, ...over,
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return {
    id, name, provider: 'Anthropic', costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002, contextWindow: 1000,
    capabilities: '', company: 'Anthropic', ...over,
  }
}

/** A record of `iterations` iterations on which every completed iteration scored `values` (one per iteration). */
function rec(over: Partial<BenchmarkResult> & { taskId: string; modelId: string; values: number[] }): BenchmarkResult {
  const { values, ...rest } = over
  const completed = values.length
  return {
    score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    runtimeMs: 1000,
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0,
    iterations: 3,
    iterationScores: values,
    iterationsSucceeded: completed,
    status: completed === 3 ? 'success' : 'partial',
    createdAt: '2026-11-11T00:00:00.000Z',
    source: 'live',
    scorerVersion: 2,
    ...rest,
  }
}

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

function find(board: Board, id: string, group: 'claude' | 'all' = 'all') {
  return board.insights.headline[group].find((i) => i.id === id)
}

describe('top: exact ties and wide intervals are not leaders', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [
    model('alpha', 'Alpha'),
    model('beta', 'Beta'),
    model('gamma', 'Gamma'),
    model('delta', 'Delta'),
  ]

  it('two configurations at 100 on every iteration tie, and neither is named the leader', () => {
    const results = tasks.flatMap((t) => [
      rec({ taskId: t.id, modelId: 'alpha', values: [100, 100, 100] }),
      rec({ taskId: t.id, modelId: 'beta', values: [100, 100, 100] }),
    ])
    const top = find(buildBoard(world(results, models, tasks)), 'top')!
    expect(top.body).toContain('Alpha and Beta both score 100.0 on every iteration, so the top cannot be ranked among them (2 configurations covering at least 80% of the headline tasks, 24 requested iterations).')
    expect(top.body).not.toContain('leads at')
  })

  it('a narrow interval whose upper bound reaches the top is not separable from it, and is named as such', () => {
    const results = [
      ...tasks.map((t) => rec({ taskId: t.id, modelId: 'alpha', values: [100, 100, 100] })),
      rec({ taskId: 't1', modelId: 'eps', values: [100, 100, 97] }),
      rec({ taskId: 't2', modelId: 'eps', values: [100, 100, 100] }),
      rec({ taskId: 't3', modelId: 'eps', values: [100, 100, 100] }),
      rec({ taskId: 't4', modelId: 'eps', values: [100, 100, 100] }),
    ]
    const eps = [...models, model('eps', 'Eps')]
    const top = find(buildBoard(world(results, eps, tasks)), 'top')!
    expect(top.body).toMatch(/Not separable from the top: its 95% interval reaches 100\.0, so the difference is not established: Eps \(99\.\d, interval \[\d+\.\d to 100\.0\]\) \(2 configurations covering at least 80% of the headline tasks, 24 requested iterations\)\.$/)
    expect(top.body).not.toContain('Too variable')
  })

  it('a wide interval reaching the top is too variable to rank, a narrow one below it is not listed, and the top leads', () => {
    const results = [
      ...tasks.map((t) => rec({ taskId: t.id, modelId: 'alpha', values: [100, 100, 100] })),
      // Two tasks at 100 and two at 0: the interval reaches 100 and runs down near 0.
      rec({ taskId: 't1', modelId: 'gamma', values: [100, 100, 100] }),
      rec({ taskId: 't2', modelId: 'gamma', values: [100, 100, 100] }),
      rec({ taskId: 't3', modelId: 'gamma', values: [0, 0, 0] }),
      rec({ taskId: 't4', modelId: 'gamma', values: [0, 0, 0] }),
      // Narrow and below the top: its interval stops short of 100.
      ...tasks.map((t) => rec({ taskId: t.id, modelId: 'delta', values: [90, 90, 90] })),
    ]
    const top = find(buildBoard(world(results, models, tasks)), 'top')!
    expect(top.body.startsWith('Alpha leads at 100.0 all-trials score.')).toBe(true)
    expect(top.body).toMatch(/Too variable to rank: Gamma \(50\.0, interval \[\d+\.\d to 100\.0\] wider than 40 points\) \(3 configurations covering at least 80% of the headline tasks, 36 requested iterations\)\.$/)
    expect(top.body).not.toContain('Delta')
    expect(top.body).not.toContain('Not separable')
  })
})

describe('truncation: a failed iteration that hit the output cap is named as one', () => {
  it('counts the failed iterations of a recorded truncated cell', () => {
    expect(truncatedIterationsOf({ iterations: 3, failureReason: 'truncated', tokensOut: 352061 }, 2)).toBe(1)
  })

  it('counts an all-failed cell with no recorded reason when its output is exactly the cap on every iteration', () => {
    expect(truncatedIterationsOf({ iterations: 3, failureReason: undefined, tokensOut: 3 * OUTPUT_CAP_TOKENS }, 0)).toBe(3)
    expect(truncatedIterationsOf({ iterations: 3, tokensOut: 3 * OUTPUT_CAP_TOKENS }, 0)).toBe(3)
  })

  it('does not count a failure with another reason, output below the cap, or a completed cell', () => {
    expect(truncatedIterationsOf({ iterations: 3, failureReason: 'model_error', tokensOut: 3 * OUTPUT_CAP_TOKENS }, 0)).toBe(0)
    expect(truncatedIterationsOf({ iterations: 3, failureReason: undefined, tokensOut: 100 }, 0)).toBe(0)
    expect(truncatedIterationsOf({ iterations: 3, failureReason: 'truncated', tokensOut: 1 }, 3)).toBe(0)
  })
})

describe('effort: every level is named with its interval, and truncations are named where they happened', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [
    model('base', 'Base', { reasoningEffort: 'medium' }),
    model('base-low', 'Base (low effort)', { baseModelId: 'base', reasoningEffort: 'low' }),
    model('base-xhigh', 'Base', { baseModelId: 'base', reasoningEffort: 'xhigh' }),
  ]
  const results = [
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'base-low', values: [100, 100, 100] })),
    // Three tasks complete at 100; the fourth hit the cap on all three iterations and has no reason recorded.
    ...tasks.slice(0, 3).map((t) => rec({ taskId: t.id, modelId: 'base-xhigh', values: [100, 100, 100] })),
    rec({ taskId: 't4', modelId: 'base-xhigh', values: [], iterationsSucceeded: 0, status: 'fail', score: 0, tokensOut: 3 * OUTPUT_CAP_TOKENS, failureReason: undefined }),
  ]
  const board = buildBoard(world(results, models, tasks))

  it('names each level with its score and interval, and says the change is not established when the intervals overlap', () => {
    const effort = find(board, 'effort-base')!
    expect(effort.body).toContain('Base all-trials scores by effort, with 95% intervals: low 100.0 [100.0 to 100.0] and extra high ')
    expect(effort.body).toMatch(/extra high 75\.0 \[\d+\.\d to 100\.0\]/)
    expect(effort.body).toContain('The change from low to extra high effort, -25.0 points, is not established: the 95% intervals overlap, so differences are not established with 3 iterations per task.')
  })

  it('says how many iterations hit the output cap at that level, and what its completed iterations average', () => {
    const effort = find(board, 'effort-base')!
    expect(effort.body).toContain('Extra high effort: 3 of 12 requested iterations hit the 128,000-token output cap and count as zero; its completed iterations averaged 100.0 per task, over the 3 tasks with a completed iteration, so the truncated iterations account for the whole gap between its score and that average.')
    expect(effort.body).not.toContain('Low effort: ')
  })
})

describe('guide: the answer names the top, the cheapest and where it trails, and the caveats give the ceiling and truncations', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [
    model('top-m', 'Top M', { costPer1kInputUsd: 0.01, costPer1kOutputUsd: 0.02 }),
    model('cheap', 'Cheap', { costPer1kInputUsd: 0.0001, costPer1kOutputUsd: 0.0002 }),
    model('xh', 'Hi Xhigh', { reasoningEffort: 'xhigh', costPer1kInputUsd: 0.0001, costPer1kOutputUsd: 0.0002 }),
  ]
  // top-m at 100 on every task. cheap scores 100 on t1 and t2, 60 on t3 and t4 (a trail of 40). xh hit the cap on t4.
  const results = [
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'top-m', values: [100, 100, 100], costUsd: 1.0 })),
    rec({ taskId: 't1', modelId: 'cheap', values: [100, 100, 100], costUsd: 0.09 }),
    rec({ taskId: 't2', modelId: 'cheap', values: [100, 100, 100], costUsd: 0.09 }),
    rec({ taskId: 't3', modelId: 'cheap', values: [60, 60, 60], costUsd: 0.09 }),
    rec({ taskId: 't4', modelId: 'cheap', values: [60, 60, 60], costUsd: 0.09 }),
    rec({ taskId: 't1', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't2', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't3', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't4', modelId: 'xh', values: [], iterationsSucceeded: 0, status: 'fail', score: 0, tokensOut: 3 * OUTPUT_CAP_TOKENS, costUsd: 0.3 }),
  ]
  const board = buildBoard(world(results, models, tasks))
  const guide = board.guides.headline.all

  it('answers with the top, the value pick, and the cheapest configuration with the tasks it trails on', () => {
    expect(guide.answer[0]).toContain('Top M leads at 100.0. The Top score finding below gives the full statement.')
    expect(guide.answer.some((s) => s.startsWith('Cheapest within 5 points of the top: '))).toBe(true)
    const cheapest = guide.answer.find((s) => s.startsWith('Cheapest covered configuration: '))!
    expect(cheapest).toContain('Cheap at $0.0300 per attempt, scoring 80.0')
    expect(cheapest).toContain('it trails the top by 10 points or more on Task t3 (60.0 against 100.0) and Task t4 (60.0 against 100.0)')
  })

  it('states the sample and the interval width, so a difference is read against them', () => {
    expect(guide.caveats[0]).toMatch(/^Each cell ran 3 iterations\. A difference smaller than the intervals is not established\./)
  })

  it('the callout gives the cell size, the tasks at the ceiling, and the configurations at 100 on every iteration', () => {
    // t1 and t2 are 100 for all three configurations; t3 and t4 are not (cheap trails, xh was truncated on t4).
    expect(guide.callout).toEqual([
      'Each cell is 3 iterations. Differences inside the 95% intervals are not established.',
      'These tasks do not separate the configurations: Task t1 and Task t2, where every configuration in view scored 100.0.',
      'At 100.0 on every iteration: Top M.',
    ])
  })

  it('names the configuration that hit the output cap, with its count, its requested iterations and the tasks', () => {
    expect(guide.caveats.join(' ')).toContain(
      'Output-cap truncations, counted as zero and billed: Hi Xhigh (extra high effort) on 3 of 12 requested iterations (Task t4 3 of 3).'
    )
  })
})

describe('held back: a registered task with no runs is named, and its absence is explained', () => {
  it('lists the task as held back and says so in its suite note', () => {
    const tasks = [task('t1'), task('ghost', { pluginId: 'horizon-seat-pricing', title: 'Seat Pricing Calculator' })]
    const results = [rec({ taskId: 't1', modelId: 'm', values: [100, 100, 100] })]
    const board = buildBoard(world(results, [model('m', 'M')], tasks))
    expect(board.heldBackTasks).toEqual(['Seat Pricing Calculator'])
    const horizon = board.suites.find((s) => s.id === 'horizon')!
    expect(horizon.note).toContain('ghost is registered but held back: it has no runs.')
    expect(board.heldBack).toEqual([{ id: 'ghost', title: 'Seat Pricing Calculator', sentence: 'ghost is registered but held back: it has no runs.' }])
  })
})

describe('names: the effort is in the name, in words', () => {
  it('adds the effort in words when the registry name does not say it', () => {
    expect(effortName({ name: 'Claude Opus 5.5', effort: 'medium' })).toBe('Claude Opus 5.5 (medium effort)')
    expect(effortName({ name: 'Claude Sonnet 5.5', effort: 'xhigh' })).toBe('Claude Sonnet 5.5 (extra high effort)')
  })

  it('keeps a registry name that already says its effort', () => {
    expect(effortName({ name: 'Claude Haiku 5.5 (extra high effort)', effort: 'xhigh' })).toBe('Claude Haiku 5.5 (extra high effort)')
    expect(effortName({ name: 'Claude Fable 5.2 (low effort)', effort: 'low' })).toBe('Claude Fable 5.2 (low effort)')
  })

  it('leaves a name with no effort unchanged', () => {
    expect(effortName({ name: 'Claude Opus 4.8', effort: null })).toBe('Claude Opus 4.8')
  })
})

describe('guide has no answer and no caveats without a focus model', () => {
  it('an empty scope gives an empty guide', () => {
    const board = buildBoard(world([], [model('m', 'M')], [task('t1')]))
    expect(board.guides.headline.all).toEqual({ answer: [], caveats: [], callout: [] })
  })
})

describe('cost per attempt includes every iteration billed, including cells in which every iteration failed', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [model('m', 'M'), model('xh', 'Hi Xhigh', { reasoningEffort: 'xhigh' })]
  const results = [
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'm', values: [100, 100, 100], costUsd: 0.3 })),
    rec({ taskId: 't1', modelId: 'xh', values: [100, 100, 100], costUsd: 0.3 }),
    rec({ taskId: 't2', modelId: 'xh', values: [100, 100, 100], costUsd: 0.3 }),
    rec({ taskId: 't3', modelId: 'xh', values: [100, 100, 100], costUsd: 0.3 }),
    // Every iteration hit the output cap: no completed iteration, but the three attempts were billed.
    rec({ taskId: 't4', modelId: 'xh', values: [], iterationsSucceeded: 0, status: 'fail', score: 0, tokensOut: 3 * OUTPUT_CAP_TOKENS, costUsd: 0.6 }),
  ]
  const board = buildBoard(world(results, models, tasks))

  it('the failed cell keeps its billed cost, so the model covers all four tasks in its cost per attempt', () => {
    const xh = board.summaries.find((s) => s.scope === 'headline' && s.modelId === 'xh')!
    expect(board.cells.find((c) => c.modelId === 'xh' && c.taskId === 't4')!.costUsd).toBe(0.6)
    // Cells: 0.1, 0.1, 0.1 and 0.2 per attempt; their mean is 0.125.
    expect(xh.costPerAttempt).toBeCloseTo(0.125, 12)
    expect(xh.pricedCells).toBe(4)
  })

  it('the definition says failed and truncated iterations are billed and counted', () => {
    expect(board.definitions.costPerAttempt).toContain('failed and truncated iterations counted in the division')
    expect(board.definitions.costPerAttempt).toContain('A cell in which every iteration failed still has a cost per attempt')
  })

  it('the reliability finding names a truncation in a configuration whatever its coverage', () => {
    expect(find(board, 'reliability', 'all')!.body).toContain('Hi Xhigh (extra high effort) (75.0% completed; recorded reason truncated at the output cap)')
  })
})

describe('glance: one row per configuration, and at most three computed sentences that state their sample', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [
    model('top-m', 'Top M', { costPer1kInputUsd: 0.01, costPer1kOutputUsd: 0.02 }),
    model('cheap', 'Cheap', { costPer1kInputUsd: 0.0001, costPer1kOutputUsd: 0.0002 }),
    model('xh', 'Hi Xhigh', { reasoningEffort: 'xhigh', costPer1kInputUsd: 0.0001, costPer1kOutputUsd: 0.0002 }),
  ]
  const results = [
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'top-m', values: [100, 100, 100], costUsd: 1.0 })),
    rec({ taskId: 't1', modelId: 'cheap', values: [100, 100, 100], costUsd: 0.09 }),
    rec({ taskId: 't2', modelId: 'cheap', values: [100, 100, 100], costUsd: 0.09 }),
    rec({ taskId: 't3', modelId: 'cheap', values: [60, 60, 60], costUsd: 0.09 }),
    rec({ taskId: 't4', modelId: 'cheap', values: [60, 60, 60], costUsd: 0.09 }),
    rec({ taskId: 't1', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't2', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't3', modelId: 'xh', values: [100, 100, 100], costUsd: 0.15 }),
    rec({ taskId: 't4', modelId: 'xh', values: [], iterationsSucceeded: 0, status: 'fail', score: 0, tokensOut: 3 * OUTPUT_CAP_TOKENS, costUsd: 0.3 }),
  ]
  const glance = buildBoard(world(results, models, tasks)).glance.headline.all

  it('has one row per configuration, sorted by all-trials score, with the failed iterations and their reason', () => {
    expect(glance.rows.map((r) => r.name)).toEqual(['Top M', 'Cheap', 'Hi Xhigh (extra high effort)'])
    const xh = glance.rows[2]
    expect(xh).toMatchObject({ score: 75, requested: 12, completed: 9, failed: 3, truncated: 3, failureReason: null })
    expect(glance.rows[0].costPerAttempt).toBeCloseTo(1 / 3, 12)
  })

  it('states at most three sentences: the configurations not separable from the top, the cheapest of them against the most expensive, and the fastest', () => {
    expect(glance.sentences.length).toBeLessThanOrEqual(3)
    expect(glance.sentences[0]).toBe('Not separable from the top, 100.0 (each 95% interval reaches 100.0, or the configuration scores it): Top M (100.0) and Cheap (80.0) (of 3 configurations covering at least 80% of the headline tasks, 36 requested iterations). Too variable to rank: Hi Xhigh (extra high effort), 75.0, interval 25.0 to 100.0.')
    expect(glance.sentences[1]).toMatch(/^Cheapest configuration not separable from the top: Cheap, \$0\.0300 per attempt, 0\.090 times the cost of Top M at \$0\.333, the most expensive configuration at the top value \(of 3 configurations covering at least 80% of the headline tasks, 36 requested iterations\)\.$/)
    expect(glance.sentences[2]).toBe('Fastest configuration not separable from the top: Cheap at 1.0 seconds median per completed iteration, among the 2 configurations not separable from the top (24 requested iterations).')
  })

  it('names the too-variable configurations in sentence 1, and only there', () => {
    expect(glance.sentences[0]).toContain('Too variable to rank: Hi Xhigh (extra high effort), 75.0, interval 25.0 to 100.0.')
    for (const s of glance.sentences.slice(1)) expect(s).not.toContain('Too variable')
  })

  it('every sentence states the covering sample it compared, and its count equals the covering rows of the table', () => {
    const covering = glance.rows.filter((r) => r.covering).length
    expect(covering).toBe(3)
    expect(glance.sentences[0]).toContain(`(of ${covering} configurations covering at least 80% of the headline tasks, `)
    expect(glance.sentences[1]).toContain(`(of ${covering} configurations covering at least 80% of the headline tasks, `)
    expect(glance.sentences[2]).toMatch(/among the 2 configurations not separable from the top \(24 requested iterations\)\.$/)
  })
})

describe('glance value pick: the cheapest configuration not separable from the top, never a too-variable one', () => {
  const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id))
  const models = [
    model('top-m', 'Top M', { costPer1kInputUsd: 0.01, costPer1kOutputUsd: 0.02 }),
    model('mid', 'Mid', { costPer1kInputUsd: 0.01, costPer1kOutputUsd: 0.02 }),
    model('wide', 'Wide Cheap', { costPer1kInputUsd: 0.0001, costPer1kOutputUsd: 0.0002 }),
  ]
  const results = [
    // The top: 100 on every task, at $1.00 a cell.
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'top-m', values: [100, 100, 100], costUsd: 1.0 })),
    // Not separable: 100 on three tasks and 90 on one, so its interval reaches the top and is narrow.
    rec({ taskId: 't1', modelId: 'mid', values: [100, 100, 100], costUsd: 0.3 }),
    rec({ taskId: 't2', modelId: 'mid', values: [100, 100, 100], costUsd: 0.3 }),
    rec({ taskId: 't3', modelId: 'mid', values: [100, 100, 100], costUsd: 0.3 }),
    rec({ taskId: 't4', modelId: 'mid', values: [90, 90, 90], costUsd: 0.3 }),
    // Too variable: 100 on two tasks and 0 on two, so its interval reaches the top and is wider than 40 points. It is the cheapest.
    rec({ taskId: 't1', modelId: 'wide', values: [100, 100, 100], costUsd: 0.003 }),
    rec({ taskId: 't2', modelId: 'wide', values: [100, 100, 100], costUsd: 0.003 }),
    rec({ taskId: 't3', modelId: 'wide', values: [0, 0, 0], costUsd: 0.003 }),
    rec({ taskId: 't4', modelId: 'wide', values: [0, 0, 0], costUsd: 0.003 }),
  ]
  const glance = buildBoard(world(results, models, tasks)).glance.headline.all

  it('names the not-separable configuration, not the cheaper too-variable one, and says what the pick is compared with', () => {
    expect(glance.rows.find((r) => r.name === 'Wide Cheap')!.interval![1]).toBeCloseTo(100, 6)
    expect(glance.sentences[0]).toContain('Too variable to rank: Wide Cheap, 50.0, interval ')
    expect(glance.sentences[1]).toMatch(/^Cheapest configuration not separable from the top: Mid, \$0\.100 per attempt, 0\.30 times the cost of Top M at \$0\.333, the most expensive configuration at the top value \(of 3 configurations covering/)
  })

  it('no configuration cheaper than the named pick is in the not-separable set', () => {
    const picked = glance.sentences[1].match(/not separable from the top: ([^,]+), /)![1]
    const pick = glance.rows.find((r) => r.name === picked)!
    const top = Math.max(...glance.rows.filter((r) => r.covering).map((r) => r.score))
    const separable = glance.rows.filter((r) => r.covering && (
      Math.abs(r.score - top) < 1e-6 || (r.interval !== null && r.interval[1] >= top - 1e-6 && r.interval[1] - r.interval[0] <= 40)
    ))
    expect(separable.map((r) => r.name).sort()).toEqual(['Mid', 'Top M'])
    for (const r of separable) expect(r.costPerAttempt!).toBeGreaterThanOrEqual(pick.costPerAttempt! - 1e-12)
  })
})
