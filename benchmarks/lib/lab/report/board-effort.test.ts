import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import { buildBoard, stripEffortSuffix, type BoardCell, type BuildInput } from './board'

/**
 * Reasoning effort is compared only over the tasks every effort level of a base model ran in the scope, and the
 * Horizon scope is the horizon suite on its own. Small hand-built worlds, so each number can be checked by hand.
 */

const NOW = '2026-11-10T12:00:00.000Z'
const CATEGORIES: BenchmarkCategory[] = [
  { slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' },
]

function task(id: string, over: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id, category: 'advanced-game-building', title: `Task ${id}`, blurb: '', prompt: '', runtimeHint: '',
    iterationsDefault: 5, methodNotes: '', demoComponentName: '', slug: id, scorer: 'behavioral',
    pluginId: 'community-tasks', ...over,
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return { id, name, provider: 'Anthropic', costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002, contextWindow: 1000, capabilities: '', company: 'Anthropic', ...over }
}

/** A complete five-iteration record with one per-iteration score, at the given score and cost. */
function full(taskId: string, modelId: string, score: number, over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    taskId, modelId, score, runtimeMs: 2000, tokensIn: 100, tokensOut: 200, costUsd: 0, iterations: 5,
    status: 'success', createdAt: '2026-11-01T00:00:00.000Z', source: 'live', scorerVersion: 2,
    iterationScores: [score, score, score, score, score], iterationsSucceeded: 5, ...over,
  }
}

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

const DELTA_MODELS = [
  model('delta-base', 'Delta Base', { company: 'Anthropic' }),
  model('delta-low', 'Delta Low (low effort)', { baseModelId: 'delta-base', reasoningEffort: 'low' }),
  model('delta-high', 'Delta High (high effort)', { baseModelId: 'delta-base', reasoningEffort: 'high' }),
]
const FOUR = ['c1', 'c2', 'c3', 'c4'].map((id) => task(id))

describe('effort comparison: each base is compared over the tasks every level ran', () => {
  it('uses only the shared tasks, so a task only one level ran does not move either mean', () => {
    const results = [
      // low ran all four tasks; c4 is low-only and scores 0, which would pull its mean down if it counted.
      full('c1', 'delta-low', 50, { costUsd: 0.2 }),
      full('c2', 'delta-low', 50, { costUsd: 0.2 }),
      full('c3', 'delta-low', 50, { costUsd: 0.2 }),
      full('c4', 'delta-low', 0, { costUsd: 100 }),
      // high ran c1 to c3 only.
      full('c1', 'delta-high', 70, { costUsd: 0.6 }),
      full('c2', 'delta-high', 70, { costUsd: 0.6 }),
      full('c3', 'delta-high', 70, { costUsd: 0.6 }),
    ]
    const board = buildBoard(world(results, DELTA_MODELS, FOUR))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'delta-base')!
    expect(comp.name).toBe('Delta Base')
    expect(comp.tasks).toEqual(['c1', 'c2', 'c3'])
    const [low, high] = comp.levels
    expect(low).toMatchObject({ modelId: 'delta-low', effort: 'low', score: 50, timedTasks: 3 })
    expect(high).toMatchObject({ modelId: 'delta-high', effort: 'high', score: 70, timedTasks: 3 })
    // Cost per attempt over the shared tasks: 0.2 / 5 and 0.6 / 5. The 100 USD on c4 is not in it.
    expect(low.costPerAttempt).toBeCloseTo(0.04, 12)
    expect(high.costPerAttempt).toBeCloseTo(0.12, 12)
    expect(low.pricedTasks).toBe(3)
    // Runtime is 2000 ms per cell: a median of 2 seconds.
    expect(low.medianSeconds).toBe(2)
  })

  it('the finding names the number of tasks compared, and its figures are the shared-task means', () => {
    // Five tasks in scope. Low ran all five, high ran four of them (80%, so both levels are eligible for a finding).
    const five = [...FOUR, task('c5')]
    const results = [
      full('c1', 'delta-low', 50, { costUsd: 0.2 }), full('c2', 'delta-low', 50, { costUsd: 0.2 }),
      full('c3', 'delta-low', 50, { costUsd: 0.2 }), full('c4', 'delta-low', 0, { costUsd: 0.2 }),
      full('c5', 'delta-low', 0, { costUsd: 100 }),
      full('c1', 'delta-high', 70, { costUsd: 0.6 }), full('c2', 'delta-high', 70, { costUsd: 0.6 }),
      full('c3', 'delta-high', 70, { costUsd: 0.6 }), full('c4', 'delta-high', 70, { costUsd: 0.6 }),
    ]
    const board = buildBoard(world(results, DELTA_MODELS, five))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'delta-base')!
    expect(comp.tasks).toEqual(['c1', 'c2', 'c3', 'c4'])
    const finding = board.insights.headline.all.find((i) => i.id === 'effort-delta-base')!
    // Over c1 to c4 only: low (50, 50, 50, 0) averages 37.5, high averages 70 and the score change is +32.5.
    expect(finding.body).toContain('Delta Base all-trials scores by effort, with 95% intervals: low 37.5 [12.5 to 50.0] and high 70.0 [70.0 to 70.0].')
    expect(finding.body).toContain('The change from low to high effort, +32.5 points, is established: the two 95% intervals do not overlap.')
    // The sample clause is on the last sentence, not mid-body.
    expect(finding.body).toContain('Cost per attempt changes by +$0.0800 ($0.0400 to $0.120) (compared on 4 tasks every effort level ran; 2 configurations covering at least 80% of the headline tasks, 40 requested iterations).')
  })

  it('a base whose levels share no task has no tasks, no finding, and empty stats for the section to say so', () => {
    const results = [full('c1', 'delta-low', 50), full('c2', 'delta-high', 70)]
    const board = buildBoard(world(results, DELTA_MODELS, FOUR))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'delta-base')!
    expect(comp.tasks).toEqual([])
    expect(comp.levels.map((l) => l.score)).toEqual([null, null])
    expect(board.insights.headline.all.some((i) => i.id === 'effort-delta-base')).toBe(false)
  })

  it('a base with one effort level in view is not compared', () => {
    const results = [full('c1', 'delta-low', 50), full('c2', 'delta-low', 50)]
    const board = buildBoard(world(results, DELTA_MODELS, FOUR))
    expect(board.effort.headline.all.some((c) => c.baseModelId === 'delta-base')).toBe(false)
  })

  it('a second model at an effort already present is not a further level', () => {
    const models = [...DELTA_MODELS, model('delta-low-2', 'Delta Low Copy', { baseModelId: 'delta-base', reasoningEffort: 'low' })]
    const results = [full('c1', 'delta-low', 50), full('c1', 'delta-high', 70), full('c1', 'delta-low-2', 10)]
    const board = buildBoard(world(results, models, [task('c1')]))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'delta-base')!
    expect(comp.levels.map((l) => l.modelId)).toEqual(['delta-low', 'delta-high'])
  })

  it('the effort levels are ordered from least to most effort, whatever the registry order', () => {
    const results = FOUR.flatMap((t) => [full(t.id, 'delta-high', 70), full(t.id, 'delta-low', 50)])
    const board = buildBoard(world(results, [...DELTA_MODELS].reverse(), FOUR))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'delta-base')!
    expect(comp.levels.map((l) => l.effort)).toEqual(['low', 'high'])
  })

  it('strips an effort suffix from a display name', () => {
    expect(stripEffortSuffix('Claude Opus 5.5 (high effort)')).toBe('Claude Opus 5.5')
    expect(stripEffortSuffix('Claude Opus 5.5 (extra high effort)')).toBe('Claude Opus 5.5')
    expect(stripEffortSuffix('Claude Fable 5.2 (low effort)')).toBe('Claude Fable 5.2')
    expect(stripEffortSuffix('Claude Opus 5.5')).toBe('Claude Opus 5.5')
  })
})

describe('the Horizon scope is the horizon suite, scorer version 2 only', () => {
  const HORIZON = [task('h1', { pluginId: 'horizon-suite' }), task('h2', { pluginId: 'horizon-suite' })]
  const CLASSIC_TASK = task('k1')
  const models = [
    model('alpha', 'Alpha'),
    model('beta-low', 'Beta (low effort)', { baseModelId: 'beta', reasoningEffort: 'low' }),
    model('beta', 'Beta', { reasoningEffort: 'high' }),
  ]

  it('holds the horizon tasks only, and the effort variants cover every horizon task they ran, so they can be on the frontier', () => {
    const results = [
      full('h1', 'alpha', 60, { costUsd: 0.1 }), full('h2', 'alpha', 60, { costUsd: 0.1 }),
      full('h1', 'beta-low', 70, { costUsd: 0.2 }), full('h2', 'beta-low', 70, { costUsd: 0.2 }),
      full('h1', 'beta', 80, { costUsd: 0.5 }), full('h2', 'beta', 80, { costUsd: 0.5 }),
      full('k1', 'alpha', 90, { costUsd: 0.1 }),
      full('h1', 'legacy', 10, { scorerVersion: 1, costUsd: 0.1 }),
    ]
    const board = buildBoard(world(results, [...models, model('legacy', 'Legacy')], [...HORIZON, CLASSIC_TASK]))
    expect(board.scopeTasks.horizon).toEqual(['h1', 'h2'])
    const horizonRows = board.summaries.filter((s) => s.scope === 'horizon')
    expect(horizonRows.map((s) => s.modelId).sort()).toEqual(['alpha', 'beta', 'beta-low'])
    for (const s of horizonRows) expect(s).toMatchObject({ tasksTotal: 2, tasksCovered: 2 })
    // The classic task and the version 1 record are outside the horizon scope.
    expect(horizonRows.find((s) => s.modelId === 'alpha')!.meanScoreAllTrials).toBe(60)
    expect(board.cells.filter((c) => inHorizon(c)).length).toBe(6)
    // Every model in the horizon scope has a measured cost and covers both horizon tasks, so each is eligible for the frontier.
    expect(horizonRows.filter((s) => s.costPerAttempt !== null).length).toBe(3)
  })

  it('a horizon-scope finding is labelled with the horizon scope', () => {
    const results = [full('h1', 'alpha', 60, { costUsd: 0.1 }), full('h2', 'alpha', 62, { costUsd: 0.1 })]
    const board = buildBoard(world(results, models, HORIZON))
    const top = board.insights.horizon.all.find((i) => i.id === 'top')!
    expect(top.title).toBe('Top score, horizon tasks')
    expect(top.body).toContain('(1 configuration covering at least 80% of the horizon tasks, 10 requested iterations)')
  })
})

function inHorizon(c: BoardCell): boolean {
  return c.suite === 'horizon' && c.scorerVersion >= 2
}
