import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import * as registry from '../llm-benchmark/registry'
import { OUTPUT_CAP_TOKENS, buildBoard, fmt1, type Board, type BuildInput, type GlanceBlock, type GlanceRow } from './board'

// Review round three: the glance sentences, the value pick, the sample clauses, the check finding, the rounding and the
// findings' wording, checked against results.json (read only) and against small hand-built worlds.

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
const SCOPES = ['headline', 'horizon'] as const
const GROUPS = ['claude', 'all'] as const

/** The configurations a glance block treats as not separable from the top: covering, reaching the top, and not too wide. */
function notSeparable(rows: GlanceRow[]): GlanceRow[] {
  const covering = rows.filter((r) => r.covering)
  const top = Math.max(...covering.map((r) => r.score))
  return covering.filter((r) => Math.abs(r.score - top) < 1e-6 || (r.interval !== null && r.interval[1] >= top - 1e-6 && r.interval[1] - r.interval[0] <= 40))
}

describe('glance, real board: the sample clauses state the covering sample and its count', () => {
  for (const scope of SCOPES) {
    for (const group of GROUPS) {
      it(`${scope} / ${group}: sentences 1 and 2 count the covering rows of the table, and sentence 3 counts the not-separable set`, () => {
        const block: GlanceBlock = board.glance[scope][group]
        const covering = block.rows.filter((r) => r.covering).length
        expect(covering).toBeGreaterThan(0)
        expect(block.sentences[0]).toContain(`(of ${covering} configurations covering at least 80% of the ${scope} tasks, `)
        expect(block.sentences[1]).toContain(`(of ${covering} configurations covering at least 80% of the ${scope} tasks, `)
        const k = notSeparable(block.rows).length
        expect(block.sentences[2]).toMatch(new RegExp(`among the ${k} configurations? not separable from the top \\(\\d+ requested iterations?\\)\\.$`))
      })
    }
  }
})

describe('glance, real board: the value pick is never a too-variable configuration and no cheaper one is in the not-separable set', () => {
  for (const scope of SCOPES) {
    for (const group of GROUPS) {
      it(`${scope} / ${group}`, () => {
        const block = board.glance[scope][group]
        const sentence = block.sentences[1]
        const picked = sentence.match(/^Cheapest configuration not separable from the top: (.+?), \$/)![1]
        const pick = block.rows.find((r) => r.name === picked)!
        expect(pick).toBeDefined()
        for (const r of notSeparable(block.rows)) {
          expect(r.costPerAttempt!).toBeGreaterThanOrEqual(pick.costPerAttempt! - 1e-12)
        }
      })
    }
  }

  it('Horizon, claude: the pick is Sonnet 5.5 (low effort), and Haiku 5.5 (extra high effort) is named as too variable, not picked', () => {
    const block = board.glance.horizon.claude
    expect(block.sentences[1]).toContain('Cheapest configuration not separable from the top: Claude Sonnet 5.5 (low effort), $0.0682 per attempt, 0.13 times the cost of Claude Sonnet 5.5 (extra high effort) at $0.509, the most expensive configuration at the top value')
    expect(block.sentences[0]).toContain('Too variable to rank: Claude Haiku 5.5 (extra high effort), 77.2, interval 44.4 to 100.0.')
    expect(block.sentences[1]).not.toContain('Haiku')
    expect(block.sentences[0].startsWith('Not separable from the top, 100.0 (each 95% interval reaches 100.0, or the configuration scores it):')).toBe(true)
  })
})

describe('check, real board: the Headline result pools the covering configurations only', () => {
  it('bike-painted at 5 of 12 (41.7%) over the four covering configurations, not the lower 66.7% of the non-covering pool', () => {
    const check = board.insights.headline.all.find((i) => i.id === 'check')!
    expect(check.figure).toBe('41.7')
    expect(check.body).toMatch(/^The lowest check pass rate is bike-painted \(Bicycle Blueprint\), passed in 41\.7% of 12 runs\. Named check rows were recorded for every one of the 40 cells in that sample \(pooled over 4 configurations covering at least 80% of the headline tasks; 12 of \d+ completed iterations in those cells recorded this check\)\./)
  })
})

describe('effort, real board: every level is evaluated, the figure is the lowest to highest level, and the zero-width ceiling is named', () => {
  it('Sonnet 5.5: high and extra high do not overlap only against the zero-width ceiling at 100.0, and the figure is 93.9 to 100.0', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-sonnet-5-5')!
    expect(effort.figure).toBe('93.9 to 100.0')
    expect(effort.body).toContain('Extra high effort scored 100.0 on all 18 requested iterations, and high effort\'s interval [82.9 to 99.5] does not reach it, so under the page\'s top rule high effort is separable from extra high effort. The gap cannot be measured against a zero-width interval at the ceiling.')
    expect(effort.figureUnit).toBe('pts')
    expect(effort.body).toContain('The change from low to extra high effort, +2.3 points, is not established: the 95% intervals overlap')
  })

  it('Haiku 5.5: its completed iterations average over the five tasks that completed, and the figure runs lowest to highest', () => {
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-haiku-5-5')!
    expect(effort.figure).toBe('77.2 to 93.5')
    expect(effort.body).toContain('Extra high effort: 4 of 18 requested iterations hit the 128,000-token output cap and count as zero; its completed iterations averaged 99.3 per task, over the 5 tasks with a completed iteration, so the truncated iterations account for the whole gap between its score and that average.')
  })

  it('Opus 5.5 (medium effort) scores 96.1 everywhere it is printed, not 96.0', () => {
    const block = board.glance.horizon.claude
    expect(block.sentences[0]).toContain('Claude Opus 5.5 (medium effort) (96.1)')
    const opus = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-opus-5-5')!
    expect(opus.body).toContain('medium 96.1 [85.4 to 100.0]')
    for (const i of board.insights.horizon.claude) expect(i.body).not.toContain('96.0 ')
  })
})

describe('the shared one-decimal formatter rounds half up, with an epsilon for binary noise', () => {
  it('96.05 stored as 96.0499999 prints 96.1', () => {
    expect(fmt1(96.04999999999)).toBe('96.1')
    expect(fmt1((100 + 100 + 100 + 98 + 78.3 + 100) / 6)).toBe('96.1')
  })

  it('ordinary values round as expected, and 100 keeps its trailing zero', () => {
    expect(fmt1(99.27)).toBe('99.3')
    expect(fmt1(77.17)).toBe('77.2')
    expect(fmt1(100)).toBe('100.0')
    expect(fmt1(0)).toBe('0.0')
  })
})

describe('headline ceiling and spread, real board: the configurations at 100.0 are named and the spread says 100.0 where it is true', () => {
  it('the callout names Gateway Console and Car Racer, where every covering configuration scored 100.0', () => {
    const callout = board.guides.headline.claude.callout
    expect(callout.some((s) => s.includes('Gateway Console and Car Racer, where every covering configuration scored 100.0'))).toBe(true)
    expect(callout.some((s) => s.includes('Orbit Lab: conservation laws under instrumentation, where every configuration in view scored 100.0'))).toBe(true)
  })

  it('the spread finding says 100.0 for the tasks every covered configuration scored 100.0 on, and 95 or more for the rest', () => {
    const spread = board.insights.headline.claude.find((i) => i.id === 'spread')!
    expect(spread.body).toContain('Every covered configuration that ran Gateway Console, Car Racer and Orbit Lab: conservation laws under instrumentation scored 100.0.')
    expect(spread.body).toContain('Every covered configuration that ran RLC Response Lab: analytic Bode and step response at hidden values and Bicycle Blueprint scored 95 or more (4 configurations covering at least 80% of the headline tasks, 120 requested iterations).')
  })

  it('the frontier finding names Sonnet 5.5 (high effort) as dominated, with its score and interval, and says membership compares point scores', () => {
    const frontier = board.insights.headline.claude.find((i) => i.id === 'frontier')!
    expect(frontier.body).toContain('Dominated, so off the frontier (another configuration costs no more and scores no less): Claude Sonnet 5.5 (high effort) (89.5, interval [78.1 to 98.2]) is dominated by Claude Haiku 5.5 (medium effort) (92.1, interval [82.4 to 99.0]).')
    expect(frontier.body).toContain('Membership compares point scores: differences inside the intervals are not established (4 configurations covering at least 80% of the headline tasks, 120 requested iterations).')
  })
})

describe('findings wording, real board', () => {
  it('the answer names the value pick once: no repeated "within 5 points" clause', () => {
    const answer = board.guides.horizon.claude.answer
    const value = answer.find((s) => s.startsWith('Cheapest within 5 points of the top: '))!
    expect(value).toMatch(/^Cheapest within 5 points of the top: Claude Sonnet 5\.5 \(low effort\) at \$0\.0682 per attempt, scoring 97\.7 \[\d+\.\d to \d+\.\d\]\.$/)
  })

  it('the top finding says "its 95% interval" for one close configuration, and "their" for more', () => {
    const top = board.insights.headline.claude.find((i) => i.id === 'top')!
    expect(top.body).toContain('Not separable from the top: its 95% interval reaches 99.7, so the difference is not established: Claude Opus 5.5 (medium effort) (97.6, interval [91.1 to 100.0]) (4 configurations covering at least 80% of the headline tasks, 120 requested iterations).')
    const horizonTop = board.insights.horizon.claude.find((i) => i.id === 'top')!
    expect(horizonTop.body).toContain('Not separable from the top: their 95% intervals reach 100.0')
  })

  it('the callout reads "This task" when one task does not separate the configurations (Horizon has one such task)', () => {
    const horizon = board.guides.horizon.claude.callout
    expect(horizon).toContain('This task does not separate the configurations: Orbit Lab: conservation laws under instrumentation, where every configuration in view scored 100.0.')
  })

  it('the output cap is stated from the board definition in every truncation sentence', () => {
    expect(board.definitions.outputCapTokens).toBe(OUTPUT_CAP_TOKENS)
    const effort = board.insights.horizon.claude.find((i) => i.id === 'effort-claude-haiku-5-5')!
    expect(effort.body).toContain(`hit the ${OUTPUT_CAP_TOKENS.toLocaleString('en-US')}-token output cap`)
  })
})

// ── Hand-built worlds for the wording rules the real board does not hit ────────────────────────

const CATEGORIES: BenchmarkCategory[] = [{ slug: 'advanced-game-building', label: 'Advanced Game Building', glyph: '◆', accent: '#000', blurb: '' }]

function task(id: string): BenchmarkTask {
  return {
    id, category: 'advanced-game-building', title: `Task ${id}`, blurb: '', prompt: '', runtimeHint: '', iterationsDefault: 3,
    methodNotes: '', demoComponentName: '', slug: id, scorer: 'behavioral', pluginId: 'community-tasks',
  }
}

function model(id: string, name: string, over: Partial<BenchmarkModel> = {}): BenchmarkModel {
  return { id, name, provider: 'Anthropic', costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002, contextWindow: 1000, capabilities: '', company: 'Anthropic', ...over }
}

function rec(over: Partial<BenchmarkResult> & { taskId: string; modelId: string; values: number[] }): BenchmarkResult {
  const { values, ...rest } = over
  return {
    score: values.reduce((a, b) => a + b, 0) / values.length, runtimeMs: 1000, tokensIn: 100, tokensOut: 200, costUsd: 0, iterations: 3,
    iterationScores: values, iterationsSucceeded: values.length, status: values.length === 3 ? 'success' : 'partial',
    createdAt: '2026-11-11T00:00:00.000Z', source: 'live', scorerVersion: 2, ...rest,
  }
}

function world(results: BenchmarkResult[], models: BenchmarkModel[], tasks: BenchmarkTask[]): BuildInput {
  return { results, models, tasks, categories: CATEGORIES, now: NOW, resultsSha256: 'x' }
}

describe('a single task and a single close configuration are written in the singular', () => {
  it('one ceiling task: "This task does not separate" and "its 95% interval"', () => {
    const tasks = [task('t1'), task('t2')]
    const models = [model('a', 'Alpha'), model('b', 'Beta')]
    const results = [
      rec({ taskId: 't1', modelId: 'a', values: [100, 100, 100], costUsd: 1 }),
      rec({ taskId: 't1', modelId: 'b', values: [100, 100, 100], costUsd: 1 }),
      rec({ taskId: 't2', modelId: 'a', values: [100, 100, 100], costUsd: 1 }),
      rec({ taskId: 't2', modelId: 'b', values: [50, 50, 50], costUsd: 1 }),
    ]
    const b = buildBoard(world(results, models, tasks))
    expect(b.guides.headline.all.callout.some((s) => s.startsWith('This task does not separate the configurations: Task t1, where every configuration in view scored 100.0.'))).toBe(true)
  })
})

describe('the not-covering sub-heading names the tasks of the earlier runs without repeating "all"', () => {
  it('earlier scope: "Ran fewer than 80% of the N tasks"', () => {
    const tasks = [task('t1'), task('t2'), task('t3')]
    const models = [model('full', 'Full'), model('partial', 'Partial')]
    const results = [
      ...tasks.map((t) => rec({ taskId: t.id, modelId: 'full', values: [100, 100, 100], scorerVersion: 1 })),
      rec({ taskId: 't1', modelId: 'partial', values: [100, 100, 100], scorerVersion: 1 }),
    ]
    const b = buildBoard(world(results, models, tasks))
    const notCovering = b.glance.earlier.all.notCovering
    expect(notCovering).not.toBeNull()
    expect(notCovering).toContain('Ran fewer than 80% of the 3 tasks: 1 configuration ran at most 1 of 3 tasks.')
    expect(notCovering).not.toContain('all tasks')
  })
})

describe('the page formats one decimal the way the board does: one formatter, half up', () => {
  const pageJs = readFileSync(fileURLToPath(new URL('../../../report/template/report.js', import.meta.url)), 'utf8')
  const definition = pageJs.match(/function oneDp\(v\) \{[^\n]*\}/)![0]
  const oneDp = new Function(`${definition}; return oneDp`)() as (v: number) => string

  it('every one-decimal figure goes through oneDp: the only toFixed(1) in the page is its definition', () => {
    expect(pageJs.replace(definition, '')).not.toContain('.toFixed(1)')
  })

  it('oneDp prints exactly what fmt1 prints, over a grid of scores, including the half that binary noise rounds down', () => {
    expect(oneDp(96.04999999999)).toBe('96.1')
    for (let k = 0; k <= 20000; k++) {
      const x = k / 200
      expect(oneDp(x)).toBe(fmt1(x))
    }
  })
})
