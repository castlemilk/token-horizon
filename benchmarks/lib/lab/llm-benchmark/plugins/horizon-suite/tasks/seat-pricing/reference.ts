/**
 * Independent reference for the seat-pricing prompt, in exact BigInt arithmetic.
 * Ported from the chief designer's pricing.cjs (the same half-up formula,
 * (2n*num + den) / (2n*den), applied once per stated rounding step).
 *
 * Pure: no DOM, no clock, no host time zone. Checks call it; they never trust the
 * page's own arithmetic.
 */
import type { PlanName, RegionCode, Scenario } from './hidden'

export const LIST_PRICE_CENTS: Readonly<Record<PlanName, bigint>> = {
  starter: 900n,
  team: 1450n,
  scale: 2375n,
}

/** Tax rate per 100000 (ca 7.25% = 7250). */
export const RATE_PER_100000: Readonly<Record<RegionCode, bigint>> = {
  none: 0n,
  ca: 7250n,
  ny: 8875n,
  uk: 20000n,
  de: 19000n,
}

export const SEAT_MIN = 1
export const SEAT_MAX = 5000
export const FLAT50_CENTS = 5000n

export interface Priced {
  subtotal: bigint
  annualDiscount: bigint
  promoDiscount: bigint
  taxable: bigint
  tax: bigint
  total: bigint
  perSeat: bigint
  /** 'none' (no code), 'applied' (valid code in effect) or 'error'. */
  promoState: 'none' | 'applied' | 'error'
  /** The normalised code: trimmed and upper-cased; '' for none. */
  promoCode: string
}

/** Round half up for non-negative integers: num/den rounded, exact halves go up. */
export function roundHalfUp(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) throw new RangeError('roundHalfUp needs num >= 0 and den > 0')
  return (2n * num + den) / (2n * den)
}

/** Codes match case-insensitively after trimming whitespace. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * Parse the seats text the way the prompt defines it: trimmed, only ASCII digits,
 * value 1 to 5000. Returns null when the text is invalid.
 */
export function parseSeats(text: string): number | null {
  const t = text.trim()
  if (!/^[0-9]+$/.test(t)) return null
  const n = Number(t)
  return n >= SEAT_MIN && n <= SEAT_MAX ? n : null
}

/** The graduated weighted percentage (100 = full list price per seat, summed over seats). */
export function weightedPercent(seats: number): bigint {
  const n = BigInt(seats)
  const t1 = n < 10n ? n : 10n
  const t2 = n > 10n ? (n < 50n ? n - 10n : 40n) : 0n
  const t3 = n > 50n ? (n < 200n ? n - 50n : 150n) : 0n
  const t4 = n > 200n ? n - 200n : 0n
  return t1 * 100n + t2 * 90n + t3 * 80n + t4 * 70n
}

/** Price one scenario. promo is the raw code text ('' for none). */
export function priceScenario(s: Scenario): Priced {
  const seats = BigInt(s.seats)
  const months = s.annual ? 12n : 1n
  const subtotal = roundHalfUp(months * LIST_PRICE_CENTS[s.plan] * weightedPercent(s.seats), 100n)
  const annualDiscount = s.annual ? roundHalfUp(subtotal * 17n, 100n) : 0n
  const base = subtotal - annualDiscount

  const code = normaliseCode(s.promo)
  let promoDiscount = 0n
  let promoState: Priced['promoState'] = 'none'
  if (code === '') {
    promoState = 'none'
  } else if (code === 'LAUNCH20') {
    promoDiscount = roundHalfUp(base * 20n, 100n)
    promoState = 'applied'
  } else if (code === 'FLAT50') {
    promoDiscount = base < FLAT50_CENTS ? base : FLAT50_CENTS
    promoState = 'applied'
  } else if (code === 'TEAM10' && s.plan !== 'starter' && s.seats >= 5) {
    promoDiscount = roundHalfUp(base * 10n, 100n)
    promoState = 'applied'
  } else {
    promoState = 'error'
  }

  const taxable = base - promoDiscount
  const tax = roundHalfUp(taxable * RATE_PER_100000[s.region], 100000n)
  const total = taxable + tax
  const perSeat = roundHalfUp(total, seats * months)
  return { subtotal, annualDiscount, promoDiscount, taxable, tax, total, perSeat, promoState, promoCode: code }
}

/** [subtotal, annual, promo, tax, total, perSeat] as plain numbers (all below 2^53). */
export function sixAmounts(p: Priced): [number, number, number, number, number, number] {
  return [p.subtotal, p.annualDiscount, p.promoDiscount, p.tax, p.total, p.perSeat].map((v) => Number(v)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
}

/** "$1,234.56" style text for a whole number of cents (discounts pass a sign separately). */
export function formatDollars(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (cents % 100n).toString().padStart(2, '0')
  return `$${whole}.${frac}`
}
