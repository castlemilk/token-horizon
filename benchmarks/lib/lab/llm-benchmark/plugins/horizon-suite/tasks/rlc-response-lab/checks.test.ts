import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SANDBOX_CONSTRAINTS } from '../../../../prompts'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { checks, checkList, checkNames } from './checks'
import * as hidden from './hidden'
import { HIDDEN_VERSION } from './hidden'
import { brokenArtifacts, expectations, fixtures, goodArtifact, replaceRegion, staticFake } from './fixtures'
import { pose } from './pose'
import { rlcPrompt, task } from './task'

/**
 * The specification pins. The prompt is identified by the sha256 of its
 * final_prompt field in task-rlc-response-lab.json, and the checks by their names
 * and points, so both assertions run on every machine: they do not depend on the
 * design scratchpad still existing.
 */
const PROMPT_SHA256 = 'c112d93114cf73d504df35669283641ac68a45ac4fdf2572cb83f498ddd402a2'
const SPEC_CHECKS: Array<{ name: string; points: number }> = [
  { name: 'rlc-metrics', points: 10 },
  { name: 'rlc-peak-overshoot', points: 8 },
  { name: 'rlc-response', points: 14 },
  { name: 'rlc-step-underdamped', points: 10 },
  { name: 'rlc-step-critical-overdamped', points: 12 },
  { name: 'rlc-bode-curve', points: 14 },
  { name: 'rlc-bode-autorange', points: 8 },
  { name: 'rlc-peak-resolved', points: 8 },
  { name: 'rlc-step-plot', points: 8 },
  { name: 'rlc-readouts', points: 8 },
]

describe('task row', () => {
  it('prompt is the specification prompt (pinned sha256)', () => {
    expect(createHash('sha256').update(rlcPrompt, 'utf8').digest('hex')).toBe(PROMPT_SHA256)
    expect(task.prompt).toBe(rlcPrompt)
  })

  it('check names and points match the specification in order and sum to 100', () => {
    expect(checkNames).toEqual(SPEC_CHECKS.map((c) => c.name))
    const points = checkNames.map((name) => checks[name]?.maxPoints)
    expect(points).toEqual(SPEC_CHECKS.map((c) => c.points))
    expect(points.reduce((sum, p) => sum! + (p ?? 0), 0)).toBe(100)
    expect(checkList.map((c) => c.checkName)).toEqual(checkNames)
  })

  it('every check is declared under its own name with its own budget', () => {
    for (const name of checkNames) {
      expect(checks[name]?.checkName).toBe(name)
      expect(checks[name]?.maxPoints ?? 0).toBeGreaterThan(0)
    }
    expect(Object.keys(checks)).toEqual(checkNames)
  })

  it('the task row lists the check names in the same order as checks.ts', () => {
    expect(task.checks).toEqual(checkNames)
    expect(task.id).toBe('rlc-response-lab')
    expect(task.slug).toBe('rlc-response-lab')
    expect(task.category).toBe('advanced-electronics')
    expect(task.scorer).toBe('behavioral')
    expect(task.iterationsDefault).toBe(3)
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
  })

  it('sandboxConstraints are the eight hygiene lines of the global contract plus the task sentence', () => {
    const globalLines = SANDBOX_CONSTRAINTS.split('\n').filter((line) => line.length > 0)
    const hygiene = globalLines.slice(0, 8)
    const expected = [...hygiene, 'Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.'].join('\n')
    expect(task.sandboxConstraints).toBe(expected)
    expect(hygiene[0]!.startsWith('EXECUTION ENVIRONMENT')).toBe(true)
    expect(hygiene[7]!.startsWith('- Wrap your top-level script body in try/catch')).toBe(true)
  })

  it('methodNotes names no hidden circuit and no hidden tolerance', () => {
    expect(task.methodNotes).not.toMatch(/R = 1 ohm/)
    expect(task.methodNotes).not.toMatch(/0\.5 dB/)
  })

  it('the pose and hidden version are present', () => {
    expect(HIDDEN_VERSION).toBe('rlc-response-lab/v2')
    expect(pose).toContain('__bench.set')
  })
})

describe('the prompt gives no answers away', () => {
  /**
   * Every number the hidden circuits, sweeps and cases use, read from hidden.ts
   * itself, written the ways a prompt would write it (shortest decimal and
   * exponent form). A form is matched with digit and dot boundaries so that
   * "0.1592" does not count as "0.1".
   */
  const CIRCUIT_EXPORTS = [
    'SET',
    'METRIC_SETS',
    'PEAK_ZETAS',
    'PEAK_L',
    'PEAK_C',
    'RESPONSE_MULTIPLES',
    'STEP_UNDER_MULTIPLES',
    'STEP_CRIT_MULTIPLES',
    'BODE_CURVE_CASES',
    'AUTORANGE_SETS',
    'PEAK_RESOLVED_LC',
    'STEP_PLOT_SETS',
    'READOUT_SETS',
    'STEP_UNDER_SETS',
    'STEP_CRIT_SETS',
  ] as const
  /**
   * Spellings the prompt itself uses as tolerances ("compared to about 1e-6",
   * "within 1e-7 of 1"). The hidden capacitances 1e-6 and 1e-7 cannot be told
   * apart by text; every set that uses them is still caught by its other values.
   */
  const PUBLIC_TOLERANCE_SPELLINGS = new Set(['1e-6', '1e-7'])

  function numbersIn(value: unknown, out: number[]): void {
    if (typeof value === 'number') out.push(value)
    else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out))
    else if (value !== null && typeof value === 'object') Object.values(value).forEach((v) => numbersIn(v, out))
  }

  function hiddenForms(): string[] {
    const numbers: number[] = []
    for (const key of CIRCUIT_EXPORTS) numbersIn((hidden as unknown as Record<string, unknown>)[key], numbers)
    const forms = new Set<string>()
    for (const n of numbers) {
      forms.add(String(n))
      forms.add(n.toExponential())
    }
    // Forms of one or two characters (1, 2, 10) are too short to match reliably; they are
    // circuit values of the hidden sets too, but the prompt's own digits would match them.
    return [...forms].filter((f) => f.length >= 3 && !PUBLIC_TOLERANCE_SPELLINGS.has(f))
  }

  it('the hidden forms are derived from hidden.ts and are not empty', () => {
    expect(hiddenForms().length).toBeGreaterThan(40)
    expect(hiddenForms()).toContain('3.3e-7')
    expect(hiddenForms()).toContain('2530')
  })

  it('the prompt contains none of the hidden circuit or readout values', () => {
    const leaked = hiddenForms().filter((literal) => {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(rlcPrompt)
    })
    expect(leaked, `hidden values in the prompt (${HIDDEN_VERSION})`).toEqual([])
  })

  it('the pose is not a hidden input: it uses the public showcase values and no hidden literal', () => {
    expect(pose).toContain('R: 4.6')
    expect(pose).toContain('L: 0.0047')
    expect(pose).toContain('C: 22e-9')
    for (const literal of ['2530', '0.022', '3.3e-7', '1.5e-4', '3.9e-9', '4.7e-6', '6.8e-7', '2.2e-8', '2.53318', '200.00002', '199.99998', '200.0000001']) {
      expect(pose.includes(literal), literal).toBe(false)
    }
  })
})

describe('mutations', () => {
  it('every broken variant is a different artifact from the good one', () => {
    for (const broken of brokenArtifacts) {
      expect(broken.html, broken.name).not.toBe(goodArtifact.html)
    }
    expect(staticFake.html).not.toBe(goodArtifact.html)
  })

  it('replaceRegion refuses a replacement that does not change the region', () => {
    const inner = 'if (zeta < 1 - 1e-9) return \'underdamped\'; if (zeta > 1 + 1e-9) return \'overdamped\'; return \'critical\';'
    expect(() => replaceRegion(goodArtifact.html, 'regime', inner)).toThrow(/does not change/)
  })

  it('replaceRegion refuses a missing marker', () => {
    expect(() => replaceRegion(goodArtifact.html, 'no-such-region', 'x')).toThrow(/missing or not unique/)
  })

  it('every expectation names a fixture and every fixture has one', () => {
    const names = fixtures.map((f) => f.name)
    expect(Object.keys(expectations).sort()).toEqual([...names].sort())
  })

  it('every expected failing check is a real check of this task', () => {
    for (const [fixture, expectation] of Object.entries(expectations)) {
      if (Array.isArray(expectation)) {
        for (const name of expectation) expect(checkNames, `${fixture} names ${name}`).toContain(name)
      }
    }
  })
})

describe('browser-gated fixture matrix', () => {
  fixtureMatrix({
    taskId: 'rlc-response-lab',
    checks: checkList,
    fixtures,
    expectations,
    checksModule: { url: new URL('./checks.ts', import.meta.url).href, exportName: 'checkList' },
  })
})
