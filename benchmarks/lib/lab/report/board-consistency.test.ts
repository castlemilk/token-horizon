import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import { buildBoard, type BuildInput } from './board'

/**
 * Consistency rules the page relies on: one interval per model and task set wherever it is shown, the at-a-glance table
 * ranks covering configurations first, and a level's completed mean is a mean over tasks. Small hand-built worlds.
 */

const NOW = '2026-11-10T12:00:00.000Z'
const CATEGORIES: BenchmarkCategory[] = [
  { slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' },
]

function task(id: string, over: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id, category: 'advanced-game-building', title: `Task ${id}`, blurb: '', prompt: '', runtimeHint: '',
    iterationsDefault: 3, methodNotes: '', demoComponentName: '', slug: id, scorer: 'behavioral',
    pluginId: 'community-tasks', ...over,
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return { id, name, provider: 'Anthropic', costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002, contextWindow: 1000, capabilities: '', company: 'Anthropic', ...over } as BenchmarkModel
}

function rec(over: Partial<BenchmarkResult> & { taskId: string; modelId: string; values: number[] }): BenchmarkResult {
  const { values, ...rest } = over
  const completed = values.length
  return {
    score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    runtimeMs: 1000, tokensIn: 100, tokensOut: 200, costUsd: 0.01, iterations: 3,
    iterationScores: values, iterationsSucceeded: completed,
    status: completed === 3 ? 'success' : 'partial',
    createdAt: '2026-11-11T00:00:00.000Z', source: 'live', scorerVersion: 2,
    ...rest,
  } as BenchmarkResult
}

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

const HORIZON = { pluginId: 'horizon-a' }

describe('one interval per model and task set, wherever it is shown', () => {
  // The variant ran only the two horizon tasks, so its headline cells are its horizon cells.
  const tasks = [task('h1', HORIZON), task('h2', HORIZON)]
  const models = [
    model('b', 'Base', { reasoningEffort: 'medium', baseModelId: 'b' }),
    model('v', 'Variant', { reasoningEffort: 'low', baseModelId: 'b' }),
  ]
  const results = [
    rec({ taskId: 'h1', modelId: 'b', values: [60, 80, 100] }),
    rec({ taskId: 'h2', modelId: 'b', values: [40, 90, 100] }),
    rec({ taskId: 'h1', modelId: 'v', values: [70, 85, 95] }),
    rec({ taskId: 'h2', modelId: 'v', values: [50, 75, 100] }),
  ]
  const board = buildBoard(world(results, models, tasks))

  it("a variant's interval is the same in the headline and horizon scopes when it ran the same cells", () => {
    const head = board.summaries.find((s) => s.modelId === 'v' && s.scope === 'headline')!
    const horizon = board.summaries.find((s) => s.modelId === 'v' && s.scope === 'horizon')!
    expect(head.interval).not.toBeNull()
    expect(head.interval).toEqual(horizon.interval)
  })

  it("an effort level's interval is the same as its summary interval over the same cells", () => {
    const comp = board.effort.horizon.all.find((c) => c.baseModelId === 'b')!
    const level = comp.levels.find((l) => l.modelId === 'v')!
    const summary = board.summaries.find((s) => s.modelId === 'v' && s.scope === 'horizon')!
    expect(level.interval).not.toBeNull()
    expect(level.interval).toEqual(summary.interval)
  })
})

describe('the at-a-glance table: covering configurations first, and only they are compared in its sentences', () => {
  const tasks = [1, 2, 3, 4, 5].map((i) => task(`t${i}`, HORIZON))
  const models = [model('full', 'Full'), model('partial', 'Partial')]
  const results = [
    ...tasks.map((t) => rec({ taskId: t.id, modelId: 'full', values: [90, 95, 100] })),
    rec({ taskId: 't1', modelId: 'partial', values: [100, 100, 100], costUsd: 0.001 }),
    rec({ taskId: 't2', modelId: 'partial', values: [100, 100, 100], costUsd: 0.001 }),
  ]
  const board = buildBoard(world(results, models, tasks))
  const glance = board.glance.headline.all

  it('lists the configuration that covers the tasks above the one that ran two, whatever its score', () => {
    expect(glance.rows.map((r) => r.modelId)).toEqual(['full', 'partial'])
    expect(glance.rows.map((r) => r.covering)).toEqual([true, false])
  })

  it('sub-heads the rows that do not cover 80% of the tasks, with the most tasks any of them ran', () => {
    expect(glance.notCovering).toBe('Ran fewer than 80% of the 5 headline tasks: 1 configuration ran at most 2 of 5 tasks. Not compared with the rows above.')
  })

  it('compares only covering configurations in its sentences', () => {
    expect(glance.sentences.length).toBeGreaterThan(0)
    for (const s of glance.sentences) expect(s).not.toContain('Partial')
  })
})

describe('an effort level: the completed mean is a mean over tasks, and its truncations are noted', () => {
  // Task t1: three completed iterations at 100. Task t2: two completed at 60 and 80, one truncated. The completed mean over
  // tasks is (100 + 70) / 2 = 85; over completed iterations it would be 88.
  const tasks = [task('t1'), task('t2')]
  const models = [
    model('b', 'Base', { reasoningEffort: 'medium', baseModelId: 'b' }),
    model('x', 'Base xhigh', { reasoningEffort: 'xhigh', baseModelId: 'b' }),
  ]
  const results = [
    rec({ taskId: 't1', modelId: 'b', values: [100, 100, 100] }),
    rec({ taskId: 't2', modelId: 'b', values: [100, 100, 100] }),
    rec({ taskId: 't1', modelId: 'x', values: [100, 100, 100] }),
    rec({ taskId: 't2', modelId: 'x', values: [60, 80], failureReason: 'truncated', costUsd: 0.02 }),
  ]
  const board = buildBoard(world(results, models, tasks))
  const comp = board.effort.headline.all.find((c) => c.baseModelId === 'b')!
  const xhigh = comp.levels.find((l) => l.modelId === 'x')!

  it('takes the completed mean over tasks, not over iterations', () => {
    expect(xhigh.completedMean).toBeCloseTo(85, 6)
    expect(xhigh.completed).toBe(5)
  })

  it('names the truncations in one sentence, with the count, the cap and the completed mean', () => {
    expect(xhigh.truncated).toBe(1)
    expect(comp.truncationNotes).toEqual([
      'Extra high effort: 1 of 6 requested iterations truncated at the 128,000-token output cap, counted as zero; its completed iterations averaged 85.0 per task, over the 2 tasks with a completed iteration.',
    ])
  })
})
