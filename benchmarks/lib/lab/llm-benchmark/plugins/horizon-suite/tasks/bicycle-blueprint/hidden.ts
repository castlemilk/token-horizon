/**
 * Hidden constants for the bicycle blueprint. Read by checks.ts, fixtures.ts and
 * the tests. Never written into the prompt. Version string: HIDDEN_VERSION.
 * Rotate the sets (and bump the version) if the repository becomes public.
 *
 * Specification corrections, for the designers to confirm (the specification file
 * is read-only here, so they are recorded in this file):
 * 1. The naive chain-run error figures in the specification notes (5.2 to 6.3 px) were
 *    reported wrong by the implementer; they are not re-derived here, so re-measure them.
 * 2. "P2 and P3 differ by more than 150 mm" does not stop a fixed saddle or handlebar:
 *    a saddle fixed about 108 mm above the default seat cluster plus a handlebar fixed
 *    midway between the two head tops passes both sets. If each saddle base should catch
 *    both fixed joints, P3 needs a head top at least 150 mm from the default.
 */
import type { Params } from './reference'
import { PUBLIC_DEFAULTS } from './reference'

// v2: stroked-line saddle and bar count as areas; paint is judged per element (5 samples per line).
export const HIDDEN_VERSION = 'bicycle-blueprint/v2'

type Partial_ = Partial<Params>

/** Parameter set for the frame-joint and saddle checks (other keys take the public defaults). */
export const HIDDEN_P1: Partial_ = {
  wheelRadius: 311,
  wheelbase: 1085,
  chainstay: 440,
  bbDrop: 42,
  seatTube: 480,
  seatAngle: 74.5,
  headAngle: 69,
  forkLength: 365,
  headTube: 170,
}

export const HIDDEN_P2: Partial_ = {
  wheelRadius: 268,
  wheelbase: 742,
  chainstay: 395,
  bbDrop: 33,
  seatTube: 600,
  seatAngle: 77,
  headAngle: 75,
  forkLength: 345,
  headTube: 95,
}

export const HIDDEN_P3: Partial_ = {
  wheelRadius: 372,
  wheelbase: 980,
  chainstay: 402,
  bbDrop: 78,
  seatTube: 590,
  seatAngle: 70.5,
  headAngle: 73.5,
  forkLength: 398,
  headTube: 105,
}

/** Fill the public defaults under a partial set. */
export function withDefaults(partial: Partial_): Params {
  return { ...PUBLIC_DEFAULTS, ...partial }
}

/** Wheel-circle and ground checks (radius and wheelbase only). */
export const WHEEL_SETS: Partial_[] = [
  { wheelRadius: 311, wheelbase: 1085 },
  { wheelRadius: 268, wheelbase: 742 },
]

/** Drivetrain circles: tooth pair on a hidden base. */
export const DRIVETRAIN_CASES: Array<{ base: Partial_; chainring: number; sprocket: number }> = [
  { base: HIDDEN_P1, chainring: 52, sprocket: 12 },
  { base: HIDDEN_P2, chainring: 28, sprocket: 34 },
  { base: HIDDEN_P3, chainring: 39, sprocket: 23 },
]

/** Chain-tangent cases. The chainstay is part of the case (it changes the tilt). */
export const CHAIN_CASES: Array<{ base: Partial_; chainring: number; sprocket: number; chainstay?: number }> = [
  { base: HIDDEN_P1, chainring: 52, sprocket: 12 },
  { base: HIDDEN_P1, chainring: 48, sprocket: 14, chainstay: 425 },
  { base: HIDDEN_P1, chainring: 44, sprocket: 11, chainstay: 380 },
  { base: HIDDEN_P2, chainring: 28, sprocket: 34 },
]

/** Crank angles (degrees) for the crank and pedal check, on P1. */
export const CRANK_ANGLES = [0, 90, 225, 765]

/** Spoke counts for the spoke check, on the default bicycle. */
export const SPOKE_COUNTS = [12, 20, 36]

/** Wheel rotation: teeth, crank angle (degrees), spokes per wheel. */
export const ROTATION_CASES: Array<{ chainring: number; sprocket: number; theta: number; spokes: number }> = [
  { chainring: 48, sprocket: 18, theta: 100, spokes: 24 },
  { chainring: 44, sprocket: 16, theta: 765, spokes: 24 },
  { chainring: 28, sprocket: 34, theta: 55, spokes: 36 },
  { chainring: 52, sprocket: 12, theta: 50, spokes: 12 },
]

/** Readouts: a base, teeth and a crank angle each. */
export const READOUT_CASES: Array<{ base: Partial_; chainring: number; sprocket: number; theta: number }> = [
  { base: HIDDEN_P1, chainring: 52, sprocket: 12, theta: 137 },
  { base: HIDDEN_P2, chainring: 28, sprocket: 34, theta: 262.5 },
  { base: HIDDEN_P3, chainring: 39, sprocket: 23, theta: 401 },
]

/** Saddle and handlebar: the two bases whose joints are far from the default. */
export const SADDLE_CASES: Partial_[] = [HIDDEN_P2, HIDDEN_P3]

/** The largest and smallest valid bicycles for the fit check. */
export const FIT_EXTREMES: Partial_[] = [
  {
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
  },
  {
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
  },
]

/** Crank angle for the paint proof (default bicycle). */
export const PAINT_CRANK_DEG = 40

/** Tolerances. Derivations are in the task notes; never loosen them to pass a build. */
export const TOL = {
  /** Circularity: horizontal against vertical screen radius, fraction. */
  circular: 0.01,
  /** Front radius = rear radius, fraction. */
  radiusEqual: 0.01,
  /** Hub separation / rear radius = W / R, fraction. */
  wheelRatio: 0.005,
  /** Hub y values equal, px. */
  hubY: 1,
  /** Ground endpoints equal in y, px. */
  groundFlat: 0.5,
  /** Ground y equals hub y plus radius, px. */
  groundAtWheels: 1.5,
  /** Joints: px floor and mm times scale. */
  jointPx: 1.5,
  jointMm: 4,
  /** Drivetrain circles: centre px, radius px and fraction. */
  centrePx: 1.5,
  hubPx: 1,
  radiusPx: 1,
  ringRadiusFrac: 0.015,
  sprocketRadiusFrac: 0.02,
  /** Chain tangency: line distance px, endpoint foot px. */
  tangentLinePx: 1.5,
  tangentFootPx: 2.5,
  /** Cranks: angle degrees, length fraction, end-to-BB px. */
  crankAngleDeg: 1.2,
  crankLengthFrac: 0.02,
  crankBbPx: 1.5,
  /** Pedals: centre px and edge alignment degrees. */
  pedalCentrePx: 3,
  pedalAlignDeg: 1,
  /** Spokes: end px, rim fraction, angle offsets degrees. */
  spokeEndPx: 1.5,
  spokeRimFrac: 0.015,
  spokeStartDeg: 1,
  spokeStepDeg: 0.8,
  /** Rotation: valve angle degrees, valve radius fraction, spoke congruence degrees. */
  valveAngleDeg: 1.2,
  valveRadiusFrac: 0.03,
  spokeCongruenceDeg: 1,
  /** Readouts: ratio and development (2 decimals), chain (1 decimal), distance (3 decimals). */
  ratioAbs: 0.0051,
  developmentAbs: 0.0051,
  chainAbs: 0.051,
  distanceAbs: 0.00051,
  /** Saddle and handlebar: mm allowances. */
  saddleLowMinMm: -2,
  saddleLowMaxMm: 120,
  saddleCentreMm: 80,
  handlebarMm: 150,
  /** Fit: px slack, minimum front-to-rear span in px, drawn W/R within this fraction of W/R. */
  fitSlackPx: 0.5,
  fitSpanPx: 560,
  fitRatioFrac: 0.02,
  /** Chain gate: drawn ring/sprocket radius ratio for 28/34 below this fraction of the 52/12 ratio (true factor 0.19). */
  chainGateFrac: 0.5,
  /** Paint: minimum per-channel difference, and points needed per group (rims of eight, gears of four, spokes of two, saddle and bars on a grid). */
  paintMin: 40,
  paintWheelPoints: 6,
  /** Gears: eight points round each ring; half must paint (a chain over a tangent point hides only a few). */
  paintGearNeed: 4,
  /** Spokes: six spokes spread round the wheel; four must paint (a stay crossing a spoke hides only a few). */
  paintSpokeSample: 6,
  paintSpokeNeed: 4,
  paintGridCols: 4,
  paintGridRows: 3,
  paintGridNeed: 3,
  /** Points sampled along each named line (evenly spaced, ends excluded); one must paint, so a dash gap at one point is not a failure. */
  paintLineSamples: 5,
  /** A saddle or bar drawn as a stroke counts as an area when its on-screen stroke is at least this wide (px). */
  strokeMinPx: 1.5,
} as const

/** Paint points for the wheel rims: eight angles, degrees clockwise from up. */
export const RIM_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

/** Invalid calls. Each is a source expression run in the page (NaN and Infinity cannot pass through JSON). */
export const INVALID_CALLS: Array<{ label: string; call: string }> = [
  { label: 'setParams: missing key', call: '(function(){ var p = Object.assign({}, D); delete p.spokes; return B.setParams(p); })()' },
  { label: 'setParams: wheelRadius NaN', call: 'B.setParams(Object.assign({}, D, { wheelRadius: NaN }))' },
  { label: 'setParams: chainringTeeth 48.5', call: 'B.setParams(Object.assign({}, D, { chainringTeeth: 48.5 }))' },
  { label: 'setParams: spokes 25', call: 'B.setParams(Object.assign({}, D, { spokes: 25 }))' },
  { label: 'setParams: wheelbase 700 with radius 350', call: 'B.setParams(Object.assign({}, D, { wheelbase: 700, wheelRadius: 350 }))' },
  { label: 'setParams: fork 350 with radius 340', call: 'B.setParams(Object.assign({}, D, { forkLength: 350, wheelRadius: 340 }))' },
  { label: 'setParams: bbDrop 81', call: 'B.setParams(Object.assign({}, D, { bbDrop: 81 }))' },
  { label: 'setCrank: -10', call: 'B.setCrank(-10)' },
  { label: "setCrank: 'abc'", call: "B.setCrank('abc')" },
  { label: 'setCrank: Infinity', call: 'B.setCrank(Infinity)' },
]
