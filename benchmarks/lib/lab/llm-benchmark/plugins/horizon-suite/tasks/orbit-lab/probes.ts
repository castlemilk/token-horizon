/**
 * In-page probe sources for orbit-lab. Each is a plain-JavaScript arrow function
 * written as a string, evaluated in the artifact page through probe(). Strings
 * are used, not functions, so nothing compiled by tsx reaches the page (postmortem
 * 0008). Every probe is one synchronous JavaScript turn except the contract probe,
 * which awaits animation frames, and that one can only let an unpaused page pass
 * the frame wait, never fail a paused one.
 *
 * Numbers cross the wire as decimal strings from num(): String(v), or '-0' for
 * negative zero, so NaN, Infinity and -0 survive. A non-number becomes 'bad', which
 * Number() reads as NaN and every comparison then fails.
 */

/** Shared helpers, pasted into every probe. */
const HELP = String.raw`function num(v) {
  if (typeof v !== 'number') return 'bad';
  return (v === 0 && 1 / v < 0) ? '-0' : String(v);
}
function snap(s) {
  return {
    t: num(s.t),
    bodies: s.bodies.map(function (b) {
      return { m: num(b.m), x: num(b.x), y: num(b.y), vx: num(b.vx), vy: num(b.vy) };
    })
  };
}
function fresh(list) {
  return list.map(function (b) { return { m: b.m, x: b.x, y: b.y, vx: b.vx, vy: b.vy }; });
}`

/** Pixel helpers for the canvas probes. Packed RGBA is read as uint32 (little-endian). */
const PIXELS = String.raw`function grab(ctx, canvas) { return ctx.getImageData(0, 0, canvas.width, canvas.height); }
function unpack(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
function modal(img) {
  var u = new Uint32Array(img.data.buffer);
  var counts = new Map();
  var best = 0, bestN = 0;
  for (var i = 0; i < u.length; i++) {
    var c = (counts.get(u[i]) || 0) + 1;
    counts.set(u[i], c);
    if (c > bestN) { bestN = c; best = u[i]; }
  }
  return unpack(best);
}
function at(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  var i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
function block(img, x, y) {
  var s = [0, 0, 0, 0], n = 0;
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    var p = at(img, x + dx, y + dy);
    if (p) { for (var k = 0; k < 4; k++) s[k] += p[k]; n++; }
  }
  return n === 0 ? null : s.map(function (v) { return v / n; });
}
function same(a, b) {
  var x = new Uint32Array(a.data.buffer), y = new Uint32Array(b.data.buffer);
  if (x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}`

/**
 * Contract probe. Load a copy, mutate the caller's array, wait for frames, then
 * step. Returns every snapshot the Node side compares.
 */
export const CONTRACT_SRC = String.raw`async (arg) => {
  ${HELP}
  var B = window.__bench;
  function frames(n, timer) {
    return new Promise(function (resolve) {
      var count = 0, done = false;
      var t = setTimeout(finish, timer);
      function finish() { if (!done) { done = true; resolve(); } }
      function tick() {
        if (done) return;
        count += 1;
        if (count >= n) { clearTimeout(t); finish(); } else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }
  var mine = fresh(arg.bodies);
  B.load(mine, arg.opts);
  var s0 = snap(B.state());
  mine[0].x += arg.mutateBody0X;
  mine[2].m = arg.mutateBody2Mass;
  var s0b = snap(B.state());
  await frames(arg.frames, arg.frameTimerMs);
  await new Promise(function (resolve) { setTimeout(resolve, arg.settleMs); });
  var s1 = snap(B.state());
  B.step(0);
  var s2 = snap(B.state());
  B.step(arg.stepsA);
  var s3 = snap(B.state());
  B.load(fresh(arg.bodies), arg.opts);
  B.step(arg.stepsA);
  var s4 = snap(B.state());
  B.load(fresh(arg.bodies), arg.opts);
  B.step(arg.stepsB);
  B.step(arg.stepsC);
  var s5 = snap(B.state());
  return { s0: s0, s0b: s0b, s1: s1, s2: s2, s3: s3, s4: s4, s5: s5 };
}`

/**
 * Sampled runs. For each run: load, sample, then `count` times step(stride) and
 * sample. A run with `reverse` then loads the final state with every velocity
 * negated and steps `reverse` more, returning that final snapshot.
 */
export const RUNS_SRC = String.raw`(arg) => {
  ${HELP}
  var B = window.__bench;
  var out = [];
  for (var r = 0; r < arg.runs.length; r++) {
    var run = arg.runs[r];
    B.load(fresh(run.bodies), run.opts);
    var samples = [snap(B.state())];
    for (var k = 0; k < run.count; k++) {
      B.step(run.stride);
      samples.push(snap(B.state()));
    }
    var final = null;
    if (run.reverse) {
      var st = B.state();
      B.load(st.bodies.map(function (b) {
        return { m: b.m, x: b.x, y: b.y, vx: -b.vx, vy: -b.vy };
      }), run.opts);
      B.step(run.reverse);
      final = snap(B.state());
    }
    out.push({ samples: samples, final: final });
  }
  return out;
}`

/** Diagnostics before and after step(steps), for each configuration. */
export const DIAG_SRC = String.raw`(arg) => {
  ${HELP}
  var B = window.__bench;
  function flat(d) {
    return [d.kinetic, d.potential, d.energy, d.angularMomentum, d.momentum[0], d.momentum[1], d.com[0], d.com[1]].map(num);
  }
  return arg.configs.map(function (c) {
    B.load(fresh(c.bodies), c.opts);
    var d0 = flat(B.diagnostics());
    var s0 = snap(B.state());
    B.step(c.steps);
    var d1 = flat(B.diagnostics());
    var s1 = snap(B.state());
    return { d0: d0, s0: s0, d1: d1, s1: s1 };
  });
}`

/** The three HUD spans after load, step and render, with the state they should show. */
export const HUD_SRC = String.raw`(arg) => {
  ${HELP}
  var B = window.__bench;
  B.load(fresh(arg.bodies), arg.opts);
  B.step(arg.steps);
  B.render();
  function read(id) {
    var el = document.getElementById(id);
    return el ? String(el.textContent).trim() : null;
  }
  return {
    time: read('hud-time'),
    energy: read('hud-energy'),
    angmom: read('hud-angmom'),
    state: snap(B.state())
  };
}`

/**
 * Camera fit: for each system, load it, then project the probe points. The canvas
 * size and its rectangle are read after the load.
 */
export const VIEW_SRC = String.raw`(arg) => {
  ${HELP}
  var B = window.__bench;
  var canvas = document.getElementById('scene');
  function pt(p) { return [num(p[0]), num(p[1])]; }
  return arg.systems.map(function (sys) {
    B.load(fresh(sys.bodies), sys.opts);
    var d = sys.d, cx = sys.cx, cy = sys.cy;
    var r = canvas.getBoundingClientRect();
    return {
      W: num(canvas.width),
      H: num(canvas.height),
      p0: pt(B.project(cx, cy)),
      px: pt(B.project(cx + d, cy)),
      py: pt(B.project(cx, cy + d)),
      p2: pt(B.project(cx + 2 * d, cy)),
      proj: sys.bodies.map(function (b) { return pt(B.project(b.x, b.y)); }),
      rect: [num(r.left), num(r.top), num(r.right), num(r.bottom)]
    };
  });
}`

/**
 * Drawn pixels. One synchronous probe: load and render, read the canvas, then load
 * the same bodies with 0 and 1 exchanged and read it again.
 */
export const DRAWN_SRC = String.raw`(arg) => {
  ${HELP}
  ${PIXELS}
  var B = window.__bench;
  var canvas = document.getElementById('scene');
  var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { ok: false, detail: 'no 2d context on #scene' };
  B.load(fresh(arg.bodies), arg.opts);
  B.render();
  var img1 = grab(ctx, canvas);
  var bg = modal(img1);
  var pts = arg.bodies.map(function (b) {
    var p = B.project(b.x, b.y);
    return [Math.round(p[0]), Math.round(p[1])];
  });
  var o = arg.offset;
  var centre = pts.map(function (p) { return block(img1, p[0], p[1]); });
  var samples = pts.map(function (p) {
    return [block(img1, p[0], p[1]), at(img1, p[0] + o, p[1]), at(img1, p[0] - o, p[1]),
      at(img1, p[0], p[1] + o), at(img1, p[0], p[1] - o)];
  });
  B.load(fresh([arg.bodies[1], arg.bodies[0], arg.bodies[2]]), arg.opts);
  B.render();
  var img2 = grab(ctx, canvas);
  var after = pts.map(function (p) { return block(img2, p[0], p[1]); });
  return { ok: true, bg: bg, pts: pts, centre: centre, samples: samples, after: after };
}`

/**
 * Trails. One synchronous probe. The page is loaded once to size its canvas; the
 * binary is then laid along the SHORTER canvas axis (vertical on a landscape canvas),
 * so that a camera which fits the separation to the shorter axis keeps the whole
 * orbit on the canvas. 80 cycles of step(3) and render() follow; body 0's pixel is
 * recorded each cycle, and the pixels are read. render() must be idempotent. The
 * canvas is then wiped and render() must redraw the trail from stored history. Last,
 * two far-apart bodies are loaded and the old pixels are read again.
 */
export const TRAILS_SRC = String.raw`(arg) => {
  ${HELP}
  ${PIXELS}
  var B = window.__bench;
  var canvas = document.getElementById('scene');
  var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { ok: false, detail: 'no 2d context on #scene' };
  function diff(a, b) {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
  }
  function litAround(img, p, bg) {
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var v = at(img, p[0] + dx, p[1] + dy);
      if (v && diff(v, bg) >= arg.litDiff) return true;
    }
    return false;
  }
  B.load(fresh(arg.horizontal), arg.opts);
  var vertical = canvas.width > canvas.height;
  var bodies = vertical ? arg.vertical : arg.horizontal;
  B.load(fresh(bodies), arg.opts);
  var W = canvas.width, H = canvas.height;
  var q = [];
  for (var k = 0; k < arg.cycles; k++) {
    B.step(arg.stepsPerCycle);
    B.render();
    var st = B.state();
    var p = B.project(st.bodies[0].x, st.bodies[0].y);
    q.push([Math.round(p[0]), Math.round(p[1])]);
  }
  var on = q.map(function (p) { return p[0] >= 1 && p[1] >= 1 && p[0] <= W - 2 && p[1] <= H - 2; });
  var img1 = grab(ctx, canvas);
  var bg = modal(img1);
  var lit = q.map(function (p) { return litAround(img1, p, bg); });
  B.render();
  var img2 = grab(ctx, canvas);
  var identical = same(img1, img2);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.restore();
  B.render();
  var img3 = grab(ctx, canvas);
  var bgw = modal(img3);
  var relit = q.map(function (p) { return litAround(img3, p, bgw); });
  B.load(fresh(arg.far), arg.opts);
  B.render();
  var img4 = grab(ctx, canvas);
  var bg2 = modal(img4);
  var newPts = arg.far.map(function (b) {
    var p = B.project(b.x, b.y);
    return [p[0], p[1]];
  });
  var after = q.map(function (p) { return at(img4, p[0], p[1]); });
  return { ok: true, vertical: vertical, on: on, lit: lit, identical: identical, relit: relit, bg2: bg2, q: q, newPts: newPts, after: after };
}`

export interface WireBody {
  m: string
  x: string
  y: string
  vx: string
  vy: string
}

export interface WireSnap {
  t: string
  bodies: WireBody[]
}
