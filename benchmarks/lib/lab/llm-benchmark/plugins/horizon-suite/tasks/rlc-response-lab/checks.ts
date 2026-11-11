/**
 * The ten checks of rlc-response-lab. Each is a defineCheck with the name and the
 * points of the specification, and implements the method written there. Hidden
 * inputs come from hidden.ts; expectations come from reference.ts; in-page reads
 * are plain JavaScript source strings (local.ts, or the kit's SVG_GEOM and
 * LINE_SCREENS).
 *
 * Each check probes only the __bench members it calls, so a missing member costs
 * the checks that need it. A check that cannot run fails with its full budget
 * (the wrapper enforces it).
 */
import type { CheckContext, CheckFn } from '../../../../scorers/check-meta'
import { defineCheck, type CheckOutcome } from '../../lib/check'
import { hookPresent, probe } from '../../lib/probe'
import {
  AUTORANGE_SETS,
  BODE_CURVE_CASES,
  METRIC_SETS,
  PEAK_C,
  PEAK_L,
  PEAK_RESOLVED_LC,
  PEAK_RESOLVED_Q_DIVISOR,
  PEAK_ZETAS,
  READOUT_SETS,
  RESPONSE_MULTIPLES,
  SET,
  STEP_CRIT_MULTIPLES,
  STEP_CRIT_SETS,
  STEP_PLOT_SETS,
  STEP_UNDER_MULTIPLES,
  STEP_UNDER_SETS,
  TOL,
  type SeriesSet,
} from './hidden'
import {
  bandwidthHz,
  f0Hz,
  gainDb,
  overshootPctRef,
  parseEngHz,
  peakDbRef,
  phaseDeg,
  qOf,
  regimeOf,
  regimeWord,
  significantDigits,
  stepRef,
  tauRef,
  tmaxRef,
  zetaOf,
  type Circuit,
  type Output,
} from './reference'
import {
  METRICS_SWEEP_SOURCE,
  PLOT_SNAPSHOT_SOURCE,
  RESPONSE_SWEEP_SOURCE,
  SET_THEN_TEXT_SOURCE,
  STEP_SWEEP_SOURCE,
} from './local'

type Page = CheckContext['page']

interface Pt {
  x: number
  y: number
}

interface Corners {
  left: number
  right: number
  top: number
  bottom: number
}

interface GeoResult {
  ok: boolean
  detail?: string
  points?: Pt[]
  corners?: Pt[]
}

interface LineRead {
  ok: boolean
  detail?: string
  a?: Pt
  b?: Pt
  data?: Record<string, string>
}

interface LineSet {
  count: number
  lines: LineRead[]
}

interface PlotRead {
  attrs: Record<string, string> | null
  area: GeoResult
  line: GeoResult
  lines: LineSet | null
}

interface PlotSnapshot {
  attrs: Record<string, string>
  area: Corners
  verts: Pt[]
  lines: LineSet | null
}

const SHORT = 180

function fail(detail: string): CheckOutcome {
  return { passed: false, detail: detail.length > SHORT ? detail.slice(0, SHORT - 3) + '...' : detail }
}

function pass(detail: string): CheckOutcome {
  return { passed: true, detail }
}

/** The first problems, joined: a short detail with the count. */
function summarise(problems: string[], okText: string): CheckOutcome {
  if (problems.length === 0) return pass(okText)
  return fail(`${problems.length} problem(s); first: ${problems[0]}`)
}

function num(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return NaN
  return Number(value)
}

function circuitOf(set: SeriesSet): Circuit {
  return { R: set.R, L: set.L, C: set.C }
}

function label(set: SeriesSet, output?: Output): string {
  const tag = `R=${set.R} L=${set.L} C=${set.C}`
  return output === undefined ? tag : `${tag} out=${output}`
}

/** The first __bench member a check calls that is missing, or null when all are present. */
async function missingMember(page: Page, members: readonly string[]): Promise<string | null> {
  for (const m of members) {
    if (!(await hookPresent(page, `__bench.${m}`))) return `window.__bench.${m} is missing`
  }
  return null
}

function cornersOf(corners: Pt[]): Corners {
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

/**
 * Set the circuit and read the plot in one JavaScript turn (PLOT_SNAPSHOT_SOURCE):
 * the svg's data-* attributes, the plot rectangle in viewport pixels, the polyline's
 * vertices and, when linesSel is given, the matching lines. Returns a string
 * naming the problem when the plot cannot be read, when its rectangle is too small
 * to show a curve, or when a vertex is not finite.
 */
async function plotSnapshot(
  page: Page,
  set: SeriesSet,
  output: Output,
  svgSel: string,
  areaSel: string,
  lineSel: string,
  linesSel?: string
): Promise<PlotSnapshot | string> {
  const got = await probe<PlotRead>(
    page,
    PLOT_SNAPSHOT_SOURCE,
    { R: set.R, L: set.L, C: set.C, output, svg: svgSel, area: areaSel, line: lineSel, lines: linesSel ?? null },
    2500
  )
  if (got.attrs === null || got.attrs === undefined) return `no element ${svgSel}`
  if (!got.area.ok || got.area.corners === undefined) return `${areaSel}: ${got.area.detail ?? 'no corners'}`
  if (!got.line.ok || got.line.points === undefined) return `${lineSel}: ${got.line.detail ?? 'no points'}`
  const area = cornersOf(got.area.corners)
  const w = area.right - area.left
  const h = area.bottom - area.top
  if (!(w >= TOL.MIN_AREA_PX && h >= TOL.MIN_AREA_PX)) {
    return `${areaSel} is ${w.toFixed(1)} x ${h.toFixed(1)} px on screen (needs ${TOL.MIN_AREA_PX} px each way)`
  }
  if (!got.line.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return `${lineSel} has a non-finite vertex`
  return { attrs: got.attrs, area, verts: got.line.points, lines: got.lines ?? null }
}

/** n points spread linearly from a to b inclusive. */
function linspace(a: number, b: number, n: number): number[] {
  const out: number[] = []
  for (let k = 0; k < n; k++) out.push(a + ((b - a) * k) / (n - 1))
  return out
}

/** Circular difference of two angles in degrees, in [0, 180]. */
function angleDiff(a: number, b: number): number {
  const d = (((a - b + 540) % 360) + 360) % 360
  return Math.abs(d - 180)
}

/**
 * The shared vertex rules of the drawn curves: at least MIN_VERTICES, x never
 * decreasing, and no horizontal gap wider than GAP_FRAC of the width, with the
 * plot edges counted as the ends of the polyline. The caller checks where the
 * first and last vertices sit. Returns the problems found.
 */
function vertexProblems(tag: string, verts: Pt[], left: number, right: number): string[] {
  const problems: string[] = []
  if (verts.length < TOL.MIN_VERTICES) problems.push(`${tag}: ${verts.length} vertices`)
  for (let i = 1; i < verts.length; i++) {
    if (verts[i]!.x < verts[i - 1]!.x - 1e-9) {
      problems.push(`${tag}: x decreases at vertex ${i}`)
      break
    }
  }
  const xs = [left, ...verts.map((p) => p.x), right]
  let gap = 0
  for (let i = 1; i < xs.length; i++) gap = Math.max(gap, xs[i]! - xs[i - 1]!)
  const frac = gap / (right - left)
  if (!(frac <= TOL.GAP_FRAC)) problems.push(`${tag}: a ${(frac * 100).toFixed(1)}% horizontal gap between vertices`)
  return problems
}

/** The true span of a step response over [0, tEnd], with 0 and 1 always included. */
function responseSpan(c: Circuit, tEnd: number): number {
  let lo = 0
  let hi = 1
  for (let k = 0; k <= 4000; k++) {
    const v = stepRef(c, 'C', (tEnd * k) / 4000)
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  return hi - lo
}

/* ---------------------------------------------------------------- rlc-metrics */

const metricsCheck = defineCheck(
  'rlc-metrics',
  10,
  'f0, zeta, Q, bandwidth and the regime word for seven circuits, including exact critical damping and both sides of the 1e-9 band.',
  async (ctx) => {
    const missing = await missingMember(ctx.page, ['set', 'metrics'])
    if (missing) return fail(missing)
    const cases = METRIC_SETS.map((s) => ({ R: s.R, L: s.L, C: s.C, output: 'C' }))
    const rows = await probe<Array<Record<string, unknown> | null>>(ctx.page, METRICS_SWEEP_SOURCE, { cases })
    if (!Array.isArray(rows) || rows.length !== METRIC_SETS.length) return fail('metrics() did not answer for every set')
    const problems: string[] = []
    METRIC_SETS.forEach((set, i) => {
      const got = rows[i]
      const z = zetaOf(circuitOf(set))
      const expected: Record<string, number> = {
        f0: f0Hz(circuitOf(set)),
        zeta: z,
        Q: qOf(z),
        bandwidthHz: bandwidthHz(circuitOf(set)),
      }
      if (got === null || typeof got !== 'object') {
        problems.push(`${label(set)}: no metrics object`)
        return
      }
      for (const key of ['f0', 'zeta', 'Q', 'bandwidthHz']) {
        const value = got[key]
        const exp = expected[key]!
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push(`${label(set)}: ${key} is ${String(value)}`)
        } else if (!(Math.abs(value - exp) <= TOL.METRICS_REL * Math.abs(exp))) {
          problems.push(`${label(set)}: ${key} ${value} vs ${exp}`)
        }
      }
      const regime = regimeOf(z)
      if (got.regime !== regime) problems.push(`${label(set)}: regime ${String(got.regime)} vs ${regime}`)
    })
    return summarise(problems, `${METRIC_SETS.length} circuits within 1e-9 with the exact regime word`)
  }
)

/* ------------------------------------------------------- rlc-peak-overshoot */

const peakOvershootCheck = defineCheck(
  'rlc-peak-overshoot',
  8,
  'The exact resonant peak and the overshoot, including the no-peak and no-overshoot cases (zeta above 1/sqrt(2), and critical or overdamped).',
  async (ctx) => {
    const missing = await missingMember(ctx.page, ['set', 'metrics'])
    if (missing) return fail(missing)
    const cases: Array<{ R: number; L: number; C: number; output: Output }> = []
    for (const z of PEAK_ZETAS) {
      const R = 2 * z * Math.sqrt(PEAK_L / PEAK_C)
      for (const output of ['C', 'L', 'R'] as Output[]) cases.push({ R, L: PEAK_L, C: PEAK_C, output })
    }
    const rows = await probe<Array<Record<string, unknown> | null>>(ctx.page, METRICS_SWEEP_SOURCE, { cases })
    if (!Array.isArray(rows) || rows.length !== cases.length) return fail('metrics() did not answer for every case')
    const problems: string[] = []
    cases.forEach((k, i) => {
      const got = rows[i]
      const c = { R: k.R, L: k.L, C: k.C }
      const what = `zeta=${zetaOf(c).toFixed(3)} out=${k.output}`
      if (got === null || typeof got !== 'object') {
        problems.push(`${what}: no metrics`)
        return
      }
      const peak = got.peakDb
      const expPeak = peakDbRef(c, k.output)
      if (typeof peak !== 'number' || !(Math.abs(peak - expPeak) <= TOL.PEAK_DB)) {
        problems.push(`${what}: peakDb ${String(peak)} vs ${expPeak.toFixed(5)}`)
      }
      const pct = got.overshootPct
      const expPct = overshootPctRef(c)
      if (typeof pct !== 'number' || !(Math.abs(pct - expPct) <= TOL.PEAK_PCT)) {
        problems.push(`${what}: overshootPct ${String(pct)} vs ${expPct.toFixed(5)}`)
      }
    })
    return summarise(problems, `${cases.length} peak and overshoot cases within 1e-3`)
  }
)

/* ------------------------------------------------------------- rlc-response */

const responseCheck = defineCheck(
  'rlc-response',
  14,
  'Gain and phase of all three outputs at and above resonance, for three circuits, modulo 360 degrees.',
  async (ctx) => {
    const missing = await missingMember(ctx.page, ['set', 'response'])
    if (missing) return fail(missing)
    const sets: SeriesSet[] = [SET.U1, SET.U2, SET.OVM]
    const cases: Array<{ R: number; L: number; C: number; output: Output; fs: number[] }> = []
    for (const set of sets) {
      const fs = RESPONSE_MULTIPLES.map((m) => m * f0Hz(circuitOf(set)))
      for (const output of ['C', 'R', 'L'] as Output[]) cases.push({ R: set.R, L: set.L, C: set.C, output, fs })
    }
    const rows = await probe<Array<Array<{ gainDb: number; phaseDeg: number } | null>>>(ctx.page, RESPONSE_SWEEP_SOURCE, { cases })
    if (!Array.isArray(rows) || rows.length !== cases.length) return fail('response() did not answer for every case')
    const problems: string[] = []
    cases.forEach((k, i) => {
      const got = rows[i] ?? []
      k.fs.forEach((f, j) => {
        const g = got[j]
        const what = `R=${k.R} L=${k.L} C=${k.C} out=${k.output} f=${f.toPrecision(5)}`
        if (g === null || typeof g !== 'object') {
          problems.push(`${what}: no response`)
          return
        }
        const c = circuitOf({ R: k.R, L: k.L, C: k.C })
        const expGain = gainDb(c, k.output, f)
        const expPhase = phaseDeg(c, k.output, f)
        if (typeof g.gainDb !== 'number' || !(Math.abs(g.gainDb - expGain) <= TOL.RESPONSE_ABS)) {
          problems.push(`${what}: gain ${String(g.gainDb)} vs ${expGain.toFixed(7)}`)
        }
        if (typeof g.phaseDeg !== 'number' || !(angleDiff(g.phaseDeg, expPhase) <= TOL.RESPONSE_ABS)) {
          problems.push(`${what}: phase ${String(g.phaseDeg)} vs ${expPhase.toFixed(7)}`)
        }
      })
    })
    return summarise(problems, `${cases.length * RESPONSE_MULTIPLES.length} samples within 1e-6 dB and degrees`)
  }
)

/* --------------------------------------------------------- rlc-step-underdamped */

const stepUnderdampedCheck = defineCheck(
  'rlc-step-underdamped',
  10,
  'The closed-form underdamped step response of all three outputs at zeta = 0.005, for U1 and for the R = 1 ohm set.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set', 'stepAt'])
    if (missing) return fail(missing)
    const outs: Output[] = ['C', 'R', 'L']
    const cases: Array<{ R: number; L: number; C: number; output: Output; ts: number[] }> = []
    for (const set of STEP_UNDER_SETS) {
      const period = (2 * set.L) / set.R
      const ts = STEP_UNDER_MULTIPLES.map((m) => m * period)
      for (const output of outs) cases.push({ R: set.R, L: set.L, C: set.C, output, ts })
    }
    if (tools.aborted()) return fail('stopped at the deadline')
    const rows = await probe<Array<Array<number | null>>>(ctx.page, STEP_SWEEP_SOURCE, { cases })
    if (!Array.isArray(rows) || rows.length !== cases.length) return fail('stepAt() did not answer for every case')
    const problems: string[] = []
    cases.forEach((k, i) => {
      k.ts.forEach((t, j) => {
        const g = (rows[i] ?? [])[j]
        const exp = stepRef({ R: k.R, L: k.L, C: k.C }, k.output, t)
        const what = `R=${k.R} L=${k.L} out=${k.output} t=${t.toExponential(3)}`
        if (typeof g !== 'number' || !Number.isFinite(g)) {
          problems.push(`${what}: ${String(g)}`)
        } else if (!(Math.abs(g - exp) <= TOL.STEP_ABS)) {
          problems.push(`${what}: ${g.toFixed(8)} vs ${exp.toFixed(8)}`)
        }
      })
    })
    return summarise(problems, `${cases.length * STEP_UNDER_MULTIPLES.length} samples within 1e-6`)
  }
)

/* ------------------------------------------------- rlc-step-critical-overdamped */

const stepCriticalCheck = defineCheck(
  'rlc-step-critical-overdamped',
  12,
  'The step response of all three outputs stays finite and accurate at exact critical damping, near it on both sides, and stiffly overdamped.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set', 'stepAt'])
    if (missing) return fail(missing)
    const outs: Output[] = ['C', 'R', 'L']
    const cases: Array<{ R: number; L: number; C: number; output: Output; ts: number[] }> = []
    for (const set of STEP_CRIT_SETS) {
      const tau = tauRef(circuitOf(set))
      const ts = STEP_CRIT_MULTIPLES.map((m) => m * tau)
      for (const output of outs) cases.push({ R: set.R, L: set.L, C: set.C, output, ts })
    }
    if (tools.aborted()) return fail('stopped at the deadline')
    const rows = await probe<Array<Array<number | null>>>(ctx.page, STEP_SWEEP_SOURCE, { cases })
    if (!Array.isArray(rows) || rows.length !== cases.length) return fail('stepAt() did not answer for every set')
    const problems: string[] = []
    cases.forEach((k, i) => {
      k.ts.forEach((t, j) => {
        const g = (rows[i] ?? [])[j]
        const exp = stepRef(circuitOf({ R: k.R, L: k.L, C: k.C }), k.output, t)
        const what = `R=${k.R} L=${k.L} C=${k.C} out=${k.output} t=${t.toExponential(3)}`
        if (typeof g !== 'number' || !Number.isFinite(g)) {
          problems.push(`${what}: ${String(g)}`)
        } else if (!(Math.abs(g - exp) <= TOL.STEP_ABS)) {
          problems.push(`${what}: ${g.toFixed(8)} vs ${exp.toFixed(8)}`)
        }
      })
    })
    return summarise(problems, `${cases.length * STEP_CRIT_MULTIPLES.length} samples within 1e-6, all finite`)
  }
)

/* -------------------------------------------------------------- rlc-bode-curve */

const bodeCurveCheck = defineCheck(
  'rlc-bode-curve',
  14,
  'The drawn gain polyline lies on the analytic curve when mapped back through the published axes (log frequency, linear dB).',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set'])
    if (missing) return fail(missing)
    const problems: string[] = []
    for (const cs of BODE_CURVE_CASES) {
      if (tools.aborted()) return fail('stopped at the deadline')
      const c = circuitOf(cs.set)
      const tag = label(cs.set, cs.output)
      const snap = await plotSnapshot(ctx.page, cs.set, cs.output, '#bode', '#bode-area', '#bode-gain')
      if (typeof snap === 'string') return fail(`${tag}: ${snap}`)
      const fmin = num(snap.attrs['data-fmin'])
      const fmax = num(snap.attrs['data-fmax'])
      const dbmin = num(snap.attrs['data-dbmin'])
      const dbmax = num(snap.attrs['data-dbmax'])
      if (![fmin, fmax, dbmin, dbmax].every(Number.isFinite) || !(fmin > 0) || !(fmax > fmin) || !(dbmax > dbmin)) {
        return fail(`${tag}: bad data-f or data-db axis values on #bode`)
      }
      const { left, right, top, bottom } = snap.area
      const width = right - left
      const height = bottom - top
      problems.push(...vertexProblems(tag, snap.verts, left, right))
      const first = snap.verts[0]
      const last = snap.verts[snap.verts.length - 1]
      if (first === undefined || last === undefined) return fail(`${tag}: no vertices`)
      if (!(Math.abs(first.x - left) <= TOL.BODE_EDGE_FRAC * width)) problems.push(`${tag}: first vertex off the left edge`)
      if (!(Math.abs(last.x - right) <= TOL.BODE_EDGE_FRAC * width)) problems.push(`${tag}: last vertex off the right edge`)
      let worst = 0
      let worstAt = -1
      snap.verts.forEach((p, i) => {
        const f = fmin * Math.pow(fmax / fmin, (p.x - left) / width)
        const db = dbmax - ((p.y - top) / height) * (dbmax - dbmin)
        const lo = f / (1 + TOL.BODE_F_SPREAD)
        const hi = f * (1 + TOL.BODE_F_SPREAD)
        let best = Infinity
        for (const fp of linspace(lo, hi, 9)) best = Math.min(best, Math.abs(db - gainDb(c, cs.output, fp)))
        // Math.max keeps a NaN deviation as NaN, so a degenerate vertex can never pass.
        const next = Math.max(worst, best)
        if (next !== worst) worstAt = i
        worst = next
      })
      if (!(worst <= TOL.BODE_DB)) {
        problems.push(`${tag}: vertex ${worstAt} is ${worst.toFixed(2)} dB off the curve`)
      }
    }
    return summarise(problems, `${BODE_CURVE_CASES.length} curves on the analytic gain within 0.5 dB`)
  }
)

/* ---------------------------------------------------------- rlc-bode-autorange */

const bodeAutorangeCheck = defineCheck(
  'rlc-bode-autorange',
  8,
  'Decade-aligned auto-ranging and one gridline per decade, from sub-hertz to megahertz, with nothing clipped.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set'])
    if (missing) return fail(missing)
    const problems: string[] = []
    for (const set of AUTORANGE_SETS) {
      if (tools.aborted()) return fail('stopped at the deadline')
      const c = circuitOf(set)
      const f0 = f0Hz(c)
      const tag = label(set, 'C')
      const snap = await plotSnapshot(ctx.page, set, 'C', '#bode', '#bode-area', '#bode-gain', 'line.decade')
      if (typeof snap === 'string') return fail(`${tag}: ${snap}`)
      const fmin = num(snap.attrs['data-fmin'])
      const fmax = num(snap.attrs['data-fmax'])
      const dbmin = num(snap.attrs['data-dbmin'])
      const dbmax = num(snap.attrs['data-dbmax'])
      if (![fmin, fmax, dbmin, dbmax].every(Number.isFinite) || !(fmin > 0) || !(fmax > fmin)) {
        return fail(`${tag}: bad axis attributes on #bode`)
      }
      if (!(dbmax > dbmin)) problems.push(`${tag}: data-dbmax ${dbmax} is not above data-dbmin ${dbmin}`)
      const lf = Math.log10(fmin)
      const lh = Math.log10(fmax)
      if (Math.abs(lf - Math.round(lf)) > TOL.LOG_INTEGER || Math.abs(lh - Math.round(lh)) > TOL.LOG_INTEGER) {
        problems.push(`${tag}: fmin or fmax is not a power of ten`)
      }
      if (!(fmin <= f0 / 30)) problems.push(`${tag}: fmin ${fmin} above f0/30`)
      if (!(fmax >= 30 * f0)) problems.push(`${tag}: fmax ${fmax} below 30 f0`)
      if (lh - lf > 6 + 1e-9) problems.push(`${tag}: spans ${(lh - lf).toFixed(2)} decades`)
      for (const [name, v] of [
        ['data-dbmin', dbmin],
        ['data-dbmax', dbmax],
      ] as const) {
        if (!(Math.abs(v - 10 * Math.round(v / 10)) <= TOL.TEN_MULTIPLE)) problems.push(`${tag}: ${name} ${v} is not a multiple of 10`)
      }
      const { left, right, top, bottom } = snap.area
      const width = right - left
      const height = bottom - top
      const outside = snap.verts.filter(
        (p) =>
          !(p.x >= left - TOL.AUTORANGE_PX && p.x <= right + TOL.AUTORANGE_PX && p.y >= top - TOL.AUTORANGE_PX && p.y <= bottom + TOL.AUTORANGE_PX)
      )
      if (outside.length > 0) problems.push(`${tag}: ${outside.length} vertices outside #bode-area`)
      problems.push(...vertexProblems(tag, snap.verts, left, right))

      // The decade gridlines of the gain plot: the lines that cover at least half of
      // #bode-area's height. A gridline drawn for another panel (the phase plot) does not count.
      const lines = snap.lines
      if (lines === null) return fail(`${tag}: no line.decade read`)
      const expectedCount = Math.round(lh) - Math.round(lf) + 1
      const inArea: LineRead[] = []
      for (const line of lines.lines) {
        if (!line.ok || line.a === undefined || line.b === undefined) {
          problems.push(`${tag}: ${line.detail ?? 'decade line not rendered'}`)
          continue
        }
        const overlap = Math.min(Math.max(line.a.y, line.b.y), bottom) - Math.max(Math.min(line.a.y, line.b.y), top)
        if (overlap >= TOL.DECADE_OVERLAP_FRAC * height) inArea.push(line)
      }
      if (inArea.length !== expectedCount) problems.push(`${tag}: ${inArea.length} decade lines on #bode-area, expected ${expectedCount}`)
      const seen = new Set<number>()
      for (const line of inArea) {
        if (line.a === undefined || line.b === undefined) continue
        if (!(Math.abs(line.a.x - line.b.x) < TOL.DECADE_VERTICAL_PX)) problems.push(`${tag}: decade line not vertical`)
        const fLine = Number(line.data?.f)
        if (!(fLine > 0) || !Number.isFinite(fLine)) {
          problems.push(`${tag}: data-f ${String(line.data?.f)} does not parse`)
          continue
        }
        const n = Math.round(Math.log10(fLine))
        if (!(Math.abs(fLine - Math.pow(10, n)) <= TOL.DECADE_F_REL * Math.pow(10, n))) {
          problems.push(`${tag}: data-f ${fLine} is not a power of ten`)
          continue
        }
        seen.add(n)
        const x = (line.a.x + line.b.x) / 2
        const predicted = left + ((n - Math.round(lf)) / (Math.round(lh) - Math.round(lf))) * width
        if (!(Math.abs(x - predicted) <= TOL.DECADE_POS_PX)) problems.push(`${tag}: decade 1e${n} at x ${x.toFixed(1)} vs ${predicted.toFixed(1)}`)
      }
      if (seen.size !== expectedCount) problems.push(`${tag}: decades present ${seen.size} of ${expectedCount}`)
    }
    return summarise(problems, `${AUTORANGE_SETS.length} ranges decade-aligned, unclipped, one gridline per decade`)
  }
)

/* ---------------------------------------------------------- rlc-peak-resolved */

const peakResolvedCheck = defineCheck(
  'rlc-peak-resolved',
  8,
  'The drawn gain curve reaches the true resonant peak at Q = 100, for five resonances from 25 Hz to 208 kHz.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set'])
    if (missing) return fail(missing)
    const problems: string[] = []
    for (const lc of PEAK_RESOLVED_LC) {
      if (tools.aborted()) return fail('stopped at the deadline')
      const set: SeriesSet = { R: Math.sqrt(lc.L / lc.C) / PEAK_RESOLVED_Q_DIVISOR, L: lc.L, C: lc.C }
      const tag = `L=${lc.L} C=${lc.C}`
      const snap = await plotSnapshot(ctx.page, set, 'C', '#bode', '#bode-area', '#bode-gain')
      if (typeof snap === 'string') return fail(`${tag}: ${snap}`)
      const dbmin = num(snap.attrs['data-dbmin'])
      const dbmax = num(snap.attrs['data-dbmax'])
      if (!(Number.isFinite(dbmin) && Number.isFinite(dbmax) && dbmax > dbmin)) return fail(`${tag}: bad data-dbmin or data-dbmax on #bode`)
      const { left, right, top, bottom } = snap.area
      const height = bottom - top
      problems.push(...vertexProblems(tag, snap.verts, left, right))
      let highest = -Infinity
      for (const p of snap.verts) highest = Math.max(highest, dbmax - ((p.y - top) / height) * (dbmax - dbmin))
      const truth = peakDbRef(set, 'C')
      if (!(Math.abs(highest - truth) <= TOL.PEAK_RESOLVED_DB)) {
        problems.push(`${tag}: highest vertex ${highest.toFixed(3)} dB vs ${truth.toFixed(5)} dB`)
      }
    }
    return summarise(problems, `${PEAK_RESOLVED_LC.length} resonances resolved within 0.5 dB`)
  }
)

/* ------------------------------------------------------------- rlc-step-plot */

const stepPlotCheck = defineCheck(
  'rlc-step-plot',
  8,
  'The drawn step response and its time window (tmax = 10 tau), checked through the published axes.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set'])
    if (missing) return fail(missing)
    const problems: string[] = []
    for (const set of STEP_PLOT_SETS) {
      if (tools.aborted()) return fail('stopped at the deadline')
      const c = circuitOf(set)
      const tag = label(set, 'C')
      const snap = await plotSnapshot(ctx.page, set, 'C', '#step', '#step-area', '#step-curve')
      if (typeof snap === 'string') return fail(`${tag}: ${snap}`)
      const tmax = num(snap.attrs['data-tmax'])
      const vmin = num(snap.attrs['data-vmin'])
      const vmax = num(snap.attrs['data-vmax'])
      if (![tmax, vmin, vmax].every(Number.isFinite) || !(tmax > 0) || !(vmax > vmin)) return fail(`${tag}: bad step axis attributes`)
      const expected = tmaxRef(c)
      if (!(Math.abs(tmax - expected) <= TOL.STEP_TMAX_REL * expected)) problems.push(`${tag}: data-tmax ${tmax} vs ${expected}`)
      const { left, right, top, bottom } = snap.area
      const width = right - left
      const height = bottom - top
      problems.push(...vertexProblems(tag, snap.verts, left, right))
      const first = snap.verts[0]
      const last = snap.verts[snap.verts.length - 1]
      if (first === undefined || last === undefined) return fail(`${tag}: no vertices`)
      if (!(Math.abs(first.x - left) <= TOL.STEP_EDGE_FRAC * width)) problems.push(`${tag}: curve does not start at t = 0`)
      if (!(last.x - left >= TOL.STEP_END_FRAC * width)) problems.push(`${tag}: curve stops before ${TOL.STEP_END_FRAC * 100}% of the width`)
      // The vertical tolerance is a share of the true span of the response, capped at
      // STEP_SPAN_FACTOR times it, so a range padded to +-1e6 cannot make a flat line pass.
      const cap = Math.min(vmax - vmin, TOL.STEP_SPAN_FACTOR * responseSpan(c, expected))
      let worst = 0
      snap.verts.forEach((p) => {
        if (!(p.x >= left - TOL.STEP_PX && p.x <= right + TOL.STEP_PX && p.y >= top - TOL.STEP_PX && p.y <= bottom + TOL.STEP_PX)) {
          problems.push(`${tag}: vertex outside #step-area`)
        }
        const t = ((p.x - left) / width) * tmax
        const v = vmax - ((p.y - top) / height) * (vmax - vmin)
        let best = Infinity
        for (const tp of linspace(t - TOL.STEP_T_FRAC * tmax, t + TOL.STEP_T_FRAC * tmax, 9)) {
          best = Math.min(best, Math.abs(v - stepRef(c, 'C', tp)))
        }
        worst = Math.max(worst, best)
      })
      if (!(worst <= TOL.STEP_V_FRAC * cap)) {
        problems.push(`${tag}: curve ${worst.toExponential(2)} off the analytic response`)
      }
    }
    return summarise(problems, `${STEP_PLOT_SETS.length} step windows and curves match tmax = 10 tau`)
  }
)

/* ------------------------------------------------------------- rlc-readouts */

function checkEngReadout(problems: string[], what: string, text: string | null | undefined, truth: number): void {
  if (text === null || text === undefined) {
    problems.push(`${what}: missing`)
    return
  }
  const parsed = parseEngHz(text)
  if (parsed === null) {
    problems.push(`${what} "${text}" is not engineering notation`)
    return
  }
  const mantissa = Number(parsed.mantissa)
  if (!(mantissa >= 1 && mantissa < 1000)) problems.push(`${what} "${text}" mantissa outside [1, 1000)`)
  if (parsed.sigDigits !== 4) problems.push(`${what} "${text}" does not have 4 significant digits`)
  if (!(Math.abs(parsed.value - truth) <= TOL.READOUT_REL * truth)) {
    problems.push(`${what} "${text}" vs ${truth.toPrecision(6)} Hz`)
  }
}

function checkPlainReadout(problems: string[], what: string, text: string | null | undefined, truth: number): void {
  if (text === null || text === undefined) {
    problems.push(`${what}: missing`)
    return
  }
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) {
    problems.push(`${what} "${text}" is not a plain decimal`)
    return
  }
  if (significantDigits(text) !== 4) problems.push(`${what} "${text}" does not have 4 significant digits`)
  const value = Number(text)
  if (!(Math.abs(value - truth) <= TOL.READOUT_REL * Math.abs(truth))) problems.push(`${what} "${text}" vs ${truth.toPrecision(6)}`)
}

const readoutsCheck = defineCheck(
  'rlc-readouts',
  8,
  'Engineering-notation readouts for f0 and bandwidth (4 significant digits, prefix rollover, sub-unit values), plain Q and zeta, and the regime word.',
  async (ctx, tools) => {
    const missing = await missingMember(ctx.page, ['set'])
    if (missing) return fail(missing)
    const problems: string[] = []
    const ids = ['readout-f0', 'readout-bw', 'readout-q', 'readout-zeta', 'readout-regime']
    for (const set of READOUT_SETS) {
      if (tools.aborted()) return fail('stopped at the deadline')
      const c = circuitOf(set)
      const texts = await probe<Array<string | null> | null>(ctx.page, SET_THEN_TEXT_SOURCE, { R: set.R, L: set.L, C: set.C, output: 'C', ids }, 2500)
      if (!Array.isArray(texts)) return fail('readout text could not be read')
      const tag = label(set)
      checkEngReadout(problems, `${tag} f0`, texts[0], f0Hz(c))
      checkEngReadout(problems, `${tag} bandwidth`, texts[1], bandwidthHz(c))
      const z = zetaOf(c)
      checkPlainReadout(problems, `${tag} Q`, texts[2], qOf(z))
      checkPlainReadout(problems, `${tag} zeta`, texts[3], z)
      if (texts[4] !== regimeWord(c)) problems.push(`${tag} regime "${String(texts[4])}" vs ${regimeWord(c)}`)
    }
    return summarise(problems, `${READOUT_SETS.length} readout sets pass the 4-digit and prefix rules`)
  }
)

/** The checks in the order the specification gives, keyed by check name. */
export const checks: Record<string, CheckFn> = {
  'rlc-metrics': metricsCheck,
  'rlc-peak-overshoot': peakOvershootCheck,
  'rlc-response': responseCheck,
  'rlc-step-underdamped': stepUnderdampedCheck,
  'rlc-step-critical-overdamped': stepCriticalCheck,
  'rlc-bode-curve': bodeCurveCheck,
  'rlc-bode-autorange': bodeAutorangeCheck,
  'rlc-peak-resolved': peakResolvedCheck,
  'rlc-step-plot': stepPlotCheck,
  'rlc-readouts': readoutsCheck,
}

export const checkNames = Object.keys(checks)

/** The same checks as a list, in specification order: the form the sweep and the fixture matrix take. */
export const checkList: CheckFn[] = checkNames.map((name) => checks[name]!)
