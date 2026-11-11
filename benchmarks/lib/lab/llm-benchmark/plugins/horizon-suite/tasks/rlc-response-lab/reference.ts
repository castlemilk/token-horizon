/**
 * Independent reference for the RLC response lab. Pure functions, Node only, no
 * DOM and no Date. The artifact is never consulted: every expectation in the
 * checks comes from here.
 *
 * The formulas are written the textbook way and deliberately differ in form from
 * the artifact's (the transfer function is built from the series impedance, the
 * step roots use the textbook square root, the critical and underdamped branches
 * are chosen by the regime band of the prompt). Their agreement is tested in
 * reference.test.ts against brute-force peak searches, an RK4 integration of the
 * circuit ODE and Kirchhoff's voltage law.
 */

export type Output = 'C' | 'R' | 'L'
export type Regime = 'underdamped' | 'critical' | 'overdamped'
export interface Circuit {
  R: number
  L: number
  C: number
}

/** The prompt's band: zeta within 1e-9 of 1 is 'critical'. */
export const REGIME_BAND = 1e-9

/** Undamped angular frequency 1/sqrt(LC), rad/s. */
export function omega0(c: Circuit): number {
  return 1 / Math.sqrt(c.L * c.C)
}

/** Resonant frequency in hertz, f0 = 1/(2 pi sqrt(LC)). */
export function f0Hz(c: Circuit): number {
  return 1 / (2 * Math.PI * Math.sqrt(c.L * c.C))
}

/** Damping ratio zeta = (R/2) sqrt(C/L). */
export function zetaOf(c: Circuit): number {
  return (c.R / 2) * Math.sqrt(c.C / c.L)
}

/** Quality factor Q = 1/(2 zeta). */
export function qOf(zeta: number): number {
  return 1 / (2 * zeta)
}

export function regimeOf(zeta: number): Regime {
  if (zeta < 1 - REGIME_BAND) return 'underdamped'
  if (zeta > 1 + REGIME_BAND) return 'overdamped'
  return 'critical'
}

/** Bandwidth R/(2 pi L), hertz. */
export function bandwidthHz(c: Circuit): number {
  return c.R / (2 * Math.PI * c.L)
}

/** Exponential decay rate a = R/(2L), 1/s. */
export function decayRate(c: Circuit): number {
  return c.R / (2 * c.L)
}

export interface Complex {
  re: number
  im: number
}

/**
 * H(j w) = V_out / V_in in sinusoidal steady state, built from the series
 * impedance Z = R + j w L + 1/(j w C) and the current I = 1/Z (V_in = 1):
 * V_C = I/(j w C), V_R = R I, V_L = j w L I.
 */
export function transfer(c: Circuit, out: Output, f: number): Complex {
  const w = 2 * Math.PI * f
  const zr = c.R
  const zi = w * c.L - 1 / (w * c.C)
  const d = zr * zr + zi * zi
  const ir = zr / d
  const ii = -zi / d
  if (out === 'R') return { re: c.R * ir, im: c.R * ii }
  if (out === 'L') return { re: -w * c.L * ii, im: w * c.L * ir }
  return { re: ii / (w * c.C), im: -ir / (w * c.C) }
}

/** 20 log10 |H| in dB. */
export function gainDb(c: Circuit, out: Output, f: number): number {
  const h = transfer(c, out, f)
  return 20 * Math.log10(Math.hypot(h.re, h.im))
}

/** arg H in degrees, normalised to (-180, 180]. */
export function phaseDeg(c: Circuit, out: Output, f: number): number {
  const h = transfer(c, out, f)
  let deg = (Math.atan2(h.im, h.re) * 180) / Math.PI
  if (deg <= -180) deg += 360
  return deg
}

/**
 * Largest value of 20 log10 |H| over f > 0. For C and L the maximum of
 * |H|^2 = 1/(4 zeta^2 (1 - zeta^2)) is reached when zeta < 1/sqrt(2); above that
 * the gain never exceeds 1 and the supremum is 0 dB. The resistor voltage peaks
 * at f0 with unit gain.
 */
export function peakDbRef(c: Circuit, out: Output): number {
  const z = zetaOf(c)
  if (out === 'R' || z >= Math.SQRT1_2) return 0
  return -20 * Math.log10(2 * z * Math.sqrt(1 - z * z))
}

/** Percentage by which the capacitor step response exceeds 1 (0 if it never does). */
export function overshootPctRef(c: Circuit): number {
  const z = zetaOf(c)
  if (z >= 1) return 0
  return 100 * Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z))
}

/**
 * Time constant of the step plot: 2L/R for zeta <= 1, and 1/|s_slow| above,
 * where s_slow = -a + sqrt(a^2 - w0^2) is the root closer to zero.
 */
export function tauRef(c: Circuit): number {
  if (zetaOf(c) <= 1) return (2 * c.L) / c.R
  const a = decayRate(c)
  const w0 = omega0(c)
  const sSlow = -a + Math.sqrt(a * a - w0 * w0)
  return 1 / Math.abs(sSlow)
}

export function tmaxRef(c: Circuit): number {
  return 10 * tauRef(c)
}

/**
 * Unit-step response of the chosen element at t seconds (zero before the step,
 * zero initial conditions). Three textbook branches, chosen by the regime band:
 *   underdamped  wd = sqrt(w0^2 - a^2)
 *   critical     v_C = 1 - e^{-at}(1 + at)
 *   overdamped   s1,2 = -a +- sqrt(a^2 - w0^2)
 * The resistor voltage is R times the loop current; the inductor voltage is the
 * remainder of Kirchhoff's voltage law, written in closed form.
 */
export function stepRef(c: Circuit, out: Output, t: number): number {
  if (t < 0) return 0
  const a = decayRate(c)
  const w0 = omega0(c)
  const z = zetaOf(c)
  const regime = regimeOf(z)
  if (regime === 'underdamped') {
    const wd = Math.sqrt(w0 * w0 - a * a)
    const e = Math.exp(-a * t)
    const x = wd * t
    const s = Math.sin(x)
    const co = Math.cos(x)
    if (out === 'C') return 1 - e * (co + (a / wd) * s)
    if (out === 'R') return ((2 * a) / wd) * e * s
    return e * (co - (a / wd) * s)
  }
  if (regime === 'critical') {
    const e = Math.exp(-a * t)
    if (out === 'C') return 1 - e * (1 + a * t)
    if (out === 'R') return 2 * a * t * e
    return e * (1 - a * t)
  }
  const root = Math.sqrt(a * a - w0 * w0)
  const s1 = -a + root
  const s2 = -a - root
  const den = s1 - s2
  const e1 = Math.exp(s1 * t)
  const e2 = Math.exp(s2 * t)
  if (out === 'C') return 1 + (s2 * e1 - s1 * e2) / den
  if (out === 'R') return ((c.R / c.L) * (e1 - e2)) / den
  return (s1 * e1 - s2 * e2) / den
}

/** Regime-band label used in the readouts (same function as regimeOf). */
export function regimeWord(c: Circuit): Regime {
  return regimeOf(zetaOf(c))
}

/** Parse an engineering-notation readout such as "1.000 kHz" or "47.00 Hz" to hertz. */
export function parseEngHz(text: string): { mantissa: string; value: number; sigDigits: number } | null {
  const m = /^(\d+(?:\.\d+)?) ?([pnuµμmkMG]?)Hz$/.exec(text)
  if (m === null) return null
  const mantissa = m[1] ?? ''
  const prefix = m[2] ?? ''
  const exp = ENG_EXP[prefix]
  if (exp === undefined) return null
  const value = Number(mantissa) * Math.pow(10, exp)
  return { mantissa, value, sigDigits: significantDigits(mantissa) }
}

const ENG_EXP: Record<string, number> = {
  '': 0,
  p: -12,
  n: -9,
  u: -6,
  µ: -6,
  μ: -6,
  m: -3,
  k: 3,
  M: 6,
  G: 9,
}

/** Count significant digits from the first non-zero digit (decimal point ignored). */
export function significantDigits(text: string): number {
  const digits = text.replace('.', '').replace(/^0+/, '')
  return digits.length
}
