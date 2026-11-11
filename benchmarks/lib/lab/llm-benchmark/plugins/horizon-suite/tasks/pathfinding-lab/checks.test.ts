import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { closeSandbox, runChecks } from '../../../../scorers/sandbox'
import { defineCheck } from '../../lib/check'
import { probe } from '../../lib/probe'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { checkList, checks } from './checks'
import { goodArtifact, brokenArtifacts, expectations, fixtures, staticFakeArtifact } from './fixtures'
import { HIDDEN_ANSWER_TOKENS, HIDDEN_VERSION, MAP_A_ROWS, SEEDED, TRAP_ROWS, TOL } from './hidden'
import { genMap, optimalCost } from './reference'
import { pose } from './pose'
import { PROMPT, SANDBOX_CONTRACT, task } from './task'
import { createHash } from 'node:crypto'

/**
 * Pins of the prompt and of the sandbox contract. They are checked every time, with or without the
 * specification file on disk, so a silent change to either text fails here. Changing a pin is a
 * deliberate act: the prompt is the specification, and the designers decide any change to it.
 */
const PROMPT_SHA256 = '2a3b765e056af56793ac4120d03e62111a7fd2067ab99c17c414329ca4be5cff'
const SANDBOX_SHA256 = '2e444e986ac96bcdcb9d96f730379137314c61da179993074ba9ba1dd92eb749'
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const SPEC_PATH = new URL('../../design/task-pathfinding-lab.json', import.meta.url)

/** The names and points the specification gives, in order. Used when the spec file is absent. */
const EXPECTED: Array<[string, number]> = [
  ['path-grid-render', 8],
  ['path-dijkstra', 12],
  ['path-astar-optimal', 12],
  ['path-astar-expansion', 10],
  ['path-bfs', 8],
  ['path-no-path-trivial', 10],
  ['path-diagonal-rules', 12],
  ['path-visual-sync', 12],
  ['path-edit-resolve', 8],
  ['path-stats-dom', 8],
]

function specFile(): { final_prompt: string; final_checks: Array<{ name: string; points: number }>; fixtures: Array<{ name: string }> } | null {
  if (!existsSync(SPEC_PATH)) return null
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'))
}

describe('pathfinding-lab: specification conformance', () => {
  it('has the check names and points of the specification, in order, summing to 100', () => {
    const spec = specFile()
    const want = spec ? spec.final_checks.map((c) => [c.name, c.points] as [string, number]) : EXPECTED
    expect(checkList.map((c) => [c.checkName, c.maxPoints])).toEqual(want)
    expect(want.reduce((sum, [, points]) => sum + points, 0)).toBe(100)
    expect(Object.keys(checks)).toEqual(want.map(([name]) => name))
  })

  it('declares each check with a rationale and a budget the wrapper can read', () => {
    for (const check of checkList) {
      expect(check.checkName).toBeTruthy()
      expect(check.maxPoints).toBeGreaterThan(0)
      expect((check as { rationale?: string }).rationale?.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('lists the same check names on the task row', () => {
    expect(task.checks).toEqual(checkList.map((c) => c.checkName))
    expect(task.id).toBe('pathfinding-lab')
    expect(task.slug).toBe('pathfinding-lab')
    expect(task.scorer).toBe('behavioral')
    expect(task.iterationsDefault).toBe(3)
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
    expect(task.category).toBe('advanced-game-building')
  })

  it('uses the hygiene-only sandbox contract: eight lines of the global text plus the sentence', () => {
    const lines = SANDBOX_CONTRACT.split('\n')
    expect(lines.length).toBe(9)
    expect(lines[0]!.startsWith('EXECUTION ENVIRONMENT')).toBe(true)
    expect(lines[7]!.startsWith('- Wrap your top-level script body')).toBe(true)
    expect(lines[8]!.startsWith('Set html,body{margin:0;min-height:100%}')).toBe(true)
    // The canvas, resize and requestAnimationFrame guidance belongs to the LAYOUT section, which is not copied.
    expect(SANDBOX_CONTRACT).not.toMatch(/^LAYOUT|requestAnimationFrame|window 'resize'/m)
    expect(task.sandboxConstraints).toBe(SANDBOX_CONTRACT)
  })

  it('pins the prompt and the sandbox contract by sha256, whether or not the spec file exists', () => {
    expect(sha256(PROMPT)).toBe(PROMPT_SHA256)
    expect(sha256(SANDBOX_CONTRACT)).toBe(SANDBOX_SHA256)
  })

  it('makes the prompt the specification final_prompt, verbatim, when the spec file exists', () => {
    const spec = specFile()
    if (spec === null) return
    expect(PROMPT).toBe(spec.final_prompt)
    expect(task.prompt).toBe(spec.final_prompt)
  })

  it('has one fixture for each broken variant the specification names, plus the good and the static fake', () => {
    const spec = specFile()
    const names = fixtures.map((f) => f.name)
    if (spec !== null) {
      // Every fixture the specification names appears, in its order. Fixtures added since then may sit between them.
      const specNames = spec.fixtures.map((f) => f.name)
      let at = 0
      for (const name of names) if (name === specNames[at]) at++
      expect(at, 'specification fixtures present in order').toBe(specNames.length)
    }
    expect(names[0]).toBe('path-good')
    expect(names[names.length - 1]).toBe('path-control-static-fake')
    expect(Object.keys(expectations).sort()).toEqual([...names].sort())
  })
})

describe('pathfinding-lab: hidden inputs stay hidden', () => {
  it('the prompt contains no hidden map rows and no hidden answer', () => {
    const forbidden: string[] = []
    for (const row of TRAP_ROWS) if (row.length >= 9) forbidden.push(row)
    for (const row of MAP_A_ROWS) if (row.length >= 9) forbidden.push(row)
    for (const spec of Object.values(SEEDED)) {
      const map = genMap(spec)
      for (const row of map.rows) if (row.length >= 9) forbidden.push(row)
    }
    for (const row of forbidden) expect(PROMPT.includes(row), `prompt contains hidden row ${row}`).toBe(false)
    for (const token of HIDDEN_ANSWER_TOKENS) {
      expect(PROMPT.includes(token), `prompt contains hidden answer ${token}`).toBe(false)
    }
    expect(HIDDEN_VERSION).toBe('pathfinding-lab/v2')
  })

  it('the prompt contains no seed number that could be read as a map key', () => {
    for (const spec of Object.values(SEEDED)) {
      expect(PROMPT).not.toMatch(new RegExp(`\\bseed ${spec.seed}\\b`))
    }
  })

  it('the hidden maps really have the properties the checks rely on', () => {
    expect(optimalCost(genMap(SEEDED.dijkstra8))).toBe(39.5)
    expect(optimalCost(genMap(SEEDED.stats501))).toBe(15.5)
    expect(TOL.minCellPx).toBe(8)
  })
})

describe('pathfinding-lab: fixtures are mutations of the good artifact', () => {
  it('every broken variant differs from the good artifact', () => {
    for (const fixture of brokenArtifacts) {
      expect(fixture.html, fixture.name).not.toBe(goodArtifact)
      expect(fixture.html.length, fixture.name).toBeGreaterThan(goodArtifact.length - 400)
    }
  })

  it('the static fake has every control id the prompt names', () => {
    for (const id of ['grid', 'algo', 'run', 'diagonals', 'play', 'scrub', 'stat-cost', 'stat-moves', 'stat-expanded', 'status']) {
      expect(staticFakeArtifact.includes(`id="${id}"`), id).toBe(true)
    }
  })

  it('the good artifact names every id, data attribute and function the prompt requires', () => {
    for (const id of ['grid', 'algo', 'run', 'diagonals', 'play', 'scrub', 'stat-cost', 'stat-moves', 'stat-expanded', 'status']) {
      expect(goodArtifact.includes(`id="${id}"`), id).toBe(true)
    }
    for (const attr of ['data-r', 'data-c', 'data-terrain', 'data-role', 'data-visited', 'data-path', 'data-state']) {
      expect(goodArtifact.includes(attr), attr).toBe(true)
    }
    expect(goodArtifact).toContain('window.__bench')
    expect(goodArtifact).toContain('loadGrid')
    expect(goodArtifact).toContain('solve')
    expect(goodArtifact).toContain('last: function')
    expect(goodArtifact).not.toMatch(/<<|>>/)
  })

  it('the pose is a plain function string that names only public inputs', () => {
    expect(pose.startsWith('() => {')).toBe(true)
    expect(pose).toContain('"astar"')
    expect(pose).not.toMatch(/seed|hidden/i)
  })
})

// The grader's own record of how long the full batch takes on the good artifact.
const batchMs = { value: 0 }

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('pathfinding-lab: browser checks', () => {
  afterAll(closeSandbox)

  it('scores the good artifact 100 for the right reasons, inside the time budget', async () => {
    const started = Date.now()
    const rows = await runChecks(goodArtifact, checkList, { settleMs: 600 })
    batchMs.value = Date.now() - started
    const failed = rows.filter((r) => !r.passed).map((r) => `${r.name}: ${r.detail ?? ''}`)
    expect(failed).toEqual([])
    expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(100)
    expect(batchMs.value).toBeLessThan(15_000)
  }, 60_000)

  it('the pose drives the artifact to the 20 x 32 A* scenario through the public contract', async () => {
    const poseCheck = defineCheck('pose-public-scenario', 1, 'The gallery pose solves the demo map with A*.', async (ctx) => {
      const result = await probe<{ found: boolean; cost: number | null; order: unknown[] }>(ctx.page, pose, undefined, 3000)
      const last = await probe<{ algorithm: string; found: boolean }>(ctx.page, '() => window.__bench.last()', undefined, 3000)
      const grid = await probe<number>(ctx.page, "() => document.querySelectorAll('#grid [data-r][data-c]').length", undefined, 3000)
      return {
        passed: result.found === true && last.algorithm === 'astar' && grid === 640 && result.cost !== null,
        detail: `found ${String(result.found)}, cost ${String(result.cost)}, grid ${String(grid)}`,
      }
    })
    const rows = await runChecks(goodArtifact, [poseCheck], { settleMs: 600 })
    expect(rows[0]!.passed, rows[0]!.detail).toBe(true)
  }, 30_000)

  fixtureMatrix({
    taskId: 'pathfinding-lab',
    checks: checkList,
    fixtures: fixtures.map((f) => ({ name: f.name, html: f.html })),
    expectations,
  })
})
