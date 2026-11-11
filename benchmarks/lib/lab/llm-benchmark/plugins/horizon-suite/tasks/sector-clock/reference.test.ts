import { describe, expect, it } from 'vitest'
import { daysFromCivil as mathDaysFromCivil, isoWeek as mathIsoWeek, mulberry32 } from '../../lib/math'
import {
  OFFSET_MAX,
  OFFSET_MIN,
  UTC_MS_MAX,
  UTC_MS_MIN,
  civilFromDays,
  clockReadout,
  daysFromCivil,
  isoWeekOf,
  sectorSpan,
  utcOf,
} from './reference'

const DEFAULT_UTC = 1773453566000
const DEFAULT_OFFSET = 330

describe('sector-clock reference arithmetic', () => {
  it('reproduces the on-load default readouts from the prompt', () => {
    const r = clockReadout(DEFAULT_UTC, DEFAULT_OFFSET)
    expect(r.digital).toBe('07:29:26')
    expect(r.date).toBe('Sat 14')
    expect(r.offsetLabel).toBe('UTC+05:30')
    expect(r.week).toBe('2026-W11')
  })

  it('agrees with the prompt example that 14 March 2026 is 2026-W11', () => {
    expect(clockReadout(utcOf(2026, 3, 14, 12, 0, 0), 0).week).toBe('2026-W11')
  })

  it('matches the date-window values in the specification', () => {
    const cases: Array<[number, number, string]> = [
      [utcOf(2024, 2, 28, 10, 30, 0), 840, 'Thu 29'],
      [utcOf(2021, 3, 1, 2, 10, 0), -210, 'Sun 28'],
      [utcOf(2100, 2, 28, 23, 30, 0), 60, 'Mon 1'],
      [utcOf(1900, 2, 28, 20, 15, 0), 330, 'Thu 1'],
      [utcOf(2000, 3, 1, 5, 0, 0), -720, 'Tue 29'],
      [utcOf(2024, 12, 31, 23, 59, 59), 1, 'Wed 1'],
      [utcOf(2024, 1, 1, 0, 0, 0), -1, 'Sun 31'],
    ]
    for (const [utc, off, want] of cases) expect(clockReadout(utc, off).date).toBe(want)
  })

  it('matches the ISO week values in the specification, including week-numbering years', () => {
    const cases: Array<[number, number, string]> = [
      [utcOf(2021, 1, 1, 12, 0, 0), 0, '2020-W53'],
      [utcOf(2024, 12, 30, 12, 0, 0), 0, '2025-W01'],
      [utcOf(2026, 12, 31, 12, 0, 0), 0, '2026-W53'],
      [utcOf(2023, 1, 1, 12, 0, 0), 0, '2022-W52'],
      [utcOf(2018, 12, 31, 10, 0, 0), 840, '2019-W01'],
      [utcOf(2021, 1, 4, 3, 0, 0), -300, '2020-W53'],
      [utcOf(2016, 1, 3, 23, 30, 0), 60, '2016-W01'],
      [utcOf(1900, 1, 1, 0, 0, 0), 0, '1900-W01'],
      [utcOf(2100, 12, 31, 23, 0, 0), 0, '2100-W52'],
    ]
    for (const [utc, off, want] of cases) expect(clockReadout(utc, off).week).toBe(want)
  })

  it('matches the offset-time values in the specification', () => {
    const cases: Array<[number, number, string, string]> = [
      [utcOf(2025, 5, 6, 18, 20, 0), 345, '00:05:00', 'UTC+05:45'],
      [utcOf(2025, 5, 6, 2, 40, 0), -210, '23:10:00', 'UTC-03:30'],
      [utcOf(2025, 5, 6, 10, 15, 0), 840, '00:15:00', 'UTC+14:00'],
      [utcOf(2025, 5, 6, 5, 10, 0), -720, '17:10:00', 'UTC-12:00'],
      [utcOf(2025, 5, 6, 20, 45, 0), 330, '02:15:00', 'UTC+05:30'],
      [utcOf(2025, 5, 6, 8, 35, 0), -570, '23:05:00', 'UTC-09:30'],
      [utcOf(2025, 5, 6, 0, 50, 0), -45, '00:05:00', 'UTC-00:45'],
    ]
    for (const [utc, off, digital, label] of cases) {
      const r = clockReadout(utc, off)
      expect(r.digital).toBe(digital)
      expect(r.offsetLabel).toBe(label)
    }
    expect(clockReadout(0, 0).offsetLabel).toBe('UTC+00:00')
  })

  it('floors negative and sub-second instants (edge instants)', () => {
    expect(clockReadout(-1, 0).digital).toBe('23:59:59')
    expect(clockReadout(-86400001, 0).digital).toBe('23:59:59')
    expect(clockReadout(utcOf(1969, 7, 20, 20, 17, 40, 500), 0).digital).toBe('20:17:40')
    expect(clockReadout(utcOf(2024, 6, 10, 12, 0, 0, 999), 0).digital).toBe('12:00:00')
    expect(clockReadout(-1, 0).secondDeg).toBe(354)
    expect(clockReadout(-86400001, 0).secondDeg).toBe(354)
    expect(clockReadout(utcOf(1969, 7, 20, 20, 17, 40, 500), 0).secondDeg).toBe(240)
  })

  it('gives the hour-hand angles in the specification, including the seconds term', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [utcOf(2025, 5, 6, 12, 30, 0), 0, 15],
      [utcOf(2025, 5, 6, 11, 59, 59), 0, 359.992],
      [utcOf(2025, 5, 6, 23, 59, 59), 0, 359.992],
      [utcOf(2025, 5, 6, 0, 0, 1), 0, 0.008],
      [utcOf(2025, 5, 6, 6, 30, 0), 0, 195],
      [utcOf(2025, 5, 6, 3, 47, 20), 0, 113.667],
      [utcOf(2025, 5, 6, 9, 15, 45), 0, 277.875],
      [utcOf(2025, 5, 6, 18, 22, 59), 0, 191.492],
    ]
    for (const [utc, off, want] of cases) {
      expect(Math.abs(clockReadout(utc, off).hourDeg - want)).toBeLessThan(0.001)
    }
  })

  it('gives the minute and second angles in the specification', () => {
    const cases: Array<[number, number, number, number]> = [
      [utcOf(2025, 5, 6, 9, 15, 45), 94.5, 270, 0],
      [utcOf(2025, 5, 6, 3, 47, 20), 284, 120, 0],
      [utcOf(2025, 5, 6, 18, 22, 59), 137.9, 354, 0],
      [utcOf(2025, 5, 6, 10, 8, 37), 51.7, 222, 0],
    ]
    for (const [utc, minute, second] of cases) {
      const r = clockReadout(utc, 0)
      expect(Math.abs(r.minuteDeg - minute)).toBeLessThan(1e-9)
      expect(Math.abs(r.secondDeg - second)).toBeLessThan(1e-9)
    }
  })

  it('gives the 24-hour hand angles in the specification', () => {
    const cases: Array<[number, number, number]> = [
      [utcOf(2025, 5, 6, 3, 0, 0), 0, 45],
      [utcOf(2025, 5, 6, 15, 0, 0), 0, 225],
      [utcOf(2025, 5, 6, 0, 0, 0), 0, 0],
      [utcOf(2025, 5, 6, 18, 45, 0), 0, 281.25],
      [utcOf(2025, 5, 6, 23, 59, 59), 0, 359.996],
    ]
    for (const [utc, off, want] of cases) {
      expect(Math.abs(clockReadout(utc, off).h24Deg - want)).toBeLessThan(0.001)
    }
  })

  it('rejects instants outside the contract ranges', () => {
    expect(() => clockReadout(UTC_MS_MIN - 1, 0)).toThrow(RangeError)
    expect(() => clockReadout(UTC_MS_MAX + 1, 0)).toThrow(RangeError)
    expect(() => clockReadout(0, OFFSET_MIN - 1)).toThrow(RangeError)
    expect(() => clockReadout(0, OFFSET_MAX + 1)).toThrow(RangeError)
    expect(() => clockReadout(0.5, 0)).toThrow(RangeError)
  })

  it('computes sector spans, including through 12 and empty', () => {
    expect(sectorSpan(540, 330)).toEqual({ startDeg: 270, widthDeg: 255, empty: false })
    expect(sectorSpan(100, 190)).toEqual({ startDeg: 50, widthDeg: 45, empty: false })
    expect(sectorSpan(675, 105)).toEqual({ startDeg: 337.5, widthDeg: 75, empty: false })
    expect(sectorSpan(120, 600).widthDeg).toBe(240)
    expect(sectorSpan(180, 540).widthDeg).toBe(180)
    expect(sectorSpan(20, 10).widthDeg).toBe(355)
    expect(sectorSpan(300, 300).empty).toBe(true)
  })
})

describe('sector-clock reference against independent calendar code', () => {
  it('agrees with the shared math.ts calendar on day numbers and ISO weeks', () => {
    const rnd = mulberry32(20250506)
    for (let i = 0; i < 2000; i++) {
      const y = 1900 + Math.floor(rnd() * 201)
      const m = 1 + Math.floor(rnd() * 12)
      const d = 1 + Math.floor(rnd() * 28)
      expect(daysFromCivil(y, m, d)).toBe(mathDaysFromCivil(y, m, d))
      const iso = isoWeekOf(daysFromCivil(y, m, d))
      const want = mathIsoWeek(y, m, d)
      expect(iso.year).toBe(want.year)
      expect(iso.week).toBe(want.week)
    }
  })

  it('agrees with Date UTC getters on 20000 random instants (UTC getters only, no host zone)', () => {
    const rnd = mulberry32(7);
    const pad = (n: number): string => String(n).padStart(2, '0')
    let checked = 0
    for (let i = 0; i < 20000; i++) {
      const span = UTC_MS_MAX - UTC_MS_MIN
      const utc = UTC_MS_MIN + 86400000 * 2 + Math.floor(rnd() * (span - 4 * 86400000))
      const off = OFFSET_MIN + Math.floor(rnd() * (OFFSET_MAX - OFFSET_MIN + 1))
      const local = new Date(Math.floor(utc / 1000) * 1000 + off * 60000)
      const r = clockReadout(utc, off)
      const digital = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
      expect(r.digital).toBe(digital)
      const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      expect(r.date.slice(0, 3)).toBe(weekdays[local.getUTCDay()])
      expect(r.ymd[0]).toBe(local.getUTCFullYear())
      expect(r.ymd[1]).toBe(local.getUTCMonth() + 1)
      expect(r.ymd[2]).toBe(local.getUTCDate())
      checked++
    }
    expect(checked).toBe(20000)
  })

  it('civil date round-trips through days', () => {
    for (let z = -100000; z <= 100000; z += 137) {
      const [y, m, d] = civilFromDays(z)
      expect(daysFromCivil(y, m, d)).toBe(z)
    }
  })
})
