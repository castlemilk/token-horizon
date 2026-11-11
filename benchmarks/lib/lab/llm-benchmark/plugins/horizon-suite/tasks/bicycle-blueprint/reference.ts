/**
 * Reference geometry for the bicycle blueprint. Pure functions, no DOM.
 *
 * Millimetres, origin at the rear hub, x to the right (towards the front wheel),
 * y up. The checks compare what the page draws against these values; the good
 * artifact derives the same values in its own script. Ported from the chief
 * designer's derivation (see the task specification), with the chain-length
 * formula cross-checked against a construction from the tangent points.
 */
import { clockwiseAngle, type Point } from '../../lib/math'

/** Pitch of the chain, in millimetres. Tooth radius = teeth * PITCH / (2 pi). */
export const PITCH_MM = 12.7

export const PARAM_KEYS = [
  'wheelRadius',
  'wheelbase',
  'chainstay',
  'bbDrop',
  'seatTube',
  'seatAngle',
  'headAngle',
  'forkLength',
  'headTube',
  'chainringTeeth',
  'sprocketTeeth',
  'crankLength',
  'spokes',
] as const

export type ParamKey = (typeof PARAM_KEYS)[number]

/** Every parameter is a number. Ranges are inclusive. */
export type Params = Record<ParamKey, number>

interface Range {
  lo: number
  hi: number
  integer?: boolean
  even?: boolean
}

export const PARAM_RANGES: Record<ParamKey, Range> = {
  wheelRadius: { lo: 250, hi: 380 },
  wheelbase: { lo: 700, hi: 1200 },
  chainstay: { lo: 380, hi: 460 },
  bbDrop: { lo: 30, hi: 80 },
  seatTube: { lo: 420, hi: 620 },
  seatAngle: { lo: 68, hi: 78 },
  headAngle: { lo: 66, hi: 76 },
  forkLength: { lo: 340, hi: 420 },
  headTube: { lo: 90, hi: 200 },
  chainringTeeth: { lo: 26, hi: 56, integer: true },
  sprocketTeeth: { lo: 11, hi: 36, integer: true },
  crankLength: { lo: 160, hi: 180 },
  spokes: { lo: 12, hi: 36, integer: true, even: true },
}

/** The load defaults named in the prompt (public). */
export const PUBLIC_DEFAULTS: Params = {
  wheelRadius: 340,
  wheelbase: 1010,
  chainstay: 425,
  bbDrop: 65,
  seatTube: 540,
  seatAngle: 73,
  headAngle: 72,
  forkLength: 380,
  headTube: 140,
  chainringTeeth: 48,
  sprocketTeeth: 18,
  crankLength: 170,
  spokes: 24,
}

export const PUBLIC_DEFAULT_CRANK_DEG = 35

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** True when p has every key as an in-range number, integers and even counts, and the two cross-limits. */
export function validParams(p: unknown): p is Params {
  if (typeof p !== 'object' || p === null) return false
  const record = p as Record<string, unknown>
  for (const key of PARAM_KEYS) {
    const v = record[key]
    const r = PARAM_RANGES[key]
    if (!isNum(v) || v < r.lo || v > r.hi) return false
    if (r.integer && !Number.isInteger(v)) return false
    if (r.even && v % 2 !== 0) return false
  }
  const p2 = p as Params
  if (p2.wheelbase < 2 * p2.wheelRadius + 20) return false
  if (p2.forkLength < p2.wheelRadius + 15) return false
  return true
}

/** A crank angle is any finite number >= 0 (degrees, clockwise from straight up). */
export function validCrank(theta: unknown): boolean {
  return isNum(theta) && theta >= 0
}

export function teethRadius(teeth: number): number {
  return (teeth * PITCH_MM) / (2 * Math.PI)
}

const rad = (deg: number): number => (deg * Math.PI) / 180

export interface Geometry {
  R: number
  W: number
  C: number
  D: number
  rear: Point
  front: Point
  bb: Point
  sc: Point
  fc: Point
  ht: Point
  rf: number
  rr: number
  L: number
  crankRight: Point
  crankLeft: Point
  /** Wheel rotation in degrees, theta * Nf / Nr (may exceed 360). */
  phi: number
  theta: number
}

/** Every joint and radius the parameters define, for a crank angle in degrees. */
export function derive(p: Params, thetaDeg: number): Geometry {
  const A = rad(p.seatAngle)
  const H = rad(p.headAngle)
  const C = p.chainstay
  const D = p.bbDrop
  const W = p.wheelbase
  const rear: Point = { x: 0, y: 0 }
  const front: Point = { x: W, y: 0 }
  const bb: Point = { x: Math.sqrt(C * C - D * D), y: -D }
  const sc: Point = { x: bb.x - p.seatTube * Math.cos(A), y: bb.y + p.seatTube * Math.sin(A) }
  const fc: Point = { x: W - p.forkLength * Math.cos(H), y: p.forkLength * Math.sin(H) }
  const ht: Point = { x: fc.x - p.headTube * Math.cos(H), y: fc.y + p.headTube * Math.sin(H) }
  const th = rad(thetaDeg)
  const sx = Math.sin(th)
  const cy = Math.cos(th)
  return {
    R: p.wheelRadius,
    W,
    C,
    D,
    rear,
    front,
    bb,
    sc,
    fc,
    ht,
    rf: teethRadius(p.chainringTeeth),
    rr: teethRadius(p.sprocketTeeth),
    L: p.crankLength,
    crankRight: { x: bb.x + p.crankLength * sx, y: bb.y + p.crankLength * cy },
    crankLeft: { x: bb.x - p.crankLength * sx, y: bb.y - p.crankLength * cy },
    phi: (thetaDeg * p.chainringTeeth) / p.sprocketTeeth,
    theta: thetaDeg,
  }
}

/** Point on a circle at a clockwise angle (degrees) from straight up, in mm. */
export function onCircle(centre: Point, radius: number, clockwiseDeg: number): Point {
  const a = rad(clockwiseDeg)
  return { x: centre.x + radius * Math.sin(a), y: centre.y + radius * Math.cos(a) }
}

export interface Tangent {
  a: Point
  b: Point
}

export interface TangentRuns {
  upper: Tangent
  lower: Tangent
  /** Unit normal of the upper run, and its angle (radians) to the line of centres. */
  upperNormal: Point
  upperGamma: number
}

/**
 * The two external common tangents of circle 1 (centre o1, radius r1) and circle 2
 * (o2, r2). Each run is given as [point on circle 1, point on circle 2]. "Upper"
 * is the run on the side of the line of centres that is higher on the page (mm
 * frame, y up).
 */
export function tangentRuns(o1: Point, r1: number, o2: Point, r2: number): TangentRuns {
  const dx = o2.x - o1.x
  const dy = o2.y - o1.y
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const c = (r1 - r2) / len
  const s = Math.sqrt(Math.max(0, 1 - c * c))
  const vx = -uy
  const vy = ux
  const n1 = { x: c * ux + s * vx, y: c * uy + s * vy }
  const n2 = { x: c * ux - s * vx, y: c * uy - s * vy }
  // w: the perpendicular to the line of centres that points up the page.
  const wx = vy >= 0 ? vx : -vx
  const wy = vy >= 0 ? vy : -vy
  const upN = n1.x * wx + n1.y * wy >= 0 ? n1 : n2
  const downN = upN === n1 ? n2 : n1
  const run = (n: Point): Tangent => ({
    a: { x: o1.x + r1 * n.x, y: o1.y + r1 * n.y },
    b: { x: o2.x + r2 * n.x, y: o2.y + r2 * n.y },
  })
  const gamma = Math.atan2(Math.abs(upN.x * uy - upN.y * ux), upN.x * ux + upN.y * uy)
  return { upper: run(upN), lower: run(downN), upperNormal: upN, upperGamma: gamma }
}

/**
 * Closed chain loop length from the closed-form tangent-and-arc expression:
 * 2 sqrt(C^2 - (rf - rr)^2) + rf (pi + 2b) + rr (pi - 2b), b = asin((rf - rr) / C).
 */
export function chainLength(C: number, rf: number, rr: number): number {
  const b = Math.asin((rf - rr) / C)
  return 2 * Math.sqrt(C * C - (rf - rr) * (rf - rr)) + rf * (Math.PI + 2 * b) + rr * (Math.PI - 2 * b)
}

/**
 * The same loop built from the tangent points: two straight runs, the far-side arc
 * on circle 1 and the near-side arc on circle 2 (both angles from the tangent
 * normals). An independent construction used to test chainLength.
 */
export function chainLengthGeometric(C: number, rf: number, rr: number): number {
  const runs = tangentRuns({ x: 0, y: 0 }, rf, { x: C, y: 0 }, rr)
  const straight = Math.hypot(runs.upper.a.x - runs.upper.b.x, runs.upper.a.y - runs.upper.b.y)
  const gamma = runs.upperGamma
  return 2 * straight + rf * (2 * Math.PI - 2 * gamma) + rr * (2 * gamma)
}

/** Smallest even integer n with n * 12.7 >= loop. */
export function linksFor(loop: number): number {
  let n = Math.ceil(loop / PITCH_MM)
  if (n % 2 !== 0) n += 1
  return n
}

export interface Readouts {
  ratio: number
  development: number
  chain: number
  links: number
  distance: number
}

/** Exact (unrounded) readout values for a parameter set and crank angle. */
export function readoutsFor(p: Params, thetaDeg: number): Readouts {
  const ratio = p.chainringTeeth / p.sprocketTeeth
  const rf = teethRadius(p.chainringTeeth)
  const rr = teethRadius(p.sprocketTeeth)
  const chain = chainLength(p.chainstay, rf, rr)
  const phiRad = rad((thetaDeg * p.chainringTeeth) / p.sprocketTeeth)
  return {
    ratio,
    development: (2 * Math.PI * p.wheelRadius * ratio) / 1000,
    chain,
    links: linksFor(chain),
    distance: (p.wheelRadius * phiRad) / 1000,
  }
}

/** Clockwise angle from straight up, in degrees, in [0, 360), of the vector a -> b. */
export function bearing(a: Point, b: Point): number {
  return clockwiseAngle(b.x - a.x, b.y - a.y)
}

/** Saddle box, mm (x, y = bottom edge, w, h). Sits just above SC, centred 12 mm forward of SC. */
export function saddleBox(g: Pick<Geometry, 'sc'>): { x: number; y: number; w: number; h: number } {
  return { x: g.sc.x + 12 - 62, y: g.sc.y + 8, w: 124, h: 20 }
}

/** Handlebar box, mm. Centre 22 mm behind HT and 15 mm above it. */
export function handlebarBox(g: Pick<Geometry, 'ht'>): { x: number; y: number; w: number; h: number } {
  return { x: g.ht.x - 62, y: g.ht.y + 6, w: 80, h: 18 }
}

export interface Extents {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Bounds of everything the artifact draws (wheels with tyres, ground, dimension
 * line, joints, cranks with pedals, saddle, handlebar), padded by 6 % of the larger
 * side. The artifact fits its viewBox to these bounds.
 */
export function extentsOf(p: Params, thetaDeg = 0): Extents {
  const g = derive(p, thetaDeg)
  const R = g.R
  const pts: Point[] = [
    { x: -R - 12, y: -R - 12 },
    { x: R + 12, y: R + 12 },
    { x: g.W - R - 12, y: -R - 12 },
    { x: g.W + R + 12, y: R + 12 },
    { x: -R - 40, y: -R },
    { x: g.W + R + 40, y: -R },
    { x: 0, y: -R - 70 },
    { x: g.W, y: -R - 70 },
    g.sc,
    g.ht,
    g.fc,
    g.bb,
    { x: g.crankRight.x - 25, y: g.crankRight.y - 12 },
    { x: g.crankRight.x + 25, y: g.crankRight.y + 12 },
    { x: g.crankLeft.x - 25, y: g.crankLeft.y - 12 },
    { x: g.crankLeft.x + 25, y: g.crankLeft.y + 12 },
  ]
  const sb = saddleBox(g)
  const hb = handlebarBox(g)
  for (const b of [sb, hb]) {
    pts.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h })
  }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const q of pts) {
    x0 = Math.min(x0, q.x)
    y0 = Math.min(y0, q.y)
    x1 = Math.max(x1, q.x)
    y1 = Math.max(y1, q.y)
  }
  const m = 0.06 * Math.max(x1 - x0, y1 - y0)
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }
}

/** The viewBox attribute the artifact sets for these parameters (SVG y is mm y negated). */
export function viewBoxOf(p: Params, thetaDeg = 0): string {
  const e = extentsOf(p, thetaDeg)
  return [e.x0, -e.y1, e.x1 - e.x0, e.y1 - e.y0].map((v) => round(v, 3)).join(' ')
}

function round(v: number, places: number): number {
  const f = 10 ** places
  return Math.round(v * f) / f
}
