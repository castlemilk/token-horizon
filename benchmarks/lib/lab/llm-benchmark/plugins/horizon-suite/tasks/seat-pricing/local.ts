/**
 * In-page sources and drivers specific to seat-pricing. Every in-page function is a
 * plain-JavaScript SOURCE STRING (postmortem 0008), run through the kit's probe().
 *
 * Plan buttons are always addressed as button[data-plan="..."]: a card or any other
 * element may carry data-plan too (the prompt's contract names the buttons only).
 *
 * The kit's tabWalk reports a plan button by its aria-label or text, but the
 * contract names a plan button by data-plan, and it does not look at the label of a
 * visually hidden radio. This file carries its own walk with both.
 */
import type { Page } from 'playwright'
import { bounded, probe } from '../../lib/probe'
import { TAB_BLUR_AND_CLEAN, TAB_START } from '../../lib/sources'
import { PAGE_CANVAS } from './contrast'

const ACTION_MS = 1500

/** Shared helpers every in-page source below repeats (a page cannot import this file). */
const IS_SHOWN = String.raw`function isShown(e) {
  if (!e) return false;
  if (typeof e.checkVisibility === 'function') {
    try { if (!e.checkVisibility()) return false; } catch (err) { /* fall through */ }
  }
  var cs = getComputedStyle(e);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  var opacity = 1;
  for (var up = e; up && up.nodeType === 1; up = up.parentElement) opacity *= parseFloat(getComputedStyle(up).opacity);
  if (!(opacity > 0)) return false;
  var r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function labelOf(e) {
  if (e.labels && e.labels.length > 0) return e.labels[0];
  return e.closest ? e.closest('label') : null;
}
/** A native radio is shown through its own box or through its label (the visually hidden radio pattern). */
function shownOrLabel(e) {
  if (isShown(e)) return true;
  var label = e.type === 'radio' ? labelOf(e) : null;
  return !!label && isShown(label);
}
function finishAll() {
  document.getAnimations().forEach(function (animation) {
    try { animation.finish(); } catch (err) { /* infinite animations cannot finish */ }
  });
}
/* Any computed colour as [r, g, b, a] (channels 0..255, alpha 0..1), read back through a 1 x 1 canvas so that
   colour functions the Node-side parser does not know (oklch, lab, color-mix) still resolve. Null if unreadable. */
var RGBA_CTX = (function () {
  var c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  return c.getContext('2d', { willReadFrequently: true });
})();
function rgbaOf(input) {
  var exact = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(String(input).trim());
  if (exact) return [Number(exact[1]), Number(exact[2]), Number(exact[3]), exact[4] === undefined ? 1 : Number(exact[4])];
  if (!RGBA_CTX) return null;
  try {
    RGBA_CTX.clearRect(0, 0, 1, 1);
    RGBA_CTX.fillStyle = '#000000';
    RGBA_CTX.fillStyle = input;
    RGBA_CTX.fillRect(0, 0, 1, 1);
    var d = RGBA_CTX.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  } catch (err) { return null; }
}`

/**
 * Apply a scenario through the contract. Keys left out of s are not touched, so a
 * step can change one control and keep an applied code. Order: plan, billing, region,
 * seats, promo (last, so a code is evaluated against the seats it is applied to).
 * The promo field gets the input and change events a typed value would give, before
 * Apply is pressed, so a page that tracks the typed text sees the same code.
 */
const APPLY_STATE = String.raw`function applyState(s) {
  var missing = [];
  function fire(node, type) { node.dispatchEvent(new Event(type, { bubbles: true })); }
  if (s.plan !== undefined) {
    var b = document.querySelector('button[data-plan="' + s.plan + '"]');
    if (b) b.click(); else missing.push('plan');
  }
  if (s.annual !== undefined) {
    var r = document.getElementById(s.annual ? 'billing-annual' : 'billing-monthly');
    if (r) r.click(); else missing.push('billing');
  }
  if (s.region !== undefined) {
    var sel = document.getElementById('region');
    if (sel) { sel.value = s.region; fire(sel, 'input'); fire(sel, 'change'); } else missing.push('region');
  }
  if (s.seats !== undefined) {
    var inp = document.getElementById('seats');
    if (inp) { inp.value = String(s.seats); fire(inp, 'input'); fire(inp, 'change'); } else missing.push('seats');
  }
  if (s.promo !== undefined) {
    var p = document.getElementById('promo');
    var a = document.getElementById('promo-apply');
    if (p && a) { p.value = s.promo; fire(p, 'input'); fire(p, 'change'); a.click(); } else missing.push('promo');
  }
  return missing;
}`

/** Everything a check reads, in one object, same turn. */
const SNAPSHOT = String.raw`${IS_SHOWN}
function snapshot() {
  var AMOUNTS = ['subtotal', 'annual-discount', 'promo-discount', 'tax', 'total', 'per-seat'];
  var out = { amounts: {}, promo: null, seats: null, disabled: {}, pressed: {}, annual: false, bar: null, missing: [] };
  AMOUNTS.forEach(function (id) {
    var e = document.getElementById(id);
    if (!e) { out.missing.push(id); out.amounts[id] = null; return; }
    out.amounts[id] = {
      cents: e.getAttribute('data-cents'),
      text: e.textContent,
      inner: e.innerText,
      shown: isShown(e) && getComputedStyle(e).visibility !== 'hidden'
    };
  });
  var st = document.getElementById('promo-status');
  if (st) out.promo = { state: st.getAttribute('data-state'), text: st.textContent.trim(), shown: isShown(st) };
  var seats = document.getElementById('seats');
  var err = document.getElementById('seats-error');
  if (seats) out.seats = {
    value: seats.value,
    invalid: seats.getAttribute('aria-invalid'),
    describedBy: seats.getAttribute('aria-describedby') || '',
    errorText: err ? err.textContent.trim() : null,
    errorShown: !!err && isShown(err)
  };
  ['checkout', 'seats-dec', 'seats-inc'].forEach(function (id) {
    var e = document.getElementById(id);
    out.disabled[id] = e ? e.disabled === true : null;
  });
  document.querySelectorAll('button[data-plan]').forEach(function (b) {
    out.pressed[b.getAttribute('data-plan')] = b.getAttribute('aria-pressed');
  });
  var annual = document.getElementById('billing-annual');
  out.annual = !!(annual && annual.checked);
  var bar = document.getElementById('breakdown');
  if (bar) {
    out.bar = {
      width: bar.getBoundingClientRect().width,
      segments: ['net', 'tax', 'saved'].map(function (name) {
        var s = bar.querySelector('[data-segment="' + name + '"]');
        if (!s) return null;
        var r = s.getBoundingClientRect();
        var cs = getComputedStyle(s);
        return {
          name: name, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
          children: bar.children.length, shown: isShown(s), background: cs.backgroundColor,
          backgroundRgba: rgbaOf(cs.backgroundColor), image: cs.backgroundImage
        };
      })
    };
  }
  return out;
}`

/**
 * arg: an array of steps { set?: scenario }. Applies each step in order and returns
 * the snapshot after it. Every step reads in the same turn as its own change, with
 * the animations that change started already finished.
 */
export const RUN_STEPS = String.raw`(steps) => {
  ${APPLY_STATE}
  ${SNAPSHOT}
  return steps.map(function (step) {
    var missing = step.set ? applyState(step.set) : [];
    finishAll();
    var snap = snapshot();
    snap.applyMissing = missing;
    return snap;
  });
}`

/** arg: none. The current snapshot, without changing anything. */
export const READ_STATE = String.raw`() => {
  ${SNAPSHOT}
  return snapshot();
}`

/** arg: { set }. Applies one scenario, returns the snapshot. Used by the contrast check. */
export const APPLY_AND_READ = String.raw`(step) => {
  ${APPLY_STATE}
  ${SNAPSHOT}
  var missing = step.set ? applyState(step.set) : [];
  finishAll();
  var snap = snapshot();
  snap.applyMissing = missing;
  return snap;
}`

/** arg: CSS selector. Clicks an element in the page (a stepper) and returns its value afterwards. */
export const CLICK_AND_READ_SEATS = String.raw`(selector) => {
  ${IS_SHOWN}
  var e = document.querySelector(selector);
  if (!e) return { clicked: false, value: null };
  if (e.disabled) return { clicked: false, value: document.getElementById('seats').value };
  e.click();
  finishAll();
  return { clicked: true, value: document.getElementById('seats').value };
}`

/** arg: CSS selector. Focuses an element from script and reports whether focus landed. */
export const FOCUS_SELECTOR = String.raw`(selector) => {
  var e = document.querySelector(selector);
  if (!e) return false;
  e.focus();
  return document.activeElement === e;
}`

/** arg: none. The seats text, as the page holds it. */
export const READ_SEATS_VALUE = String.raw`() => document.getElementById('seats').value`

/**
 * arg: { controls: [selector...], cards: selector, breakdown: selector }. Used at
 * each viewport width: scrolls each control into view instantly, then reads its box
 * and the element at its centre. A visually hidden radio is measured through its
 * label, which is what the user sees and clicks.
 */
export const RESPONSIVE_READ = String.raw`(arg) => {
  ${IS_SHOWN}
  function owns(e, hit) {
    var labels = e.labels ? Array.prototype.slice.call(e.labels) : [];
    var wrap = e.closest ? e.closest('label') : null;
    if (wrap) labels.push(wrap);
    return labels.some(function (l) { return l === hit || l.contains(hit); });
  }
  var out = {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    controls: [],
    cards: [],
    breakdown: null
  };
  arg.controls.forEach(function (sel) {
    var e = document.querySelector(sel);
    if (!e) { out.controls.push({ sel: sel, missing: true }); return; }
    var target = e;
    if (e.type === 'radio' && !isShown(e) && labelOf(e)) target = labelOf(e);
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    var r = target.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var inside = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
    var hit = inside ? document.elementFromPoint(cx, cy) : null;
    var hitOk = !!hit && (hit === target || target.contains(hit) || e.contains(hit) || owns(e, hit));
    out.controls.push({
      sel: sel, missing: false, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      shown: isShown(target), hitOk: hitOk, hit: hit ? hit.tagName.toLowerCase() : null
    });
  });
  out.cards = Array.prototype.slice.call(document.querySelectorAll(arg.cards)).map(function (c) {
    var r = c.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  var bd = document.querySelector(arg.breakdown);
  if (bd) {
    var br = bd.getBoundingClientRect();
    out.breakdown = { left: br.left, right: br.right, width: br.width, shown: isShown(bd) };
  }
  return out;
}`

/** arg: none. The document-level facts the accessible-names check needs beyond role lookups. */
export const DOCUMENT_FACTS = String.raw`() => {
  var total = document.getElementById('total');
  var live = total ? total.closest('[aria-live]') : null;
  var main = document.querySelector('main');
  return {
    lang: document.documentElement.getAttribute('lang') || '',
    h1Count: document.querySelectorAll('h1').length,
    summaryInMain: !!(main && document.getElementById('summary') && main.contains(document.getElementById('summary'))),
    liveValue: live ? live.getAttribute('aria-live') : null,
    pressedCount: document.querySelectorAll('button[data-plan][aria-pressed="true"]').length
  };
}`

// ---------------------------------------------------------------------------
// Contract tab walk
// ---------------------------------------------------------------------------

const TAB_LIST = String.raw`var TAB_SELECTOR = 'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"]';
function tabbables() {
  return Array.prototype.slice.call(document.querySelectorAll(TAB_SELECTOR)).filter(function (el) {
    if (el.id === '__bench_tab_start') return false;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) < 0) return false;
    if (el.disabled || el.type === 'hidden') return false;
    if (el.closest && el.closest(':disabled')) return false;
    return shownOrLabel(el) && el.getClientRects().length > 0;
  });
}
function identityOf(el) {
  if (el.tagName === 'BUTTON' && el.getAttribute('data-plan')) return el.getAttribute('data-plan');
  return el.id || ('<' + el.tagName.toLowerCase() + '>');
}
/** The colour behind an element's outside edge: the nearest ancestor with a painted background. */
function effOpacity(el) {
  var o = 1;
  for (var e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
  return isFinite(o) ? o : 1;
}
/** One painted layer as [r, g, b, a]: the element's background, its alpha times its effective opacity. */
function layerOf(e) {
  var c = rgbaOf(getComputedStyle(e).backgroundColor) || [0, 0, 0, 0];
  return [c[0], c[1], c[2], c[3] * effOpacity(e)];
}
${PAGE_CANVAS}
/**
 * Every ancestor's layer, nearest first, up to and including html, then the page canvas
 * (opaque, resolved from the root background or the used Canvas colour). The compositing
 * happens in checks.ts, down from the canvas.
 */
function backdropOf(el) {
  var out = [];
  for (var p = el.parentElement; p; p = p.parentElement) out.push(layerOf(p));
  out.push(pageCanvas(rgbaOf));
  return out;
}
function paintOf(el) {
  var cs = getComputedStyle(el);
  var op = effOpacity(el);
  var outline = rgbaOf(cs.outlineColor), bg = rgbaOf(cs.backgroundColor);
  return {
    outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow, borderColor: cs.borderTopColor, backgroundColor: cs.backgroundColor,
    backdrop: backdropOf(el),
    outlineRgba: outline ? [outline[0], outline[1], outline[2], outline[3] * op] : null,
    backgroundRgba: bg ? [bg[0], bg[1], bg[2], bg[3] * op] : null
  };
}
function styleOf(el) {
  var label = el.type === 'radio' ? labelOf(el) : null;
  return { own: paintOf(el), label: label ? paintOf(label) : null };
}
`

const TAB_SNAPSHOT = String.raw`() => {
  ${IS_SHOWN}
  ${TAB_LIST}
  finishAll();
  return tabbables().map(function (el, i) {
    var s = styleOf(el);
    return { index: i, identity: identityOf(el), style: s.own, label: s.label };
  });
}`

const TAB_ACTIVE = String.raw`() => {
  ${IS_SHOWN}
  ${TAB_LIST}
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { active: false };
  finishAll();
  var s = styleOf(el);
  return { active: true, index: tabbables().indexOf(el), identity: identityOf(el), style: s.own, label: s.label };
}`

export type Rgba4 = [number, number, number, number]

export interface FocusStyle {
  outlineStyle: string
  outlineWidth: string
  outlineColor: string
  outlineOffset: string
  boxShadow: string
  borderColor: string
  backgroundColor: string
  /**
   * The ancestors' painted layers, nearest first, each [r, g, b, a] with alpha times
   * opacity, then the page canvas as the last (opaque) layer. checks.ts composites them
   * down from the canvas to get the colour outside the control.
   */
  backdrop: Rgba4[]
  /** Resolved colours with alpha times the element's opacity; null where the page could not resolve one. */
  outlineRgba: Rgba4 | null
  backgroundRgba: Rgba4 | null
}

export interface TabStop {
  index: number
  identity: string
  style: FocusStyle
  /** A radio's label, which carries the focus ring when the radio itself is hidden. */
  label: FocusStyle | null
}

export interface ContractTabWalk {
  visits: TabStop[]
  unfocusedAfter: TabStop[]
  ended: 'left-page' | 'cycled' | 'limit'
}

/**
 * Press Tab from the top of the document up to maxPresses times with real key
 * events. Records each stop's contract identity (plan button, else id) and its
 * focused styles, then the unfocused styles after focus has left the page.
 */
export async function tabWalkContract(page: Page, maxPresses: number): Promise<ContractTabWalk> {
  await probe(page, TAB_START, undefined, ACTION_MS)
  const visits: TabStop[] = []
  let ended: ContractTabWalk['ended'] = 'limit'
  try {
    for (let press = 0; press < maxPresses; press++) {
      await bounded(page.keyboard.press('Tab'), ACTION_MS, 'Tab press')
      const state = await probe<{ active: boolean; index?: number; identity?: string; style?: FocusStyle; label?: FocusStyle | null }>(
        page,
        TAB_ACTIVE,
        undefined,
        ACTION_MS
      )
      if (!state.active) {
        ended = 'left-page'
        break
      }
      const index = state.index ?? -1
      if (visits.length > 0 && index === visits[0]!.index) {
        ended = 'cycled'
        break
      }
      visits.push({ index, identity: state.identity ?? '', style: state.style!, label: state.label ?? null })
    }
  } finally {
    await probe(page, TAB_BLUR_AND_CLEAN, undefined, ACTION_MS).catch(() => undefined)
  }
  const unfocusedAfter = await probe<TabStop[]>(page, TAB_SNAPSHOT, undefined, ACTION_MS)
  return { visits, unfocusedAfter, ended }
}
