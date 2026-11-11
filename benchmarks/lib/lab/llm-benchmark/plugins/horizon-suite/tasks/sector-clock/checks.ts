/**
 * The thirteen sector-clock checks, one per entry of task-sector-clock.json, in
 * the order the specification gives. Every check runs on a fresh document at the
 * default viewport with the page pinned to UTC (except clock-host-timezone, which
 * opens its own page in another zone). Expected values come from reference.ts;
 * hidden inputs come from hidden.ts. Nothing reads the wall clock or frame rate.
 *
 * Measurement rules used throughout:
 *  - a hook call, the finish of the page's animations and the read of the hands
 *    and readouts happen in ONE in-page turn (SET_READ_SOURCE), so a page that
 *    draws later than the call returns cannot pass by being read after the draw;
 *  - each check requires only the elements it reads (CHECK_IDS), so a missing
 *    readout costs the checks that read it and nothing else; structure and
 *    clock-sync-validation require the whole contract;
 *  - every tolerance is written as "if (!(value <= bound)) fail", so a NaN
 *    (a zero-length hand has no direction) fails instead of passing.
 */
import { createHash } from 'node:crypto'
import type { Page } from 'playwright'
import type { CheckContext, CheckFn } from '../../../../scorers/check-meta'
import { defineCheck, type CheckOutcome } from '../../lib/check'
import { probe, finishAnimations, withViewport } from '../../lib/probe'
import { VISIBLE } from '../../lib/sources'
import { altTimezonePage, freshLoad, pinTimezone } from '../../lib/load'
import { paintDiff, samplePixels, type Clip } from '../../lib/pixels'
import { chan, circularDifference, clockwiseAngle, mod, parseCssColour, pointLineDistance } from '../../lib/math'
import { clockReadout, sectorSpan } from './reference'
import * as H from './hidden'

type Pt = { x: number; y: number }
/** A line's screen endpoints: ax, ay, bx, by in CSS pixels. */
type Seg = [number, number, number, number]

/** One element's geometry in viewport CSS pixels, as read by GEOM_SOURCE. */
interface Geo {
  ok: boolean
  detail?: string
  ax?: number
  ay?: number
  bx?: number
  by?: number
  cls?: string
  cx?: number
  cy?: number
  rx?: number
  ry?: number
  text?: string
  rot?: number
  left?: number
  top?: number
  right?: number
  bottom?: number
}

interface Contract {
  missing: string[]
  setInstant: boolean
  setSector: boolean
  tags: Record<string, string | null>
  order: boolean
  ticks: number
  majors: number
  numerals: number
}

/** The result of one set-and-read turn. */
interface SetRead {
  ok: unknown
  lines: Array<Seg | null>
  texts: Array<string | null>
  error: string | null
}

/** The result of the sync-validation turn. */
interface SyncRead {
  okB: unknown
  okS: unknown
  digital: string | null
  minute: Seg | null
  animations: number
}

// ---------------------------------------------------------------------------
// In-page sources. Plain JavaScript strings: no backticks, no template
// placeholders, no helper captured from the harness (postmortem 0008).
// ---------------------------------------------------------------------------

/** Every id the contract names. */
const ALL_IDS = [
  'clock',
  'dial',
  'subdial',
  'hand-hour',
  'hand-minute',
  'hand-second',
  'hand-24h',
  'sector',
  'digital',
  'date-window',
  'offset-label',
  'week-label',
]

/** The ids each check reads (its own elements only). Structure and sync-validation read all of them. */
const CHECK_IDS = {
  structure: ALL_IDS,
  ticks: ['dial'],
  minuteSecond: ['hand-minute', 'hand-second'],
  hour: ['hand-hour'],
  offset: ['digital', 'offset-label', 'hand-minute', 'hand-hour'],
  date: ['date-window'],
  iso: ['week-label'],
  subdial: ['subdial', 'hand-24h'],
  band: ['clock', 'dial', 'sector'],
  arcs: ['clock', 'dial'],
  edge: ['digital', 'hand-second'],
  host: ['digital', 'date-window', 'week-label', 'hand-minute', 'hand-hour'],
  sync: ALL_IDS,
} as const

const HAND_IDS = ['hand-hour', 'hand-minute', 'hand-second', 'hand-24h']

/** Geometry of every element matching a selector, through each element's own CTM. */
const GEOM_SOURCE = String.raw`(arg) => {
  function xf(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }
  var list = Array.prototype.slice.call(document.querySelectorAll(arg.selector));
  return list.map(function (el) {
    if (arg.op === 'rect') {
      var r = el.getBoundingClientRect();
      return { ok: true, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    var m = typeof el.getScreenCTM === 'function' ? el.getScreenCTM() : null;
    if (!m) return { ok: false, detail: 'no screen matrix for ' + arg.selector };
    if (arg.op === 'line') {
      var a = xf(m, el.x1.baseVal.value, el.y1.baseVal.value);
      var b = xf(m, el.x2.baseVal.value, el.y2.baseVal.value);
      return { ok: true, ax: a.x, ay: a.y, bx: b.x, by: b.y, cls: el.getAttribute('class') || '' };
    }
    if (arg.op === 'circle') {
      var cx = el.cx.baseVal.value, cy = el.cy.baseVal.value, rr = el.r.baseVal.value;
      var c = xf(m, cx, cy), h = xf(m, cx + rr, cy), v = xf(m, cx, cy + rr);
      return { ok: true, cx: c.x, cy: c.y, rx: Math.hypot(h.x - c.x, h.y - c.y), ry: Math.hypot(v.x - c.x, v.y - c.y) };
    }
    if (arg.op === 'text') {
      var bb = el.getBBox();
      var t = xf(m, bb.x + bb.width / 2, bb.y + bb.height / 2);
      return { ok: true, text: (el.textContent || '').trim(), cx: t.x, cy: t.y, rot: Math.atan2(m.b, m.a) * 180 / Math.PI };
    }
    return { ok: false, detail: 'unknown op ' + arg.op };
  });
}`

/** Contract presence, counts, paint order and the tag of each element. */
const CONTRACT_SOURCE = String.raw`() => {
  var ids = ['clock', 'dial', 'subdial', 'hand-hour', 'hand-minute', 'hand-second', 'hand-24h', 'sector', 'digital', 'date-window', 'offset-label', 'week-label'];
  var missing = ids.filter(function (id) { return document.getElementById(id) === null; });
  function tag(id) { var el = document.getElementById(id); return el ? el.tagName.toLowerCase() : null; }
  function before(a, b) { return !!a && !!b && (a.compareDocumentPosition(b) & 4) !== 0; }
  var s = document.getElementById('sector'), h = document.getElementById('hand-hour');
  var mi = document.getElementById('hand-minute'), se = document.getElementById('hand-second');
  var hooks = window.__bench || null;
  return {
    missing: missing,
    setInstant: !!hooks && typeof hooks.setInstant === 'function',
    setSector: !!hooks && typeof hooks.setSector === 'function',
    tags: { clock: tag('clock'), dial: tag('dial'), subdial: tag('subdial'), hour: tag('hand-hour'),
            minute: tag('hand-minute'), second: tag('hand-second'), h24: tag('hand-24h'), sector: tag('sector') },
    order: before(s, h) && before(h, mi) && before(mi, se),
    ticks: document.querySelectorAll('line.tick').length,
    majors: document.querySelectorAll('line.tick.major').length,
    numerals: document.querySelectorAll('text.numeral').length
  };
}`

/** Presence of the listed ids and of the two hooks, before anything is applied. */
const PRESENT_SOURCE = String.raw`(ids) => {
  var missing = ids.filter(function (id) { return document.getElementById(id) === null; });
  var hooks = window.__bench || null;
  return {
    missing: missing,
    setInstant: !!hooks && typeof hooks.setInstant === 'function',
    setSector: !!hooks && typeof hooks.setSector === 'function'
  };
}`

/**
 * Stop CSS transitions only, once per document. Animations are not removed here:
 * finishAnimations() carries them to their end state, so a finished entrance keeps
 * its final look (animation:none would blank it).
 */
const TRANSITIONS_OFF_SOURCE = String.raw`() => {
  if (document.getElementById('__bench_transitions_off')) return false;
  var style = document.createElement('style');
  style.id = '__bench_transitions_off';
  style.textContent = '*,*::before,*::after{transition:none !important;scroll-behavior:auto !important;caret-color:transparent !important}';
  (document.head || document.documentElement).appendChild(style);
  return true;
}`

/** Finish every Web Animation, each in its own try, so an infinite one cannot stop the rest. */
const FINISH_JS =
  'function finish() { var list = document.getAnimations(); for (var i = 0; i < list.length; i++) { try { list[i].finish(); } catch (e) { /* an infinite animation cannot finish */ } } }'
/** Element-local to screen: a CSS matrix applied to a point. */
const XF_JS = 'function xf(m, x, y) { return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }'
/** A line element's two endpoints in screen pixels, or null when it is not a line. */
const SEG_JS =
  'function seg(el) { if (!el || !el.x1 || typeof el.getScreenCTM !== "function") return null; var m = el.getScreenCTM(); if (!m) return null; ' +
  'var a = xf(m, el.x1.baseVal.value, el.y1.baseVal.value); var b = xf(m, el.x2.baseVal.value, el.y2.baseVal.value); return [a[0], a[1], b[0], b[1]]; }'

/**
 * One turn: setInstant(utcMs, offset), finish the animations, then read the named
 * lines (screen endpoints) and readouts (text). A page that draws later than the
 * call returns is read before its draw, and fails.
 */
const SET_READ_SOURCE =
  '(arg) => { ' + FINISH_JS + ' ' + XF_JS + ' ' + SEG_JS + ' ' +
  'var out = { ok: null, lines: [], texts: [], error: null };' +
  'try { out.ok = window.__bench.setInstant(arg.utcMs, arg.offsetMinutes); }' +
  ' catch (e) { out.error = "setInstant threw " + e.name; return out; }' +
  'finish();' +
  'out.lines = arg.lines.map(function (id) { return seg(document.getElementById(id)); });' +
  'out.texts = arg.texts.map(function (id) { var el = document.getElementById(id); return el ? el.textContent : null; });' +
  'return out; }'

/** One turn: setSector(start, end), then finish the animations. Returns the hook's value. */
const SET_SECTOR_SOURCE =
  '(a) => { ' + FINISH_JS +
  ' var ok; try { ok = window.__bench.setSector(a[0], a[1]); } catch (e) { return "threw " + e.name; }' +
  ' finish(); return ok; }'

/**
 * The sync-validation turn. setInstant(first), then setSector(first sector), then the
 * animations already running are noted; then setInstant(second) and setSector(second
 * sector) are applied in the same turn. The minute hand, #digital and the animations
 * that were NOT running before the second call are read straight after it. No
 * finish() here: a stray transition must show.
 */
const SYNC_SOURCE =
  '(arg) => { var b = window.__bench; var clock = document.getElementById("clock");' +
  ' function inClock(an) { var t = an.effect && an.effect.target; return !!t && clock.contains(t); }' +
  ' ' + XF_JS + ' ' + SEG_JS +
  ' b.setInstant(arg.first[0], arg.first[1]);' +
  ' b.setSector(arg.sector1[0], arg.sector1[1]);' +
  ' var before = document.getAnimations();' +
  ' var okB = b.setInstant(arg.second[0], arg.second[1]);' +
  ' var okS = b.setSector(arg.sector2[0], arg.sector2[1]);' +
  ' var animations = document.getAnimations().filter(function (an) { return before.indexOf(an) < 0 && inClock(an); }).length;' +
  ' var digital = document.getElementById("digital");' +
  ' return { okB: okB, okS: okS, digital: digital ? digital.textContent : null, minute: seg(document.getElementById("hand-minute")), animations: animations }; }'

/** Screen endpoints of the hands, the sector's d attribute and display, for the snapshot. */
const SNAPSHOT_SOURCE = String.raw`() => {
  function ends(id) {
    var el = document.getElementById(id);
    var m = el.getScreenCTM();
    function xf(x, y) { return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }
    return [xf(el.x1.baseVal.value, el.y1.baseVal.value), xf(el.x2.baseVal.value, el.y2.baseVal.value)];
  }
  var sector = document.getElementById('sector');
  return {
    hands: [ends('hand-hour'), ends('hand-minute'), ends('hand-second'), ends('hand-24h')],
    texts: ['digital', 'date-window', 'offset-label', 'week-label'].map(function (id) {
      return document.getElementById(id).textContent;
    }),
    sectorD: sector.getAttribute('d'),
    sectorDisplay: getComputedStyle(sector).display
  };
}`

const SET_INSTANT_INVALID = (calls: string): string =>
  `(function () { var b = window.__bench; var out = []; var calls = [${calls}]; calls.forEach(function (fn) { try { var v = fn(); out.push(v === false ? 'false' : 'other:' + String(v)); } catch (e) { out.push('threw:' + e.name); } }); return out; })`

// ---------------------------------------------------------------------------
// Helpers shared by the checks
// ---------------------------------------------------------------------------

const AMBER = parseCssColour('#f59e0b')

const dist = (p: Pt, q: Pt): number => Math.hypot(p.x - q.x, p.y - q.y)
const angleOfLine = (g: Geo): number => clockwiseAngle((g.bx ?? 0) - (g.ax ?? 0), (g.by ?? 0) - (g.ay ?? 0))
const lineA = (g: Geo): Pt => ({ x: g.ax ?? 0, y: g.ay ?? 0 })
const lineB = (g: Geo): Pt => ({ x: g.bx ?? 0, y: g.by ?? 0 })
const angleDiff = (a: number, b: number): number => Math.abs(circularDifference(a, b))

/** The screen point at clockwise angle deg and distance rho * R from centre c. */
function screenPolar(c: Pt, R: number, deg: number, rho: number): Pt {
  const t = (deg * Math.PI) / 180
  return { x: c.x + rho * R * Math.sin(t), y: c.y - rho * R * Math.cos(t) }
}

const fmt = (n: number): string => n.toFixed(2)

async function geo(page: Page, selector: string, op: string): Promise<Geo[]> {
  return probe<Geo[]>(page, GEOM_SOURCE, { selector, op })
}

/** The first matching element's geometry. A missing element throws, which the wrapper records as a failure. */
async function one(page: Page, selector: string, op: string): Promise<Geo> {
  const list = await geo(page, selector, op)
  const first = list[0]
  if (first === undefined) throw new Error(`no element for ${selector}`)
  if (!first.ok) throw new Error(first.detail ?? `${selector} is not a ${op}`)
  return first
}

/** A line's geometry from a set-and-read turn. A null segment means the element is not a line: the check throws and fails. */
function segGeo(s: Seg | null | undefined, label: string): Geo {
  if (!s) throw new Error(`${label} has no screen line`)
  return { ok: true, ax: s[0], ay: s[1], bx: s[2], by: s[3] }
}

async function svgClip(page: Page): Promise<Clip> {
  const r = await one(page, '#clock', 'rect')
  return { x: r.left ?? 0, y: r.top ?? 0, width: (r.right ?? 0) - (r.left ?? 0), height: (r.bottom ?? 0) - (r.top ?? 0) }
}

async function contract(page: Page): Promise<Contract> {
  return probe<Contract>(page, CONTRACT_SOURCE, undefined, 1500)
}

/**
 * Structural precondition: the listed elements and both hooks exist, then (optionally)
 * transitions are off and every running animation is carried to its end state.
 */
async function prepare(page: Page, ids: readonly string[], freeze: boolean): Promise<string | undefined> {
  const c = await probe<{ missing: string[]; setInstant: boolean; setSector: boolean }>(page, PRESENT_SOURCE, [...ids], 1500)
  if (c.missing.length > 0) return `missing ${c.missing.join(', ')}`
  if (!c.setInstant || !c.setSector) return 'window.__bench.setInstant and setSector must both be functions'
  if (freeze) {
    await probe(page, TRANSITIONS_OFF_SOURCE, undefined, 1500)
    await finishAnimations(page)
  }
  return undefined
}

/** One turn: apply an instant, finish the animations, read the named lines and texts. */
async function readAt(page: Page, inst: H.Instant, lines: readonly string[], texts: readonly string[]): Promise<SetRead> {
  return probe<SetRead>(
    page,
    SET_READ_SOURCE,
    { utcMs: inst.utcMs, offsetMinutes: inst.offsetMinutes, lines: [...lines], texts: [...texts] },
    1500
  )
}

/** A failed hook call, as a detail string, or undefined when setInstant returned exactly true. */
function hookFailure(r: SetRead, label: string): string | undefined {
  if (r.error !== null) return `${label}: ${r.error}`
  if (r.ok !== true) return `${label}: setInstant returned ${String(r.ok)}, need true`
  return undefined
}

/** One turn: setSector, then finish the animations. True only for exactly true. */
async function setSec(page: Page, start: number, end: number): Promise<boolean> {
  return (await probe<unknown>(page, SET_SECTOR_SOURCE, [start, end], 1500)) === true
}

/** Set the parked instant (all hands at 0 degrees) and report a hook problem, if any. */
async function park(page: Page): Promise<string | undefined> {
  return hookFailure(await readAt(page, H.PARKED_INSTANT, [], []), H.PARKED_INSTANT.label)
}

/**
 * Pinned to UTC, a fresh document, then the precondition for the listed elements.
 * Every check except clock-host-timezone runs through here.
 */
async function withClock(
  ctx: CheckContext,
  ids: readonly string[],
  body: (page: Page) => Promise<CheckOutcome>,
  freeze = true
): Promise<CheckOutcome> {
  return pinTimezone(ctx.page, 'UTC', async () => {
    await freshLoad(ctx)
    const problem = await prepare(ctx.page, ids, freeze)
    if (problem !== undefined) return { passed: false, detail: problem }
    return body(ctx.page)
  })
}

function outcome(fails: string[], passDetail: string): CheckOutcome {
  return fails.length === 0 ? { passed: true, detail: passDetail } : { passed: false, detail: fails.slice(0, 3).join('; ') }
}

/** The angle a hand line reads, compared against an expected angle from the reference. NaN fails. */
function handCheck(
  fails: string[],
  label: string,
  g: Geo,
  want: number,
  tolerance: number,
  instant: H.Instant
): void {
  const got = angleOfLine(g)
  const d = angleDiff(got, want)
  if (!(d <= tolerance)) fails.push(`${instant.label} ${label} ${fmt(got)} vs ${fmt(want)} (off ${fmt(d)})`)
}

/** Readout text with whitespace collapsed (the date window). */
const readoutText = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** clock-structure (6): contract elements, true circle, hand and sub-dial bands, paint order and paint proof. */
async function structure(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  const c = await contract(page)
  const want: Record<string, string> = { clock: 'svg', dial: 'circle', subdial: 'circle', hour: 'line', minute: 'line', second: 'line', h24: 'line', sector: 'path' }
  for (const [key, tag] of Object.entries(want)) {
    if (c.tags[key] !== tag) fails.push(`${key} is ${String(c.tags[key])}, need ${tag}`)
  }
  if (c.ticks !== 60) fails.push(`line.tick count ${c.ticks}, need 60`)
  if (c.majors !== 12) fails.push(`line.tick.major count ${c.majors}, need 12`)
  if (c.numerals !== 12) fails.push(`text.numeral count ${c.numerals}, need 12`)
  if (!c.order) fails.push('paint order is not sector < hour < minute < second')

  // The paint instant, the hands read in the same turn as the call.
  const turn = await readAt(page, H.PAINT_INSTANT, HAND_IDS, [])
  const problem = hookFailure(turn, H.PAINT_INSTANT.label)
  if (problem !== undefined) return { passed: false, detail: problem }

  const tol = H.TOL.relSlack
  const dial = await one(page, '#dial', 'circle')
  const R = (dial.rx! + dial.ry!) / 2
  const centre: Pt = { x: dial.cx!, y: dial.cy! }
  if (!(Math.abs(dial.rx! - dial.ry!) <= tol * R)) fails.push(`dial radii ${fmt(dial.rx!)} and ${fmt(dial.ry!)} px differ`)
  if (!(Math.min(dial.rx!, dial.ry!) >= H.TOL.dialMinWide)) fails.push(`dial radius ${fmt(Math.min(dial.rx!, dial.ry!))} px < 150`)

  const handBand = (label: string, s: Seg, lo: number, hi: number): void => {
    const tail: Pt = { x: s[0], y: s[1] }
    const tip: Pt = { x: s[2], y: s[3] }
    const dTip = dist(centre, tip) / R
    const dTail = dist(centre, tail) / R
    if (!(dTip >= lo * (1 - tol) && dTip <= hi * (1 + tol))) fails.push(`${label} tip at ${fmt(dTip)}R, need ${lo}-${hi}R`)
    if (!(dTail <= 0.2 * (1 + tol))) fails.push(`${label} tail ${fmt(dTail)}R, need <= 0.2R`)
    const dot = (tail.x - centre.x) * (tip.x - centre.x) + (tail.y - centre.y) * (tip.y - centre.y)
    if (!(dot <= 1e-6 * R * R)) fails.push(`${label} tail is in front of the centre`)
    if (!(pointLineDistance(centre, tail, tip) <= H.TOL.pxLine)) fails.push(`${label} line misses the centre`)
  }
  const segs = HAND_IDS.map((id, i) => {
    const s = turn.lines[i]
    if (!s) throw new Error(`${id} has no screen line`)
    return s
  })
  handBand('hour hand', segs[0]!, 0.4, 0.55)
  handBand('minute hand', segs[1]!, 0.62, 0.76)
  handBand('second hand', segs[2]!, 0.62, 0.76)

  const sub = await one(page, '#subdial', 'circle')
  const subC: Pt = { x: sub.cx!, y: sub.cy! }
  const rs = (sub.rx! + sub.ry!) / 2
  if (!(Math.abs(sub.rx! - sub.ry!) <= tol * rs)) fails.push('sub-dial is not a true circle')
  if (!(rs >= 0.1 * R * (1 - tol) && rs <= 0.14 * R * (1 + tol))) fails.push(`sub-dial radius ${fmt(rs / R)}R, need 0.10-0.14R`)
  const off = dist(centre, subC) / R
  if (!(off >= 0.26 * (1 - tol) && off <= 0.32 * (1 + tol))) fails.push(`sub-dial centre ${fmt(off)}R from the pivot, need 0.26-0.32R`)
  if (!(subC.y > centre.y && Math.abs(subC.x - centre.x) <= H.TOL.pxLine)) fails.push('sub-dial is not directly below the pivot')
  const h24 = segs[3]!
  if (!(dist(subC, { x: h24[0], y: h24[1] }) <= H.TOL.pxLine)) fails.push('24-hour hand does not start at the sub-dial centre')
  const tipRatio = dist(subC, { x: h24[2], y: h24[3] }) / rs
  if (!(tipRatio >= 0.6 * (1 - tol) && tipRatio <= 0.95 * (1 + tol))) fails.push(`24-hour tip at ${fmt(tipRatio)} of the sub-dial radius, need 0.6-0.95`)

  // Paint proof, at the paint instant: the drawn line's pixels, at several fractions along it, must change
  // when the four hands are hidden. This proves each hand is drawn; its direction is judged by the angle checks.
  await finishAnimations(page)
  const names = ['hour', 'minute', 'second', '24h']
  const paintPts: Pt[] = []
  const paintNames: string[] = []
  segs.forEach((s, i) => {
    for (const f of H.PAINT_FRACTIONS) {
      paintPts.push({ x: s[0] + f * (s[2] - s[0]), y: s[1] + f * (s[3] - s[1]) })
      paintNames.push(`${names[i]} hand at ${Math.round(f * 100)}%`)
    }
  })
  const diffs = await paintDiff(page, await svgClip(page), HAND_IDS.map((id) => `#${id}`).join(', '), paintPts)
  diffs.forEach((d, i) => {
    if (!(d >= H.TOL.paintDiff)) fails.push(`${paintNames[i]} not painted: largest change ${d}`)
  })

  // The on-screen rule: the clock and readouts lie inside the viewport and are shown (not display:none, not covered).
  const onScreen = async (label: string, w: number, h: number): Promise<void> => {
    for (const id of ['clock', 'digital', 'date-window', 'offset-label', 'week-label']) {
      const r = await one(page, `#${id}`, 'rect')
      if (!((r.left ?? -1) >= 0 && (r.top ?? -1) >= 0 && (r.right ?? 0) <= w && (r.bottom ?? 0) <= h)) {
        fails.push(`${label}#${id} is outside 0..${w} x 0..${h}`)
      }
      const shown = await probe<{ visible: boolean; detail: string }>(page, VISIBLE, `#${id}`, 1500)
      if (shown.visible !== true) fails.push(`${label}#${id} is not visible: ${shown.detail}`)
    }
  }
  await onScreen('', H.TOL.wide.width, H.TOL.wide.height)

  // Same geometry at the narrow viewport: the dial still at least 100 px, everything on screen.
  await withViewport(page, H.TOL.narrow.width, H.TOL.narrow.height, async () => {
    const d2 = await one(page, '#dial', 'circle')
    if (!(Math.abs(d2.rx! - d2.ry!) <= tol * ((d2.rx! + d2.ry!) / 2))) fails.push('narrow: dial is not a true circle')
    if (!(Math.min(d2.rx!, d2.ry!) >= H.TOL.dialMinNarrow)) fails.push(`narrow: dial radius ${fmt(Math.min(d2.rx!, d2.ry!))} px < 100`)
    await onScreen('narrow: ', H.TOL.narrow.width, H.TOL.narrow.height)
  })
  const paintNote = `paint change ${diffs.map((d) => String(d)).join('/')} (need >= ${H.TOL.paintDiff})`
  return outcome(fails, `contract, true circle, bands and paint order hold at 1024x720 and 380x480; ${paintNote}`)
}

/** clock-ticks-numerals (7): sixty ticks on 6-degree steps, twelve majors, twelve upright numerals. */
async function ticksAndNumerals(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  const dial = await one(page, '#dial', 'circle')
  const R = (dial.rx! + dial.ry!) / 2
  const c: Pt = { x: dial.cx!, y: dial.cy! }
  const ticks = await geo(page, 'line.tick', 'line')
  if (ticks.length !== 60) fails.push(`${ticks.length} ticks, need 60`)
  const seen = new Set<number>()
  const minorLengths: number[] = []
  const majorLengths: number[] = []
  const majorSlots: number[] = []
  const midpoints: Pt[] = []
  for (const t of ticks) {
    if (!t.ok) {
      fails.push('a tick has no geometry')
      continue
    }
    const a = lineA(t)
    const b = lineB(t)
    midpoints.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const da = clockwiseAngle(a.x - c.x, a.y - c.y)
    const db = clockwiseAngle(b.x - c.x, b.y - c.y)
    if (!(angleDiff(da, db) <= H.TOL.tickDeg)) fails.push(`tick ends differ by ${fmt(angleDiff(da, db))} deg`)
    const ra = dist(a, c) / R
    const rb = dist(b, c) / R
    if (!(ra >= 0.89 && ra <= 1.005 && rb >= 0.89 && rb <= 1.005)) fails.push(`tick radii ${fmt(ra)}R..${fmt(rb)}R, need 0.90-1.00R`)
    const mid = mod(da + circularDifference(db, da) / 2, 360)
    const k = mod(Math.round(mid / 6), 60)
    if (!(angleDiff(mid, k * 6) <= H.TOL.tickResidualDeg)) fails.push(`tick at ${fmt(mid)} deg is off the 6-degree grid`)
    seen.add(k)
    const len = dist(a, b)
    if ((t.cls ?? '').split(/\s+/).includes('major')) {
      majorLengths.push(len)
      majorSlots.push(k)
    } else {
      minorLengths.push(len)
    }
  }
  if (seen.size !== 60) fails.push(`${seen.size} distinct 6-degree slots, need all 60 once`)
  const expectedMajors = Array.from({ length: 60 }, (_, k) => k).filter((k) => k % 5 === 0)
  if (majorSlots.slice().sort((x, y) => x - y).join(',') !== expectedMajors.join(',')) {
    fails.push('the major class is not exactly on the multiples of 30 degrees')
  }
  if (majorLengths.length > 0 && minorLengths.length > 0) {
    const shortestMajor = Math.min(...majorLengths)
    const longestMinor = Math.max(...minorLengths)
    if (!(shortestMajor >= H.TOL.majorRatio * longestMinor)) {
      fails.push(`shortest major ${fmt(shortestMajor)} px < 1.4 x longest minor ${fmt(longestMinor)} px`)
    }
  }

  // Paint proof for the ticks: the midpoint of each drawn tick changes when all ticks are hidden.
  if (midpoints.length > 0) {
    const changes = await paintDiff(page, await svgClip(page), 'line.tick', midpoints)
    const unpainted = changes.filter((d) => !(d >= H.TOL.tickPaint))
    if (unpainted.length > 0) {
      fails.push(`${unpainted.length} of ${changes.length} ticks are not painted (smallest change ${Math.min(...changes)})`)
    }
  }

  const numerals = await geo(page, 'text.numeral', 'text')
  const texts = numerals.map((n) => n.text ?? '').slice().sort((x, y) => Number(x) - Number(y))
  if (texts.join(',') !== Array.from({ length: 12 }, (_, i) => String(i + 1)).join(',')) {
    fails.push(`numeral texts are ${texts.join(',')}, need 1..12 once each`)
  }
  for (const n of numerals) {
    const value = Number(n.text)
    const centre: Pt = { x: n.cx ?? 0, y: n.cy ?? 0 }
    const ang = clockwiseAngle(centre.x - c.x, centre.y - c.y)
    if (!(angleDiff(ang, value * 30) <= H.TOL.numeralDeg)) fails.push(`numeral ${n.text} at ${fmt(ang)} deg, need ${value * 30}`)
    const rho = dist(centre, c) / R
    if (!(rho >= 0.52 && rho <= 0.71)) fails.push(`numeral ${n.text} at ${fmt(rho)}R, need 0.52-0.71R`)
    if (!(angleDiff(n.rot ?? 0, 0) <= H.TOL.numeralUpright)) fails.push(`numeral ${n.text} is rotated ${fmt(n.rot ?? 0)} deg`)
  }
  return outcome(fails, 'sixty ticks on the grid and painted, twelve majors, and twelve upright numerals at their hour positions')
}

/** clock-minute-second (8): minute hand with its seconds advance, and the second hand. */
async function minuteSecond(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.MINUTE_SECOND_CASES) {
    const r = await readAt(page, inst, ['hand-minute', 'hand-second'], [])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
    handCheck(fails, 'minute', segGeo(r.lines[0], 'hand-minute'), ref.minuteDeg, H.TOL.minuteDeg, inst)
    handCheck(fails, 'second', segGeo(r.lines[1], 'hand-second'), ref.secondDeg, H.TOL.secondDeg, inst)
  }
  return outcome(fails, 'minute and second hands within 0.5 degree at all four instants')
}

/** clock-hour-hand (11): hour hand with the partial advance and the seconds term, at the edges around 12. */
async function hourHand(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.HOUR_CASES) {
    const r = await readAt(page, inst, ['hand-hour'], [])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
    handCheck(fails, 'hour', segGeo(r.lines[0], 'hand-hour'), ref.hourDeg, H.TOL.hourDeg, inst)
  }
  return outcome(fails, 'hour hand within 0.25 degree at all ten instants')
}

/** clock-offset-time (11): local time under fractional, negative and extreme offsets. */
async function offsetTime(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.OFFSET_CASES) {
    const r = await readAt(page, inst, ['hand-minute', 'hand-hour'], ['digital', 'offset-label'])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
    const digital = r.texts[0] ?? null
    if (digital !== ref.digital) fails.push(`${inst.label} digital "${String(digital)}" vs "${ref.digital}"`)
    const normal = (r.texts[1] ?? '').trim().replace(/−/g, '-')
    if (normal !== ref.offsetLabel) fails.push(`${inst.label} offset "${normal}" vs "${ref.offsetLabel}"`)
    handCheck(fails, 'minute', segGeo(r.lines[0], 'hand-minute'), ref.minuteDeg, H.TOL.minuteDeg, inst)
    handCheck(fails, 'hour', segGeo(r.lines[1], 'hand-hour'), ref.hourDeg, H.TOL.offsetHourDeg, inst)
  }
  return outcome(fails, 'digital, offset label and both hands agree at all seven offsets')
}

/** clock-date-window (7): weekday and day of month of the local date. */
async function dateWindow(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.DATE_CASES) {
    const r = await readAt(page, inst, [], ['date-window'])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const want = clockReadout(inst.utcMs, inst.offsetMinutes).date
    const got = readoutText(r.texts[0] ?? null)
    if (got !== want) fails.push(`${inst.label} "${got}" vs "${want}"`)
  }
  return outcome(fails, 'weekday and day of month correct at all seven dates')
}

/** clock-iso-week (7): ISO week and week-numbering year at year boundaries. */
async function isoWeek(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.ISO_WEEK_CASES) {
    const r = await readAt(page, inst, [], ['week-label'])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const want = clockReadout(inst.utcMs, inst.offsetMinutes).week
    const got = (r.texts[0] ?? '').trim()
    if (got !== want) fails.push(`${inst.label} "${got}" vs "${want}"`)
  }
  return outcome(fails, 'ISO week and week-numbering year correct at all nine instants')
}

/** clock-subdial-24h (6): the 24-hour hand pivots on the sub-dial with midnight at the top. */
async function subdial24(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  const sub = await one(page, '#subdial', 'circle')
  const subC: Pt = { x: sub.cx!, y: sub.cy! }
  for (const inst of H.H24_CASES) {
    const r = await readAt(page, inst, ['hand-24h'], [])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const g = segGeo(r.lines[0], 'hand-24h')
    if (!(dist(lineA(g), subC) <= H.TOL.pxLine)) fails.push(`${inst.label} 24h tail is off the sub-dial centre`)
    const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
    handCheck(fails, '24h', g, ref.h24Deg, H.TOL.h24Deg, inst)
  }
  return outcome(fails, '24-hour hand pivots on the sub-dial and matches at all five times')
}

/** clock-sector-band (6): the sector is #f59e0b and fills exactly the 0.78R-0.88R band. */
async function sectorBand(page: Page): Promise<CheckOutcome> {
  const parked = await park(page)
  if (parked !== undefined) return { passed: false, detail: parked }
  if (!(await setSec(page, H.BAND_SECTOR[0], H.BAND_SECTOR[1]))) return { passed: false, detail: 'setSector returned false for 135, 315' }
  const dial = await one(page, '#dial', 'circle')
  const c: Pt = { x: dial.cx!, y: dial.cy! }
  const R = (dial.rx! + dial.ry!) / 2
  const inside: Array<{ deg: number; rho: number; pt: Pt }> = []
  const outside: Array<{ deg: number; rho: number; pt: Pt }> = []
  const spanOut: Array<{ deg: number; rho: number; pt: Pt }> = []
  for (const deg of H.BAND_ANGLES_DEG) {
    for (const rho of H.BAND_INSIDE_RADII) inside.push({ deg, rho, pt: screenPolar(c, R, deg, rho) })
    for (const rho of H.BAND_OUTSIDE_RADII) outside.push({ deg, rho, pt: screenPolar(c, R, deg, rho) })
  }
  for (const deg of H.BAND_OUTSIDE_SPAN_DEG) spanOut.push({ deg, rho: H.ARC_RADIUS, pt: screenPolar(c, R, deg, H.ARC_RADIUS) })
  const clip = await svgClip(page)
  await finishAnimations(page)
  const all = [...inside, ...outside, ...spanOut].map((s) => s.pt)
  const colours = await samplePixels(page, clip, all)
  const fails: string[] = []
  inside.forEach((s, i) => {
    const d = chan(colours[i]!, AMBER)
    if (!(d <= H.TOL.amberTol)) fails.push(`${s.deg} deg at ${s.rho}R is ${String(colours[i]!.slice(0, 3))}, ${fmt(d)} from amber`)
  })
  const notAmber = [...outside, ...spanOut]
  notAmber.forEach((s, i) => {
    const d = chan(colours[inside.length + i]!, AMBER)
    if (!(d >= H.TOL.notAmber)) fails.push(`${s.deg} deg at ${s.rho}R is amber-like (${fmt(d)} from amber)`)
  })
  // The amber must be the #sector element: hiding it changes every in-band sample.
  const paint = await paintDiff(page, clip, '#sector', inside.map((s) => s.pt))
  const unpainted = paint.filter((d) => !(d >= H.TOL.paintDiff)).length
  if (unpainted > 0) fails.push(`${unpainted} of ${paint.length} in-band samples do not change when #sector is hidden`)
  return outcome(fails, 'amber #f59e0b fills the 0.78R-0.88R band only, at three angles, and comes from #sector')
}

/** clock-sector-arcs (12): the sector's angular extent for six hidden spans, sampled at 72 points. */
async function sectorArcs(page: Page): Promise<CheckOutcome> {
  const parked = await park(page)
  if (parked !== undefined) return { passed: false, detail: parked }
  const dial = await one(page, '#dial', 'circle')
  const c: Pt = { x: dial.cx!, y: dial.cy! }
  const R = (dial.rx! + dial.ry!) / 2
  const clip = await svgClip(page)
  const fails: string[] = []
  for (const [start, end] of H.ARC_SPANS) {
    if (!(await setSec(page, start, end))) {
      fails.push(`${start}->${end} setSector returned false`)
      continue
    }
    const sp = sectorSpan(start, end)
    const samples: Array<{ deg: number; pt: Pt }> = []
    for (let k = 0; k < H.ARC_SAMPLES; k++) {
      const deg = 2.5 + 5 * k
      samples.push({ deg, pt: screenPolar(c, R, deg, H.ARC_RADIUS) })
    }
    await finishAnimations(page)
    const colours = await samplePixels(page, clip, samples.map((s) => s.pt))
    samples.forEach((s, i) => {
      if (sp.empty) {
        // An empty span paints nothing: every sample must be clearly not amber.
        if (chan(colours[i]!, AMBER) >= H.TOL.notAmber) return
        fails.push(`${start}->${end} empty but ${s.deg} deg is amber-like`)
        return
      }
      const rel = mod(s.deg - sp.startDeg, 360)
      const inSpan = rel < sp.widthDeg
      const edge = Math.min(angleDiff(s.deg, sp.startDeg), angleDiff(s.deg, sp.startDeg + sp.widthDeg))
      if (edge <= H.TOL.arcEdgeSkipDeg) return
      const d = chan(colours[i]!, AMBER)
      if (inSpan && !(d <= H.TOL.amberTol)) fails.push(`${start}->${end}: ${s.deg} deg inside the span is ${fmt(d)} from amber`)
      if (!inSpan && !(d >= H.TOL.notAmber)) fails.push(`${start}->${end}: ${s.deg} deg outside the span is amber-like`)
    })
  }
  return outcome(fails, 'all six hidden spans, including through 12, over 180 and empty, paint the right arc')
}

/** clock-edge-instants (6): pre-1970 and sub-second instants are floored. */
async function edgeInstants(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  for (const inst of H.EDGE_CASES) {
    const r = await readAt(page, inst, ['hand-second'], ['digital'])
    const problem = hookFailure(r, inst.label)
    if (problem !== undefined) {
      fails.push(problem)
      continue
    }
    const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
    const digital = r.texts[0] ?? null
    if (digital !== ref.digital) fails.push(`${inst.label} digital "${String(digital)}" vs "${ref.digital}"`)
    handCheck(fails, 'second', segGeo(r.lines[0], 'hand-second'), ref.secondDeg, H.TOL.secondDeg, inst)
  }
  return outcome(fails, 'pre-1970 and sub-second instants floor to the whole second')
}

/** clock-host-timezone (6): displayed time, date and week do not depend on the viewer's zone. */
async function hostTimezone(ctx: CheckContext): Promise<CheckOutcome> {
  const alt = await altTimezonePage(ctx, H.HOST_ZONE_ZONE)
  try {
    try {
      await alt.page.waitForFunction(
        "window.__bench !== undefined && typeof window.__bench.setInstant === 'function'",
        undefined,
        { timeout: 1500 }
      )
    } catch {
      return { passed: false, detail: 'window.__bench was not ready within 1.5 s in the second context' }
    }
    const zone = await probe<string>(alt.page, '() => Intl.DateTimeFormat().resolvedOptions().timeZone', undefined, 1500)
    if (zone !== H.HOST_ZONE_ZONE) return { passed: false, detail: `second context runs in ${zone}, not ${H.HOST_ZONE_ZONE}` }
    const problem = await prepare(alt.page, CHECK_IDS.host, true)
    if (problem !== undefined) return { passed: false, detail: problem }
    const fails: string[] = []
    for (const inst of H.HOST_ZONE_CASES) {
      const r = await readAt(alt.page, inst, ['hand-minute', 'hand-hour'], ['digital', 'date-window', 'week-label'])
      const hook = hookFailure(r, inst.label)
      if (hook !== undefined) {
        fails.push(hook)
        continue
      }
      const ref = clockReadout(inst.utcMs, inst.offsetMinutes)
      const digital = r.texts[0] ?? null
      if (digital !== ref.digital) fails.push(`${inst.label} digital "${String(digital)}" vs "${ref.digital}"`)
      const date = readoutText(r.texts[1] ?? null)
      if (date !== ref.date) fails.push(`${inst.label} date "${date}" vs "${ref.date}"`)
      const week = (r.texts[2] ?? '').trim()
      if (week !== ref.week) fails.push(`${inst.label} week "${week}" vs "${ref.week}"`)
      handCheck(fails, 'minute', segGeo(r.lines[0], 'hand-minute'), ref.minuteDeg, H.TOL.minuteDeg, inst)
      handCheck(fails, 'hour', segGeo(r.lines[1], 'hand-hour'), ref.hourDeg, H.TOL.offsetHourDeg, inst)
    }
    return outcome(fails, 'digital, date, week and hands match the reference in a Pacific/Chatham viewer')
  } finally {
    await alt.close()
  }
}

/** clock-sync-validation (7): synchronous hooks, no transition, false for invalid input, true for valid. */
async function syncValidation(page: Page): Promise<CheckOutcome> {
  const fails: string[] = []
  const sync = await probe<SyncRead>(
    page,
    SYNC_SOURCE,
    {
      first: [H.SYNC_FIRST.utcMs, H.SYNC_FIRST.offsetMinutes],
      second: [H.SYNC_SECOND.utcMs, H.SYNC_SECOND.offsetMinutes],
      sector1: H.SYNC_SECTORS[0],
      sector2: H.SYNC_SECTORS[1],
    },
    1500
  )
  if (sync.okB !== true) fails.push(`setInstant(B) returned ${String(sync.okB)}, need true`)
  const want = clockReadout(H.SYNC_SECOND.utcMs, H.SYNC_SECOND.offsetMinutes)
  if (sync.digital !== want.digital) fails.push(`digital is "${String(sync.digital)}" at once, need "${want.digital}"`)
  const minute = segGeo(sync.minute, 'hand-minute')
  const minuteGot = angleOfLine(minute)
  if (!(angleDiff(minuteGot, want.minuteDeg) <= H.TOL.minuteDeg)) fails.push(`minute hand ${fmt(minuteGot)} at once, need ${fmt(want.minuteDeg)}`)
  if (sync.animations !== 0) fails.push(`${sync.animations} animation(s) started by the call on the clock`)

  const before = await probe<unknown>(page, SNAPSHOT_SOURCE, undefined, 1500)
  const calls = H.INVALID_CALL_SOURCES.map((c) => `function () { return b.${c}; }`).join(', ')
  const results = await probe<string[]>(page, SET_INSTANT_INVALID(calls), undefined, 2000)
  H.INVALID_CALL_SOURCES.forEach((call, i) => {
    if (results[i] !== 'false') fails.push(`${call} returned ${String(results[i])}, need false`)
  })
  const after = await probe<unknown>(page, SNAPSHOT_SOURCE, undefined, 1500)
  if (JSON.stringify(before) !== JSON.stringify(after)) fails.push('an invalid call changed the page')

  const valid = await probe<boolean[]>(
    page,
    `(function () { var b = window.__bench; return [b.setInstant(${H.SYNC_SECOND.utcMs}, 0) === true, b.setSector(${H.VALID_SECTOR[0]}, ${H.VALID_SECTOR[1]}) === true]; })`,
    undefined,
    1500
  )
  if (valid[0] !== true) fails.push('a valid setInstant did not return exactly true')
  if (valid[1] !== true) fails.push('a valid setSector did not return exactly true')
  return outcome(fails, 'hooks apply at once, run no animation, reject invalid input and accept valid input')
}

// ---------------------------------------------------------------------------
// The check table
// ---------------------------------------------------------------------------

const RATIONALE: Record<string, string> = {
  'clock-structure': 'Contract elements, counts, true circle at both viewports, hand and sub-dial bands, paint order, and a paint proof that the hands are drawn.',
  'clock-ticks-numerals': 'Sixty radial ticks on 6-degree steps with majors marked and painted, and twelve upright numerals at the hour positions.',
  'clock-minute-second': 'Minute hand with its continuous seconds advance, and the second hand, at ordinary times.',
  'clock-hour-hand': 'Hour hand partial advance including the seconds term, and the edge cases around 12 o\'clock.',
  'clock-offset-time': 'Local time under fractional, negative and extreme offsets that cross midnight.',
  'clock-date-window': 'Weekday and day of month across month ends, leap days and the 1900 and 2100 rules.',
  'clock-iso-week': 'The ISO 8601 week and week-numbering year at year boundaries.',
  'clock-subdial-24h': 'The 24-hour hand makes one revolution a day with midnight at the top.',
  'clock-sector-band': 'The sector is #f59e0b, comes from #sector, and occupies exactly the 0.78R to 0.88R band.',
  'clock-sector-arcs': 'The sector\'s angular extent for hidden spans, including through 12, over 180 degrees, exactly 180, nearly full and empty.',
  'clock-edge-instants': 'Negative and sub-second timestamps are floored, not truncated or rounded.',
  'clock-host-timezone': 'The displayed time, date and week do not depend on the viewer\'s time zone.',
  'clock-sync-validation': 'Hooks apply synchronously without transitions, return true for valid input, and return false without changing the page for invalid input.',
}

/** The name and points of each check, in the specification's order. Sums to 100. */
export const CHECK_SPECS: ReadonlyArray<{ name: string; points: number }> = [
  { name: 'clock-structure', points: 6 },
  { name: 'clock-ticks-numerals', points: 7 },
  { name: 'clock-minute-second', points: 8 },
  { name: 'clock-hour-hand', points: 11 },
  { name: 'clock-offset-time', points: 11 },
  { name: 'clock-date-window', points: 7 },
  { name: 'clock-iso-week', points: 7 },
  { name: 'clock-subdial-24h', points: 6 },
  { name: 'clock-sector-band', points: 6 },
  { name: 'clock-sector-arcs', points: 12 },
  { name: 'clock-edge-instants', points: 6 },
  { name: 'clock-host-timezone', points: 6 },
  { name: 'clock-sync-validation', points: 7 },
]

/** The SHA-256 of the specification's final_prompt. The prompt test compares against this, so it cannot go vacuous. */
export const PROMPT_SHA256 = 'd87c780a4390dea2580ac9b5ae651eed78fa00eb6513e1785f20515c94588271'

/** The hash of a prompt text, as the test computes it. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function make(name: string, points: number, run: (ctx: CheckContext) => Promise<CheckOutcome>): CheckFn {
  return defineCheck(name, points, RATIONALE[name] ?? name, run)
}

const clockCheck =
  (ids: readonly string[], body: (page: Page) => Promise<CheckOutcome>, freeze = true) =>
  (ctx: CheckContext) =>
    withClock(ctx, ids, body, freeze)

export const checks: Record<string, CheckFn> = {
  'clock-structure': make('clock-structure', 6, clockCheck(CHECK_IDS.structure, structure)),
  'clock-ticks-numerals': make('clock-ticks-numerals', 7, clockCheck(CHECK_IDS.ticks, ticksAndNumerals)),
  'clock-minute-second': make('clock-minute-second', 8, clockCheck(CHECK_IDS.minuteSecond, minuteSecond)),
  'clock-hour-hand': make('clock-hour-hand', 11, clockCheck(CHECK_IDS.hour, hourHand)),
  'clock-offset-time': make('clock-offset-time', 11, clockCheck(CHECK_IDS.offset, offsetTime)),
  'clock-date-window': make('clock-date-window', 7, clockCheck(CHECK_IDS.date, dateWindow)),
  'clock-iso-week': make('clock-iso-week', 7, clockCheck(CHECK_IDS.iso, isoWeek)),
  'clock-subdial-24h': make('clock-subdial-24h', 6, clockCheck(CHECK_IDS.subdial, subdial24)),
  'clock-sector-band': make('clock-sector-band', 6, clockCheck(CHECK_IDS.band, sectorBand)),
  'clock-sector-arcs': make('clock-sector-arcs', 12, clockCheck(CHECK_IDS.arcs, sectorArcs)),
  'clock-edge-instants': make('clock-edge-instants', 6, clockCheck(CHECK_IDS.edge, edgeInstants)),
  'clock-host-timezone': make('clock-host-timezone', 6, (ctx) => hostTimezone(ctx)),
  'clock-sync-validation': make('clock-sync-validation', 7, clockCheck(CHECK_IDS.sync, syncValidation, false)),
}
