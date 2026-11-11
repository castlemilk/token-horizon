/**
 * The twelve checks for the bicycle blueprint. Each measures what the page draws
 * (through getScreenCTM, the readouts' text and pixels), never the DOM's claims,
 * and compares it with the reference geometry in reference.ts under the tolerances
 * in hidden.ts (TOL). Points sum to 100.
 *
 * Every check runs in the same page. Each case sets its parameters through the
 * hooks and reads everything it needs in ONE probe (one JavaScript turn), so a
 * deferred redraw cannot change what a case measures, and no check depends on the
 * state a previous check left behind.
 */
import type { Page } from 'playwright'
import type { CheckFn } from '../../../../scorers/check-meta'
import { defineCheck } from '../../lib/check'
import { freezeMotion, hookPresent, probe, settle } from '../../lib/probe'
import { SVG_GEOM } from '../../lib/sources'
import { paintDiffGroups, type Clip } from '../../lib/pixels'
import { circularDifference, footOfPerpendicular, pointLineDistance, sideOfLine, type Point } from '../../lib/math'
import { bearing, chainLength, derive, linksFor, readoutsFor, teethRadius, type Geometry, type Params } from './reference'
import {
  CHAIN_CASES,
  CRANK_ANGLES,
  DRIVETRAIN_CASES,
  FIT_EXTREMES,
  HIDDEN_P1,
  HIDDEN_P2,
  HIDDEN_P3,
  INVALID_CALLS,
  PAINT_CRANK_DEG,
  READOUT_CASES,
  RIM_ANGLES,
  ROTATION_CASES,
  SADDLE_CASES,
  SPOKE_COUNTS,
  TOL,
  WHEEL_SETS,
  withDefaults,
} from './hidden'

// ---------------------------------------------------------------------------
// Page access: in-page source strings only (no compiled functions cross into the page)
// ---------------------------------------------------------------------------

/**
 * Screen geometry for every element matching a selector, through each element's own
 * getScreenCTM. Lines give a and b; circles give centre and the horizontal and
 * vertical screen radii; rectangles give their four corners (tl, tr, br, bl).
 * Elements that are not drawn (inside defs, display:none on the element or an
 * ancestor) come back with ok false, as the kit's visibility rules require.
 */
const ITEMS = String.raw`(arg) => {
  function T(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }
  function num(a) { return a && a.baseVal ? a.baseVal.value : NaN; }
  var NOT_DRAWN_IN = 'defs, symbol, clipPath, mask, pattern, marker';
  var list = Array.prototype.slice.call(document.querySelectorAll(arg.selector));
  return list.map(function (el) {
    var tag = el.tagName.toLowerCase();
    var out = { ok: false, tag: tag, id: el.id || '', cls: el.getAttribute('class') || '', wheel: el.getAttribute('data-wheel') };
    if (el.closest && el.closest(NOT_DRAWN_IN)) return out;
    // The kit's rule (as SVG_GEOM applies it): display:none or visibility:hidden on the
    // element or an ancestor means the element is not drawn.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true })) return out;
    } else {
      for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') return out;
      }
      var vis = getComputedStyle(el).visibility;
      if (vis === 'hidden' || vis === 'collapse') return out;
    }
    var m = el.getScreenCTM && el.getScreenCTM();
    if (!m) return out;
    out.ok = true;
    if (tag === 'line') {
      out.a = T(m, num(el.x1), num(el.y1));
      out.b = T(m, num(el.x2), num(el.y2));
    } else if (tag === 'circle') {
      var cx = num(el.cx), cy = num(el.cy), r = num(el.r);
      var c = T(m, cx, cy), px = T(m, cx + r, cy), py = T(m, cx, cy + r);
      out.cx = c.x; out.cy = c.y;
      out.rx = Math.hypot(px.x - c.x, px.y - c.y);
      out.ry = Math.hypot(py.x - c.x, py.y - c.y);
    } else if (tag === 'rect') {
      var x = num(el.x), y = num(el.y), w = num(el.width), h = num(el.height);
      out.corners = [T(m, x, y), T(m, x + w, y), T(m, x + w, y + h), T(m, x, y + h)];
    }
    return out;
  });
}`

/**
 * One probe per case: set the parameters and the crank angle through the hooks, then
 * read every named selector, the bounding corners of the listed boxes, the readout
 * text and the svg's screen box, all in the same JavaScript turn.
 */
const SNAPSHOT = String.raw`(arg) => {
  var B = window.__bench;
  var out = { hooks: false, setParams: null, setCrank: null, items: {}, boxes: {}, readouts: null, svg: null };
  if (!B || typeof B.setParams !== 'function' || typeof B.setCrank !== 'function') return out;
  out.hooks = true;
  if (arg.params !== null) out.setParams = B.setParams(arg.params) === true;
  if (arg.theta !== null) out.setCrank = B.setCrank(arg.theta) === true;
  var readItems = ` + ITEMS + String.raw`;
  var G = ` + SVG_GEOM + String.raw`;
  arg.selectors.forEach(function (s) { out.items[s] = readItems({ selector: s }); });
  arg.boxes.forEach(function (id) {
    var box = G({ op: 'bboxCorners', selector: '#' + id });
    var el = document.getElementById(id);
    var stroke = 0;
    if (box && box.ok && el && getComputedStyle(el).stroke !== 'none') {
      var m = el.getScreenCTM();
      stroke = parseFloat(getComputedStyle(el).strokeWidth) * (m ? Math.hypot(m.a, m.b) : 1);
      if (!isFinite(stroke)) stroke = 0;
    }
    if (box) box.strokeWidth = stroke;
    out.boxes[id] = box;
  });
  if (arg.readouts) {
    out.readouts = ['out-ratio', 'out-development', 'out-chain', 'out-links', 'out-distance'].map(function (id) {
      var el = document.getElementById(id);
      return el ? el.textContent : null;
    });
  }
  if (arg.svg) {
    var svgEl = document.getElementById('bike');
    if (svgEl) {
      var r = svgEl.getBoundingClientRect();
      out.svg = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
  }
  return out;
}`

interface Item {
  ok: boolean
  tag: string
  id: string
  cls: string
  wheel: string | null
  a?: Point
  b?: Point
  cx?: number
  cy?: number
  rx?: number
  ry?: number
  corners?: Point[]
}

interface Snap {
  hooks: boolean
  setParams: boolean | null
  setCrank: boolean | null
  items: Record<string, Item[]>
  boxes: Record<string, { ok: boolean; corners?: Point[]; strokeWidth?: number }>
  readouts: Array<string | null> | null
  svg: Clip | null
}

interface SnapOptions {
  params?: Partial<Params>
  theta?: number
  selectors?: string[]
  boxes?: string[]
  readouts?: boolean
  svg?: boolean
}

/** Set the parameters and crank through the hooks and read everything in one probe. */
async function snap(page: Page, o: SnapOptions): Promise<Snap> {
  const params = o.params === undefined ? null : withDefaults(o.params)
  const theta = o.theta === undefined ? null : o.theta
  const arg = {
    params,
    theta,
    selectors: o.selectors ?? [],
    boxes: o.boxes ?? [],
    readouts: o.readouts === true,
    svg: o.svg === true,
  }
  const s = await probe<Snap>(page, SNAPSHOT, arg, 3000)
  if (!s.hooks) throw new Error('no window.__bench.setParams and setCrank hooks')
  if (params !== null && s.setParams !== true) throw new Error(`setParams did not return true for ${JSON.stringify(o.params)}`)
  if (theta !== null && s.setCrank !== true) throw new Error(`setCrank did not return true for ${String(theta)}`)
  return s
}

/** The one drawn element for a selector; anything else fails the case. */
function one(s: Snap, selector: string): Item {
  const list = s.items[selector] ?? []
  const drawn = list.filter((i) => i.ok)
  if (list.length !== 1 || drawn.length !== 1) throw new Error(`expected one drawn element for ${selector}, found ${drawn.length} drawn of ${list.length}`)
  return drawn[0]!
}

/** Every element matching a selector (drawn or not). */
function listOf(s: Snap, selector: string): Item[] {
  return s.items[selector] ?? []
}

async function preamble(page: Page): Promise<void> {
  const ready = (await hookPresent(page, '__bench.setParams')) && (await hookPresent(page, '__bench.setCrank'))
  if (!ready) throw new Error('no window.__bench.setParams and setCrank hooks')
  await freezeMotion(page)
}

/** Millimetre frame read from the drawing: origin at the rear wheel centre, scale from the hub separation. */
interface Frame {
  ox: number
  oy: number
  s: number
}

function frameFrom(rear: Item, front: Item, wheelbase: number): Frame {
  const s = Math.hypot(front.cx! - rear.cx!, front.cy! - rear.cy!) / wheelbase
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('hub separation is not measurable')
  return { ox: rear.cx!, oy: rear.cy!, s }
}

function toMm(p: Point, f: Frame): Point {
  return { x: (p.x - f.ox) / f.s, y: -(p.y - f.oy) / f.s }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** A point on a drawn circle or ellipse at a clockwise angle (degrees) from straight up. */
function circlePoint(c: Item, deg: number): Point {
  const a = (deg * Math.PI) / 180
  return { x: c.cx! + c.rx! * Math.sin(a), y: c.cy! - c.ry! * Math.cos(a) }
}

/** The four extreme points of a drawn circle: left, right, top and bottom. */
function extentPoints(c: Item): Point[] {
  return [
    { x: c.cx! - c.rx!, y: c.cy! },
    { x: c.cx! + c.rx!, y: c.cy! },
    { x: c.cx!, y: c.cy! - c.ry! },
    { x: c.cx!, y: c.cy! + c.ry! },
  ]
}

/** The centre of a rectangle given by its four corners. */
function centreOf(corners: Point[]): Point {
  return { x: (corners[0]!.x + corners[2]!.x) / 2, y: (corners[0]!.y + corners[2]!.y) / 2 }
}

/** A cols x rows grid of points spread over the box spanned by the corners. */
function gridIn(corners: Point[], cols: number, rows: number): Point[] {
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const out: Point[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      out.push({ x: x0 + ((i + 0.5) * (x1 - x0)) / cols, y: y0 + ((j + 0.5) * (y1 - y0)) / rows })
    }
  }
  return out
}

/** The endpoint of a line that is farther from a given point. */
function farther(from: Point, a: Point, b: Point): { near: Point; far: Point } {
  return dist(from, a) >= dist(from, b) ? { near: b, far: a } : { near: a, far: b }
}

const mod360 = (x: number): number => ((x % 360) + 360) % 360

/** Result collector: names every failed measurement and keeps the detail short. */
class Verdict {
  private readonly fails: string[] = []
  constructor(private readonly budget: number) {}
  fail(message: string): void {
    this.fails.push(message)
  }
  expect(condition: boolean, message: string): void {
    if (!condition) this.fails.push(message)
  }
  result(): { passed: boolean; detail: string } {
    if (this.fails.length === 0) return { passed: true, detail: `all measured within tolerance (${this.budget} points)` }
    return { passed: false, detail: this.fails.slice(0, 3).join('; ') + (this.fails.length > 3 ? ` (+${this.fails.length - 3} more)` : '') }
  }
}

const f1 = (v: number): string => v.toFixed(1)
const f2 = (v: number): string => v.toFixed(2)
const f3 = (v: number): string => v.toFixed(3)

/** The tube lines of the frame, by id. */
const TUBE_IDS = ['chain-stay', 'seat-stay', 'seat-tube', 'top-tube', 'down-tube', 'head-tube', 'fork'] as const
/** Lines whose drawn extent the fit check and the paint proof use: tubes, chain runs and cranks. */
const NAMED_LINE_IDS = [...TUBE_IDS, 'chain-upper', 'chain-lower', 'crank-right', 'crank-left'] as const

// ---------------------------------------------------------------------------
// 1. bike-wheels-ground (8)
// ---------------------------------------------------------------------------

const wheelsGround = defineCheck(
  'bike-wheels-ground',
  8,
  'two equal wheels at the right separation on one hub line, with the ground tangent beneath both',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(8)
    for (const partial of WHEEL_SETS) {
      const full = withDefaults(partial)
      const s = await snap(ctx.page, { params: partial, theta: 0, selectors: ['#wheel-rear', '#wheel-front', '#ground'] })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const ground = one(s, '#ground')
      const rr = rear.rx!
      const fr = front.rx!
      v.expect(Math.abs(rear.rx! - rear.ry!) <= TOL.circular * rr, `rear wheel not circular (${f2(rear.rx!)} vs ${f2(rear.ry!)} px)`)
      v.expect(Math.abs(front.rx! - front.ry!) <= TOL.circular * fr, `front wheel not circular (${f2(front.rx!)} vs ${f2(front.ry!)} px)`)
      v.expect(Math.abs(fr - rr) <= TOL.radiusEqual * rr, `front radius ${f2(fr)} differs from rear ${f2(rr)}`)
      const sep = Math.hypot(front.cx! - rear.cx!, front.cy! - rear.cy!)
      const ratio = sep / rr / (full.wheelbase / full.wheelRadius)
      v.expect(Math.abs(ratio - 1) <= TOL.wheelRatio, `hub separation / radius off by ${f2(Math.abs(ratio - 1) * 100)} %`)
      v.expect(Math.abs(rear.cy! - front.cy!) <= TOL.hubY, `hub heights differ by ${f2(Math.abs(rear.cy! - front.cy!))} px`)
      v.expect(front.cx! > rear.cx!, 'front wheel is not to the right of the rear wheel')
      const a = ground.a!
      const b = ground.b!
      v.expect(Math.abs(a.y - b.y) <= TOL.groundFlat, `ground ends differ in height by ${f2(Math.abs(a.y - b.y))} px`)
      v.expect(Math.abs(a.y - (rear.cy! + rr)) <= TOL.groundAtWheels, `ground is ${f2(Math.abs(a.y - (rear.cy! + rr)))} px from the wheel bottoms`)
      // Slack on both ends: a ground drawn exactly hub to hub can land a float32 step outside.
      const left = Math.min(rear.cx!, front.cx!)
      const right = Math.max(rear.cx!, front.cx!)
      v.expect(
        Math.min(a.x, b.x) <= left + TOL.groundFlat && Math.max(a.x, b.x) >= right - TOL.groundFlat,
        'ground does not reach under both hubs',
      )
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 2. bike-frame-joints (14)
// ---------------------------------------------------------------------------

const frameJoints = defineCheck(
  'bike-frame-joints',
  14,
  'the seven frame tubes end exactly at the joints the parameters define',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(14)
    const TUBES: Array<[string, (g: Geometry) => [Point, Point]]> = [
      ['chain-stay', (g) => [g.rear, g.bb]],
      ['seat-stay', (g) => [g.rear, g.sc]],
      ['seat-tube', (g) => [g.bb, g.sc]],
      ['top-tube', (g) => [g.sc, g.ht]],
      ['down-tube', (g) => [g.bb, g.fc]],
      ['head-tube', (g) => [g.fc, g.ht]],
      ['fork', (g) => [g.fc, g.front]],
    ]
    const sets = [HIDDEN_P1, HIDDEN_P2, HIDDEN_P3]
    for (const [index, partial] of sets.entries()) {
      const label = `set P${index + 1}`
      const full = withDefaults(partial)
      const s = await snap(ctx.page, {
        params: partial,
        theta: 0,
        selectors: [...TUBES.map(([id]) => `#${id}`), '#wheel-rear', '#wheel-front'],
      })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const g = derive(full, 0)
      const tolMm = Math.max(TOL.jointPx / f.s, TOL.jointMm)
      for (const [id, expect] of TUBES) {
        const tube = one(s, `#${id}`)
        const [e1, e2] = expect(g)
        const p = toMm(tube.a!, f)
        const q = toMm(tube.b!, f)
        const straight = dist(p, e1) <= tolMm && dist(q, e2) <= tolMm
        const crossed = dist(p, e2) <= tolMm && dist(q, e1) <= tolMm
        if (!straight && !crossed) {
          v.fail(`${id} ends ${f1(Math.min(dist(p, e1), dist(p, e2)))} mm off on ${label}`)
        }
      }
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 3. bike-drivetrain-circles (6)
// ---------------------------------------------------------------------------

const drivetrainCircles = defineCheck(
  'bike-drivetrain-circles',
  6,
  'chainring and sprocket have the pitch radii implied by their tooth counts and sit on the drawn anchors',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(6)
    for (const c of DRIVETRAIN_CASES) {
      const partial = { ...c.base, chainringTeeth: c.chainring, sprocketTeeth: c.sprocket }
      const full = withDefaults(partial)
      const s = await snap(ctx.page, {
        params: partial,
        theta: 0,
        selectors: ['#wheel-rear', '#wheel-front', '#chainring', '#sprocket', '#chain-stay'],
      })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const ring = one(s, '#chainring')
      const sprocket = one(s, '#sprocket')
      const stay = one(s, '#chain-stay')
      const bbScreen = farther({ x: rear.cx!, y: rear.cy! }, stay.a!, stay.b!).far
      const ringC = { x: ring.cx!, y: ring.cy! }
      v.expect(dist(ringC, bbScreen) <= TOL.centrePx, `chainring centre ${f2(dist(ringC, bbScreen))} px from the drawn bottom bracket`)
      const expectRing = teethRadius(c.chainring) * f.s
      v.expect(Math.abs(ring.rx! - expectRing) <= Math.max(TOL.radiusPx, TOL.ringRadiusFrac * expectRing), `chainring radius ${f2(ring.rx!)} px, expected ${f2(expectRing)} px`)
      const sprocketC = { x: sprocket.cx!, y: sprocket.cy! }
      v.expect(dist(sprocketC, { x: rear.cx!, y: rear.cy! }) <= TOL.hubPx, `sprocket centre ${f2(dist(sprocketC, { x: rear.cx!, y: rear.cy! }))} px from the rear hub`)
      const expectSpr = teethRadius(c.sprocket) * f.s
      v.expect(Math.abs(sprocket.rx! - expectSpr) <= Math.max(TOL.radiusPx, TOL.sprocketRadiusFrac * expectSpr), `sprocket radius ${f2(sprocket.rx!)} px, expected ${f2(expectSpr)} px`)
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 4. bike-chain-tangent (14)
// ---------------------------------------------------------------------------

const chainTangent = defineCheck(
  'bike-chain-tangent',
  14,
  'the two chain runs are the true external common tangents of the two drawn circles',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(14)
    // Drawn chainring-to-sprocket radius ratio per case, for the responsiveness gate.
    const drawnRatio: Record<string, number> = {}
    for (const c of CHAIN_CASES) {
      const partial = { ...c.base, chainringTeeth: c.chainring, sprocketTeeth: c.sprocket, ...(c.chainstay ? { chainstay: c.chainstay } : {}) }
      const label = `${c.chainring}/${c.sprocket}`
      const s = await snap(ctx.page, { params: partial, theta: 0, selectors: ['#chainring', '#sprocket', '#chain-upper', '#chain-lower'] })
      const ring = one(s, '#chainring')
      const spr = one(s, '#sprocket')
      const upper = one(s, '#chain-upper')
      const lower = one(s, '#chain-lower')
      const ringC = { x: ring.cx!, y: ring.cy! }
      const sprC = { x: spr.cx!, y: spr.cy! }
      const ringR = ring.rx!
      const sprR = spr.rx!
      drawnRatio[label] = sprR > 0 ? ringR / sprR : Number.NaN
      // The side of the line of centres that is higher on the page.
      const centreMid = mid(ringC, sprC)
      const aboveSide = sideOfLine({ x: centreMid.x, y: centreMid.y - 10 }, ringC, sprC)
      for (const [name, run, side] of [
        ['upper', upper, aboveSide],
        ['lower', lower, -aboveSide],
      ] as const) {
        const a = run.a!
        const b = run.b!
        v.expect(Math.abs(pointLineDistance(ringC, a, b) - ringR) <= TOL.tangentLinePx, `${label} ${name}: chainring centre ${f2(pointLineDistance(ringC, a, b))} px from the run, radius ${f2(ringR)}`)
        v.expect(Math.abs(pointLineDistance(sprC, a, b) - sprR) <= TOL.tangentLinePx, `${label} ${name}: sprocket centre ${f2(pointLineDistance(sprC, a, b))} px from the run, radius ${f2(sprR)}`)
        const footRing = footOfPerpendicular(ringC, a, b)
        const footSpr = footOfPerpendicular(sprC, a, b)
        const matched =
          (dist(a, footSpr) <= TOL.tangentFootPx && dist(b, footRing) <= TOL.tangentFootPx) ||
          (dist(b, footSpr) <= TOL.tangentFootPx && dist(a, footRing) <= TOL.tangentFootPx)
        v.expect(matched, `${label} ${name}: endpoints are not the tangent points (${f2(Math.min(dist(a, footSpr), dist(b, footSpr)))} px from the sprocket foot)`)
        v.expect(sideOfLine(a, ringC, sprC) === side && sideOfLine(b, ringC, sprC) === side, `${label} ${name}: an endpoint is on the wrong side of the line of centres`)
      }
    }
    // Responsiveness gate. The circles must follow the tooth pair: the 28/34 case has
    // a sprocket larger than its chainring, so its drawn ratio must be far below the
    // 52/12 ratio (true factor 0.19). Static drawings, dots and equal circles fail here.
    const small = drawnRatio['28/34']
    const large = drawnRatio['52/12']
    if (small === undefined || large === undefined || !Number.isFinite(small) || !Number.isFinite(large)) {
      v.fail('the 28/34 and 52/12 circles have no measurable radius ratio')
    } else {
      v.expect(
        small < TOL.chainGateFrac * large,
        `drawn chainring/sprocket radius ratio ${f2(small)} for 28/34 is not below ${TOL.chainGateFrac} x ${f2(large)} for 52/12: the circles do not follow the tooth pair`,
      )
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 5. bike-crank-pedals (8)
// ---------------------------------------------------------------------------

const crankPedals = defineCheck(
  'bike-crank-pedals',
  8,
  'cranks at the commanded angle, opposite each other, of the right length, with pedals that stay level',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(8)
    const full = withDefaults(HIDDEN_P1)
    for (const theta of CRANK_ANGLES) {
      const s = await snap(ctx.page, {
        params: HIDDEN_P1,
        theta,
        selectors: ['#wheel-rear', '#wheel-front', '#chain-stay', '#crank-right', '#crank-left', 'rect.pedal'],
      })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const stay = one(s, '#chain-stay')
      const bb = farther({ x: rear.cx!, y: rear.cy! }, stay.a!, stay.b!).far
      const right = one(s, '#crank-right')
      const left = one(s, '#crank-left')
      const ends: Point[] = []
      for (const [name, crank, expectDeg] of [
        ['right', right, theta],
        ['left', left, theta + 180],
      ] as const) {
        const { near, far } = farther(bb, crank.a!, crank.b!)
        v.expect(dist(near, bb) <= TOL.crankBbPx, `${name} crank starts ${f2(dist(near, bb))} px from the bottom bracket`)
        const angle = bearing(bb, far)
        const diff = circularDifference(angle, expectDeg % 360, 360)
        v.expect(Math.abs(diff) <= TOL.crankAngleDeg, `${name} crank at ${f1(angle)} deg for commanded ${theta}`)
        const len = dist(bb, far) / f.s
        v.expect(Math.abs(len - full.crankLength) <= TOL.crankLengthFrac * full.crankLength, `${name} crank length ${f1(len)} mm`)
        ends.push(far)
      }
      const pedals = listOf(s, 'rect.pedal')
      v.expect(pedals.length === 2 && pedals.every((p) => p.ok), `expected two drawn pedals, found ${pedals.filter((p) => p.ok).length}`)
      if (pedals.length !== 2 || !pedals.every((p) => p.ok && p.corners)) continue
      const centres: Point[] = pedals.map((p) => centreOf(p.corners!))
      // Each pedal must sit on a different crank end.
      const pairs: Array<[number, number]> = [
        [0, 1],
        [1, 0],
      ]
      const matched = pairs.some(([i, j]) => dist(centres[0]!, ends[i]!) <= TOL.pedalCentrePx && dist(centres[1]!, ends[j]!) <= TOL.pedalCentrePx)
      v.expect(matched, `pedal centres are not on the two crank ends (theta ${theta})`)
      for (const p of pedals) {
        const c = p.corners!
        const e1 = { x: c[1]!.x - c[0]!.x, y: c[1]!.y - c[0]!.y }
        const e2 = { x: c[2]!.x - c[1]!.x, y: c[2]!.y - c[1]!.y }
        const l1 = Math.hypot(e1.x, e1.y)
        const l2 = Math.hypot(e2.x, e2.y)
        const sin1 = Math.sin((TOL.pedalAlignDeg * Math.PI) / 180)
        const horiz1 = Math.abs(e1.y) <= l1 * sin1
        const vert2 = Math.abs(e2.x) <= l2 * sin1
        const vert1 = Math.abs(e1.x) <= l1 * sin1
        const horiz2 = Math.abs(e2.y) <= l2 * sin1
        const aligned = (horiz1 && vert2) || (vert1 && horiz2)
        v.expect(aligned, `pedal edges not axis-aligned within ${TOL.pedalAlignDeg} deg`)
        const wide = horiz1 ? l1 : l2
        const high = horiz1 ? l2 : l1
        v.expect(wide > high, `pedal is not wider than tall (${f1(wide)} by ${f1(high)} px)`)
      }
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 6. bike-spokes (8)
// ---------------------------------------------------------------------------

const spokes = defineCheck(
  'bike-spokes',
  8,
  'exactly N spokes per wheel, from hub to rim, evenly spaced',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(8)
    for (const count of SPOKE_COUNTS) {
      const partial = { spokes: count }
      const full = withDefaults(partial)
      const s = await snap(ctx.page, { params: partial, theta: 0, selectors: ['#wheel-rear', '#wheel-front', 'line.spoke'] })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const all = listOf(s, 'line.spoke')
      for (const [wheel, hub] of [
        ['rear', rear],
        ['front', front],
      ] as const) {
        const mine = all.filter((x) => x.wheel === wheel)
        v.expect(mine.length === count, `${wheel} wheel has ${mine.length} spokes, expected ${count}`)
        const undrawn = mine.filter((x) => !x.ok).length
        if (undrawn > 0) v.fail(`${wheel} wheel has ${undrawn} spokes that are not drawn`)
        const drawn = mine.filter((x) => x.ok)
        const hubC = { x: hub.cx!, y: hub.cy! }
        const angles: number[] = []
        for (const sp of drawn) {
          const { near, far } = farther(hubC, sp.a!, sp.b!)
          v.expect(dist(near, hubC) <= TOL.spokeEndPx, `${wheel} spoke starts ${f2(dist(near, hubC))} px from the hub`)
          const rim = dist(far, hubC)
          const expectRim = full.wheelRadius * f.s
          v.expect(Math.abs(rim - expectRim) <= TOL.spokeRimFrac * expectRim, `${wheel} spoke ends ${f1(rim)} px from the hub, expected ${f1(expectRim)}`)
          angles.push(bearing(hubC, far))
        }
        if (angles.length === count && count > 0) {
          const step = 360 / count
          // The spoke nearest straight up anchors the sequence. Measuring every gap
          // from that anchor, with a key that puts the 0/360 seam midway between two
          // spokes, makes spokes at 359.9995 degrees count as the first spoke.
          let anchor = angles[0]!
          let nearest = Infinity
          for (const a of angles) {
            const d = Math.abs(circularDifference(a, 0, 360))
            if (d < nearest) {
              nearest = d
              anchor = a
            }
          }
          v.expect(nearest <= TOL.spokeStartDeg, `${wheel} spokes do not start at straight up (nearest ${f2(circularDifference(anchor, 0, 360))} deg)`)
          const keys = angles.map((a) => mod360(a - anchor + step / 2)).sort((p, q) => p - q)
          for (let i = 0; i < count; i++) {
            const next = i + 1 < count ? keys[i + 1]! : keys[0]! + 360
            const gap = next - keys[i]!
            v.expect(Math.abs(gap - step) <= TOL.spokeStepDeg, `${wheel} spoke gap ${f2(gap)} deg, expected ${f2(step)}`)
          }
        }
      }
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 7. bike-wheel-rotation (10)
// ---------------------------------------------------------------------------

const wheelRotation = defineCheck(
  'bike-wheel-rotation',
  10,
  'both wheels turn by theta times Nf over Nr, shown by the valve and by every spoke',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(10)
    for (const c of ROTATION_CASES) {
      const partial = { chainringTeeth: c.chainring, sprocketTeeth: c.sprocket, spokes: c.spokes }
      const full = withDefaults(partial)
      const label = `${c.chainring}/${c.sprocket} at ${c.theta} with ${c.spokes}`
      const s = await snap(ctx.page, {
        params: partial,
        theta: c.theta,
        selectors: ['#wheel-rear', '#wheel-front', 'circle.valve', 'line.spoke'],
      })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const phi = (c.theta * c.chainring) / c.sprocket
      const valves = listOf(s, 'circle.valve')
      const allSpokes = listOf(s, 'line.spoke')
      for (const [wheel, hub] of [
        ['rear', rear],
        ['front', front],
      ] as const) {
        const hubC = { x: hub.cx!, y: hub.cy! }
        const wheelValves = valves.filter((x) => x.wheel === wheel)
        if (wheelValves.length !== 1 || !wheelValves[0]!.ok) {
          v.fail(`${label}: expected one drawn valve for the ${wheel} wheel, found ${wheelValves.length}`)
          continue
        }
        const valve = wheelValves[0]!
        const valveC = { x: valve.cx!, y: valve.cy! }
        const angle = bearing(hubC, valveC)
        v.expect(Math.abs(circularDifference(angle, phi % 360, 360)) <= TOL.valveAngleDeg, `${label}: ${wheel} valve at ${f1(angle)} deg, expected ${f1(phi % 360)}`)
        const rimPx = full.wheelRadius * f.s
        v.expect(Math.abs(dist(valveC, hubC) - rimPx) <= TOL.valveRadiusFrac * rimPx, `${label}: ${wheel} valve off the rim`)
        const wheelSpokes = allSpokes.filter((x) => x.wheel === wheel)
        if (wheelSpokes.length === 0) {
          v.fail(`${label}: no spokes drawn for the ${wheel} wheel, so its rotation is not shown`)
          continue
        }
        const step = 360 / c.spokes
        for (const sp of wheelSpokes) {
          if (!sp.ok) {
            v.fail(`${label}: a ${wheel} spoke is not drawn`)
            continue
          }
          const { far } = farther(hubC, sp.a!, sp.b!)
          const a = bearing(hubC, far)
          v.expect(Math.abs(circularDifference(a, phi, step)) <= TOL.spokeCongruenceDeg, `${label}: ${wheel} spoke at ${f1(a)} deg is not congruent to ${f1(phi)}`)
        }
      }
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 8. bike-readouts (12)
// ---------------------------------------------------------------------------

/** Trim ASCII whitespace only, so a value written with surrounding spaces or newlines reads as its number. */
function clean(text: string | null): string | null {
  return text === null ? null : text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
}

const readouts = defineCheck(
  'bike-readouts',
  12,
  'gear ratio, development, exact chain loop, even link count and distance travelled',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(12)
    for (const c of READOUT_CASES) {
      const partial = { ...c.base, chainringTeeth: c.chainring, sprocketTeeth: c.sprocket }
      const full = withDefaults(partial)
      const label = `${c.chainring}/${c.sprocket} at ${c.theta}`
      const s = await snap(ctx.page, { params: partial, theta: c.theta, readouts: true })
      const texts = (s.readouts ?? []).map(clean)
      const ratioText = texts[0] ?? null
      const devText = texts[1] ?? null
      const chainText = texts[2] ?? null
      const linksText = texts[3] ?? null
      const distText = texts[4] ?? null
      const exact = readoutsFor(full, c.theta)
      const shapes: Array<[string, string | null, RegExp]> = [
        ['ratio', ratioText, /^\d+\.\d{2}$/],
        ['development', devText, /^\d+\.\d{2}$/],
        ['chain', chainText, /^\d+\.\d$/],
        ['links', linksText, /^\d+$/],
        ['distance', distText, /^\d+\.\d{3}$/],
      ]
      for (const [name, text, shape] of shapes) {
        v.expect(text !== null && shape.test(text), `${label}: ${name} reads "${text}", not a plain decimal with the required places`)
      }
      if (ratioText !== null) v.expect(Math.abs(Number(ratioText) - exact.ratio) <= TOL.ratioAbs, `${label}: ratio ${ratioText}, expected ${f2(exact.ratio)}`)
      if (devText !== null) v.expect(Math.abs(Number(devText) - exact.development) <= TOL.developmentAbs, `${label}: development ${devText}, expected ${f2(exact.development)}`)
      const rf = teethRadius(c.chainring)
      const rr = teethRadius(c.sprocket)
      const loop = chainLength(full.chainstay, rf, rr)
      if (chainText !== null) v.expect(Math.abs(Number(chainText) - loop) <= TOL.chainAbs, `${label}: chain ${chainText}, expected ${f1(loop)}`)
      if (linksText !== null) v.expect(Number(linksText) === linksFor(loop), `${label}: links ${linksText}, expected ${linksFor(loop)}`)
      if (distText !== null) v.expect(Math.abs(Number(distText) - exact.distance) <= TOL.distanceAbs, `${label}: distance ${distText}, expected ${exact.distance.toFixed(3)}`)
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 9. bike-saddle-bars (4)
// ---------------------------------------------------------------------------

/**
 * Whether a drawn box has area. A filled or outlined shape has width and height; a
 * saddle or bar drawn as a stroked line has a zero-thickness box, and counts when its
 * on-screen stroke is at least TOL.strokeMinPx wide and it has some extent.
 */
function hasArea(corners: Point[], strokeWidth: number | undefined): boolean {
  const w = Math.abs(corners[1]!.x - corners[0]!.x)
  const h = Math.abs(corners[2]!.y - corners[1]!.y)
  if (w > 0 && h > 0) return true
  return (strokeWidth ?? 0) >= TOL.strokeMinPx && w + h > 0
}

const saddleBars = defineCheck(
  'bike-saddle-bars',
  4,
  'the saddle and handlebar follow the frame instead of sitting at fixed coordinates',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(4)
    for (const partial of SADDLE_CASES) {
      const full = withDefaults(partial)
      const g = derive(full, 0)
      const s = await snap(ctx.page, { params: partial, theta: 0, selectors: ['#wheel-rear', '#wheel-front'], boxes: ['saddle', 'handlebar'] })
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      const f = frameFrom(rear, front, full.wheelbase)
      const saddle = s.boxes.saddle
      const bars = s.boxes.handlebar
      if (!saddle || !saddle.ok || !saddle.corners || !bars || !bars.ok || !bars.corners) throw new Error('saddle or handlebar has no bounding box')
      const sMm = saddle.corners.map((p) => toMm(p, f))
      const lowest = Math.min(...sMm.map((p) => p.y))
      v.expect(lowest >= g.sc.y + TOL.saddleLowMinMm && lowest <= g.sc.y + TOL.saddleLowMaxMm, `saddle lowest point ${f1(lowest)} mm, seat cluster ${f1(g.sc.y)} mm`)
      const sCentre = (Math.min(...sMm.map((p) => p.x)) + Math.max(...sMm.map((p) => p.x))) / 2
      v.expect(Math.abs(sCentre - g.sc.x) <= TOL.saddleCentreMm, `saddle centre ${f1(sCentre)} mm, seat cluster ${f1(g.sc.x)} mm`)
      v.expect(hasArea(saddle.corners, saddle.strokeWidth), 'saddle has no area')
      const bMm = bars.corners.map((p) => toMm(p, f))
      const bCentre = {
        x: (Math.min(...bMm.map((p) => p.x)) + Math.max(...bMm.map((p) => p.x))) / 2,
        y: (Math.min(...bMm.map((p) => p.y)) + Math.max(...bMm.map((p) => p.y))) / 2,
      }
      v.expect(dist(bCentre, g.ht) <= TOL.handlebarMm, `handlebar centre ${f1(dist(bCentre, g.ht))} mm from the head top`)
      v.expect(bCentre.y >= g.fc.y, 'handlebar centre is below the fork crown')
      v.expect(hasArea(bars.corners, bars.strokeWidth), 'handlebar has no area')
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 10. bike-fits-view (6)
// ---------------------------------------------------------------------------

const fitsView = defineCheck(
  'bike-fits-view',
  6,
  'the drawing is rescaled to fit the largest and smallest valid bicycles, with one uniform scale',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(6)
    for (const partial of FIT_EXTREMES) {
      const full = withDefaults(partial)
      const label = `W${full.wheelbase} R${full.wheelRadius}`
      const s = await snap(ctx.page, {
        params: partial,
        theta: 0,
        selectors: [
          ...NAMED_LINE_IDS.map((id) => `#${id}`),
          'line.spoke[data-wheel]',
          'rect.pedal',
          '#wheel-rear',
          '#wheel-front',
          '#chainring',
          '#sprocket',
        ],
        boxes: ['saddle', 'handlebar'],
        svg: true,
      })
      const rect = s.svg
      if (rect === null) throw new Error('the svg has no screen box')
      const rear = one(s, '#wheel-rear')
      const front = one(s, '#wheel-front')
      // The named geometry only: tubes, chain runs, cranks, spokes, wheels, gears,
      // pedals and the saddle and handlebar boxes. Grid, dimension lines and the
      // ground are decoration or follow from the wheels, so they are left out.
      const points: Point[] = []
      for (const id of NAMED_LINE_IDS) {
        const it = one(s, `#${id}`)
        points.push(it.a!, it.b!)
      }
      for (const sp of listOf(s, 'line.spoke[data-wheel]')) {
        if (sp.ok) points.push(sp.a!, sp.b!)
        else v.fail(`${label}: a spoke is not drawn`)
      }
      points.push(...extentPoints(rear), ...extentPoints(front))
      for (const id of ['chainring', 'sprocket'] as const) points.push(...extentPoints(one(s, `#${id}`)))
      for (const p of listOf(s, 'rect.pedal')) {
        if (p.ok && p.corners) points.push(...p.corners)
        else v.fail(`${label}: a pedal is not drawn`)
      }
      for (const id of ['saddle', 'handlebar'] as const) {
        const box = s.boxes[id]
        if (box && box.ok && box.corners) points.push(...box.corners)
        else v.fail(`${label}: ${id} is not drawn`)
      }
      const slack = TOL.fitSlackPx
      let outside = 0
      for (const p of points) {
        const inside =
          p.x >= rect.x - slack && p.x <= rect.x + rect.width + slack && p.y >= rect.y - slack && p.y <= rect.y + rect.height + slack &&
          p.x >= -slack && p.x <= 1024 + slack && p.y >= -slack && p.y <= 720 + slack
        if (!inside) outside++
      }
      v.expect(outside === 0, `${label}: ${outside} drawn points outside the svg or the 1024 x 720 view`)
      const span = front.cx! + front.rx! - (rear.cx! - rear.rx!)
      v.expect(span >= TOL.fitSpanPx, `${label}: rear-to-front span ${f1(span)} px, need ${TOL.fitSpanPx}`)
      v.expect(Math.abs(rear.rx! - rear.ry!) <= 0.01 * rear.rx! && Math.abs(front.rx! - front.ry!) <= 0.01 * front.rx!, `${label}: wheels are not circular`)
      // The drawing must show these extremes: drawn hub separation over drawn rear radius is W / R.
      const drawnRatio = Math.hypot(front.cx! - rear.cx!, front.cy! - rear.cy!) / rear.rx!
      const wantRatio = full.wheelbase / full.wheelRadius
      v.expect(
        Math.abs(drawnRatio / wantRatio - 1) <= TOL.fitRatioFrac,
        `${label}: drawn hub separation / rear radius ${f3(drawnRatio)}, expected ${f3(wantRatio)}`,
      )
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 11. bike-validation (5)
// ---------------------------------------------------------------------------

const VALIDATION = String.raw`(arg) => {
  var B = window.__bench;
  var D = arg.defaults;
  var readItems = ` + ITEMS + String.raw`;
  var G = ` + SVG_GEOM + String.raw`;
  function r1(v) { return Math.round(v * 10) / 10; }
  function rounder(key, value) { return typeof value === 'number' ? r1(value) : value; }
  function snapshot() {
    var s = [];
    arg.selectors.forEach(function (sel) { s.push(JSON.stringify(readItems({ selector: sel }), rounder)); });
    arg.boxes.forEach(function (id) { s.push(JSON.stringify(G({ op: 'bboxCorners', selector: '#' + id }), rounder)); });
    ['out-ratio', 'out-development', 'out-chain', 'out-links', 'out-distance'].forEach(function (id) {
      var el = document.getElementById(id);
      s.push(el ? el.textContent : null);
    });
    return JSON.stringify(s);
  }
  var valid = [B.setParams(D) === true, B.setCrank(40) === true];
  var base = snapshot();
  var results = arg.calls.map(function (c) {
    var value, threw = false, detail = '';
    try { value = (new Function('B', 'D', 'return ' + c.call + ';'))(B, D); } catch (e) { threw = true; detail = String(e && e.message); }
    var after = snapshot();
    var kind = value === undefined ? 'undefined' : (typeof value === 'string' ? 'string "' + value + '"' : String(value));
    return { label: c.label, isFalse: value === false, kind: kind, threw: threw, detail: detail, unchanged: after === base };
  });
  return { valid: valid, results: results };
}`

const validation = defineCheck(
  'bike-validation',
  5,
  'invalid parameters and crank angles are rejected without throwing or redrawing',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(5)
    const defaults = withDefaults({})
    const outcome = await probe<{
      valid: boolean[]
      results: Array<{ label: string; isFalse: boolean; kind: string; threw: boolean; detail: string; unchanged: boolean }>
    }>(
      ctx.page,
      VALIDATION,
      {
        defaults,
        calls: INVALID_CALLS,
        selectors: [
          ...NAMED_LINE_IDS.map((id) => `#${id}`),
          '#ground',
          '#wheel-rear',
          '#wheel-front',
          '#chainring',
          '#sprocket',
          'line.spoke',
          'circle.valve',
          'rect.pedal',
        ],
        boxes: ['saddle', 'handlebar'],
      },
      15_000,
    )
    v.expect(outcome.valid[0] === true && outcome.valid[1] === true, 'a valid setParams or setCrank did not return exactly true')
    for (const r of outcome.results) {
      if (r.threw) v.fail(`${r.label}: threw ${r.detail}`)
      else if (!r.isFalse) v.fail(`${r.label}: returned ${r.kind}, not the boolean false`)
      if (!r.unchanged) v.fail(`${r.label}: changed the drawing or readouts`)
    }
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// 12. bike-painted (5)
// ---------------------------------------------------------------------------

/**
 * Each group is one named element (or one kind of element). The group is judged
 * against a capture in which only its own selector is hidden, so each element is
 * measured against the picture that lies behind it, not against the whole drawing
 * with every named element removed at once.
 */
interface SampleGroup {
  label: string
  /** How many of its points must paint. */
  need: number
  /** The selector that hides this group alone. Decoy elements without data-wheel are never hidden, so they cannot stand in for a named one. */
  hide: string
  /** With hide, only the index-th matching element is hidden (for a pair judged one at a time). */
  index?: number
  points: Point[]
}

/** Four points across a pedal's width at its vertical centre, one eighth in from each end and at three eighths and five eighths. */
function pedalPoints(corners: Point[]): Point[] {
  const [tl, tr, , bl] = corners as [Point, Point, Point, Point]
  return [0.125, 0.375, 0.625, 0.875].map((t) => ({
    x: tl.x + (tr.x - tl.x) * t + (bl.x - tl.x) / 2,
    y: tl.y + (tr.y - tl.y) * t + (bl.y - tl.y) / 2,
  }))
}

/** Evenly spaced points strictly inside a line (its ends excluded), so a dash pattern is hit somewhere. */
function alongLine(it: Item, count: number): Point[] {
  const out: Point[] = []
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1)
    out.push({ x: it.a!.x + (it.b!.x - it.a!.x) * t, y: it.a!.y + (it.b!.y - it.a!.y) * t })
  }
  return out
}

const painted = defineCheck(
  'bike-painted',
  5,
  'the measured geometry is what is visibly painted: each named element paints where its geometry says, against the picture behind it',
  async (ctx) => {
    await preamble(ctx.page)
    const v = new Verdict(5)
    const selectors = [
      ...NAMED_LINE_IDS.map((id) => `#${id}`),
      '#ground',
      '#wheel-rear',
      '#wheel-front',
      '#chainring',
      '#sprocket',
      'line.spoke[data-wheel]',
      'circle.valve[data-wheel]',
      'rect.pedal',
    ]
    await snap(ctx.page, { params: {}, theta: PAINT_CRANK_DEG })
    // Read the geometry only after two frames, so a page that draws on the next frame is
    // measured on the picture it shows. Synchronous drawing is enforced by the other checks.
    await settle(ctx.page)
    const s = await snap(ctx.page, { selectors, boxes: ['saddle', 'handlebar'], svg: true })
    const clip = s.svg
    if (clip === null) throw new Error('the svg has no screen box')
    const groups: SampleGroup[] = []
    for (const id of NAMED_LINE_IDS) {
      const it = one(s, `#${id}`)
      groups.push({ label: id, need: 1, hide: `#${id}`, points: alongLine(it, TOL.paintLineSamples) })
    }
    const ground = one(s, '#ground')
    groups.push({ label: 'ground', need: 1, hide: '#ground', points: alongLine(ground, TOL.paintLineSamples) })
    for (const wheel of ['rear', 'front'] as const) {
      const w = one(s, `#wheel-${wheel}`)
      groups.push({ label: `${wheel} rim`, need: TOL.paintWheelPoints, hide: `#wheel-${wheel}`, points: RIM_ANGLES.map((deg) => circlePoint(w, deg)) })
    }
    for (const id of ['chainring', 'sprocket'] as const) {
      const c = one(s, `#${id}`)
      const angles = [0, 45, 90, 135, 180, 225, 270, 315]
      groups.push({ label: id, need: TOL.paintGearNeed, hide: `#${id}`, points: angles.map((deg) => circlePoint(c, deg)) })
    }
    for (const wheel of ['rear', 'front'] as const) {
      const sp = listOf(s, 'line.spoke[data-wheel]').filter((x) => x.wheel === wheel && x.ok)
      // Spread across the whole wheel, so a seat stay or chain stay crossing a few spokes is not the test.
      const picked = Array.from({ length: Math.min(TOL.paintSpokeSample, sp.length) }, (_, i) => sp[Math.floor((i * sp.length) / TOL.paintSpokeSample)]!)
      groups.push({
        label: `${wheel} spokes`,
        need: TOL.paintSpokeNeed,
        hide: `line.spoke[data-wheel="${wheel}"]`,
        points: picked.map((x) => mid(x.a!, x.b!)),
      })
    }
    // Each pedal is judged alone, at four points across its width, so the crank over its
    // middle does not hide the pedal from the test.
    const pedals = listOf(s, 'rect.pedal')
    if (pedals.length !== 2 || pedals.some((p) => !p.ok || !p.corners)) v.fail('the two pedals are not both drawn as rectangles')
    pedals.forEach((p, index) => {
      if (!p.ok || !p.corners) return
      groups.push({ label: `pedal ${index + 1}`, need: 1, hide: 'rect.pedal', index, points: pedalPoints(p.corners) })
    })
    for (const wheel of ['rear', 'front'] as const) {
      const valves = listOf(s, 'circle.valve[data-wheel]').filter((x) => x.wheel === wheel && x.ok)
      groups.push({ label: `${wheel} valve`, need: 1, hide: `circle.valve[data-wheel="${wheel}"]`, points: valves.slice(0, 1).map((x) => ({ x: x.cx!, y: x.cy! })) })
    }
    for (const id of ['saddle', 'handlebar'] as const) {
      const box = s.boxes[id]
      const corners = box && box.ok && box.corners ? box.corners : []
      groups.push({
        label: `${id} area`,
        need: TOL.paintGridNeed,
        hide: `#${id}`,
        points: corners.length === 4 ? gridIn(corners, TOL.paintGridCols, TOL.paintGridRows) : [],
      })
    }
    // Samples outside the svg's screen box cannot be read; they count as unpainted.
    const ix0 = Math.floor(clip.x)
    const iy0 = Math.floor(clip.y)
    const ix1 = Math.ceil(clip.x + clip.width)
    const iy1 = Math.ceil(clip.y + clip.height)
    const inside = (p: Point): boolean =>
      Number.isFinite(p.x) && Number.isFinite(p.y) && Math.floor(p.x) >= ix0 && Math.floor(p.x) < ix1 && Math.floor(p.y) >= iy0 && Math.floor(p.y) < iy1
    const readable = groups.map((g) => g.points.filter(inside))
    const diffs = await paintDiffGroups(
      ctx.page,
      clip,
      groups.map((g, i) => ({ hide: g.hide, index: g.index, points: readable[i]! })),
    )
    groups.forEach((g, i) => {
      let k = 0
      const d = g.points.map((p) => (inside(p) ? diffs[i]![k++]! : 0))
      const good = d.filter((x) => x >= TOL.paintMin).length
      const best = d.length > 0 ? Math.max(...d) : 0
      v.expect(good >= g.need, `${g.label}: ${good} of ${g.points.length} sample points paint >= ${TOL.paintMin} (need ${g.need}, best ${best})`)
    })
    return v.result()
  },
)

// ---------------------------------------------------------------------------
// The registered checks, in the order the specification gives
// ---------------------------------------------------------------------------

export const checks: Record<string, CheckFn> = {
  'bike-wheels-ground': wheelsGround,
  'bike-frame-joints': frameJoints,
  'bike-drivetrain-circles': drivetrainCircles,
  'bike-chain-tangent': chainTangent,
  'bike-crank-pedals': crankPedals,
  'bike-spokes': spokes,
  'bike-wheel-rotation': wheelRotation,
  'bike-readouts': readouts,
  'bike-saddle-bars': saddleBars,
  'bike-fits-view': fitsView,
  'bike-validation': validation,
  'bike-painted': painted,
}

/** The same checks as a list, for the fixture matrix's tsx-loader run (it spreads its export). */
export const checkList: CheckFn[] = Object.values(checks)
