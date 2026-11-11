/**
 * Pure helpers for horizon-suite checks: polar geometry, CSS colour parsing,
 * channel distance, WCAG 2 contrast, a seeded PRNG, bit-exact deep equality and
 * integer-only civil calendar arithmetic.
 *
 * Runs in Node only. Nothing here reads the DOM, the wall clock or the host time
 * zone, so every expectation a check derives from these helpers is a function
 * of its integer or floating inputs alone.
 */

/** Pixel or colour as [r, g, b, a]: r, g, b in 0..255 and a in 0..1. */
export type RGBA = [number, number, number, number]

export interface Point {
  x: number
  y: number
}

/** Integer-safe modulus: the result has the sign of n, never negative for n > 0. */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/** Floor division for integers (Math.floor of the quotient). */
export function floorDiv(a: number, n: number): number {
  return Math.floor(a / n)
}

// ---------------------------------------------------------------------------
// Polar and line geometry (screen coordinates: y grows downwards)
// ---------------------------------------------------------------------------

/**
 * Clockwise angle from straight up, in radians: atan2(dx, -dy), in (-PI, PI].
 * NaN for a zero-length vector (0, 0), which has no direction: a hand of zero
 * length must not read as pointing somewhere.
 */
export function clockwiseAngleRad(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return NaN
  return Math.atan2(dx, -dy)
}

/**
 * Clockwise angle from straight up in degrees, normalised to [0, 360).
 * Straight up is 0, right is 90, down is 180, left is 270. NaN for (0, 0).
 */
export function clockwiseAngle(dx: number, dy: number): number {
  const deg = (clockwiseAngleRad(dx, dy) * 180) / Math.PI
  const wrapped = mod(deg, 360)
  return wrapped >= 360 ? 0 : wrapped
}

/**
 * Signed difference a - b on a circle, wrapped into [-period/2, period/2).
 * circularDifference(359, 1) is -2 and circularDifference(1, 359) is 2.
 * Use Math.abs for the unsigned distance.
 */
export function circularDifference(a: number, b: number, period = 360): number {
  const d = mod(a - b, period)
  return d >= period / 2 ? d - period : d
}

/** Perpendicular distance from p to the infinite line through a and b. */
export function pointLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) throw new Error('pointLineDistance: a and b must differ')
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / len
}

/** Foot of the perpendicular from p onto the infinite line through a and b. */
export function footOfPerpendicular(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d2 = dx * dx + dy * dy
  if (d2 === 0) throw new Error('footOfPerpendicular: a and b must differ')
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / d2
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/**
 * Which side of the directed line a -> b the point lies on: +1 left of it,
 * -1 right of it (in the y-down screen sense: the sign of the cross product),
 * 0 on it.
 */
export function sideOfLine(p: Point, a: Point, b: Point): -1 | 0 | 1 {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  return cross > 0 ? 1 : cross < 0 ? -1 : 0
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const NAMED_TRANSPARENT = 'transparent'

/**
 * One channel on the 0..255 scale. A percentage is a fraction of full scale in
 * both syntaxes; a bare number is 0..255 for rgb() and 0..1 for color(srgb).
 */
function parseChannel(token: string, isColorFunction: boolean): number {
  const t = token.trim()
  if (t === '') throw new Error(`parseCssColour: empty channel in "${token}"`)
  const clamp = (v: number): number => Math.min(255, Math.max(0, v))
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1))
    if (!Number.isFinite(pct)) throw new Error(`parseCssColour: bad channel "${token}"`)
    return clamp((pct / 100) * 255)
  }
  const v = Number(t)
  if (!Number.isFinite(v)) throw new Error(`parseCssColour: bad channel "${token}"`)
  return clamp(isColorFunction ? v * 255 : v)
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1
  const t = token.trim()
  const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t)
  if (!Number.isFinite(v)) throw new Error(`parseCssColour: bad alpha "${token}"`)
  return Math.min(1, Math.max(0, v))
}

/**
 * Parse a CSS colour string into RGBA. Accepts:
 *  - rgb(r, g, b), rgba(r, g, b, a) and the space syntax rgb(r g b / a),
 *    with integer, decimal or percentage channels;
 *  - color(srgb r g b) and color(srgb r g b / a) with 0..1 channels, the form
 *    Chromium returns for some computed colours;
 *  - #rgb, #rgba, #rrggbb and #rrggbbaa;
 *  - the keyword transparent.
 * Throws on anything else, so a check never silently treats an unknown colour
 * as black or white.
 */
export function parseCssColour(input: string): RGBA {
  const s = input.trim().toLowerCase()
  if (s === NAMED_TRANSPARENT) return [0, 0, 0, 0]

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }

  const fn = /^(rgba?|color)\((.*)\)$/.exec(s)
  if (!fn) throw new Error(`parseCssColour: unsupported colour "${input}"`)
  const isColorFunction = fn[1] === 'color'
  let body = fn[2]!.trim()
  if (isColorFunction) {
    const space = /^srgb\s+/.exec(body)
    if (!space) throw new Error(`parseCssColour: only color(srgb ...) is supported, got "${input}"`)
    body = body.slice(space[0].length)
  }

  let main: string
  let alphaToken: string | undefined
  if (body.includes('/')) {
    const [m, a] = body.split('/')
    main = m!.trim()
    alphaToken = a!.trim()
  } else {
    main = body
  }
  let parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/)
  if (alphaToken === undefined && parts.length === 4) {
    alphaToken = parts[3]
    parts = parts.slice(0, 3)
  }
  if (parts.length !== 3) throw new Error(`parseCssColour: expected 3 channels in "${input}"`)
  const [r, g, b] = parts.map((p) => parseChannel(p, isColorFunction))
  return [r!, g!, b!, parseAlpha(alphaToken)]
}

/**
 * The one distance used suite-wide: the largest absolute difference over the
 * red, green and blue channels (0..255 scale). Alpha is not compared.
 */
export function chan(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!))
}

/** Source-over composite of `top` onto `bottom`, both RGBA. Returns RGBA. */
export function compositeOver(top: RGBA, bottom: RGBA): RGBA {
  const ta = top[3]
  const ba = bottom[3]
  const oa = ta + ba * (1 - ta)
  if (oa === 0) return [0, 0, 0, 0]
  const mix = (i: 0 | 1 | 2): number => (top[i] * ta + bottom[i] * ba * (1 - ta)) / oa
  return [mix(0), mix(1), mix(2), oa]
}

/**
 * WCAG 2 relative luminance of an sRGB colour (channels 0..255; alpha ignored).
 */
export function relativeLuminance(c: ArrayLike<number>): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
}

/** WCAG 2 contrast ratio between two opaque colours, in [1, 21]. */
export function contrastRatio(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

// ---------------------------------------------------------------------------
// Seeded randomness and equality
// ---------------------------------------------------------------------------

/**
 * mulberry32: a small, fast 32-bit PRNG. Returns a function producing floats in
 * [0, 1). The same seed always gives the same sequence on every platform.
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Structural equality where every leaf is compared with Object.is, so NaN equals
 * NaN and +0 differs from -0. Arrays compare by length and element; typed arrays by
 * constructor, length and element; plain objects (prototype Object.prototype or
 * null) by their own key set and values. Any other object (Date, Map, Set, class
 * instances) is equal only to itself: its own keys say nothing about its contents.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
    if (a.constructor !== b.constructor) return false
    const x = a as unknown as ArrayLike<unknown>
    const y = b as unknown as ArrayLike<unknown>
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    if (!hasPlainPrototype(a) || !hasPlainPrototype(b)) return Object.is(a, b)
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return Object.is(a, b)
}

function hasPlainPrototype(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// ---------------------------------------------------------------------------
// Civil calendar (proleptic Gregorian), integers only
// ---------------------------------------------------------------------------

/** Day number of a civil date, counted from 1970-01-01 = 0. Howard Hinnant's algorithm. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = floorDiv(yy, 400)
  const yoe = yy - era * 400
  const mp = m > 2 ? m - 3 : m + 9
  const doy = floorDiv(153 * mp + 2, 5) + d - 1
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
  return era * 146097 + doe - 719468
}

/** Civil date [year, month 1..12, day 1..31] of a day number counted from 1970-01-01. */
export function civilFromDays(z: number): [number, number, number] {
  const shifted = z + 719468
  const era = floorDiv(shifted, 146097)
  const doe = shifted - era * 146097
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
  const mp = floorDiv(5 * doy + 2, 153)
  const d = doy - floorDiv(153 * mp + 2, 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return [m <= 2 ? y + 1 : y, m, d]
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!
}

/** Weekday with Monday = 0 through Sunday = 6. 1970-01-01 (a Thursday) is 3. */
export function weekday(y: number, m: number, d: number): number {
  return mod(daysFromCivil(y, m, d) + 3, 7)
}

/**
 * ISO 8601 week and week-numbering year. The week belongs to the year that
 * contains its Thursday, so 2021-01-03 is week 53 of 2020 and 2024-12-30 is
 * week 1 of 2025.
 */
export function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const dn = daysFromCivil(y, m, d)
  const thursday = dn - weekday(y, m, d) + 3
  const [weekYear] = civilFromDays(thursday)
  const jan1 = daysFromCivil(weekYear, 1, 1)
  return { year: weekYear, week: floorDiv(thursday - jan1, 7) + 1 }
}
