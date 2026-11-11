/**
 * seat-pricing: plain unit tests always; the browser-gated fixture matrix and the
 * gallery pose behind BENCH_BROWSER_TESTS=1.
 *
 * Browser run (from the benchmarks directory):
 *   PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright-benchmarks" BENCH_BROWSER_TESTS=1 \
 *     npx vitest run lib/lab/llm-benchmark/plugins/horizon-suite/tasks/seat-pricing
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, afterAll } from 'vitest'
import { fixtureMatrix, type Expectation } from '../../lib/fixture-matrix'
import { closeSandbox, runChecks } from '../../../../scorers/sandbox'
import { getSandboxBackend } from '../../../../scorers/sandbox-backend'
import { freshLoad } from '../../lib/load'
import { probe } from '../../lib/probe'
import type { CheckContext } from '../../../../scorers/check-meta'
import { SANDBOX_CONSTRAINTS } from '../../../../prompts'
import { task, SEAT_PRICING_PROMPT, SEAT_PRICING_SANDBOX } from './task'
import { checks, CHECK_LIST, CHECK_NAMES } from './checks'
import { DISCOUNT_STEPS, DISCOUNT_STEP_A, HIDDEN_VERSION, ROUNDING_CASES, TIER_SCALE_SUBTOTALS_CENTS } from './hidden'
import {
  FIXTURE_GOOD_NAMES,
  FIXTURE_NAMES,
  brokenDefinitions,
  brokenArtifacts,
  expectations,
  fixtures,
  goodArtifact,
  goodVariantArtifacts,
  goodVariantDefinitions,
  mutate,
  replaceRegion,
  staticFakeArtifact,
} from './fixtures'
import { pose } from './pose'
import { formatDollars } from './reference'

/** SHA-256 of the specification's final_prompt, pinned here so the check runs everywhere. */
const SPEC_PROMPT_SHA256 = 'cd1d8a285faf146bce6992bab79a6c3cddd8b60bff03872974c331d3404e9629'

/** The names and points the specification gives, in order (kept here so the test runs without the spec file). */
const EXPECTED_CHECKS: ReadonlyArray<[string, number]> = [
  ['pricing-graduated-tiers', 10],
  ['pricing-discount-order', 12],
  ['pricing-exact-rounding', 14],
  ['pricing-display-format', 7],
  ['pricing-seats-validation', 11],
  ['pricing-keyboard', 10],
  ['pricing-accessible-names', 8],
  ['pricing-contrast', 8],
  ['pricing-responsive', 10],
  ['pricing-breakdown-geometry', 10],
]

describe('seat-pricing: declared checks', () => {
  it('names and points match the specification, in order, and sum to 100', () => {
    expect(CHECK_NAMES).toEqual(EXPECTED_CHECKS.map(([n]) => n))
    for (const [name, points] of EXPECTED_CHECKS) {
      const check = checks[name]!
      expect(check.checkName, name).toBe(name)
      expect(check.maxPoints, name).toBe(points)
    }
    expect(CHECK_LIST.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0)).toBe(100)
  })

  it('the task row lists the checks in the same order', () => {
    expect(task.checks).toEqual(EXPECTED_CHECKS.map(([n]) => n))
    expect(task.scorer).toBe('behavioral')
    expect(task.id).toBe('seat-pricing')
    expect(task.slug).toBe('seat-pricing')
    expect(task.category).toBe('ui-building')
    expect(task.iterationsDefault).toBe(3)
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
  })
})

describe('seat-pricing: the prompt', () => {
  it('is the specification final_prompt, pinned by digest', () => {
    const digest = createHash('sha256').update(SEAT_PRICING_PROMPT, 'utf8').digest('hex')
    expect(digest).toBe(SPEC_PROMPT_SHA256)
    expect(task.prompt).toBe(SEAT_PRICING_PROMPT)
  })

  it('contains none of the hidden amounts the checks use (formatted or as digits)', () => {
    const amounts = new Set<number>()
    for (const c of ROUNDING_CASES) for (const v of c.expect) amounts.add(v)
    for (const v of TIER_SCALE_SUBTOTALS_CENTS) amounts.add(v)
    for (const step of DISCOUNT_STEPS) for (const v of step.amounts) amounts.add(v)
    for (const v of DISCOUNT_STEP_A.amounts) amounts.add(v)
    // Public figures the prompt states itself: the list prices and the FLAT50 cap.
    const PUBLIC_CENTS = new Set([900, 1450, 2375, 5000])
    const leaks: string[] = []
    for (const cents of amounts) {
      if (cents < 1000 || PUBLIC_CENTS.has(cents)) continue
      const dollars = formatDollars(BigInt(cents))
      if (SEAT_PRICING_PROMPT.includes(dollars)) leaks.push(dollars)
      if (String(cents).length >= 5 && SEAT_PRICING_PROMPT.includes(String(cents))) leaks.push(String(cents))
    }
    expect(leaks).toEqual([])
  })

  it('contains none of the hidden scenario seat counts that are not public', () => {
    // The prompt names 1 to 5000 and the invalid example "5001" publicly; the hidden
    // scenario counts below must not appear as a standalone number.
    for (const n of [137, 1234, 4999]) {
      expect(SEAT_PRICING_PROMPT.match(new RegExp(`\\b${n}\\b`))).toBeNull()
    }
  })

  it('carries the hygiene-only sandbox contract: the first eight global lines, then the task sentence', () => {
    const start = SANDBOX_CONSTRAINTS.split('\n').findIndex((l) => l.startsWith('EXECUTION ENVIRONMENT'))
    const globalLines = SANDBOX_CONSTRAINTS.split('\n').slice(start, start + 8)
    expect(globalLines.length).toBe(8)
    for (const line of globalLines) expect(SEAT_PRICING_SANDBOX).toContain(line)
    expect(SEAT_PRICING_SANDBOX.endsWith('Output only the HTML document.')).toBe(true)
    expect(task.sandboxConstraints).toBe(SEAT_PRICING_SANDBOX)
  })
})

describe('seat-pricing: fixtures', () => {
  it('the good artifact has each contract id exactly once', () => {
    const ids = [
      'billing-monthly', 'billing-annual', 'seats', 'seats-dec', 'seats-inc', 'promo', 'promo-apply', 'promo-status',
      'region', 'checkout', 'summary', 'subtotal', 'annual-discount', 'promo-discount', 'tax', 'total', 'per-seat',
      'seats-error', 'breakdown',
    ]
    for (const id of ids) {
      const n = goodArtifact.split(`id="${id}"`).length - 1
      expect(n, id).toBe(1)
    }
    expect(goodArtifact.split('<h1').length - 1).toBe(1)
    expect(goodArtifact.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(goodArtifact).toContain('<html lang="en">')
  })

  it('every broken definition changes the artifact in a named region, and each change is real', () => {
    for (const def of brokenDefinitions) {
      const html = brokenArtifacts[def.name]!
      expect(html, def.name).not.toBe(goodArtifact)
      for (const [region] of def.replacements) {
        expect(goodArtifact.includes(`@region:${region}`), `${def.name} region ${region}`).toBe(true)
      }
    }
    expect(staticFakeArtifact).not.toBe(goodArtifact)
    expect(staticFakeArtifact).not.toContain('<script>')
  })

  it('a mutation that changes nothing is refused', () => {
    expect(() => replaceRegion(goodArtifact, 'tiers', (old) => old)).toThrow(/did not change/)
    expect(() => mutate(goodArtifact, [['no-such-region', 'x']])).toThrow(/not in the good artifact/)
  })

  it('the fixture list and the expectations cover every fixture and name only real checks', () => {
    const names = fixtures.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    for (const key of Object.keys(expectations)) expect(names).toContain(key)
    for (const list of Object.values(expectations)) {
      for (const check of list) expect(CHECK_NAMES).toContain(check)
    }
    expect(expectations[FIXTURE_NAMES.good]).toEqual([])
  })

  it('the static fake keeps the names and contrast checks passing by design and fails the rest', () => {
    const failing = expectations[FIXTURE_NAMES.staticFake]!
    expect(failing).not.toContain('pricing-accessible-names')
    expect(failing).not.toContain('pricing-contrast')
    expect(failing.length).toBe(8)
    const points = CHECK_LIST.filter((c) => !failing.includes(c.checkName!)).reduce((s, c) => s + (c.maxPoints ?? 0), 0)
    expect(points).toBe(16)
  })

  it('every conforming variant is a region edit of the good artifact and changes it', () => {
    for (const def of goodVariantDefinitions) {
      const html = goodVariantArtifacts[def.name]!
      expect(html, def.name).not.toBe(goodArtifact)
      for (const [region] of def.replacements) {
        expect(goodArtifact.includes(`@region:${region}`), `${def.name} region ${region}`).toBe(true)
      }
    }
    expect(FIXTURE_GOOD_NAMES.length).toBe(1 + goodVariantDefinitions.length)
  })

  it('the hidden version is recorded', () => {
    expect(HIDDEN_VERSION).toBe('seat-pricing/v4')
  })
})

// ---------------------------------------------------------------------------
// Browser-gated: the fixture matrix, the gallery pose and the timing budget.
// ---------------------------------------------------------------------------

const fixtureExpectations: Record<string, Expectation> = Object.fromEntries(
  Object.entries(expectations).map(([name, list]) => [name, FIXTURE_GOOD_NAMES.includes(name) ? 'good' : [...list]])
)

/**
 * Each check's elapsed time in every fixture, in run order: the matrix runs every check of a fixture in turn, so the
 * records split into the fixtures by the check count. Written to BENCH_MATRIX_OUT with the matrix, so a slow check
 * under load is visible in the saved output (the console lines of a test run are not kept).
 */
const timings: Array<{ check: string; ms: number; passed: boolean }> = []

function timed(check: (typeof CHECK_LIST)[number]): (typeof CHECK_LIST)[number] {
  const wrapped = (async (ctx: CheckContext) => {
    const started = Date.now()
    try {
      const result = await check(ctx)
      timings.push({ check: check.checkName ?? '?', ms: Date.now() - started, passed: result.passed })
      return result
    } catch (error) {
      timings.push({ check: check.checkName ?? '?', ms: Date.now() - started, passed: false })
      throw error
    }
  }) as (typeof CHECK_LIST)[number]
  wrapped.checkName = check.checkName
  wrapped.maxPoints = check.maxPoints
  return wrapped
}

fixtureMatrix({
  taskId: 'seat-pricing',
  checks: CHECK_LIST.map(timed),
  fixtures: fixtures.map((f) => ({ name: f.name, html: f.html })),
  expectations: fixtureExpectations,
  checksModule: { url: new URL('./checks.ts', import.meta.url).href, exportName: 'CHECK_LIST' },
})

afterAll(() => {
  if (!process.env.BENCH_MATRIX_OUT || timings.length === 0) return
  const per = CHECK_LIST.length
  const lines = [`seat-pricing check times (ms), per fixture in matrix order (${per} checks each)`]
  fixtures.forEach((fixture, f) => {
    const rows = timings.slice(f * per, (f + 1) * per)
    if (rows.length === 0) return
    const total = rows.reduce((sum, r) => sum + r.ms, 0)
    const slowest = rows.reduce((a, b) => (b.ms > a.ms ? b : a))
    lines.push(`${String(f + 1).padStart(3)} ${fixture.name}: total ${total}, slowest ${slowest.check} ${slowest.ms}`)
    lines.push('    ' + rows.map((r) => `${r.check}=${r.ms}${r.passed ? '' : '!'}`).join(' '))
  })
  writeFileSync(join(process.env.BENCH_MATRIX_OUT, 'seat-pricing-timing.txt'), lines.join('\n') + '\n')
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('seat-pricing: browser-only extras', () => {
  afterAll(closeSandbox)

  it('the gallery pose reads $23,817.65 and $14.49 per seat on the good artifact', async () => {
    const session = await getSandboxBackend().launch()
    const context = await session.newContext({ viewport: { width: 1024, height: 720 } })
    try {
      const page = await context.newPage()
      const ctx: CheckContext = { page, html: goodArtifact, captureCanvas: async () => undefined }
      await freshLoad(ctx)
      const result = await probe<{ total: string | null; perSeat: string | null }>(page, pose, undefined, 3000)
      expect(result.total).toBe('$23,817.65')
      expect(result.perSeat).toBe('$14.49')
    } finally {
      await context.close().catch(() => undefined)
    }
  })

  it('the good artifact passes every check in under 15 seconds of check time', async () => {
    const started = Date.now()
    const rows = await runChecks(goodArtifact, [...CHECK_LIST], { settleMs: 600 })
    const elapsed = Date.now() - started
    const failing = rows.filter((r) => !r.passed).map((r) => `${r.name}: ${r.detail ?? ''}`)
    console.log(`[seat-pricing] good artifact: ${rows.reduce((s, r) => s + r.points, 0)}/100 in ${elapsed} ms`)
    expect(failing).toEqual([])
    expect(elapsed).toBeLessThan(15_000)
  }, 60_000)

  // pricing-contrast has a 4.5 s deadline, so its own time must sit well inside it, with margin for load. The good
  // page and the heaviest fixture (the most audited stops at the time of writing) must finish inside 3 s. A medium page
  // with a grain overlay (every candidate under an image layer, so every stop takes the glyph pair) and the very long
  // page have 3.5 s: the overlay costs two more pictures per stop, and both measured 2.5 to 3.1 s under load.
  it('the contrast check finishes inside its bound on the good, grain, long and heaviest pages', async () => {
    const session = await getSandboxBackend().launch()
    const htmlOf = (name: string): string => fixtures.find((f) => f.name === name)!.html
    const cases: Array<[string, string, number]> = [
      ['good', goodArtifact, 3_000],
      ['heaviest', brokenArtifacts[FIXTURE_NAMES.cheatStaticConstants]!, 3_000],
      ['grain overlay', htmlOf('pricing-good-medium-page-grain-overlay'), 3_500],
      ['very long', htmlOf('pricing-good-very-long-page'), 3_500],
    ]
    for (const [label, html, bound] of cases) {
      const context = await session.newContext({ viewport: { width: 1024, height: 720 } })
      try {
        const page = await context.newPage()
        const ctx: CheckContext = { page, html, captureCanvas: async () => undefined }
        await freshLoad(ctx)
        const started = Date.now()
        const result = await checks['pricing-contrast']!(ctx)
        const elapsed = Date.now() - started
        console.log(`[seat-pricing] pricing-contrast on the ${label} page: ${elapsed} ms, passed ${result.passed}`)
        expect(elapsed, label).toBeLessThan(bound)
        if (label !== 'heaviest') expect(result.passed, label).toBe(true)
      } finally {
        await context.close().catch(() => undefined)
      }
    }
  }, 60_000)
})
