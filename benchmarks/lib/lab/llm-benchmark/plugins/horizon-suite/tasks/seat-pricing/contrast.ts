/**
 * seat-pricing's text-contrast audit, measured on paint.
 *
 * The audit does not read the stack from CSS alone. It takes the page as drawn and measures what the reader
 * sees, one scroll stop at a time. The declared colour is used only where the picture confirms it.
 *
 * 1. Candidates: every visible element with its own non-whitespace text (its direct text nodes), plus the displayed
 *    value of an input or textarea and the selected option of a select. Visibility, opacity, size and disabled rules
 *    are the shared audit's own. Text shadows are removed from every picture: a shadow is decoration, not the colour
 *    of the text. A candidate whose own fill is transparent is drawn by its shadows (an outline), so its shadows stay.
 *    Separators (a middle dot, a bar, a slash) that are decoration are not measured: a separator is decorative when it
 *    is aria-hidden or is not inside a control (a button, a link, a tab, a field). Other punctuation is measured.
 *
 * 2. Pieces. A candidate's text is measured per piece: each piece is one of its text boxes (a line of its Range rects,
 *    or the content box of a control), cut to the boxes that clip it (overflow other than visible, contain: paint, a
 *    clip-path, the legacy clip property on an absolutely positioned box, content-visibility: hidden). A piece cut to
 *    nothing, or lying wholly outside the viewport at its own stop, is not painted there. A candidate is skipped when
 *    none of its pieces is painted at its own stop (text parked off screen, a skip link, a collapsed accordion).
 *    A piece is measured at a stop only when it lies wholly inside the viewport (the picture is clipped to the viewport,
 *    so a line half below the fold would be read as missing). A candidate taller than the viewport therefore takes
 *    several stops: each stop centres its first unmeasured piece, and every piece wholly in view at that stop is measured.
 *
 * 3. Pictures of each stop (the viewport, after scrolling the candidate's next piece into view). Motion is frozen first
 *    (the kit's freezeMotion), and each picture waits two frames and a macrotask, so a backdrop-filter layer has repainted.
 *    A: the page as drawn (text shadows removed).
 *    B: every candidate's text made invisible: colour, -webkit-text-fill-color, -webkit-text-stroke-color and caret
 *       transparent (and for SVG text, fill and stroke transparent). Every background-clip:text element that paints a
 *       glyph (the candidate itself, or an ancestor whose gradient the candidate's text inherits) loses its background,
 *       because that background is glyph paint. B holds the backdrop.
 *    E and F, only on a stop where some pending piece is covered or special (step 5): the page with every background,
 *       border image, box shadow and mask removed, every image, canvas, video, iframe, embed and SVG (outside a
 *       candidate) hidden, on a mid-grey canvas, and every candidate's text forced to black (E) and then to white (F).
 *       A pixel that differs between E and F is a glyph pixel whatever is behind or over it, and an emoji keeps its own
 *       colour in both, so it is not a glyph pixel.
 *
 * 4. Glyph pixels. Each piece owns the pixels of its own box (grown by 1 px where no other piece owns them). A pixel in
 *    the boxes of two candidates belongs to neither, unless one is a control: the text beats the control's content box,
 *    so a label laid over a filled input is measured.
 *    The ink is the owned pixels that differ by more than GLYPH_DIFF channel levels between E and F (on a stop with E and
 *    F) or between A and B (on a stop without them). The visible glyph pixels are the ink pixels that also differ between
 *    A and B. Failures and skips, decided per candidate from the sums over its pieces:
 *     - punctuation or symbols only, with fewer than GLYPH_MIN visible or full-strength glyph pixels, or an emoji: skipped;
 *     - fewer than GLYPH_MIN visible glyph pixels, for text with a letter or digit: "text not painted" (under a cover);
 *     - on a stop with E and F: at least GLYPH_MIN solid glyph pixels (ink at least SOLID_STRENGTH of the strongest) and
 *       HIDDEN_SHARE of them not visible: "text partly covered".
 *
 * 5. Stops with E and F: a stop takes the stripped pair only when a pending piece is covered (a non-ancestor box, a
 *    replaced element, an ancestor's pseudo-element or a layer of its image, overlapping its text) or special (a
 *    background-clip:text glyph, a mask-image fade, an emoji). Those are the cases where A minus B can miss glyph pixels.
 *
 * 6. The colour and the ratio. Each piece's core is its ink at FULL_STRENGTH of its strongest ink (the glyph's solid part).
 *    Each core pixel has its own backdrop (B under that pixel). A core pixel where A equals B is ratio 1 (the text cannot
 *    be told from its backdrop there).
 *    Plain text (no cover, no special layer, no opacity, filter, blend or mask on its element or any ancestor, no stroke,
 *    not SVG, at least PLAIN_MIN_PX font size, with at least GLYPH_MIN solid pixels) takes its colour from CSS: the computed
 *    fill colour, composited over the backdrop. The picture is checked:
 *    each visible core pixel must lie on the line from its backdrop to that colour, within LINE_TOLERANCE levels per
 *    channel, for at least (1 - OFF_LINE_SHARE) of the core. A thin hairline weight therefore reads the colour the author
 *    set, not the lighter pixels its strokes leave, and a paint that does not match the CSS colour falls back to the
 *    measured colour. The measured colour is the per-channel median of A over the CORE_PIXELS strongest ink pixels.
 *    A piece's ratio is the mean of the worst WORST_SHARE of its core ratios (the worst quartile, averaged), and it is
 *    also the lowest mean over any window one em wide along the piece (so an unreadable word of a readable line fails).
 *    A candidate's ratio is the lowest of its piece ratios, of its worst quartile over all core pixels, and of its windows.
 *    The ratio must reach 4.5:1, or 3:1 for large text (computed size at least 24px, or 18.66px and bold).
 *
 * 7. A candidate whose text meets a fixed or sticky layer (a bottom bar) at a stop where it is not centred may be hidden
 *    or tinted by that layer there. A failing piece there is not taken: the piece is measured again at its own stop, where
 *    that result is final. Anywhere else a result at any stop is final.
 *
 * 8. Limits, recorded in the README: an animated mask fade (a mask-image on an element with an infinite animation, such
 *    as a logo marquee) is skipped, because its paint depends on the animation's time; a piece taller than the viewport
 *    inside a scroll box is measured only where its box shows it; placeholder text and generated ::before or ::after text
 *    are not measured.
 *
 * 9. Later states reuse results. A state that changes the page (an error) is audited only for candidates whose
 *    fingerprint (tag, id, text, colours, font, opacity, size and the background of the element and its three nearest
 *    ancestors) is new. The others keep their result from the default state, so the state still counts every candidate.
 *
 * Scope and report shape are the shared audit's: a candidate skipped as clipped, as off screen, as a decorative separator
 * or as an animated mask is counted as skipped; the result carries checked, failCount, failing, failingAll, the three
 * lowest ratios, every measured row, and the baseline for later states.
 *
 * Cost. One set of pictures serves every piece in the viewport at a stop, not one set per candidate: the check has a
 * 4.5 s deadline. The stripped pair is taken only at stops that need it (step 5).
 *
 * PAGE_CANVAS stays here: pricing-keyboard's focus check reads the canvas colour from it.
 */
import type { BrowserContext, Page } from 'playwright'
import { freezeMotion, probe } from '../../lib/probe'

/** Channel levels above which a pixel counts as painted text (see the header, step 4). */
export const GLYPH_DIFF = 2
/** Fewest glyph pixels a candidate may have and still count as painted. */
export const GLYPH_MIN = 8
/**
 * The strongest ink pixels of a piece that give its measured text colour. The colour is read from full-coverage
 * pixels only: a larger set takes in antialiased edge pixels, which pull the measured colour towards the backdrop.
 */
export const CORE_PIXELS = GLYPH_MIN
/** A glyph pixel at or above this share of the strongest ink (of its piece) is full strength, and in the core. */
export const FULL_STRENGTH = 0.5
/** The share of a piece's core ratios that is averaged as its ratio: 0.25 is the worst quartile. */
export const WORST_SHARE = 0.25
/** A glyph pixel at or above this share of the strongest ink is solid: a cover is measured on solid pixels only. */
export const SOLID_STRENGTH = 0.9
/** The share of solid glyph pixels that must be hidden (and at least GLYPH_MIN of them) for a cover to fail a candidate. */
export const HIDDEN_SHARE = 0.05
/** The share of a plain piece's visible core pixels that may lie off the line from backdrop to the CSS colour. */
export const OFF_LINE_SHARE = 0.1
/** How far, in channel levels, a core pixel may lie off that line and still match the CSS colour. */
export const LINE_TOLERANCE = 3
/**
 * The smallest font size (CSS px) whose text takes its colour from CSS. Below it the strokes are sub-pixel, and the
 * colour the reader sees is the diluted one, so the colour is measured from the picture (a stricter result, never a looser one).
 */
export const PLAIN_MIN_PX = 8

const ACTION_MS = 1500
const SHOT_MS = 1500
const SETUP_MS = 3000
const ANALYSE_MS = 6000
const STRIP_ID = '__seat_pricing_contrast_strip'
const HIDE_ATTR = 'data-seat-hide'
/** Controls: a separator inside one of these is text the user acts on, so it is measured. */
const CONTROL_SELECTOR =
  'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"]'

/**
 * The page canvas. Defined once so the focus probes and any other reader use the same colour.
 * Source of a function (parse) => [r, g, b, a] (0..255, alpha 0..1) or null. The probe element
 * reads the used Canvas colour; the root background (html, else body) replaces it when it is opaque.
 * A translucent root is composited over the Canvas colour by its own layer, so it is not added here.
 */
export const PAGE_CANVAS = String.raw`function pageCanvas(parse) {
  var probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;background-color:Canvas';
  var host = document.body || document.documentElement;
  host.appendChild(probe);
  var sys = parse(getComputedStyle(probe).backgroundColor);
  host.removeChild(probe);
  if (!sys) sys = [255, 255, 255, 1];
  var roots = [document.documentElement, document.body];
  for (var i = 0; i < roots.length; i++) {
    if (!roots[i]) continue;
    var c = parse(getComputedStyle(roots[i]).backgroundColor);
    if (c && c[3] > 0) return c[3] >= 1 ? c : sys;
  }
  return sys;
}`

/** One candidate as the page describes it (the report fields, plus the requirement and what the page says of it). */
export interface ContrastMeta {
  tag: string
  id: string
  text: string
  fontSize: number
  weight: number
  required: number
  /** The text has no letter or digit (a separator or symbol). */
  punct: boolean
  /** The text has an emoji (a colour glyph that the text colour does not reach). */
  emoji: boolean
  /** The candidate's fingerprint, for reusing its result in a later state. */
  fp: string
  /** The CSS fill colour [r, g, b, a], when the text is plain (see the header, step 6); else null. */
  plainFill: number[] | null
  /** The number of text boxes (pieces) the candidate has. */
  pieces: number
  /** Why the candidate is not measured: a decorative separator or an animated mask fade. Null when it is measured. */
  skip: 'decorative' | 'animated-mask' | null
}

/** One audited candidate. ratio is null when no ratio was taken (the text is not painted, or covered). */
export interface ContrastRow {
  tag: string
  id: string
  text: string
  ratio: number | null
  required: number
  failure: string | null
  /** The measured colours and pixel counts, for diagnostics. Null when no ratio was taken. */
  paint: { mode: 'stripped' | 'drawn'; text: number[]; back: number[]; ink: number; visible: number; core: number } | null
}

/**
 * Each candidate's result in the audit that produced it, keyed by its fingerprint and in document order
 * (null: skipped). A later state passes it on, so unchanged candidates keep their result.
 */
export interface ContrastBaseline {
  readonly entries: ReadonlyMap<string, ReadonlyArray<ContrastRow | null>>
}

export interface ContrastAudit {
  ok: boolean
  checked: number
  /** Candidates not measured: their text is clipped away, outside the viewport, decorative, or an animated mask. */
  skipped: number
  failCount: number
  failing: ContrastRow | null
  failingAll: ContrastRow[]
  lowest: ContrastRow[]
  /** Every measured candidate, in document order (for diagnostics and reports). */
  rows: ContrastRow[]
  /** The results of this audit, for a later state to reuse (see the header, step 9). */
  baseline: ContrastBaseline
}

/** The in-page helpers every page-side source below uses. Plain JavaScript, no closures over this module. */
const PRELUDE = String.raw`
  var SKIP_INPUT = /^(radio|checkbox|range|color|file|image|hidden)$/i;
  var CONTROL_SEL = ${JSON.stringify(CONTROL_SELECTOR)};
  function effOpacity(el) {
    var o = 1;
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return isFinite(o) ? o : 1;
  }
  function isShown(el) {
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
      } catch (e) { /* older engines: fall through to the computed-style test */ }
    }
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }
  function ownTextNodes(el) {
    var out = [];
    for (var c = 0; c < el.childNodes.length; c++) {
      var node = el.childNodes[c];
      if (node.nodeType === 3 && node.textContent.trim() !== '') out.push(node);
    }
    return out;
  }
  function labelOf(el, nodes) {
    var tag = el.tagName;
    if (tag === 'SELECT') {
      var opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return opt ? opt.text.trim() : '';
    }
    if (tag === 'TEXTAREA') return String(el.value || '').trim();
    if (tag === 'INPUT') return SKIP_INPUT.test(el.type || '') ? '' : String(el.value || '').trim();
    return nodes.map(function (n) { return n.textContent.trim(); }).join(' ');
  }
  // The alpha of a computed colour (rgb/rgba/transparent); 1 when it cannot be read.
  function alphaOf(c) {
    if (c === 'transparent') return 0;
    var m = /^rgba?\(([^)]*)\)$/.exec(c || '');
    if (!m) return 1;
    var parts = m[1].split(/[ ,\/]+/).filter(function (t) { return t !== ''; });
    if (parts.length < 4) return 1;
    var a = parseFloat(parts[3]);
    return isFinite(a) ? a : 1;
  }
  // A computed colour as [r, g, b, a], or null when it is not an rgb()/rgba() value.
  function parseRgba(c) {
    var m = /^rgba?\(([^)]*)\)$/.exec(c || '');
    if (!m) return null;
    var parts = m[1].split(/[ ,\/]+/).filter(function (t) { return t !== ''; });
    if (parts.length < 3) return null;
    var r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
    var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if (!isFinite(r) || !isFinite(g) || !isFinite(b) || !isFinite(a)) return null;
    return [r, g, b, a];
  }
  // A layer that can cover text: a background image, a border image, or an inset shadow (a fill under the content).
  function hasImage(cs) { return cs.backgroundImage !== 'none' || (!!cs.borderImageSource && cs.borderImageSource !== 'none') || /inset/.test(cs.boxShadow); }
  // A box that paints something of its own: a background colour or image, a border image, or an inset shadow.
  function paints(cs) {
    return alphaOf(cs.backgroundColor) > 0 || hasImage(cs);
  }
  // Whether one of the element's own pseudo-elements paints a box (an overlay or a decoration).
  function pseudoPaints(el) {
    var pseudos = ['::before', '::after'];
    for (var i = 0; i < pseudos.length; i++) {
      var cs = getComputedStyle(el, pseudos[i]);
      if (cs.content !== 'none' && cs.content !== 'normal' && paints(cs)) return true;
    }
    return false;
  }
  // A background that is clipped to the text: its paint is the glyphs of the element and its descendants.
  function bgClipText(cs) { return cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text'; }
  function hasMask(cs) { return (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none'); }
  // A backdrop filter (a blur, a tint) on a box: it changes what lies under the box, so a box over text covers that text.
  function hasBackdrop(cs) { return (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none'); }
  // Whether the element's own text can be read as the colour its CSS sets: no alpha multiplier (opacity, filter,
  // blend, mask) on it or on an ancestor, and no text stroke. Then the picture's text is the colour composited over the backdrop.
  function chainPlain(el) {
    for (var up = el; up && up.nodeType === 1; up = up.parentElement) {
      var u = getComputedStyle(up);
      if (parseFloat(u.opacity) !== 1) return false;
      if (u.mixBlendMode && u.mixBlendMode !== 'normal') return false;
      if (u.filter && u.filter !== 'none') return false;
      if (u.backdropFilter && u.backdropFilter !== 'none') return false;
      if (u.webkitBackdropFilter && u.webkitBackdropFilter !== 'none') return false;
      if (hasMask(u)) return false;
    }
    return parseFloat(getComputedStyle(el).webkitTextStrokeWidth) <= 0;
  }
  // A mask fade on the element or an ancestor, and an infinite animation on the element or an ancestor: the paint
  // depends on the time of the animation, so the candidate is not measured.
  function animatedMask(el) {
    var masked = false, animated = false;
    for (var up = el; up && up.nodeType === 1; up = up.parentElement) {
      var cs = getComputedStyle(up);
      if (hasMask(cs)) masked = true;
      if (cs.animationName !== 'none' && /infinite/.test(cs.animationIterationCount)) animated = true;
    }
    return masked && animated;
  }
  // Elements whose box is their own content, not a background: an image, a canvas, a video, a frame, an
  // embedded object, or an outermost SVG. Their pixels sit above or below the text like any other layer.
  function isReplaced(el) {
    var tn = String(el.tagName || '').toLowerCase();
    if (/^(img|picture|video|canvas|iframe|object|embed)$/.test(tn)) return true;
    if (tn === 'svg') return !(el.parentNode && el.parentNode.closest && el.parentNode.closest('svg'));
    return false;
  }
  // The boxes the candidate's text is painted in, in viewport CSS px: [x, y, w, h], one per piece (a line).
  // A control's text is painted in its content box; anything else in the Range rects of its own text.
  function regionRects(item) {
    var out = [];
    if (item.control) {
      var el = item.el, cs = getComputedStyle(el), r = el.getBoundingClientRect();
      var l = r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      var t = r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      var rt = r.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
      var b = r.bottom - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0);
      if (rt - l > 0 && b - t > 0) out.push([l, t, rt - l, b - t]);
      return out;
    }
    item.nodes.forEach(function (node) {
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) out.push([rects[i].left, rects[i].top, rects[i].width, rects[i].height]);
      }
    });
    return out;
  }
  // The clip of an inset(...) shape, in viewport px: [x0, y0, x1, y1]. Other shapes give the border box.
  function clipPathBox(value, r) {
    var whole = [r.left, r.top, r.right, r.bottom];
    var m = /^inset\((.+)\)$/.exec(value);
    if (!m) return whole;
    var toks = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    if (toks.length < 1 || toks.length > 4) return whole;
    function len(tok, size) {
      if (!/^-?(\d+\.?\d*|\.\d+)(px|%)?$/.test(tok)) return NaN;
      var n = parseFloat(tok);
      return /%$/.test(tok) ? n * size / 100 : n;
    }
    var T = toks[0], R = toks.length > 1 ? toks[1] : T, B = toks.length > 2 ? toks[2] : T, L = toks.length > 3 ? toks[3] : R;
    var top = len(T, r.height), right = len(R, r.width), bottom = len(B, r.height), left = len(L, r.width);
    if (isNaN(top) || isNaN(right) || isNaN(bottom) || isNaN(left)) return whole;
    return [r.left + left, r.top + top, r.right - right, r.bottom - bottom];
  }
  // The legacy clip value of an absolutely positioned box (rect(...)), or null.
  function legacyClip(cs) {
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return null;
    var c = cs.clip;
    if (!c || c === 'auto' || !/^rect\(/.test(c)) return null;
    return c;
  }
  // The legacy clip rect(top, right, bottom, left) in viewport px, for the box r; null when it cannot be read.
  function clipRectValue(value, r) {
    var m = /^rect\((.*)\)$/.exec(value);
    if (!m) return null;
    var toks = m[1].split(/[ ,]+/).filter(function (t) { return t !== ''; });
    if (toks.length !== 4) return null;
    function px(t, dflt) { if (t === 'auto') return dflt; var n = parseFloat(t); return isFinite(n) ? n : dflt; }
    var top = px(toks[0], 0), right = px(toks[1], r.width), bottom = px(toks[2], r.height), left = px(toks[3], 0);
    return [r.left + left, r.top + top, r.left + right, r.top + bottom];
  }
  // The clipping plan of an element: each ancestor (below the root) that clips its own text, with the style it clips by.
  // Computed once per audit (overflow, contain, clip-path, the legacy clip, borders and content-visibility do not change
  // while the audit paints), so a stop reads only the boxes. null when content-visibility hides the text.
  function clipPlan(el) {
    var out = [];
    for (var e = el; e && e.nodeType === 1 && e !== document.documentElement && e !== document.body; e = e.parentElement) {
      var cs = getComputedStyle(e);
      if (cs.contentVisibility === 'hidden') return null;
      var boxy = cs.display !== 'inline' && cs.display !== 'contents';
      if (boxy && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint/.test(cs.contain || ''))) {
        out.push({
          el: e, kind: 'box',
          bl: parseFloat(cs.borderLeftWidth) || 0, bt: parseFloat(cs.borderTopWidth) || 0,
          br: parseFloat(cs.borderRightWidth) || 0, bb: parseFloat(cs.borderBottomWidth) || 0
        });
      }
      if (cs.clipPath && cs.clipPath !== 'none') out.push({ el: e, kind: 'path', value: cs.clipPath });
      var lc = legacyClip(cs);
      if (lc) out.push({ el: e, kind: 'legacy', value: lc });
    }
    return out;
  }
  // The clip boxes of a plan, in viewport px, read now; null when the plan is null (the text is hidden).
  function clipBoxesOf(plan) {
    if (plan === null) return null;
    var out = [];
    plan.forEach(function (p) {
      var r = p.el.getBoundingClientRect();
      if (p.kind === 'box') out.push([r.left + p.bl, r.top + p.bt, r.right - p.br, r.bottom - p.bb]);
      else if (p.kind === 'path') out.push(clipPathBox(p.value, r));
      else {
        var lr = clipRectValue(p.value, r);
        if (lr) out.push(lr);
      }
    });
    return out;
  }
  // Cuts each [x, y, w, h] box to every clip box; boxes cut to nothing are dropped.
  function clipRects(rects, boxes) {
    var out = [];
    rects.forEach(function (rc) {
      var x0 = rc[0], y0 = rc[1], x1 = rc[0] + rc[2], y1 = rc[1] + rc[3];
      boxes.forEach(function (b) {
        x0 = Math.max(x0, b[0]); y0 = Math.max(y0, b[1]);
        x1 = Math.min(x1, b[2]); y1 = Math.min(y1, b[3]);
      });
      if (x1 > x0 && y1 > y0) out.push([x0, y0, x1 - x0, y1 - y0]);
    });
    return out;
  }
  function overlaps(r, g) { return r[0] < g[2] && r[0] + r[2] > g[0] && r[1] < g[3] && r[1] + r[3] > g[1]; }
`

/**
 * arg: none. Collects the candidates in document order, stores them on window for the later stops, and returns
 * their report fields and fingerprints. Then removes text shadows from every candidate that has its own fill
 * (inline, important), keeping each candidate's text-shadow for FINISH.
 */
const INIT_SOURCE = String.raw`() => {
  ${PRELUDE}
  var SEP = /^[\s|\/\\·•‧⋅∙–—]+$/;
  var all = document.body ? document.body.querySelectorAll('*') : [];
  var imageEls = [];
  var roots = [document.documentElement, document.body];
  for (var q = 0; q < roots.length; q++) {
    if (roots[q] && (hasImage(getComputedStyle(roots[q])) || hasImage(getComputedStyle(roots[q], '::before')) || hasImage(getComputedStyle(roots[q], '::after')))) imageEls.push(roots[q]);
  }
  for (var m = 0; m < all.length; m++) {
    var e = all[m];
    if (hasImage(getComputedStyle(e)) || hasImage(getComputedStyle(e, '::before')) || hasImage(getComputedStyle(e, '::after'))) imageEls.push(e);
  }
  // Every other layer that can cover text: a painted box, a replaced element, or an element with a painted pseudo-element.
  // pseudo marks the last kind, which covers the text of its own element and of its descendants.
  var coverEls = [];
  for (var c = 0; c < all.length; c++) {
    var ce = all[c];
    if (ce === document.documentElement || ce === document.body) continue;
    if (!isShown(ce) || effOpacity(ce) === 0) continue;
    var rep = isReplaced(ce), ccs = getComputedStyle(ce), pseudo = pseudoPaints(ce);
    if (rep || paints(ccs) || pseudo || hasBackdrop(ccs)) coverEls.push({ el: ce, pseudo: pseudo });
  }
  var items = [], metas = [], owners = [];
  for (var n = 0; n < all.length; n++) {
    var el = all[n], tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'OPTION') continue;
    if (el.closest && el.closest('option')) continue;
    if (tag === 'INPUT' && SKIP_INPUT.test(el.type || '')) continue;
    var nodes = ownTextNodes(el);
    var label = labelOf(el, nodes);
    if (label === '') continue;
    if (el.matches(':disabled') || (el.closest && el.closest(':disabled'))) continue;
    if (!isShown(el)) continue;
    if (effOpacity(el) === 0) continue;
    var box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    var cs = getComputedStyle(el);
    var isSvg = typeof SVGElement !== 'undefined' && el instanceof SVGElement && !(el instanceof HTMLElement);
    var fontSize = parseFloat(cs.fontSize) || 16;
    var weight = parseInt(cs.fontWeight, 10);
    var large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
    var clipped = !isSvg && bgClipText(cs);
    var emoji = /\p{Extended_Pictographic}/u.test(label);
    var masked = hasMask(cs);
    // The ancestors whose background is clipped to text (their gradient is this text's glyph paint).
    var own = [];
    for (var up = el.parentElement; up && up.nodeType === 1; up = up.parentElement) {
      var ucs = getComputedStyle(up);
      if (bgClipText(ucs) && (ucs.backgroundImage !== 'none' || alphaOf(ucs.backgroundColor) > 0)) {
        own.push(up);
        if (owners.indexOf(up) < 0) owners.push(up);
      }
    }
    var special = clipped || masked || emoji || own.length > 0;
    var fill = isSvg ? null : parseRgba(cs.webkitTextFillColor);
    var item = { el: el, nodes: nodes, svg: isSvg, clipped: clipped, emoji: emoji, control: tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA', special: special, owners: own, plan: clipPlan(el) };
    var plain = !isSvg && !special && fill !== null && fill[3] > 0 && chainPlain(el);
    var inControl = !!(el.closest && el.closest(CONTROL_SEL));
    var ariaHidden = !!(el.closest && el.closest('[aria-hidden="true"]'));
    var punct = !/[\p{L}\p{N}]/u.test(label);
    var decorative = SEP.test(label) && (ariaHidden || !inControl);
    var skip = decorative ? 'decorative' : (animatedMask(el) ? 'animated-mask' : null);
    var parts = [tag, el.id || '', label.slice(0, 80), cs.color, cs.webkitTextFillColor, cs.fontSize, cs.fontWeight, cs.opacity, cs.backgroundColor, cs.backgroundImage.slice(0, 60), String(Math.round(box.width)), String(Math.round(box.height))];
    for (var up2 = el.parentElement, k = 0; up2 && up2 !== document.body && k < 3; up2 = up2.parentElement, k++) parts.push(getComputedStyle(up2).backgroundColor);
    items.push(item);
    metas.push({
      tag: tag.toLowerCase(), id: el.id || '', text: label.slice(0, 40), fontSize: fontSize, weight: weight,
      required: large ? 3 : 4.5, punct: punct, emoji: emoji, fp: parts.join('|'),
      plainFill: plain ? fill : null, pieces: regionRects(item).length, skip: skip
    });
  }
  // The replaced elements that hold no candidate (an image, an SVG icon, a canvas): hidden in the stripped pair, so the
  // glyphs under them show. A candidate's own SVG text is kept.
  var hideEls = coverEls.filter(function (c) { return isReplaced(c.el) && !items.some(function (it) { return c.el.contains(it.el); }); }).map(function (c) { return c.el; });
  var fixedEls = [];
  for (var f = 0; f < all.length; f++) {
    var pos = getComputedStyle(all[f]).position;
    if (pos === 'fixed' || pos === 'sticky') fixedEls.push(all[f]);
  }
  // Every element whose style the paint changes: the candidates, and the background-clip ancestors of their text.
  var touched = [];
  items.forEach(function (it) { if (touched.indexOf(it.el) < 0) touched.push(it.el); });
  owners.forEach(function (o) { if (touched.indexOf(o) < 0) touched.push(o); });
  window.__seatPricingContrast = { items: items, saved: null, imageEls: imageEls, coverEls: coverEls, hide: hideEls, fixedEls: fixedEls, shadows: null, owners: owners, touched: touched };
  var shadows = items.map(function (item) {
    var s = item.el.style;
    return [s.getPropertyValue('text-shadow'), s.getPropertyPriority('text-shadow')];
  });
  // A candidate whose own fill is transparent is drawn by its shadows alone (an outline): the shadow is its glyph,
  // so its shadow stays in A. Every other candidate's shadow is removed, so it is never read as the text colour.
  items.forEach(function (item) {
    var cs = getComputedStyle(item.el);
    var ownFillClear = alphaOf(cs.color) === 0 || alphaOf(cs.webkitTextFillColor) === 0;
    if (ownFillClear && cs.textShadow !== 'none') return;
    item.el.style.setProperty('text-shadow', 'none', 'important');
  });
  window.__seatPricingContrast.shadows = shadows;
  return { metas: metas, startX: window.scrollX, startY: window.scrollY };
}`

/**
 * arg: { index, piece }. Scrolls the candidate at index to the centre of the viewport, then centres its piece (its
 * text box) if the piece is not at the centre of the candidate. Reports every candidate's pieces in viewport coordinates
 * (each cut to its clipping boxes), whether each lies in view, and whether it is covered or fixed (see the header).
 */
const STOP_SOURCE = String.raw`(arg) => {
  ${PRELUDE}
  var st = window.__seatPricingContrast;
  var own = st.items[arg.index];
  own.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var vw = window.innerWidth, vh = window.innerHeight;
  // The piece's top sits 8 px below the viewport's top edge: every piece above it is already measured, so the lower
  // part of the viewport is where the next pieces are, and a stop covers the most pieces it can.
  if (arg.piece >= 0) {
    var target = regionRects(own)[arg.piece];
    if (target) {
      var dy = target[1] - 8;
      if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior: 'instant' });
    }
  }
  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom];
  }
  var imgBoxes = st.imageEls.map(boxOf);
  var covers = st.coverEls.map(function (c) { return { el: c.el, pseudo: c.pseudo, box: boxOf(c.el) }; });
  var fixedBoxes = [];
  st.fixedEls.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) fixedBoxes.push({ el: el, box: [r.left, r.top, r.right, r.bottom] });
  });
  return {
    vw: vw,
    vh: vh,
    items: st.items.map(function (item) {
      var out = { clipped: item.clipped, special: item.special, control: item.control, pieces: [] };
      var raw = regionRects(item);
      var boxes = clipBoxesOf(item.plan);
      raw.forEach(function (rr) {
        var rect = null;
        if (boxes !== null) {
          var cut = clipRects([rr], boxes);
          // Text cut to a sliver (a visually hidden wrapper: 1 px, clipped) is not painted by design.
          if (cut.length > 0 && cut[0][2] >= 2 && cut[0][3] >= 2) rect = cut[0];
        }
        var p = { r: rect, vis: false, inside: false, covered: false, fixed: false };
        if (rect) {
          p.vis = rect[0] < vw && rect[0] + rect[2] > 0 && rect[1] < vh && rect[1] + rect[3] > 0;
          p.inside = rect[0] >= -0.5 && rect[1] >= -0.5 && rect[0] + rect[2] <= vw + 0.5 && rect[1] + rect[3] <= vh + 0.5;
          p.covered = imgBoxes.some(function (g) { return overlaps(rect, g); }) ||
            covers.some(function (c) {
              if (!c.pseudo && (c.el === item.el || c.el.contains(item.el))) return false;
              return overlaps(rect, c.box);
            });
          p.fixed = fixedBoxes.some(function (f) {
            if (f.el.contains(item.el) || item.el.contains(f.el)) return false;
            return overlaps(rect, f.box);
          });
        }
        out.pieces.push(p);
      });
      return out;
    })
  };
}`

/**
 * The paint of every candidate, as a page-side function: the text in colour (inline, important); a candidate that
 * is clipped also loses its background, which is its glyph paint. The first call saves each touched element's style
 * attribute, so RESTORE puts back the page as it was. A colour of 'transparent' also removes the text shadow of a
 * candidate whose fill is painted (B), and the background of every background-clip:text ancestor (their glyph paint);
 * other colours keep the shadow, so an outline keeps its shadows as its glyph.
 */
const PAINT_FN = String.raw`function paintAll(colour) {
  var st = window.__seatPricingContrast;
  if (!st.saved) st.saved = st.touched.map(function (el) { return el.getAttribute('style'); });
  st.items.forEach(function (item) {
    var s = item.el.style;
    s.setProperty('color', colour, 'important');
    s.setProperty('-webkit-text-fill-color', colour, 'important');
    s.setProperty('-webkit-text-stroke-color', colour, 'important');
    s.setProperty('caret-color', colour, 'important');
    if (colour === 'transparent') s.setProperty('text-shadow', 'none', 'important');
    if (item.svg) {
      s.setProperty('fill', colour, 'important');
      s.setProperty('stroke', colour, 'important');
    }
    if (item.clipped) {
      s.setProperty('background-image', 'none', 'important');
      s.setProperty('background-color', 'transparent', 'important');
    }
  });
  if (colour === 'transparent') {
    st.owners.forEach(function (el) {
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('background-color', 'transparent', 'important');
    });
  }
}
function restoreAll() {
  var st = window.__seatPricingContrast;
  if (!st || !st.saved) return false;
  st.touched.forEach(function (el, i) {
    var saved = st.saved[i];
    if (saved === null) el.removeAttribute('style');
    else el.setAttribute('style', saved);
  });
  st.saved = null;
  return true;
}`

/** arg: { colour }. Applies the paint of PAINT_FN to every candidate (picture B, and the glyph colours of the stripped pair). */
const APPLY_PAINT_SOURCE = String.raw`(arg) => {
  ${PAINT_FN}
  paintAll(arg.colour);
  return true;
}`

/** Puts back every style attribute that APPLY_PAINT_SOURCE changed. */
const RESTORE_PAINT_SOURCE = String.raw`() => {
  ${PAINT_FN}
  return restoreAll();
}`

/**
 * arg: { colour }. The stripped page for the glyph pictures E and F: no background, border image, box shadow or mask
 * (so no cover or backdrop is drawn), every replaced element that holds no candidate hidden (so no image is drawn over
 * a glyph), on a mid-grey canvas; then every candidate's text in arg.colour. STRIP_OFF undoes all of it.
 */
const STRIP_ON_SOURCE = String.raw`(arg) => {
  ${PAINT_FN}
  var st = window.__seatPricingContrast;
  var style = document.createElement('style');
  style.id = '${STRIP_ID}';
  style.textContent = '*,*::before,*::after{background-image:none !important;background-color:transparent !important;border-image:none !important;box-shadow:none !important;mask-image:none !important;-webkit-mask-image:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}' +
    'html,body{background-color:#808080 !important}' +
    '[${HIDE_ATTR}]{visibility:hidden !important}';
  (document.head || document.documentElement).appendChild(style);
  st.hide.forEach(function (el) { el.setAttribute('${HIDE_ATTR}', ''); });
  paintAll(arg.colour);
  return true;
}`

/** Puts back the paint, removes the stripped page's style and its hidden marks. */
const STRIP_OFF_SOURCE = String.raw`() => {
  ${PAINT_FN}
  var st = window.__seatPricingContrast;
  restoreAll();
  if (st) st.hide.forEach(function (el) { el.removeAttribute('${HIDE_ATTR}'); });
  var style = document.getElementById('${STRIP_ID}');
  if (style) style.remove();
  return true;
}`

/** Puts back each candidate's text-shadow as INIT found it, removes the strip, drops the stored candidates and restores the scroll position. */
const FINISH_SOURCE = String.raw`(arg) => {
  ${PAINT_FN}
  var st = window.__seatPricingContrast;
  restoreAll();
  if (st && st.shadows) {
    st.items.forEach(function (item, i) {
      var saved = st.shadows[i], s = item.el.style;
      if (saved[0] === '') s.removeProperty('text-shadow');
      else s.setProperty('text-shadow', saved[0], saved[1]);
    });
  }
  if (st) st.hide.forEach(function (el) { el.removeAttribute('${HIDE_ATTR}'); });
  var strip = document.getElementById('${STRIP_ID}');
  if (strip) strip.remove();
  window.__seatPricingContrast = undefined;
  window.scrollTo({ left: arg.x, top: arg.y, behavior: 'instant' });
  return true;
}`

/** Two frames and a macrotask: the compositor has taken the last style or scroll change. */
const FRAMES_SOURCE = `() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 0)));
})`

/**
 * Runs in the helper page. arg: { a, b, e, f } (base64 PNGs of the same size; e and f are null when the stop has no
 * stripped pair, see the header, step 5), vw and vh (the viewport in CSS px), and views: one per piece measured at this
 * stop, { key (its candidate), r (the piece's box), control, em (the candidate's font size), plainFill (its CSS fill colour,
 * or null) }. Returns one raw result per view; the verdicts are taken in JavaScript from the sums over a candidate's pieces.
 */
const ANALYSE_SOURCE = String.raw`async (arg) => {
  var GLYPH_DIFF = ${GLYPH_DIFF}, GLYPH_MIN = ${GLYPH_MIN}, CORE_PIXELS = ${CORE_PIXELS}, FULL_STRENGTH = ${FULL_STRENGTH}, WORST_SHARE = ${WORST_SHARE}, SOLID_STRENGTH = ${SOLID_STRENGTH}, HIDDEN_SHARE = ${HIDDEN_SHARE}, OFF_LINE_SHARE = ${OFF_LINE_SHARE}, LINE_TOLERANCE = ${LINE_TOLERANCE};
  async function load(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
    var w = bitmap.width, h = bitmap.height;
    var canvas = new OffscreenCanvas(w, h);
    var g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    var data = g.getImageData(0, 0, w, h).data;
    if (bitmap.close) bitmap.close();
    return { width: w, height: h, data: data };
  }
  var A = await load(arg.a), B = await load(arg.b);
  var hasEF = !!(arg.e && arg.f);
  var E = hasEF ? await load(arg.e) : null, F = hasEF ? await load(arg.f) : null;
  var W = A.width, H = A.height, sx = W / arg.vw, sy = H / arg.vh, total = W * H;
  [B, E, F].forEach(function (img) {
    if (img && (img.width !== W || img.height !== H)) throw new Error('screenshots differ in size');
  });
  function box(r, grow) {
    var x0 = Math.max(0, Math.floor((r[0] - grow) * sx)), y0 = Math.max(0, Math.floor((r[1] - grow) * sy));
    var x1 = Math.min(W, Math.ceil((r[0] + r[2] + grow) * sx)), y1 = Math.min(H, Math.ceil((r[1] + r[3] + grow) * sy));
    return [x0, y0, x1, y1];
  }
  // Owner of each pixel: the view whose own box covers it; -1 none; -2 two views (belongs to neither). A text beats a
  // control's content box (a label over a filled input); two texts, or two controls, sharing a pixel is -2. Pieces of
  // one candidate never conflict.
  var owner = new Int32Array(total);
  owner.fill(-1);
  arg.views.forEach(function (view, k) {
    var b = box(view.r, 0);
    for (var y = b[1]; y < b[3]; y++) {
      for (var x = b[0]; x < b[2]; x++) {
        var i = y * W + x, o = owner[i];
        if (o === -1) owner[i] = k;
        else if (o === k || o === -2) continue;
        else if (arg.views[o].key === view.key) continue;
        else if (view.control) { if (arg.views[o].control) owner[i] = -2; }
        else owner[i] = arg.views[o].control ? k : -2;
      }
    }
  });
  function chanMax(X, Y, p) {
    return Math.max(Math.abs(X.data[p] - Y.data[p]), Math.abs(X.data[p + 1] - Y.data[p + 1]), Math.abs(X.data[p + 2] - Y.data[p + 2]));
  }
  function median(values) {
    var v = values.slice().sort(function (p, q) { return p - q; });
    var m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  // The mean of the worst WORST_SHARE of the values (the lowest ratios): the worst quartile, averaged.
  function worstMean(values) {
    var v = values.slice().sort(function (p, q) { return p - q; });
    var k = Math.max(1, Math.floor(v.length * WORST_SHARE)), s = 0;
    for (var i = 0; i < k; i++) s += v[i];
    return s / k;
  }
  function mean(values) {
    var s = 0;
    for (var i = 0; i < values.length; i++) s += values[i];
    return s / values.length;
  }
  function lin(v) {
    var s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
  function lum(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function ratio(c1, c2) {
    var l1 = lum(c1), l2 = lum(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  var stamp = new Int32Array(total);
  return arg.views.map(function (view, k) {
    // The owned pixels of this view (each once), then the 1 px ring around them that no view owns.
    var region = [];
    var b0 = box(view.r, 0);
    for (var y0 = b0[1]; y0 < b0[3]; y0++) {
      for (var x0 = b0[0]; x0 < b0[2]; x0++) {
        var i0 = y0 * W + x0;
        if (owner[i0] !== k || stamp[i0] === k + 1) continue;
        stamp[i0] = k + 1;
        region.push(i0);
      }
    }
    var b1 = box(view.r, 1);
    for (var y1 = b1[1]; y1 < b1[3]; y1++) {
      for (var x1 = b1[0]; x1 < b1[2]; x1++) {
        var i1 = y1 * W + x1;
        if (owner[i1] !== -1 || stamp[i1] === k + 1) continue;
        stamp[i1] = k + 1;
        region.push(i1);
      }
    }
    // The glyph mask: E minus F when the stop has the stripped pair (no backdrop, no cover, no emoji), else A minus B.
    var ink = [];
    for (var j = 0; j < region.length; j++) {
      var p = 4 * region[j];
      var d = hasEF ? chanMax(E, F, p) : chanMax(A, B, p);
      if (d > GLYPH_DIFF) ink.push({ i: region[j], d: d });
    }
    ink.sort(function (p1, q1) { return q1.d - p1.d; });
    var strongest = ink.length ? ink[0].d : 0;
    var visible = 0, full = 0, solid = 0, hidden = 0, core = [];
    ink.forEach(function (e) {
      var seen = chanMax(A, B, 4 * e.i) > GLYPH_DIFF;
      if (seen) visible++;
      if (e.d >= FULL_STRENGTH * strongest) { full++; core.push(e); }
      if (hasEF && e.d >= SOLID_STRENGTH * strongest) {
        solid++;
        if (!seen) hidden++;
      }
    });
    // The measured colour of the piece: the median of A over its CORE_PIXELS strongest ink pixels (within 2 levels of the strongest).
    var measured = null;
    if (ink.length > 0) {
      var top = ink[0].d, n = 0;
      while (n < ink.length && n < CORE_PIXELS && ink[n].d >= top - 2) n++;
      var ta = [[], [], []];
      for (var c = 0; c < n; c++) {
        var q0 = 4 * ink[c].i;
        for (var ch = 0; ch < 3; ch++) ta[ch].push(A.data[q0 + ch]);
      }
      measured = [median(ta[0]), median(ta[1]), median(ta[2])];
    }
    // The CSS colour composited over the backdrop B under pixel q.
    var fill = view.plainFill;
    function fillAt(q) {
      var a = fill[3];
      return [a * fill[0] + (1 - a) * B.data[q], a * fill[1] + (1 - a) * B.data[q + 1], a * fill[2] + (1 - a) * B.data[q + 2]];
    }
    // Whether A at pixel q lies off the line from B to the target colour t, by more than LINE_TOLERANCE levels.
    function offLine(q, t) {
      var b0 = B.data[q], b1 = B.data[q + 1], b2 = B.data[q + 2];
      var d0 = t[0] - b0, d1 = t[1] - b1, d2 = t[2] - b2;
      var v0 = A.data[q] - b0, v1 = A.data[q + 1] - b1, v2 = A.data[q + 2] - b2;
      var dd = d0 * d0 + d1 * d1 + d2 * d2;
      var s = dd > 0 ? Math.max(0, Math.min(1, (v0 * d0 + v1 * d1 + v2 * d2) / dd)) : 0;
      return Math.max(Math.abs(v0 - s * d0), Math.abs(v1 - s * d1), Math.abs(v2 - s * d2)) > LINE_TOLERANCE;
    }
    var plainOk = false;
    // A piece with fewer than GLYPH_MIN solid pixels (a 5 px line) cannot show its CSS colour: its colour is measured.
    if (fill && core.length >= GLYPH_MIN) {
      var off = 0;
      core.forEach(function (e) {
        var q = 4 * e.i;
        if (chanMax(A, B, q) > GLYPH_DIFF && offLine(q, fillAt(q))) off++;
      });
      plainOk = off <= OFF_LINE_SHARE * core.length;
    }
    var ratios = [], backs = [[], [], []];
    core.forEach(function (e) {
      var q = 4 * e.i;
      backs[0].push(B.data[q]); backs[1].push(B.data[q + 1]); backs[2].push(B.data[q + 2]);
      if (chanMax(A, B, q) <= GLYPH_DIFF) { ratios.push(1); return; }
      var back = [B.data[q], B.data[q + 1], B.data[q + 2]];
      ratios.push(ratio(plainOk ? fillAt(q) : measured, back));
    });
    // Windows one em wide along the piece: the mean core ratio of each window with at least GLYPH_MIN core pixels.
    var windowMin = null, pieceWorst = null;
    if (core.length >= GLYPH_MIN) pieceWorst = worstMean(ratios);
    var em = Math.max(1, view.em * sx), left = view.r[0] * sx, groups = {};
    core.forEach(function (e, n) {
      var w = Math.floor(((e.i % W) - left) / em);
      (groups[w] = groups[w] || []).push(ratios[n]);
    });
    Object.keys(groups).forEach(function (key) {
      var list = groups[key];
      if (list.length >= GLYPH_MIN) {
        var m = mean(list);
        windowMin = windowMin === null ? m : Math.min(windowMin, m);
      }
    });
    var colour = null;
    if (measured !== null) colour = plainOk && fill[3] === 1 ? [fill[0], fill[1], fill[2]] : measured;
    return {
      mode: hasEF ? 'stripped' : 'drawn',
      ink: ink.length, visible: visible, full: full, solid: solid, hidden: hidden, core: core.length,
      ratios: ratios.map(function (r) { return Math.round(r * 1000) / 1000; }),
      pieceWorst: pieceWorst === null ? null : Math.round(pieceWorst * 1000) / 1000,
      windowMin: windowMin === null ? null : Math.round(windowMin * 1000) / 1000,
      text: colour,
      back: backs[0].length ? [median(backs[0]), median(backs[1]), median(backs[2])] : null,
      plain: plainOk
    };
  });
}`

const helperPages = new WeakMap<BrowserContext, Promise<Page>>()

/** A blank page in the same context, used only to decode the screenshots (pixels.ts does the same). */
async function helperFor(page: Page): Promise<Page> {
  const context = page.context()
  const cached = helperPages.get(context)
  if (cached !== undefined) {
    const existing = await cached
    if (!existing.isClosed()) return existing
  }
  const created = context.newPage().then(async (helper) => {
    await helper.goto('about:blank', { timeout: ACTION_MS })
    return helper
  })
  helperPages.set(context, created)
  created.catch(() => helperPages.delete(context))
  return created
}

async function frames(page: Page): Promise<void> {
  await probe(page, FRAMES_SOURCE, undefined, 500).catch(() => undefined)
}

async function shot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', timeout: SHOT_MS })
  return buffer.toString('base64')
}

/** One text box of a candidate at a stop. r is its box cut to its clipping boxes, in viewport CSS px; null when clipped away. */
interface StopPiece {
  r: number[] | null
  /** Some of the box meets the viewport. */
  vis: boolean
  /** The whole box lies in the viewport: it can be measured at this stop. */
  inside: boolean
  /** The box meets a layer that can cover it, or the image of an ancestor. */
  covered: boolean
  /** The box meets a fixed or sticky layer (a bottom bar): its paint here depends on that layer. */
  fixed: boolean
}

interface StopItem {
  clipped: boolean
  /** The candidate's glyph paint is special: a background-clip text, a mask fade, an emoji, or a clipped ancestor. */
  special: boolean
  control: boolean
  pieces: StopPiece[]
}

interface Stop {
  vw: number
  vh: number
  items: StopItem[]
}

/** The raw measurement of one piece (a text box) at a stop, from the helper page. */
interface PieceResult {
  mode: 'stripped' | 'drawn'
  ink: number
  visible: number
  full: number
  solid: number
  hidden: number
  core: number
  ratios: number[]
  pieceWorst: number | null
  windowMin: number | null
  text: number[] | null
  back: number[] | null
  plain: boolean
}

interface InitResult {
  metas: ContrastMeta[]
  startX: number
  startY: number
}

/** The stripped pair E and F (see the header, step 3): E with the text in black, F with it in white. */
async function glyphPictures(page: Page): Promise<{ e: string; f: string }> {
  await probe(page, STRIP_ON_SOURCE, { colour: '#000000' }, SETUP_MS)
  try {
    await frames(page)
    const e = await shot(page)
    await probe(page, APPLY_PAINT_SOURCE, { colour: '#ffffff' }, SETUP_MS)
    await frames(page)
    const f = await shot(page)
    return { e, f }
  } finally {
    await probe(page, STRIP_OFF_SOURCE, undefined, SETUP_MS).catch(() => undefined)
  }
}

function worstMeanOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const k = Math.max(1, Math.floor(sorted.length * WORST_SHARE))
  let sum = 0
  for (let i = 0; i < k; i++) sum += sorted[i]!
  return sum / k
}

/** Whether a piece's raw measurement fails its requirement on its own (used for a fixed layer's stop only). */
function pieceFails(result: PieceResult, required: number): boolean {
  if (result.visible < GLYPH_MIN) return true
  if (result.mode === 'stripped' && result.hidden >= GLYPH_MIN && result.hidden >= HIDDEN_SHARE * result.solid) return true
  let ratio = Infinity
  if (result.ratios.length > 0) ratio = Math.min(ratio, worstMeanOf(result.ratios))
  if (result.windowMin !== null) ratio = Math.min(ratio, result.windowMin)
  return ratio < required
}

/** The row of one candidate from the raw measurements of all its pieces, or null when it is skipped. */
function settle(meta: ContrastMeta, parts: PieceResult[]): ContrastRow | null {
  if (parts.length === 0) return null
  let visible = 0
  let ink = 0
  let full = 0
  let solid = 0
  let hidden = 0
  let core = 0
  let stripped = false
  const ratios: number[] = []
  let lineWorst: number | null = null
  let windowMin: number | null = null
  let text: number[] | null = null
  let back: number[] | null = null
  for (const p of parts) {
    visible += p.visible
    ink += p.ink
    full += p.full
    solid += p.solid
    hidden += p.hidden
    core += p.core
    if (p.mode === 'stripped') stripped = true
    for (const r of p.ratios) ratios.push(r)
    if (p.pieceWorst !== null) lineWorst = lineWorst === null ? p.pieceWorst : Math.min(lineWorst, p.pieceWorst)
    if (p.windowMin !== null) windowMin = windowMin === null ? p.windowMin : Math.min(windowMin, p.windowMin)
    if (text === null && p.text !== null) {
      text = p.text
      back = p.back
    }
  }
  const mode = stripped ? 'stripped' : 'drawn'
  const fail = (failure: string): ContrastRow => ({
    tag: meta.tag,
    id: meta.id,
    text: meta.text,
    ratio: null,
    required: meta.required,
    failure,
    paint: null,
  })
  // Punctuation or a symbol, or an emoji, with too few glyph pixels to read a colour from is skipped.
  if (meta.punct && (meta.emoji || visible < GLYPH_MIN || full < GLYPH_MIN)) return null
  if (visible < GLYPH_MIN) return fail(`text not painted (${visible} of ${ink} glyph pixels visible)`)
  if (stripped && hidden >= GLYPH_MIN && hidden >= HIDDEN_SHARE * solid) {
    return fail(`text partly covered (${hidden} of ${solid} solid glyph pixels hidden under an image or layer, or the colour of their backdrop)`)
  }
  if (ratios.length === 0) return fail('text not painted (no solid glyph pixels)')
  let ratio = worstMeanOf(ratios)
  if (lineWorst !== null) ratio = Math.min(ratio, lineWorst)
  if (windowMin !== null) ratio = Math.min(ratio, windowMin)
  return {
    tag: meta.tag,
    id: meta.id,
    text: meta.text,
    ratio,
    required: meta.required,
    failure: null,
    paint: { mode, text: text ?? [], back: back ?? [], ink, visible, core },
  }
}

/**
 * Audits text contrast in the page's current state, from paint. Returns the shared shape: ok does not mean anything
 * was checked, so require checked > 0 as well. Pass the baseline of the default state to a later state: the
 * candidates whose fingerprint is unchanged keep their result, and the state counts them (see the header, step 9).
 */
export async function contrastAudit(page: Page, previous?: ContrastBaseline): Promise<ContrastAudit> {
  await freezeMotion(page)
  const init = await probe<InitResult>(page, INIT_SOURCE, undefined, SETUP_MS)
  const count = init.metas.length
  // The outcome of each candidate: a row, null for a skip, or undefined until it is settled.
  const outcome: Array<ContrastRow | null | undefined> = new Array(count).fill(undefined)
  if (previous) {
    const carry = new Map<string, Array<ContrastRow | null>>()
    for (const [key, list] of previous.entries) carry.set(key, [...list])
    init.metas.forEach((meta, i) => {
      const list = carry.get(meta.fp)
      if (list && list.length > 0) outcome[i] = list.shift()!
    })
  }
  init.metas.forEach((meta, i) => {
    if (outcome[i] === undefined && (meta.skip !== null || meta.pieces === 0)) outcome[i] = null
  })
  // The raw measurements of each candidate's pieces, and which of its pieces are done (measured or not painted).
  const parts: PieceResult[][] = init.metas.map(() => [])
  const done: boolean[][] = init.metas.map((meta) => new Array<boolean>(meta.pieces).fill(false))
  let todo = init.metas.map((_, i) => i).filter((i) => outcome[i] === undefined)
  try {
    if (todo.length > 0) {
      const helper = await helperFor(page)
      while (todo.length > 0) {
        const first = todo[0]!
        const target = done[first]!.indexOf(false)
        const stop = await probe<Stop>(page, STOP_SOURCE, { index: first, piece: target }, SETUP_MS)
        await frames(page)
        const pending: Array<{ i: number; k: number; own: boolean }> = []
        // The candidate's own piece at its own stop: painted here, or clipped away or outside the viewport (not painted).
        const own = stop.items[first]!.pieces[target]!
        if (own.r !== null && own.vis) pending.push({ i: first, k: target, own: true })
        else done[first]![target] = true
        for (const i of todo) {
          stop.items[i]!.pieces.forEach((piece, k) => {
            if (i === first && k === target) return
            if (done[i]![k] || piece.r === null || !piece.inside) return
            pending.push({ i, k, own: i === first })
          })
        }
        if (pending.length > 0) {
          const shotA = await shot(page)
          await probe(page, APPLY_PAINT_SOURCE, { colour: 'transparent' }, SETUP_MS)
          let shotB = ''
          try {
            await frames(page)
            shotB = await shot(page)
          } finally {
            await probe(page, RESTORE_PAINT_SOURCE, undefined, SETUP_MS).catch(() => undefined)
          }
          // A stop takes the stripped pair only when a pending piece could be covered or is special (header, step 5).
          const needsGlyphs = pending.some(({ i, k }) => stop.items[i]!.pieces[k]!.covered || stop.items[i]!.special)
          const glyphs = needsGlyphs ? await glyphPictures(page) : null
          const views = pending.map(({ i, k }) => {
            const item = stop.items[i]!
            const piece = item.pieces[k]!
            const meta = init.metas[i]!
            return {
              key: i,
              r: piece.r!,
              control: item.control,
              em: meta.fontSize,
              plainFill: piece.covered || item.special || meta.fontSize < PLAIN_MIN_PX ? null : meta.plainFill,
            }
          })
          const results = await probe<PieceResult[]>(
            helper,
            ANALYSE_SOURCE,
            { a: shotA, b: shotB, e: glyphs?.e ?? null, f: glyphs?.f ?? null, vw: stop.vw, vh: stop.vh, views },
            ANALYSE_MS
          )
          pending.forEach(({ i, k, own: isOwn }, n) => {
            const piece = stop.items[i]!.pieces[k]!
            const result = results[n]!
            // A fixed layer may hide or tint a piece that is not at its own stop: it is measured again there, if it fails here.
            if (!isOwn && piece.fixed && pieceFails(result, init.metas[i]!.required)) return
            parts[i]!.push(result)
            done[i]![k] = true
          })
        }
        for (const i of todo) {
          if (done[i]!.every(Boolean)) outcome[i] = settle(init.metas[i]!, parts[i]!)
        }
        todo = todo.filter((i) => outcome[i] === undefined)
      }
    }
  } finally {
    await probe(page, FINISH_SOURCE, { x: init.startX, y: init.startY }, SETUP_MS).catch(() => undefined)
  }
  const entries = new Map<string, Array<ContrastRow | null>>()
  init.metas.forEach((meta, i) => {
    const list = entries.get(meta.fp) ?? []
    list.push(outcome[i] ?? null)
    entries.set(meta.fp, list)
  })
  const rows = outcome.filter((r): r is ContrastRow => r !== null && r !== undefined)
  const skipped = outcome.filter((r) => r === null || r === undefined).length
  const failingAll = rows.filter((r) => r.failure !== null || (r.ratio !== null && r.ratio < r.required))
  const ranked = rows.filter((r) => r.ratio !== null).sort((a, b) => a.ratio! - b.ratio!)
  return {
    ok: failingAll.length === 0,
    checked: rows.length,
    skipped,
    failCount: failingAll.length,
    failing: failingAll[0] ?? null,
    failingAll,
    lowest: ranked.slice(0, 3),
    rows,
    baseline: { entries },
  }
}
