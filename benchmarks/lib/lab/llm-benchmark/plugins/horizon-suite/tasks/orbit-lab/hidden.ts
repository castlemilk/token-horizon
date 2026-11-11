/**
 * Every hidden constant the orbit-lab checks use. This is the single source for
 * checks.ts, fixtures.ts and the tests, so they cannot drift apart. The version
 * string is written to the run log; rotate the values and bump the version if the
 * repository ever becomes public.
 *
 * Nothing in this file may appear in the prompt. checks.test.ts enforces that for
 * the distinctive values. The public thresholds (2e-6, 1e-10, ...) are stated in
 * the prompt on purpose and are not secret.
 */

export const HIDDEN_VERSION = 'orbit-lab/v2'

/**
 * The dynamics guard. The state after the first stride of a sampled run must follow
 * gravity: it is compared with an independent Yoshida-4 integration that takes this
 * many sub-steps per stride. Any accurate integrator passes it; a page that computes
 * no force, drifts freely or spins rigidly does not. The tolerances below sit between
 * the errors of the conforming integrators (Yoshida, Verlet) and the errors of the
 * free-drift, rigid-body and frozen cheats, all measured with this reference.
 */
export const GUARD_SUBSTEPS = 64

export interface HiddenBody {
  m: number
  x: number
  y: number
  vx: number
  vy: number
}

export interface HiddenOpts {
  G: number
  dt: number
  softening?: number
}

// ---------------------------------------------------------------------------
// orbit-contract-paused
// ---------------------------------------------------------------------------

export const CONTRACT = {
  bodies: [
    { m: 1.3, x: -0.7, y: 0.2, vx: 0.11, vy: -0.42 },
    { m: 0.6, x: 1.1, y: 0.5, vx: -0.3, vy: 0.25 },
    { m: 2.1, x: 0.15, y: -0.9, vx: 0.02, vy: 0.19 },
  ] as HiddenBody[],
  opts: { G: 0.83, dt: 0.004 } as HiddenOpts,
  /** The probe mutates its own array after load: body 0 moves, body 2's mass changes. */
  mutateBody0X: 5,
  mutateBody2Mass: 99,
  /** Frames awaited (raced against a timer) after load, then a settle time. */
  frames: 3,
  frameTimerMs: 400,
  settleMs: 120,
  /** step(5) against step(2) followed by step(3). */
  stepsA: 5,
  stepsB: 2,
  stepsC: 3,
  /** t after step(5) with dt 0.004. */
  timeAfterFiveSteps: 0.02,
  timeTol: 1e-12,
}

// ---------------------------------------------------------------------------
// orbit-kepler-period
// ---------------------------------------------------------------------------

export const KEPLER = {
  G: 0.37,
  m1: 9.1,
  m2: 1.3,
  a: 2.4,
  e: 0.3,
  rot: 0.7,
  boost: [0.05, 0.02] as [number, number],
  /** One period is 4000 steps; the probe takes 2000 then 2000 more. */
  stepsPerPeriod: 4000,
  half: 2000,
  posTol: 5e-3,
  timeTol: 1e-9,
}

// ---------------------------------------------------------------------------
// orbit-energy-fourth-order
// ---------------------------------------------------------------------------

export const ENERGY = {
  G: 1,
  mass: 1.5,
  e: 0.5,
  periods: 10,
  /** Run A and B: fine (1000 steps per period, sampled every 20) and coarse (500 per period, every 10). */
  finePerPeriod: 1000,
  coarsePerPeriod: 500,
  fineStride: 20,
  coarseStride: 10,
  runA: { a: 0.8, rot: 1.1 },
  runB: { a: 37, rot: -2.3 },
  bound: 2e-6,
  waiver: 1e-10,
  ratioMin: 10,
  /** Dynamics guard on the fine runs, as a fraction of the periapsis separation. */
  guardTol: 1e-3,
  fig8: {
    lambda: 3.2,
    m: 0.8,
    G: 1,
    stepsPerPeriod: 1000,
    steps: 2000,
    stride: 20,
    bound: 1e-7,
    /** Dynamics guard on the figure-eight, as a fraction of lambda. */
    guardTol: 1e-3,
  },
}

// ---------------------------------------------------------------------------
// orbit-symplectic-reversible
// ---------------------------------------------------------------------------

export const SYMPLECTIC = {
  G: 1,
  e: 0.6,
  periods: 10,
  stepsPerPeriod: 100,
  stride: 10,
  reverseSteps: 350,
  lzBound: 1e-11,
  reverseBound: 1e-10,
  /** Dynamics guard on runs A and B, as a fraction of the periapsis separation. */
  guardTol: 0.15,
  runA: { m1: 1.5, m2: 1.5, a: 2.2, rot: 0.4 },
  runB: { m1: 2.3, m2: 0.7, a: 31, rot: -0.9 },
  fig8: {
    lambda: 3.2,
    m: 0.8,
    G: 1,
    stepsPerPeriod: 100,
    steps: 200,
    stride: 10,
    reverseSteps: 150,
    lzBound: 1e-11,
    reverseBound: 1e-10,
    /** Dynamics guard on the figure-eight, as a fraction of lambda. */
    guardTol: 0.03,
  },
}

// ---------------------------------------------------------------------------
// orbit-momentum-com
// ---------------------------------------------------------------------------

export const MOMENTUM = {
  bodies: [
    { m: 1, x: -2, y: 0.5, vx: 0.3, vy: 0.4 },
    { m: 2.5, x: 1.5, y: -1, vx: 0.1, vy: -0.2 },
    { m: 0.4, x: 0.5, y: 2.2, vx: -0.5, vy: 0.1 },
  ] as HiddenBody[],
  opts: { G: 1, dt: 0.002 } as HiddenOpts,
  stride: 100,
  count: 6,
  momentumTol: 1e-10,
  comTol: 1e-9,
  /** Dynamics guard, as a fraction of the largest pair distance at load. */
  guardTol: 2e-4,
}

// ---------------------------------------------------------------------------
// orbit-softening-reference
// ---------------------------------------------------------------------------

export const SOFTENING = {
  G: 1,
  softening: 0.6,
  dt: 0.0025,
  steps: 2400,
  refSteps: 48000,
  bound: 2e-3,
  bodies: [
    { m: 2, x: -1.1, y: -0.16666667, vx: 0.1, vy: -0.55 },
    { m: 2, x: 1.0, y: -0.66666667, vx: -0.2, vy: 0.6 },
    { m: 2, x: 0.1, y: 0.83333333, vx: 0.1, vy: -0.05 },
  ] as HiddenBody[],
}

// ---------------------------------------------------------------------------
// orbit-diagnostics
// ---------------------------------------------------------------------------

export const DIAGNOSTICS = {
  steps: 10,
  relTol: 1e-10,
  absFloor: 1e-12,
  configs: [
    {
      G: 2.6,
      dt: 0.002,
      softening: 0,
      bodies: [
        { m: 1.7, x: 0.4, y: -1.2, vx: 0.5, vy: 0.2 },
        { m: 0.6, x: -1.5, y: 0.8, vx: -0.3, vy: 0.6 },
        { m: 2.9, x: 2.0, y: 1.1, vx: 0.1, vy: -0.4 },
        { m: 1.1, x: -0.3, y: -2.4, vx: -0.5, vy: -0.1 },
      ] as HiddenBody[],
    },
    {
      G: 2.6,
      dt: 0.002,
      softening: 0.35,
      bodies: [
        { m: 0.9, x: -0.6, y: 0.9, vx: -0.4, vy: 0.3 },
        { m: 2.2, x: 1.3, y: -0.4, vx: 0.2, vy: 0.5 },
        { m: 1.4, x: 0.2, y: -1.7, vx: 0.6, vy: 0.1 },
        { m: 3.1, x: -2.1, y: -0.8, vx: -0.2, vy: -0.3 },
      ] as HiddenBody[],
    },
  ] as Array<{ G: number; dt: number; softening: number; bodies: HiddenBody[] }>,
}

// ---------------------------------------------------------------------------
// orbit-hud-numbers
// ---------------------------------------------------------------------------

export const HUD = {
  bodies: CONTRACT.bodies,
  opts: { G: 1.9, dt: 0.004 } as HiddenOpts,
  steps: 7,
  /** t = 7 * 0.004. */
  time: 0.028,
  relTol: 2e-6,
}

// ---------------------------------------------------------------------------
// orbit-view-fit
// ---------------------------------------------------------------------------

/** A square cluster of three bodies spanning `span` world units, centred on (cx, cy). */
function squareSystem(cx: number, cy: number, span: number): HiddenBody[] {
  const h = span / 2
  return [
    { m: 1, x: cx - h, y: cy - h, vx: 0, vy: 0 },
    { m: 1, x: cx + h, y: cy + h, vx: 0, vy: 0 },
    { m: 1, x: cx, y: cy, vx: 0, vy: 0 },
  ]
}

export const VIEW = {
  viewport: { width: 1024, height: 720 },
  marginFraction: 0.05,
  marginPx: 0.5,
  longerFraction: 0.35,
  minArea: 368640,
  isoTol: 1e-6,
  systems: [
    { name: 'tiny', cx: 5.3, cy: -2.1, d: 0.012 / 4, bodies: squareSystem(5.3, -2.1, 0.012) },
    { name: 'vast', cx: -3000, cy: 800, d: 1400 / 4, bodies: squareSystem(-3000, 800, 1400) },
    {
      name: 'tall',
      cx: 0,
      cy: 0,
      d: 6 / 4,
      bodies: [
        { m: 1, x: -0.2, y: -3, vx: 0, vy: 0 },
        { m: 1, x: 0.2, y: 3, vx: 0, vy: 0 },
        { m: 1, x: 0, y: 0, vx: 0, vy: 0 },
      ] as HiddenBody[],
    },
  ] as Array<{ name: string; cx: number; cy: number; d: number; bodies: HiddenBody[] }>,
  opts: { G: 1, dt: 0.001 } as HiddenOpts,
}

// ---------------------------------------------------------------------------
// orbit-bodies-drawn
// ---------------------------------------------------------------------------

export const DRAWN = {
  bodies: [
    { m: 1, x: -2.4, y: 1.1, vx: 0, vy: 0 },
    { m: 1, x: 1.9, y: 2.2, vx: 0, vy: 0 },
    { m: 1, x: 0.6, y: -2.5, vx: 0, vy: 0 },
  ] as HiddenBody[],
  opts: { G: 1, dt: 0.001 } as HiddenOpts,
  /** Samples at 2 px from the centre, plus the 3x3 mean at the centre. */
  sampleOffset: 2,
  minDiff: 40,
  swapTol: 12,
}

// ---------------------------------------------------------------------------
// orbit-trails-history
// ---------------------------------------------------------------------------

export const TRAILS = {
  binary: {
    G: 1,
    m: 1,
    separation: 1,
    stepsPerPeriod: 240,
  },
  cycles: 80,
  stepsPerCycle: 3,
  litFraction: 0.9,
  litDiff: 40,
  excludePx: 30,
  matchTol: 8,
  matchFraction: 0.9,
  /** Guard against a vacuous pass: at least this many old points must be far from the new bodies. */
  minCandidates: 40,
  /** The binary is judged only where it is on the canvas: at least this many of the cycles must be. */
  minJudged: 40,
  far: [
    { m: 1, x: -5, y: 0.3, vx: 0, vy: 0 },
    { m: 1, x: 5, y: -0.3, vx: 0, vy: 0 },
  ] as HiddenBody[],
  opts: { G: 1, dt: 0.001 } as HiddenOpts,
}
