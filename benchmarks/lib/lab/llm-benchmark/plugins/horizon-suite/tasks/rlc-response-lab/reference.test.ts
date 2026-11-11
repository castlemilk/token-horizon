import { describe, expect, it } from 'vitest'
import {
  bandwidthHz,
  decayRate,
  f0Hz,
  gainDb,
  omega0,
  overshootPctRef,
  parseEngHz,
  peakDbRef,
  phaseDeg,
  qOf,
  regimeOf,
  significantDigits,
  stepRef,
  tauRef,
  tmaxRef,
  transfer,
  zetaOf,
  type Circuit,
  type Output,
} from './reference'
import { SET } from './hidden'

const OUTPUTS: Output[] = ['C', 'R', 'L']

/** Circuits used across the tests: the hidden sets and a few generic ones. */
const CIRCUITS: Record<string, Circuit> = {
  U1: SET.U1,
  U2: SET.U2,
  CR: SET.CR,
  NC: SET.NC,
  NU: SET.NU,
  ND: SET.ND,
  OVM: SET.OVM,
  OVS: SET.OVS,
  VRU: SET.VR_UNDER,
  BA: SET.BA_HF,
  DEFAULT: { R: 20, L: 10e-3, C: 1e-6 },
  ZETA_04: { R: 80, L: 0.01, C: 1e-6 },
  ZETA_0625: { R: 125, L: 0.01, C: 1e-6 },
}

/**
 * Brute-force reference: integrate the circuit ODE with fixed-step RK4 and
 * return the three voltages at each requested time (times sorted, from 0).
 *   q' = i,  L i' = V_in - R i - q/C,  v_C = q/C,  v_R = R i,  v_L = L i'.
 * The step is subdivided so every requested time is hit exactly.
 */
function integrateRK4(c: Circuit, times: number[], hmax: number): Array<{ C: number; R: number; L: number }> {
  let q = 0
  let i = 0
  let t = 0
  const rhs = (qq: number, ii: number): [number, number] => [ii, (1 - c.R * ii - qq / c.C) / c.L]
  const out: Array<{ C: number; R: number; L: number }> = []
  for (const target of times) {
    const span = target - t
    const n = Math.max(1, Math.ceil(span / hmax))
    const h = span / n
    for (let k = 0; k < n; k++) {
      const [k1q, k1i] = rhs(q, i)
      const [k2q, k2i] = rhs(q + (h / 2) * k1q, i + (h / 2) * k1i)
      const [k3q, k3i] = rhs(q + (h / 2) * k2q, i + (h / 2) * k2i)
      const [k4q, k4i] = rhs(q + h * k3q, i + h * k3i)
      q += (h / 6) * (k1q + 2 * k2q + 2 * k3q + k4q)
      i += (h / 6) * (k1i + 2 * k2i + 2 * k3i + k4i)
    }
    t = target
    const vC = q / c.C
    const vR = c.R * i
    const vL = 1 - c.R * i - q / c.C
    out.push({ C: vC, R: vR, L: vL })
  }
  return out
}

/** Golden-section maximiser on [lo, hi]. */
function goldenMax(fn: (x: number) => number, lo: number, hi: number): number {
  const g = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let x1 = b - g * (b - a)
  let x2 = a + g * (b - a)
  let f1 = fn(x1)
  let f2 = fn(x2)
  for (let k = 0; k < 200; k++) {
    if (f1 < f2) {
      a = x1
      x1 = x2
      f1 = f2
      x2 = a + g * (b - a)
      f2 = fn(x2)
    } else {
      b = x2
      x2 = x1
      f2 = f1
      x1 = b - g * (b - a)
      f1 = fn(x1)
    }
  }
  return fn((a + b) / 2)
}

describe('closed forms against independent computations', () => {
  it('transfer function matches the N/(1 - w^2 LC + j w RC) form', () => {
    for (const c of Object.values(CIRCUITS)) {
      for (const out of OUTPUTS) {
        for (const x of [0.05, 0.3, 0.9, 1, 1.1, 3, 25]) {
          const f = x * f0Hz(c)
          const w = 2 * Math.PI * f
          const dr = 1 - w * w * c.L * c.C
          const di = w * c.R * c.C
          const num = out === 'C' ? [1, 0] : out === 'R' ? [0, di] : [-w * w * c.L * c.C, 0]
          const d = dr * dr + di * di
          const expRe = (num[0]! * dr + num[1]! * di) / d
          const expIm = (num[1]! * dr - num[0]! * di) / d
          const h = transfer(c, out, f)
          expect(Math.abs(h.re - expRe)).toBeLessThan(1e-9 * Math.max(1, Math.abs(expRe)))
          expect(Math.abs(h.im - expIm)).toBeLessThan(1e-9 * Math.max(1, Math.abs(expIm)))
        }
      }
    }
  })

  it('phase lies in (-180, 180] and is continuous through resonance for the capacitor', () => {
    const c = SET.CR
    let worst = 0
    for (let k = 0; k < 400; k++) {
      const f = f0Hz(c) * Math.pow(10, -2 + (4 * k) / 399)
      const p = phaseDeg(c, 'C', f)
      expect(p).toBeGreaterThan(-180)
      expect(p).toBeLessThanOrEqual(180)
      worst = Math.max(worst, Math.abs(p))
    }
    expect(worst).toBeLessThanOrEqual(180)
  })

  it('capacitor and inductor phases above resonance are on the right side (C -> -90, L -> -90)', () => {
    const c = SET.U1
    expect(phaseDeg(c, 'C', 20 * f0Hz(c))).toBeLessThan(-170)
    expect(phaseDeg(c, 'R', 20 * f0Hz(c))).toBeLessThan(-80)
    expect(phaseDeg(c, 'R', 20 * f0Hz(c))).toBeGreaterThan(-100)
    expect(phaseDeg(c, 'L', 20 * f0Hz(c))).toBeGreaterThan(-5)
  })

  it('the three outputs sum to the source voltage (Kirchhoff) in every regime', () => {
    for (const name of ['U1', 'CR', 'NC', 'NU', 'ND', 'OVS', 'VRU']) {
      const c = CIRCUITS[name]!
      const tau = tauRef(c)
      for (const x of [0, 0.01, 0.2, 0.5, 1, 2, 5, 8]) {
        const t = x * tau
        const sum = stepRef(c, 'C', t) + stepRef(c, 'R', t) + stepRef(c, 'L', t)
        expect(Math.abs(sum - 1), `${name} at t=${t}`).toBeLessThan(1e-9)
      }
    }
  })

  it('step responses agree with an RK4 integration of the circuit ODE', () => {
    for (const name of ['U1', 'VRU', 'CR', 'NC', 'NU', 'ND', 'OVS', 'U2']) {
      const c = CIRCUITS[name]!
      const tau = tauRef(c)
      const xs = [0, 0.13, 0.5, 1, 2.7, 6, 8]
      const times = xs.map((x) => x * tau)
      const numeric = integrateRK4(c, times, Math.min(tau / 400, 2e-7))
      times.forEach((t, k) => {
        for (const out of OUTPUTS) {
          const expected = numeric[k]![out]
          const got = stepRef(c, out, t)
          expect(Math.abs(got - expected), `${name} ${out} at t=${t}`).toBeLessThan(2e-6)
        }
      })
    }
  })

  it('stepRef is exactly zero for the capacitor at t = 0 and one for the inductor, and both are finite at exact criticality', () => {
    for (const out of OUTPUTS) {
      const v = stepRef(SET.CR, out, 0)
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(stepRef(SET.CR, 'C', 0)).toBeCloseTo(0, 12)
    expect(stepRef(SET.CR, 'L', 0)).toBeCloseTo(1, 12)
    expect(stepRef(SET.U1, 'C', 0)).toBeCloseTo(0, 12)
    expect(stepRef(SET.U1, 'L', 0)).toBeCloseTo(1, 12)
  })

  it('the critical step agrees with the overdamped and underdamped branches to 1e-7 near zeta = 1', () => {
    const base = { R: 2, L: 0.25, C: 0.25 }
    for (const x of [0.2, 1, 3]) {
      const t = x * tauRef(base)
      const crit = stepRef(base, 'C', t)
      const nearUnder = stepRef({ ...base, R: 2 * (1 - 1e-7) }, 'C', t)
      const nearOver = stepRef({ ...base, R: 2 * (1 + 1e-7) }, 'C', t)
      expect(Math.abs(crit - nearUnder)).toBeLessThan(1e-6)
      expect(Math.abs(crit - nearOver)).toBeLessThan(1e-6)
    }
  })

  it('peakDbRef equals a brute-force maximum of 20 log10 |H| over a fine log grid', () => {
    for (const name of ['U1', 'ZETA_04', 'ZETA_0625', 'U2', 'OVS', 'VRU', 'OVM']) {
      const c = CIRCUITS[name]!
      for (const out of OUTPUTS) {
        const f0 = f0Hz(c)
        // Twelve decades: the supremum of C and L above 1/sqrt(2) is approached only at the ends.
        const grid: number[] = []
        for (let k = 0; k <= 40000; k++) grid.push(f0 * Math.pow(10, -6 + (12 * k) / 40000))
        let bestK = 0
        let best = -Infinity
        grid.forEach((f, k) => {
          const g = gainDb(c, out, f)
          if (g > best) {
            best = g
            bestK = k
          }
        })
        const lo = grid[Math.max(0, bestK - 1)]!
        const hi = grid[Math.min(grid.length - 1, bestK + 1)]!
        const refined = Math.max(best, goldenMax((f) => gainDb(c, out, f), lo, hi))
        expect(Math.abs(refined - peakDbRef(c, out)), `${name} ${out}`).toBeLessThan(1e-6)
      }
    }
  })

  it('the spec quotes the peak values it was derived from', () => {
    expect(peakDbRef({ R: 80, L: 0.01, C: 1e-6 }, 'C')).toBeCloseTo(2.69541, 4)
    expect(peakDbRef({ R: 125, L: 0.01, C: 1e-6 }, 'C')).toBeCloseTo(0.21295, 4)
    expect(peakDbRef({ R: 80, L: 0.01, C: 1e-6 }, 'L')).toBeCloseTo(2.69541, 4)
    expect(peakDbRef({ R: 1, L: 0.01, C: 1e-6 }, 'C')).toBeCloseTo(40.00011, 4)
    expect(peakDbRef({ R: 1, L: 0.01, C: 1e-6 }, 'R')).toBe(0)
  })

  it('overshootPctRef equals a brute-force maximum of the capacitor step response', () => {
    for (const name of ['VRU', 'ZETA_04', 'ZETA_0625', 'U1', 'ND', 'CR', 'OVS']) {
      const c = CIRCUITS[name]!
      const tau = tauRef(c)
      const grid: number[] = []
      for (let k = 0; k <= 40000; k++) grid.push((20 * tau * k) / 40000)
      let bestK = 0
      let best = -Infinity
      grid.forEach((t, k) => {
        const v = stepRef(c, 'C', t)
        if (v > best) {
          best = v
          bestK = k
        }
      })
      const lo = grid[Math.max(0, bestK - 1)]!
      const hi = grid[Math.min(grid.length - 1, bestK + 1)]!
      const peakV = Math.max(best, goldenMax((t) => stepRef(c, 'C', t), lo, hi))
      const brute = Math.max(0, (peakV - 1) * 100)
      expect(Math.abs(brute - overshootPctRef(c)), name).toBeLessThan(1e-3)
    }
  })

  it('overshoot is zero exactly at and above critical damping', () => {
    expect(overshootPctRef(SET.CR)).toBe(0)
    expect(overshootPctRef(SET.OVS)).toBe(0)
    expect(overshootPctRef(SET.NU)).toBe(0)
  })
})

describe('definitions and regime band', () => {
  it('derives f0, zeta, Q and bandwidth from the prompt definitions', () => {
    const c = SET.U1
    expect(f0Hz(c)).toBeCloseTo(1867.9, 1)
    expect(zetaOf(c)).toBeCloseTo(0.0910, 3)
    expect(qOf(zetaOf(c))).toBeCloseTo(5.49, 2)
    expect(bandwidthHz(c)).toBeCloseTo(340.0, 1)
    expect(omega0(c)).toBeCloseTo(2 * Math.PI * f0Hz(c), 6)
    expect(decayRate(c)).toBeCloseTo(c.R / (2 * c.L), 9)
  })

  it('classifies the critical, near-critical and overdamped sets as the spec states', () => {
    expect(zetaOf(SET.CR)).toBe(1)
    expect(regimeOf(zetaOf(SET.CR))).toBe('critical')
    expect(zetaOf(SET.NC)).toBeGreaterThan(1)
    expect(zetaOf(SET.NC) - 1).toBeLessThan(1e-9)
    expect(regimeOf(zetaOf(SET.NC))).toBe('critical')
    expect(regimeOf(zetaOf(SET.NU))).toBe('overdamped')
    expect(zetaOf(SET.NU) - 1).toBeCloseTo(1e-7, 12)
    expect(regimeOf(zetaOf(SET.ND))).toBe('underdamped')
    expect(1 - zetaOf(SET.ND)).toBeCloseTo(1e-7, 12)
    expect(zetaOf(SET.OVM)).toBeCloseTo(40.003, 2)
    expect(zetaOf(SET.OVS)).toBeCloseTo(3, 12)
  })

  it('time constants and step-plot windows match the spec values', () => {
    expect(tmaxRef(SET.U1)).toBeCloseTo(9.3617e-3, 6)
    expect(tauRef(SET.OVS)).toBeCloseTo(1 / 1715.73, 6)
    expect(tmaxRef(SET.OVS)).toBeCloseTo(5.828e-3, 5)
    expect(tauRef(SET.CR)).toBeCloseTo(0.25, 12)
  })
})

describe('readout helpers', () => {
  it('parses engineering readouts including micro sign variants', () => {
    expect(parseEngHz('1.000 kHz')).toMatchObject({ value: 1000, sigDigits: 4 })
    expect(parseEngHz('159.2 mHz')?.value).toBeCloseTo(0.1592, 10)
    expect(parseEngHz('47.00 Hz')?.value).toBeCloseTo(47, 10)
    expect(parseEngHz('340.0 µHz')?.value).toBeCloseTo(340e-6, 12)
    expect(parseEngHz('340.0 μHz')?.value).toBeCloseTo(340e-6, 12)
    expect(parseEngHz('1000 Hz')?.mantissa).toBe('1000')
    expect(parseEngHz('0.1592 Hz')).not.toBeNull()
    expect(parseEngHz('12 Hz x')).toBeNull()
  })

  it('counts significant digits from the first non-zero digit', () => {
    expect(significantDigits('0.07071')).toBe(4)
    expect(significantDigits('2.500')).toBe(4)
    expect(significantDigits('100.0')).toBe(4)
    expect(significantDigits('100')).toBe(3)
    expect(significantDigits('0.5000')).toBe(4)
  })
})
