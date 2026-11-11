/**
 * Every hidden constant the seat-pricing checks and fixtures use. Single source:
 * checks.ts, fixtures.ts and the unit tests all import from here, so they cannot
 * drift. Nothing in this file may appear in the prompt (checks.test.ts asserts it).
 *
 * The money values are whole US cents. The rounding table and the discount steps
 * are the chief designer's brute-force results (scratchpad/chief/pricing.cjs); the
 * reference.ts implementation must reproduce every one of them (reference.test.ts).
 */

// v3: the sandbox sentence asks for <html lang="en">; the seats field may be a spinbutton; focus rings need 3:1 contrast; contrast reads fill colours and clipped gradients.
// v4: focus rings are judged on the composite of translucent ancestors (not white); the contrast icon rule composites the control's own translucent background and no longer exempts percentage, cover, contain, gradient-auto or oversized images.
export const HIDDEN_VERSION = 'seat-pricing/v4'

export type PlanName = 'starter' | 'team' | 'scale'
export type RegionCode = 'none' | 'ca' | 'ny' | 'uk' | 'de'

/** [subtotal, annualDiscount, promoDiscount, tax, total, perSeat], whole cents. */
export type SixAmounts = readonly [number, number, number, number, number, number]

/** One scenario the page is driven through. promo '' means no code. */
export interface Scenario {
  plan: PlanName
  seats: number
  annual: boolean
  promo: string
  region: RegionCode
}

// ---------------------------------------------------------------------------
// pricing-graduated-tiers: every plan at each of these seat counts, monthly, no
// promo, no tax. The BigInt reference supplies the expected subtotal and total.
// ---------------------------------------------------------------------------
export const TIER_PLANS: readonly PlanName[] = ['starter', 'team', 'scale']
export const TIER_SEATS: readonly number[] = [1, 10, 11, 37, 50, 51, 200, 201, 1234, 5000]

/** Scale subtotal (= total, no tax) in cents for the TIER_SEATS list: spec anchor. */
export const TIER_SCALE_SUBTOTALS_CENTS: readonly number[] = [
  2375, 23750, 25888, 81463, 109250, 111150, 394250, 395913, 2113275, 8374250,
]

// ---------------------------------------------------------------------------
// pricing-discount-order: the promo state machine and the order of discounts.
// Step (a) is typed with real keyboard input; the rest are page-state steps.
// ---------------------------------------------------------------------------
export const DISCOUNT_STEP_A = {
  plan: 'scale' as PlanName,
  seats: 8,
  annual: true,
  typed: '  launch20 ',
  region: 'none' as RegionCode,
  state: 'applied',
  amounts: [228000, 38760, 37848, 0, 151392, 1577] as SixAmounts,
}

/**
 * Page-state steps after step (a). `promo` undefined means the step does not touch
 * the code: the page must re-evaluate the code that is already applied.
 */
export interface DiscountStep {
  label: string
  plan: PlanName
  seats: number
  annual: boolean
  promo?: string
  region: RegionCode
  state: 'none' | 'applied' | 'error'
  amounts: SixAmounts
}

export const DISCOUNT_STEPS: readonly DiscountStep[] = [
  { label: 'b', plan: 'team', seats: 9, annual: true, promo: 'FLAT50', region: 'de', state: 'applied',
    amounts: [156600, 26622, 5000, 23746, 148724, 1377] },
  { label: 'c1', plan: 'starter', seats: 1, annual: false, promo: 'FLAT50', region: 'none', state: 'applied',
    amounts: [900, 0, 900, 0, 0, 0] },
  { label: 'c2', plan: 'starter', seats: 9, annual: false, promo: 'FLAT50', region: 'none', state: 'applied',
    amounts: [8100, 0, 5000, 0, 3100, 344] },
  { label: 'd1', plan: 'team', seats: 5, annual: false, promo: 'TEAM10', region: 'none', state: 'applied',
    amounts: [7250, 0, 725, 0, 6525, 1305] },
  // d2 keeps the code: the page must drop TEAM10 when the seat count falls below 5.
  { label: 'd2', plan: 'team', seats: 4, annual: false, region: 'none', state: 'error',
    amounts: [5800, 0, 0, 0, 5800, 1450] },
  // d3 keeps the code: valid again at 5 seats.
  { label: 'd3', plan: 'team', seats: 5, annual: false, region: 'none', state: 'applied',
    amounts: [7250, 0, 725, 0, 6525, 1305] },
  // d4 keeps the code: TEAM10 is invalid on Starter.
  { label: 'd4', plan: 'starter', seats: 5, annual: false, region: 'none', state: 'error',
    amounts: [4500, 0, 0, 0, 4500, 900] },
  // e: an unknown code is an error with zero discount.
  { label: 'e', plan: 'starter', seats: 5, annual: false, promo: 'SAVE99', region: 'none', state: 'error',
    amounts: [4500, 0, 0, 0, 4500, 900] },
  // f: applying an empty value removes the code.
  { label: 'f', plan: 'starter', seats: 5, annual: false, promo: '', region: 'none', state: 'none',
    amounts: [4500, 0, 0, 0, 4500, 900] },
]

// ---------------------------------------------------------------------------
// pricing-exact-rounding: twelve cases where a float style or a toFixed step lands
// one cent away. Expected amounts are the exact half-up results.
// ---------------------------------------------------------------------------
export interface RoundingCase {
  plan: PlanName
  seats: number
  annual: boolean
  promo: string
  region: RegionCode
  expect: SixAmounts
}

export const ROUNDING_CASES: readonly RoundingCase[] = [
  { plan: 'team', seats: 4, annual: false, promo: '', region: 'ca', expect: [5800, 0, 0, 421, 6221, 1555] },
  { plan: 'team', seats: 5, annual: false, promo: 'LAUNCH20', region: 'ca', expect: [7250, 0, 1450, 421, 6221, 1244] },
  { plan: 'team', seats: 8, annual: false, promo: 'FLAT50', region: 'ca', expect: [11600, 0, 5000, 479, 7079, 885] },
  { plan: 'scale', seats: 6, annual: false, promo: 'LAUNCH20', region: 'ca', expect: [14250, 0, 2850, 827, 12227, 2038] },
  { plan: 'starter', seats: 2, annual: false, promo: '', region: 'ca', expect: [1800, 0, 0, 131, 1931, 966] },
  { plan: 'starter', seats: 6, annual: false, promo: '', region: 'ca', expect: [5400, 0, 0, 392, 5792, 965] },
  { plan: 'scale', seats: 8, annual: false, promo: '', region: 'ca', expect: [19000, 0, 0, 1378, 20378, 2547] },
  { plan: 'scale', seats: 4, annual: false, promo: 'LAUNCH20', region: 'ny', expect: [9500, 0, 1900, 675, 8275, 2069] },
  { plan: 'scale', seats: 3, annual: true, promo: '', region: 'uk', expect: [85500, 14535, 0, 14193, 85158, 2366] },
  { plan: 'scale', seats: 5, annual: true, promo: '', region: 'uk', expect: [142500, 24225, 0, 23655, 141930, 2366] },
  { plan: 'scale', seats: 9, annual: true, promo: '', region: 'uk', expect: [256500, 43605, 0, 42579, 255474, 2366] },
  { plan: 'scale', seats: 5, annual: true, promo: 'FLAT50', region: 'uk', expect: [142500, 24225, 5000, 22655, 135930, 2266] },
]

// ---------------------------------------------------------------------------
// pricing-display-format: four states, each with a different number of figures.
// The check compares the visible text with the page's own data-cents, so no
// expected amount is needed here.
// ---------------------------------------------------------------------------
export const DISPLAY_STATES: readonly Scenario[] = [
  { plan: 'starter', seats: 1, annual: false, promo: 'FLAT50', region: 'none' },
  { plan: 'team', seats: 7, annual: false, promo: '', region: 'none' },
  { plan: 'scale', seats: 137, annual: true, promo: 'LAUNCH20', region: 'ny' },
  { plan: 'scale', seats: 5000, annual: true, promo: '', region: 'none' },
]

// ---------------------------------------------------------------------------
// pricing-seats-validation
// ---------------------------------------------------------------------------
export const INVALID_SEATS_TEXT: readonly string[] = [
  '', '   ', '0', '000', '5001', '12.5', '1e3', '+5', '-3', '12abc', '0x10', '99999999999999999999',
]

/** Valid after trimming; the value must be 7 in both. */
export const VALID_ODD_SEATS: readonly { text: string; seats: number }[] = [
  { text: ' 7 ', seats: 7 },
  { text: '007', seats: 7 },
]

/** Digit-only data-cents at the two limits. */
export const LIMIT_SEATS_TEXT: readonly string[] = ['1', '5000']

export const VALIDATION_SCENARIO = { plan: 'team' as PlanName, annual: false, region: 'none' as RegionCode, promo: '' }

// ---------------------------------------------------------------------------
// pricing-keyboard
// ---------------------------------------------------------------------------
/** Contract identities in tab order. The billing group is one stop (native radios). */
export const TAB_ORDER: readonly string[] = [
  'starter', 'team', 'scale', 'billing', 'seats-dec', 'seats', 'seats-inc',
  'promo', 'promo-apply', 'region', 'checkout',
]
export const KEY_SCENARIO_SEATS = 9
export const KEY_SCENARIO_PROMO = 'launch20'
export const KEY_SCENARIO_PLAN: PlanName = 'scale'

// ---------------------------------------------------------------------------
// pricing-responsive
// ---------------------------------------------------------------------------
export const RESPONSIVE_WIDTHS: readonly number[] = [390, 768, 1440]
export const RESPONSIVE_HEIGHT = 900
/**
 * The 1 px tolerance the specification gives. A control or a breakdown edge may sit
 * up to this far outside the viewport on the left (-1 px) or right, and an overflow
 * up to this many px counts as none.
 */
export const LAYOUT_TOLERANCE_PX = 1
export const BREAKDOWN_MIN_PX = 240

// ---------------------------------------------------------------------------
// pricing-breakdown-geometry
// ---------------------------------------------------------------------------
export const BREAKDOWN_STATES: readonly Scenario[] = [
  { plan: 'team', seats: 7, annual: false, promo: '', region: 'ny' },
  { plan: 'scale', seats: 8, annual: true, promo: 'LAUNCH20', region: 'uk' },
  { plan: 'team', seats: 7, annual: false, promo: '', region: 'none' },
  { plan: 'starter', seats: 1, annual: false, promo: 'FLAT50', region: 'none' },
]
export const BREAKDOWN_VIEWPORT_WIDTH = 1024
export const BREAKDOWN_VIEWPORT_HEIGHT = 720
/** Maximum |share of drawn width - share of amount|. */
export const SHARE_TOLERANCE = 0.01
export const BREAKDOWN_MIN_SUM_PX = 239
/**
 * Reach guards. A page whose amounts never change (constants in the markup) cannot
 * show a correct bar or format, so a check also requires the page to reach states
 * where the amounts are non-zero and large. These only gate; they are not measured.
 * The four breakdown states are BREAKDOWN_STATES[0..3]: index 0 must carry tax,
 * index 1 tax and savings, index 3 savings.
 */
export const BREAKDOWN_REACH_TAX_STATE = 0
export const BREAKDOWN_REACH_TAX_SAVINGS_STATE = 1
export const BREAKDOWN_REACH_SAVINGS_STATE = 3
/** Display format: an amount of at least this many cents ($1,000.00) must appear in the 137-seat and 5000-seat states. */
export const DISPLAY_REACH_CENTS = 100000

// ---------------------------------------------------------------------------
// pricing-contrast
// ---------------------------------------------------------------------------
export const CONTRAST_NORMAL = 4.5
export const CONTRAST_LARGE = 3
export const CONTRAST_STATE_PROMO_UNKNOWN = 'SAVE99'
/**
 * A state's audit must cover at least this many text elements. The good artifact has
 * 63 to 65 audited elements in each state; a page below the floor is not audited
 * meaningfully (typically because its text is hidden or the audit scope is empty).
 */
export const CONTRAST_MIN_AUDITED = 20

// ---------------------------------------------------------------------------
// pricing-accessible-names
// ---------------------------------------------------------------------------
export const PLAN_NAMES: Readonly<Record<PlanName, string>> = { starter: 'Starter', team: 'Team', scale: 'Scale' }
