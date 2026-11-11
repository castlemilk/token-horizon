import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { checks, CHECK_LIST, CHECK_NAMES } from './checks'
import { goodArtifact, expectations, fixtures, replaceRegion, stripMarkers } from './fixtures'
import { GOOD_SOURCE } from './good-source'
import { HIDDEN_VERSION } from './hidden'
import { task } from './task'
import { pose } from './pose'

/**
 * The specification, pinned here rather than read from the design scratchpad, so that
 * these tests cannot skip when that file is gone. The prompt is pinned by its SHA-256.
 */
const SPEC_PROMPT_SHA256 = '18d99903cad1e973b1bee67ac1d6324c5c3bda4159fa4b3ae33c9a0b72ca30c3'
const SPEC_CHECKS: Array<[string, number]> = [
  ['orbit-contract-paused', 8],
  ['orbit-kepler-period', 10],
  ['orbit-energy-fourth-order', 12],
  ['orbit-symplectic-reversible', 12],
  ['orbit-momentum-com', 6],
  ['orbit-softening-reference', 8],
  ['orbit-diagnostics', 10],
  ['orbit-hud-numbers', 6],
  ['orbit-view-fit', 8],
  ['orbit-bodies-drawn', 12],
  ['orbit-trails-history', 8],
]

const budgets = CHECK_NAMES.map((n) => ({ name: n, points: (checks[n] as { maxPoints?: number }).maxPoints ?? -1 }))

describe('orbit-lab: unit', () => {
  it('declares the hidden version the run log records', () => {
    expect(HIDDEN_VERSION).toBe('orbit-lab/v2')
  })

  it('has eleven checks whose names and points sum to 100', () => {
    expect(CHECK_NAMES.length).toBe(11)
    expect(budgets.reduce((s, b) => s + b.points, 0)).toBe(100)
    expect(new Set(CHECK_NAMES).size).toBe(CHECK_NAMES.length)
  })

  it('matches the specification: names, order and points', () => {
    expect(budgets).toEqual(SPEC_CHECKS.map(([name, points]) => ({ name, points })))
  })

  it('the ordered export lists the same checks in the same order', () => {
    expect(CHECK_LIST.map((c) => c.checkName)).toEqual(CHECK_NAMES)
  })

  it('task.checks lists exactly the checks, in the same order', () => {
    expect(task.checks).toEqual(CHECK_NAMES)
    expect(task.id).toBe('orbit-lab')
    expect(task.slug).toBe('orbit-lab')
    expect(task.scorer).toBe('behavioral')
    expect(task.iterationsDefault).toBe(3)
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
    expect(task.sandboxConstraints).toBeUndefined()
  })

  it('the prompt is the specification prompt, pinned by SHA-256', () => {
    expect(createHash('sha256').update(task.prompt).digest('hex')).toBe(SPEC_PROMPT_SHA256)
  })

  it('the prompt contains none of the distinctive hidden values', () => {
    // Values that exist only in hidden.ts. The public tolerances and the eccentricities
    // 0.5 and 0.6 are stated in the prompt on purpose, so they are not listed here.
    const hidden = [
      '1.3', '-0.7', '0.83', '2.1', '0.15', '-0.42', '0.11', '9.1', '0.37', '2.6', '1.9',
      '3.2', '0.35', '1.7', '2.9', '-2.4', '-2.5', '2.4', '0.0025', '48000', '-5', '-0.16666667',
    ]
    const found = hidden.filter((v) => new RegExp('(^|[^0-9.])' + v.replace(/[.]/g, '\\.') + '($|[^0-9])').test(task.prompt))
    expect(found).toEqual([])
  })

  it('pose is a plain source string with no hidden constant', () => {
    expect(typeof pose).toBe('string')
    expect(pose.startsWith('(arg) => {')).toBe(true)
    for (const v of ['0.83', '9.1', '0.35', '-2.4', '48000']) expect(pose.includes(v)).toBe(false)
  })

  it('the good artifact has no region markers and is a complete document', () => {
    expect(goodArtifact).not.toMatch(/\/\*@(region|end):/)
    expect(goodArtifact.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(goodArtifact.trimEnd().endsWith('</html>')).toBe(true)
    expect(goodArtifact).not.toMatch(/\bfetch\(|<script src=|https?:\/\//)
  })

  it('has the reference good artifact and at least two conforming variants', () => {
    const good = fixtures.filter((f) => f.kind === 'good').map((f) => f.name)
    expect(good).toEqual(expect.arrayContaining(['orbit-good', 'orbit-good-contain-fit', 'orbit-good-scroll-layout']))
  })

  it('every fixture is named once, with an expectation, and the broken ones differ from the good one', () => {
    const names = fixtures.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    for (const f of fixtures) {
      expect(expectations[f.name], f.name).toBeDefined()
      expect(f.html, f.name).not.toMatch(/\/\*@(region|end):/)
      if (f.kind === 'broken') expect(f.html, f.name).not.toBe(goodArtifact)
    }
    expect(Object.keys(expectations).sort()).toEqual([...names].sort())
  })

  it('every expectation names only checks that exist', () => {
    for (const [fixture, exp] of Object.entries(expectations)) {
      if (typeof exp === 'string') continue
      for (const name of exp) expect(CHECK_NAMES, `${fixture} expects ${name}`).toContain(name)
    }
  })

  it('a mutation that does not change the text is refused', () => {
    const current = replaceRegion(GOOD_SOURCE, 'force-gravity', '1')
    expect(current).not.toBe(GOOD_SOURCE)
    expect(() => replaceRegion(GOOD_SOURCE, 'force-gravity', 'G')).toThrow(/does not change/)
    expect(() => replaceRegion(GOOD_SOURCE, 'no-such-region', '1')).toThrow(/exactly once/)
  })

  it('stripMarkers removes every marker and nothing else', () => {
    const stripped = stripMarkers(GOOD_SOURCE)
    expect(stripped).not.toMatch(/\/\*@(region|end):/)
    expect(stripped.length).toBeLessThan(GOOD_SOURCE.length)
  })
})

fixtureMatrix({
  taskId: 'orbit-lab',
  checks: CHECK_NAMES.map((n) => checks[n]),
  fixtures,
  expectations,
  checksModule: { url: new URL('./checks.ts', import.meta.url).href, exportName: 'CHECK_LIST' },
})
