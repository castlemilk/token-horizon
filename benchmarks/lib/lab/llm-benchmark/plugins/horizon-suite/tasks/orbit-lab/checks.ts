/**
 * orbit-lab checks: one defineCheck per entry in the specification, in its order.
 *
 * Each check measures the page through its public contract (window.__bench, the
 * canvas#scene pixels and the three HUD spans) and compares the result with an
 * independent Node computation. A page that does not implement the contract fails
 * inside a probe in milliseconds. A page that answers with frozen numbers fails the
 * timeline guard in runPlan(): a sampled run must advance t by exactly the steps the
 * probe requested, and must move. Without that guard a frozen page would pass every
 * energy and momentum check trivially.
 */
import type { CheckContext, CheckFn } from '../../../../scorers/check-meta'
import { defineCheck } from '../../lib/check'
import { probe } from '../../lib/probe'
import { deepEqual } from '../../lib/math'
import * as R from './reference'
import {
  CONTRACT,
  DIAGNOSTICS,
  DRAWN,
  ENERGY,
  GUARD_SUBSTEPS,
  HUD,
  KEPLER,
  MOMENTUM,
  SOFTENING,
  SYMPLECTIC,
  TRAILS,
  VIEW,
} from './hidden'
import { CONTRACT_SRC, DIAG_SRC, DRAWN_SRC, HUD_SRC, RUNS_SRC, TRAILS_SRC, VIEW_SRC } from './probes'
import type { WireSnap } from './probes'

const PROBE_MS = 4000

/** A decoded snapshot: t and bodies as numbers. */
interface Snap {
  t: number
  bodies: R.Body[]
}

interface Verdict {
  passed: boolean
  detail?: string
}

const pass: Verdict = { passed: true }
const fail = (detail: string): Verdict => ({ passed: false, detail })

function decode(w: WireSnap): Snap {
  return {
    t: Number(w.t),
    bodies: w.bodies.map((b) => ({
      m: Number(b.m),
      x: Number(b.x),
      y: Number(b.y),
      vx: Number(b.vx),
      vy: Number(b.vy),
    })),
  }
}

// ---------------------------------------------------------------------------
// Runs: one probe drives several sampled runs and returns every snapshot.
// ---------------------------------------------------------------------------

interface PlanRun {
  bodies: R.Body[]
  opts: { G: number; dt: number; softening?: number }
  stride: number
  count: number
  reverse?: number
}

interface PlanOut {
  samples: Snap[]
  final: Snap | null
}

async function runPlan(ctx: CheckContext, runs: PlanRun[]): Promise<PlanOut[]> {
  const wire = await probe<Array<{ samples: WireSnap[]; final: WireSnap | null }>>(
    ctx.page,
    RUNS_SRC,
    { runs },
    PROBE_MS
  )
  return wire.map((w) => ({ samples: w.samples.map(decode), final: w.final === null ? null : decode(w.final) }))
}

/** Each sample must sit at t = k * stride * dt (to 1e-9 relative). */
function timelineError(samples: Snap[], stride: number, dt: number): string | undefined {
  for (let k = 0; k < samples.length; k++) {
    const expected = k * stride * dt
    if (!(Math.abs(samples[k].t - expected) <= 1e-9 * Math.max(expected, dt))) {
      return `sample ${k} has t=${samples[k].t}, expected ${expected}`
    }
  }
  return undefined
}

function moved(a: Snap, b: Snap): boolean {
  return a.bodies.some((p, i) => p.x !== b.bodies[i].x || p.y !== b.bodies[i].y)
}

function energyRelative(samples: Snap[], G: number): number[] {
  const e0 = R.energy(samples[0].bodies, G, 0)
  return samples.map((s) => R.relativeEnergyError(e0, R.energy(s.bodies, G, 0)))
}

const finiteMax = (xs: number[]): number => xs.reduce((m, x) => (Number.isNaN(x) ? Infinity : Math.max(m, x)), 0)

/** Every number of a snapshot is finite (NaN and Infinity fail). */
function finiteSnap(s: Snap): boolean {
  return Number.isFinite(s.t) && s.bodies.every((b) => [b.m, b.x, b.y, b.vx, b.vy].every(Number.isFinite))
}

/**
 * The dynamics guard. The state after the first stride of a sampled run must follow
 * gravity: it is compared with an independent Yoshida-4 integration of the same run,
 * GUARD_SUBSTEPS sub-steps per stride. The invariant checks below measure only
 * conserved quantities, so without this guard a page that computes no force (a free
 * drift, a rigid spin) would pass them. Returns the failure, or undefined.
 */
function followsGravity(
  label: string,
  run: { bodies: R.Body[]; opts: { G: number; dt: number }; stride: number },
  first: Snap,
  scale: number,
  tol: number
): string | undefined {
  const ref = R.copyBodies(run.bodies)
  for (let k = 0; k < run.stride * GUARD_SUBSTEPS; k++) R.yoshida4(ref, run.opts.G, 0, run.opts.dt / GUARD_SUBSTEPS)
  let worst = 0
  for (let j = 0; j < ref.length; j++) {
    const q = first.bodies[j]
    const e = q === undefined ? Infinity : Math.hypot(q.x - ref[j].x, q.y - ref[j].y) / scale
    worst = Number.isNaN(e) ? Infinity : Math.max(worst, e)
  }
  if (worst <= tol) return undefined
  return `${label}: after ${run.stride} steps the bodies are ${worst.toExponential(2)} of the scale from an independent integration (bound ${tol}); the state does not follow gravity`
}

// ---------------------------------------------------------------------------
// Softening reference, computed once per process.
// ---------------------------------------------------------------------------

let softeningCache: R.Body[] | undefined

function softeningReference(): R.Body[] {
  if (softeningCache === undefined) {
    softeningCache = R.rk4Reference(
      SOFTENING.bodies,
      SOFTENING.G,
      SOFTENING.softening,
      SOFTENING.steps * SOFTENING.dt,
      SOFTENING.refSteps
    )
  }
  return softeningCache
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const contractPaused = defineCheck(
  'orbit-contract-paused',
  8,
  'Load copies its input, pauses, steps are deterministic and grouping-independent (the wire contract the grader uses).',
  async (ctx): Promise<Verdict> => {
    const w = await probe<{
      s0: WireSnap
      s0b: WireSnap
      s1: WireSnap
      s2: WireSnap
      s3: WireSnap
      s4: WireSnap
      s5: WireSnap
    }>(
      ctx.page,
      CONTRACT_SRC,
      {
        bodies: CONTRACT.bodies,
        opts: CONTRACT.opts,
        mutateBody0X: CONTRACT.mutateBody0X,
        mutateBody2Mass: CONTRACT.mutateBody2Mass,
        frames: CONTRACT.frames,
        frameTimerMs: CONTRACT.frameTimerMs,
        settleMs: CONTRACT.settleMs,
        stepsA: CONTRACT.stepsA,
        stepsB: CONTRACT.stepsB,
        stepsC: CONTRACT.stepsC,
      },
      PROBE_MS
    )
    const s0 = decode(w.s0)
    const s3 = decode(w.s3)
    const input = CONTRACT.bodies
    const exact =
      s0.t === 0 &&
      s0.bodies.length === input.length &&
      s0.bodies.every((b, i) => b.m === input[i].m && b.x === input[i].x && b.y === input[i].y && b.vx === input[i].vx && b.vy === input[i].vy)
    if (!exact) return fail('state right after load is not the numbers that were passed in')
    if (!deepEqual(decode(w.s0b), s0)) return fail('changing the caller array after load changed the state')
    if (!deepEqual(decode(w.s1), s0)) return fail('state changed while paused (frames and timers)')
    if (!deepEqual(decode(w.s2), s0)) return fail('step(0) changed the state')
    // Object.is treats NaN as equal to NaN, so finiteness is tested on its own.
    if (!finiteSnap(s3)) return fail('state is not finite after step(5)')
    if (!(Math.abs(s3.t - CONTRACT.timeAfterFiveSteps) <= CONTRACT.timeTol)) {
      return fail(`t after step(5) is ${s3.t}, expected ${CONTRACT.timeAfterFiveSteps}`)
    }
    if (!moved(s0, s3)) return fail('step(5) moved no body')
    const s4 = decode(w.s4)
    if (!finiteSnap(s4)) return fail('state is not finite after a fresh load and step(5)')
    if (!deepEqual(s4, s3)) return fail('a fresh load and step(5) differ from the first step(5)')
    const s5 = decode(w.s5)
    if (!finiteSnap(s5)) return fail('state is not finite after step(2) and step(3)')
    if (!deepEqual(s5, s3)) return fail('step(2) then step(3) differs from step(5)')
    return pass
  }
)

const keplerPeriod = defineCheck(
  'orbit-kepler-period',
  10,
  'The force law in absolute terms: G, the inverse-square law and the total mass give the period and apoapsis.',
  async (ctx): Promise<Verdict> => {
    const K = KEPLER
    const bodies = R.twoBody(K.G, K.m1, K.m2, K.a, K.e, K.rot, K.boost as [number, number])
    const T = R.period(K.G, K.m1 + K.m2, K.a)
    const dt = T / K.stepsPerPeriod
    const [out] = await runPlan(ctx, [{ bodies, opts: { G: K.G, dt }, stride: K.half, count: 2 }])
    const [s0, sH, sT] = out.samples
    const timeline = timelineError(out.samples, K.half, dt)
    if (timeline !== undefined) return fail(timeline)
    const sep = (s: Snap) => [s.bodies[1].x - s.bodies[0].x, s.bodies[1].y - s.bodies[0].y]
    const a0 = sep(s0)
    const aH = sep(sH)
    const aT = sep(sT)
    const q = (1 + K.e) / (1 - K.e)
    const apo = Math.hypot(aH[0] + q * a0[0], aH[1] + q * a0[1]) / K.a
    const back = Math.hypot(aT[0] - a0[0], aT[1] - a0[1]) / K.a
    const timeErr = Math.abs(sT.t - T) / T
    if (!(apo <= K.posTol)) return fail(`apoapsis relation ${apo.toExponential(2)} > ${K.posTol}`)
    if (!(back <= K.posTol)) return fail(`period return ${back.toExponential(2)} > ${K.posTol}`)
    if (!(timeErr <= K.timeTol)) return fail(`t after one period differs from T by ${timeErr.toExponential(2)} relative`)
    return pass
  }
)

const energyFourth = defineCheck(
  'orbit-energy-fourth-order',
  12,
  'Requirement (a): fourth order or better, as an absolute energy bound and as the error ratio under step halving; plus the figure-eight bound.',
  async (ctx): Promise<Verdict> => {
    const E = ENERGY
    const mass2 = 2 * E.mass
    const runOf = (run: { a: number; rot: number }) => {
      const bodies = R.twoBody(1, E.mass, E.mass, run.a, E.e, run.rot)
      const T = R.period(1, mass2, run.a)
      return {
        scale: run.a * (1 - E.e),
        fine: { bodies, opts: { G: 1, dt: T / E.finePerPeriod }, stride: E.fineStride, count: (E.periods * E.finePerPeriod) / E.fineStride },
        coarse: { bodies, opts: { G: 1, dt: T / E.coarsePerPeriod }, stride: E.coarseStride, count: (E.periods * E.coarsePerPeriod) / E.coarseStride },
        dtFine: T / E.finePerPeriod,
        dtCoarse: T / E.coarsePerPeriod,
      }
    }
    const A = runOf(E.runA)
    const B = runOf(E.runB)
    const fig = R.figureEight(E.fig8.lambda, E.fig8.m, E.fig8.G)
    const figDt = fig.T / E.fig8.stepsPerPeriod
    const figRun = { bodies: fig.bodies, opts: { G: E.fig8.G, dt: figDt }, stride: E.fig8.stride, count: E.fig8.steps / E.fig8.stride }
    const outs = await runPlan(ctx, [A.fine, A.coarse, B.fine, B.coarse, figRun])
    const problems: string[] = []
    const check = (label: string, run: typeof A, fine: Snap[], coarse: Snap[]) => {
      const tf = timelineError(fine, E.fineStride, run.dtFine)
      const tc = timelineError(coarse, E.coarseStride, run.dtCoarse)
      if (tf !== undefined) problems.push(`${label} fine: ${tf}`)
      if (tc !== undefined) problems.push(`${label} coarse: ${tc}`)
      if (tf !== undefined || tc !== undefined) return
      if (!moved(fine[0], fine[fine.length - 1])) problems.push(`${label} fine run did not move`)
      const guard = followsGravity(`${label} fine`, run.fine, fine[1], run.scale, E.guardTol)
      if (guard !== undefined) problems.push(guard)
      const e1000 = finiteMax(energyRelative(fine, 1))
      const e500 = finiteMax(energyRelative(coarse, 1))
      if (!(e1000 < E.bound)) problems.push(`${label} E1000 ${e1000.toExponential(2)} >= ${E.bound}`)
      else if (!(e1000 < E.waiver || e500 / e1000 >= E.ratioMin)) {
        problems.push(`${label} ratio E500/E1000 ${(e500 / e1000).toFixed(2)} < ${E.ratioMin}`)
      }
    }
    check('run A', A, outs[0].samples, outs[1].samples)
    check('run B', B, outs[2].samples, outs[3].samples)
    const figSamples = outs[4].samples
    const tfig = timelineError(figSamples, E.fig8.stride, figDt)
    if (tfig !== undefined) problems.push(`figure-eight: ${tfig}`)
    else {
      if (!moved(figSamples[0], figSamples[figSamples.length - 1])) problems.push('figure-eight did not move')
      const guard = followsGravity('figure-eight', figRun, figSamples[1], E.fig8.lambda, E.fig8.guardTol)
      if (guard !== undefined) problems.push(guard)
      const figErr = finiteMax(energyRelative(figSamples, E.fig8.G))
      if (!(figErr < E.fig8.bound)) problems.push(`figure-eight error ${figErr.toExponential(2)} >= ${E.fig8.bound}`)
    }
    return problems.length === 0 ? pass : fail(problems.join('; '))
  }
)

const symplecticReversible = defineCheck(
  'orbit-symplectic-reversible',
  12,
  'Requirements (b) and (c): Lz conserved to rounding at a coarse step, and exact time reversal, for two and three bodies.',
  async (ctx): Promise<Verdict> => {
    const S = SYMPLECTIC
    const sysA = S.runA
    const sysB = S.runB
    const bodiesA = R.twoBody(S.G, sysA.m1, sysA.m2, sysA.a, S.e, sysA.rot)
    const bodiesB = R.twoBody(S.G, sysB.m1, sysB.m2, sysB.a, S.e, sysB.rot)
    const dtA = R.period(S.G, sysA.m1 + sysA.m2, sysA.a) / S.stepsPerPeriod
    const dtB = R.period(S.G, sysB.m1 + sysB.m2, sysB.a) / S.stepsPerPeriod
    const fig = R.figureEight(S.fig8.lambda, S.fig8.m, S.fig8.G)
    const dtC = fig.T / S.fig8.stepsPerPeriod
    const opts = (dt: number) => ({ G: S.G, dt })
    const outs = await runPlan(ctx, [
      { bodies: bodiesA, opts: opts(dtA), stride: S.stride, count: (S.periods * S.stepsPerPeriod) / S.stride },
      { bodies: bodiesA, opts: opts(dtA), stride: S.reverseSteps, count: 1, reverse: S.reverseSteps },
      { bodies: bodiesB, opts: opts(dtB), stride: S.stride, count: (S.periods * S.stepsPerPeriod) / S.stride },
      { bodies: bodiesB, opts: opts(dtB), stride: S.reverseSteps, count: 1, reverse: S.reverseSteps },
      { bodies: fig.bodies, opts: opts(dtC), stride: S.fig8.stride, count: S.fig8.steps / S.fig8.stride },
      { bodies: fig.bodies, opts: opts(dtC), stride: S.fig8.reverseSteps, count: 1, reverse: S.fig8.reverseSteps },
    ])
    const problems: string[] = []
    const lzWorst = (samples: Snap[]) => {
      const L0 = R.angularMomentum(samples[0].bodies)
      return finiteMax(samples.map((s) => Math.abs((R.angularMomentum(s.bodies) - L0) / L0)))
    }
    const lzAbsWorst = (samples: Snap[], scale: number) => {
      const L0 = R.angularMomentum(samples[0].bodies)
      return finiteMax(samples.map((s) => Math.abs(R.angularMomentum(s.bodies) - L0) / scale))
    }
    const reversalWorst = (final: Snap | null, initial: R.Body[], scale: number) => {
      if (final === null) return Infinity
      return finiteMax(final.bodies.map((p, i) => Math.hypot(p.x - initial[i].x, p.y - initial[i].y) / scale))
    }
    const D_A = sysA.a * (1 - S.e)
    const D_B = sysB.a * (1 - S.e)
    const D_C = R.largestPairDistance(fig.bodies)
    const tA = timelineError(outs[0].samples, S.stride, dtA)
    const tB = timelineError(outs[2].samples, S.stride, dtB)
    const tC = timelineError(outs[4].samples, S.fig8.stride, dtC)
    if (tA !== undefined) problems.push(`run A: ${tA}`)
    if (tB !== undefined) problems.push(`run B: ${tB}`)
    if (tC !== undefined) problems.push(`figure-eight: ${tC}`)
    if (problems.length === 0) {
      const guards = [
        followsGravity('run A', { bodies: bodiesA, opts: opts(dtA), stride: S.stride }, outs[0].samples[1], D_A, S.guardTol),
        followsGravity('run B', { bodies: bodiesB, opts: opts(dtB), stride: S.stride }, outs[2].samples[1], D_B, S.guardTol),
        followsGravity(
          'figure-eight',
          { bodies: fig.bodies, opts: opts(dtC), stride: S.fig8.stride },
          outs[4].samples[1],
          S.fig8.lambda,
          S.fig8.guardTol
        ),
      ]
      for (const guard of guards) if (guard !== undefined) problems.push(guard)
      const lzA = lzWorst(outs[0].samples)
      const lzB = lzWorst(outs[2].samples)
      if (!(lzA < S.lzBound)) problems.push(`run A Lz drift ${lzA.toExponential(2)}`)
      if (!(lzB < S.lzBound)) problems.push(`run B Lz drift ${lzB.toExponential(2)}`)
      const revA = reversalWorst(outs[1].final, bodiesA, D_A)
      const revB = reversalWorst(outs[3].final, bodiesB, D_B)
      if (!(revA < S.reverseBound)) problems.push(`run A reversal ${revA.toExponential(2)}*D`)
      if (!(revB < S.reverseBound)) problems.push(`run B reversal ${revB.toExponential(2)}*D`)
      const S_C = R.angularScale(fig.bodies)
      const lzC = lzAbsWorst(outs[4].samples, S_C)
      if (!(lzC < S.fig8.lzBound)) problems.push(`figure-eight Lz drift ${lzC.toExponential(2)} of scale`)
      const revC = reversalWorst(outs[5].final, fig.bodies, D_C)
      if (!(revC < S.fig8.reverseBound)) problems.push(`figure-eight reversal ${revC.toExponential(2)}*D`)
      if (!moved(outs[1].samples[0], outs[1].samples[1])) problems.push('run A did not move')
      if (!moved(outs[5].samples[0], outs[5].samples[1])) problems.push('figure-eight did not move')
    }
    return problems.length === 0 ? pass : fail(problems.join('; '))
  }
)

const momentumCom = defineCheck(
  'orbit-momentum-com',
  6,
  'Nothing in the simulated state is re-centred or damped, and forces obey action-reaction: momentum is constant and the centre of mass moves straight.',
  async (ctx): Promise<Verdict> => {
    const M = MOMENTUM
    const [out] = await runPlan(ctx, [{ bodies: M.bodies, opts: M.opts, stride: M.stride, count: M.count }])
    const timeline = timelineError(out.samples, M.stride, M.opts.dt)
    if (timeline !== undefined) return fail(timeline)
    if (!moved(out.samples[0], out.samples[out.samples.length - 1])) return fail('the system did not move')
    const guard = followsGravity(
      'system',
      { bodies: M.bodies, opts: M.opts, stride: M.stride },
      out.samples[1],
      R.largestPairDistance(M.bodies),
      M.guardTol
    )
    if (guard !== undefined) return fail(guard)
    const s0 = out.samples[0]
    const P0 = R.momentum(s0.bodies)
    const C0 = R.centreOfMass(s0.bodies)
    const total = R.totalMass(s0.bodies)
    const P0norm = Math.hypot(P0[0], P0[1])
    let worstP = 0
    let worstC = 0
    for (const s of out.samples) {
      const P = R.momentum(s.bodies)
      const C = R.centreOfMass(s.bodies)
      worstP = Math.max(worstP, Math.hypot(P[0] - P0[0], P[1] - P0[1]) / P0norm)
      worstC = Math.max(worstC, Math.hypot(C[0] - (C0[0] + (P0[0] / total) * s.t), C[1] - (C0[1] + (P0[1] / total) * s.t)))
    }
    if (!(worstP <= M.momentumTol)) return fail(`momentum drift ${worstP.toExponential(2)} relative`)
    if (!(worstC <= M.comTol)) return fail(`centre of mass off its straight line by ${worstC.toExponential(2)}`)
    return pass
  }
)

const softeningReferenceCheck = defineCheck(
  'orbit-softening-reference',
  8,
  'Plummer softening is applied as r^2 + eps^2 in the force, checked against the grader own high-resolution integration.',
  async (ctx): Promise<Verdict> => {
    const [out] = await runPlan(ctx, [
      {
        bodies: SOFTENING.bodies,
        opts: { G: SOFTENING.G, dt: SOFTENING.dt, softening: SOFTENING.softening },
        stride: SOFTENING.steps,
        count: 1,
      },
    ])
    const timeline = timelineError(out.samples, SOFTENING.steps, SOFTENING.dt)
    if (timeline !== undefined) return fail(timeline)
    const end = out.samples[1]
    if (!moved(out.samples[0], end)) return fail('the system did not move')
    const ref = softeningReference()
    const worst = finiteMax(end.bodies.map((p, i) => Math.hypot(p.x - ref[i].x, p.y - ref[i].y)))
    if (!(worst < SOFTENING.bound)) return fail(`position error ${worst.toExponential(2)} >= ${SOFTENING.bound}`)
    return pass
  }
)

const diagnosticsCheck = defineCheck(
  'orbit-diagnostics',
  10,
  'diagnostics() implements the stated formulas: pair potential counted once with softening, origin-referenced angular momentum, mass-weighted centre of mass.',
  async (ctx): Promise<Verdict> => {
    const D = DIAGNOSTICS
    const wire = await probe<Array<{ d0: string[]; s0: WireSnap; d1: string[]; s1: WireSnap }>>(
      ctx.page,
      DIAG_SRC,
      {
        configs: D.configs.map((c) => ({
          bodies: c.bodies,
          opts: { G: c.G, dt: c.dt, softening: c.softening },
          steps: D.steps,
        })),
      },
      PROBE_MS
    )
    const problems: string[] = []
    wire.forEach((w, i) => {
      const cfg = D.configs[i]
      const s0 = decode(w.s0)
      const s1 = decode(w.s1)
      const tl = Math.abs(s1.t - D.steps * cfg.dt) <= 1e-9 * D.steps * cfg.dt
      if (!tl) problems.push(`config ${i}: t after step(${D.steps}) is ${s1.t}`)
      if (!moved(s0, s1)) problems.push(`config ${i}: step(${D.steps}) moved nothing`)
      for (const [label, flat, snapshot] of [
        ['t0', w.d0, s0],
        ['t1', w.d1, s1],
      ] as const) {
        const ref = R.diagnosticsOf(snapshot.bodies, cfg.G, cfg.softening)
        const expected = [ref.kinetic, ref.potential, ref.energy, ref.angularMomentum, ref.momentum[0], ref.momentum[1], ref.com[0], ref.com[1]]
        const names = ['kinetic', 'potential', 'energy', 'angularMomentum', 'momentum x', 'momentum y', 'com x', 'com y']
        expected.forEach((want, k) => {
          const got = Number(flat[k])
          const tol = Math.max(D.relTol * Math.abs(want), D.absFloor)
          if (!(Math.abs(got - want) <= tol)) {
            problems.push(`config ${i} ${label} ${names[k]}: ${got} vs ${want}`)
          }
        })
      }
    })
    return problems.length === 0 ? pass : fail(problems.slice(0, 3).join('; '))
  }
)

const hudNumbers = defineCheck(
  'orbit-hud-numbers',
  6,
  'The on-page HUD shows the true time, energy and angular momentum to at least 7 significant digits.',
  async (ctx): Promise<Verdict> => {
    const w = await probe<{ time: string | null; energy: string | null; angmom: string | null; state: WireSnap }>(
      ctx.page,
      HUD_SRC,
      { bodies: HUD.bodies, opts: HUD.opts, steps: HUD.steps },
      PROBE_MS
    )
    const parse = (text: string | null): number => (text === null || text === '' ? NaN : Number(text))
    const time = parse(w.time)
    const energy = parse(w.energy)
    const angmom = parse(w.angmom)
    if (!Number.isFinite(time) || !Number.isFinite(energy) || !Number.isFinite(angmom)) {
      return fail(`HUD text is not a number: ${w.time} | ${w.energy} | ${w.angmom}`)
    }
    const state = decode(w.state)
    const eRef = R.energy(state.bodies, HUD.opts.G, 0)
    const lRef = R.angularMomentum(state.bodies)
    const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want)
    if (!(rel(time, HUD.time) <= HUD.relTol)) return fail(`time ${time} vs ${HUD.time}`)
    if (!(rel(energy, eRef) <= HUD.relTol)) return fail(`energy ${energy} vs ${eRef}`)
    if (!(rel(angmom, lRef) <= HUD.relTol)) return fail(`angular momentum ${angmom} vs ${lRef}`)
    return pass
  }
)

const viewFit = defineCheck(
  'orbit-view-fit',
  8,
  'The camera is an isotropic y-up affine map that auto-fits systems of any size and offset, and the canvas is large.',
  async (ctx): Promise<Verdict> => {
    const V = VIEW
    const wire = await probe<
      Array<{
        W: string
        H: string
        p0: string[]
        px: string[]
        py: string[]
        p2: string[]
        proj: string[][]
        rect: string[]
      }>
    >(
      ctx.page,
      VIEW_SRC,
      {
        systems: V.systems.map((s) => ({ cx: s.cx, cy: s.cy, d: s.d, bodies: s.bodies, opts: V.opts })),
      },
      PROBE_MS
    )
    const problems: string[] = []
    wire.forEach((r, idx) => {
      const sys = V.systems[idx]
      const W = Number(r.W)
      const H = Number(r.H)
      const pt = (p: string[]) => [Number(p[0]), Number(p[1])]
      const p0 = pt(r.p0)
      const px = pt(r.px)
      const py = pt(r.py)
      const p2 = pt(r.p2)
      const proj = r.proj.map(pt)
      const d = sys.d
      const sx = (px[0] - p0[0]) / d
      const sy = (p0[1] - py[1]) / d
      const tol = V.isoTol * sx * d
      const where = sys.name
      if (!(sx > 0 && sy > 0)) problems.push(`${where}: scale ${sx}, ${sy} not positive (y up, x right)`)
      else {
        if (!(Math.abs(sx - sy) <= V.isoTol * sx)) problems.push(`${where}: x scale ${sx} != y scale ${sy}`)
        if (!(Math.abs(px[1] - p0[1]) <= tol && Math.abs(py[0] - p0[0]) <= tol)) problems.push(`${where}: rotation or shear`)
        if (!(Math.abs(p2[0] - px[0] - (px[0] - p0[0])) <= tol && Math.abs(p2[1] - px[1] - (px[1] - p0[1])) <= tol)) {
          problems.push(`${where}: not affine along x`)
        }
      }
      const margin = V.marginFraction * Math.min(W, H) - V.marginPx
      const inside = proj.every((p) => p[0] >= margin && p[0] <= W - margin && p[1] >= margin && p[1] <= H - margin)
      if (!inside) problems.push(`${where}: a body lies outside the ${margin.toFixed(1)} px margin`)
      const xs = proj.map((p) => p[0])
      const ys = proj.map((p) => p[1])
      const longer = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      if (!(longer >= V.longerFraction * Math.min(W, H))) {
        problems.push(`${where}: bounding box ${longer.toFixed(1)} px < ${(V.longerFraction * Math.min(W, H)).toFixed(1)}`)
      }
      if (idx === 0) {
        // "The canvas covers at least half of the browser window": the part of the canvas
        // inside the viewport must cover that much. A canvas below the fold still counts
        // for what the reader sees, so the rectangle is intersected, not required to fit.
        const [left, top, right, bottom] = r.rect.map(Number)
        const visibleWidth = Math.max(0, Math.min(right, V.viewport.width) - Math.max(left, 0))
        const visibleHeight = Math.max(0, Math.min(bottom, V.viewport.height) - Math.max(top, 0))
        const visible = visibleWidth * visibleHeight
        if (!(visible >= V.minArea)) problems.push(`canvas covers ${visible} px^2 of the viewport, below ${V.minArea}`)
      }
    })
    return problems.length === 0 ? pass : fail(problems.slice(0, 3).join('; '))
  }
)

const bodiesDrawn = defineCheck(
  'orbit-bodies-drawn',
  12,
  'Bodies are drawn where project() says, as solid discs in index-specific colours, and the colours follow the index, not the position.',
  async (ctx): Promise<Verdict> => {
    type Rgba = number[] | null
    const w = await probe<{
      ok: boolean
      detail?: string
      bg?: number[]
      pts?: number[][]
      centre?: Rgba[]
      samples?: Rgba[][]
      after?: Rgba[]
    }>(ctx.page, DRAWN_SRC, { bodies: DRAWN.bodies, opts: DRAWN.opts, offset: DRAWN.sampleOffset }, PROBE_MS)
    if (!w.ok || w.bg === undefined || w.centre === undefined || w.samples === undefined || w.after === undefined) {
      return fail(w.detail ?? 'canvas could not be read')
    }
    const diff = (a: number[], b: number[]) => Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[k] - b[k])))
    const problems: string[] = []
    const bg = w.bg
    DRAWN.bodies.forEach((_, k) => {
      w.samples![k].forEach((s, j) => {
        if (s === null) problems.push(`body ${k} sample ${j} is off canvas`)
        else if (!(diff(s, bg) >= DRAWN.minDiff)) problems.push(`body ${k} sample ${j} is not drawn (diff ${diff(s, bg).toFixed(0)})`)
      })
    })
    const c = w.centre
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        if (c[i] === null || c[j] === null) problems.push(`centre ${i} or ${j} is off canvas`)
        else if (!(diff(c[i]!, c[j]!) >= DRAWN.minDiff)) problems.push(`bodies ${i} and ${j} share a colour`)
      }
    }
    const a = w.after
    const tol = DRAWN.swapTol
    const near = (x: Rgba, y: Rgba) => x !== null && y !== null && diff(x, y) <= tol
    if (!near(a[0], c[1])) problems.push('after swap, body 1 is not drawn in its own colour')
    if (!near(a[1], c[0])) problems.push('after swap, body 0 is not drawn in its own colour')
    if (!near(a[2], c[2])) problems.push('body 2 colour changed after swap')
    return problems.length === 0 ? pass : fail(problems.slice(0, 3).join('; '))
  }
)

const trailsHistory = defineCheck(
  'orbit-trails-history',
  8,
  'Trails are stored history redrawn on each render: visible, cleared on load, and render() is idempotent.',
  async (ctx): Promise<Verdict> => {
    const bin = TRAILS.binary
    // Two binaries: the separation along x, and along y. The page picks the one along its
    // shorter canvas axis, so a camera that fits the separation to the shorter axis keeps
    // the orbit on the canvas (the pure width-limited fit, on a landscape canvas, would not).
    const horizontal = R.twoBody(bin.G, bin.m, bin.m, bin.separation, 0, 0)
    const vertical = R.twoBody(bin.G, bin.m, bin.m, bin.separation, 0, Math.PI / 2)
    const dt = R.period(bin.G, 2 * bin.m, bin.separation) / bin.stepsPerPeriod
    const w = await probe<{
      ok: boolean
      detail?: string
      vertical?: boolean
      on?: boolean[]
      lit?: boolean[]
      identical?: boolean
      relit?: boolean[]
      bg2?: number[]
      q?: number[][]
      newPts?: number[][]
      after?: Array<number[] | null>
    }>(
      ctx.page,
      TRAILS_SRC,
      {
        horizontal,
        vertical,
        opts: { G: bin.G, dt },
        cycles: TRAILS.cycles,
        stepsPerCycle: TRAILS.stepsPerCycle,
        litDiff: TRAILS.litDiff,
        far: TRAILS.far,
      },
      PROBE_MS
    )
    if (!w.ok || !w.on || !w.lit || !w.relit || !w.q || !w.after || !w.bg2 || !w.newPts) {
      return fail(w.detail ?? 'canvas could not be read')
    }
    const { on, lit, relit, q, newPts, after, bg2 } = w
    const problems: string[] = []
    // Only the points that are on the canvas can be judged: an orbit that leaves the
    // canvas leaves no pixels to read, and that is the camera's fault, not the trails'.
    const judged = on.flatMap((v, k) => (v ? [k] : []))
    if (judged.length < TRAILS.minJudged) problems.push(`only ${judged.length} of ${on.length} trail points are on the canvas`)
    const share = (flags: boolean[]) => (judged.length === 0 ? 0 : judged.filter((k) => flags[k]).length / judged.length)
    const litFraction = share(lit)
    if (!(litFraction >= TRAILS.litFraction)) {
      problems.push(`only ${(100 * litFraction).toFixed(0)}% of on-canvas trail points are drawn`)
    }
    if (w.identical !== true) problems.push('render() is not idempotent')
    // Stored history: after the canvas is wiped, render() must draw the trail again.
    const relitFraction = share(relit)
    if (!(relitFraction >= TRAILS.litFraction)) {
      problems.push(`after the canvas is wiped, render() redraws only ${(100 * relitFraction).toFixed(0)}% of the trail (not stored history)`)
    }
    const candidates = judged.filter((k) => newPts.every((n) => Math.hypot(q[k][0] - n[0], q[k][1] - n[1]) > TRAILS.excludePx))
    if (candidates.length < TRAILS.minCandidates) problems.push(`only ${candidates.length} old points are clear of the new bodies`)
    const matched = candidates.filter((k) => {
      const px = after[k]
      return px !== null && [0, 1, 2, 3].every((c) => Math.abs(px[c] - bg2[c]) <= TRAILS.matchTol)
    })
    const matchFraction = candidates.length === 0 ? 0 : matched.length / candidates.length
    if (!(matchFraction >= TRAILS.matchFraction)) {
      problems.push(`${(100 * matchFraction).toFixed(0)}% of old trail points left after a load (want ${100 * TRAILS.matchFraction}%)`)
    }
    return problems.length === 0 ? pass : fail(problems.join('; '))
  }
)

/** The checks, keyed by name, in the order of the specification. */
export const checks: Record<string, CheckFn> = {
  'orbit-contract-paused': contractPaused,
  'orbit-kepler-period': keplerPeriod,
  'orbit-energy-fourth-order': energyFourth,
  'orbit-symplectic-reversible': symplecticReversible,
  'orbit-momentum-com': momentumCom,
  'orbit-softening-reference': softeningReferenceCheck,
  'orbit-diagnostics': diagnosticsCheck,
  'orbit-hud-numbers': hudNumbers,
  'orbit-view-fit': viewFit,
  'orbit-bodies-drawn': bodiesDrawn,
  'orbit-trails-history': trailsHistory,
}

export const CHECK_NAMES: string[] = Object.keys(checks)

/** The checks as an ordered list: the export the tsx-loader matrix run scores through. */
export const CHECK_LIST: CheckFn[] = CHECK_NAMES.map((name) => checks[name])
