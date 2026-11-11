import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import * as registry from '../llm-benchmark/registry'
import { buildBoard, fmt1, type Board, type BuildInput } from './board'

// Review round four: a finding names only configurations that cover 80% of the scope's tasks (reliability included), the
// singular glance sentence excludes the too-variable configurations by name, and the effort figure's unit and wording
// follow the page's top rule.

const NOW = '2026-11-10T12:00:00.000Z'

const realBoard = (): Board => {
  const resultsPath = fileURLToPath(new URL('../llm-benchmark/results.json', import.meta.url))
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as BenchmarkResult[]
  return buildBoard({
    results,
    models: registry.BENCHMARK_MODELS,
    tasks: registry.BENCHMARK_TASKS,
    categories: registry.BENCHMARK_CATEGORIES,
    now: NOW,
    resultsSha256: 'test',
  })
}

const board = realBoard()
const SCOPES = ['headline', 'horizon', 'earlier'] as const
const GROUPS = ['claude', 'all'] as const

describe('findings, real board: a finding names only configurations that cover at least 80% of the scope\'s tasks', () => {
  for (const scope of SCOPES) {
    for (const group of GROUPS) {
      it(`${scope} / ${group}: no finding body names a non-covering configuration (no exceptions)`, () => {
        const block = board.glance[scope][group]
        const nonCovering = block.rows.filter((r) => !r.covering).map((r) => r.name)
        for (const insight of board.insights[scope][group]) {
          for (const name of nonCovering) {
            // A whole-name match: "Kimi K3" is not a name inside "Kimi K3.1 Pro".
            const whole = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`)
            expect(whole.test(insight.body), `${insight.id} names ${name}`).toBe(false)
          }
        }
      })
    }
  }

  it('Headline reliability: the covering configurations completed every requested iteration, and Haiku 5.5 (extra high effort) is not named', () => {
    const rel = board.insights.headline.claude.find((i) => i.id === 'reliability')!
    expect(rel.body).toBe('None of the 4 configurations covering at least 80% of the headline tasks had a failed iteration (120 of 120 requested iterations completed).')
    expect(rel).toMatchObject({ figure: '100', figureUnit: '% completed' })
    expect(rel.body).not.toContain('Haiku')
  })
})

describe('glance, real board: the covering clause names the scope\'s own tasks and counts the covering rows, in every scope', () => {
  for (const scope of SCOPES) {
    for (const group of GROUPS) {
      it(`${scope} / ${group}: sentences 1 and 2 name the scope's tasks and count the covering rows`, () => {
        const block = board.glance[scope][group]
        const covering = block.rows.filter((r) => r.covering).length
        // A group with no covering configuration has no comparison sentences to check.
        if (covering === 0) return
        const tasks = scope === 'earlier' ? `the ${block.rows[0].tasksTotal} earlier tasks` : `the ${scope} tasks`
        const clause = `(of ${covering} configurations covering at least 80% of ${tasks}, `
        expect(block.sentences[0]).toContain(clause)
        // Sentence 2 is the value pick, which needs a priced configuration; when it is absent, sentence 3 is the next compared one.
        const compared = block.sentences.filter((x) => /^(Not separable|Cheapest configuration not separable|\S.* is the only covering configuration)/.test(x))
        for (const sentence of compared) expect(sentence).toContain(clause)
        expect(block.sentences[0]).not.toContain('of all tasks')
      })
    }
  }
})

describe('effort, real board: the figure unit says change only when no pair of levels is separated', () => {
  it('Sonnet 5.5: a pair is separated (high and extra high), so the unit is a plain points range', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-sonnet-5-5')!
    expect(effort).toMatchObject({ figure: '93.9 to 100.0', figureUnit: 'pts' })
  })

  it('Haiku 5.5: no pair of levels is separated, so the unit still says the change is not established', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-haiku-5-5')!
    expect(effort.figureUnit).toBe('pts, change not established')
  })
})

describe('the shared formatter prints the page\'s one-decimal scores, half up', () => {
  it('the Opus 5.5 (medium effort) horizon mean prints 96.1 wherever it is printed', () => {
    const opus = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-opus-5-5')!
    expect(opus.body).toContain('96.1')
    expect(fmt1((100 + 100 + 100 + 98 + 78.3 + 100) / 6)).toBe('96.1')
  })
})

/** A five-iteration record per task with the given per-iteration scores. */
function rec(taskId: string, modelId: string, scores: number[]): BenchmarkResult {
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  return {
    taskId,
    modelId,
    score: mean,
    runtimeMs: 1000,
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0,
    iterations: scores.length,
    status: 'success',
    createdAt: '2026-11-01T00:00:00.000Z',
    source: 'live',
    scorerVersion: 2,
    iterationScores: scores,
    iterationsSucceeded: scores.length,
  } as BenchmarkResult
}

const task = (id: string): BenchmarkTask => ({
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
  pluginId: 'community-tasks',
})

const model = (id: string, name: string): BenchmarkModel => ({
  id,
  name,
  provider: 'OpenRouter',
  costPer1kInputUsd: 0.001,
  costPer1kOutputUsd: 0.002,
  contextWindow: 1000,
  capabilities: '',
  company: 'Acme',
})

const CATEGORIES: BenchmarkCategory[] = [
  { slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' },
]

describe('glance, synthetic: the singular sentence excludes a too-variable configuration by name', () => {
  // The top scores 80.0 on every iteration (a zero-width interval). The wide configuration swings between 0 and 100 across
  // eight iterations, so its interval is wider than 40 points and its upper bound reaches the top: it is too variable to rank.
  const tasks = ['c1', 'c2', 'c3', 'c4'].map(task)
  const models = [model('top', 'Top'), model('wide', 'Wide')]
  const results: BenchmarkResult[] = []
  tasks.forEach((t, i) => {
    results.push(rec(t.id, 'top', [80, 80]))
    results.push(rec(t.id, 'wide', i < 3 ? [100, 100] : [0, 0]))
  })
  const input: BuildInput = { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
  const synthetic = buildBoard(input)

  it('the wide configuration is wider than 40 points and reaches the top, so it is named as too variable', () => {
    const block = synthetic.glance.headline.all
    const wide = block.rows.find((r) => r.name === 'Wide')!
    expect(wide.covering).toBe(true)
    expect(wide.interval![1] - wide.interval![0]).toBeGreaterThan(40)
    expect(wide.interval![1]).toBeGreaterThanOrEqual(80)
    expect(synthetic.glance.headline.all.rows.find((r) => r.name === 'Top')!.interval).toEqual([80, 80])
  })

  it('the first sentence says the top is the only covering configuration not separable from its score, and names the too-variable one', () => {
    const sentence = synthetic.glance.headline.all.sentences[0]
    expect(sentence.startsWith('Top is the only covering configuration not separable from its score of 80.0, apart from the too-variable configurations named below ')).toBe(true)
    expect(sentence).not.toContain('whose interval reaches')
    expect(sentence).toMatch(/Too variable to rank: Wide, 75\.0, interval \d+\.\d to \d+\.\d\.$/)
  })
})

describe('round five, real board: the effort verdict does not contradict a separated pair, and an empty comparison says so', () => {
  it('Sonnet 5.5: the lowest-to-highest verdict speaks for that change only, because high and extra high separate', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-sonnet-5-5')!
    expect(effort.body).toContain('so this change is not established with 3 iterations per task')
    expect(effort.body).not.toContain('so differences are not established')
  })

  it('Haiku 5.5: no pair separates, so the general sentence stays', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-haiku-5-5')!
    expect(effort.body).toContain('so differences are not established with 3 iterations per task')
  })

  it('every sample clause on the board counts configurations, never models', () => {
    for (const scope of SCOPES) {
      for (const group of GROUPS) {
        for (const insight of board.insights[scope][group]) expect(insight.body).not.toMatch(/\d+ models? covering/)
      }
    }
  })

  it('a glance block with no covering row does not refer to rows above', () => {
    for (const scope of SCOPES) {
      for (const group of GROUPS) {
        const block = board.glance[scope][group]
        if (block.notCovering && block.rows.every((r) => !r.covering)) {
          expect(block.notCovering).not.toContain('rows above')
          expect(block.notCovering).toContain('nothing is compared')
        }
      }
    }
  })
})
