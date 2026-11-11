/**
 * The ten seat-pricing checks, in the order and with the points the specification
 * gives (sum 100). Each runs on its own fresh load of the artifact (freshLoad), then
 * calmPage (transitions off, running animations finished), and each runs through
 * defineCheck, so a throw or a deadline keeps the full budget.
 *
 * Each check requires only the contract ids and plan buttons it drives or reads
 * (NEEDS below). A page that lacks one element fails the checks that need it and
 * keeps the rest of its score.
 *
 * Expected money values come from the BigInt reference (reference.ts) or from the
 * literal tables in hidden.ts; no check trusts the page's own arithmetic. Where the
 * specification says a check compares the page with its own data-cents, it does.
 */
import type { Locator, Page } from 'playwright'
import type { CheckContext, CheckFn } from '../../../../scorers/check-meta'
import { defineCheck, type CheckOutcome, type CheckTools } from '../../lib/check'
import { bounded, probe, settle, withViewport } from '../../lib/probe'
import { freshLoad } from '../../lib/load'
import { contrastAudit, type ContrastAudit, type ContrastBaseline, type ContrastRow } from './contrast'
import { compositeOver, contrastRatio, type RGBA } from '../../lib/math'
import { calmPage, revealAll } from './motion'
import {
  BREAKDOWN_MIN_PX,
  BREAKDOWN_MIN_SUM_PX,
  BREAKDOWN_REACH_SAVINGS_STATE,
  BREAKDOWN_REACH_TAX_SAVINGS_STATE,
  BREAKDOWN_REACH_TAX_STATE,
  BREAKDOWN_STATES,
  BREAKDOWN_VIEWPORT_HEIGHT,
  BREAKDOWN_VIEWPORT_WIDTH,
  CONTRAST_LARGE,
  CONTRAST_MIN_AUDITED,
  CONTRAST_NORMAL,
  CONTRAST_STATE_PROMO_UNKNOWN,
  DISCOUNT_STEPS,
  DISCOUNT_STEP_A,
  DISPLAY_REACH_CENTS,
  DISPLAY_STATES,
  INVALID_SEATS_TEXT,
  KEY_SCENARIO_PLAN,
  KEY_SCENARIO_PROMO,
  KEY_SCENARIO_SEATS,
  LAYOUT_TOLERANCE_PX,
  LIMIT_SEATS_TEXT,
  PLAN_NAMES,
  RESPONSIVE_HEIGHT,
  RESPONSIVE_WIDTHS,
  ROUNDING_CASES,
  SHARE_TOLERANCE,
  TAB_ORDER,
  TIER_PLANS,
  TIER_SEATS,
  VALID_ODD_SEATS,
  VALIDATION_SCENARIO,
  HIDDEN_VERSION,
  type PlanName,
  type Scenario,
  type SixAmounts,
} from './hidden'
import { priceScenario, sixAmounts } from './reference'
import {
  APPLY_AND_READ,
  CLICK_AND_READ_SEATS,
  DOCUMENT_FACTS,
  FOCUS_SELECTOR,
  READ_STATE,
  RESPONSIVE_READ,
  RUN_STEPS,
  tabWalkContract,
  type ContractTabWalk,
  type FocusStyle,
  type Rgba4,
  type TabStop,
} from './local'

export const CHECKS_VERSION = HIDDEN_VERSION

// ---------------------------------------------------------------------------
// Shared shapes and helpers
// ---------------------------------------------------------------------------

/** The amount elements in the order the spec's rounding tables use. */
const AMOUNT_IDS = ['subtotal', 'annual-discount', 'promo-discount', 'tax', 'total', 'per-seat'] as const
type AmountId = (typeof AMOUNT_IDS)[number]

interface AmountReading {
  cents: string | null
  text: string
  inner: string
  shown: boolean
}

interface SegmentReading {
  name: string
  left: number
  right: number
  top: number
  bottom: number
  width: number
  children: number
  shown: boolean
  background: string
  backgroundRgba: Rgba4 | null
  image: string
}

interface Snapshot {
  amounts: Record<AmountId, AmountReading | null>
  promo: { state: string | null; text: string; shown: boolean } | null
  seats: { value: string; invalid: string | null; describedBy: string; errorText: string | null; errorShown: boolean } | null
  disabled: Record<'checkout' | 'seats-dec' | 'seats-inc', boolean | null>
  pressed: Record<string, string | null>
  annual: boolean
  bar: { width: number; segments: Array<SegmentReading | null> } | null
  missing: string[]
  applyMissing: string[]
}

const CONTRACT_PLANS: readonly PlanName[] = ['starter', 'team', 'scale']

/**
 * What a check needs on the page: the plan buttons it clicks or reads, and the
 * contract ids it drives or reads. Nothing else gates it.
 */
interface Needs {
  plans: readonly PlanName[]
  ids: readonly string[]
}

const BILLING_IDS = ['billing-monthly', 'billing-annual'] as const
const SIX_IDS: readonly string[] = AMOUNT_IDS
const RATE_STEP_IDS = ['region', 'seats', 'promo', 'promo-apply'] as const

const NEEDS: Record<
  | 'tiers'
  | 'discount'
  | 'rounding'
  | 'display'
  | 'validation'
  | 'keyboard'
  | 'names'
  | 'contrast'
  | 'responsive'
  | 'breakdown',
  Needs
> = {
  tiers: {
    plans: CONTRACT_PLANS,
    ids: ['billing-monthly', 'region', 'seats', 'subtotal', 'annual-discount', 'promo-discount', 'tax', 'total'],
  },
  discount: {
    plans: CONTRACT_PLANS,
    ids: [...BILLING_IDS, ...RATE_STEP_IDS, 'promo-status', ...SIX_IDS],
  },
  rounding: { plans: CONTRACT_PLANS, ids: [...BILLING_IDS, ...RATE_STEP_IDS, ...SIX_IDS] },
  display: { plans: CONTRACT_PLANS, ids: [...BILLING_IDS, ...RATE_STEP_IDS, ...SIX_IDS] },
  validation: {
    plans: ['team'],
    ids: ['billing-monthly', 'region', 'seats', 'seats-dec', 'seats-inc', 'seats-error', 'checkout', 'promo', 'promo-apply', ...SIX_IDS],
  },
  keyboard: {
    plans: CONTRACT_PLANS,
    ids: [...BILLING_IDS, 'seats-dec', 'seats', 'seats-inc', 'promo', 'promo-apply', 'region', 'checkout', 'promo-status', ...SIX_IDS],
  },
  names: {
    plans: CONTRACT_PLANS,
    ids: [...BILLING_IDS, 'seats', 'seats-dec', 'seats-inc', 'promo', 'promo-apply', 'region', 'summary', 'total'],
  },
  // The states are reached through the controls; a missing control fails the state, not the page.
  contrast: { plans: [], ids: [] },
  responsive: {
    plans: CONTRACT_PLANS,
    ids: [...BILLING_IDS, 'seats-dec', 'seats', 'seats-inc', 'promo', 'promo-apply', 'region', 'checkout', ...SIX_IDS, 'breakdown'],
  },
  breakdown: { plans: CONTRACT_PLANS, ids: [...BILLING_IDS, ...RATE_STEP_IDS, 'breakdown', ...SIX_IDS] },
}

/** Ids that exist and each plan button that is the only [data-plan] button for its plan. */
const PRESENCE_SOURCE = String.raw`(arg) => {
  var missing = arg.ids.filter(function (id) { return !document.getElementById(id); });
  arg.plans.forEach(function (plan) {
    if (document.querySelectorAll('button[data-plan="' + plan + '"]').length !== 1) missing.push('button[data-plan=' + plan + ']');
  });
  return missing;
}`

async function missingFor(page: Page, needs: Needs): Promise<string[]> {
  return probe<string[]>(page, PRESENCE_SOURCE, { ids: [...new Set(needs.ids)], plans: [...needs.plans] }, 2000)
}

/** Fresh load, motion calmed, then the needs check. Returns the reason to fail, or null. */
async function ready(ctx: CheckContext, needs: Needs): Promise<string | null> {
  await freshLoad(ctx)
  await calmPage(ctx.page)
  const missing = await missingFor(ctx.page, needs)
  return missing.length > 0 ? `missing ${missing.join(', ')}` : null
}

const READ_VALUE_SOURCE = String.raw`() => document.getElementById('seats').value`

function reading(snap: Snapshot, id: AmountId): AmountReading | null {
  return snap.amounts[id] ?? null
}

/** A page's whole-cent value for one amount, or null where it is not whole cents. */
function centsOf(snap: Snapshot, id: AmountId): bigint | null {
  const c = reading(snap, id)?.cents ?? null
  return c !== null && /^[0-9]+$/.test(c) ? BigInt(c) : null
}

/** The six amounts as the page reports them, or null where a value is not whole cents. */
function sixFrom(snap: Snapshot): (bigint | null)[] {
  return AMOUNT_IDS.map((id) => centsOf(snap, id))
}

/** Compare the page's six data-cents with a literal table. Returns the first mismatch or null. */
function compareSix(snap: Snapshot, want: SixAmounts): string | null {
  const got = sixFrom(snap)
  for (let i = 0; i < AMOUNT_IDS.length; i++) {
    if (got[i] === null) return `${AMOUNT_IDS[i]} has no whole-cent data-cents`
    if (got[i] !== BigInt(want[i]!)) return `${AMOUNT_IDS[i]} ${String(got[i])} != ${want[i]}`
  }
  return null
}

function compareReference(snap: Snapshot, s: Scenario): string | null {
  return compareSix(snap, sixAmounts(priceScenario(s)) as unknown as SixAmounts)
}

function scenarioArg(s: Scenario): Record<string, unknown> {
  return { plan: s.plan, seats: s.seats, annual: s.annual, promo: s.promo, region: s.region }
}

function labelOf(s: Scenario): string {
  return `${s.plan}/${s.seats}/${s.annual ? 'a' : 'm'}/${s.promo || '-'}/${s.region}`
}

function nonEmpty(text: string): boolean {
  return text.length > 0
}

function failWith(detail: string): CheckOutcome {
  return { passed: false, detail }
}

// ---------------------------------------------------------------------------
// pricing-graduated-tiers (10)
// ---------------------------------------------------------------------------

export const pricingGraduatedTiers = defineCheck(
  'pricing-graduated-tiers',
  10,
  'Each seat is priced by its own bracket and the subtotal is rounded once, for all three plans.',
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const gate = await ready(ctx, NEEDS.tiers)
    if (gate !== null) return failWith(gate)
    const scenarios: Scenario[] = []
    for (const plan of TIER_PLANS) {
      for (const seats of TIER_SEATS) scenarios.push({ plan, seats, annual: false, promo: '', region: 'none' })
    }
    const snaps = await probe<Snapshot[]>(
      ctx.page,
      RUN_STEPS,
      scenarios.map((s) => ({ set: scenarioArg(s) })),
      4000
    )
    const bad: string[] = []
    snaps.forEach((snap, i) => {
      const s = scenarios[i]!
      const p = priceScenario(s)
      const got = sixFrom(snap)
      const want = [p.subtotal, 0n, 0n, 0n, p.total]
      for (let k = 0; k < 5; k++) {
        if (got[k] !== want[k]) {
          bad.push(`${labelOf(s)} ${AMOUNT_IDS[k]} ${String(got[k])}!=${String(want[k])}`)
          break
        }
      }
    })
    if (bad.length > 0) return failWith(`${bad.length}/30 wrong; first ${bad[0]}`)
    return { passed: true, detail: '30/30 subtotals and totals match the bracket reference' }
  }
)

// ---------------------------------------------------------------------------
// pricing-discount-order (12)
// ---------------------------------------------------------------------------

export const pricingDiscountOrder = defineCheck(
  'pricing-discount-order',
  12,
  'The annual discount comes first, the promo applies to the reduced amount, eligibility and the FLAT50 cap hold, and case and whitespace are handled.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.discount)
    if (gate !== null) return failWith(gate)

    // (a) real keyboard input: scale, 8 seats, annual, then the typed code and Enter.
    const setA = await probe<Snapshot[]>(
      page,
      RUN_STEPS,
      [{ set: { plan: DISCOUNT_STEP_A.plan, seats: DISCOUNT_STEP_A.seats, annual: DISCOUNT_STEP_A.annual, promo: '', region: DISCOUNT_STEP_A.region } }],
      3000
    )
    if (setA[0]!.applyMissing.length > 0) return failWith('controls missing for step a')
    const focused = await probe<boolean>(page, FOCUS_SELECTOR, '#promo', 1500)
    if (!focused) return failWith('#promo cannot take focus')
    // The keyboard bounds are 3 s: a few characters and one key take well under a second on a quiet machine, and the
    // 1.5 s bound was missed under heavy machine load (a timeout is a load failure, not a missing promo field).
    await bounded(page.keyboard.type(DISCOUNT_STEP_A.typed), 3000, 'type promo')
    await bounded(page.keyboard.press('Enter'), 3000, 'press Enter')
    await settle(page)
    const aSnap = await probe<Snapshot>(page, READ_STATE, undefined, 2000)
    if (aSnap.promo?.state !== DISCOUNT_STEP_A.state) {
      return failWith(`step a: promo state ${aSnap.promo?.state} != applied`)
    }
    const aMismatch = compareSix(aSnap, DISCOUNT_STEP_A.amounts)
    if (aMismatch !== null) return failWith(`step a: ${aMismatch}`)

    if (tools.aborted()) return failWith('aborted')
    // (b) to (f): page-state steps. A step without promo keeps the applied code.
    const steps = DISCOUNT_STEPS.map((step) => ({
      set: {
        plan: step.plan,
        seats: step.seats,
        annual: step.annual,
        region: step.region,
        ...(step.promo === undefined ? {} : { promo: step.promo }),
      },
    }))
    const snaps = await probe<Snapshot[]>(page, RUN_STEPS, steps, 4000)
    for (let i = 0; i < DISCOUNT_STEPS.length; i++) {
      const step = DISCOUNT_STEPS[i]!
      const snap = snaps[i]!
      if (snap.promo?.state !== step.state) {
        return failWith(`step ${step.label}: data-state ${snap.promo?.state} != ${step.state}`)
      }
      if (step.state === 'error' && !(snap.promo?.shown && nonEmpty(snap.promo.text))) {
        return failWith(`step ${step.label}: error message not visible`)
      }
      const mismatch = compareSix(snap, step.amounts)
      if (mismatch !== null) return failWith(`step ${step.label}: ${mismatch}`)
    }
    return { passed: true, detail: 'steps a to f match the reference, including TEAM10 re-validation' }
  }
)

// ---------------------------------------------------------------------------
// pricing-exact-rounding (14)
// ---------------------------------------------------------------------------

export const pricingExactRounding = defineCheck(
  'pricing-exact-rounding',
  14,
  'Round half up on exact values: ties in tax and in the per-seat division are right to the cent.',
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const gate = await ready(ctx, NEEDS.rounding)
    if (gate !== null) return failWith(gate)
    const snaps = await probe<Snapshot[]>(
      ctx.page,
      RUN_STEPS,
      ROUNDING_CASES.map((c) => ({
        set: { plan: c.plan, seats: c.seats, annual: c.annual, promo: c.promo, region: c.region },
      })),
      4000
    )
    const bad: string[] = []
    ROUNDING_CASES.forEach((c, i) => {
      const mismatch = compareSix(snaps[i]!, c.expect)
      if (mismatch !== null) bad.push(`${c.plan}/${c.seats}/${c.annual ? 'a' : 'm'}/${c.promo || '-'}/${c.region}: ${mismatch}`)
    })
    if (bad.length > 0) return failWith(`${bad.length}/12 wrong; first ${bad[0]}`)
    return { passed: true, detail: '12/12 rounding cases match exactly' }
  }
)

// ---------------------------------------------------------------------------
// pricing-display-format (7)
// ---------------------------------------------------------------------------

const DISPLAY_RE = /^[−-]?\$[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}$/

export const pricingDisplayFormat = defineCheck(
  'pricing-display-format',
  7,
  'The visible text is the reported amount: a dollar sign, comma separators, two decimals, and an em dash when seats is invalid.',
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const gate = await ready(ctx, NEEDS.display)
    if (gate !== null) return failWith(gate)
    const steps: Array<{ set: Record<string, unknown> }> = DISPLAY_STATES.map((s) => ({ set: scenarioArg(s) }))
    steps.push({ set: { seats: 'abc' } })
    const snaps = await probe<Snapshot[]>(ctx.page, RUN_STEPS, steps, 4000)
    const bad: string[] = []
    DISPLAY_STATES.forEach((s, i) => {
      const snap = snaps[i]!
      for (const id of AMOUNT_IDS) {
        const r = reading(snap, id)
        if (r === null) { bad.push(`${id} missing`); continue }
        if (!r.shown) { bad.push(`${id} not visible in ${labelOf(s)}`); continue }
        const text = r.inner.trim()
        if (!DISPLAY_RE.test(text)) { bad.push(`${id} text "${text}" in ${labelOf(s)}`); continue }
        if (r.cents === null || !/^[0-9]+$/.test(r.cents)) { bad.push(`${id} data-cents "${r.cents}"`); continue }
        const digits = text.replace(/[^0-9]/g, '')
        if (BigInt(digits) !== BigInt(r.cents)) bad.push(`${id} shows ${text} for cents ${r.cents}`)
      }
    })
    // Reach: the two large states must show an amount of $1,000.00 or more, and the subtotal must move.
    // A page with constant amounts cannot show a separator or a large figure, so it cannot pass.
    const large = (snap: Snapshot): boolean =>
      AMOUNT_IDS.some((id) => {
        const c = centsOf(snap, id)
        return c !== null && c >= BigInt(DISPLAY_REACH_CENTS)
      })
    for (const i of [2, 3]) {
      if (!large(snaps[i]!)) bad.push(`no amount of $1,000.00 or more shown in ${labelOf(DISPLAY_STATES[i]!)}`)
    }
    const subtotals = DISPLAY_STATES.map((_, i) => reading(snaps[i]!, 'subtotal')?.cents ?? '')
    if (new Set(subtotals).size < 2) bad.push('the subtotal is the same in all four states')
    const dashes = snaps[DISPLAY_STATES.length]!
    for (const id of AMOUNT_IDS) {
      const r = reading(dashes, id)
      if (r === null) { bad.push(`${id} missing after invalid seats`); continue }
      if (r.text.trim() !== '—') bad.push(`${id} shows "${r.text.trim()}" for invalid seats`)
      if (r.cents !== '') bad.push(`${id} data-cents "${r.cents}" for invalid seats`)
    }
    if (bad.length > 0) return failWith(bad[0]! + (bad.length > 1 ? ` (+${bad.length - 1} more)` : ''))
    return { passed: true, detail: 'four states format correctly; invalid seats show em dashes' }
  }
)

// ---------------------------------------------------------------------------
// pricing-seats-validation (11)
// ---------------------------------------------------------------------------

export const pricingSeatsValidation = defineCheck(
  'pricing-seats-validation',
  11,
  'Empty, invalid and extreme seat input is rejected by the stated rule, wired up accessibly, and recovers.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const gate = await ready(ctx, NEEDS.validation)
    if (gate !== null) return failWith(gate)

    const invalidSteps = INVALID_SEATS_TEXT.map((text) => ({ set: { seats: text } }))
    const invalid = await probe<Snapshot[]>(ctx.page, RUN_STEPS, invalidSteps, 4000)
    for (let i = 0; i < INVALID_SEATS_TEXT.length; i++) {
      const text = INVALID_SEATS_TEXT[i]!
      const snap = invalid[i]!
      const label = JSON.stringify(text)
      if (snap.seats === null) return failWith(`${label}: no seats control`)
      if (snap.seats.invalid !== 'true') return failWith(`${label}: aria-invalid ${snap.seats.invalid}`)
      if (!(snap.seats.errorShown && nonEmpty(snap.seats.errorText ?? ''))) {
        return failWith(`${label}: no visible error message`)
      }
      if (!snap.seats.describedBy.split(/\s+/).includes('seats-error')) {
        return failWith(`${label}: aria-describedby lacks seats-error`)
      }
      for (const id of AMOUNT_IDS) {
        const r = reading(snap, id)
        if (r === null || r.text.trim() !== '—' || r.cents !== '') {
          return failWith(`${label}: ${id} is not an em dash with empty data-cents`)
        }
      }
      if (!(snap.disabled.checkout && snap.disabled['seats-dec'] && snap.disabled['seats-inc'])) {
        return failWith(`${label}: checkout or steppers still enabled`)
      }
      if (snap.seats.value !== text) return failWith(`${label}: the typed text was rewritten to ${JSON.stringify(snap.seats.value)}`)
    }
    if (tools.aborted()) return failWith('aborted')

    const validSteps = [
      ...VALID_ODD_SEATS.map((v) => ({ set: { ...scenarioArg({ ...VALIDATION_SCENARIO, seats: v.seats }), seats: v.text } })),
      ...LIMIT_SEATS_TEXT.map((text) => ({ set: { ...scenarioArg({ ...VALIDATION_SCENARIO, seats: 1 }), seats: text } })),
    ]
    const valid = await probe<Snapshot[]>(ctx.page, RUN_STEPS, validSteps, 4000)
    for (let i = 0; i < VALID_ODD_SEATS.length; i++) {
      const v = VALID_ODD_SEATS[i]!
      const snap = valid[i]!
      const label = JSON.stringify(v.text)
      if (snap.seats?.invalid !== 'false') return failWith(`${label}: aria-invalid ${snap.seats?.invalid}`)
      if ((snap.seats.errorText ?? '') !== '') return failWith(`${label}: error message not empty`)
      if (snap.seats.value !== v.text) return failWith(`${label}: value rewritten to ${JSON.stringify(snap.seats.value)}`)
      const mismatch = compareReference(snap, { ...VALIDATION_SCENARIO, seats: v.seats })
      if (mismatch !== null) return failWith(`${label}: ${mismatch}`)
    }
    for (let i = 0; i < LIMIT_SEATS_TEXT.length; i++) {
      const snap = valid[VALID_ODD_SEATS.length + i]!
      const label = JSON.stringify(LIMIT_SEATS_TEXT[i])
      for (const id of AMOUNT_IDS) {
        const r = reading(snap, id)
        if (r === null || r.cents === null || !/^[0-9]+$/.test(r.cents)) {
          return failWith(`${label}: ${id} data-cents is not digits`)
        }
      }
    }

    // Stepper: at 1 the decrease button is disabled; from 4999 one click reaches 5000 and disables increase.
    const atOne = await probe<Snapshot[]>(ctx.page, RUN_STEPS, [{ set: { seats: '1' } }, { set: { seats: '4999' } }], 2000)
    if (atOne[0]!.disabled['seats-dec'] !== true) return failWith('decrease is enabled at 1')
    const up = await probe<{ clicked: boolean; value: string | null }>(ctx.page, CLICK_AND_READ_SEATS, '#seats-inc', 1500)
    if (!up.clicked || up.value !== '5000') return failWith(`increase from 4999 gives ${up.value}`)
    const top = await probe<Snapshot>(ctx.page, READ_STATE, undefined, 1500)
    if (top.disabled['seats-inc'] !== true) return failWith('increase is enabled at 5000')
    await probe(ctx.page, RUN_STEPS, [{ set: { seats: '5000' } }], 1500)
    await probe(ctx.page, CLICK_AND_READ_SEATS, '#seats-dec', 1500)
    const down = await probe<{ clicked: boolean; value: string | null }>(ctx.page, CLICK_AND_READ_SEATS, '#seats-dec', 1500)
    if (!down.clicked || down.value !== '4998') return failWith(`two decreases from 5000 give ${down.value}`)
    return { passed: true, detail: 'invalid strings rejected; " 7 " and "007" accepted; stepper bounds hold' }
  }
)

// ---------------------------------------------------------------------------
// pricing-keyboard (10)
// ---------------------------------------------------------------------------

const CONTRACT_STOP = new Set([
  'starter', 'team', 'scale', 'billing-monthly', 'billing-annual', 'seats-dec', 'seats', 'seats-inc',
  'promo', 'promo-apply', 'region', 'checkout',
])

/** Billing radios collapse to the one stop "billing"; other identities keep their name. */
function stopName(identity: string): string {
  return identity.startsWith('billing-') ? 'billing' : identity
}

/** WCAG 2.2 1.4.11: a focus indicator must contrast 3:1 with the colours beside it. */
const FOCUS_INDICATOR_MIN = 3

/**
 * The opaque colour outside a control: its ancestors' painted layers (nearest first,
 * alpha times opacity), with the page canvas last. The canvas is opaque (the root
 * background, else the used Canvas colour, read in the page), so compositing from it up
 * gives the dark card behind a translucent card over a dark page, not white.
 */
export function backdropOf(layers: readonly RGBA[]): RGBA {
  let acc: RGBA = [0, 0, 0, 0]
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    if (layer[3] > 0) acc = compositeOver(layer, acc)
  }
  return acc
}

/**
 * A focus ring is visible when it has a style other than none, a width of at least
 * 1 px, a colour with some opacity, and at least 3:1 contrast with the paint it is
 * drawn on. A ring outside the border (offset 0 or more) is drawn on the colour outside
 * the control (backdropOf its ancestors); an inset ring (negative offset) is drawn on the
 * control's own background, composited over that colour. A ring that differs from its
 * paint by a few levels (a dark ring on a dark page) is not a visible indicator.
 */
function visibleRing(s: FocusStyle): boolean {
  const width = parseFloat(s.outlineWidth)
  if (s.outlineStyle === 'none' || !Number.isFinite(width) || width < 1) return false
  if (s.outlineRgba === null || s.backgroundRgba === null) return false
  if (s.outlineRgba[3] <= 0) return false
  const outside = backdropOf(s.backdrop)
  const offset = parseFloat(s.outlineOffset)
  const drawnOn: RGBA = Number.isFinite(offset) && offset < 0 ? compositeOver(s.backgroundRgba, outside) : outside
  return contrastRatio(compositeOver(s.outlineRgba, drawnOn), drawnOn) >= FOCUS_INDICATOR_MIN
}

/** The painted style of one element changed on focus: its ring, shadow, border colour or background. */
function paintChanged(focused: FocusStyle, unfocused: FocusStyle): boolean {
  const ringDiffers =
    visibleRing(focused) &&
    (focused.outlineStyle !== unfocused.outlineStyle ||
      focused.outlineWidth !== unfocused.outlineWidth ||
      focused.outlineColor !== unfocused.outlineColor)
  return (
    ringDiffers ||
    focused.boxShadow !== unfocused.boxShadow ||
    focused.borderColor !== unfocused.borderColor ||
    focused.backgroundColor !== unfocused.backgroundColor
  )
}

/** A focused stop shows a change on itself or, for a visually hidden radio, on its label. */
function focusDiffers(focused: TabStop, unfocused: TabStop): boolean {
  if (paintChanged(focused.style, unfocused.style)) return true
  return focused.label !== null && unfocused.label !== null && paintChanged(focused.label, unfocused.label)
}

export const pricingKeyboard = defineCheck(
  'pricing-keyboard',
  10,
  'Keyboard operability, the stated focus order, and a visible focus indicator on every control.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.keyboard)
    if (gate !== null) return failWith(gate)

    const walk: ContractTabWalk = await tabWalkContract(page, 30)
    const stops: string[] = []
    for (const v of walk.visits) {
      if (!CONTRACT_STOP.has(v.identity)) continue
      const name = stopName(v.identity)
      if (stops[stops.length - 1] !== name) stops.push(name)
    }
    if (stops.join('|') !== TAB_ORDER.join('|')) {
      return failWith(`tab order ${stops.join(' > ')}`)
    }

    const unfocused = new Map<string, TabStop>()
    for (const stop of walk.unfocusedAfter) unfocused.set(stop.identity, stop)
    for (const v of walk.visits) {
      if (!CONTRACT_STOP.has(v.identity)) continue
      const before = unfocused.get(v.identity)
      if (before === undefined) return failWith(`${v.identity} has no unfocused style`)
      if (!focusDiffers(v, before)) return failWith(`no focus indicator with 3:1 contrast on ${v.identity}`)
    }
    if (tools.aborted()) return failWith('aborted')

    // Keys only: Space on Scale, ArrowRight on the billing group, End and Backspace then 9 in seats, Enter on the code.
    if (!(await probe<boolean>(page, FOCUS_SELECTOR, `button[data-plan="${KEY_SCENARIO_PLAN}"]`, 1500))) {
      return failWith('Scale cannot take focus')
    }
    await bounded(page.keyboard.press('Space'), 1500, 'Space')
    const afterSpace = await probe<Snapshot>(page, READ_STATE, undefined, 1500)
    if (afterSpace.pressed[KEY_SCENARIO_PLAN] !== 'true') return failWith('Space did not press Scale')

    if (!(await probe<boolean>(page, FOCUS_SELECTOR, '#billing-monthly', 1500))) {
      return failWith('#billing-monthly cannot take focus')
    }
    await bounded(page.keyboard.press('ArrowRight'), 1500, 'ArrowRight')
    const afterArrow = await probe<Snapshot>(page, READ_STATE, undefined, 1500)
    if (!afterArrow.annual) return failWith('ArrowRight did not select annual')
    if (!((reading(afterArrow, 'annual-discount')?.cents ?? '0') !== '0')) {
      return failWith('annual discount still zero after ArrowRight')
    }

    if (!(await probe<boolean>(page, FOCUS_SELECTOR, '#seats', 1500))) {
      return failWith('#seats cannot take focus')
    }
    await bounded(page.keyboard.press('End'), 1500, 'End')
    let presses = 0
    let value = await probe<string>(page, READ_VALUE_SOURCE, undefined, 1500)
    while (value.length > 0 && presses < 12) {
      await bounded(page.keyboard.press('Backspace'), 1500, 'Backspace')
      presses++
      value = await probe<string>(page, READ_VALUE_SOURCE, undefined, 1500)
    }
    if (value.length > 0) return failWith('Backspace did not empty #seats')
    await bounded(page.keyboard.press(String(KEY_SCENARIO_SEATS)), 1500, 'digit')
    const afterSeats = await probe<Snapshot>(page, READ_STATE, undefined, 1500)
    const wantSeats = { plan: KEY_SCENARIO_PLAN, seats: KEY_SCENARIO_SEATS, annual: true, promo: '', region: 'none' as const }
    const seatsMismatch = compareReference(afterSeats, wantSeats)
    if (seatsMismatch !== null) return failWith(`typed seats: ${seatsMismatch}`)

    if (!(await probe<boolean>(page, FOCUS_SELECTOR, '#promo', 1500))) {
      return failWith('#promo cannot take focus')
    }
    await bounded(page.keyboard.type(KEY_SCENARIO_PROMO), 1500, 'type code')
    await bounded(page.keyboard.press('Enter'), 1500, 'Enter')
    await settle(page)
    const afterPromo = await probe<Snapshot>(page, READ_STATE, undefined, 1500)
    if (afterPromo.promo?.state !== 'applied') return failWith(`Enter in #promo gave ${afterPromo.promo?.state}`)
    return { passed: true, detail: `${stops.length} stops in order; focus rings visible; keys-only steps work` }
  }
)

// ---------------------------------------------------------------------------
// pricing-accessible-names (8)
// ---------------------------------------------------------------------------

/** The first button line of an ARIA snapshot: - button "name" */
const ARIA_BUTTON_NAME = /^\s*-\s*button\s+"((?:[^"\\]|\\.)*)"/m

export const pricingAccessibleNames = defineCheck(
  'pricing-accessible-names',
  8,
  'Roles and accessible names of every control, plus the landmarks and the live region.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.names)
    if (gate !== null) return failWith(gate)

    const failures: string[] = []
    const expectOne = async (label: string, locator: Locator): Promise<void> => {
      const n = await bounded(locator.count(), 1500, 'locator count')
      if (n !== 1) failures.push(`${label} matches ${n}`)
    }

    const group = page.getByRole('radiogroup', { name: 'Billing period', exact: true })
    await expectOne('radiogroup Billing period', group)
    if ((await bounded(group.locator('#billing-monthly, #billing-annual').count(), 1500, 'radio count')) !== 2) {
      failures.push('billing group lacks both radios')
    }
    await expectOne('radio Monthly', page.getByRole('radio', { name: 'Monthly', exact: true }).and(page.locator('#billing-monthly')))
    await expectOne('radio Annual', page.getByRole('radio', { name: 'Annual', exact: true }).and(page.locator('#billing-annual')))
    // The seats field is a text box or a spin button (a stepper with ARIA spinbutton semantics).
    const seats = page.getByRole('textbox', { name: 'Seats', exact: true }).or(page.getByRole('spinbutton', { name: 'Seats', exact: true }))
    await expectOne('textbox or spinbutton Seats', seats.and(page.locator('#seats')))
    await expectOne('button Decrease seats', page.getByRole('button', { name: 'Decrease seats', exact: true }).and(page.locator('#seats-dec')))
    await expectOne('button Increase seats', page.getByRole('button', { name: 'Increase seats', exact: true }).and(page.locator('#seats-inc')))
    await expectOne('button Apply promo code', page.getByRole('button', { name: 'Apply promo code', exact: true }).and(page.locator('#promo-apply')))
    await expectOne('textbox Promo code', page.getByRole('textbox', { name: 'Promo code', exact: true }).and(page.locator('#promo')))
    await expectOne('combobox Tax region', page.getByRole('combobox', { name: 'Tax region', exact: true }).and(page.locator('#region')))
    for (const plan of CONTRACT_PLANS) {
      const name = PLAN_NAMES[plan]
      await expectOne(`plan button ${name}`, page.getByRole('button', { name }).and(page.locator(`button[data-plan="${plan}"]`)))
    }
    if (tools.aborted()) return failWith('aborted')

    // Each plan button's own accessible name: it contains its plan name, and the three names differ.
    const names: Partial<Record<PlanName, string>> = {}
    for (const plan of CONTRACT_PLANS) {
      const yaml = await bounded(
        page.locator(`button[data-plan="${plan}"]`).ariaSnapshot({ timeout: 1500 }),
        1500,
        `${plan} button name`
      )
      const match = ARIA_BUTTON_NAME.exec(yaml)
      if (match === null) {
        failures.push(`${PLAN_NAMES[plan]} button has no readable name`)
        continue
      }
      names[plan] = match[1]!.replace(/\\(.)/g, '$1')
    }
    for (const plan of CONTRACT_PLANS) {
      const n = names[plan]
      if (n !== undefined && !n.toLowerCase().includes(PLAN_NAMES[plan].toLowerCase())) {
        failures.push(`${PLAN_NAMES[plan]} button is named "${n}"`)
      }
    }
    if (Object.keys(names).length === CONTRACT_PLANS.length && new Set(Object.values(names)).size < CONTRACT_PLANS.length) {
      failures.push('the three plan buttons do not have three different names')
    }

    const facts = await probe<{ lang: string; h1Count: number; summaryInMain: boolean; liveValue: string | null; pressedCount: number }>(
      page,
      DOCUMENT_FACTS,
      undefined,
      2000
    )
    if (!facts.lang.toLowerCase().startsWith('en')) failures.push(`html lang "${facts.lang}"`)
    if (facts.h1Count !== 1) failures.push(`${facts.h1Count} h1 elements`)
    if (!facts.summaryInMain) failures.push('#summary is not inside main')
    if (facts.liveValue !== 'polite') failures.push('#total has no aria-live polite ancestor')
    if (facts.pressedCount !== 1) failures.push(`${facts.pressedCount} plan buttons pressed`)
    if (failures.length > 0) return failWith(failures[0]! + (failures.length > 1 ? ` (+${failures.length - 1} more)` : ''))
    return { passed: true, detail: 'all control names, landmarks and the live region match; plan names differ' }
  }
)

// ---------------------------------------------------------------------------
// pricing-contrast (8)
// ---------------------------------------------------------------------------

function rowText(r: ContrastRow): string {
  const measure = r.failure !== null ? r.failure : r.ratio === null ? 'n/a' : `${r.ratio.toFixed(2)}:1`
  return `${r.tag}${r.id ? '#' + r.id : ''} ${measure} (need ${r.required})`
}

export const pricingContrast = defineCheck(
  'pricing-contrast',
  8,
  'Computed text contrast meets 4.5:1 (3:1 for large text) in the default, seat-error and promo-error states.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.contrast)
    if (gate !== null) return failWith(gate)
    // Reveal-on-scroll content is shown before the audit, so it is measured and not skipped.
    await revealAll(page)

    const states: Array<{ name: string; prepare: () => Promise<string[]> }> = [
      { name: 'default', prepare: async () => [] },
      {
        name: 'seat-error',
        prepare: async () => (await probe<Snapshot>(page, APPLY_AND_READ, { set: { seats: '' } }, 2000)).applyMissing,
      },
      {
        name: 'promo-error',
        prepare: async () =>
          (await probe<Snapshot>(page, APPLY_AND_READ, { set: { seats: '5', promo: CONTRAST_STATE_PROMO_UNKNOWN } }, 2000)).applyMissing,
      },
    ]
    const lines: string[] = []
    // The default state's results: a later state re-measures only the candidates whose fingerprint changed.
    let baseline: ContrastBaseline | undefined
    for (const state of states) {
      if (tools.aborted()) return failWith('aborted')
      const missing = await state.prepare()
      if (missing.length > 0) return failWith(`${state.name} state cannot be reached (missing ${missing.join(', ')})`)
      let audit: ContrastAudit
      try {
        audit = await contrastAudit(page, baseline)
      } catch (error) {
        // A screenshot or probe that runs past its bound under heavy machine load is a load failure, not a contrast
        // failure: the detail says so, so a sweep can tell it apart and retry the run.
        const message = error instanceof Error ? error.message : String(error)
        if (/timed out|timeout/i.test(message)) {
          return failWith(`load: the contrast audit in the ${state.name} state timed out under machine load (${message})`)
        }
        throw error
      }
      if (baseline === undefined) baseline = audit.baseline
      if (audit.checked < CONTRAST_MIN_AUDITED) {
        return failWith(`${state.name}: only ${audit.checked} text elements audited (need ${CONTRAST_MIN_AUDITED})`)
      }
      if (!audit.ok) {
        const f = audit.failing
        const culprit = f ? rowText(f) : 'unknown'
        const lowest = audit.lowest.slice(0, 3).map(rowText)
        return failWith(`${state.name}: ${audit.failCount} failing; first ${culprit}; lowest ${lowest.join('; ')}`)
      }
      const lowest = audit.lowest.slice(0, 3).map(rowText)
      lines.push(`${state.name}: ${audit.checked} checked, lowest ${lowest.join('; ')}`)
    }
    return { passed: true, detail: `all text passes in three states; ${lines.join(' | ')}` }
  }
)

// ---------------------------------------------------------------------------
// pricing-responsive (10)
// ---------------------------------------------------------------------------

const RESPONSIVE_CONTROLS = [
  'button[data-plan="starter"]', 'button[data-plan="team"]', 'button[data-plan="scale"]',
  '#billing-monthly', '#billing-annual',
  '#seats-dec', '#seats', '#seats-inc',
  '#promo', '#promo-apply', '#region', '#checkout',
  '#subtotal', '#annual-discount', '#promo-discount', '#tax', '#total', '#per-seat',
]

interface ResponsiveRead {
  scrollWidth: number
  clientWidth: number
  innerWidth: number
  controls: Array<{ sel: string; missing: boolean; left?: number; right?: number; shown?: boolean; hitOk?: boolean; hit?: string | null }>
  cards: Array<{ left: number; right: number; top: number; bottom: number }>
  breakdown: { left: number; right: number; width: number; shown: boolean } | null
}

export const pricingResponsive = defineCheck(
  'pricing-responsive',
  10,
  'No horizontal overflow at 390, 768 and 1440 px, every control inside the viewport and reachable, and the cards switch from a row to a stack.',
  async (ctx: CheckContext, tools: CheckTools): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.responsive)
    if (gate !== null) return failWith(gate)

    for (const width of RESPONSIVE_WIDTHS) {
      if (tools.aborted()) return failWith('aborted')
      const read = await withViewport(page, width, RESPONSIVE_HEIGHT, () =>
        probe<ResponsiveRead>(page, RESPONSIVE_READ, { controls: RESPONSIVE_CONTROLS, cards: '[data-plan-card]', breakdown: '#breakdown' }, 4000)
      )
      const at = `${width}px`
      if (read.scrollWidth > read.clientWidth + LAYOUT_TOLERANCE_PX) {
        return failWith(`${at}: horizontal overflow ${read.scrollWidth} > ${read.clientWidth}`)
      }
      for (const c of read.controls) {
        if (c.missing) return failWith(`${at}: ${c.sel} missing`)
        if (c.shown !== true) return failWith(`${at}: ${c.sel} not shown`)
        if ((c.left ?? 0) < -LAYOUT_TOLERANCE_PX || (c.right ?? 0) > read.innerWidth + LAYOUT_TOLERANCE_PX) {
          return failWith(`${at}: ${c.sel} outside the viewport (${c.left} to ${c.right})`)
        }
        if (c.hitOk !== true) return failWith(`${at}: ${c.sel} is covered by ${c.hit ?? 'nothing'}`)
      }
      if (read.breakdown === null || read.breakdown.width < BREAKDOWN_MIN_PX) {
        return failWith(`${at}: breakdown narrower than ${BREAKDOWN_MIN_PX}px`)
      }
      if (read.breakdown.right > read.innerWidth + LAYOUT_TOLERANCE_PX || read.breakdown.left < -LAYOUT_TOLERANCE_PX) {
        return failWith(`${at}: breakdown outside the viewport`)
      }
      const cards = read.cards
      if (cards.length !== 3) return failWith(`${at}: ${cards.length} plan cards`)
      const tol = LAYOUT_TOLERANCE_PX
      const xDisjoint = (a: (typeof cards)[number], b: (typeof cards)[number]): boolean => a.right <= b.left + tol || b.right <= a.left + tol
      const yOverlap = (a: (typeof cards)[number], b: (typeof cards)[number]): boolean => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0
      const yDisjoint = (a: (typeof cards)[number], b: (typeof cards)[number]): boolean => a.bottom <= b.top + tol || b.bottom <= a.top + tol
      const xOverlap = (a: (typeof cards)[number], b: (typeof cards)[number]): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0
      const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]]
      if (width === 1440) {
        for (const [i, j] of pairs) {
          if (!(xDisjoint(cards[i]!, cards[j]!) && yOverlap(cards[i]!, cards[j]!))) {
            return failWith(`1440px: plan cards ${i} and ${j} are not side by side in one row`)
          }
        }
      }
      if (width === 390) {
        for (const [i, j] of pairs) {
          if (!(yDisjoint(cards[i]!, cards[j]!) && xOverlap(cards[i]!, cards[j]!))) {
            return failWith(`390px: plan cards ${i} and ${j} are not stacked in one column`)
          }
        }
      }
    }
    return { passed: true, detail: 'no overflow at 390, 768 or 1440; cards row at 1440 and stack at 390' }
  }
)

// ---------------------------------------------------------------------------
// pricing-breakdown-geometry (10)
// ---------------------------------------------------------------------------

/** A segment paints when it has a visible background colour or a background image. */
function paints(seg: SegmentReading): boolean {
  if (seg.image !== 'none') return true
  return seg.backgroundRgba !== null && seg.backgroundRgba[3] > 0
}

export const pricingBreakdownGeometry = defineCheck(
  'pricing-breakdown-geometry',
  10,
  'What is drawn matches what is reported: bar segment widths are proportional to net, tax and savings.',
  async (ctx: CheckContext): Promise<CheckOutcome> => {
    const page = ctx.page
    const gate = await ready(ctx, NEEDS.breakdown)
    if (gate !== null) return failWith(gate)

    const snaps = await withViewport(page, BREAKDOWN_VIEWPORT_WIDTH, BREAKDOWN_VIEWPORT_HEIGHT, () =>
      probe<Snapshot[]>(
        page,
        RUN_STEPS,
        BREAKDOWN_STATES.map((s) => ({ set: scenarioArg(s) })),
        4000
      )
    )

    // Reach: the page must change its amounts where the guard states say it should.
    // Constants in the markup give shares of 1, 0, 0 and cannot pass the four-state comparison below.
    const savingsOf = (snap: Snapshot): bigint | null => {
      const a = centsOf(snap, 'annual-discount')
      const p = centsOf(snap, 'promo-discount')
      return a === null || p === null ? null : a + p
    }
    const stateLabel = (i: number): string => labelOf(BREAKDOWN_STATES[i]!)
    const tax0 = centsOf(snaps[BREAKDOWN_REACH_TAX_STATE]!, 'tax')
    const tax1 = centsOf(snaps[BREAKDOWN_REACH_TAX_SAVINGS_STATE]!, 'tax')
    const save1 = savingsOf(snaps[BREAKDOWN_REACH_TAX_SAVINGS_STATE]!)
    const save3 = savingsOf(snaps[BREAKDOWN_REACH_SAVINGS_STATE]!)
    if (tax0 === null || tax0 <= 0n) return failWith(`${stateLabel(BREAKDOWN_REACH_TAX_STATE)} shows no tax; the tax segment cannot be measured`)
    if (tax1 === null || tax1 <= 0n || save1 === null || save1 <= 0n) {
      return failWith(`${stateLabel(BREAKDOWN_REACH_TAX_SAVINGS_STATE)} shows no tax or no savings`)
    }
    if (save3 === null || save3 <= 0n) return failWith(`${stateLabel(BREAKDOWN_REACH_SAVINGS_STATE)} shows no savings`)
    const signatures = snaps.map((s) => AMOUNT_IDS.map((id) => reading(s, id)?.cents ?? '').join('|'))
    if (new Set(signatures).size < 2) return failWith('the four states show the same amounts')

    for (let i = 0; i < BREAKDOWN_STATES.length; i++) {
      const s = BREAKDOWN_STATES[i]!
      const snap = snaps[i]!
      const label = labelOf(s)
      if (snap.bar === null || snap.bar.segments.some((seg) => seg === null)) {
        return failWith(`${label}: segments net, tax, saved not found`)
      }
      const seg = snap.bar.segments as SegmentReading[]
      const total = centsOf(snap, 'total')
      const tax = centsOf(snap, 'tax')
      const annual = centsOf(snap, 'annual-discount')
      const promo = centsOf(snap, 'promo-discount')
      if (total === null || tax === null || annual === null || promo === null) {
        return failWith(`${label}: amounts are not whole cents`)
      }
      const amounts = [total - tax, tax, annual + promo]
      const sum = amounts[0]! + amounts[1]! + amounts[2]!
      const widths = seg.map((x) => x.width)
      const W = widths.reduce((a, b) => a + b, 0)
      if (!(W >= BREAKDOWN_MIN_SUM_PX && W <= snap.bar.width + 1)) {
        return failWith(`${label}: drawn bar ${W.toFixed(2)}px outside ${BREAKDOWN_MIN_SUM_PX} to ${(snap.bar.width + 1).toFixed(2)}`)
      }
      const names = ['net', 'tax', 'saved']
      for (let k = 0; k < 3; k++) {
        const name = names[k]!
        const amount = amounts[k]!
        if (amount === 0n) {
          if (widths[k]! > 1) return failWith(`${label}: ${name} is zero but drawn ${widths[k]!.toFixed(2)}px`)
          continue
        }
        if (!seg[k]!.shown) return failWith(`${label}: ${name} segment is not shown`)
        if (!paints(seg[k]!)) return failWith(`${label}: ${name} segment has no visible background`)
        const drawn = widths[k]! / W
        const reported = Number(amount) / Number(sum)
        if (Math.abs(drawn - reported) > SHARE_TOLERANCE) {
          return failWith(`${label}: ${name} drawn ${drawn.toFixed(4)} vs reported ${reported.toFixed(4)}`)
        }
      }
      // Row and order apply to the drawn (non-zero) segments; a zero amount may be hidden (display none).
      const active = [0, 1, 2].filter((k) => amounts[k] !== 0n)
      if (active.length > 0) {
        const top = Math.max(...active.map((k) => seg[k]!.top))
        const bottom = Math.min(...active.map((k) => seg[k]!.bottom))
        if (!(bottom > top)) return failWith(`${label}: segments do not share a row`)
        for (let j = 0; j + 1 < active.length; j++) {
          if (!(seg[active[j]!]!.left <= seg[active[j + 1]!]!.left + 0.5)) {
            return failWith(`${label}: segments are not ordered net, tax, saved`)
          }
        }
      }
    }
    return { passed: true, detail: `shares within ${SHARE_TOLERANCE} in four states; amounts change between states` }
  }
)

/** The checks keyed by name, in the order the specification gives them. */
export const checks: Record<string, CheckFn> = {
  'pricing-graduated-tiers': pricingGraduatedTiers,
  'pricing-discount-order': pricingDiscountOrder,
  'pricing-exact-rounding': pricingExactRounding,
  'pricing-display-format': pricingDisplayFormat,
  'pricing-seats-validation': pricingSeatsValidation,
  'pricing-keyboard': pricingKeyboard,
  'pricing-accessible-names': pricingAccessibleNames,
  'pricing-contrast': pricingContrast,
  'pricing-responsive': pricingResponsive,
  'pricing-breakdown-geometry': pricingBreakdownGeometry,
}

export const CHECK_NAMES: readonly string[] = Object.keys(checks)

/** Checks as an array in specification order, for the matrix and the task row. */
export const CHECK_LIST: readonly CheckFn[] = Object.values(checks)
