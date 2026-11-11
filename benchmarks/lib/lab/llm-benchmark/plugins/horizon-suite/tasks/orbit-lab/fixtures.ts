/**
 * orbit-lab fixtures. The good artifact is GOOD_SOURCE with its regions stripped.
 * Each broken fixture replaces one or two named regions of the good source with a
 * small, documented mutation, and asserts the replacement really changed the text.
 * The static fake is a page with the contract's shape and canned numbers.
 *
 * expectations lists, for each fixture, the exact check names it must fail. A good
 * fixture must fail nothing; the static fake must fail everything.
 */
import { GOOD_SOURCE } from './good-source'
import { FREE_DRIFT_CHEAT } from './cheats'

/** Remove the region markers, leaving the plain artifact. */
export function stripMarkers(source: string): string {
  return source.replace(/\/\*@(?:region|end):[A-Za-z0-9_-]+\*\//g, '')
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Replace the text inside the region `name` with `replacement`. The region must
 * occur exactly once, and the replacement must differ from the text it replaces.
 */
export function replaceRegion(source: string, name: string, replacement: string): string {
  const open = `/*@region:${name}*/`
  const close = `/*@end:${name}*/`
  if (count(source, open) !== 1 || count(source, close) !== 1) {
    throw new Error(`region ${name} must occur exactly once (found ${count(source, open)} opens, ${count(source, close)} closes)`)
  }
  const start = source.indexOf(open) + open.length
  const end = source.indexOf(close)
  if (end < start) throw new Error(`region ${name} closes before it opens`)
  const original = source.slice(start, end)
  if (original === replacement) throw new Error(`mutation of ${name} does not change the text`)
  return source.slice(0, start) + replacement + source.slice(end)
}

/** The good artifact, as published: no region markers. */
export const goodArtifact: string = stripMarkers(GOOD_SOURCE)

// ---------------------------------------------------------------------------
// Mutations. Each is documented with the reason it must fail exactly its checks.
// ---------------------------------------------------------------------------

/** Pause-on-load removed: load() leaves the animation loop stepping. */
const UNPAUSED = replaceRegion(GOOD_SOURCE, 'pause-on-load', '')

/** Acceleration uses G = 1 whatever opts.G is; diagnostics still use opts.G. */
const G_IGNORED = replaceRegion(GOOD_SOURCE, 'force-gravity', '1')

/** Velocity Verlet in place of the Yoshida composition. Symmetric, so reversible; not fourth order. */
const VERLET = replaceRegion(GOOD_SOURCE, 'integrator', '        verlet(dt);\n    ')

/** Classical RK4 in place of the symplectic step: energy stays good, Lz and reversal drift. */
const RK4 = replaceRegion(
  GOOD_SOURCE,
  'integrator',
  `
    var rkBodies = function (s, k, f) {
      return s.map(function (b, i) {
        return { m: b.m, x: b.x + k[i][0] * f, y: b.y + k[i][1] * f, vx: b.vx + k[i][2] * f, vy: b.vy + k[i][3] * f };
      });
    };
    var rkSlope = function (s) {
      var a = accelerations(s, sys.G, sys.eps);
      return s.map(function (b, i) { return [b.vx, b.vy, a[i][0], a[i][1]]; });
    };
    var s0 = sys.bodies.map(copyBody);
    var k1 = rkSlope(s0);
    var k2 = rkSlope(rkBodies(s0, k1, dt / 2));
    var k3 = rkSlope(rkBodies(s0, k2, dt / 2));
    var k4 = rkSlope(rkBodies(s0, k3, dt));
    for (var q = 0; q < sys.bodies.length; q++) {
      sys.bodies[q].x = s0[q].x + dt / 6 * (k1[q][0] + 2 * k2[q][0] + 2 * k3[q][0] + k4[q][0]);
      sys.bodies[q].y = s0[q].y + dt / 6 * (k1[q][1] + 2 * k2[q][1] + 2 * k3[q][1] + k4[q][1]);
      sys.bodies[q].vx = s0[q].vx + dt / 6 * (k1[q][2] + 2 * k2[q][2] + 2 * k3[q][2] + k4[q][2]);
      sys.bodies[q].vy = s0[q].vy + dt / 6 * (k1[q][3] + 2 * k2[q][3] + 2 * k3[q][3] + k4[q][3]);
    }
    `
)

/** Each step subtracts the centre of mass from the positions. */
const RECENTRE = replaceRegion(
  GOOD_SOURCE,
  'recentre',
  `
    var cmx = 0;
    var cmy = 0;
    var mtot = 0;
    for (var q = 0; q < sys.bodies.length; q++) {
      cmx += sys.bodies[q].m * sys.bodies[q].x;
      cmy += sys.bodies[q].m * sys.bodies[q].y;
      mtot += sys.bodies[q].m;
    }
    cmx /= mtot;
    cmy /= mtot;
    for (q = 0; q < sys.bodies.length; q++) {
      sys.bodies[q].x -= cmx;
      sys.bodies[q].y -= cmy;
    }
    `
)

/** Plummer softening dropped from the force; the potential in diagnostics() keeps it. */
const NO_SOFTENING = replaceRegion(GOOD_SOURCE, 'force-eps', '0')

/** diagnostics().com is the plain average of the positions. */
const COM_UNWEIGHTED = replaceRegion(
  GOOD_SOURCE,
  'diag-com',
  `
    var ux = 0;
    var uy = 0;
    for (i = 0; i < n; i++) {
      ux += bodies[i].x;
      uy += bodies[i].y;
    }
    comX = ux / n;
    comY = uy / n;
    `
)

/** HUD prints toFixed(2). */
const HUD_PRECISION = replaceRegion(GOOD_SOURCE, 'hud-number', 'return v.toFixed(2);')

/** Camera fixed at 40 px per unit, centred on the origin. */
const FIXED_ZOOM = replaceRegion(GOOD_SOURCE, 'camera-fit', 'cam.cx = 0; cam.cy = 0; cam.k = 40;')

/** Every body drawn white. */
const ONE_COLOUR = replaceRegion(GOOD_SOURCE, 'body-colour', "'#ffffff'")

/**
 * Trails by translucent fade: the frame is not cleared but painted over with a
 * translucent rectangle, and each render draws only the segment from the last
 * rendered position. Old points fade, render() is not idempotent, and trails
 * survive a load (the segment state lives on window and is not reset).
 */
const FADE_TRAILS = replaceRegion(
  replaceRegion(
    GOOD_SOURCE,
    'render-clear',
    `
    ctx.fillStyle = 'rgba(7, 11, 22, 0.08)';
    ctx.fillRect(0, 0, W, H);
    `
  ),
  'render-trails',
  `
    var fadeLast = window.__fadeLast || (window.__fadeLast = []);
    for (var k2 = 0; k2 < sys.bodies.length; k2++) {
      var pp = project(sys.bodies[k2].x, sys.bodies[k2].y);
      var prev = fadeLast[k2];
      if (prev) {
        ctx.strokeStyle = PALETTE[k2 % PALETTE.length];
        ctx.lineWidth = Math.max(2, 2 * dpr);
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(pp[0], pp[1]);
        ctx.stroke();
      }
      fadeLast[k2] = pp;
    }
    `
)

/** Softening read as Number(opts.softening): an omitted softening is NaN, not 0. */
const NAN_SOFTENING = replaceRegion(GOOD_SOURCE, 'softening-read', 'Number(opts.softening)')

/**
 * Cheat: a rigid spin. The integrator is replaced by a rigid rotation about the centre
 * of mass at omega = Lz / I, with the centre of mass drifting at its velocity. No force
 * is evaluated, so every conserved quantity is kept exactly and no trajectory is followed.
 */
const RIGID_BODY = replaceRegion(
  GOOD_SOURCE,
  'integrator',
  `
    (function () {
      var b = sys.bodies, n = b.length, i;
      var M = 0, cx = 0, cy = 0, px = 0, py = 0;
      for (i = 0; i < n; i++) { M += b[i].m; cx += b[i].m * b[i].x; cy += b[i].m * b[i].y; px += b[i].m * b[i].vx; py += b[i].m * b[i].vy; }
      cx /= M; cy /= M; var ux = px / M, uy = py / M;
      var L = 0, I = 0;
      for (i = 0; i < n; i++) {
        var rx = b[i].x - cx, ry = b[i].y - cy, wx = b[i].vx - ux, wy = b[i].vy - uy;
        L += b[i].m * (rx * wy - ry * wx); I += b[i].m * (rx * rx + ry * ry);
      }
      var th = (I > 0 ? L / I : 0) * dt, c = Math.cos(th), s = Math.sin(th);
      var ncx = cx + ux * dt, ncy = cy + uy * dt;
      for (i = 0; i < n; i++) {
        var qx = b[i].x - cx, qy = b[i].y - cy, zx = b[i].vx - ux, zy = b[i].vy - uy;
        b[i].x = ncx + c * qx - s * qy; b[i].y = ncy + s * qx + c * qy;
        b[i].vx = ux + c * zx - s * zy; b[i].vy = uy + s * zx + c * zy;
      }
    })();
    `
)

/**
 * Cheat: trails by leaving old frames on the canvas. render() draws only the newest
 * segment and disc, returns early when the state has not changed, and wipes the canvas
 * once, on load. Nothing redraws the history, so the trail exists only as stale pixels.
 */
const SMEAR_TRAILS = replaceRegion(
  replaceRegion(
    replaceRegion(GOOD_SOURCE, 'pause-on-load', 'setPlaying(false);\n    window.__wipe = true;'),
    'render-clear',
    `
    if (window.__wipe) { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); window.__wipe = false; window.__last = null; window.__seen = -1; }
    if (window.__seen === sys.steps) { updateHud(); return; }
    window.__seen = sys.steps;
    `
  ),
  'render-trails',
  `
    var now = sys.bodies.map(function (b) { return project(b.x, b.y); });
    if (window.__last) {
      for (var k = 0; k < now.length; k++) {
        ctx.strokeStyle = PALETTE[k % PALETTE.length];
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(window.__last[k][0], window.__last[k][1]);
        ctx.lineTo(now[k][0], now[k][1]);
        ctx.stroke();
      }
    }
    window.__last = now;
    `
)

/**
 * Conforming variant: the camera fits the width and the height separately (a contain
 * fit with an 8% pad), so on a landscape canvas the scale is limited by the shorter axis
 * for a binary along y and by the width for a binary along x.
 */
const CONTAIN_FIT = replaceRegion(
  GOOD_SOURCE,
  'camera-fit',
  `
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
    var pad = 0.08 * Math.min(W, H);
    var spanX = Math.max(maxX - minX, 1e-12);
    var spanY = Math.max(maxY - minY, 1e-12);
    cam.cx = (minX + maxX) / 2;
    cam.cy = (minY + maxY) / 2;
    cam.k = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    `
)

/**
 * Conforming variant: the header stays in normal flow and the stage is 100vh tall, so the
 * canvas extends below the fold while covering more than half of the window.
 */
const LAYOUT_SCROLL = replaceRegion(replaceRegion(GOOD_SOURCE, 'body-layout', ''), 'stage-size', 'height: 100vh;')

/** Control: velocity Verlet with 16 sub-steps per step. Passes the absolute bounds, fails the ratio. */
const VERLET16 = replaceRegion(
  GOOD_SOURCE,
  'integrator',
  `
    for (var s = 0; s < 16; s++) verlet(dt / 16);
    `
)

/** Control: explicit Euler. Fails the integrator checks, passes the contract and drawing checks. */
const EULER = replaceRegion(
  GOOD_SOURCE,
  'integrator',
  `
    var ea = accelerations(sys.bodies, sys.G, sys.eps);
    for (var q = 0; q < sys.bodies.length; q++) {
      sys.bodies[q].x += sys.bodies[q].vx * dt;
      sys.bodies[q].y += sys.bodies[q].vy * dt;
      sys.bodies[q].vx += ea[q][0] * dt;
      sys.bodies[q].vy += ea[q][1] * dt;
    }
    `
)

/**
 * Control: a static picture. Its __bench returns canned numbers and never advances,
 * its canvas is blank, and its HUD shows fixed text.
 */
const STATIC_FAKE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbit Lab</title>
<style>
html, body { margin: 0; height: 100%; background: #05080f; color: #e8ecf5; font-family: system-ui, sans-serif; }
canvas#scene { display: block; width: 100%; height: 70vh; background: #070b16; }
button, select { font: inherit; margin: 8px; }
</style>
</head>
<body>
<button id="play-pause" type="button" aria-pressed="false">Play</button>
<button id="reset" type="button">Reset</button>
<select id="preset"><option value="figure-eight">Figure-eight</option></select>
<canvas id="scene"></canvas>
<p><span id="hud-time">0.5000000</span> <span id="hud-energy">-1.000000</span> <span id="hud-angmom">1.000000</span> <span id="hud-drift">0.0</span></p>
<script>
(function () {
  var fixed = { t: 0.5, bodies: [{ m: 1, x: 0, y: 0, vx: 0, vy: 0 }, { m: 1, x: 1, y: 0, vx: 0, vy: 1 }, { m: 1, x: -1, y: 0, vx: 0, vy: -1 }] };
  window.__bench = {
    load: function () {},
    step: function () {},
    state: function () { return { t: fixed.t, bodies: fixed.bodies.map(function (b) { return { m: b.m, x: b.x, y: b.y, vx: b.vx, vy: b.vy }; }) }; },
    diagnostics: function () { return { kinetic: 1, potential: -1, energy: 0, angularMomentum: 1, momentum: [0, 0], com: [0, 0] }; },
    render: function () {},
    project: function () { return [0, 0]; }
  };
})();
</script>
</body>
</html>`

export interface Fixture {
  name: string
  kind: 'good' | 'broken' | 'static'
  html: string
  /** What the fixture is, and the check it is meant to fail. */
  note: string
}

export const fixtures: Fixture[] = [
  { name: 'orbit-good', kind: 'good', html: goodArtifact, note: 'The reference solution: Yoshida-4, pairwise softened gravity, auto-fit camera, history trails.' },
  { name: 'orbit-broken-unpaused', kind: 'broken', html: stripMarkers(UNPAUSED), note: 'load() leaves the loop stepping. Only orbit-contract-paused should fail.' },
  { name: 'orbit-broken-g-ignored', kind: 'broken', html: stripMarkers(G_IGNORED), note: 'Acceleration uses G = 1; diagnostics keep opts.G. Only orbit-kepler-period should fail.' },
  { name: 'orbit-broken-verlet', kind: 'broken', html: stripMarkers(VERLET), note: 'Velocity Verlet. Only orbit-energy-fourth-order should fail (symmetric, so the structure check passes).' },
  { name: 'orbit-broken-rk4', kind: 'broken', html: stripMarkers(RK4), note: 'Classical RK4. Only orbit-symplectic-reversible should fail (Lz drift, reversal).' },
  { name: 'orbit-broken-recentre', kind: 'broken', html: stripMarkers(RECENTRE), note: 'Each step re-centres the positions. Only orbit-momentum-com should fail.' },
  { name: 'orbit-broken-no-softening', kind: 'broken', html: stripMarkers(NO_SOFTENING), note: 'Force ignores softening, the potential keeps it. Only orbit-softening-reference should fail.' },
  { name: 'orbit-broken-com-unweighted', kind: 'broken', html: stripMarkers(COM_UNWEIGHTED), note: 'diagnostics().com is the plain average. Only orbit-diagnostics should fail.' },
  { name: 'orbit-broken-hud-precision', kind: 'broken', html: stripMarkers(HUD_PRECISION), note: 'HUD prints toFixed(2). Only orbit-hud-numbers should fail.' },
  { name: 'orbit-broken-fixed-zoom', kind: 'broken', html: stripMarkers(FIXED_ZOOM), note: 'Camera fixed at 40 px per unit. Only orbit-view-fit should fail.' },
  { name: 'orbit-broken-one-colour', kind: 'broken', html: stripMarkers(ONE_COLOUR), note: 'Every body white. Only orbit-bodies-drawn should fail.' },
  { name: 'orbit-broken-fade-trails', kind: 'broken', html: stripMarkers(FADE_TRAILS), note: 'Trails by translucent fade. Only orbit-trails-history should fail.' },
  { name: 'orbit-broken-smear-trails', kind: 'broken', html: stripMarkers(SMEAR_TRAILS), note: 'Trails by leaving old frames on the canvas: segments only, no stored history. Only orbit-trails-history should fail.' },
  { name: 'orbit-broken-nan-softening', kind: 'broken', html: stripMarkers(NAN_SOFTENING), note: 'Softening read as Number(opts.softening), so an omitted softening is NaN. Every check that steps a system loaded without softening must fail.' },
  { name: 'orbit-cheat-rigid-body', kind: 'broken', html: stripMarkers(RIGID_BODY), note: 'Rigid spin about the centre of mass with drift, no force evaluated. Must fail the five dynamics checks; the contract, formula, drawing, camera and trail checks pass, as they test the state, not the integrator.' },
  { name: 'orbit-cheat-free-drift', kind: 'broken', html: FREE_DRIFT_CHEAT, note: 'The contract with no physics: free drift, constant diagnostics, nothing drawn. Must fail the dynamics checks and the checks that compare its numbers or pixels with the formulas.' },
  { name: 'orbit-good-contain-fit', kind: 'good', html: stripMarkers(CONTAIN_FIT), note: 'Conforming: the camera fits each axis separately (contain). Must score 100.' },
  { name: 'orbit-good-scroll-layout', kind: 'good', html: stripMarkers(LAYOUT_SCROLL), note: 'Conforming: header in normal flow and a 100vh stage, so the canvas extends below the fold. Must score 100.' },
  { name: 'orbit-control-verlet-substep16', kind: 'broken', html: stripMarkers(VERLET16), note: 'Verlet with 16 sub-steps. Only orbit-energy-fourth-order should fail (ratio 4.00).' },
  { name: 'orbit-control-euler', kind: 'broken', html: stripMarkers(EULER), note: 'Explicit Euler. Fails kepler, energy, symplectic and softening; passes the other seven.' },
  { name: 'orbit-control-static-fake', kind: 'static', html: STATIC_FAKE, note: 'Canned numbers, no behaviour. Must score 0 of 100.' },
]

/** The broken variants: one per documented mutation (controls included). */
export const brokenArtifacts: Fixture[] = fixtures.filter((f) => f.kind === 'broken')

/** For each fixture: 'good', 'static', or the exact names of the checks that must fail. */
export const expectations: Record<string, 'good' | 'static' | string[]> = {
  'orbit-good': 'good',
  'orbit-broken-unpaused': ['orbit-contract-paused'],
  'orbit-broken-g-ignored': ['orbit-kepler-period'],
  'orbit-broken-verlet': ['orbit-energy-fourth-order'],
  'orbit-broken-rk4': ['orbit-symplectic-reversible'],
  'orbit-broken-recentre': ['orbit-momentum-com'],
  'orbit-broken-no-softening': ['orbit-softening-reference'],
  'orbit-broken-com-unweighted': ['orbit-diagnostics'],
  'orbit-broken-hud-precision': ['orbit-hud-numbers'],
  'orbit-broken-fixed-zoom': ['orbit-view-fit'],
  'orbit-broken-one-colour': ['orbit-bodies-drawn'],
  'orbit-broken-fade-trails': ['orbit-trails-history'],
  'orbit-broken-smear-trails': ['orbit-trails-history'],
  'orbit-broken-nan-softening': [
    'orbit-contract-paused',
    'orbit-kepler-period',
    'orbit-energy-fourth-order',
    'orbit-symplectic-reversible',
    'orbit-momentum-com',
    'orbit-hud-numbers',
    'orbit-trails-history',
  ],
  'orbit-cheat-rigid-body': [
    'orbit-kepler-period',
    'orbit-energy-fourth-order',
    'orbit-symplectic-reversible',
    'orbit-momentum-com',
    'orbit-softening-reference',
  ],
  'orbit-cheat-free-drift': [
    'orbit-kepler-period',
    'orbit-energy-fourth-order',
    'orbit-symplectic-reversible',
    'orbit-momentum-com',
    'orbit-softening-reference',
    'orbit-diagnostics',
    'orbit-hud-numbers',
    'orbit-bodies-drawn',
    'orbit-trails-history',
  ],
  'orbit-good-contain-fit': 'good',
  'orbit-good-scroll-layout': 'good',
  'orbit-control-verlet-substep16': ['orbit-energy-fourth-order'],
  'orbit-control-euler': [
    'orbit-kepler-period',
    'orbit-energy-fourth-order',
    'orbit-symplectic-reversible',
    'orbit-softening-reference',
  ],
  'orbit-control-static-fake': 'static',
}
