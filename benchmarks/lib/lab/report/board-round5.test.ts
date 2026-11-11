import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import * as registry from '../llm-benchmark/registry'
import {
  SEAT_PRICING_STATE,
  buildBoard,
  heldBackSentenceIn,
  type Board,
  type BuildInput,
} from './board'

/**
 * Real-data tests. Every expectation about the live results is computed here from the raw records in results.json, by
 * formulas written out in this file, never copied from the board's output. The synthetic worlds pin the wording and the
 * held-back states. Round 7: no record in the current results stopped, so the stop checks assert that nothing is stopped.
 */

const resultsPath = fileURLToPath(new URL('../llm-benchmark/results.json', import.meta.url))
const rawRecords = JSON.parse(readFileSync(resultsPath, 'utf8')) as Array<
  BenchmarkResult & { source?: string }
>

const realBoard = (): Board => {
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as BenchmarkResult[]
  return buildBoard({
    results,
    models: registry.BENCHMARK_MODELS,
    tasks: registry.BENCHMARK_TASKS,
    categories: registry.BENCHMARK_CATEGORIES,
    now: '2026-11-11T12:00:00.000Z',
    resultsSha256: 'test',
  })
}

const board = realBoard()

/** Round to one decimal, half up, as the page does (an epsilon stops binary noise from rounding a true half down). */
function round1(x: number): number {
  return Math.round(x * 10 + 1e-9) / 10
}

/** One decimal, as text: 95.55 reads 95.6, 96.05 reads 96.1. */
function fmt1(x: number): string {
  return round1(x).toFixed(1)
}

/**
 * A cell's all-trials score, written from the definition, one decimal: the record's scoreAllTrials when it has one; else the
 * iteration-score sum over the iterations; else the score times the completed iterations over the iterations; else the score.
 */
function cellAllTrialsFromRaw(r: BenchmarkResult): number {
  if (typeof r.scoreAllTrials === 'number') return round1(r.scoreAllTrials)
  if (Array.isArray(r.iterationScores)) return round1(r.iterationScores.reduce((a, b) => a + b, 0) / r.iterations)
  if (typeof r.iterationsSucceeded === 'number') return round1((r.score * r.iterationsSucceeded) / r.iterations)
  return round1(r.score)
}

/** Per-iteration values of a cell, with a zero for every iteration that has no score (a failed iteration counts as zero). */
function valuesFromRaw(r: BenchmarkResult): number[] {
  const values = [...(r.iterationScores ?? [])]
  while (values.length < r.iterations) values.push(0)
  return values
}

const HORIZON_TASKS = ['orbit-lab', 'pathfinding-lab', 'rlc-response-lab', 'bicycle-blueprint', 'sector-clock', 'kanban-keyboard-undo']

function rawOf(modelId: string, taskId: string): BenchmarkResult {
  const hits = rawRecords.filter((r) => r.modelId === modelId && r.taskId === taskId && r.source === 'live')
  expect(hits, `${modelId} on ${taskId}`).toHaveLength(1)
  return hits[0]
}

/** FNV-1a, mulberry32 and the percentile bootstrap, written out from the documented method (not imported from the board). */
function fnv1aOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
function mulberry32Of(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The 95% interval of the mean over cells, each cell a list of values; the seed is the model and its task ids. */
function bootstrapOver(cells: number[][], seedText: string): [number, number] {
  const rand = mulberry32Of(fnv1aOf(seedText))
  const n = cells.length
  const stats: number[] = []
  for (let b = 0; b < 2000; b++) {
    let total = 0
    for (let k = 0; k < n; k++) {
      const c = cells[Math.floor(rand() * n)]
      let acc = 0
      for (let i = 0; i < c.length; i++) acc += c[Math.floor(rand() * c.length)]
      total += acc / c.length
    }
    stats.push(total / n)
  }
  stats.sort((a, b) => a - b)
  const pct = (p: number) => { const idx = p * (stats.length - 1), lo = Math.floor(idx), hi = Math.ceil(idx); return stats[lo] + (stats[hi] - stats[lo]) * (idx - lo) }
  return [pct(0.025), pct(0.975)]
}

/** The 95% interval of a model's mean cell score over its Horizon cells, from the raw records. */
function bootstrapFromRaw(modelId: string): [number, number] {
  const cells = HORIZON_TASKS.map((t) => valuesFromRaw(rawOf(modelId, t)))
  return bootstrapOver(cells, `${modelId}|${HORIZON_TASKS.join(',')}`)
}

/** A level's Horizon mean over its six cells, and its interval, from the raw records. */
function levelFromRaw(modelId: string) {
  const cells = HORIZON_TASKS.map((t) => cellAllTrialsFromRaw(rawOf(modelId, t)))
  return { cells, mean: cells.reduce((a, b) => a + b, 0) / cells.length, interval: bootstrapFromRaw(modelId) }
}

/** The text of a 95% interval, as the page writes it: "[84.6 to 100.0]". */
function ivText(iv: [number, number]): string {
  return `[${fmt1(iv[0])} to ${fmt1(iv[1])}]`
}

/** Dollars to three significant figures, as the page's tables write them. */
function usd(x: number): string {
  return `$${x.toPrecision(3)}`
}

describe('F1, real data: no record in results.json stopped before its planned iterations ran', () => {
  it('no record is stopped: no live record carries a stop field, the board names no stop in any cell, row, level, caveat or count, the method says so, and the page text carries no stop label or stopped-cells note', () => {
    const live = rawRecords.filter((r) => r.source === 'live')
    expect(live.filter((r) => r.budgetExceeded || r.quotaNextResetAt)).toEqual([])
    expect(board.source.stoppedCells).toBe(0)
    expect(board.source.iterationsNotRun).toBe(0)
    expect(board.stoppedNotRun).toEqual([])
    expect(board.cells.filter((c) => c.stopped || c.stopLabel || c.stopSentence)).toEqual([])
    for (const scope of Object.keys(board.glance)) {
      for (const group of Object.keys(board.glance[scope as keyof typeof board.glance])) {
        const block = board.glance[scope as keyof typeof board.glance][group as 'claude' | 'all']
        expect(block.rows.filter((r) => r.stoppedCells || r.stopLabel), `${scope}/${group}`).toEqual([])
      }
    }
    for (const scope of Object.keys(board.effort)) {
      for (const group of Object.keys(board.effort[scope as keyof typeof board.effort])) {
        for (const comp of board.effort[scope as keyof typeof board.effort][group as 'claude' | 'all']) {
          expect(comp.stopNotes, `${scope}/${group}/${comp.baseModelId}`).toEqual([])
          for (const level of comp.levels) expect(level.stopMark).toBeNull()
        }
      }
    }
    for (const scope of Object.keys(board.guides)) {
      for (const group of Object.keys(board.guides[scope as keyof typeof board.guides])) {
        const guide = board.guides[scope as keyof typeof board.guides][group as 'claude' | 'all']
        expect(guide.caveats.filter((c) => c.startsWith('Stopped cells')), `${scope}/${group}`).toEqual([])
      }
    }
    expect(board.definitions.stoppedCount).toBe('No record in these results was stopped this way.')
    expect(board.definitions.stoppedRule).toMatch(/counted over the iterations that ran/)
    expect(board.definitions.stoppedRule).toMatch(/The limit: the record cannot tell a model failure from the stop, so a failure earlier in the same pair would also be dropped/)
    // The stop rule is the method's definition, so it is left out of the page-text check: no label or note is in the rest.
    const withoutRule = JSON.stringify({ ...board, definitions: { ...board.definitions, stoppedRule: '' } })
    expect(withoutRule).not.toMatch(/stopped by the account|Stopped cells|not run, stopped|This cell was stopped|stopped cell/)
  })
})

describe('F2, real data: the Opus 5.5 values with three effort levels, recomputed from the raw records', () => {
  const levels = [
    { effort: 'low', modelId: 'claude-opus-5-5-low' },
    { effort: 'medium', modelId: 'claude-opus-5-5' },
    { effort: 'high', modelId: 'claude-opus-5-5-high' },
  ]

  it('each Opus level\'s Horizon score is the mean of its six cells\' all-trials scores, computed from the raw iteration scores', () => {
    const comp = board.effort.horizon.claude.find((c) => c.baseModelId === 'claude-opus-5-5')!
    for (const level of comp.levels) {
      const expected = levels.find((l) => l.effort === level.effort)!
      expect(level.modelId).toBe(expected.modelId)
      expect(level.score!, level.effort).toBeCloseTo(levelFromRaw(expected.modelId).mean, 9)
    }
  })

  it('Opus 5.5 (high effort) on Horizon: the cells are 100, 100, 98, 97, 78.3, 100 (RLC is 98, was 100 when it stopped), and the mean is 95.6 (was 95.9)', () => {
    // The RLC record ran all three iterations (100, 100, 94), so its cell counts three and scores their mean, 98.
    const raw = rawOf('claude-opus-5-5-high', 'rlc-response-lab')
    expect(raw.iterations).toBe(3)
    expect(raw.iterationScores).toEqual([100, 100, 94])
    expect(raw.scoreAllTrials).toBe(98)
    expect(raw.costUsd).toBe(2.35566)
    const rlc = board.cells.find((c) => c.modelId === 'claude-opus-5-5-high' && c.taskId === 'rlc-response-lab')!
    expect(rlc.iterations).toBe(3)
    expect(rlc.succeeded).toBe(3)
    expect(rlc.stopped).toBeNull()
    // The record's own failure reason, as recorded for a complete record ('none'), not a stop.
    expect(rlc.failureReason).toBe('none')
    const summary = board.summaries.find((s) => s.modelId === 'claude-opus-5-5-high' && s.scope === 'horizon')!
    const cells = HORIZON_TASKS.map((t) => cellAllTrialsFromRaw(rawOf('claude-opus-5-5-high', t)))
    expect(cells).toEqual([100, 100, 98, 97, 78.3, 100])
    const mean = cells.reduce((a, b) => a + b, 0) / 6
    expect(summary.meanScoreAllTrials).toBeCloseTo(mean, 9)
    expect(fmt1(mean)).toBe('95.6')
    expect(fmt1(summary.meanScoreAllTrials)).toBe('95.6')
    // Cost per attempt: each cell's billed cost over the three iterations it ran, then the mean over the six cells.
    const perAttempt = HORIZON_TASKS.map((t) => {
      const r = rawOf('claude-opus-5-5-high', t)
      return r.costUsd / r.iterations
    })
    expect(summary.costPerAttempt).toBeCloseTo(perAttempt.reduce((a, b) => a + b, 0) / 6, 9)
    expect(usd(summary.costPerAttempt as number)).toBe('$0.493')
  })

  it('the Opus 5.5 intervals on Horizon are recomputed from the raw cells by the documented bootstrap (high: 84.6 to 100.0)', () => {
    for (const modelId of ['claude-opus-5-5-low', 'claude-opus-5-5', 'claude-opus-5-5-high']) {
      const summary = board.summaries.find((s) => s.modelId === modelId && s.scope === 'horizon')!
      const expected = bootstrapFromRaw(modelId)
      expect(summary.interval![0], modelId).toBeCloseTo(expected[0], 9)
      expect(summary.interval![1], modelId).toBeCloseTo(expected[1], 9)
    }
    const high = board.summaries.find((s) => s.modelId === 'claude-opus-5-5-high' && s.scope === 'horizon')!
    expect(ivText(bootstrapFromRaw('claude-opus-5-5-high'))).toBe('[84.6 to 100.0]')
    expect(high.interval![1]).toBe(100)
  })

  it('the Opus effort finding is the full sentence computed from the raw levels: three levels, the change from low to high, the cost, and the sample on the last sentence', () => {
    const low = levelFromRaw('claude-opus-5-5-low')
    const medium = levelFromRaw('claude-opus-5-5')
    const high = levelFromRaw('claude-opus-5-5-high')
    const delta = high.mean - low.mean
    const overlap = low.interval[0] <= high.interval[1] && high.interval[0] <= low.interval[1]
    expect(overlap).toBe(true)
    const costOf = (id: string) => HORIZON_TASKS.map((t) => rawOf(id, t)).map((r) => r.costUsd / r.iterations).reduce((a, b) => a + b, 0) / 6
    const costDelta = costOf('claude-opus-5-5-high') - costOf('claude-opus-5-5-low')
    const requested = levels.reduce((s, l) => s + HORIZON_TASKS.reduce((t, id) => t + rawOf(l.modelId, id).iterations, 0), 0)
    expect(requested).toBe(54)
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-opus-5-5')!
    const expected = [
      `Claude Opus 5.5 all-trials scores by effort, with 95% intervals: low ${fmt1(low.mean)} ${ivText(low.interval)}, medium ${fmt1(medium.mean)} ${ivText(medium.interval)} and high ${fmt1(high.mean)} ${ivText(high.interval)}.`,
      `The change from low to high effort, ${delta >= 0 ? '+' : '-'}${fmt1(Math.abs(delta))} points, is not established: the 95% intervals overlap, so differences are not established with 3 iterations per task.`,
      `Cost per attempt changes by ${costDelta >= 0 ? '+' : '-'}${usd(Math.abs(costDelta))} (${usd(costOf('claude-opus-5-5-low'))} to ${usd(costOf('claude-opus-5-5-high'))}) (compared on 6 tasks every effort level ran; 3 configurations covering at least 80% of the horizon tasks, ${requested} requested iterations).`,
    ].join(' ')
    expect(effort.body).toBe(expected)
    expect(effort.body).toContain('high 95.6 [84.6 to 100.0]')
    expect(effort.body).toContain('Cost per attempt changes by +$0.357 ($0.135 to $0.493)')
    // The figure is the lowest to the highest level score, here low 92.2 and medium 96.1 (96.05 rounds to 96.1).
    expect(effort.figure).toBe(`${fmt1(low.mean)} to ${fmt1(medium.mean)}`)
    expect(effort.figure).toBe('92.2 to 96.1')
  })

  it('the Horizon top names the tied top, and places Opus 5.5 (high effort) among the not-separable configurations at 95.6', () => {
    // Claude configurations covering at least 80% of the six Horizon tasks (five or more), ranked by their mean.
    const claudeIds = new Set(registry.BENCHMARK_MODELS.filter((m) => m.company === 'Anthropic').map((m) => m.id))
    const ran = [...new Set(rawRecords.filter((r) => r.source === 'live' && claudeIds.has(r.modelId) && HORIZON_TASKS.includes(r.taskId)).map((r) => r.modelId))]
    const covering = ran.filter((id) => HORIZON_TASKS.filter((t) => rawRecords.some((r) => r.source === 'live' && r.modelId === id && r.taskId === t)).length >= 5)
    const means = covering.map((id) => {
      const cells = HORIZON_TASKS.filter((t) => rawRecords.some((r) => r.source === 'live' && r.modelId === id && r.taskId === t)).map((t) => cellAllTrialsFromRaw(rawOf(id, t)))
      return { id, mean: cells.reduce((a, b) => a + b, 0) / cells.length }
    })
    const top = Math.max(...means.map((m) => m.mean))
    expect(fmt1(top)).toBe('100.0')
    const tied = means.filter((m) => Math.abs(m.mean - top) < 1e-6).map((m) => m.id)
    expect(tied.sort()).toEqual(['claude-fable-5-2-low', 'claude-sonnet-5-5-xhigh'])
    const body = board.insights.horizon.claude.find((i) => i.id === 'top')!.body
    const names = tied.map((id) => registry.BENCHMARK_MODELS.find((m) => m.id === id)!.name).sort()
    expect(body.startsWith(`${names[0]} and ${names[1]} both score 100.0 on every iteration, so the top cannot be ranked among them.`)).toBe(true)
    const opusHigh = levelFromRaw('claude-opus-5-5-high')
    expect(body).toContain(`Claude Opus 5.5 (high effort) (${fmt1(opusHigh.mean)}, interval ${ivText(opusHigh.interval)})`)
    expect(body).toContain(`Claude Opus 5.5 (high effort) (95.6, interval [84.6 to 100.0])`)
  })

  it('the Horizon frontier: Opus 5.5 (high effort) at 95.6 is dominated by Claude Fable 5.2 (low effort), the cheapest configuration that scores no less', () => {
    // Every Horizon configuration in the scope with a measured cost and covering at least five of six tasks, as the board uses.
    const pricedRule = (id: string) => {
      const m = registry.BENCHMARK_MODELS.find((x) => x.id === id)!
      const positive = [m.costPer1kInputUsd, m.costPer1kOutputUsd].map((v) => Number((v * 1000).toPrecision(12))).filter((v) => v > 0)
      return positive.length > 0 && !positive.some((v) => v < 0.01)
    }
    const ids = [...new Set(rawRecords.filter((r) => r.source === 'live' && HORIZON_TASKS.includes(r.taskId)).map((r) => r.modelId))]
    const rows = ids.map((id) => {
      const tasks = HORIZON_TASKS.filter((t) => rawRecords.some((r) => r.source === 'live' && r.modelId === id && r.taskId === t))
      const recs = tasks.map((t) => rawOf(id, t))
      const mean = recs.map((r) => cellAllTrialsFromRaw(r)).reduce((a, b) => a + b, 0) / recs.length
      // A cost is measured for a priced model when it is above zero, or a reported zero.
      const costed = recs.filter((r) => pricedRule(id) && (r.costUsd > 0 || r.usage?.source === 'reported'))
      const cost = costed.length ? costed.reduce((s, r) => s + r.costUsd / r.iterations, 0) / costed.length : null
      return { id, tasks: tasks.length, mean, cost }
    })
    const eligible = rows.filter((r) => r.tasks >= 5 && r.cost !== null)
    const opus = eligible.find((r) => r.id === 'claude-opus-5-5-high')!
    const dominators = eligible
      .filter((q) => q.id !== opus.id && q.cost! <= opus.cost! && q.mean >= opus.mean && (q.cost! < opus.cost! || q.mean > opus.mean))
      .sort((a, b) => b.mean - a.mean || a.cost! - b.cost!)
    expect(dominators[0].id).toBe('claude-fable-5-2-low')
    const fable = levelFromRaw('claude-fable-5-2-low')
    const frontier = board.insights.horizon.claude.find((i) => i.id === 'frontier')!
    expect(frontier.body).toContain(`Claude Opus 5.5 (high effort) (95.6, interval [84.6 to 100.0]) is dominated by Claude Fable 5.2 (low effort) (${fmt1(fable.mean)}, interval ${ivText(fable.interval)})`)
  })

  it('the Horizon run count for the Claude group: 198 iterations requested, the Opus high row counts 18, and every cell ran three iterations', () => {
    // Every live Anthropic record on the six Horizon tasks: the iterations each record ran.
    const claudeIds = new Set(registry.BENCHMARK_MODELS.filter((m) => m.company === 'Anthropic').map((m) => m.id))
    const records = rawRecords.filter((r) => r.source === 'live' && claudeIds.has(r.modelId) && HORIZON_TASKS.includes(r.taskId))
    const counted = records.reduce((s, r) => s + r.iterations, 0)
    expect(records).toHaveLength(66)
    expect(counted).toBe(198)
    expect(board.glance.horizon.claude.rows.reduce((s, r) => s + r.requested, 0)).toBe(counted)
    const opusHighRow = board.glance.horizon.claude.rows.find((r) => r.modelId === 'claude-opus-5-5-high')!
    expect(opusHighRow.requested).toBe(18)
    expect(opusHighRow.completed).toBe(18)
    // The sample caveat names the iterations per cell the records share.
    const perCell = [...new Set(records.map((r) => r.iterations))]
    expect(perCell).toEqual([3])
    expect(board.guides.horizon.claude.caveats[0]).toMatch(/^Each cell ran 3 iterations\./)
  })
})

describe('F3b, real data: every finding ends with a full stop, and no clause stands as a sentence of its own', () => {
  it('for every scope and group, each finding body ends with "." (or ".)") and never has ")." followed by "("', () => {
    let checked = 0
    for (const scope of Object.keys(board.insights)) {
      for (const group of Object.keys(board.insights[scope as keyof typeof board.insights])) {
        for (const i of board.insights[scope as keyof typeof board.insights][group as 'claude' | 'all']) {
          checked += 1
          expect(i.body, `${scope}/${group}/${i.id}`).toMatch(/\.\)?$/)
          expect(i.body, `${scope}/${group}/${i.id}`).not.toMatch(/\)\.\s*\(/)
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('F4: the seat-pricing sentence has two states, and the constant is set to held', () => {
  it('the constant is held: the real board says seat-pricing is registered but held back, with no results', () => {
    expect(SEAT_PRICING_STATE).toBe('held')
    const held = board.heldBack.find((h) => h.id === 'seat-pricing')!
    expect(held.sentence).toBe('seat-pricing is registered but held back: its contrast check did not pass review, so it has no results.')
    expect(board.heldBackTasks).toContain(held.title)
  })

  it('both states give their own sentence', () => {
    const task = { id: 'seat-pricing' }
    expect(heldBackSentenceIn(task, 'held')).toBe('seat-pricing is registered but held back: its contrast check did not pass review, so it has no results.')
    expect(heldBackSentenceIn(task, 'not-run')).toBe("seat-pricing passed review on 2026-11-11 but has not been run yet: the API key's spend limit was reached.")
  })

  it('a task with records is not held back: the sentence and the held-back count go, and the task counts with runs', () => {
    const models: BenchmarkModel[] = [{ id: 'acme', name: 'Acme', provider: 'Anthropic', costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002, contextWindow: 1, capabilities: '', company: 'Anthropic' } as BenchmarkModel]
    const tasks: BenchmarkTask[] = [
      { id: 'seat-pricing', category: 'advanced-game-building', title: 'Seat pricing', blurb: '', prompt: '', runtimeHint: '', iterationsDefault: 3, methodNotes: '', demoComponentName: '', slug: 'seat-pricing', scorer: 'behavioral', pluginId: 'horizon-suite' } as BenchmarkTask,
    ]
    const results = [{
      taskId: 'seat-pricing', modelId: 'acme', score: 90, runtimeMs: 1000, tokensIn: 1, tokensOut: 1, costUsd: 0,
      iterations: 2, iterationsSucceeded: 2, iterationScores: [90, 90], status: 'success', createdAt: '2026-11-11T00:00:00.000Z',
      source: 'live', scorerVersion: 2,
    } as BenchmarkResult]
    const input: BuildInput = { results, models, tasks, categories: [{ slug: 'advanced-game-building', label: 'Advanced', glyph: '◆', accent: '#000', blurb: '' } as BenchmarkCategory], now: '2026-11-11T12:00:00.000Z', resultsSha256: 'x' }
    const b = buildBoard(input)
    expect(b.heldBack).toEqual([])
    expect(b.heldBackTasks).toEqual([])
    const horizon = b.suites.find((s) => s.id === 'horizon')!
    expect(horizon.note).toContain('1 task registered.')
    expect(horizon.note).not.toContain('held back')
  })
})
