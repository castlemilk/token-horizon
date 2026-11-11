/**
 * Every hidden input the sector-clock checks use. Checks and fixtures import from
 * here only, so the two cannot drift. The prompt never contains these values
 * except the public on-load default below, which the prompt states itself.
 *
 * Instants are integer milliseconds in UTC, built with the integer calendar in
 * reference.ts (no Date local getters). Offsets are minutes east of UTC.
 */
import { utcOf } from './reference'

export const HIDDEN_VERSION = 'sector-clock/v1'

export interface Instant {
  utcMs: number
  offsetMinutes: number
  /** Short label for check details and fixture notes. */
  label: string
}

const at = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number =>
  utcOf(y, mo, d, h, mi, s, ms)

/** The on-load default stated in the prompt (public). Used by the pose step. */
export const DEFAULT_INSTANT: Instant = { utcMs: 1773453566000, offsetMinutes: 330, label: 'default' }
/** The on-load sector stated in the prompt (public): start 540, end 330 minutes. */
export const DEFAULT_SECTOR: readonly [number, number] = [540, 330]

/** Minute and second hands at ordinary times, offset 0, 2025-05-06. */
export const MINUTE_SECOND_CASES: Instant[] = [
  { utcMs: at(2025, 5, 6, 9, 15, 45), offsetMinutes: 0, label: '09:15:45' },
  { utcMs: at(2025, 5, 6, 3, 47, 20), offsetMinutes: 0, label: '03:47:20' },
  { utcMs: at(2025, 5, 6, 18, 22, 59), offsetMinutes: 0, label: '18:22:59' },
  { utcMs: at(2025, 5, 6, 10, 8, 37), offsetMinutes: 0, label: '10:08:37' },
]

/** Hour-hand cases including the 12 o'clock edges and the seconds term, offset 0. */
export const HOUR_CASES: Instant[] = [
  { utcMs: at(2025, 5, 6, 12, 0, 0), offsetMinutes: 0, label: '12:00:00' },
  { utcMs: at(2025, 5, 6, 0, 0, 0), offsetMinutes: 0, label: '00:00:00' },
  { utcMs: at(2025, 5, 6, 12, 30, 0), offsetMinutes: 0, label: '12:30:00' },
  { utcMs: at(2025, 5, 6, 11, 59, 59), offsetMinutes: 0, label: '11:59:59' },
  { utcMs: at(2025, 5, 6, 23, 59, 59), offsetMinutes: 0, label: '23:59:59' },
  { utcMs: at(2025, 5, 6, 0, 0, 1), offsetMinutes: 0, label: '00:00:01' },
  { utcMs: at(2025, 5, 6, 6, 30, 0), offsetMinutes: 0, label: '06:30:00' },
  { utcMs: at(2025, 5, 6, 3, 47, 20), offsetMinutes: 0, label: '03:47:20' },
  { utcMs: at(2025, 5, 6, 9, 15, 45), offsetMinutes: 0, label: '09:15:45' },
  { utcMs: at(2025, 5, 6, 18, 22, 59), offsetMinutes: 0, label: '18:22:59' },
]

/** Fractional, negative and extreme offsets that cross midnight, local seconds 0. */
export const OFFSET_CASES: Instant[] = [
  { utcMs: at(2025, 5, 6, 18, 20, 0), offsetMinutes: 345, label: '18:20Z +345' },
  { utcMs: at(2025, 5, 6, 2, 40, 0), offsetMinutes: -210, label: '02:40Z -210' },
  { utcMs: at(2025, 5, 6, 10, 15, 0), offsetMinutes: 840, label: '10:15Z +840' },
  { utcMs: at(2025, 5, 6, 5, 10, 0), offsetMinutes: -720, label: '05:10Z -720' },
  { utcMs: at(2025, 5, 6, 20, 45, 0), offsetMinutes: 330, label: '20:45Z +330' },
  { utcMs: at(2025, 5, 6, 8, 35, 0), offsetMinutes: -570, label: '08:35Z -570' },
  { utcMs: at(2025, 5, 6, 0, 50, 0), offsetMinutes: -45, label: '00:50Z -45' },
]

/** Local weekday and day across month ends, leap days and the 1900 and 2100 rules. */
export const DATE_CASES: Instant[] = [
  { utcMs: at(2024, 2, 28, 10, 30, 0), offsetMinutes: 840, label: '2024-02-28T10:30Z +840' },
  { utcMs: at(2021, 3, 1, 2, 10, 0), offsetMinutes: -210, label: '2021-03-01T02:10Z -210' },
  { utcMs: at(2100, 2, 28, 23, 30, 0), offsetMinutes: 60, label: '2100-02-28T23:30Z +60' },
  { utcMs: at(1900, 2, 28, 20, 15, 0), offsetMinutes: 330, label: '1900-02-28T20:15Z +330' },
  { utcMs: at(2000, 3, 1, 5, 0, 0), offsetMinutes: -720, label: '2000-03-01T05:00Z -720' },
  { utcMs: at(2024, 12, 31, 23, 59, 59), offsetMinutes: 1, label: '2024-12-31T23:59:59Z +1' },
  { utcMs: at(2024, 1, 1, 0, 0, 0), offsetMinutes: -1, label: '2024-01-01T00:00Z -1' },
]

/** ISO 8601 week and week-numbering year at year boundaries. */
export const ISO_WEEK_CASES: Instant[] = [
  { utcMs: at(2021, 1, 1, 12, 0, 0), offsetMinutes: 0, label: '2021-01-01T12:00Z 0' },
  { utcMs: at(2024, 12, 30, 12, 0, 0), offsetMinutes: 0, label: '2024-12-30T12:00Z 0' },
  { utcMs: at(2026, 12, 31, 12, 0, 0), offsetMinutes: 0, label: '2026-12-31T12:00Z 0' },
  { utcMs: at(2023, 1, 1, 12, 0, 0), offsetMinutes: 0, label: '2023-01-01T12:00Z 0' },
  { utcMs: at(2018, 12, 31, 10, 0, 0), offsetMinutes: 840, label: '2018-12-31T10:00Z +840' },
  { utcMs: at(2021, 1, 4, 3, 0, 0), offsetMinutes: -300, label: '2021-01-04T03:00Z -300' },
  { utcMs: at(2016, 1, 3, 23, 30, 0), offsetMinutes: 60, label: '2016-01-03T23:30Z +60' },
  { utcMs: at(1900, 1, 1, 0, 0, 0), offsetMinutes: 0, label: '1900-01-01T00:00Z 0' },
  { utcMs: at(2100, 12, 31, 23, 0, 0), offsetMinutes: 0, label: '2100-12-31T23:00Z 0' },
]

/** The 24-hour hand, offset 0. */
export const H24_CASES: Instant[] = [
  { utcMs: at(2025, 5, 6, 3, 0, 0), offsetMinutes: 0, label: '03:00:00' },
  { utcMs: at(2025, 5, 6, 15, 0, 0), offsetMinutes: 0, label: '15:00:00' },
  { utcMs: at(2025, 5, 6, 0, 0, 0), offsetMinutes: 0, label: '00:00:00' },
  { utcMs: at(2025, 5, 6, 18, 45, 0), offsetMinutes: 0, label: '18:45:00' },
  { utcMs: at(2025, 5, 6, 23, 59, 59), offsetMinutes: 0, label: '23:59:59' },
]

/** Pre-1970 and sub-second instants, offset 0. */
export const EDGE_CASES: Instant[] = [
  { utcMs: -1, offsetMinutes: 0, label: '-1' },
  { utcMs: -86400001, offsetMinutes: 0, label: '-86400001' },
  { utcMs: at(1969, 7, 20, 20, 17, 40, 500), offsetMinutes: 0, label: '1969-07-20T20:17:40.500Z' },
  { utcMs: at(2024, 6, 10, 12, 0, 0, 999), offsetMinutes: 0, label: '2024-06-10T12:00:00.999Z' },
]

/** Cases read in the second browser context with the Chatham time zone (whole minutes). */
export const HOST_ZONE_ZONE = 'Pacific/Chatham'
export const HOST_ZONE_CASES: Instant[] = [
  { utcMs: at(2025, 5, 6, 12, 0, 0), offsetMinutes: 0, label: '2025-05-06T12:00Z 0' },
  { utcMs: at(2025, 5, 6, 2, 40, 0), offsetMinutes: -210, label: '2025-05-06T02:40Z -210' },
  { utcMs: at(2024, 9, 28, 14, 30, 0), offsetMinutes: 0, label: '2024-09-28T14:30Z 0' },
]

/** Pixel instant for the paint proof: the hands at 10:08:37. */
export const PAINT_INSTANT: Instant = { utcMs: at(2025, 5, 6, 10, 8, 37), offsetMinutes: 0, label: '10:08:37' }

/** Instant that parks every hand at 0 degrees for the sector pixel checks. */
export const PARKED_INSTANT: Instant = { utcMs: at(2025, 5, 6, 12, 0, 0), offsetMinutes: 0, label: '12:00:00' }

/** The sector used by the band check, in minutes after 12:00. */
export const BAND_SECTOR: readonly [number, number] = [135, 315]

/** The spans used by the arc check, in minutes after 12:00. Each is [start, end]. */
export const ARC_SPANS: ReadonlyArray<readonly [number, number]> = [
  [100, 190],
  [675, 105],
  [120, 600],
  [180, 540],
  [20, 10],
  [300, 300],
]

/**
 * Validity pair for the synchronous hooks: the first instant is applied, then the
 * second one is read back in the same JavaScript turn. Its seconds are zero so the
 * minute-hand check does not depend on the seconds term.
 */
export const SYNC_FIRST: Instant = { utcMs: at(2025, 5, 6, 3, 47, 20), offsetMinutes: 0, label: '03:47:20' }
export const SYNC_SECOND: Instant = { utcMs: at(2025, 5, 6, 18, 22, 0), offsetMinutes: 0, label: '18:22:00' }

/**
 * Invalid calls for setInstant and setSector, written as JavaScript source. They
 * are source text, not values, because NaN does not survive JSON serialisation.
 */
export const INVALID_CALL_SOURCES: readonly string[] = [
  'setInstant(NaN, 0)',
  "setInstant('abc', 0)",
  "setInstant('1700000000000', 0)",
  'setInstant(0, 841)',
  'setInstant(0, 1.5)',
  'setInstant(1.5, 0)',
  'setInstant(4133980800000, 0)',
  'setInstant()',
  'setSector(-1, 10)',
  'setSector(10, 720)',
  'setSector(10.5, 20)',
  "setSector('a', 'b')",
  "setSector('10', '20')",
]

/** Valid pair used for the true return values. */
export const VALID_SECTOR: readonly [number, number] = [10, 20]

/** Points on the dial, as fractions of R, used by the pixel checks. */
export const BAND_ANGLES_DEG: readonly number[] = [82.5, 112.5, 142.5]
export const BAND_INSIDE_RADII: readonly number[] = [0.8, 0.83, 0.86]
export const BAND_OUTSIDE_RADII: readonly number[] = [0.765, 0.895]
export const ARC_RADIUS = 0.83
export const ARC_SAMPLES = 72
/**
 * Angles at 0.83R that must NOT be amber: they lie inside the on-load sector (270 to 165 through 12, set by the
 * prompt) and outside the band check's hidden span (67.5 to 157.5). A page that paints the default sector
 * instead of the hidden one fails here.
 */
export const BAND_OUTSIDE_SPAN_DEG: readonly number[] = [22.5, 37.5, 322.5]
/** Fractions along each hand's own drawn line, from its tail to its tip, where the paint proof samples. */
export const PAINT_FRACTIONS: readonly number[] = [0.35, 0.6, 0.85]
/** The two sectors set by the sync-validation probe: the second is the one whose animations are counted. */
export const SYNC_SECTORS: readonly [readonly [number, number], readonly [number, number]] = [
  [10, 20],
  [200, 480],
]

/** Tolerances the checks apply. Each is derived in the check notes and in checks.ts. */
export const TOL = {
  /** Screen radii and line distances, px. */
  pxLine: 1.5,
  /** Relative slack on the proportions, as a fraction of R. */
  relSlack: 0.01,
  /** Dial radius minimum on screen, px, at 1024x720 and at 380x480. */
  dialMinWide: 150,
  dialMinNarrow: 100,
  /** Hand and dial angles, degrees. */
  minuteDeg: 0.5,
  secondDeg: 0.5,
  hourDeg: 0.25,
  offsetHourDeg: 15.5,
  h24Deg: 1.5,
  /** Ticks and numerals. */
  tickDeg: 1,
  tickResidualDeg: 0.6,
  numeralDeg: 8,
  numeralUpright: 1,
  majorRatio: 1.4,
  /** Pixels: colour distances per channel. */
  amberTol: 14,
  notAmber: 60,
  paintDiff: 40,
  /** Tick midpoints: a visible tick changes at least this much when the ticks are hidden. */
  tickPaint: 12,
  /** Arc sampling skip, degrees from an edge. */
  arcEdgeSkipDeg: 2,
  /** Viewport sizes. */
  wide: { width: 1024, height: 720 },
  narrow: { width: 380, height: 480 },
} as const
