/**
 * In-page sources for pathfinding-lab. Each is a plain JavaScript arrow function written as a
 * string, run with probe(page, SOURCE, arg). Nothing here is compiled by tsx, so no helper is
 * captured (postmortem 0008). Rules: no backticks and no template placeholders in page code.
 *
 * One probe per map: loading a map, solving it and reading the drawn state happen in one
 * synchronous page turn, so a page that redraws on a later animation frame cannot change the
 * outcome between two probes. The hit test and the read after a real pointer click are the only
 * steps that are separate, because the click itself needs its own step.
 */

/**
 * Helper statements shared by the sources below, emitted inside an IIFE (see inPage).
 * cellVisible: the cell passes checkVisibility (opacity and CSS included) and a hit test at its
 * centre inside the window finds the cell or one of its descendants, so a covered, clipped or
 * hidden cell is not drawn. colourBytes: the sRGB bytes of a computed colour, read back through
 * a 1 x 1 canvas, for colour syntaxes the Node parser does not know (oklch, lab, display-p3).
 * readGrid: every cell's attributes, rect, visibility and computed colour, plus last().
 */
const HELPERS = String.raw`
function cellVisible(el) {
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  var box = el.getBoundingClientRect();
  var x = box.left + box.width / 2;
  var y = box.top + box.height / 2;
  if (!(x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return false;
  var hit = document.elementFromPoint(x, y);
  return hit !== null && (hit === el || el.contains(hit));
}
function shownBox(el) {
  return el !== null && typeof el.checkVisibility === 'function' && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}
function colourBytes(css) {
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  } catch (e) {
    return null;
  }
}
function readGrid() {
  var bytes = {};
  var cells = Array.prototype.slice.call(document.querySelectorAll('#grid [data-r][data-c]')).map(function (el) {
    var box = el.getBoundingClientRect();
    var bg = getComputedStyle(el).backgroundColor;
    var key = 'k' + bg;
    if (!(key in bytes)) bytes[key] = colourBytes(bg);
    return {
      r: el.getAttribute('data-r'),
      c: el.getAttribute('data-c'),
      terrain: el.getAttribute('data-terrain'),
      role: el.getAttribute('data-role'),
      visited: el.getAttribute('data-visited'),
      path: el.getAttribute('data-path'),
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      bg: bg,
      px: bytes[key],
      visible: cellVisible(el)
    };
  });
  var status = document.getElementById('status');
  return {
    cells: cells,
    last: window.__bench.last(),
    status: status ? status.getAttribute('data-state') : null
  };
}`

/** Wraps a body (the statements of an arrow function of arg) with the helpers, as one expression. */
function inPage(body: string): string {
  return '(() => {' + HELPERS + '\nreturn (arg) => {\n' + body + '\n};\n})()'
}

/** arg: { spec }. Loads the map and reads the drawn grid. */
export const LOAD_GRID_SRC = inPage(String.raw`  window.__bench.loadGrid(arg);
  return readGrid();`)

/** arg: none. The drawn grid as it is now. */
export const GRID_SRC = inPage(String.raw`  return readGrid();`)

/** arg: { spec, algorithm }. Loads the map and solves it, once. */
export const LOAD_SOLVE_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  return window.__bench.solve(arg.algorithm);`)

/** arg: { spec, algorithms }. Loads the map, then solves it once per algorithm, in order. */
export const LOAD_SOLVE_MANY_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  return arg.algorithms.map(function (name) { return window.__bench.solve(name); });`)

/**
 * arg: { spec, algorithm }. Loads the map and solves it twice, with Math.random counted and
 * restored in finally, so the determinism check can see both results and any random draw.
 */
export const LOAD_SOLVE_TWICE_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  var calls = 0;
  var real = Math.random;
  Math.random = function () { calls += 1; return real(); };
  try {
    var first = window.__bench.solve(arg.algorithm);
    var second = window.__bench.solve(arg.algorithm);
    return { first: first, second: second, randomCalls: calls };
  } finally {
    Math.random = real;
  }`)

/** arg: { spec, algorithm }. Loads and solves, then reports the status region with the result. */
export const LOAD_SOLVE_STATUS_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  var result = window.__bench.solve(arg.algorithm);
  var status = document.getElementById('status');
  return {
    result: result,
    state: status ? status.getAttribute('data-state') : null,
    text: status ? status.textContent : null
  };`)

/**
 * arg: { spec, algorithm }. Loads and solves, then reads the stats, the scrubber and whether each
 * displayed control is shown (opacity and CSS included).
 */
export const LOAD_SOLVE_STATS_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  var result = window.__bench.solve(arg.algorithm);
  var read = function (id) { var el = document.getElementById(id); return el ? el.textContent : null; };
  var scrub = document.getElementById('scrub');
  var status = document.getElementById('status');
  var visible = {};
  ['stat-cost', 'stat-moves', 'stat-expanded', 'status', 'scrub'].forEach(function (id) {
    visible[id] = shownBox(document.getElementById(id));
  });
  return {
    result: result,
    cost: read('stat-cost'),
    moves: read('stat-moves'),
    expanded: read('stat-expanded'),
    max: scrub ? scrub.max : null,
    value: scrub ? scrub.value : null,
    state: status ? status.getAttribute('data-state') : null,
    visible: visible
  };`)

/**
 * arg: { spec, algorithm }. Loads and solves, then sets the scrubber to 0, N/3, N-1 and N (N is
 * the order length, and the values are the same in the grader), one 'input' event each, and reads
 * every cell's visibility, visited, path and computed colour in the same turn.
 */
export const LOAD_SOLVE_SYNC_SRC = inPage(String.raw`  window.__bench.loadGrid(arg.spec);
  var result = window.__bench.solve(arg.algorithm);
  var N = result.order.length;
  var values = [0, Math.floor(N / 3), N - 1, N];
  var scrub = document.getElementById('scrub');
  var out = [];
  for (var j = 0; j < values.length; j++) {
    scrub.value = String(values[j]);
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
    var nodes = document.querySelectorAll('#grid [data-r][data-c]');
    var cells = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      cells.push({
        r: el.getAttribute('data-r'),
        c: el.getAttribute('data-c'),
        visible: cellVisible(el),
        visited: el.getAttribute('data-visited'),
        path: el.getAttribute('data-path'),
        bg: getComputedStyle(el).backgroundColor
      });
    }
    out.push({ value: scrub.value, max: scrub.max, cells: cells });
  }
  return { result: result, values: values, snaps: out };`)

/**
 * arg: a CSS selector. Hit test at the centre of the matched cell, so an overlay that covers
 * it fails fast with its name, instead of a click that lands somewhere else.
 */
export const HIT_SRC = String.raw`(selector) => {
  var el = document.querySelector(selector);
  if (!el) return { ok: false, detail: 'no cell matches ' + selector };
  var box = el.getBoundingClientRect();
  var x = box.left + box.width / 2;
  var y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    return { ok: false, detail: 'cell centre is outside the viewport' };
  }
  var hit = document.elementFromPoint(x, y);
  if (!hit) return { ok: false, detail: 'nothing is drawn at the cell centre' };
  if (hit === el || el.contains(hit)) return { ok: true, x: x, y: y, detail: 'ok' };
  return { ok: false, x: x, y: y, detail: 'covered by ' + hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') };
}`
