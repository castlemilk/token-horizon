/**
 * The good artifact, with named regions the broken fixtures replace. A region is
 * written as a marker pair: /*@region:NAME*\/ ... /*@end:NAME*\/ (the backslash is
 * only here so this comment does not close itself). The markers are stripped from
 * the published fixture by fixtures.ts.
 *
 * Written as a careful human expert would write it: one fixed-step Yoshida-4
 * composition of velocity Verlet, pairwise Plummer-softened gravity, a camera that
 * refits on load, stored trail history redrawn on each render, and a HUD that reads
 * the same state the drawing reads.
 */
export const GOOD_SOURCE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbit Lab</title>
<style>
:root {
  --bg: #05080f;
  --panel: #0c1322;
  --line: #22304d;
  --text: #e8ecf5;
  --muted: #8e9bb8;
  --accent: #4dd4ff;
  --danger: #ff6b6b;
}
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  /*@region:body-layout*/display: flex;
  flex-direction: column;
  min-height: 100vh;/*@end:body-layout*/
  box-sizing: border-box;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 12px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: 0.01em; }
.sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
button, select {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: #162140;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 12px;
}
button { cursor: pointer; min-width: 74px; }
button:hover, select:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: #1d3a5c; border-color: var(--accent); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.stage { position: relative; /*@region:stage-size*/flex: 1 1 auto; min-height: 360px;/*@end:stage-size*/ }
canvas#scene { position: absolute; inset: 0; width: 100%; height: 100%; display: block; background: #070b16; }
.hud {
  position: absolute;
  top: 12px;
  left: 12px;
  margin: 0;
  display: grid;
  grid-template-columns: auto auto;
  gap: 4px 14px;
  padding: 10px 12px;
  background: rgba(9, 14, 28, 0.86);
  border: 1px solid var(--line);
  border-radius: 10px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.hud dt { color: var(--muted); }
.hud dd { margin: 0; text-align: right; }
footer { padding: 8px 16px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
.alert {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding: 10px 12px;
  background: #3a1220;
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: #ffd6d6;
  font-size: 13px;
}
@media (max-width: 640px) {
  .controls { margin-left: 0; }
  .hud { font-size: 11.5px; padding: 8px 10px; }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>Orbit Lab</h1>
    <div class="sub">Gravitational N-body, fourth-order symplectic integrator</div>
  </div>
  <div class="controls">
    <button id="play-pause" type="button" aria-pressed="false">Play</button>
    <button id="reset" type="button">Reset</button>
    <label><span class="sr">Preset</span>
      <select id="preset">
        <option value="figure-eight">Figure-eight (three bodies)</option>
        <option value="star-two-planets">Star and two planets</option>
        <option value="eccentric-binary">Eccentric binary (e 0.8)</option>
      </select>
    </label>
  </div>
</header>
<main class="stage">
  <canvas id="scene" aria-label="Simulated bodies and their trails"></canvas>
  <dl class="hud">
    <dt>time</dt><dd><span id="hud-time">0</span></dd>
    <dt>energy</dt><dd><span id="hud-energy">0</span></dd>
    <dt>L<sub>z</sub></dt><dd><span id="hud-angmom">0</span></dd>
    <dt>drift</dt><dd><span id="hud-drift">0</span></dd>
  </dl>
  <div id="alert" class="alert" role="alert" hidden></div>
</main>
<footer>Pairwise gravity with Plummer softening. Yoshida composition of velocity Verlet. The camera refits when a system loads.</footer>
<script>
(function () {
  'use strict';

  var PALETTE = ['#ff6b6b', '#4dd4ff', '#ffd166', '#9b8cff', '#6be38f', '#ff7a00', '#f78fb3', '#e6e6e6'];
  var BG = '#070b16';
  var TRAIL_MAX = 1200;
  var TRAIL_FULL = 100;
  var FIT_FRACTION = 0.8;
  var YOSHIDA_W1 = 1 / (2 - Math.cbrt(2));
  var YOSHIDA_W0 = -Math.cbrt(2) * YOSHIDA_W1;

  var canvas = null;
  var ctx = null;
  var W = 2;
  var H = 2;
  var dpr = 1;
  var cam = { cx: 0, cy: 0, k: 1 };
  var sys = { G: 1, dt: 0.001, eps: 0, spf: 4, bodies: [], steps: 0, trails: [], dirty: false, E0: 0 };
  var playing = false;
  var loopId = 0;
  var currentPreset = 'figure-eight';

  function copyBody(b) {
    return { m: b.m, x: b.x, y: b.y, vx: b.vx, vy: b.vy };
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ----- forces ------------------------------------------------------------

  function accelerations(bodies, G, eps) {
    var n = bodies.length;
    var acc = [];
    var e2 = eps * eps;
    var i, j;
    for (i = 0; i < n; i++) acc.push([0, 0]);
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var bi = bodies[i];
        var bj = bodies[j];
        var dx = bj.x - bi.x;
        var dy = bj.y - bi.y;
        var r2 = dx * dx + dy * dy + /*@region:force-eps*/e2/*@end:force-eps*/;
        var inv = /*@region:force-gravity*/G/*@end:force-gravity*/ / (r2 * Math.sqrt(r2));
        acc[i][0] += bj.m * dx * inv;
        acc[i][1] += bj.m * dy * inv;
        acc[j][0] -= bi.m * dx * inv;
        acc[j][1] -= bi.m * dy * inv;
      }
    }
    return acc;
  }

  // ----- diagnostics -------------------------------------------------------

  function diagnostics() {
    var bodies = sys.bodies;
    var n = bodies.length;
    var kinetic = 0;
    var lz = 0;
    var px = 0;
    var py = 0;
    var mass = 0;
    var potential = 0;
    var comX = 0;
    var comY = 0;
    var i, j;
    for (i = 0; i < n; i++) {
      var b = bodies[i];
      kinetic += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy);
      lz += b.m * (b.x * b.vy - b.y * b.vx);
      px += b.m * b.vx;
      py += b.m * b.vy;
      mass += b.m;
    }
    var e2 = sys.eps * sys.eps;
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var dx = bodies[j].x - bodies[i].x;
        var dy = bodies[j].y - bodies[i].y;
        potential -= sys.G * bodies[i].m * bodies[j].m / Math.sqrt(dx * dx + dy * dy + e2);
      }
    }
    /*@region:diag-com*/
    var sx = 0;
    var sy = 0;
    for (i = 0; i < n; i++) {
      sx += bodies[i].m * bodies[i].x;
      sy += bodies[i].m * bodies[i].y;
    }
    comX = sx / mass;
    comY = sy / mass;
    /*@end:diag-com*/
    return {
      kinetic: kinetic,
      potential: potential,
      energy: kinetic + potential,
      angularMomentum: lz,
      momentum: [px, py],
      com: [comX, comY]
    };
  }

  // ----- integrator --------------------------------------------------------

  function kick(h) {
    var a = accelerations(sys.bodies, sys.G, sys.eps);
    for (var i = 0; i < sys.bodies.length; i++) {
      sys.bodies[i].vx += a[i][0] * h;
      sys.bodies[i].vy += a[i][1] * h;
    }
  }

  function drift(h) {
    for (var i = 0; i < sys.bodies.length; i++) {
      sys.bodies[i].x += sys.bodies[i].vx * h;
      sys.bodies[i].y += sys.bodies[i].vy * h;
    }
  }

  function verlet(h) {
    kick(h / 2);
    drift(h);
    kick(h / 2);
  }

  function yoshidaStep(h) {
    verlet(YOSHIDA_W1 * h);
    verlet(YOSHIDA_W0 * h);
    verlet(YOSHIDA_W1 * h);
  }

  function stepOnce() {
    var dt = sys.dt;
    /*@region:integrator*/
    yoshidaStep(dt);
    /*@end:integrator*/
    /*@region:recentre*//*@end:recentre*/
    sys.steps += 1;
    sys.dirty = true;
  }

  // Each render() that follows a change of state appends every body's position.
  function appendTrailPoints() {
    for (var k = 0; k < sys.trails.length; k++) {
      var tr = sys.trails[k];
      var b = sys.bodies[k];
      tr.push({ x: b.x, y: b.y });
      if (tr.length > TRAIL_MAX) tr.splice(0, tr.length - TRAIL_MAX);
    }
  }

  function step(n) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new RangeError('step needs a non-negative integer');
    }
    for (var i = 0; i < n; i++) stepOnce();
  }

  // ----- camera ------------------------------------------------------------

  function project(x, y) {
    return [W / 2 + (x - cam.cx) * cam.k, H / 2 - (y - cam.cy) * cam.k];
  }

  function fitCamera(bodies) {
    /*@region:camera-fit*/
    var minX = Infinity;
    var maxX = -Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < bodies.length; i++) {
      minX = Math.min(minX, bodies[i].x);
      maxX = Math.max(maxX, bodies[i].x);
      minY = Math.min(minY, bodies[i].y);
      maxY = Math.max(maxY, bodies[i].y);
    }
    var span = Math.max(maxX - minX, maxY - minY);
    if (!(span > 0)) span = 1;
    cam.cx = (minX + maxX) / 2;
    cam.cy = (minY + maxY) / 2;
    cam.k = FIT_FRACTION * Math.min(W, H) / span;
    /*@end:camera-fit*/
  }

  function sizeCanvas() {
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var w = Math.max(2, Math.round(rect.width * dpr));
    var h = Math.max(2, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    W = canvas.width;
    H = canvas.height;
  }

  // ----- drawing -----------------------------------------------------------

  function strokeRun(pts, from, to) {
    if (to - from < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[from][0], pts[from][1]);
    for (var i = from + 1; i < to; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function drawTrails() {
    for (var k = 0; k < sys.trails.length; k++) {
      var history = sys.trails[k];
      if (history.length < 2) continue;
      var screen = history.map(function (p) { return project(p.x, p.y); });
      var split = Math.max(0, screen.length - TRAIL_FULL);
      ctx.lineWidth = Math.max(2, 2 * dpr);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = PALETTE[k % PALETTE.length];
      ctx.globalAlpha = 0.45;
      strokeRun(screen, 0, split + 1);
      ctx.globalAlpha = 1;
      strokeRun(screen, split, screen.length);
    }
    ctx.globalAlpha = 1;
  }

  function drawBodies() {
    var r = Math.min(24, Math.max(4, 6 * dpr));
    for (var k = 0; k < sys.bodies.length; k++) {
      var p = project(sys.bodies[k].x, sys.bodies[k].y);
      ctx.fillStyle = /*@region:body-colour*/PALETTE[k % PALETTE.length]/*@end:body-colour*/;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function fmt(v) {
    /*@region:hud-number*/return v.toPrecision(10);/*@end:hud-number*/
  }

  function driftText(energyNow) {
    var delta = energyNow - sys.E0;
    var den = Math.abs(sys.E0);
    return (den > 0 ? delta / den : delta).toExponential(3);
  }

  function updateHud() {
    var d = diagnostics();
    setText('hud-time', fmt(sys.steps * sys.dt));
    setText('hud-energy', fmt(d.energy));
    setText('hud-angmom', fmt(d.angularMomentum));
    setText('hud-drift', driftText(d.energy));
  }

  function render() {
    if (sys.dirty) {
      appendTrailPoints();
      sys.dirty = false;
    }
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    /*@region:render-clear*/
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    /*@end:render-clear*/
    /*@region:render-trails*/
    drawTrails();
    /*@end:render-trails*/
    drawBodies();
    updateHud();
  }

  // ----- transport ---------------------------------------------------------

  function setPlaying(on) {
    playing = !!on;
    if (!playing && loopId) {
      cancelAnimationFrame(loopId);
      loopId = 0;
    }
    if (playing && !loopId) loopId = requestAnimationFrame(frame);
    var btn = document.getElementById('play-pause');
    if (btn) {
      btn.textContent = playing ? 'Pause' : 'Play';
      btn.setAttribute('aria-pressed', String(playing));
    }
  }

  function frame() {
    loopId = 0;
    if (!playing) return;
    step(sys.spf);
    render();
    loopId = requestAnimationFrame(frame);
  }

  function load(bodies, opts) {
    opts = opts || {};
    if (!Array.isArray(bodies) || bodies.length < 2 || bodies.length > 8) {
      throw new RangeError('load needs an array of 2 to 8 bodies');
    }
    sys.G = Number(opts.G);
    sys.dt = Number(opts.dt);
    sys.eps = /*@region:softening-read*/opts.softening === undefined ? 0 : Number(opts.softening)/*@end:softening-read*/;
    sys.bodies = bodies.map(copyBody);
    sys.steps = 0;
    sys.trails = sys.bodies.map(function () { return []; });
    sys.dirty = true;
    /*@region:pause-on-load*/
    setPlaying(false);
    /*@end:pause-on-load*/
    sizeCanvas();
    fitCamera(sys.bodies);
    sys.E0 = diagnostics().energy;
    render();
  }

  function state() {
    return { t: sys.steps * sys.dt, bodies: sys.bodies.map(copyBody) };
  }

  // ----- presets -----------------------------------------------------------

  function twoBody(G, m1, m2, a, e) {
    var M = m1 + m2;
    var rp = a * (1 - e);
    var vp = Math.sqrt(G * M * (1 + e) / (a * (1 - e)));
    return [
      { m: m1, x: -m2 / M * rp, y: 0, vx: 0, vy: -m2 / M * vp },
      { m: m2, x: m1 / M * rp, y: 0, vx: 0, vy: m1 / M * vp }
    ];
  }

  var PRESETS = {
    'figure-eight': function () {
      return {
        bodies: [
          { m: 1, x: 0.97000436, y: -0.24308753, vx: 0.46620369, vy: 0.43236573 },
          { m: 1, x: -0.97000436, y: 0.24308753, vx: 0.46620369, vy: 0.43236573 },
          { m: 1, x: 0, y: 0, vx: -0.93240737, vy: -0.86473146 }
        ],
        opts: { G: 1, dt: 0.001 },
        spf: 8
      };
    },
    'star-two-planets': function () {
      var star = { m: 1, x: 0, y: 0, vx: 0, vy: 0 };
      var p1 = { m: 0.001, x: 1, y: 0, vx: 0, vy: 1 };
      var p2 = { m: 0.0005, x: 2.2, y: 0, vx: 0, vy: Math.sqrt(1 / 2.2) };
      star.vx = -(p1.m * p1.vx + p2.m * p2.vx) / star.m;
      star.vy = -(p1.m * p1.vy + p2.m * p2.vy) / star.m;
      return { bodies: [star, p1, p2], opts: { G: 1, dt: 0.002 }, spf: 8 };
    },
    'eccentric-binary': function () {
      return { bodies: twoBody(1, 1, 1, 1, 0.8), opts: { G: 1, dt: 0.004 }, spf: 6 };
    }
  };

  function loadPreset(name) {
    var make = PRESETS[name] || PRESETS['figure-eight'];
    var preset = make();
    currentPreset = PRESETS[name] ? name : 'figure-eight';
    sys.spf = preset.spf;
    load(preset.bodies, preset.opts);
  }

  // ----- contract ----------------------------------------------------------

  window.__bench = {
    load: load,
    step: step,
    state: state,
    diagnostics: diagnostics,
    render: render,
    project: project
  };

  function bindControls() {
    document.getElementById('play-pause').addEventListener('click', function () {
      setPlaying(!playing);
    });
    document.getElementById('reset').addEventListener('click', function () {
      loadPreset(currentPreset);
      setPlaying(true);
    });
    document.getElementById('preset').addEventListener('change', function (ev) {
      loadPreset(ev.target.value);
      setPlaying(true);
    });
    window.addEventListener('resize', function () {
      sizeCanvas();
      render();
    });
  }

  function start() {
    canvas = document.getElementById('scene');
    ctx = canvas.getContext('2d');
    bindControls();
    sizeCanvas();
    loadPreset('figure-eight');
    setPlaying(true);
  }

  try {
    start();
  } catch (err) {
    var alertBox = document.getElementById('alert');
    if (alertBox) {
      alertBox.textContent = 'Orbit Lab failed to start: ' + (err && err.message ? err.message : String(err));
      alertBox.hidden = false;
    }
  }
})();
</script>
</body>
</html>`
