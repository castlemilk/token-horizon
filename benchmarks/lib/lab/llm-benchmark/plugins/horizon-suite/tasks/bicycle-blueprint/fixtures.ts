/**
 * Fixtures for the bicycle blueprint.
 *
 * goodArtifact is the reference solution: it derives every point from the
 * parameters and fits its viewBox to the drawn bounds. Each broken fixture is the
 * good source with ONE documented mutation applied to a marked region
 * (/*@region name*\/ ... /*@end name*\/). replaceRegion asserts that the region
 * exists exactly once and that the replacement changes the source. The static fake
 * is the default bicycle drawn with fixed values and no test hooks.
 *
 * The expectations say which checks each fixture must fail. Every other check must pass.
 */
import { readFileSync } from 'node:fs'
import type { Expectation, FixtureSpec } from '../../lib/fixture-matrix'
import { PUBLIC_DEFAULTS, derive, handlebarBox, readoutsFor, saddleBox, tangentRuns, viewBoxOf, type Params } from './reference'

export const GOOD_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bicycle Blueprint</title>
<style>
:root {
  --bg: #0b1622;
  --panel: #0f2032;
  --rule: #22405c;
  --grid: #142536;
  --ink: #d9e8f3;
  --muted: #8aa6bd;
  --accent: #7fd8ff;
  --tyre: #1f3a50;
  --rim: #7fd8ff;
  --spoke: #7fb7d8;
  --ground: #8fb9d6;
  --dim: #3d6079;
  --frame: #ffb347;
  --chain: #e8f1f8;
  --crank: #d8e4ee;
  --gear: #b6f2c8;
  --valve: #ffe27a;
  --seat: #f0b15a;
  --bar: #d9e6f2;
  --pedal: #c7d3de;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100vh; height: 100dvh; overflow: hidden; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--rule); }
h1 { margin: 0; font-size: 14px; letter-spacing: .16em; text-transform: uppercase; font-weight: 650; color: var(--accent); }
.sub { font-size: 12px; color: var(--muted); }
#stage { position: relative; min-height: 0; }
#bike { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
footer { padding: 10px 16px 12px; border-top: 1px solid var(--rule); background: var(--panel); }
.readouts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px 14px; margin: 0; }
.readout { min-width: 0; }
.readout dt { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); line-height: 1.3; }
.readout dd { margin: 2px 0 0; }
output { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink); }
[role="alert"] { position: fixed; left: 16px; right: 16px; top: 60px; padding: 10px 12px; background: #3a1420; color: #ffd4dc; border: 1px solid #7a2a3a; border-radius: 6px; z-index: 5; }
.grid { fill: none; stroke: var(--grid); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.dim { fill: none; stroke: var(--dim); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.tyre { fill: none; stroke: var(--tyre); stroke-width: 7px; vector-effect: non-scaling-stroke; }
.rim { fill: none; stroke: var(--rim); stroke-width: 2.5px; vector-effect: non-scaling-stroke; }
#ground { stroke: var(--ground); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.spoke { stroke: var(--spoke); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.gear { fill: none; stroke: var(--gear); stroke-width: 2px; vector-effect: non-scaling-stroke; }
.chain { stroke: var(--chain); stroke-width: 2.5px; vector-effect: non-scaling-stroke; }
/*@region tube-style*/.frame { stroke: var(--frame); stroke-width: 3.5px; stroke-linecap: round; vector-effect: non-scaling-stroke; }/*@end tube-style*/
.crank { stroke: var(--crank); stroke-width: 5px; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.pedal { fill: var(--pedal); }
.valve { fill: var(--valve); }
#saddle { fill: var(--seat); }
#handlebar { fill: var(--bar); }
@media (max-width: 700px) {
  .sub { display: none; }
  .readouts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
</head>
<body>
<header>
  <h1>Bicycle blueprint</h1>
  <span class="sub">Side elevation, drawn from its parameters in millimetres</span>
</header>
<main id="stage">
  <svg id="bike" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="bike-title bike-desc">
    <title id="bike-title">Bicycle side elevation</title>
    <desc id="bike-desc">Wheels, frame, drivetrain, cockpit and saddle drawn from the current parameters.</desc>
    <g id="layer-grid"></g>
    <g id="layer-dims"></g>
    <g id="layer-tyres"></g>
    <line id="ground" x1="0" y1="0" x2="0" y2="0"></line>
    <circle id="wheel-rear" class="rim" cx="0" cy="0" r="1"></circle>
    <circle id="wheel-front" class="rim" cx="0" cy="0" r="1"></circle>
    <g id="layer-spokes"></g>
    <circle id="chainring" class="gear" cx="0" cy="0" r="1"></circle>
    <circle id="sprocket" class="gear" cx="0" cy="0" r="1"></circle>
    <line id="chain-upper" class="chain" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="chain-lower" class="chain" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="chain-stay" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="seat-stay" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="seat-tube" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="top-tube" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="down-tube" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="head-tube" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="fork" class="frame" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="crank-right" class="crank" x1="0" y1="0" x2="0" y2="0"></line>
    <line id="crank-left" class="crank" x1="0" y1="0" x2="0" y2="0"></line>
    <rect id="pedal-right" class="pedal" x="0" y="0" width="1" height="1"></rect>
    <rect id="pedal-left" class="pedal" x="0" y="0" width="1" height="1"></rect>
    <rect id="saddle" x="0" y="0" width="1" height="1" rx="6"></rect>
    <rect id="handlebar" x="0" y="0" width="1" height="1" rx="8"></rect>
    <g id="layer-valves"></g>
  </svg>
</main>
<footer>
  <dl class="readouts">
    <div class="readout"><dt>Gear ratio, Nf / Nr</dt><dd><output id="out-ratio">--</output></dd></div>
    <div class="readout"><dt>Development, m per crank turn</dt><dd><output id="out-development">--</output></dd></div>
    <div class="readout"><dt>Chain loop, mm</dt><dd><output id="out-chain">--</output></dd></div>
    <div class="readout"><dt>Chain links, even count</dt><dd><output id="out-links">--</output></dd></div>
    <div class="readout"><dt>Distance at this crank angle, m</dt><dd><output id="out-distance">--</output></dd></div>
  </dl>
</footer>
<script>
(function () {
  'use strict';
  var PI = Math.PI;
  var PITCH = 12.7;
  var SVGNS = 'http://www.w3.org/2000/svg';
  // Parameter ranges: [min, max, integer?, even?]
  var RANGES = {
    wheelRadius: [250, 380], wheelbase: [700, 1200], chainstay: [380, 460], bbDrop: [30, 80],
    seatTube: [420, 620], seatAngle: [68, 78], headAngle: [66, 76], forkLength: [340, 420],
    headTube: [90, 200], chainringTeeth: [26, 56, true], sprocketTeeth: [11, 36, true],
    crankLength: [160, 180], spokes: [12, 36, true, true]
  };
  var DEFAULTS = {
    wheelRadius: 340, wheelbase: 1010, chainstay: 425, bbDrop: 65, seatTube: 540, seatAngle: 73,
    headAngle: 72, forkLength: 380, headTube: 140, chainringTeeth: 48, sprocketTeeth: 18,
    crankLength: 170, spokes: 24
  };
  var svg = document.getElementById('bike');
  var layers = {
    grid: document.getElementById('layer-grid'),
    dims: document.getElementById('layer-dims'),
    tyres: document.getElementById('layer-tyres'),
    spokes: document.getElementById('layer-spokes'),
    valves: document.getElementById('layer-valves')
  };
  var state = { p: null, theta: 35 };

  function el(id) { return document.getElementById(id); }
  function rad(deg) { return deg * PI / 180; }
  function teeth(n) { return n * PITCH / (2 * PI); }
  // Millimetres (y up) to SVG user units (y down).
  function sv(pt) { return { x: pt.x, y: -pt.y }; }
  function make(name, attrs, parent) {
    var node = document.createElementNS(SVGNS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    parent.appendChild(node);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setLine(node, a, b) {
    var pa = sv(a), pb = sv(b);
    node.setAttribute('x1', pa.x); node.setAttribute('y1', pa.y);
    node.setAttribute('x2', pb.x); node.setAttribute('y2', pb.y);
  }
  function setCircle(node, c, r) {
    var pc = sv(c);
    node.setAttribute('cx', pc.x); node.setAttribute('cy', pc.y); node.setAttribute('r', r);
  }
  // Box in millimetres: x, bottom y, width and height.
  function setRect(node, box) {
    node.setAttribute('x', box.x);
    node.setAttribute('y', -(box.y + box.h));
    node.setAttribute('width', box.w);
    node.setAttribute('height', box.h);
  }
  function setText(id, text) { el(id).textContent = text; }

  function validParams(p) {
    /*@region validate*/
    if (typeof p !== 'object' || p === null) return false;
    for (var key in RANGES) {
      var r = RANGES[key];
      var v = p[key];
      if (typeof v !== 'number' || !isFinite(v) || v < r[0] || v > r[1]) return false;
      if (r[2] && Math.floor(v) !== v) return false;
      if (r[3] && v % 2 !== 0) return false;
    }
    if (p.wheelbase < 2 * p.wheelRadius + 20) return false;
    if (p.forkLength < p.wheelRadius + 15) return false;
    return true;
    /*@end validate*/
  }

  function validCrank(theta) {
    /*@region validate-crank*/
    if (typeof theta !== 'number' || !isFinite(theta) || theta < 0) return false;
    /*@end validate-crank*/
    return true;
  }

  function derive(p, theta) {
    var A = rad(p.seatAngle), H = rad(p.headAngle);
    var C = p.chainstay, D = p.bbDrop, W = p.wheelbase, L = p.crankLength;
    var rear = { x: 0, y: 0 };
    var front = { x: W, y: 0 };
    /*@region bb*/
    var bb = { x: Math.sqrt(C * C - D * D), y: -D };
    /*@end bb*/
    var sc = { x: bb.x - p.seatTube * Math.cos(A), y: bb.y + p.seatTube * Math.sin(A) };
    var fc = { x: W - p.forkLength * Math.cos(H), y: p.forkLength * Math.sin(H) };
    var ht = { x: fc.x - p.headTube * Math.cos(H), y: fc.y + p.headTube * Math.sin(H) };
    var th = rad(theta);
    var sinT = Math.sin(th), cosT = Math.cos(th);
    /*@region phase*/
    var phi = theta * p.chainringTeeth / p.sprocketTeeth;
    /*@end phase*/
    return {
      R: p.wheelRadius, W: W, C: C, D: D, rear: rear, front: front, bb: bb, sc: sc, fc: fc, ht: ht,
      rf: /*@region ring*/teeth(p.chainringTeeth)/*@end ring*/,
      rr: teeth(p.sprocketTeeth),
      L: L,
      crankRight: { x: bb.x + L * sinT, y: bb.y + L * cosT },
      crankLeft: { x: bb.x - L * sinT, y: bb.y - L * cosT },
      phi: phi,
      theta: theta
    };
  }

  // Saddle: sits just above SC, its centre 12 mm forward of SC.
  function saddleBox(g) {
    /*@region saddle*/
    return { x: g.sc.x + 12 - 62, y: g.sc.y + 8, w: 124, h: 20 };
    /*@end saddle*/
  }

  // Handlebar: centre 22 mm behind HT and 15 mm above it.
  function handlebarBox(g) {
    /*@region bars*/
    return { x: g.ht.x - 62, y: g.ht.y + 6, w: 80, h: 18 };
    /*@end bars*/
  }

  // Bounds of everything drawn, padded by 6 % of the larger side (millimetres, y up).
  function frameOf(g) {
    var R = g.R, W = g.W;
    var pts = [
      { x: -R - 12, y: -R - 12 }, { x: R + 12, y: R + 12 },
      { x: W - R - 12, y: -R - 12 }, { x: W + R + 12, y: R + 12 },
      { x: -R - 40, y: -R }, { x: W + R + 40, y: -R },
      { x: 0, y: -R - 70 }, { x: W, y: -R - 70 },
      g.sc, g.ht, g.fc, g.bb,
      { x: g.crankRight.x - 25, y: g.crankRight.y - 12 }, { x: g.crankRight.x + 25, y: g.crankRight.y + 12 },
      { x: g.crankLeft.x - 25, y: g.crankLeft.y - 12 }, { x: g.crankLeft.x + 25, y: g.crankLeft.y + 12 }
    ];
    var sb = saddleBox(g), hb = handlebarBox(g);
    pts.push({ x: sb.x, y: sb.y }, { x: sb.x + sb.w, y: sb.y + sb.h });
    pts.push({ x: hb.x, y: hb.y }, { x: hb.x + hb.w, y: hb.y + hb.h });
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y);
      x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y);
    }
    var m = 0.06 * Math.max(x1 - x0, y1 - y0);
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  }

  // External common tangents of circle 1 (o1, r1) and circle 2 (o2, r2), in millimetres.
  // Each run is { a: point on circle 1, b: point on circle 2 }. Upper is the run higher on the page.
  function tangents(o1, r1, o2, r2) {
    var dx = o2.x - o1.x, dy = o2.y - o1.y, len = Math.sqrt(dx * dx + dy * dy);
    var ux = dx / len, uy = dy / len;
    var c = (r1 - r2) / len;
    var s = Math.sqrt(Math.max(0, 1 - c * c));
    var vx = -uy, vy = ux;
    var n1 = { x: c * ux + s * vx, y: c * uy + s * vy };
    var n2 = { x: c * ux - s * vx, y: c * uy - s * vy };
    var wx = vy >= 0 ? vx : -vx, wy = vy >= 0 ? vy : -vy;
    var up = (n1.x * wx + n1.y * wy >= 0) ? n1 : n2;
    var down = (up === n1) ? n2 : n1;
    function run(n) {
      return {
        a: { x: o1.x + r1 * n.x, y: o1.y + r1 * n.y },
        b: { x: o2.x + r2 * n.x, y: o2.y + r2 * n.y }
      };
    }
    return { upper: run(up), lower: run(down) };
  }

  function drawGrid(box) {
    clear(layers.grid);
    var x, y;
    for (x = Math.ceil(box.x0 / 50) * 50; x <= box.x1; x += 50) {
      make('line', { 'class': 'grid', x1: x, x2: x, y1: -box.y1, y2: -box.y0 }, layers.grid);
    }
    for (y = Math.ceil(box.y0 / 50) * 50; y <= box.y1; y += 50) {
      make('line', { 'class': 'grid', x1: box.x0, x2: box.x1, y1: -y, y2: -y }, layers.grid);
    }
  }

  function drawDims(g) {
    clear(layers.dims);
    var y = -g.R - 60;
    make('line', { 'class': 'dim', x1: 0, x2: g.W, y1: -y, y2: -y }, layers.dims);
    make('line', { 'class': 'dim', x1: 0, x2: 0, y1: -y - 10, y2: -y + 10 }, layers.dims);
    make('line', { 'class': 'dim', x1: g.W, x2: g.W, y1: -y - 10, y2: -y + 10 }, layers.dims);
  }

  function drawTyres(g) {
    clear(layers.tyres);
    setCircle(make('circle', { 'class': 'tyre' }, layers.tyres), g.rear, g.R + 4);
    setCircle(make('circle', { 'class': 'tyre' }, layers.tyres), g.front, g.R + 4);
  }

  function drawSpokes(hub, R, count, phi, wheel) {
    for (/*@region spoke-loop*/var k = 0; k < count; k++/*@end spoke-loop*/) {
      var a = rad(phi + k * 360 / count);
      var end = { x: hub.x + R * Math.sin(a), y: hub.y + R * Math.cos(a) };
      setLine(make('line', { 'class': 'spoke', 'data-wheel': wheel, x1: 0, y1: 0, x2: 0, y2: 0 }, layers.spokes), hub, end);
    }
  }

  function drawValve(hub, R, phi, wheel) {
    var a = rad(phi);
    var c = { x: hub.x + R * Math.sin(a), y: hub.y + R * Math.cos(a) };
    setCircle(make('circle', { 'class': 'valve', 'data-wheel': wheel, cx: 0, cy: 0, r: 9 }, layers.valves), c, 9);
  }

  function drawPedal(node, c, theta) {
    setRect(node, { x: c.x - 23, y: c.y - 7, w: 46, h: 14 });
    /*@region pedal*/
    /*@end pedal*/
  }

  function readouts(p, theta) {
    var ratio = p.chainringTeeth / p.sprocketTeeth;
    var rf = teeth(p.chainringTeeth), rr = teeth(p.sprocketTeeth);
    var C = p.chainstay;
    /*@region loop*/
    var loop = 2 * Math.sqrt(C * C - (rf - rr) * (rf - rr)) +
      rf * (PI + 2 * Math.asin((rf - rr) / C)) + rr * (PI - 2 * Math.asin((rf - rr) / C));
    /*@end loop*/
    var links = Math.ceil(loop / PITCH);
    if (links % 2 !== 0) links += 1;
    var development = 2 * PI * p.wheelRadius * ratio / 1000;
    var distance = p.wheelRadius * rad(theta * ratio) / 1000;
    setText('out-ratio', ratio.toFixed(2));
    setText('out-development', development.toFixed(2));
    setText('out-chain', loop.toFixed(1));
    setText('out-links', String(links));
    setText('out-distance', distance.toFixed(3));
  }

  function draw() {
    var p = state.p, theta = state.theta;
    var g = derive(p, theta);
    var R = p.wheelRadius;
    var box = frameOf(g);
    /*@region view*/
    svg.setAttribute('viewBox', [box.x0, -box.y1, box.x1 - box.x0, box.y1 - box.y0].join(' '));
    /*@end view*/
    drawGrid(box);
    drawDims(g);
    drawTyres(g);

    var gy = /*@region ground*/-R/*@end ground*/;
    setLine(el('ground'), { x: -R - 40, y: gy }, { x: g.W + R + 40, y: gy });
    setCircle(el('wheel-rear'), g.rear, R);
    setCircle(el('wheel-front'), g.front, R);

    clear(layers.spokes);
    drawSpokes(g.rear, R, p.spokes, g.phi, 'rear');
    drawSpokes(g.front, R, p.spokes, g.phi, 'front');

    var tRf = g.rf, tRr = g.rr;
    setCircle(el('chainring'), g.bb, tRf);
    setCircle(el('sprocket'), g.rear, tRr);
    /*@region chain*/
    var runs = tangents(g.bb, tRf, g.rear, tRr);
    /*@end chain*/
    setLine(el('chain-upper'), runs.upper.a, runs.upper.b);
    setLine(el('chain-lower'), runs.lower.a, runs.lower.b);

    setLine(el('chain-stay'), g.rear, g.bb);
    setLine(el('seat-stay'), g.rear, g.sc);
    setLine(el('seat-tube'), g.bb, g.sc);
    setLine(el('top-tube'), g.sc, g.ht);
    setLine(el('down-tube'), g.bb, g.fc);
    setLine(el('head-tube'), g.fc, g.ht);
    setLine(el('fork'), g.fc, g.front);

    setLine(el('crank-right'), g.bb, g.crankRight);
    setLine(el('crank-left'), g.bb, g.crankLeft);
    drawPedal(el('pedal-right'), g.crankRight, theta);
    drawPedal(el('pedal-left'), g.crankLeft, theta);

    setRect(el('saddle'), saddleBox(g));
    setRect(el('handlebar'), handlebarBox(g));

    clear(layers.valves);
    drawValve(g.rear, R, g.phi, 'rear');
    drawValve(g.front, R, g.phi, 'front');

    readouts(p, theta);
  }

  function copyParams(p) {
    var q = {};
    for (var key in RANGES) q[key] = p[key];
    return q;
  }

  function setParams(p) {
    if (!validParams(p)) return false;
    state.p = copyParams(p);
    draw();
    return true;
  }

  function setCrank(theta) {
    if (!validCrank(theta)) return false;
    state.theta = theta;
    draw();
    return true;
  }

  window.__bench = { setParams: setParams, setCrank: setCrank };
  try {
    setParams(DEFAULTS);
    setCrank(35);
  } catch (err) {
    var alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'The blueprint could not be drawn: ' + (err && err.message ? err.message : String(err));
    document.body.appendChild(alert);
  }
})();
</script>
</body>
</html>
`

/** The reference solution. */
export const goodArtifact: string = GOOD_HTML

/**
 * Replace the text between /*@region name*\/ and /*@end name*\/ with replacement.
 * Fails loudly if the marker is missing, repeated, or the result equals the source.
 */
export function replaceRegion(source: string, name: string, replacement: string): string {
  const open = '/*@region ' + name + '*/'
  const close = '/*@end ' + name + '*/'
  const start = source.indexOf(open)
  const end = source.indexOf(close)
  if (start < 0 || end < 0 || end < start) throw new Error(`region ${name}: markers missing`)
  if (source.indexOf(open, start + 1) >= 0 || source.indexOf(close, end + 1) >= 0) {
    throw new Error(`region ${name}: markers must occur once`)
  }
  const head = source.slice(0, start + open.length)
  const current = source.slice(start + open.length, end)
  const tail = source.slice(end)
  if (current === replacement) throw new Error(`region ${name}: replacement equals the region`)
  const next = head + replacement + tail
  if (next === source) throw new Error(`region ${name}: mutation changed nothing`)
  return next
}

const DEFAULT_GEOMETRY = derive(PUBLIC_DEFAULTS, 0)
const DEFAULT_SADDLE = saddleBox(DEFAULT_GEOMETRY)
const DEFAULT_BARS = handlebarBox(DEFAULT_GEOMETRY)
const DEFAULT_VIEWBOX = viewBoxOf(PUBLIC_DEFAULTS, 0)

/** One documented mutation per broken fixture. */
const MUTATIONS: Record<string, (good: string) => string> = {
  // Ground line drawn 12 mm below the wheels.
  'bike-broken-ground-gap': (s) => replaceRegion(s, 'ground', '-R - 12'),
  // Bottom bracket at (C, 0); everything attached to it follows.
  'bike-broken-ignores-bb-drop': (s) => replaceRegion(s, 'bb', 'var bb = { x: C, y: 0 };'),
  // Chainring radius taken as the diameter over pi: Nf * 12.7 / pi. The chain stays tangent to the drawn circle.
  'bike-broken-diameter-as-radius': (s) => replaceRegion(s, 'ring', 'p.chainringTeeth * PITCH / PI'),
  // Chain runs join the topmost and bottommost points of the two circles.
  'bike-broken-chain-top-to-top': (s) =>
    replaceRegion(
      s,
      'chain',
      'var runs = { upper: { a: { x: g.bb.x, y: g.bb.y + tRf }, b: { x: g.rear.x, y: g.rear.y + tRr } }, lower: { a: { x: g.bb.x, y: g.bb.y - tRf }, b: { x: g.rear.x, y: g.rear.y - tRr } } };',
    ),
  // Pedal rectangles rotate with the crank.
  'bike-broken-pedals-rotate': (s) =>
    replaceRegion(s, 'pedal', "node.setAttribute('transform', 'rotate(' + theta + ' ' + sv(c).x + ' ' + sv(c).y + ')');"),
  // Spoke loop runs k <= N: N+1 spokes, the last one a duplicate of the first.
  'bike-broken-spoke-off-by-one': (s) => replaceRegion(s, 'spoke-loop', 'var k = 0; k <= count; k++'),
  // Wheels drawn with phi = theta * Nr / Nf; the readouts keep the correct ratio.
  'bike-broken-inverse-ratio': (s) => replaceRegion(s, 'phase', 'var phi = theta * p.sprocketTeeth / p.chainringTeeth;'),
  // Chain loop shortcut 2C + pi (rf + rr).
  'bike-broken-chain-shortcut': (s) => replaceRegion(s, 'loop', 'var loop = 2 * C + PI * (rf + rr);'),
  // Saddle and handlebar at the default bicycle's coordinates.
  'bike-broken-fixed-saddle-bars': (s) => {
    const withSaddle = replaceRegion(s, 'saddle', `return { x: ${DEFAULT_SADDLE.x}, y: ${DEFAULT_SADDLE.y}, w: ${DEFAULT_SADDLE.w}, h: ${DEFAULT_SADDLE.h} };`)
    return replaceRegion(withSaddle, 'bars', `return { x: ${DEFAULT_BARS.x}, y: ${DEFAULT_BARS.y}, w: ${DEFAULT_BARS.w}, h: ${DEFAULT_BARS.h} };`)
  },
  // viewBox sized for the default bicycle, so the largest one is clipped.
  'bike-broken-fixed-viewbox': (s) => replaceRegion(s, 'view', `svg.setAttribute('viewBox', '${DEFAULT_VIEWBOX}');`),
  // setParams and setCrank never validate and always return true.
  'bike-broken-accepts-anything': (s) => {
    const params = replaceRegion(s, 'validate', 'return true;')
    return replaceRegion(params, 'validate-crank', '')
  },
  // Frame tubes stroked in the background colour.
  'bike-broken-ghost-frame': (s) =>
    replaceRegion(s, 'tube-style', '.frame { stroke: #0b1622; stroke-width: 3.5px; stroke-linecap: round; vector-effect: non-scaling-stroke; }'),
}

function mutated(name: string): string {
  const mutate = MUTATIONS[name]
  if (mutate === undefined) throw new Error(`no mutation named ${name}`)
  return mutate(goodArtifact)
}

// ---------------------------------------------------------------------------
// Static fake: the default bicycle drawn once with fixed values, no hooks, no script
// ---------------------------------------------------------------------------

function fixed(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

function staticFake(): string {
  const P: Params = PUBLIC_DEFAULTS
  const g = derive(P, 35)
  const sv = (p: { x: number; y: number }): { x: string; y: string } => ({ x: fixed(p.x), y: fixed(-p.y) })
  const line = (cls: string, id: string | null, a: { x: number; y: number }, b: { x: number; y: number }): string => {
    const pa = sv(a)
    const pb = sv(b)
    return `<line${id ? ` id="${id}"` : ''} class="${cls}" x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}"></line>`
  }
  const circle = (cls: string, id: string | null, c: { x: number; y: number }, r: number, extra = ''): string => {
    const pc = sv(c)
    return `<circle${id ? ` id="${id}"` : ''} class="${cls}" cx="${pc.x}" cy="${pc.y}" r="${fixed(r)}"${extra}></circle>`
  }
  const spokes: string[] = []
  for (const [wheel, hub] of [
    ['rear', g.rear],
    ['front', g.front],
  ] as const) {
    for (let k = 0; k < P.spokes; k++) {
      const a = ((g.phi + (k * 360) / P.spokes) * Math.PI) / 180
      spokes.push(line('spoke', null, hub, { x: hub.x + P.wheelRadius * Math.sin(a), y: hub.y + P.wheelRadius * Math.cos(a) }).replace('class="spoke"', `class="spoke" data-wheel="${wheel}"`))
    }
  }
  const runs = tangentRuns(g.bb, g.rf, g.rear, g.rr)
  const valve = (hub: { x: number; y: number }, wheel: string): string => {
    const a = (g.phi * Math.PI) / 180
    return circle('valve', null, { x: hub.x + P.wheelRadius * Math.sin(a), y: hub.y + P.wheelRadius * Math.cos(a) }, 9, ` data-wheel="${wheel}"`)
  }
  const pedal = (c: { x: number; y: number }): string => {
    const tl = sv({ x: c.x - 23, y: c.y + 7 })
    return `<rect class="pedal" x="${tl.x}" y="${tl.y}" width="46" height="14"></rect>`
  }
  const sb = DEFAULT_SADDLE
  const hb = DEFAULT_BARS
  const outs = readoutsFor(P, 35)
  const body = [
    `<svg id="bike" xmlns="http://www.w3.org/2000/svg" viewBox="${DEFAULT_VIEWBOX}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Bicycle side elevation">`,
    circle('tyre', null, g.rear, P.wheelRadius + 4),
    circle('tyre', null, g.front, P.wheelRadius + 4),
    `<line id="ground" class="" x1="${fixed(-P.wheelRadius - 40)}" y1="${fixed(P.wheelRadius)}" x2="${fixed(g.W + P.wheelRadius + 40)}" y2="${fixed(P.wheelRadius)}"></line>`,
    circle('rim', 'wheel-rear', g.rear, P.wheelRadius),
    circle('rim', 'wheel-front', g.front, P.wheelRadius),
    spokes.join(''),
    circle('gear', 'chainring', g.bb, g.rf),
    circle('gear', 'sprocket', g.rear, g.rr),
    line('chain', 'chain-upper', runs.upper.a, runs.upper.b),
    line('chain', 'chain-lower', runs.lower.a, runs.lower.b),
    line('frame', 'chain-stay', g.rear, g.bb),
    line('frame', 'seat-stay', g.rear, g.sc),
    line('frame', 'seat-tube', g.bb, g.sc),
    line('frame', 'top-tube', g.sc, g.ht),
    line('frame', 'down-tube', g.bb, g.fc),
    line('frame', 'head-tube', g.fc, g.ht),
    line('frame', 'fork', g.fc, g.front),
    line('crank', 'crank-right', g.bb, g.crankRight),
    line('crank', 'crank-left', g.bb, g.crankLeft),
    pedal(g.crankRight),
    pedal(g.crankLeft),
    `<rect id="saddle" x="${fixed(sb.x)}" y="${fixed(-(sb.y + sb.h))}" width="${fixed(sb.w)}" height="${fixed(sb.h)}" rx="6"></rect>`,
    `<rect id="handlebar" x="${fixed(hb.x)}" y="${fixed(-(hb.y + hb.h))}" width="${fixed(hb.w)}" height="${fixed(hb.h)}" rx="8"></rect>`,
    valve(g.rear, 'rear'),
    valve(g.front, 'front'),
    '</svg>',
  ].join('\n')
  const head = goodArtifact.slice(0, goodArtifact.indexOf('<main id="stage">'))
  const footer = goodArtifact.slice(goodArtifact.indexOf('<footer>'), goodArtifact.indexOf('</footer>') + '</footer>'.length)
  const filledFooter = footer
    .replace('<output id="out-ratio">--</output>', `<output id="out-ratio">${outs.ratio.toFixed(2)}</output>`)
    .replace('<output id="out-development">--</output>', `<output id="out-development">${outs.development.toFixed(2)}</output>`)
    .replace('<output id="out-chain">--</output>', `<output id="out-chain">${outs.chain.toFixed(1)}</output>`)
    .replace('<output id="out-links">--</output>', `<output id="out-links">${outs.links}</output>`)
    .replace('<output id="out-distance">--</output>', `<output id="out-distance">${outs.distance.toFixed(3)}</output>`)
  return `${head}<main id="stage">\n${body}\n</main>\n${filledFooter}\n</body>\n</html>\n`
}

export const staticDefaultFake: string = staticFake()

/** Every fixture, good first. Broken variants are generated from goodArtifact. */
export const brokenArtifacts: Array<{ name: string; html: string }> = Object.keys(MUTATIONS).map((name) => ({
  name,
  html: mutated(name),
}))

/** Read a page kept under variants/ (conforming variants and cheats written by the reviewer). */
function variant(file: string): string {
  return readFileSync(new URL(`./variants/${file}.html`, import.meta.url), 'utf8')
}

/**
 * Conforming variant: the drawing fades in with an entrance animation that fills forwards,
 * so its base opacity is 0. A finished entrance shows the drawing; the page is not blank.
 */
const ENTRANCE_FADE = (() => {
  const head = '</head>'
  if (GOOD_HTML.split(head).length !== 2 || !GOOD_HTML.includes('<svg id="bike"')) throw new Error('entrance-fade: markers changed')
  return GOOD_HTML.replace(head, () => '<style>#bike{opacity:0;animation:bike-enter .4s ease-out forwards}@keyframes bike-enter{to{opacity:1}}</style>\n' + head)
})()

/** Conforming artifacts that differ from the reference. Each must score 100. */
export const goodVariants: Array<{ name: string; html: string }> = [
  { name: 'bike-good-rounded-spokes', html: variant('good-rounded-spokes') },
  { name: 'bike-good-grid-overshoot', html: variant('good-grid-overshoot') },
  { name: 'bike-good-ground-far', html: variant('good-ground-far') },
  { name: 'bike-good-readout-whitespace', html: variant('good-readout-whitespace') },
  { name: 'bike-good-tight-unrounded', html: variant('good-tight-unrounded') },
  // A saddle and a handlebar drawn as stroked lines: zero-thickness boxes that paint.
  { name: 'bike-good-saddle-stroke-line', html: variant('good-saddle-stroke-line') },
  // A dashed chain whose sample points can fall in a gap: other points in the dashes paint.
  { name: 'bike-good-chain-dash-5-9', html: variant('good-chain-dash-5-9') },
  { name: 'bike-good-chain-dash-6-10', html: variant('good-chain-dash-6-10') },
  // A dark crank over a bright filled chainring: judged against the ring it covers.
  { name: 'bike-good-dark-crank-bright-ring', html: variant('good-dark-crank-bright-ring') },
  { name: 'bike-good-entrance-fade', html: ENTRANCE_FADE },
]

/** Cheats and faults kept as pages. Each has an expectation below. */
export const cheatVariants: Array<{ name: string; html: string }> = [
  { name: 'bike-cheat-a-static-stub-hooks', html: variant('cheat-a-static-stub-hooks') },
  { name: 'bike-cheat-b-readouts-only', html: variant('cheat-b-readouts-only') },
  { name: 'bike-cheat-c1-perp-chain-correct-circles', html: variant('cheat-c1-perp-chain-correct-circles') },
  { name: 'bike-cheat-c2-perp-chain-dot-circles', html: variant('cheat-c2-perp-chain-dot-circles') },
  { name: 'bike-cheat-c3-perp-chain-equal-circles', html: variant('cheat-c3-perp-chain-equal-circles') },
  { name: 'bike-cheat-d1-ghost-opacity0', html: variant('cheat-d1-ghost-opacity0') },
  { name: 'bike-cheat-d2-unsampled-hidden', html: variant('cheat-d2-unsampled-hidden') },
  { name: 'bike-cheat-d3-ghost-visibility-hidden', html: variant('cheat-d3-ghost-visibility-hidden') },
  { name: 'bike-cheat-d4-ghost-display-none', html: variant('cheat-d4-ghost-display-none') },
  { name: 'bike-cheat-e-no-spokes', html: variant('cheat-e-no-spokes') },
  { name: 'bike-cheat-f-static-validating-hooks', html: variant('cheat-f-static-drawing-validating-hooks') },
  { name: 'bike-fault-raf-deferred-draw', html: variant('raf-deferred-draw') },
  { name: 'bike-fault-string-false', html: variant('string-false-invalid') },
  { name: 'bike-fault-invalid-crank-redraws', html: variant('invalid-crank-redraws-spokes') },
  // A frame that ignores the chainstay, bottom-bracket drop, seat tube, angles and head tube (a known limit, pinned here).
  { name: 'bike-cheat-frame-frozen', html: variant('cheat-frame-frozen') },
]

export const fixtures: FixtureSpec[] = [
  { name: 'bike-good', html: goodArtifact },
  ...goodVariants,
  ...brokenArtifacts.map((b) => ({ name: b.name, html: b.html })),
  ...cheatVariants,
  { name: 'bike-control-static-default', html: staticDefaultFake },
]

/** The checks each fixture must fail. The good fixtures must pass everything. */
export const expectations: Record<string, Expectation> = {
  'bike-good': 'good',
  'bike-good-rounded-spokes': 'good',
  'bike-good-grid-overshoot': 'good',
  'bike-good-ground-far': 'good',
  'bike-good-readout-whitespace': 'good',
  'bike-good-tight-unrounded': 'good',
  'bike-good-saddle-stroke-line': 'good',
  'bike-good-chain-dash-5-9': 'good',
  'bike-good-chain-dash-6-10': 'good',
  'bike-good-dark-crank-bright-ring': 'good',
  'bike-good-entrance-fade': 'good',
  'bike-broken-ground-gap': ['bike-wheels-ground'],
  'bike-broken-ignores-bb-drop': ['bike-frame-joints'],
  'bike-broken-diameter-as-radius': ['bike-drivetrain-circles'],
  'bike-broken-chain-top-to-top': ['bike-chain-tangent'],
  'bike-broken-pedals-rotate': ['bike-crank-pedals'],
  'bike-broken-spoke-off-by-one': ['bike-spokes'],
  'bike-broken-inverse-ratio': ['bike-wheel-rotation'],
  'bike-broken-chain-shortcut': ['bike-readouts'],
  'bike-broken-fixed-saddle-bars': ['bike-saddle-bars'],
  'bike-broken-fixed-viewbox': ['bike-fits-view'],
  'bike-broken-accepts-anything': ['bike-validation'],
  'bike-broken-ghost-frame': ['bike-painted'],
  'bike-cheat-a-static-stub-hooks': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-readouts', 'bike-saddle-bars', 'bike-fits-view', 'bike-validation'],
  'bike-cheat-b-readouts-only': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-saddle-bars', 'bike-fits-view'],
  'bike-cheat-c1-perp-chain-correct-circles': ['bike-chain-tangent'],
  'bike-cheat-c2-perp-chain-dot-circles': ['bike-chain-tangent', 'bike-drivetrain-circles', 'bike-painted'],
  'bike-cheat-c3-perp-chain-equal-circles': ['bike-chain-tangent', 'bike-drivetrain-circles'],
  'bike-cheat-d1-ghost-opacity0': ['bike-painted'],
  'bike-cheat-d2-unsampled-hidden': ['bike-wheels-ground', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-fits-view', 'bike-painted'],
  'bike-cheat-d3-ghost-visibility-hidden': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-saddle-bars', 'bike-fits-view', 'bike-painted'],
  'bike-cheat-d4-ghost-display-none': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-saddle-bars', 'bike-fits-view', 'bike-painted'],
  'bike-cheat-e-no-spokes': ['bike-spokes', 'bike-wheel-rotation', 'bike-painted'],
  'bike-cheat-f-static-validating-hooks': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-readouts', 'bike-saddle-bars', 'bike-fits-view'],
  'bike-fault-raf-deferred-draw': ['bike-wheels-ground', 'bike-frame-joints', 'bike-drivetrain-circles', 'bike-chain-tangent', 'bike-crank-pedals', 'bike-spokes', 'bike-wheel-rotation', 'bike-readouts', 'bike-saddle-bars', 'bike-fits-view'],
  'bike-fault-string-false': ['bike-validation'],
  'bike-fault-invalid-crank-redraws': ['bike-validation'],
  'bike-cheat-frame-frozen': ['bike-frame-joints', 'bike-saddle-bars'],
  'bike-control-static-default': 'static',
}
