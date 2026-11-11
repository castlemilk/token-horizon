import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { checks } from './checks'
import { brokenArtifacts, cheatVariants, expectations, fixtures, goodArtifact, goodVariants, replaceRegion, staticDefaultFake } from './fixtures'
import { HIDDEN_P1, HIDDEN_P2, HIDDEN_P3, HIDDEN_VERSION, ROTATION_CASES, READOUT_CASES, CRANK_ANGLES, DRIVETRAIN_CASES, CHAIN_CASES, SPOKE_COUNTS, FIT_EXTREMES, PAINT_CRANK_DEG } from './hidden'
import { pose } from './pose'
import { task, CHECK_NAMES } from './task'
import { PARAM_RANGES, PUBLIC_DEFAULTS, validParams } from './reference'

const SPEC_PATH = new URL('../../design/task-bicycle-blueprint.json', import.meta.url)

interface SpecCheck {
  name: string
  points: number
}

function readSpec(): { final_prompt: string; final_checks: SpecCheck[] } | undefined {
  if (!existsSync(SPEC_PATH)) return undefined
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as { final_prompt: string; final_checks: SpecCheck[] }
}

const spec = readSpec()

describe('bicycle blueprint: checks and budgets', () => {
  it('declares the specified names and points, in order, summing to 100', () => {
    const declared = Object.values(checks)
    expect(declared.map((c) => c.checkName)).toEqual(Object.keys(checks))
    expect(Object.keys(checks)).toEqual([...CHECK_NAMES])
    expect(declared.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0)).toBe(100)
    if (spec !== undefined) {
      expect(declared.map((c) => ({ name: c.checkName, points: c.maxPoints }))).toEqual(
        spec.final_checks.map((c) => ({ name: c.name, points: c.points })),
      )
    }
  })

  it('lists the same check names in the task row', () => {
    expect(task.checks).toEqual([...CHECK_NAMES])
    expect(task.scorer).toBe('behavioral')
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
    expect(task.iterationsDefault).toBe(3)
  })

  it('keeps the hidden version string', () => {
    expect(HIDDEN_VERSION).toBe('bicycle-blueprint/v2')
  })
})

describe('bicycle blueprint: prompt', () => {
  it('equals the specification final_prompt character for character when the spec file exists', () => {
    if (spec === undefined) return
    expect(task.prompt).toBe(spec.final_prompt)
  })

  it('contains none of the hidden answer values that the public text does not already state', () => {
    // Values a model could copy as answers. Public defaults and the stated ranges are allowed.
    const publicNumbers = new Set<number>([
      ...Object.values(PUBLIC_DEFAULTS),
      ...Object.values(PARAM_RANGES).flatMap((r) => [r.lo, r.hi]),
      35,
      90,
      180,
      270,
      360,
      560,
      720,
      1024,
      120,
      150,
      80,
      20,
      12,
      14,
      2,
      3,
      4,
      5,
      6,
      8,
      10,
      15,
      40,
      0,
      1,
      1.5,
      2.5,
      100,
      1000,
      1.2,
      0.5,
      0.1,
      0.01,
    ])
    const hiddenValues = new Set<number>()
    for (const set of [HIDDEN_P1, HIDDEN_P2, HIDDEN_P3]) for (const v of Object.values(set)) hiddenValues.add(v as number)
    for (const c of DRIVETRAIN_CASES) {
      hiddenValues.add(c.chainring)
      hiddenValues.add(c.sprocket)
    }
    for (const c of CHAIN_CASES) {
      hiddenValues.add(c.chainring)
      hiddenValues.add(c.sprocket)
      if (c.chainstay !== undefined) hiddenValues.add(c.chainstay)
    }
    for (const c of ROTATION_CASES) hiddenValues.add(c.theta)
    for (const c of READOUT_CASES) hiddenValues.add(c.theta)
    for (const t of CRANK_ANGLES) hiddenValues.add(t)
    for (const n of SPOKE_COUNTS) hiddenValues.add(n)
    for (const f of FIT_EXTREMES) for (const v of Object.values(f)) hiddenValues.add(v as number)
    hiddenValues.add(PAINT_CRANK_DEG)
    const promptNumbers = new Set((task.prompt.match(/\d+(?:\.\d+)?/g) ?? []).map(Number))
    const leaked = [...hiddenValues].filter((v) => promptNumbers.has(v) && !publicNumbers.has(v))
    expect(leaked, `hidden values that appear in the prompt: ${leaked.join(', ')}`).toEqual([])
  })

  it('states the public defaults and crank angle that the load draws', () => {
    expect(validParams(PUBLIC_DEFAULTS)).toBe(true)
    expect(task.prompt).toContain('setParams({wheelRadius:340')
    expect(task.prompt).toContain('setCrank(35)')
  })

  it('appends a hygiene-only sandbox contract with the suite sentence', () => {
    expect(task.sandboxConstraints).toContain('EXECUTION ENVIRONMENT')
    expect(task.sandboxConstraints).toContain('Output only the HTML document.')
    expect(task.sandboxConstraints).not.toContain('LAYOUT')
    expect(task.sandboxConstraints).not.toContain('QUALITY BAR')
  })
})

describe('bicycle blueprint: pose and fixtures', () => {
  it('pose is a plain source string with only the public defaults', () => {
    expect(typeof pose).toBe('string')
    expect(pose.startsWith('() =>')).toBe(true)
    for (const hidden of ['311', '1085', '268', '742', '372', '980', '74.5', '77']) {
      expect(pose.includes(hidden), `pose contains ${hidden}`).toBe(false)
    }
  })

  it('every broken fixture differs from the good artifact and the mutation regions are unique', () => {
    expect(brokenArtifacts.length).toBe(12)
    for (const b of brokenArtifacts) expect(b.html).not.toBe(goodArtifact)
    expect(() => replaceRegion(goodArtifact, 'no-such-region', 'x')).toThrow()
    expect(() => replaceRegion(goodArtifact, 'ground', '-R')).toThrow()
  })

  it('has a good artifact, good variants, cheats and a static control, each with an expectation', () => {
    expect(goodVariants.length).toBeGreaterThanOrEqual(5)
    expect(cheatVariants.length).toBeGreaterThanOrEqual(14)
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length)
    expect(Object.keys(expectations).sort()).toEqual(fixtures.map((f) => f.name).sort())
  })

  it('the static fake has no test hooks and no script', () => {
    expect(staticDefaultFake.includes('__bench')).toBe(false)
    expect(staticDefaultFake.includes('<script')).toBe(false)
  })
})

fixtureMatrix({
  taskId: 'bicycle-blueprint',
  checks: Object.values(checks),
  fixtures,
  expectations,
  checksModule: { url: new URL('./checks.ts', import.meta.url).href, exportName: 'checkList' },
})
