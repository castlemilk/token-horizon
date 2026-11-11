import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import { STOP_RULE, buildBoard, stopLabel, stopOf, type BuildInput } from './board'

/**
 * F1: a record that stopped at the account's API spend limit (budgetExceeded) or a provider quota (quotaNextResetAt)
 * before its planned iterations ran. Its unrun iterations are not requested, failed or scored; the cell is labelled.
 * Every fixture here is invented, so the tests pin the rule, not any real number.
 */

const NOW = '2026-11-11T12:00:00.000Z'
const CLASSIC = 'community-tasks'
const CATEGORIES: BenchmarkCategory[] = [{ slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' } as BenchmarkCategory]

function task(id: string): BenchmarkTask {
  return {
    id, category: 'advanced-game-building', title: `Task ${id}`, blurb: '', prompt: '', runtimeHint: '',
    iterationsDefault: 3, methodNotes: '', demoComponentName: '', slug: id, scorer: 'behavioral', pluginId: CLASSIC,
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return {
    id, name, provider: 'Anthropic', costPer1kInputUsd: 0.004, costPer1kOutputUsd: 0.02, contextWindow: 1000,
    capabilities: '', company: 'Anthropic', ...over,
  }
}

function rec(over: Partial<BenchmarkResult> & { taskId: string; modelId: string }): BenchmarkResult {
  return {
    score: 0, runtimeMs: 1000, tokensIn: 100, tokensOut: 200, costUsd: 0, iterations: 3, status: 'success',
    createdAt: '2026-11-11T00:00:00.000Z', source: 'live', scorerVersion: 2, ...over,
  }
}

/** A record that completed every planned iteration with the given scores. */
function complete(taskId: string, modelId: string, scores: number[], over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  return rec({
    taskId, modelId, score: mean, iterations: scores.length, iterationScores: scores, iterationsSucceeded: scores.length,
    scoreAllTrials: mean, costUsd: 1.5, ...over,
  })
}

/**
 * A record that stopped: three iterations planned, two completed. Its own scoreAllTrials divides by three, which is the
 * figure the stop rule must not use. The completed scores are 100 and 100, so the stopped cell's score is 100.
 */
function stopped(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return rec({
    taskId: 't1', modelId: 'stopper', score: 100, iterations: 3, iterationsSucceeded: 2, iterationScores: [100, 100],
    scoreAllTrials: 66.7, status: 'partial', failureReason: 'quota_exhausted', costUsd: 0.6,
    quotaNextResetAt: '2026-12-01T00:00:00.000Z',
    usage: { inputTokens: 1, outputTokens: 1, source: 'reported' } as BenchmarkResult['usage'],
    ...over,
  })
}

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

const models = [model('stopper', 'Stopper'), model('other', 'Other', { company: 'Acme', provider: 'OpenRouter' })]
const tasks = [task('t1'), task('t2')]

function baseWorld(stop: Partial<BenchmarkResult>) {
  return [
    stopped(stop),
    complete('t2', 'stopper', [90, 90, 90]),
    complete('t1', 'other', [80, 80, 80]),
    complete('t2', 'other', [80, 80, 80]),
  ]
}

describe('F1: a stopped record is measured over the iterations that ran', () => {
  it.each([
    ['budgetExceeded', { budgetExceeded: { spentUsd: 1, capUsd: 1 }, quotaNextResetAt: undefined }, 'budget'],
    ['quotaNextResetAt', { quotaNextResetAt: '2026-12-01T00:00:00.000Z' }, 'quota'],
  ] as const)('%s: the cell counts two requested iterations, scores their mean and names the stop', (_name, over, by) => {
    const board = buildBoard(world(baseWorld(over as Partial<BenchmarkResult>), models, tasks))
    const cell = board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't1')!
    expect(cell.iterations).toBe(2)
    expect(cell.succeeded).toBe(2)
    expect(cell.truncatedIterations).toBe(0)
    expect(cell.stopped).toEqual({ planned: 3, notRun: 1, by })
    // The record's own 66.7 divides by three; the all-trials score of the iterations that ran is their mean.
    expect(cell.scoreAllTrials).toBe(100)
    expect(cell.iterationScores).toEqual([100, 100])
    expect(cell.failureReason).toBeNull()
    // Cost per attempt divides the cell's cost by the two iterations that ran, not the three planned.
    expect(cell.costPerIteration).toBeCloseTo(0.3, 10)
  })

  it('the summary, the reliability counts and the source totals leave the unrun iteration out', () => {
    const board = buildBoard(world(baseWorld({ budgetExceeded: { spentUsd: 1, capUsd: 1 } }), models, tasks))
    const s = board.summaries.find((x) => x.modelId === 'stopper' && x.scope === 'headline')!
    // Two cells: t1 at 100 (over two iterations) and t2 at 90 (over three). The mean is over cells, as it always was.
    expect(s.meanScoreAllTrials).toBe(95)
    expect(s.successRate).toBe(1)
    expect(board.source.iterationsNotRun).toBe(1)
    expect(board.source.stoppedCells).toBe(1)
    const row = board.glance.headline.all.rows.find((r) => r.modelId === 'stopper')!
    expect(row.requested).toBe(5)
    expect(row.completed).toBe(5)
    expect(row.failed).toBe(0)
    expect(row.truncated).toBe(0)
    expect(row.failureReason).toBeNull()
    expect(row.notRun).toBe(1)
    expect(row.stoppedCells).toBe(1)
  })

  it('a stop shows as a caveat that names the cell and the label, and the findings do not count it as a failure', () => {
    const board = buildBoard(world(baseWorld({ quotaNextResetAt: '2026-12-01T00:00:00.000Z' }), models, tasks))
    const guide = board.guides.headline.all
    const caveat = guide.caveats.find((c) => c.startsWith('Stopped cells'))!
    expect(caveat).toContain("Stopper on Task t1, stopped by the account's API spend limit: 1 of 3 iterations not run")
    const reliability = board.insights.headline.all.find((i) => i.id === 'reliability')!
    expect(reliability.body).toContain(stopLabel(1, 3))
    expect(reliability.body).not.toMatch(/had failed iterations/)
    expect(board.insights.headline.all.find((i) => i.id === 'reliability')!.figure).toBe('100')
  })

  it('an effort comparison names the stopped cell and counts the level over the iterations that ran', () => {
    const effortModels = [
      model('x', 'X', { reasoningEffort: 'medium' } as Partial<BenchmarkModel>),
      model('x-high', 'X (high effort)', { baseModelId: 'x', reasoningEffort: 'high' } as Partial<BenchmarkModel>),
    ]
    const results = [
      complete('t1', 'x', [70, 70, 70]),
      complete('t2', 'x', [70, 70, 70]),
      stopped({ modelId: 'x-high', taskId: 't1' }),
      complete('t2', 'x-high', [100, 100, 100]),
    ]
    const board = buildBoard(world(results, effortModels, tasks))
    const comp = board.effort.headline.all.find((c) => c.baseModelId === 'x')!
    expect(comp.tasks).toEqual(['t1', 't2'])
    const high = comp.levels.find((l) => l.effort === 'high')!
    expect(high.stoppedCells).toBe(1)
    expect(high.notRun).toBe(1)
    expect(high.requested).toBe(5)
    expect(high.truncated).toBe(0)
    expect(comp.stopNotes).toEqual([
      "High effort on Task t1, stopped by the account's API spend limit: 1 of 3 iterations not run. Its score, interval and cost count the 2 iterations that ran.",
    ])
    const effortInsight = board.insights.headline.all.find((i) => i.id === 'effort-x')!
    expect(effortInsight.body).toContain(comp.stopNotes[0])
  })

  it('the stop rule is in the definitions, and it names its limit', () => {
    const board = buildBoard(world(baseWorld({ budgetExceeded: { spentUsd: 1, capUsd: 1 } }), models, tasks))
    expect(board.definitions.stoppedRule).toBe(STOP_RULE)
    expect(STOP_RULE).toMatch(/limit: the record cannot tell a model failure from the stop/)
  })
})

describe('F1: what is not a stop stays as it was', () => {
  it('a record with no stop field and a failed iteration is an ordinary failure', () => {
    const board = buildBoard(world([
      stopped({ budgetExceeded: undefined, quotaNextResetAt: undefined, failureReason: 'endpoint_hung' }),
      complete('t2', 'stopper', [90, 90, 90]),
      complete('t1', 'other', [80, 80, 80]),
      complete('t2', 'other', [80, 80, 80]),
    ], models, tasks))
    const cell = board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't1')!
    expect(cell.stopped).toBeNull()
    expect(cell.iterations).toBe(3)
    expect(cell.scoreAllTrials).toBe(66.7)
    expect(cell.failureReason).toBe('endpoint_hung')
    expect(board.source.stoppedCells).toBe(0)
    expect(board.glance.headline.all.rows.find((r) => r.modelId === 'stopper')!.failed).toBe(1)
  })

  it('a record that stops field-marked but completed every iteration is not a stop', () => {
    const r = stopped({ iterationsSucceeded: 3, iterationScores: [100, 100, 100], scoreAllTrials: undefined })
    expect(stopOf(r)).toBeNull()
    const board = buildBoard(world([r, complete('t2', 'stopper', [90, 90, 90]), complete('t1', 'other', [80, 80, 80]), complete('t2', 'other', [80, 80, 80])], models, tasks))
    expect(board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't1')!.stopped).toBeNull()
  })

  it('stopOf reads the two stop fields and nothing else', () => {
    expect(stopOf({ iterations: 3, iterationsSucceeded: 2, budgetExceeded: { spentUsd: 1, capUsd: 1 } })).toEqual({ planned: 3, ran: 2, notRun: 1, by: 'budget' })
    expect(stopOf({ iterations: 3, iterationsSucceeded: 2, quotaNextResetAt: '2026-12-01T00:00:00.000Z' })).toEqual({ planned: 3, ran: 2, notRun: 1, by: 'quota' })
    expect(stopOf({ iterations: 3, iterationsSucceeded: 2 })).toBeNull()
    expect(stopOf({ iterations: 3, budgetExceeded: { spentUsd: 1, capUsd: 1 } })).toBeNull()
  })
})

describe('F1: the build refuses a stopped record it cannot measure', () => {
  it('throws when the record does not score every iteration that ran', () => {
    const bad = stopped({ iterationScores: [100] })
    expect(() => buildBoard(world([bad, complete('t2', 'stopper', [90, 90, 90])], models, tasks))).toThrow(
      /stopped with 2 iterations completed but 1 iteration scores/
    )
  })

  it('a stop with no iteration run is not measured, so it does not throw', () => {
    const none = stopped({ iterationsSucceeded: 0, iterationScores: [], status: 'fail' })
    expect(() => buildBoard(world([none, complete('t2', 'stopper', [90, 90, 90])], models, tasks))).not.toThrow()
  })
})

describe('F1 (G1-e): a record that stopped before any iteration ran is a not-run cell, named as stopped', () => {
  const notRun = () => stopped({ iterationsSucceeded: 0, iterationScores: [], status: 'fail', failureReason: 'quota_exhausted' })
  const worldWithNotRun = () => buildBoard(world([
    notRun(),
    complete('t2', 'stopper', [90, 90, 90]),
    complete('t1', 'other', [80, 80, 80]),
    complete('t2', 'other', [80, 80, 80]),
  ], models, tasks))

  it('the cell is absent from the measured cells, so the heat map draws it as not run', () => {
    const board = worldWithNotRun()
    expect(board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't1')).toBeUndefined()
    expect(board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't2')).toBeDefined()
    expect(board.stoppedNotRun).toEqual([
      { modelId: 'stopper', taskId: 't1', suite: 'classic', scorerVersion: 2, stopped: { planned: 3, notRun: 3, by: 'quota' }, label: stopLabel(3, 3) },
    ])
  })

  it('the source totals count the stopped cell and its three iterations not run', () => {
    const board = worldWithNotRun()
    expect(board.source.stoppedCells).toBe(1)
    expect(board.source.iterationsNotRun).toBe(3)
    expect(board.source.iterationsRequested).toBe(9)
  })

  it('the task is run, so it is not held back', () => {
    const board = worldWithNotRun()
    expect(board.heldBackTasks).toEqual([])
    expect(board.heldBack).toEqual([])
  })

  it('the configuration row counts the three iterations not run, labelled, and the requested count leaves them out', () => {
    const row = worldWithNotRun().glance.headline.all.rows.find((r) => r.modelId === 'stopper')!
    expect(row.requested).toBe(3)
    expect(row.failed).toBe(0)
    expect(row.notRun).toBe(3)
    expect(row.stoppedPlanned).toBe(3)
    expect(row.stoppedCells).toBe(1)
    expect(row.stopLabel).toBe(stopLabel(3, 3))
  })

  it('the caveat names the not-run cell with its label', () => {
    const board = worldWithNotRun()
    const caveat = board.guides.headline.all.caveats.find((c) => c.startsWith('Stopped cells'))!
    expect(caveat).toContain(`Stopper on Task t1, ${stopLabel(3, 3)}`)
  })

  it('a covering configuration with a not-run cell is named in the reliability finding, and is not counted as a failure', () => {
    // Five tasks: the stopper ran four of them (80%, covering), and its fifth cell did not run.
    const five = ['t1', 't2', 't3', 't4', 't5'].map((id) => task(id))
    const results = [
      notRun(),
      ...['t2', 't3', 't4', 't5'].map((id) => complete(id, 'stopper', [90, 90, 90])),
      ...['t1', 't2', 't3', 't4', 't5'].map((id) => complete(id, 'other', [80, 80, 80])),
    ]
    const board = buildBoard(world(results, models, five))
    const reliability = board.insights.headline.all.find((i) => i.id === 'reliability')!
    // The sample clause (27 requested iterations, all completed) is on the last sentence, after the stop sentence.
    expect(reliability.body).toContain(`Not counted as requested or failed, because the run stopped: Stopper on Task t1, ${stopLabel(3, 3)} (27 of 27 requested iterations completed).`)
    expect(reliability.body).not.toMatch(/had failed iterations/)
  })

  it('the method says how many records stopped this way, and how many iterations did not run', () => {
    expect(worldWithNotRun().definitions.stoppedCount).toBe(
      '1 record in these results was stopped this way, with 3 iterations not run; each is named under its scope and in the glance table.'
    )
  })
})

describe('G2 (b): the method count sentence', () => {
  it('says no record was stopped when none was', () => {
    const board = buildBoard(world([complete('t1', 'other', [80, 80, 80]), complete('t2', 'other', [80, 80, 80])], models, tasks))
    expect(board.definitions.stoppedCount).toBe('No record in these results was stopped this way.')
    expect(board.source.stoppedCells).toBe(0)
  })

  it('gives the count when records stopped: two records, two iterations not run', () => {
    const board = buildBoard(world([
      stopped(),
      stopped({ taskId: 't2', iterationScores: [100, 100], iterationsSucceeded: 2 }),
      complete('t1', 'other', [80, 80, 80]),
      complete('t2', 'other', [80, 80, 80]),
    ], models, tasks))
    expect(board.definitions.stoppedCount).toBe(
      '2 records in these results were stopped this way, with 2 iterations not run; each is named under its scope and in the glance table.'
    )
  })
})

describe('G2 (d): the stop label and sentences are built in board.ts', () => {
  it('a stopped cell carries its label and the sentence the page prints, and an unstopped cell carries neither', () => {
    const board = buildBoard(world(baseWorld({ quotaNextResetAt: '2026-12-01T00:00:00.000Z' }), models, tasks))
    const cell = board.cells.find((c) => c.modelId === 'stopper' && c.taskId === 't1')!
    expect(cell.stopLabel).toBe(stopLabel(1, 3))
    expect(cell.stopSentence).toBe(`This cell was ${stopLabel(1, 3)}. Its score, cost and counts use the 2 iterations that ran.`)
    const other = board.cells.find((c) => c.modelId === 'other' && c.taskId === 't1')!
    expect(other.stopLabel).toBeNull()
    expect(other.stopSentence).toBeNull()
  })

  it('an effort level carries its chart note and tooltip line', () => {
    const effortModels = [
      model('x', 'X', { reasoningEffort: 'medium' } as Partial<BenchmarkModel>),
      model('x-high', 'X (high effort)', { baseModelId: 'x', reasoningEffort: 'high' } as Partial<BenchmarkModel>),
    ]
    const board = buildBoard(world([
      complete('t1', 'x', [70, 70, 70]),
      complete('t2', 'x', [70, 70, 70]),
      stopped({ modelId: 'x-high', taskId: 't1' }),
      complete('t2', 'x-high', [100, 100, 100]),
    ], effortModels, tasks))
    const high = board.effort.headline.all.find((c) => c.baseModelId === 'x')!.levels.find((l) => l.effort === 'high')!
    expect(high.stopMark).toBe('1 not run, stopped')
    expect(high.stopTip).toBe(`S: ${stopLabel(1, 3)}; this level is counted over the iterations that ran`)
    const medium = board.effort.headline.all.find((c) => c.baseModelId === 'x')!.levels.find((l) => l.effort === 'medium')!
    expect(medium.stopMark).toBeNull()
    expect(medium.stopTip).toBeNull()
  })
})

describe('G2 (a): the effort sentence counts the iterations of the cells it compares', () => {
  it('a stopped cell among the compared cells makes the count a range: "2 to 3 iterations per task"', () => {
    const effortModels = [
      model('x', 'X', { reasoningEffort: 'medium' } as Partial<BenchmarkModel>),
      model('x-high', 'X (high effort)', { baseModelId: 'x', reasoningEffort: 'high' } as Partial<BenchmarkModel>),
    ]
    // Three tasks, so each level has six or more interval values. x-high's t1 stopped after two of three iterations.
    const three = ['t1', 't2', 't3'].map((id) => task(id))
    const board = buildBoard(world([
      complete('t1', 'x', [50, 90, 70]),
      complete('t2', 'x', [50, 90, 70]),
      complete('t3', 'x', [50, 90, 70]),
      stopped({ modelId: 'x-high', taskId: 't1', iterationScores: [60, 100], score: 80 }),
      complete('t2', 'x-high', [80, 90, 100]),
      complete('t3', 'x-high', [80, 90, 100]),
    ], effortModels, three))
    const finding = board.insights.headline.all.find((i) => i.id === 'effort-x')!
    expect(finding.body).toContain('not established: the 95% intervals overlap, so differences are not established with 2 to 3 iterations per task.')
    expect(finding.body).not.toContain('few iterations per task')
    // The clause is on the last sentence: the sample is the compared tasks, the configurations and the requested iterations
    // (x: 3 + 3 + 3; x-high: 2 stopped + 3 + 3: 17).
    expect(finding.body).toMatch(/\(compared on 3 tasks every effort level ran; 2 configurations covering at least 80% of the headline tasks, 17 requested iterations\)\.$/)
  })
})

describe('G2 (c): the reliability sample clause is on the last sentence', () => {
  it('the completed-of-requested clause ends the finding, after the stop sentence', () => {
    const board = buildBoard(world(baseWorld({ quotaNextResetAt: '2026-12-01T00:00:00.000Z' }), models, tasks))
    const reliability = board.insights.headline.all.find((i) => i.id === 'reliability')!
    expect(reliability.body).toMatch(/Not counted as requested or failed, because the run stopped: .*\.$/)
    expect(reliability.body).toMatch(/ \(\d+ of \d+ requested iterations completed\)\.$/)
    expect(reliability.body).not.toMatch(/\) \./)
  })
})
