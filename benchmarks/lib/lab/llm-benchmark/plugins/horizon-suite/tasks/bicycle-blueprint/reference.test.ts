import { describe, expect, it } from 'vitest'
import { circularDifference, footOfPerpendicular, mulberry32, pointLineDistance } from '../../lib/math'
import {
  PUBLIC_DEFAULTS,
  bearing,
  chainLength,
  chainLengthGeometric,
  derive,
  extentsOf,
  handlebarBox,
  linksFor,
  onCircle,
  readoutsFor,
  saddleBox,
  tangentRuns,
  teethRadius,
  validCrank,
  validParams,
  viewBoxOf,
  type Params,
} from './reference'
import { HIDDEN_P1, HIDDEN_P2, HIDDEN_P3, withDefaults } from './hidden'

const close = (actual: number, expected: number, tol: number, label = ''): void => {
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(tol)
}

describe('bicycle reference: joints', () => {
  it('derives the P3 joints quoted in the specification', () => {
    const g = derive(withDefaults(HIDDEN_P3), 0)
    close(g.bb.x, 394.4, 0.05, 'bb.x')
    close(g.bb.y, -78, 1e-9, 'bb.y')
    close(g.sc.x, 197.4, 0.1, 'sc.x')
    close(g.sc.y, 478.2, 0.1, 'sc.y')
    close(g.fc.x, 867.0, 0.05, 'fc.x')
    close(g.fc.y, 381.6, 0.05, 'fc.y')
    close(g.ht.x, 837.1, 0.1, 'ht.x')
    close(g.ht.y, 482.3, 0.1, 'ht.y')
  })

  it('places the bottom bracket by Pythagoras with the drop', () => {
    const p = withDefaults(HIDDEN_P1)
    const g = derive(p, 0)
    close(Math.hypot(g.bb.x, g.bb.y), p.chainstay, 1e-9, 'chain-stay length')
    expect(g.bb.y).toBe(-p.bbDrop)
  })

  it('puts the front hub at (W, 0) and the rear hub at the origin', () => {
    const g = derive(withDefaults(HIDDEN_P2), 0)
    expect(g.rear).toEqual({ x: 0, y: 0 })
    expect(g.front).toEqual({ x: HIDDEN_P2.wheelbase, y: 0 })
  })

  it('computes the crank ends clockwise from straight up', () => {
    const g = derive(withDefaults(HIDDEN_P1), 90)
    close(g.crankRight.x - g.bb.x, HIDDEN_P1.crankLength ?? 170, 1e-9, 'right crank points right at 90')
    close(g.crankRight.y - g.bb.y, 0, 1e-9, 'right crank level at 90')
    const up = derive(withDefaults(HIDDEN_P1), 0)
    close(up.crankRight.y - up.bb.y, withDefaults(HIDDEN_P1).crankLength, 1e-9, 'crank up at 0')
  })
})

describe('bicycle reference: chain loop and links', () => {
  it('reproduces the three quoted loops and link counts', () => {
    const cases: Array<{ Nf: number; Nr: number; C: number; loop: number; links: number; shortcut: number }> = [
      { Nf: 52, Nr: 12, C: 440, loop: 1301.299, links: 104, shortcut: 1286.4 },
      { Nf: 28, Nr: 34, C: 395, loop: 1184.072, links: 94, shortcut: 1183.7 },
      { Nf: 39, Nr: 23, C: 402, loop: 1200.303, links: 96, shortcut: 1197.7 },
    ]
    for (const c of cases) {
      const rf = teethRadius(c.Nf)
      const rr = teethRadius(c.Nr)
      close(chainLength(c.C, rf, rr), c.loop, 0.001, `loop ${c.Nf}/${c.Nr}`)
      expect(linksFor(c.loop)).toBe(c.links)
      close(2 * c.C + Math.PI * (rf + rr), c.shortcut, 0.06, `shortcut ${c.Nf}/${c.Nr}`)
    }
  })

  it('agrees with the loop built from the tangent points', () => {
    const rng = mulberry32(20260914)
    for (let i = 0; i < 400; i++) {
      const C = 380 + 80 * rng()
      const Nf = 26 + Math.floor(31 * rng())
      const Nr = 11 + Math.floor(26 * rng())
      const rf = teethRadius(Nf)
      const rr = teethRadius(Nr)
      if (Math.abs(rf - rr) >= C) continue
      close(chainLengthGeometric(C, rf, rr), chainLength(C, rf, rr), 1e-6, `case ${i}`)
    }
  })

  it('gives an even link count that is the smallest one covering the loop', () => {
    for (const loop of [1301.299, 1184.072, 1200.303, 1000, 1000.01, 2000]) {
      const n = linksFor(loop)
      expect(n % 2).toBe(0)
      expect(n * 12.7).toBeGreaterThanOrEqual(loop)
      expect((n - 2) * 12.7).toBeLessThan(loop)
    }
  })
})

describe('bicycle reference: external tangents', () => {
  it('touches both circles at the tangent points, on the stated side', () => {
    for (const [Nf, Nr, C] of [
      [52, 12, 440],
      [48, 14, 425],
      [44, 11, 380],
      [28, 34, 395],
    ] as const) {
      const g = derive(withDefaults({ ...HIDDEN_P1, chainstay: C, chainringTeeth: Nf, sprocketTeeth: Nr }), 0)
      const runs = tangentRuns(g.bb, g.rf, g.rear, g.rr)
      for (const run of [runs.upper, runs.lower]) {
        // Each tangent point lies on its circle.
        close(Math.hypot(run.a.x - g.bb.x, run.a.y - g.bb.y), g.rf, 1e-9, 'a on ring')
        close(Math.hypot(run.b.x - g.rear.x, run.b.y - g.rear.y), g.rr, 1e-9, 'b on sprocket')
      }
      // Both centres lie at the stated radius from the infinite run.
      for (const run of [runs.upper, runs.lower]) {
        close(pointLineDistance(g.bb, run.a, run.b), g.rf, 1e-6, 'ring distance')
        close(pointLineDistance(g.rear, run.a, run.b), g.rr, 1e-6, 'sprocket distance')
        const fa = footOfPerpendicular(g.bb, run.a, run.b)
        const fb = footOfPerpendicular(g.rear, run.a, run.b)
        expect(Math.hypot(fa.x - run.a.x, fa.y - run.a.y)).toBeLessThan(1e-6)
        expect(Math.hypot(fb.x - run.b.x, fb.y - run.b.y)).toBeLessThan(1e-6)
      }
      // The upper run is above the line of centres, the lower one below.
      const side = (p: { x: number; y: number }): number =>
        (g.rear.x - g.bb.x) * (p.y - g.bb.y) - (g.rear.y - g.bb.y) * (p.x - g.bb.x)
      expect(Math.sign(side(runs.upper.a)) * Math.sign(side(runs.upper.b))).toBe(1)
      expect(Math.sign(side(runs.lower.a)) * Math.sign(side(runs.lower.b))).toBe(1)
      expect(Math.sign(side(runs.upper.a)) * Math.sign(side(runs.lower.a))).toBe(-1)
      expect(runs.upper.a.y).toBeGreaterThan(runs.lower.a.y)
    }
  })

  it('measures how far a top-to-top or bottom-to-bottom run misses the foot-of-perpendicular test', () => {
    // The check compares each endpoint with the foot of the perpendicular from a circle centre.
    // The upper naive run (top of ring to top of sprocket) misses the ring foot by about 3 px here;
    // the lower naive run (bottom to bottom) misses by about 9.6 px. The fixture fails either way.
    const g = derive(withDefaults({ ...HIDDEN_P1, chainringTeeth: 52, sprocketTeeth: 12 }), 0)
    const runs = tangentRuns(g.bb, g.rf, g.rear, g.rr)
    const pxPerMm = 560 / (HIDDEN_P1.wheelbase! + 2 * HIDDEN_P1.wheelRadius!)
    const topRing = { x: g.bb.x, y: g.bb.y + g.rf }
    const topSpr = { x: g.rear.x, y: g.rear.y + g.rr }
    const upperFoot = footOfPerpendicular(g.bb, topRing, topSpr)
    const upperMiss = Math.hypot(upperFoot.x - topRing.x, upperFoot.y - topRing.y) * pxPerMm
    expect(upperMiss).toBeGreaterThan(2.5)
    expect(upperMiss).toBeLessThan(4)
    const botRing = { x: g.bb.x, y: g.bb.y - g.rf }
    const botSpr = { x: g.rear.x, y: g.rear.y - g.rr }
    const lowerMiss = Math.hypot(botRing.x - runs.lower.a.x, botRing.y - runs.lower.a.y) * pxPerMm
    expect(lowerMiss).toBeGreaterThan(8)
    expect(lowerMiss).toBeLessThan(11)
    void botSpr
  })
})

describe('bicycle reference: rotation and congruence', () => {
  it('keeps every rotation case at least 3.3 degrees from an unrotated spoke pattern', () => {
    const cases = [
      { Nf: 48, Nr: 18, theta: 100, N: 24, phi: 266.667 },
      { Nf: 44, Nr: 16, theta: 765, N: 24, phi: 303.75 },
      { Nf: 28, Nr: 34, theta: 55, N: 36, phi: 45.294 },
      { Nf: 52, Nr: 12, theta: 50, N: 12, phi: 216.667 },
    ]
    for (const c of cases) {
      const phi = (c.theta * c.Nf) / c.Nr
      close(phi % 360, c.phi, 0.001, 'phi')
      const step = 360 / c.N
      expect(Math.abs(circularDifference(phi, 0, step))).toBeGreaterThanOrEqual(3.3)
    }
  })

  it('reports the bearing of a point clockwise from straight up (screen coordinates, y down)', () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(0, 9)
    expect(bearing({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90, 9)
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(180, 9)
    expect(bearing({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(270, 9)
    const p = onCircle({ x: 0, y: 0 }, 100, 300)
    // onCircle is in mm (y up): convert to screen (y down) before taking a bearing.
    expect(bearing({ x: 0, y: 0 }, { x: p.x, y: -p.y })).toBeCloseTo(300, 6)
  })
})

describe('bicycle reference: readouts and fitting', () => {
  it('computes the default readouts from the formulas', () => {
    const r = readoutsFor(PUBLIC_DEFAULTS, 35)
    close(r.ratio, 48 / 18, 1e-12)
    close(r.development, (2 * Math.PI * 340 * (48 / 18)) / 1000, 1e-12)
    close(r.distance, (340 * ((35 * 48) / 18) * Math.PI) / 180 / 1000, 1e-12)
  })

  it('validates the parameter ranges and cross-limits', () => {
    expect(validParams(withDefaults({}))).toBe(true)
    expect(validParams({ ...withDefaults({}), spokes: 25 })).toBe(false)
    expect(validParams({ ...withDefaults({}), chainringTeeth: 48.5 })).toBe(false)
    expect(validParams({ ...withDefaults({}), wheelRadius: 350, wheelbase: 700 })).toBe(false)
    expect(validParams({ ...withDefaults({}), wheelRadius: 340, forkLength: 350 })).toBe(false)
    expect(validParams({ ...withDefaults({}), bbDrop: 81 })).toBe(false)
    expect(validParams({ ...withDefaults({}), wheelRadius: NaN })).toBe(false)
    const missing: Partial<Params> = { ...withDefaults({}) }
    delete missing.spokes
    expect(validParams(missing)).toBe(false)
    expect(validCrank(0)).toBe(true)
    expect(validCrank(-10)).toBe(false)
    expect(validCrank(Infinity)).toBe(false)
    expect(validCrank(NaN)).toBe(false)
  })

  it('keeps the extreme valid bicycles inside the fitted bounds', () => {
    const largest: Params = withDefaults({
      wheelRadius: 380,
      wheelbase: 1200,
      chainstay: 460,
      bbDrop: 30,
      seatTube: 620,
      seatAngle: 68,
      headAngle: 66,
      forkLength: 420,
      headTube: 200,
      chainringTeeth: 56,
      sprocketTeeth: 11,
    })
    const smallest: Params = withDefaults({
      wheelRadius: 250,
      wheelbase: 700,
      chainstay: 380,
      bbDrop: 80,
      seatTube: 420,
      seatAngle: 78,
      headAngle: 76,
      forkLength: 340,
      headTube: 90,
      chainringTeeth: 26,
      sprocketTeeth: 36,
    })
    for (const p of [largest, smallest]) {
      expect(validParams(p)).toBe(true)
      const e = extentsOf(p, 0)
      const g = derive(p, 0)
      expect(e.x0).toBeLessThan(-p.wheelRadius)
      expect(e.x1).toBeGreaterThan(g.W + p.wheelRadius)
      const sb = saddleBox(g)
      const hb = handlebarBox(g)
      expect(sb.y + sb.h).toBeLessThan(e.y1)
      expect(hb.y + hb.h).toBeLessThan(e.y1)
      expect(viewBoxOf(p, 0).split(' ')).toHaveLength(4)
    }
  })
})

describe('bicycle reference: hidden sets are valid', () => {
  it('accepts every hidden parameter set used by the checks', () => {
    for (const p of [HIDDEN_P1, HIDDEN_P2, HIDDEN_P3]) {
      expect(validParams(withDefaults(p))).toBe(true)
    }
  })
})
