import { describe, expect, it } from 'vitest'
import {
  chan,
  circularDifference,
  civilFromDays,
  clockwiseAngle,
  compositeOver,
  contrastRatio,
  daysFromCivil,
  daysInMonth,
  deepEqual,
  footOfPerpendicular,
  isLeapYear,
  isoWeek,
  mulberry32,
  parseCssColour,
  pointLineDistance,
  relativeLuminance,
  sideOfLine,
  weekday,
} from './math'

// Node's Date in UTC is the independent reference for calendar values. The
// host time zone never enters: every call uses Date.UTC and UTC getters.
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 864e5
function utcIsoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const t = new Date(Date.UTC(y, m - 1, d))
  const w = (t.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(y, m - 1, d - w + 3))
  const year = thursday.getUTCFullYear()
  return { year, week: Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 864e5 / 7) + 1 }
}

describe('colour parsing', () => {
  it('parses rgb, rgba and the space syntax with a slash alpha', () => {
    expect(parseCssColour('rgb(0, 0, 0)')).toEqual([0, 0, 0, 1])
    expect(parseCssColour('rgba(255, 255, 255, 0.5)')).toEqual([255, 255, 255, 0.5])
    expect(parseCssColour('rgb(10 20 30 / 50%)')).toEqual([10, 20, 30, 0.5])
    expect(parseCssColour('rgb(100%, 0%, 50%)')).toEqual([255, 0, 127.5, 1])
  })

  it('parses color(srgb ...) with 0..1 channels', () => {
    expect(parseCssColour('color(srgb 1 0 0)')).toEqual([255, 0, 0, 1])
    expect(parseCssColour('color(srgb 0.5 0.5 0.5 / 0.25)')).toEqual([127.5, 127.5, 127.5, 0.25])
  })

  it('parses hex and transparent', () => {
    expect(parseCssColour('#abc')).toEqual([170, 187, 204, 1])
    expect(parseCssColour('#102030')).toEqual([16, 32, 48, 1])
    expect(parseCssColour('transparent')).toEqual([0, 0, 0, 0])
  })

  it('throws on a colour it does not understand instead of guessing', () => {
    expect(() => parseCssColour('hsl(0 0% 0%)')).toThrow(/unsupported/)
    expect(() => parseCssColour('color(display-p3 1 0 0)')).toThrow(/srgb/)
  })
})

describe('contrast and compositing', () => {
  it('black on white is 21 and identical colours are 1', () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 9)
    expect(contrastRatio([128, 128, 128], [128, 128, 128])).toBeCloseTo(1, 12)
  })

  it('matches the published WCAG value for #767676 on white (4.54:1)', () => {
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2)
  })

  it('relative luminance of white is 1 and black is 0', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 12)
    expect(relativeLuminance([0, 0, 0])).toBe(0)
  })

  it('chan is the largest absolute per-channel difference and ignores alpha', () => {
    expect(chan([0, 0, 0, 1], [3, 200, 1, 0])).toBe(200)
    expect(chan([10, 10, 10], [10, 10, 10])).toBe(0)
  })

  it('composites a half-transparent red over white', () => {
    expect(compositeOver([255, 0, 0, 0.5], [255, 255, 255, 1])).toEqual([255, 127.5, 127.5, 1])
    expect(compositeOver([0, 0, 0, 0], [9, 8, 7, 1])).toEqual([9, 8, 7, 1])
  })
})

describe('polar and line geometry', () => {
  it('clockwise angle from straight up, in degrees on [0, 360)', () => {
    expect(clockwiseAngle(0, -1)).toBeCloseTo(0, 12)
    expect(clockwiseAngle(1, 0)).toBeCloseTo(90, 12)
    expect(clockwiseAngle(0, 1)).toBeCloseTo(180, 12)
    expect(clockwiseAngle(-1, 0)).toBeCloseTo(270, 12)
    expect(clockwiseAngle(-1, -1)).toBeCloseTo(315, 12)
  })

  it('circular difference wraps across 0 and 360', () => {
    expect(circularDifference(359, 1)).toBeCloseTo(-2, 12)
    expect(circularDifference(1, 359)).toBeCloseTo(2, 12)
    expect(circularDifference(350, 10)).toBeCloseTo(-20, 12)
    expect(circularDifference(10, 350)).toBeCloseTo(20, 12)
    expect(circularDifference(0.5, 359.5)).toBeCloseTo(1, 12)
    expect(circularDifference(90, 0)).toBe(90)
    // The half-open range: 180 wraps to -180.
    expect(circularDifference(180, 0)).toBe(-180)
  })

  it('point to line distance, foot of perpendicular and side of line', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    expect(pointLineDistance({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 12)
    expect(pointLineDistance({ x: 15, y: -4 }, a, b)).toBeCloseTo(4, 12)
    expect(footOfPerpendicular({ x: 5, y: 3 }, a, b)).toEqual({ x: 5, y: 0 })
    expect(sideOfLine({ x: 5, y: 3 }, a, b)).toBe(1)
    expect(sideOfLine({ x: 5, y: -3 }, a, b)).toBe(-1)
    expect(sideOfLine({ x: 5, y: 0 }, a, b)).toBe(0)
  })
})

describe('seeded PRNG and equality', () => {
  it('mulberry32 is deterministic and matches the reference sequence', () => {
    const first = mulberry32(1)
    const second = mulberry32(1)
    const a = [first(), first(), first()]
    const b = [second(), second(), second()]
    expect(a).toEqual(b)
    expect(a[0]).toBe(0.6270739405881613)
    expect(a[1]).toBe(0.002735721180215478)
    expect(a[2]).toBe(0.5274470399599522)
    expect(mulberry32(20261110)()).toBe(0.47585524804890156)
  })

  it('mulberry32 stays in [0, 1)', () => {
    const next = mulberry32(7)
    for (let i = 0; i < 10_000; i++) {
      const v = next()
      expect(v >= 0 && v < 1).toBe(true)
    }
  })

  it('deepEqual compares leaves with Object.is', () => {
    expect(deepEqual(NaN, NaN)).toBe(true)
    expect(deepEqual(0, -0)).toBe(false)
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
  })
})

describe('civil calendar', () => {
  it('leap years: 1900 is not a leap year, 2000 is', () => {
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
    expect(isLeapYear(2024)).toBe(true)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
  })

  it('day numbers: epoch, leap day boundaries and the 1900 to 2101 span', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0)
    expect(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28)).toBe(1)
    expect(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28)).toBe(2)
    expect(daysFromCivil(2101, 1, 1) - daysFromCivil(1900, 1, 1)).toBe(73414)
    expect(daysFromCivil(2101, 1, 1) - daysFromCivil(1900, 1, 1)).toBe(utcDay(2101, 1, 1) - utcDay(1900, 1, 1))
  })

  it('round-trips every day from 1900-01-01 to 2100-12-31 and agrees with Date.UTC', () => {
    const start = daysFromCivil(1900, 1, 1)
    const end = daysFromCivil(2100, 12, 31)
    for (let z = start; z <= end; z++) {
      const [y, m, d] = civilFromDays(z)
      if (daysFromCivil(y, m, d) !== z) throw new Error(`round trip failed at day ${z}`)
      if (z % 997 === 0 || z === start || z === end) {
        expect(z).toBe(utcDay(y, m, d))
        const check = new Date(Date.UTC(y, m - 1, d))
        expect(check.getUTCFullYear()).toBe(y)
        expect(check.getUTCMonth() + 1).toBe(m)
        expect(check.getUTCDate()).toBe(d)
      }
    }
  })
})

describe('weekday and ISO week (hand-checked dates)', () => {
  // Weekday: Monday = 0 through Sunday = 6.
  it.each([
    [1970, 1, 1, 3, 'Thursday'],
    [1900, 1, 1, 0, 'Monday'],
    [2000, 2, 29, 1, 'Tuesday'],
    [2021, 1, 3, 6, 'Sunday'],
    [2026, 12, 31, 3, 'Thursday'],
    [2100, 3, 1, 0, 'Monday'],
  ])('weekday of %i-%i-%i is %i (%s)', (y, m, d, expected) => {
    expect(weekday(y, m, d)).toBe(expected)
  })

  // ISO week and week-numbering year, including the year boundaries.
  it.each([
    [2021, 1, 3, 2020, 53],
    [2026, 12, 31, 2026, 53],
    [2027, 1, 1, 2026, 53],
    [2024, 12, 30, 2025, 1],
    [2016, 1, 3, 2015, 53],
    [2022, 1, 1, 2021, 52],
    [2000, 2, 29, 2000, 9],
    [2024, 2, 29, 2024, 9],
    [1900, 1, 1, 1900, 1],
    [2020, 12, 31, 2020, 53],
    [2019, 12, 30, 2020, 1],
    [1970, 1, 1, 1970, 1],
  ])('ISO week of %i-%i-%i is %i-W%i', (y, m, d, wy, w) => {
    expect(isoWeek(y, m, d)).toEqual({ year: wy, week: w })
  })

  it('agrees with a UTC Date reference for every day from 1900 to 2100', () => {
    const start = daysFromCivil(1900, 1, 1)
    const end = daysFromCivil(2100, 12, 31)
    let mismatches = 0
    for (let z = start; z <= end; z++) {
      const [y, m, d] = civilFromDays(z)
      const got = isoWeek(y, m, d)
      const want = utcIsoWeek(y, m, d)
      if (got.year !== want.year || got.week !== want.week) mismatches++
      if (weekday(y, m, d) !== (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) mismatches++
    }
    expect(mismatches).toBe(0)
  })
})
