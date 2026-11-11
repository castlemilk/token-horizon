/**
 * Fixtures for rlc-response-lab: the reference artifact, ten targeted mutants of
 * it, and a static fake. Each mutant replaces one marked region of the good
 * source (see replaceRegion) and documents the defect it models.
 *
 * The good artifact is also the reference solution, so it is written as a careful
 * engineer would write it: closed forms with an explicit critical branch, a stable
 * overdamped branch, exact peak formula, sampling that inserts f0 and the peak
 * frequencies, decade auto-range and a rollover-safe formatter. It keeps the
 * prompt's contract and nothing else.
 */
import { readFileSync } from 'node:fs'
import type { Expectation, FixtureSpec } from '../../lib/fixture-matrix'

/* eslint-disable no-useless-escape */
const GOOD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RLC Response Lab</title>
<style>
:root {
  --bg: #0b0f14; --panel: #121923; --panel-2: #17202c; --line: #263345; --text: #e6edf5; --muted: #8fa0b5;
  --accent: #5ec2ff; --phase: #c792ea; --step: #7ee787; --warn: #ffb86b; --grid: #1d2836; --plot: #0e1520;
}
:root[data-theme="dark"] { color-scheme: dark; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { box-sizing: border-box; padding: 12px 16px; }
header h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0.01em; }
header p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
.layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; margin-top: 10px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.plots { display: grid; gap: 12px; min-width: 0; }
.plot h2 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
#schematic { width: 100%; height: auto; display: block; }
.wire { fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
.el { fill: none; stroke: var(--muted); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.el.sel { stroke: var(--warn); stroke-width: 4; }
.src { fill: var(--panel-2); stroke: var(--accent); stroke-width: 2; }
.sch-text { fill: var(--muted); font-size: 11px; }
#sch-label { fill: var(--warn); font-size: 12px; font-weight: 600; }
.row { margin-top: 12px; }
.row label { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); }
.row .val { font-variant-numeric: tabular-nums; color: var(--text); }
.row input[type=range] { width: 100%; margin: 4px 0 0; accent-color: var(--accent); }
.row select { width: 100%; margin-top: 4px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); font: inherit; }
dl.readouts { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 14px 0 0; font-size: 13px; }
dl.readouts dt { color: var(--muted); }
dl.readouts dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
svg.plotsvg { width: 100%; height: auto; display: block; }
.plot-area { fill: var(--plot); stroke: var(--line); stroke-width: 1; }
.grid { stroke: var(--grid); stroke-width: 1; }
.decade { stroke: #2b3b52; stroke-width: 1; }
.guide { stroke: var(--warn); stroke-width: 1; stroke-dasharray: 4 4; opacity: 0.6; }
.tick { fill: var(--muted); font-size: 11px; }
#bode-gain { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
#bode-phase { fill: none; stroke: var(--phase); stroke-width: 1.8; stroke-linejoin: round; }
#step-curve { fill: none; stroke: var(--step); stroke-width: 2; stroke-linejoin: round; }
#fatal { margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; background: #3a1d1d; color: #ffd2d2; font-size: 13px; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div id="fatal" role="alert" hidden></div>
<header>
  <h1>RLC Response Lab</h1>
  <p>A series RLC loop driven by an ideal source. The output is the voltage across the selected element.</p>
</header>
<main class="layout">
  <section class="panel" aria-label="Circuit">
    <svg id="schematic" viewBox="0 0 260 150" role="img" aria-label="Series loop: source, R, L and C">
      <path class="wire" d="M30 59 V30 H70"></path>
      <path class="wire" d="M130 30 H230 V50"></path>
      <path class="wire" d="M230 100 V120 H136"></path>
      <path class="wire" d="M124 120 H30 V91"></path>
      <circle class="src" cx="30" cy="75" r="16"></circle>
      <text class="sch-text" x="30" y="79" text-anchor="middle">Vin</text>
      <g id="sch-R" class="el"><path d="M70 30 L75 23 L85 37 L95 23 L105 37 L115 23 L125 37 L130 30"></path></g>
      <g id="sch-L" class="el"><path d="M230 50 a6 6 0 0 1 0 12 a6 6 0 0 1 0 12 a6 6 0 0 1 0 12 a6 6 0 0 1 0 12"></path></g>
      <g id="sch-C" class="el"><path d="M136 106 V134"></path><path d="M124 106 V134"></path></g>
      <text class="sch-text" x="100" y="18" text-anchor="middle">R</text>
      <text class="sch-text" x="246" y="78">L</text>
      <text class="sch-text" x="130" y="146" text-anchor="middle">C</text>
      <text id="sch-label" x="130" y="10" text-anchor="middle">Vout across C</text>
    </svg>
    <div class="row">
      <label for="slider-r">Resistance R <span class="val" id="val-r"></span></label>
      <input type="range" id="slider-r" min="0" max="1000" step="any">
    </div>
    <div class="row">
      <label for="slider-l">Inductance L <span class="val" id="val-l"></span></label>
      <input type="range" id="slider-l" min="0" max="1000" step="any">
    </div>
    <div class="row">
      <label for="slider-c">Capacitance C <span class="val" id="val-c"></span></label>
      <input type="range" id="slider-c" min="0" max="1000" step="any">
    </div>
    <div class="row">
      <label for="output">Output across</label>
      <select id="output">
        <option value="C">C (capacitor)</option>
        <option value="R">R (resistor)</option>
        <option value="L">L (inductor)</option>
      </select>
    </div>
    <dl class="readouts">
      <dt>f0</dt><dd><span id="readout-f0"></span></dd>
      <dt>Bandwidth</dt><dd><span id="readout-bw"></span></dd>
      <dt>Q</dt><dd><span id="readout-q"></span></dd>
      <dt>zeta</dt><dd><span id="readout-zeta"></span></dd>
      <dt>Regime</dt><dd><span id="readout-regime"></span></dd>
    </dl>
  </section>
  <section class="plots">
    <div class="panel plot">
      <h2>Bode plot: gain (dB) and phase</h2>
      <svg id="bode" class="plotsvg" viewBox="0 0 640 320" role="img" aria-label="Bode gain and phase of the selected output">
        <rect id="bode-area" class="plot-area" x="64" y="14" width="560" height="176"></rect>
        <g id="bode-grid"></g>
        <g id="bode-decades"></g>
        <polyline id="bode-gain" points=""></polyline>
        <rect id="bode-phase-area" class="plot-area" x="64" y="214" width="560" height="72"></rect>
        <g id="bode-phase-grid"></g>
        <polyline id="bode-phase" points=""></polyline>
      </svg>
    </div>
    <div class="panel plot">
      <h2>Step response (input 1 V)</h2>
      <svg id="step" class="plotsvg" viewBox="0 0 640 200" role="img" aria-label="Step response of the selected output">
        <rect id="step-area" class="plot-area" x="64" y="12" width="560" height="150"></rect>
        <g id="step-grid"></g>
        <polyline id="step-curve" points=""></polyline>
      </svg>
    </div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var TWO_PI = 2 * Math.PI;
  var NS = 'http://www.w3.org/2000/svg';
  var PREFIX = { '-12': 'p', '-9': 'n', '-6': 'µ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G' };
  var BODE = { x: 64, y: 14, w: 560, h: 176, py: 214, ph: 72 };
  var STEPG = { x: 64, y: 12, w: 560, h: 150 };
  var SLIDE = { R: { lo: -1, span: 6, unit: 'Ω' }, L: { lo: -6, span: 7, unit: 'H' }, C: { lo: -9, span: 6, unit: 'F' } };
  var STEP_SAMPLES = 4000;
  var state = { R: 20, L: 0.01, C: 1e-6, output: 'C' };

  function byId(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    parent.appendChild(node);
    return node;
  }

  /* ---------- closed forms ---------- */

  function regimeOf(zeta) {
    /*@begin:regime*/if (zeta < 1 - 1e-9) return 'underdamped'; if (zeta > 1 + 1e-9) return 'overdamped'; return 'critical';/*@end:regime*/
  }

  function derived(c) {
    var w0 = 1 / Math.sqrt(c.L * c.C);
    var zeta = (c.R / 2) * Math.sqrt(c.C / c.L);
    return {
      f0: w0 / TWO_PI,
      w0: w0,
      zeta: zeta,
      Q: 1 / (2 * zeta),
      regime: regimeOf(zeta),
      bw: c.R / (TWO_PI * c.L),
      a: c.R / (2 * c.L)
    };
  }

  // H(jw) = N / (1 - w^2 LC + j w RC) with N = 1 (C), j w RC (R) or -w^2 LC (L).
  function transfer(c, out, f) {
    var w = TWO_PI * f;
    var w2LC = w * w * c.L * c.C;
    var dr = 1 - w2LC;
    var di = w * c.R * c.C;
    var nr = 1;
    var ni = 0;
    if (out === 'R') { nr = 0; ni = di; } else if (out === 'L') { nr = -w2LC; ni = 0; }
    var d = dr * dr + di * di;
    return { re: (nr * dr + ni * di) / d, im: (ni * dr - nr * di) / d };
  }

  function response(c, out, f) {
    var h = transfer(c, out, f);
    /*@begin:phase*/var ph = Math.atan2(h.im, h.re) * 180 / Math.PI; if (ph <= -180) ph += 360;/*@end:phase*/
    return { gainDb: 20 * Math.log10(Math.hypot(h.re, h.im)), phaseDeg: ph };
  }

  function peakDb(c, out) {
    /*@begin:peak*/var d = derived(c); if (out === 'R' || d.zeta >= Math.SQRT1_2) return 0; return -20 * Math.log10(2 * d.zeta * Math.sqrt(1 - d.zeta * d.zeta));/*@end:peak*/
  }

  function overshootPct(c) {
    var d = derived(c);
    if (d.zeta >= 1) return 0;
    return 100 * Math.exp(-Math.PI * d.zeta / Math.sqrt(1 - d.zeta * d.zeta));
  }

  function stepAt(c, out, t) {
    if (t < 0) return 0;
    var d = derived(c);
    var a = d.a;
    var w0 = d.w0;
    var e;
    if (/*@begin:step-branch*/d.regime === 'underdamped'/*@end:step-branch*/) {
      var wd = w0 * Math.sqrt(1 - d.zeta * d.zeta);
      e = Math.exp(-a * t);
      var x = wd * t;
      var s = Math.sin(x);
      var co = Math.cos(x);
      var k = a / wd;
      if (out === 'C') return 1 - e * (co + k * s);
      if (out === 'R') return /*@begin:vr-step*/(2 * a / wd) * e * s/*@end:vr-step*/;
      return e * (co - k * s);
    }
    if (d.regime === 'critical') {
      e = Math.exp(-a * t);
      if (out === 'C') return 1 - e * (1 + a * t);
      if (out === 'R') return 2 * a * t * e;
      return e * (1 - a * t);
    }
    // Overdamped: the slow root is written without cancellation, s1 = -w0 / (zeta + root).
    /*@begin:over-branch*/var root = Math.sqrt(d.zeta * d.zeta - 1);
    var s1 = -w0 / (d.zeta + root);
    var s2 = -w0 * (d.zeta + root);
    var den = s1 - s2;
    var e1 = Math.exp(s1 * t);
    var e2 = Math.exp(s2 * t);
    if (out === 'C') return 1 + (s2 * e1 - s1 * e2) / den;
    if (out === 'R') return (c.R / c.L) * (e1 - e2) / den;
    return (s1 * e1 - s2 * e2) / den;/*@end:over-branch*/
  }

  function tauOf(c) {
    var d = derived(c);
    if (d.zeta <= 1) return 2 * c.L / c.R;
    return (d.zeta + Math.sqrt(d.zeta * d.zeta - 1)) / d.w0;
  }

  /* ---------- engineering and plain formatting ---------- */

  function engFormat(value, unit) {
    var e = Math.floor(Math.log10(value) / 3) * 3;
    if (e < -12) e = -12;
    if (e > 9) e = 9;
    var m = value / Math.pow(10, e);
    var s;
    /*@begin:rollover*/
    if (m < 1 && e > -12) { e -= 3; m = value / Math.pow(10, e); }
    s = m.toPrecision(4);
    if (parseFloat(s) >= 1000 && e < 9) { e += 3; s = (value / Math.pow(10, e)).toPrecision(4); }
    /*@end:rollover*/
    return s + ' ' + PREFIX[String(e)] + unit;
  }

  function sig4(v) {
    var a = Math.abs(v);
    var e = Math.floor(Math.log10(a));
    var d = 3 - e;
    var s;
    if (d >= 0) {
      s = a.toFixed(d);
      if (parseFloat(s) >= Math.pow(10, e + 1)) { e += 1; d = 3 - e; }
    }
    if (d >= 0) {
      s = a.toFixed(d);
    } else {
      var p = Math.pow(10, -d);
      s = String(Math.round(a / p) * p);
    }
    return (v < 0 ? '-' : '') + s;
  }

  function axisLabel(f) {
    if (f >= 1e6) return Number((f / 1e6).toPrecision(6)) + ' MHz';
    if (f >= 1e3) return Number((f / 1e3).toPrecision(6)) + ' kHz';
    if (f >= 1) return Number(f.toPrecision(6)) + ' Hz';
    if (f >= 1e-3) return Number((f * 1e3).toPrecision(6)) + ' mHz';
    return Number(f.toPrecision(6)) + ' Hz';
  }

  /* ---------- Bode sampling and mapping ---------- */

  function bodeRange(d) {
    return /*@begin:axis*/{ lo: Math.floor(Math.log10(d.f0 / 30)), hi: Math.ceil(Math.log10(30 * d.f0)) }/*@end:axis*/;
  }

  function bodeFrequencies(d, r) {
    /*@begin:sampling*/
    var fs = [];
    var n = 480;
    for (var i = 0; i < n; i++) fs.push(Math.pow(10, r.lo + (r.hi - r.lo) * i / (n - 1)));
    fs.push(d.f0);
    if (d.zeta < Math.SQRT1_2) {
      var k = Math.sqrt(1 - 2 * d.zeta * d.zeta);
      fs.push(d.f0 * k, d.f0 / k);
    }
    [0.25, 0.5, 1, 2, 4].forEach(function (m) {
      fs.push(d.f0 * (1 + m * d.zeta), d.f0 * (1 - m * d.zeta));
    });
    var fLo = Math.pow(10, r.lo);
    var fHi = Math.pow(10, r.hi);
    fs = fs.filter(function (f) { return f > fLo && f < fHi; });
    fs.push(fLo, fHi);
    fs.sort(function (p, q) { return p - q; });
    var out = [];
    fs.forEach(function (f) {
      if (out.length === 0 || f > out[out.length - 1] * (1 + 1e-12)) out.push(f);
    });
    return out;
    /*@end:sampling*/
  }

  function vertexX(f, r) {
    return /*@begin:vertex-x*/BODE.x + (Math.log10(f) - r.lo) / (r.hi - r.lo) * BODE.w/*@end:vertex-x*/;
  }

  function unwrap(list) {
    var out = [list[0]];
    for (var i = 1; i < list.length; i++) {
      var p = list[i];
      while (p - out[i - 1] > 180) p -= 360;
      while (p - out[i - 1] < -180) p += 360;
      out.push(p);
    }
    return out;
  }

  function drawBode(c) {
    var d = derived(c);
    var r = bodeRange(d);
    var fmin = Math.pow(10, r.lo);
    var fmax = Math.pow(10, r.hi);
    var freqs = bodeFrequencies(d, r);
    var rows = freqs.map(function (f) { return response(c, c.output, f); });
    var minDb = Infinity;
    var maxDb = -Infinity;
    rows.forEach(function (row) {
      minDb = Math.min(minDb, row.gainDb);
      maxDb = Math.max(maxDb, row.gainDb);
    });
    var dbmin = Math.floor((minDb - 1) / 10) * 10;
    var dbmax = Math.ceil((maxDb + 1) / 10) * 10;
    var phases = unwrap(rows.map(function (row) { return row.phaseDeg; }));
    var pmin = Math.min.apply(null, phases);
    var pmax = Math.max.apply(null, phases);
    var plo = Math.floor(pmin / 90) * 90;
    var phi = Math.ceil(pmax / 90) * 90;
    if (phi <= plo) phi = plo + 90;

    var svg = byId('bode');
    svg.setAttribute('data-fmin', String(fmin));
    svg.setAttribute('data-fmax', String(fmax));
    svg.setAttribute('data-dbmin', String(dbmin));
    svg.setAttribute('data-dbmax', String(dbmax));

    var gainY = function (db) { return BODE.y + (dbmax - db) / (dbmax - dbmin) * BODE.h; };
    var phaseY = function (p) { return BODE.py + (phi - p) / (phi - plo) * BODE.ph; };
    var decadeX = function (k) { return BODE.x + (k - r.lo) / (r.hi - r.lo) * BODE.w; };

    var gainPts = [];
    var phasePts = [];
    freqs.forEach(function (f, i) {
      var x = vertexX(f, r).toFixed(2);
      gainPts.push(x + ',' + gainY(rows[i].gainDb).toFixed(2));
      phasePts.push(x + ',' + phaseY(phases[i]).toFixed(2));
    });
    byId('bode-gain').setAttribute('points', gainPts.join(' '));
    byId('bode-phase').setAttribute('points', phasePts.join(' '));

    var grid = byId('bode-grid');
    clear(grid);
    var dbStep = (dbmax - dbmin) <= 90 ? 10 : 20;
    for (var g = Math.ceil(dbmin / dbStep) * dbStep; g <= dbmax; g += dbStep) {
      var gy = gainY(g).toFixed(2);
      svgEl('line', { class: 'grid', x1: BODE.x, x2: BODE.x + BODE.w, y1: gy, y2: gy }, grid);
      svgEl('text', { class: 'tick', x: BODE.x - 6, y: gy, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid).textContent = g + ' dB';
    }

    var pgrid = byId('bode-phase-grid');
    clear(pgrid);
    for (var p = plo; p <= phi; p += 90) {
      var py = phaseY(p).toFixed(2);
      svgEl('line', { class: 'grid', x1: BODE.x, x2: BODE.x + BODE.w, y1: py, y2: py }, pgrid);
      svgEl('text', { class: 'tick', x: BODE.x - 6, y: py, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, pgrid).textContent = p + '°';
    }

    var dec = byId('bode-decades');
    clear(dec);
    for (var k = r.lo; k <= r.hi; k++) {
      var dx = decadeX(k).toFixed(2);
      svgEl('line', { class: 'decade', 'data-f': String(Math.pow(10, k)), x1: dx, x2: dx, y1: BODE.y, y2: BODE.y + BODE.h }, dec);
      var nearRight = Number(dx) > BODE.x + BODE.w - 60;
      svgEl('text', { class: 'tick', x: nearRight ? Number(dx) - 3 : Number(dx) + 3, y: BODE.y + BODE.h - 5, 'text-anchor': nearRight ? 'end' : 'start' }, dec).textContent = axisLabel(Math.pow(10, k));
    }
  }

  /* ---------- step plot ---------- */

  function drawStep(c) {
    var tau = tauOf(c);
    var tmax = /*@begin:tmax*/10 * tau/*@end:tmax*/;
    var ts = [];
    var vs = [];
    for (var i = 0; i < STEP_SAMPLES; i++) {
      var t = tmax * i / (STEP_SAMPLES - 1);
      ts.push(t);
      vs.push(stepAt(c, c.output, t));
    }
    var lo = Math.min(0, Math.min.apply(null, vs));
    var hi = Math.max(1, Math.max.apply(null, vs));
    var pad = 0.06 * (hi - lo);
    /*@begin:step-window*/var vmin = lo - pad;
    var vmax = hi + pad;/*@end:step-window*/

    var svg = byId('step');
    svg.setAttribute('data-tmax', String(tmax));
    svg.setAttribute('data-vmin', String(vmin));
    svg.setAttribute('data-vmax', String(vmax));

    /*@begin:step-points*/var pts = [];
    for (var j = 0; j < STEP_SAMPLES; j++) {
      var x = STEPG.x + ts[j] / tmax * STEPG.w;
      var y = STEPG.y + (vmax - vs[j]) / (vmax - vmin) * STEPG.h;
      pts.push(x.toFixed(2) + ',' + y.toFixed(2));
    }
    byId('step-curve').setAttribute('points', pts.join(' '));/*@end:step-points*/

    var grid = byId('step-grid');
    clear(grid);
    for (var q = 0; q <= 4; q++) {
      var gx = (STEPG.x + q / 4 * STEPG.w).toFixed(2);
      svgEl('line', { class: 'grid', x1: gx, x2: gx, y1: STEPG.y, y2: STEPG.y + STEPG.h }, grid);
      svgEl('text', { class: 'tick', x: gx, y: STEPG.y + STEPG.h + 14, 'text-anchor': 'middle' }, grid).textContent = Number((tmax * q / 4 * 1e3).toPrecision(3)) + ' ms';
    }
    var yOne = (STEPG.y + (vmax - 1) / (vmax - vmin) * STEPG.h).toFixed(2);
    svgEl('line', { class: 'guide', x1: STEPG.x, x2: STEPG.x + STEPG.w, y1: yOne, y2: yOne }, grid);
    svgEl('text', { class: 'tick', x: STEPG.x + 6, y: Number(yOne) - 5 }, grid).textContent = '1 V';
  }

  /* ---------- schematic, controls and readouts ---------- */

  function drawSchematic(c) {
    ['R', 'L', 'C'].forEach(function (k) {
      byId('sch-' + k).classList.toggle('sel', c.output === k);
    });
    byId('sch-label').textContent = 'Vout across ' + c.output;
  }

  function sliderPos(name, x) {
    var pos = (Math.log10(x) - SLIDE[name].lo) / SLIDE[name].span * 1000;
    return Math.min(1000, Math.max(0, pos));
  }

  function sliderValue(name, pos) {
    return Math.pow(10, SLIDE[name].lo + SLIDE[name].span * pos / 1000);
  }

  function syncControls(c) {
    byId('slider-r').value = String(sliderPos('R', c.R));
    byId('slider-l').value = String(sliderPos('L', c.L));
    byId('slider-c').value = String(sliderPos('C', c.C));
    byId('output').value = c.output;
    byId('val-r').textContent = engFormat(c.R, SLIDE.R.unit);
    byId('val-l').textContent = engFormat(c.L, SLIDE.L.unit);
    byId('val-c').textContent = engFormat(c.C, SLIDE.C.unit);
  }

  function readouts(c) {
    var d = derived(c);
    byId('readout-f0').textContent = engFormat(d.f0, 'Hz');
    byId('readout-bw').textContent = engFormat(d.bw, 'Hz');
    byId('readout-q').textContent = sig4(d.Q);
    byId('readout-zeta').textContent = sig4(d.zeta);
    byId('readout-regime').textContent = d.regime;
  }

  function redraw() {
    syncControls(state);
    readouts(state);
    drawSchematic(state);
    drawBode(state);
    drawStep(state);
  }

  function normalise(o, base) {
    var next = { R: base.R, L: base.L, C: base.C, output: base.output };
    ['R', 'L', 'C'].forEach(function (k) {
      if (o[k] !== undefined) {
        var v = Number(o[k]);
        if (!(isFinite(v) && v > 0)) throw new RangeError(k + ' must be a positive finite number');
        next[k] = v;
      }
    });
    if (o.output !== undefined) {
      if (o.output !== 'C' && o.output !== 'R' && o.output !== 'L') throw new RangeError('output must be C, R or L');
      next.output = o.output;
    }
    return next;
  }

  function snapshot() {
    return { R: state.R, L: state.L, C: state.C, output: state.output };
  }

  /* ---------- public contract ---------- */

  window.__bench = {
    set: function (o) {
      state = normalise(o || {}, state);
      redraw();
      return snapshot();
    },
    metrics: function () {
      var d = derived(state);
      return {
        f0: d.f0,
        zeta: d.zeta,
        Q: d.Q,
        regime: d.regime,
        bandwidthHz: d.bw,
        peakDb: peakDb(state, state.output),
        overshootPct: overshootPct(state)
      };
    },
    response: function (f) {
      return response(state, state.output, f);
    },
    stepAt: function (t) {
      return stepAt(state, state.output, t);
    }
  };

  function init() {
    ['R', 'L', 'C'].forEach(function (k) {
      byId('slider-' + k.toLowerCase()).addEventListener('input', function (e) {
        var pos = Number(e.target.value);
        var o = {};
        o[k] = sliderValue(k, pos);
        state = normalise(o, state);
        redraw();
      });
    });
    byId('output').addEventListener('change', function (e) {
      state = normalise({ output: e.target.value }, state);
      redraw();
    });
    redraw();
  }

  try {
    init();
  } catch (err) {
    var box = byId('fatal');
    box.textContent = 'Startup error: ' + (err && err.message ? err.message : String(err));
    box.hidden = false;
  }
})();
</script>
</body>
</html>
`

/* eslint-enable no-useless-escape */


/** The region of the good source between /*@begin:NAME*\/ and /*@end:NAME*\/. */
function locate(src: string, name: string): { start: number; end: number; text: string } {
  const open = `/*@begin:${name}*/`
  const close = `/*@end:${name}*/`
  const a = src.indexOf(open)
  const b = src.indexOf(close)
  if (a < 0 || b < 0 || b < a || src.indexOf(open, a + 1) >= 0 || src.indexOf(close, b + 1) >= 0) {
    throw new Error(`mutation region ${name} is missing or not unique in the good source`)
  }
  const start = a + open.length
  return { start, end: b, text: src.slice(start, b) }
}

/**
 * Replace the text of one marked region of `src` with `replacement`. Throws when
 * the marker is missing or repeated, or when the replacement does not change the
 * region, so every mutant is provably a different artifact.
 */
export function replaceRegion(src: string, name: string, replacement: string): string {
  const region = locate(src, name)
  if (region.text === replacement) throw new Error(`mutation ${name} does not change the source`)
  const out = src.slice(0, region.start) + replacement + src.slice(region.end)
  if (out === src) throw new Error(`mutation ${name} produced the same artifact`)
  return out
}

/** A broken variant with the one defect it models. */
export interface BrokenArtifact extends FixtureSpec {
  /** The defect, in one line. */
  defect: string
  /** The marked region edited, when the mutant is a region edit. */
  region?: string
}

const G = GOOD_HTML

/** Replace one exact piece of text. Throws when the text is missing or repeated. */
function replaceOnce(src: string, from: string, to: string): string {
  const first = src.indexOf(from)
  if (first < 0) throw new Error(`mutation text not found: ${from.slice(0, 60)}`)
  if (src.indexOf(from, first + 1) >= 0) throw new Error(`mutation text not unique: ${from.slice(0, 60)}`)
  return src.slice(0, first) + to + src.slice(first + from.length)
}

const REDRAW_FN = `  function redraw() {
    syncControls(state);
    readouts(state);
    drawSchematic(state);
    drawBode(state);
    drawStep(state);
  }`

/** The good artifact with its redraw run later, from the given scheduler call. */
function deferredRedraw(schedule: string): string {
  return replaceOnce(
    G,
    REDRAW_FN,
    `  function redrawNow() {
    syncControls(state);
    readouts(state);
    drawSchematic(state);
    drawBode(state);
    drawStep(state);
  }
  function redraw() {
    ${schedule}
  }`
  )
}

const brokenRegionSpecs: Array<{ name: string; region: string; replacement: string; defect: string }> = [
  {
    name: 'rlc-broken-strict-critical',
    region: 'regime',
    replacement: `return zeta === 1 ? 'critical' : zeta > 1 ? 'overdamped' : 'underdamped';`,
    defect: 'regime uses zeta === 1, so NC is reported as overdamped',
  },
  {
    name: 'rlc-broken-peak-approx',
    region: 'peak',
    replacement: `return 20 * Math.log10(derived(c).Q);`,
    defect: 'peakDb = 20 log10(Q)',
  },
  {
    name: 'rlc-broken-atan-phase',
    region: 'phase',
    replacement: `var ph = Math.atan(h.im / h.re) * 180 / Math.PI;`,
    defect: 'phase from Math.atan of the ratio, losing the quadrant above resonance',
  },
  {
    name: 'rlc-broken-vr-step',
    region: 'vr-step',
    replacement: `(2 * a / wd) * e * s / c.R`,
    defect: 'resistor step response returns the current (factor R omitted)',
  },
  {
    name: 'rlc-broken-no-critical-branch',
    region: 'step-branch',
    replacement: `d.zeta <= 1`,
    defect: 'underdamped formula used whenever zeta <= 1, giving 0/0 at zeta = 1',
  },
  {
    name: 'rlc-broken-hyperbolic-overdamped',
    region: 'over-branch',
    replacement: `var b = Math.sqrt(a * a - w0 * w0);
    var ex = Math.exp(-a * t);
    var ch = Math.cosh(b * t);
    var sh = Math.sinh(b * t);
    if (out === 'C') return 1 - ex * (ch + (a / b) * sh);
    if (out === 'R') return (c.R / c.L) * ex * sh / b;
    return ex * (ch - (a / b) * sh);`,
    defect: 'overdamped step as cosh and sinh terms: overflows to NaN at zeta 40 (the stiff set)',
  },
  {
    name: 'rlc-broken-linear-x',
    region: 'vertex-x',
    replacement: `BODE.x + (f - Math.pow(10, r.lo)) / (Math.pow(10, r.hi) - Math.pow(10, r.lo)) * BODE.w`,
    defect: 'Bode vertices placed on a linear frequency axis while the axes are logarithmic',
  },
  {
    name: 'rlc-broken-fixed-axis',
    region: 'axis',
    replacement: `{ lo: 1, hi: 6 }`,
    defect: 'frequency axis fixed at 10 Hz to 1 MHz; dB auto-range intact',
  },
  {
    name: 'rlc-broken-coarse-sweep',
    region: 'sampling',
    replacement: `var fs = [];
    for (var i = 0; i < 300; i++) fs.push(Math.pow(10, r.lo + (r.hi - r.lo) * i / 299));
    return fs;`,
    defect: 'uniform 300-point log sweep with no inserted resonance points',
  },
  {
    name: 'rlc-broken-sparse-curve',
    region: 'sampling',
    replacement: `var base = [Math.pow(10, r.lo), d.f0, Math.pow(10, r.hi)];
    var out = [];
    for (var i = 0; i < 200; i++) out.push(base[Math.min(2, Math.floor(i / 67))]);
    return out;`,
    defect: 'gain drawn as three true points (fmin, f0, fmax) each repeated: on the curve, 200 vertices, no coverage',
  },
  {
    name: 'rlc-broken-fixed-tmax',
    region: 'tmax',
    replacement: `10e-3`,
    defect: 'step plot always spans 10 ms',
  },
  {
    name: 'rlc-broken-rollover',
    region: 'rollover',
    replacement: `s = m.toPrecision(4);`,
    defect: 'formatter picks the prefix before rounding and prints 1000 Hz',
  },
]

const FLAT_STEP_HTML = replaceRegion(
  replaceRegion(G, 'step-window', `var vmin = -1e6;
    var vmax = 1e6;`),
  'step-points',
  `var flat = [];
    for (var j = 0; j < STEP_SAMPLES; j++) flat.push((STEPG.x + ts[j] / tmax * STEPG.w).toFixed(2) + ',' + (STEPG.y + STEPG.h / 2).toFixed(2));
    byId('step-curve').setAttribute('points', flat.join(' '));`
)

/** Mutants made by replacing one exact piece of text (or a whole region) of the good source. */
const brokenTextSpecs: Array<{ name: string; defect: string; html: string }> = [
  {
    name: 'rlc-broken-fixed-dbmax',
    defect: 'dB top fixed at +10 dB while the bottom stays automatic: the 14.8 dB peak of U1 leaves the plot',
    html: replaceOnce(G, `var dbmax = Math.ceil((maxDb + 1) / 10) * 10;`, `var dbmax = 10;`),
  },
  {
    name: 'rlc-broken-collapsed-bode',
    defect: 'the Bode plot rectangle has zero size, so the curve and the gridlines have no area to sit in',
    html: replaceOnce(
      G,
      `<rect id="bode-area" class="plot-area" x="64" y="14" width="560" height="176"></rect>`,
      `<rect id="bode-area" class="plot-area" x="64" y="14" width="0" height="0"></rect>`
    ),
  },
  {
    name: 'rlc-broken-flat-step',
    defect: 'step curve drawn as a flat line on a +-1e6 axis: the padded range hides that the curve is wrong',
    html: FLAT_STEP_HTML,
  },
  {
    name: 'rlc-broken-clamp-micro-mega',
    defect: 'set() clamps every value to 1e-6 .. 1e6, the range the prompt used to state; the 3.9e-9 F and 1e-7 F circuits read the clamped values',
    html: replaceOnce(G, 'next[k] = v;', 'next[k] = Math.min(1e6, Math.max(1e-6, v));'),
  },
  {
    name: 'rlc-broken-output-ignored',
    defect: 'set() ignores the output selector and always selects C, so stepAt and response read C whatever is chosen',
    html: replaceOnce(G, 'next.output = o.output;', `next.output = 'C';`),
  },
  {
    name: 'rlc-broken-missing-response',
    defect: 'window.__bench.response is not defined; every other member is',
    html: replaceOnce(G, `    response: function (f) {\n      return response(state, state.output, f);\n    },\n`, ''),
  },
  {
    name: 'rlc-broken-raf-redraw',
    defect: 'redraw deferred to requestAnimationFrame, so set() leaves the drawing and readouts stale',
    html: deferredRedraw('requestAnimationFrame(redrawNow);'),
  },
  {
    name: 'rlc-broken-timeout-redraw',
    defect: 'redraw deferred to setTimeout 0, so set() leaves the drawing and readouts stale',
    html: deferredRedraw('setTimeout(redrawNow, 0);'),
  },
]

/** A page kept under variants/ (the reviewer's capacitor-only cheat: every step response reads C). */
const CAPACITOR_ONLY: BrokenArtifact = {
  name: 'rlc-cheat-capacitor-only',
  defect: 'the step response is the capacitor voltage whatever output is selected; the critical and overdamped check used to read only C',
  html: readFileSync(new URL('./variants/broken-capacitor-only.html', import.meta.url), 'utf8'),
}

export const brokenArtifacts: BrokenArtifact[] = [
  CAPACITOR_ONLY,
  ...brokenRegionSpecs.map((spec) => ({
    name: spec.name,
    html: replaceRegion(G, spec.region, spec.replacement),
    defect: spec.defect,
    region: spec.region,
  })),
  ...brokenTextSpecs.map((spec) => ({ name: spec.name, html: spec.html, defect: spec.defect })),
]

/**
 * A conforming variant that draws the decade gridlines in the phase panel as well
 * as the gain plot. The prompt asks for the gain gridlines and a separate phase
 * plot; it does not forbid gridlines in the phase panel.
 */
export const goodPhaseDecades: FixtureSpec = {
  name: 'rlc-good-phase-decades',
  html: replaceOnce(
    G,
    `    var dec = byId('bode-decades');`,
    `    var phaseDec = byId('bode-phase-grid');
    for (var pk = r.lo; pk <= r.hi; pk++) {
      var pdx = decadeX(pk).toFixed(2);
      svgEl('line', { class: 'decade', 'data-f': String(Math.pow(10, pk)), x1: pdx, x2: pdx, y1: BODE.py, y2: BODE.py + BODE.ph }, phaseDec);
    }
    var dec = byId('bode-decades');`
  ),
}

/**
 * Static fake: the right elements and plausible numbers for the default circuit
 * (zeta 0.1, Q 5), with 200-vertex curves that never change. set() does nothing,
 * so no check that compares against a set circuit can pass.
 */
function staticPage(bodeArea: string, curveScript: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RLC Response Lab</title>
<style>
html, body { margin: 0; min-height: 100%; background: #0b0f14; color: #e6edf5; font-family: system-ui, sans-serif; }
body { padding: 12px 16px; box-sizing: border-box; }
svg { width: 100%; height: auto; display: block; background: #121923; }
</style>
</head>
<body>
<h1>RLC Response Lab</h1>
<svg id="schematic" viewBox="0 0 260 150"><path d="M30 30 H230 V120 H30 Z" fill="none" stroke="#8fa0b5"></path><g id="sch-C"><path d="M136 106 V134"></path></g></svg>
<input type="range" id="slider-r" min="0" max="1000" value="500">
<input type="range" id="slider-l" min="0" max="1000" value="500">
<input type="range" id="slider-c" min="0" max="1000" value="500">
<select id="output"><option value="C" selected>C (capacitor)</option><option value="R">R (resistor)</option><option value="L">L (inductor)</option></select>
<p><span id="readout-f0">1.592 kHz</span> <span id="readout-bw">318.3 Hz</span> <span id="readout-q">5.000</span> <span id="readout-zeta">0.1000</span> <span id="readout-regime">underdamped</span></p>
<svg id="bode" viewBox="0 0 640 320" data-fmin="10" data-fmax="100000" data-dbmin="-60" data-dbmax="30">
<rect id="bode-area" x="64" y="14" ${bodeArea} fill="none" stroke="#263345"></rect>
<line class="decade" data-f="10" x1="64" x2="64" y1="14" y2="190"></line>
<line class="decade" data-f="100" x1="204" x2="204" y1="14" y2="190"></line>
<line class="decade" data-f="1000" x1="344" x2="344" y1="14" y2="190"></line>
<line class="decade" data-f="10000" x1="484" x2="484" y1="14" y2="190"></line>
<line class="decade" data-f="100000" x1="624" x2="624" y1="14" y2="190"></line>
<polyline id="bode-gain" fill="none" stroke="#5ec2ff" points=""></polyline>
<polyline id="bode-phase" fill="none" stroke="#c792ea" points="64,250 624,250"></polyline>
</svg>
<svg id="step" viewBox="0 0 640 200" data-tmax="0.00936" data-vmin="-0.1" data-vmax="1.2">
<rect id="step-area" x="64" y="12" width="560" height="150" fill="none" stroke="#263345"></rect>
<polyline id="step-curve" fill="none" stroke="#7ee787" points=""></polyline>
</svg>
<div role="alert" hidden></div>
<script>
${curveScript}
window.__bench = {
  set: function () {},
  metrics: function () { return { f0: 1591.549, zeta: 0.1, Q: 5, regime: 'underdamped', bandwidthHz: 318.31, peakDb: 14.02, overshootPct: 72.94 }; },
  response: function () { return { gainDb: 0, phaseDeg: 0 }; },
  stepAt: function () { return 0.5; }
};
</script>
</body>
</html>
`
}

const STATIC_CURVES = `(function () {
  var g = [], s = [];
  for (var i = 0; i < 200; i++) {
    g.push((64 + i * 560 / 199).toFixed(2) + ',' + (60 + 40 * Math.sin(i / 9)).toFixed(2));
    s.push((64 + i * 560 / 199).toFixed(2) + ',' + (40 + 100 * i / 199).toFixed(2));
  }
  document.getElementById('bode-gain').setAttribute('points', g.join(' '));
  document.getElementById('step-curve').setAttribute('points', s.join(' '));
})();`

const DEGENERATE_CURVES = `(function () {
  var g = [], s = [];
  for (var i = 0; i < 200; i++) { g.push('64,100'); s.push('64,100'); }
  document.getElementById('bode-gain').setAttribute('points', g.join(' '));
  document.getElementById('step-curve').setAttribute('points', s.join(' '));
})();`

export const goodArtifact: FixtureSpec = { name: 'rlc-good', html: GOOD_HTML }

export const staticFake: FixtureSpec = {
  name: 'rlc-control-static-fake',
  html: staticPage('width="560" height="176"', STATIC_CURVES),
}

/** Static, with a zero-size plot rectangle and identical vertices: nothing is drawn. */
export const staticDegenerate: FixtureSpec = {
  name: 'rlc-control-static-degenerate',
  html: staticPage('width="0" height="0"', DEGENERATE_CURVES),
}

/** Every fixture, in the order the matrix prints them. */
export const fixtures: FixtureSpec[] = [goodArtifact, goodPhaseDecades, ...brokenArtifacts, staticFake, staticDegenerate]

/**
 * What each fixture must do. A list names exactly the checks that must fail;
 * 'good' means every check passes; 'static' means nothing passes.
 */
const FIVE_DRAWN_AND_READOUT = ['rlc-bode-curve', 'rlc-bode-autorange', 'rlc-peak-resolved', 'rlc-step-plot', 'rlc-readouts']
const THREE_BODE = ['rlc-bode-curve', 'rlc-bode-autorange', 'rlc-peak-resolved']

export const expectations: Record<string, Expectation> = {
  'rlc-good': 'good',
  'rlc-good-phase-decades': 'good',
  'rlc-broken-strict-critical': ['rlc-metrics'],
  'rlc-broken-peak-approx': ['rlc-peak-overshoot'],
  'rlc-broken-atan-phase': ['rlc-response'],
  'rlc-broken-vr-step': ['rlc-step-underdamped', 'rlc-step-critical-overdamped'],
  'rlc-broken-no-critical-branch': ['rlc-step-critical-overdamped'],
  'rlc-broken-hyperbolic-overdamped': ['rlc-step-critical-overdamped'],
  'rlc-broken-linear-x': ['rlc-bode-curve'],
  'rlc-broken-fixed-axis': ['rlc-bode-autorange'],
  'rlc-broken-fixed-dbmax': ['rlc-bode-autorange'],
  'rlc-broken-collapsed-bode': THREE_BODE,
  'rlc-broken-sparse-curve': THREE_BODE,
  'rlc-broken-coarse-sweep': ['rlc-peak-resolved'],
  'rlc-broken-fixed-tmax': ['rlc-step-plot'],
  'rlc-broken-flat-step': ['rlc-step-plot'],
  'rlc-broken-rollover': ['rlc-readouts'],
  'rlc-broken-missing-response': ['rlc-response'],
  // The overshoot and critical sets all use C within 1e-6 .. 1e6, so only the sub-micro-farad sets fail.
  'rlc-broken-clamp-micro-mega': ['rlc-metrics', 'rlc-response', 'rlc-step-underdamped', 'rlc-bode-curve', 'rlc-bode-autorange', 'rlc-peak-resolved', 'rlc-step-plot', 'rlc-readouts'],
  'rlc-cheat-capacitor-only': ['rlc-peak-overshoot', 'rlc-response', 'rlc-bode-curve', 'rlc-step-underdamped', 'rlc-step-critical-overdamped'],
  'rlc-broken-output-ignored': ['rlc-peak-overshoot', 'rlc-response', 'rlc-bode-curve', 'rlc-step-underdamped', 'rlc-step-critical-overdamped'],
  'rlc-broken-raf-redraw': FIVE_DRAWN_AND_READOUT,
  'rlc-broken-timeout-redraw': FIVE_DRAWN_AND_READOUT,
  'rlc-control-static-fake': 'static',
  'rlc-control-static-degenerate': 'static',
}
