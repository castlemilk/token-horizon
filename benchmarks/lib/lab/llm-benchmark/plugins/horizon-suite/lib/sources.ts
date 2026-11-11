/**
 * In-page source strings: plain JavaScript that runs INSIDE the artifact page
 * through probe(page, SOURCE, arg). Each is a single arrow function written as a
 * string, so nothing is compiled by tsx and no helper is captured (postmortem
 * 0008). They are deliberately self-contained: the colour parser, visibility test
 * and tab-order list are repeated inside the strings, because a page cannot import
 * math.ts. lib/math.test.ts and kit.browser.test.ts pin their behaviour against the
 * Node implementations.
 *
 * Rules for editing these: no backticks and no template placeholders inside the
 * in-page code; every helper a source uses is defined inside that source.
 */

/** A CSS colour string to [r, g, b, a] (0..255, alpha 0..1), or null if unknown. */
const PARSE_COLOUR = String.raw`function parseColour(input) {
  var s = String(input).trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  var m = /^(rgba?|color)\((.*)\)$/.exec(s);
  if (!m) return null;
  var isColor = m[1] === 'color';
  var body = m[2].trim();
  if (isColor) {
    var sp = /^srgb\s+/.exec(body);
    if (!sp) return null;
    body = body.slice(sp[0].length);
  }
  var main = body;
  var alphaTok = null;
  if (body.indexOf('/') >= 0) {
    var halves = body.split('/');
    main = halves[0].trim();
    alphaTok = halves[1].trim();
  }
  var parts = main.indexOf(',') >= 0 ? main.split(',') : main.trim().split(/\s+/);
  if (alphaTok === null && parts.length === 4) {
    alphaTok = parts[3];
    parts = parts.slice(0, 3);
  }
  if (parts.length !== 3) return null;
  var ch = parts.map(function (t) {
    t = t.trim();
    if (t.charAt(t.length - 1) === '%') return parseFloat(t) / 100 * 255;
    var v = parseFloat(t);
    return isColor ? v * 255 : v;
  });
  var a = 1;
  if (alphaTok !== null) {
    a = alphaTok.charAt(alphaTok.length - 1) === '%' ? parseFloat(alphaTok) / 100 : parseFloat(alphaTok);
  }
  if (!isFinite(ch[0]) || !isFinite(ch[1]) || !isFinite(ch[2]) || !isFinite(a)) return null;
  function clamp255(v) { return Math.min(255, Math.max(0, v)); }
  return [clamp255(ch[0]), clamp255(ch[1]), clamp255(ch[2]), Math.min(1, Math.max(0, a))];
}`

/** Source-over composite, both RGBA. */
const OVER = String.raw`function over(top, bottom) {
  var ta = top[3], ba = bottom[3], oa = ta + ba * (1 - ta);
  if (oa === 0) return [0, 0, 0, 0];
  var out = [0, 0, 0, oa];
  for (var i = 0; i < 3; i++) out[i] = (top[i] * ta + bottom[i] * ba * (1 - ta)) / oa;
  return out;
}`

/** WCAG 2 contrast ratio between two opaque RGBA colours. */
const RATIO = String.raw`function lumOf(c) {
  function lin(v) { var s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function ratioOf(a, b) {
  var la = lumOf(a), lb = lumOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}`

/** Product of opacity over the element and its ancestors. */
const EFF_OPACITY = String.raw`function effOpacity(el) {
  var o = 1;
  for (var e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
  return isFinite(o) ? o : 1;
}`

/** Display and visibility test (the element's own state and its ancestors'). */
const IS_SHOWN = String.raw`function isShown(el) {
  if (typeof el.checkVisibility === 'function') {
    try {
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    } catch (e) { /* older engines: fall through to the computed-style test */ }
  }
  var cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
}
function describeEl(el) {
  var s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/)[0];
  return s;
}`

/** Tab-order list and identity, shared by the tab sources. */
const TAB_LIST = String.raw`var TAB_SELECTOR = 'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"]';
function tabbables() {
  return Array.prototype.slice.call(document.querySelectorAll(TAB_SELECTOR)).filter(function (el) {
    if (el.id === '__bench_tab_start') return false;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) < 0) return false;
    if (el.disabled || el.type === 'hidden') return false;
    if (el.closest && el.closest(':disabled')) return false;
    return isShown(el) && el.getClientRects().length > 0;
  });
}
function identityOf(el) {
  return el.getAttribute('data-plan') || el.id || el.getAttribute('data-action') || el.getAttribute('data-testid') ||
    el.getAttribute('aria-label') || (el.tagName.toLowerCase() + ':' + (el.textContent || '').trim().slice(0, 40));
}
function styleOf(el) {
  var cs = getComputedStyle(el);
  return {
    outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow, borderColor: cs.borderTopColor, backgroundColor: cs.backgroundColor, color: cs.color
  };
}
function describeTab(el, index) {
  var data = {};
  for (var i = 0; i < el.attributes.length; i++) {
    var at = el.attributes[i];
    if (at.name.indexOf('data-') === 0) data[at.name.slice(5)] = at.value;
  }
  return {
    index: index, identity: identityOf(el), style: styleOf(el), id: el.id || '',
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', dataset: data
  };
}`

/**
 * arg: { selector?: string } (default 'canvas'), optional rects: [[x, y, w, h], ...]
 * and points: [[x, y], ...] in BACKING-STORE pixels (canvas.width x canvas.height).
 * Returns { ok: false, detail } when the element is missing, not a canvas, has
 * no 2d context (for example a WebGL canvas) or is tainted. Otherwise returns
 * { ok: true, width, height, modal: [r,g,b,a], means: [[r,g,b,a], ...] for each
 * rect, points: [[r,g,b,a] | null, ...] }. Use getImageData only, never
 * captureCanvas (it returns PNG bytes).
 */
export const CANVAS_READ = String.raw`(arg) => {
  var selector = (arg && arg.selector) || 'canvas';
  var el = document.querySelector(selector);
  if (!el) return { ok: false, detail: 'no element for ' + selector };
  if (!(el instanceof HTMLCanvasElement)) return { ok: false, detail: selector + ' is not a canvas' };
  var ctx = null;
  try { ctx = el.getContext('2d'); } catch (e) { return { ok: false, detail: 'getContext threw ' + e.name }; }
  if (!ctx) return { ok: false, detail: selector + ' has no 2d context (null): it is not a 2d canvas' };
  var w = el.width, h = el.height;
  var img;
  try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return { ok: false, detail: 'getImageData threw ' + e.name + ': ' + e.message }; }
  var d = img.data;
  // Pixel (x, y) starts at byte (y * w + x) * 4. Coordinates are floored so every read is
  // whole-pixel: a fractional index would read bytes from the middle of a pixel.
  function at(x, y) { var i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
  var counts = new Map();
  var bestKey = -1, bestN = 0;
  for (var i = 0; i < d.length; i += 4) {
    var key = ((d[i] * 256 + d[i + 1]) * 256 + d[i + 2]) * 256 + d[i + 3];
    var n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestN) { bestN = n; bestKey = key; }
  }
  var modal = bestKey < 0 ? [0, 0, 0, 0] : [Math.floor(bestKey / 16777216) % 256, Math.floor(bestKey / 65536) % 256, Math.floor(bestKey / 256) % 256, bestKey % 256];
  var means = (arg && arg.rects || []).map(function (r) {
    // Pixels whose top-left corner lies in [x, x + w) x [y, y + h): from ceil(x) up to ceil(x + w).
    var x0 = Math.max(0, Math.ceil(r[0])), y0 = Math.max(0, Math.ceil(r[1]));
    var x1 = Math.min(w, Math.ceil(r[0] + r[2])), y1 = Math.min(h, Math.ceil(r[1] + r[3]));
    var sum = [0, 0, 0, 0], count = 0;
    for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
      var p = at(x, y);
      for (var k = 0; k < 4; k++) sum[k] += p[k];
      count++;
    }
    return count === 0 ? null : sum.map(function (v) { return v / count; });
  });
  var points = (arg && arg.points || []).map(function (p) {
    var x = Math.floor(p[0]), y = Math.floor(p[1]);
    return x >= 0 && y >= 0 && x < w && y < h ? at(x, y) : null;
  });
  return { ok: true, width: w, height: h, modal: modal, means: means, points: points };
}`

/**
 * arg: { op, selector } where op is one of lineScreen, circleScreen,
 * polylineScreen, rectCorners, bboxCorners. Every op maps geometry through the
 * element's own getScreenCTM(), so SVG transform attributes, CSS transforms and
 * nested groups are all applied. Results are in viewport CSS pixels.
 *   lineScreen     <line>                 -> { ok, a: {x,y}, b: {x,y} }
 *   circleScreen   <circle>/<ellipse>     -> { ok, cx, cy, rx, ry } (screen radii)
 *   polylineScreen <polyline>/<polygon>   -> { ok, points: [{x,y}, ...] }
 *   rectCorners    <rect>                 -> { ok, corners: [tl, tr, br, bl] }
 *   bboxCorners    any rendered element   -> { ok, corners: [tl, tr, br, bl] } from getBBox()
 * Failures return { ok: false, detail }.
 */
export const SVG_GEOM = String.raw`(arg) => {
  var el = document.querySelector(arg.selector);
  if (!el) return { ok: false, detail: 'no element for ' + arg.selector };
  if (typeof el.getScreenCTM !== 'function') return { ok: false, detail: arg.selector + ' is not an SVG element' };
  if (el.closest && el.closest('defs, clipPath, mask, pattern, marker, symbol')) {
    return { ok: false, detail: arg.selector + ' is inside defs or another non-rendered container' };
  }
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) {
    return { ok: false, detail: arg.selector + ' is not rendered (display or visibility)' };
  }
  for (var up = el; up && up.nodeType === 1; up = up.parentElement) {
    if (getComputedStyle(up).display === 'none') return { ok: false, detail: arg.selector + ' is not rendered (display none)' };
  }
  var m = el.getScreenCTM();
  if (!m) return { ok: false, detail: arg.selector + ' has no screen matrix (not rendered)' };
  function T(x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }
  // A geometry property: the computed value (it follows CSS and attributes alike) when it is
  // a plain length, else the attribute's base value. NaN when neither gives a number.
  function num(name) {
    var cs = getComputedStyle(el)[name];
    if (cs && !/%$/.test(cs) && isFinite(parseFloat(cs))) return parseFloat(cs);
    var attr = el[name];
    return attr && attr.baseVal ? attr.baseVal.value : NaN;
  }
  function need(names) {
    for (var i = 0; i < names.length; i++) if (!isFinite(num(names[i]))) return names[i];
    return null;
  }
  function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
  var tag = el.tagName.toLowerCase();
  if (arg.op === 'lineScreen') {
    if (tag !== 'line') return { ok: false, detail: arg.selector + ' is not a line' };
    var missL = need(['x1', 'y1', 'x2', 'y2']);
    if (missL) return { ok: false, detail: arg.selector + ' has no numeric ' + missL };
    return { ok: true, a: T(num('x1'), num('y1')), b: T(num('x2'), num('y2')) };
  }
  if (arg.op === 'circleScreen') {
    if (tag !== 'circle' && tag !== 'ellipse') return { ok: false, detail: arg.selector + ' is not a circle or ellipse' };
    var missC = need(tag === 'circle' ? ['cx', 'cy', 'r'] : ['cx', 'cy', 'rx', 'ry']);
    if (missC) return { ok: false, detail: arg.selector + ' has no numeric ' + missC };
    var cx = num('cx'), cy = num('cy');
    var rx = tag === 'circle' ? num('r') : num('rx');
    var ry = tag === 'circle' ? num('r') : num('ry');
    var c = T(cx, cy);
    return { ok: true, cx: c.x, cy: c.y, rx: dist(c, T(cx + rx, cy)), ry: dist(c, T(cx, cy + ry)) };
  }
  if (arg.op === 'polylineScreen') {
    if (tag !== 'polyline' && tag !== 'polygon') return { ok: false, detail: arg.selector + ' is not a polyline or polygon' };
    var pts = [];
    for (var i = 0; i < el.points.numberOfItems; i++) {
      var pt = el.points.getItem(i);
      pts.push(T(pt.x, pt.y));
    }
    return { ok: true, points: pts };
  }
  if (arg.op === 'rectCorners') {
    if (tag !== 'rect') return { ok: false, detail: arg.selector + ' is not a rect' };
    var missR = need(['x', 'y', 'width', 'height']);
    if (missR) return { ok: false, detail: arg.selector + ' has no numeric ' + missR };
    var x = num('x'), y = num('y'), w = num('width'), h = num('height');
    return { ok: true, corners: [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)] };
  }
  if (arg.op === 'bboxCorners') {
    if (typeof el.getBBox !== 'function') return { ok: false, detail: arg.selector + ' has no getBBox' };
    var b = el.getBBox();
    return { ok: true, corners: [T(b.x, b.y), T(b.x + b.width, b.y), T(b.x + b.width, b.y + b.height), T(b.x, b.y + b.height)] };
  }
  return { ok: false, detail: 'unknown op ' + arg.op };
}`

/**
 * arg: { selector }. Every element matching the selector, each through its own
 * getScreenCTM (the selectorAll form of lineScreen). Returns { count, lines } where
 * each line is { ok, detail?, a, b, data } and data holds that element's data-*
 * attributes keyed without the prefix. An element that is not a rendered <line>, or
 * that sits under display:none, is reported with ok: false.
 */
export const LINE_SCREENS = String.raw`(arg) => {
  var els = document.querySelectorAll(arg.selector);
  function numOf(el, name) {
    var cs = getComputedStyle(el)[name];
    if (cs && !/%$/.test(cs) && isFinite(parseFloat(cs))) return parseFloat(cs);
    var attr = el[name];
    return attr && attr.baseVal ? attr.baseVal.value : NaN;
  }
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var data = {};
    for (var k = 0; k < el.attributes.length; k++) {
      var at = el.attributes[k];
      if (at.name.indexOf('data-') === 0) data[at.name.slice(5)] = at.value;
    }
    var hidden = false;
    for (var up = el; up && up.nodeType === 1; up = up.parentElement) {
      if (getComputedStyle(up).display === 'none') { hidden = true; break; }
    }
    var m = typeof el.getScreenCTM === 'function' ? el.getScreenCTM() : null;
    if (!m || hidden || el.tagName.toLowerCase() !== 'line') {
      out.push({ ok: false, detail: 'element ' + i + ' is not a rendered line', data: data });
      continue;
    }
    var x1 = numOf(el, 'x1'), y1 = numOf(el, 'y1'), x2 = numOf(el, 'x2'), y2 = numOf(el, 'y2');
    if (!isFinite(x1 + y1 + x2 + y2)) {
      out.push({ ok: false, detail: 'element ' + i + ' has no numeric endpoints', data: data });
      continue;
    }
    function T(x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }
    out.push({ ok: true, a: T(x1, y1), b: T(x2, y2), data: data });
  }
  return { count: els.length, lines: out };
}`

/**
 * arg: a CSS selector. Returns { visible, detail }. Visible means: not hidden by
 * display or visibility (checkVisibility), not at effective opacity 0, a non-zero
 * box, and a hit test that lands on the element, a descendant, or (for a form
 * control) its own label. Pointer-events:none on the element or an ancestor is
 * lifted for the test and restored in the same turn, so a visible HUD over a
 * canvas is seen. An SVG geometry element (a line, a circle, a path) is also hit
 * at a point on its own outline, so a zero-width vertical line and a hollow circle
 * are judged by what they draw. A decoy overlay or a hidden copy cannot answer.
 */
export const VISIBLE = String.raw`(selector) => {
  ${IS_SHOWN}
  ${EFF_OPACITY}
  function ownsByLabel(el, hit) {
    var owners = el.labels ? Array.prototype.slice.call(el.labels) : [];
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) owners.push(wrap);
    for (var i = 0; i < owners.length; i++) {
      if (owners[i] === hit || owners[i].contains(hit)) return true;
    }
    return false;
  }
  function shapePoint(el) {
    if (typeof SVGGeometryElement === 'undefined' || !(el instanceof SVGGeometryElement)) return null;
    if (typeof el.getTotalLength !== 'function') return null;
    var m = el.getScreenCTM();
    var len = el.getTotalLength();
    if (!m || !(len > 0)) return null;
    var p = el.getPointAtLength(len / 2);
    return [m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f];
  }
  function hitResult(el) {
    var r = el.getBoundingClientRect();
    var boxed = r.width > 0 && r.height > 0;
    var cands = [];
    if (boxed) cands.push([r.left + r.width / 2, r.top + r.height / 2]);
    var sp = shapePoint(el);
    if (sp) {
      cands.push(sp);
      if (!boxed) cands.push([sp[0] + 1, sp[1]], [sp[0] - 1, sp[1]], [sp[0], sp[1] + 1], [sp[0], sp[1] - 1]);
    }
    if (cands.length === 0) return { visible: false, detail: 'zero-size box' };
    var lastHit = null;
    var outside = false;
    for (var i = 0; i < cands.length; i++) {
      var x = cands[i][0], y = cands[i][1];
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { outside = true; continue; }
      var hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      lastHit = hit;
      if (hit === el || el.contains(hit)) return { visible: true, detail: 'ok' };
      if (ownsByLabel(el, hit)) return { visible: true, detail: 'ok (own label)' };
    }
    if (lastHit) return { visible: false, detail: 'covered by ' + describeEl(lastHit) };
    return { visible: false, detail: outside ? 'centre outside the viewport' : 'no element at centre' };
  }
  var el = document.querySelector(selector);
  if (!el) return { visible: false, detail: 'missing ' + selector };
  if (!isShown(el)) return { visible: false, detail: 'hidden by display or visibility' };
  if (effOpacity(el) === 0) return { visible: false, detail: 'opacity 0' };
  var forced = [];
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (getComputedStyle(n).pointerEvents === 'none') {
      forced.push({ node: n, value: n.style.getPropertyValue('pointer-events'), priority: n.style.getPropertyPriority('pointer-events') });
      n.style.setProperty('pointer-events', 'auto', 'important');
    }
  }
  try {
    return hitResult(el);
  } finally {
    for (var f = forced.length - 1; f >= 0; f--) {
      var saved = forced[f];
      if (saved.value) saved.node.style.setProperty('pointer-events', saved.value, saved.priority);
      else saved.node.style.removeProperty('pointer-events');
    }
  }
}`

/**
 * arg: none. Audits text contrast in the current state and scrolls each off-screen
 * candidate into view (the window scroll position is restored at the end).
 *
 * Candidates: every shown element with a direct non-blank text node, plus input,
 * select, button and textarea. Skipped: disabled controls and their descendants,
 * options, boxes under 2 x 2 px, text-less inputs (radio, checkbox, range, color,
 * file, image, hidden) and elements at effective opacity 0. Text outside the
 * viewport is scrolled into view; a candidate still outside after that is counted
 * in offscreen.
 *
 * Foreground: the computed colour (fill for SVG text), alpha times the fill opacity
 * and the opacity of the element and its ancestors. A colour the regex parser cannot
 * read (oklch, color-mix, a named system colour) is read back through a 1 x 1
 * canvas. Background: the layers at the centre of the text's first client rect,
 * from elementsFromPoint, merged with the element's own ancestor chain (so a
 * pointer-events:none badge keeps its own background), composited bottom to top
 * from white. A background-image with no opaque colour above it fails. Required
 * ratio is 4.5, or 3 for large text (24px, or 18.66px and weight 700 or more).
 *
 * Returns { ok, checked, offscreen, failCount, failing, failingAll, lowest }:
 *  - failing is the first failing row (or null); failingAll lists every failing row.
 *  - ok is true when no checked row fails. It does NOT mean anything was checked: a
 *    check must also require checked > 0, or an empty page passes.
 *  - lowest holds the three lowest ratios, ascending.
 */
export const CONTRAST_AUDIT = String.raw`() => {
  ${PARSE_COLOUR}
  ${OVER}
  ${RATIO}
  ${EFF_OPACITY}
  ${IS_SHOWN}
  var CANVAS = document.createElement('canvas');
  CANVAS.width = 1; CANVAS.height = 1;
  var CANVAS_CTX = CANVAS.getContext('2d', { willReadFrequently: true });
  // A computed colour parseColour cannot read: read it back through a 1 x 1 canvas.
  // Computed styles are always valid colours, so the read is only used for those.
  function resolveColour(input) {
    var c = parseColour(input);
    if (c) return c;
    if (!CANVAS_CTX) return null;
    try {
      CANVAS_CTX.clearRect(0, 0, 1, 1);
      CANVAS_CTX.fillStyle = '#000000';
      CANVAS_CTX.fillStyle = input;
      CANVAS_CTX.fillRect(0, 0, 1, 1);
      var d = CANVAS_CTX.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch (e) { return null; }
  }
  // The element's layers top to bottom: the hit stack, with el and its ancestors
  // inserted where they paint when elementsFromPoint leaves them out.
  function mergeLayers(stack, chain) {
    var out = stack.slice();
    for (var i = 0; i < chain.length; i++) {
      var e = chain[i];
      if (out.indexOf(e) >= 0) continue;
      var at = -1;
      for (var j = 0; j < out.length && at < 0; j++) if (out[j] !== e && out[j].contains(e)) at = j;
      if (at < 0) out.push(e); else out.splice(at, 0, e);
    }
    return out;
  }
  function measureOf(el, textNode) {
    if (!textNode) return el.getBoundingClientRect();
    var range = document.createRange();
    range.selectNodeContents(textNode);
    return range.getClientRects()[0] || null;
  }
  function inView(r) {
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  }
  var SKIP_INPUT = /^(radio|checkbox|range|color|file|image|hidden)$/i;
  var COLOUR_FILTER = /(brightness|contrast|invert|sepia|saturate|hue-rotate|grayscale|opacity)\(/;
  var COLOUR_IN_IMAGE = /rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;
  // The readable colour stops of a background image (gradient or otherwise), as RGBA.
  function imageColours(image) {
    var found = image.match(COLOUR_IN_IMAGE) || [];
    var out = [];
    for (var i = 0; i < found.length; i++) { var c = resolveColour(found[i]); if (c) out.push(c); }
    return out;
  }
  var startX = window.scrollX, startY = window.scrollY;
  var rows = [];
  var offscreen = 0;
  var all = document.body ? document.body.querySelectorAll('*') : [];
  for (var n = 0; n < all.length; n++) {
    var el = all[n];
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'OPTION') continue;
    if (el.closest && el.closest('option')) continue;
    if (tag === 'INPUT' && SKIP_INPUT.test(el.type || '')) continue;
    var textNode = null;
    for (var c = 0; c < el.childNodes.length; c++) {
      var node = el.childNodes[c];
      if (node.nodeType === 3 && node.textContent.trim() !== '') { textNode = node; break; }
    }
    var control = /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(tag);
    if (!textNode && !control) continue;
    if (el.matches(':disabled') || (el.closest && el.closest(':disabled'))) continue;
    if (!isShown(el)) continue;
    if (effOpacity(el) === 0) continue;
    var box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    var target = measureOf(el, textNode);
    if (!target || target.width <= 0 || target.height <= 0) continue;
    if (!inView(target)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      target = measureOf(el, textNode);
      if (!target || !inView(target)) { offscreen++; continue; }
    }
    var cx = target.left + target.width / 2, cy = target.top + target.height / 2;
    var cs = getComputedStyle(el);
    var isSvg = typeof SVGElement !== 'undefined' && el instanceof SVGElement && !(el instanceof HTMLElement);
    // Text is painted in -webkit-text-fill-color (it overrides color when set). With
    // background-clip:text the glyphs are the background image, so the colours are its stops.
    var clipped = !isSvg && cs.backgroundImage !== 'none' && (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text');
    var fgRaw = isSvg ? cs.fill : (cs.webkitTextFillColor || cs.color);
    var fg = fgRaw === 'none' ? null : resolveColour(fgRaw);
    if (fg && isSvg) fg = [fg[0], fg[1], fg[2], fg[3] * parseFloat(cs.fillOpacity || '1')];
    var stops = clipped ? imageColours(cs.backgroundImage) : null;
    var text = textNode ? textNode.textContent.trim() : (el.value || el.textContent || tag.toLowerCase()).toString().trim();
    var fontSize = parseFloat(cs.fontSize);
    var weight = parseInt(cs.fontWeight, 10);
    var large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
    var required = large ? 3 : 4.5;
    var row = { tag: tag.toLowerCase(), id: el.id || '', text: text.slice(0, 40), ratio: null, required: required, fontSize: fontSize, weight: weight, failure: null };
    rows.push(row);
    if (fgRaw === 'none') { row.failure = 'SVG text has fill none'; continue; }
    if (stops !== null && stops.length === 0) { row.failure = 'text clipped to a background image with no readable colour stop'; continue; }
    if (stops === null && !fg) { row.failure = 'unparseable text colour ' + fgRaw; continue; }
    var chain = [];
    for (var up = el; up && up.nodeType === 1; up = up.parentElement) chain.push(up);
    // A colour filter on the text or an ancestor changes what is painted, and the styles do not show it.
    var filtered = null;
    for (var f = 0; f < chain.length && !filtered; f++) {
      var fl = getComputedStyle(chain[f]).filter;
      if (fl && fl !== 'none' && COLOUR_FILTER.test(fl)) filtered = fl;
    }
    if (filtered) { row.failure = 'colour filter ' + filtered.slice(0, 40) + ' on the text or an ancestor; contrast cannot be read from styles'; continue; }
    var layers = mergeLayers(document.elementsFromPoint(cx, cy) || [], chain);
    var built = [];
    var bad = null;
    for (var s = 0; s < layers.length; s++) {
      // The glyphs of a clipped text element are its own background: its layer is not a backdrop.
      if (clipped && layers[s] === el) continue;
      var scs = getComputedStyle(layers[s]);
      var bgRaw = scs.backgroundColor;
      var bg = resolveColour(bgRaw);
      if (!bg) { bad = 'unparseable background colour ' + bgRaw; break; }
      // A small no-repeat image on the text's own element over an opaque colour is an icon (a
      // select's chevron, say), not a backdrop behind the text. A cover image fills the box, so it is one.
      var icon = layers[s] === el && bg[3] >= 1 && /no-repeat/.test(scs.backgroundRepeat || '') && !/cover/.test(scs.backgroundSize || '');
      built.push({ bg: bg, alpha: bg[3] * effOpacity(layers[s]), image: scs.backgroundImage !== 'none' && !icon });
    }
    if (bad) { row.failure = bad; continue; }
    var opaqueSeen = false;
    for (var j = 0; j < built.length; j++) {
      if (built[j].image && !opaqueSeen) { row.failure = 'background-image under the text with no opaque colour above it'; break; }
      if (built[j].alpha >= 1) opaqueSeen = true;
    }
    var base = [255, 255, 255, 1];
    for (var k = built.length - 1; k >= 0; k--) {
      if (built[k].alpha > 0) base = over([built[k].bg[0], built[k].bg[1], built[k].bg[2], built[k].alpha], base);
    }
    if (stops !== null) {
      // The worst colour stop is what the glyphs can show least against.
      row.ratio = Math.min.apply(null, stops.map(function (st) {
        return ratioOf(over([st[0], st[1], st[2], st[3] * effOpacity(el)], base), base);
      }));
    } else {
      var textColour = over([fg[0], fg[1], fg[2], fg[3] * effOpacity(el)], base);
      row.ratio = ratioOf(textColour, base);
    }
  }
  window.scrollTo({ left: startX, top: startY, behavior: 'instant' });
  var failingAll = rows.filter(function (r) { return r.failure !== null || r.ratio < r.required; });
  var ranked = rows.filter(function (r) { return r.ratio !== null; }).sort(function (a, b) { return a.ratio - b.ratio; });
  function rounded(r) { return r === null ? null : Math.round(r.ratio * 100) / 100; }
  return {
    ok: failingAll.length === 0,
    checked: rows.length,
    offscreen: offscreen,
    failCount: failingAll.length,
    failing: failingAll.length ? failingAll[0] : null,
    failingAll: failingAll,
    lowest: ranked.slice(0, 3).map(function (r) { return { tag: r.tag, id: r.id, text: r.text, ratio: rounded(r), required: r.required }; })
  };
}`

/**
 * arg: none. Describes the focused element: { active, index, identity, style, id,
 * tag, type, dataset } where index is its position in the tab-order list (-1 if it
 * is not in it) and dataset holds its data-* attributes keyed without the prefix.
 */
export const TAB_STATE = String.raw`() => {
  ${IS_SHOWN}
  ${TAB_LIST}
  var el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { active: false };
  return Object.assign({ active: true }, describeTab(el, tabbables().indexOf(el)));
}`

/** arg: none. Snapshot of every tab stop, in order (see TAB_STATE for the fields). */
export const TAB_SNAPSHOT = String.raw`() => {
  ${IS_SHOWN}
  ${TAB_LIST}
  return tabbables().map(function (el, i) { return describeTab(el, i); });
}`

/**
 * arg: none. Inserts a focusable sentinel at the top of the body and focuses it.
 * It carries tabindex 1, the first positive tab index in document order, so the
 * first Tab reaches the same stops a keyboard user reaches from the top of the page:
 * positive tab indices first, then the rest in document order.
 */
export const TAB_START = String.raw`() => {
  var old = document.getElementById('__bench_tab_start');
  if (old) old.remove();
  var s = document.createElement('span');
  s.id = '__bench_tab_start';
  s.setAttribute('tabindex', '1');
  s.setAttribute('aria-hidden', 'true');
  s.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.insertBefore(s, document.body.firstChild);
  s.focus();
  return document.activeElement === s;
}`

/** arg: none. Blurs the focused element and removes the sentinel. */
export const TAB_BLUR_AND_CLEAN = String.raw`() => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  var s = document.getElementById('__bench_tab_start');
  if (s) s.remove();
  return true;
}`
