import { describe, expect, it } from 'vitest'
import {
  BREAKDOWN_STATES,
  DISCOUNT_STEPS,
  DISCOUNT_STEP_A,
  DISPLAY_STATES,
  INVALID_SEATS_TEXT,
  LIMIT_SEATS_TEXT,
  ROUNDING_CASES,
  TIER_PLANS,
  TIER_SCALE_SUBTOTALS_CENTS,
  TIER_SEATS,
  VALID_ODD_SEATS,
  VALIDATION_SCENARIO,
  type Scenario,
  type SixAmounts,
} from './hidden'
import {
  LIST_PRICE_CENTS,
  RATE_PER_100000,
  formatDollars,
  parseSeats,
  priceScenario,
  roundHalfUp,
  sixAmounts,
  weightedPercent,
} from './reference'

// ---------------------------------------------------------------------------
// Three float implementations, ported from the chief designer's pricing.cjs. They
// exist only to prove the hidden tables discriminate; no check imports them.
// ---------------------------------------------------------------------------
const FLOAT_LIST_DOLLARS: Record<string, number> = { starter: 9.0, team: 14.5, scale: 23.75 }
const FLOAT_RATE: Record<string, number> = { none: 0, ca: 0.0725, ny: 0.08875, uk: 0.2, de: 0.19 }
const INT_LIST_CENTS: Record<string, number> = { starter: 900, team: 1450, scale: 2375 }
const INT_RATE_NUM: Record<string, number> = { none: 0, ca: 7250, ny: 8875, uk: 20000, de: 19000 }

function bracketSum(seats: number, price: number): number {
  let s = 0
  for (let i = 1; i <= seats; i++) s += price * (i <= 10 ? 1 : i <= 50 ? 0.9 : i <= 200 ? 0.8 : 0.7)
  return s
}

/** Float dollars, Math.round(x * 100) / 100 at each stated rounding. */
function floatDollars(s: Scenario): SixAmounts {
  const r2 = (x: number): number => Math.round(x * 100) / 100
  const code = s.promo.trim().toUpperCase()
  const months = s.annual ? 12 : 1
  const subtotal = r2(bracketSum(s.seats, FLOAT_LIST_DOLLARS[s.plan]!) * months)
  const ad = s.annual ? r2(subtotal * 0.17) : 0
  const base = subtotal - ad
  let pd = 0
  if (code === 'LAUNCH20') pd = r2(base * 0.2)
  else if (code === 'FLAT50') pd = Math.min(50, base)
  else if (code === 'TEAM10' && s.plan !== 'starter' && s.seats >= 5) pd = r2(base * 0.1)
  const taxable = base - pd
  const tax = r2(taxable * FLOAT_RATE[s.region]!)
  const total = taxable + tax
  const per = r2(total / (s.seats * months))
  return [subtotal, ad, pd, tax, total, per].map((x) => Math.round(x * 100)) as unknown as SixAmounts
}

/** Integer cents, each multiplier a float: Math.round(x * 0.0725) style. */
function intCentsFloatMultipliers(s: Scenario): SixAmounts {
  const n = s.seats
  const t1 = Math.min(n, 10)
  const t2 = Math.max(0, Math.min(n, 50) - 10)
  const t3 = Math.max(0, Math.min(n, 200) - 50)
  const t4 = Math.max(0, n - 200)
  const months = s.annual ? 12 : 1
  const code = s.promo.trim().toUpperCase()
  const subtotal = Math.round(months * INT_LIST_CENTS[s.plan]! * (t1 + t2 * 0.9 + t3 * 0.8 + t4 * 0.7))
  const ad = s.annual ? Math.round(subtotal * 0.17) : 0
  const base = subtotal - ad
  let pd = 0
  if (code === 'LAUNCH20') pd = Math.round(base * 0.2)
  else if (code === 'FLAT50') pd = Math.min(5000, base)
  else if (code === 'TEAM10' && s.plan !== 'starter' && s.seats >= 5) pd = Math.round(base * 0.1)
  const taxable = base - pd
  const tax = Math.round(taxable * FLOAT_RATE[s.region]!)
  const total = taxable + tax
  const per = Math.round(total / (n * months))
  return [subtotal, ad, pd, tax, total, per]
}

/** Every amount rounded with toFixed(2) at each step. */
function toFixedEachStep(s: Scenario): SixAmounts {
  const f = (x: number): number => Number(x.toFixed(2))
  const code = s.promo.trim().toUpperCase()
  const months = s.annual ? 12 : 1
  const subtotal = f(bracketSum(s.seats, FLOAT_LIST_DOLLARS[s.plan]!) * months)
  const ad = s.annual ? f(subtotal * 0.17) : 0
  const base = subtotal - ad
  let pd = 0
  if (code === 'LAUNCH20') pd = f(base * 0.2)
  else if (code === 'FLAT50') pd = Math.min(50, base)
  else if (code === 'TEAM10' && s.plan !== 'starter' && s.seats >= 5) pd = f(base * 0.1)
  const taxable = base - pd
  const tax = f(taxable * FLOAT_RATE[s.region]!)
  const total = taxable + tax
  const per = f(total / (s.seats * months))
  return [subtotal, ad, pd, tax, total, per].map((x) => Math.round(x * 100)) as unknown as SixAmounts
}

const FLOAT_STYLES: Array<[string, (s: Scenario) => SixAmounts]> = [
  ['float dollars', floatDollars],
  ['integer cents with float multipliers', intCentsFloatMultipliers],
  ['toFixed at each step', toFixedEachStep],
]

function reference(s: Scenario): SixAmounts {
  return sixAmounts(priceScenario(s)) as unknown as SixAmounts
}

function scenarioOf(c: { plan: Scenario['plan']; seats: number; annual: boolean; promo: string; region: Scenario['region'] }): Scenario {
  return { plan: c.plan, seats: c.seats, annual: c.annual, promo: c.promo, region: c.region }
}

/**
 * The discount steps in order. A step without a promo key keeps the code the page
 * already has, so the scenario carries the previous code forward.
 */
function carriedDiscountScenarios(): Array<{ step: (typeof DISCOUNT_STEPS)[number]; scenario: Scenario }> {
  let code = ''
  return DISCOUNT_STEPS.map((step) => {
    code = step.promo ?? code
    return { step, scenario: { plan: step.plan, seats: step.seats, annual: step.annual, promo: code, region: step.region } }
  })
}

describe('exact reference: primitives', () => {
  it('rounds exact halves up and nothing else', () => {
    expect(roundHalfUp(5n, 10n)).toBe(1n)
    expect(roundHalfUp(4n, 10n)).toBe(0n)
    expect(roundHalfUp(15n, 10n)).toBe(2n)
    expect(roundHalfUp(14n, 10n)).toBe(1n)
    expect(roundHalfUp(0n, 7n)).toBe(0n)
  })

  it('weights seats by the prompt brackets', () => {
    expect(weightedPercent(1)).toBe(100n)
    expect(weightedPercent(10)).toBe(1000n)
    expect(weightedPercent(11)).toBe(1090n)
    expect(weightedPercent(50)).toBe(100n * 10n + 90n * 40n)
    expect(weightedPercent(51)).toBe(100n * 10n + 90n * 40n + 80n)
    expect(weightedPercent(5000)).toBe(100n * 10n + 90n * 40n + 80n * 150n + 70n * 4800n)
  })

  it('reads seats text exactly as the prompt states', () => {
    expect(parseSeats(' 7 ')).toBe(7)
    expect(parseSeats('007')).toBe(7)
    expect(parseSeats('5000')).toBe(5000)
    expect(parseSeats('1')).toBe(1)
    for (const text of INVALID_SEATS_TEXT) expect(parseSeats(text), JSON.stringify(text)).toBeNull()
    for (const text of ['12abc', '1e3', '+5', '-3', '0x10', '12.5', '5001', '0']) {
      expect(parseSeats(text), text).toBeNull()
    }
    for (const v of VALID_ODD_SEATS) expect(parseSeats(v.text)).toBe(v.seats)
    for (const text of LIMIT_SEATS_TEXT) expect(parseSeats(text)).not.toBeNull()
  })

  it('formats whole cents as the prompt displays them', () => {
    expect(formatDollars(0n)).toBe('$0.00')
    expect(formatDollars(101500n)).toBe('$1,015.00')
    expect(formatDollars(2381765n)).toBe('$23,817.65')
    expect(formatDollars(100491000n)).toBe('$1,004,910.00')
    expect(formatDollars(1450n)).toBe('$14.50')
    expect(formatDollars(7n)).toBe('$0.07')
  })

  it('keeps the list prices and rates from the prompt', () => {
    expect(LIST_PRICE_CENTS.starter).toBe(900n)
    expect(LIST_PRICE_CENTS.team).toBe(1450n)
    expect(LIST_PRICE_CENTS.scale).toBe(2375n)
    expect(RATE_PER_100000.ca).toBe(7250n)
    expect(RATE_PER_100000.ny).toBe(8875n)
    expect(RATE_PER_100000.uk).toBe(20000n)
    expect(RATE_PER_100000.de).toBe(19000n)
  })
})

describe('exact reference: the published scenarios', () => {
  it('graduated tiers: Scale subtotals match the spec anchors and tax is zero', () => {
    const scale = TIER_SEATS.map((seats) => priceScenario({ plan: 'scale', seats, annual: false, promo: '', region: 'none' }))
    expect(scale.map((p) => Number(p.subtotal))).toEqual([...TIER_SCALE_SUBTOTALS_CENTS])
    for (const p of scale) {
      expect(p.total).toBe(p.subtotal)
      expect(p.annualDiscount + p.promoDiscount + p.tax).toBe(0n)
    }
  })

  it('graduated tiers: 30 subtotals and totals are the per-seat sums rounded once', () => {
    let cases = 0
    for (const plan of TIER_PLANS) {
      for (const seats of TIER_SEATS) {
        const p = priceScenario({ plan, seats, annual: false, promo: '', region: 'none' })
        const exact = Number(LIST_PRICE_CENTS[plan]) * Number(weightedPercent(seats))
        // subtotal = round(exact / 100), recomputed independently with integer math
        expect(Number(p.subtotal)).toBe(Math.floor((2 * exact + 100) / 200))
        expect(p.total).toBe(p.subtotal)
        cases++
      }
    }
    expect(cases).toBe(30)
  })

  it('scale at 37 seats rounds once (81463), not per seat (81476)', () => {
    expect(Number(priceScenario({ plan: 'scale', seats: 37, annual: false, promo: '', region: 'none' }).subtotal)).toBe(81463)
  })

  it('discount order: step a (scale 8, annual, LAUNCH20) matches the spec', () => {
    const s = scenarioOf({ plan: DISCOUNT_STEP_A.plan, seats: DISCOUNT_STEP_A.seats, annual: DISCOUNT_STEP_A.annual, promo: DISCOUNT_STEP_A.typed, region: DISCOUNT_STEP_A.region })
    expect(priceScenario(s).promoState).toBe('applied')
    expect(reference(s)).toEqual([...DISCOUNT_STEP_A.amounts])
  })

  it('discount order: every page-state step matches the spec', () => {
    for (const { step, scenario: s } of carriedDiscountScenarios()) {
      const p = priceScenario(s)
      expect(p.promoState, step.label).toBe(step.state)
      expect(reference(s), step.label).toEqual([...step.amounts])
    }
  })

  it('discount order: the page keeps TEAM10 out at 4 seats even with the same code text', () => {
    expect(priceScenario(scenarioOf({ plan: 'team', seats: 4, annual: false, promo: 'TEAM10', region: 'none' })).promoState).toBe('error')
    expect(priceScenario(scenarioOf({ plan: 'team', seats: 5, annual: false, promo: 'team10 ', region: 'none' })).promoState).toBe('applied')
  })

  it('exact rounding: twelve literal cases match the reference exactly', () => {
    for (const c of ROUNDING_CASES) {
      expect(reference(scenarioOf(c)), `${c.plan}/${c.seats}/${c.annual}/${c.promo}/${c.region}`).toEqual([...c.expect])
    }
  })

  it('exact rounding: each float style fails at least one of the twelve cases', () => {
    for (const [name, style] of FLOAT_STYLES) {
      const wrong = ROUNDING_CASES.filter((c) => {
        const got = style(scenarioOf(c))
        return got.some((v, i) => v !== c.expect[i])
      })
      expect(wrong.length, `${name} must be wrong on some rounding case`).toBeGreaterThan(0)
    }
  })

  it('exact rounding: the integer-cents float-multiplier style is wrong on exactly four of the twelve', () => {
    const wrong = ROUNDING_CASES.filter((c) => intCentsFloatMultipliers(scenarioOf(c)).some((v, i) => v !== c.expect[i]))
    expect(wrong.length).toBe(4)
  })

  it('exact rounding: float dollars miss a different subset than integer-cents (proves coverage)', () => {
    const fd = ROUNDING_CASES.filter((c) => floatDollars(scenarioOf(c)).some((v, i) => v !== c.expect[i])).map((c) => c.seats + c.plan)
    const ic = ROUNDING_CASES.filter((c) => intCentsFloatMultipliers(scenarioOf(c)).some((v, i) => v !== c.expect[i])).map((c) => c.seats + c.plan)
    expect(fd.join('|')).not.toBe(ic.join('|'))
  })

  it('every reference case used outside the rounding table is float-safe under all three styles', () => {
    const others: Scenario[] = []
    for (const plan of TIER_PLANS) for (const seats of TIER_SEATS) others.push({ plan, seats, annual: false, promo: '', region: 'none' })
    for (const { scenario } of carriedDiscountScenarios()) others.push(scenario)
    others.push({ plan: DISCOUNT_STEP_A.plan, seats: DISCOUNT_STEP_A.seats, annual: true, promo: DISCOUNT_STEP_A.typed, region: DISCOUNT_STEP_A.region })
    for (const s of DISPLAY_STATES) others.push(s)
    for (const s of BREAKDOWN_STATES) others.push(s)
    others.push({ ...VALIDATION_SCENARIO, seats: 7 })
    others.push({ plan: 'scale', seats: 9, annual: true, promo: '', region: 'none' })
    for (const [name, style] of FLOAT_STYLES) {
      const bad = others.filter((s) => {
        const want = reference(s)
        return style(s).some((v, i) => v !== want[i])
      })
      expect(bad.map((s) => JSON.stringify(s)), `${name} must agree on every non-rounding reference case`).toEqual([])
    }
  })
})

describe('exact reference: a single pose scenario from the gallery', () => {
  it('scale, 137 seats, annual, LAUNCH20, ny reads $23,817.65 and $14.49 per seat', () => {
    const p = priceScenario({ plan: 'scale', seats: 137, annual: true, promo: 'LAUNCH20', region: 'ny' })
    expect(formatDollars(p.total)).toBe('$23,817.65')
    expect(formatDollars(p.perSeat)).toBe('$14.49')
  })
})
