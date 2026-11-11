/**
 * Reference arithmetic for the sector-clock task. Pure functions, integers only:
 * no Date local getters, no host time zone, no floating-point calendar counting.
 * Ported from the chief designer's clock.cjs (days-from-civil, civil-from-days, and
 * the ISO week taken from the Thursday of the week). reference.test.ts cross-checks
 * it against Date UTC getters and the shared math.ts calendar.
 */

export const UTC_MS_MIN = -2208988800000
export const UTC_MS_MAX = 4133980799999
export const OFFSET_MIN = -720
export const OFFSET_MAX = 840

/** Index 0 is Monday, as the ISO week begins on Monday. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b)
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/** Day number of a civil date, counted from 1970-01-01 = 0 (Howard Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = floorDiv(yy, 400)
  const yoe = yy - era * 400
  const doy = floorDiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
  return era * 146097 + doe - 719468
}

/** Civil date [year, month 1..12, day 1..31] of a day number counted from 1970-01-01. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468
  const era = floorDiv(z, 146097)
  const doe = z - era * 146097
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365)
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
  const mp = floorDiv(5 * doy + 2, 153)
  const d = doy - floorDiv(153 * mp + 2, 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d]
}

/** Monday = 0 .. Sunday = 6 for a day number. 1970-01-01 is a Thursday (3). */
export function weekdayIndex(days: number): number {
  return mod(days + 3, 7)
}

/** The instant of a UTC civil date and time, in integer milliseconds. */
export function utcOf(y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number {
  return (daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s) * 1000 + ms
}

/** ISO 8601 week-numbering year and week of a day number (the local date). */
export function isoWeekOf(days: number): { year: number; week: number } {
  const thursday = days - weekdayIndex(days) + 3
  const year = civilFromDays(thursday)[0]
  const jan1 = daysFromCivil(year, 1, 1)
  return { year, week: floorDiv(thursday - jan1, 7) + 1 }
}

export interface ClockReadout {
  /** Local hour, minute and whole second. */
  H: number
  M: number
  S: number
  /** Local calendar date as [year, month, day]. */
  ymd: [number, number, number]
  /** Expected text of each readout. */
  digital: string
  date: string
  offsetLabel: string
  week: string
  /** Expected hand angles in degrees clockwise from 12 o'clock. */
  hourDeg: number
  minuteDeg: number
  secondDeg: number
  h24Deg: number
}

/**
 * The expected readouts and hand angles for an instant. Throws on an instant
 * outside the contract ranges, so a check cannot silently use a bad input.
 */
export function clockReadout(utcMs: number, offsetMinutes: number): ClockReadout {
  if (!Number.isInteger(utcMs) || utcMs < UTC_MS_MIN || utcMs > UTC_MS_MAX) {
    throw new RangeError(`utcMs out of range: ${String(utcMs)}`)
  }
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < OFFSET_MIN || offsetMinutes > OFFSET_MAX) {
    throw new RangeError(`offsetMinutes out of range: ${String(offsetMinutes)}`)
  }
  const secs = floorDiv(utcMs, 1000) + offsetMinutes * 60
  const day = floorDiv(secs, 86400)
  const sod = secs - day * 86400
  const H = floorDiv(sod, 3600)
  const M = floorDiv(sod % 3600, 60)
  const S = sod % 60
  const ymd = civilFromDays(day)
  const iso = isoWeekOf(day)
  const pad = (n: number): string => (n < 10 ? '0' : '') + String(n)
  const abs = Math.abs(offsetMinutes)
  const sign = offsetMinutes < 0 ? '-' : '+'
  return {
    H,
    M,
    S,
    ymd,
    digital: `${pad(H)}:${pad(M)}:${pad(S)}`,
    date: `${WEEKDAYS[weekdayIndex(day)]} ${ymd[2]}`,
    offsetLabel: `UTC${sign}${pad(floorDiv(abs, 60))}:${pad(abs % 60)}`,
    week: `${iso.year}-W${pad(iso.week)}`,
    hourDeg: ((H % 12) + M / 60 + S / 3600) * 30,
    minuteDeg: (M + S / 60) * 6,
    secondDeg: S * 6,
    h24Deg: (H + M / 60 + S / 3600) * 15,
  }
}

/** The sector span in degrees, from minutes after 12:00. Start equal to end is empty. */
export function sectorSpan(startMinutes: number, endMinutes: number): { startDeg: number; widthDeg: number; empty: boolean } {
  const minutes = mod(endMinutes - startMinutes, 720)
  return { startDeg: startMinutes * 0.5, widthDeg: minutes * 0.5, empty: minutes === 0 }
}
