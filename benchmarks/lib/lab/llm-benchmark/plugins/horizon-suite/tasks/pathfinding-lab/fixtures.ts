/**
 * Fixtures for pathfinding-lab: one good artifact (also the reference solution), broken
 * variants made from it by small, documented mutations, and a static fake.
 *
 * Every mutation replaces one literal region of the good source. replaceOnce() asserts the
 * region occurs exactly once, so a mutation that matches nothing (or twice) throws instead
 * of silently producing a fixture that is not what its name says.
 */
import { DEMO_GOAL, DEMO_ROWS, DEMO_START } from './demo-map'
import { dims, heuristicValue, referenceSearch, type PathMap, type RC } from './reference'

const DEMO_PLACEHOLDER = '/*@DEMO_ROWS@*/'

/** The good artifact's source, with the demo rows spliced in from demo-map.ts. */
const GOOD_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pathfinding Lab</title>
<style>
:root{--bg:#0c0c10;--panel:#16171f;--ink:#ececf0;--muted:#a3a8b6;--line:#2b2e3b;--accent:#7aa2ff;--accent-ink:#0b1020;--ok:#8fe3a4;--bad:#ff8a8a;--focus:#ffd166}
html,body{margin:0;padding:0;height:100%;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.app{box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:10px;padding:12px 16px;min-height:0}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px}
h1{margin:0;font-size:20px;font-weight:650}
.sub{margin:2px 0 0;font-size:13px;color:var(--muted)}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.field,.check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
select{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:7px 14px;cursor:pointer}
button.ghost{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
#scrub{width:200px;accent-color:var(--accent)}
.stage{flex:1 1 0;min-height:0;display:flex}
#board{flex:1 1 0;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:12px}
#grid{display:grid;gap:2px}
.cell{box-sizing:border-box;border-radius:3px;cursor:pointer}
.cell.is-start{box-shadow:inset 0 0 0 3px #ffffff}
.cell.is-goal{box-shadow:inset 0 0 0 3px var(--focus)}
.bottom{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 18px}
.stats{display:flex;gap:10px}
.stat{min-width:96px;padding:6px 12px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.stat span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat output{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums}
#status{font-size:14px;color:var(--muted)}
#status[data-state="found"]{color:var(--ok)}
#status[data-state="no-path"]{color:var(--bad)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted)}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-2px}
#error{padding:8px 12px;border-radius:8px;background:#3a1518;color:#ffd4d4}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div>
      <h1>Pathfinding Lab</h1>
      <p class="sub">BFS, Dijkstra and A* on a weighted grid. Click a cell to toggle a wall.</p>
    </div>
    <div class="controls">
      <label class="field">Algorithm
        <select id="algo"><option value="bfs">BFS</option><option value="dijkstra">Dijkstra</option><option value="astar" selected>A*</option></select>
      </label>
      <button id="run" type="button">Run</button>
      <label class="check"><input type="checkbox" id="diagonals"> Diagonals</label>
      <button id="play" type="button" class="ghost">Play</button>
      <label class="field">Step <input type="range" id="scrub" min="0" max="0" step="1" value="0"></label>
    </div>
  </header>
  <main class="stage">
    <div id="board"><div id="grid"></div></div>
  </main>
  <footer class="bottom">
    <div class="stats">
      <div class="stat"><span>Cost</span><output id="stat-cost">-</output></div>
      <div class="stat"><span>Moves</span><output id="stat-moves">-</output></div>
      <div class="stat"><span>Expanded</span><output id="stat-expanded">-</output></div>
    </div>
    <div id="status" data-state="idle" role="status">Loading the demo map.</div>
    <div class="legend">
      <span><i style="background:#14161c"></i>Wall</span>
      <span><i style="background:#4a5568"></i>Open (1)</span>
      <span><i style="background:#8b5e34"></i>Mud (5)</span>
      <span><i style="background:#e6c229"></i>Road (0.5)</span>
      <span><i style="background:#1f6f78"></i>Expanded</span>
      <span><i style="background:#ff6ec7"></i>Path</span>
    </div>
  </footer>
  <div id="error" role="alert" hidden></div>
</div>
<script>
(function () {
  'use strict';

  var SQRT2 = Math.SQRT2;
  var GAP = 2;
  var MIN_CELL = 8;
  var TERRAIN_NAME = { '#': 'wall', '.': 'open', '~': 'mud', '=': 'road' };
  var TERRAIN_COST = { '.': 1, '~': 5, '=': 0.5 };
  var COLOUR = { wall: '#14161c', open: '#4a5568', mud: '#8b5e34', road: '#e6c229' };
  var VISITED_COLOUR = '#1f6f78';
  var PATH_COLOUR = '#ff6ec7';
  var LABEL = { bfs: 'BFS', dijkstra: 'Dijkstra', astar: 'A*' };
  var DEMO_ROWS = [
/*@DEMO_ROWS@*/
  ];

  function byId(id) { return document.getElementById(id); }
  var boardEl = byId('board');
  var gridEl = byId('grid');
  var algoEl = byId('algo');
  var diagEl = byId('diagonals');
  var playEl = byId('play');
  var scrubEl = byId('scrub');
  var costEl = byId('stat-cost');
  var movesEl = byId('stat-moves');
  var expandedEl = byId('stat-expanded');
  var statusEl = byId('status');
  var errorEl = byId('error');

  // The loaded map: rows (strings), per-cell cost (-1 for a wall), terrain names, and cmin.
  var map = null;
  var cells = [];
  var shown = null;   // the displayed result
  var last = null;    // __bench.last()
  var playRaf = null;

  function rowOf(m, i) { return Math.floor(i / m.C); }
  function colOf(m, i) { return i - Math.floor(i / m.C) * m.C; }

  function cellIndex(p, R, C, label) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1]) ||
        p[0] < 0 || p[1] < 0 || p[0] >= R || p[1] >= C) {
      throw new Error(label + ' must be [row, col] inside the grid');
    }
    return p[0] * C + p[1];
  }

  function computeCmin(m) {
    var best = Infinity;
    for (var i = 0; i < m.cost.length; i++) {
      if (m.cost[i] > 0 && m.cost[i] < best) best = m.cost[i];
    }
    return best === Infinity ? 1 : best;
  }

  function parseSpec(spec) {
    if (!spec || !Array.isArray(spec.rows) || spec.rows.length === 0) {
      throw new Error('rows must be a non-empty array of strings');
    }
    var R = spec.rows.length;
    var C = String(spec.rows[0]).length;
    if (C === 0) throw new Error('rows must not be empty');
    var rows = spec.rows.map(function (row) {
      if (typeof row !== 'string' || row.length !== C) throw new Error('all rows must have the same length');
      for (var k = 0; k < C; k++) {
        if (!TERRAIN_NAME.hasOwnProperty(row.charAt(k))) throw new Error('unknown terrain ' + row.charAt(k));
      }
      return row;
    });
    var startI = cellIndex(spec.start, R, C, 'start');
    var goalI = cellIndex(spec.goal, R, C, 'goal');
    var m = {
      R: R, C: C, rows: rows, name: [], cost: new Float64Array(R * C),
      startI: startI, goalI: goalI, diagonals: !!spec.diagonals, cmin: 1
    };
    for (var i = 0; i < R * C; i++) {
      var ch = rows[rowOf(m, i)].charAt(colOf(m, i));
      m.name.push(TERRAIN_NAME[ch]);
      m.cost[i] = ch === '#' ? -1 : TERRAIN_COST[ch];
    }
    if (m.cost[startI] < 0 || m.cost[goalI] < 0) throw new Error('start and goal must not be walls');
    m.cmin = computeCmin(m);
    return m;
  }

  // Every legal move out of cell u, as visit(v, stepCost). Diagonals need both
  // orthogonal cells they pass between to be non-wall (no corner cutting).
  function forEachMove(m, u, visit) {
    var R = m.R, C = m.C, r = rowOf(m, u), c = colOf(m, u), v;
    if (r > 0) { v = u - C; if (m.cost[v] >= 0) visit(v, m.cost[v]); }
    if (r < R - 1) { v = u + C; if (m.cost[v] >= 0) visit(v, m.cost[v]); }
    if (c > 0) { v = u - 1; if (m.cost[v] >= 0) visit(v, m.cost[v]); }
    if (c < C - 1) { v = u + 1; if (m.cost[v] >= 0) visit(v, m.cost[v]); }
    if (!m.diagonals) return;
    for (var dr = -1; dr <= 1; dr += 2) {
      for (var dc = -1; dc <= 1; dc += 2) {
        var nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
        v = nr * C + nc;
        var sideA = r * C + nc, sideB = nr * C + c;
        if (m.cost[v] < 0 || m.cost[sideA] < 0 || m.cost[sideB] < 0) continue; // corner rule
        visit(v, m.cost[v] * SQRT2);
      }
    }
  }

  // Admissible and consistent: cmin times Manhattan (or octile) distance to the goal.
  function heuristicFor(m) {
    var gr = rowOf(m, m.goalI), gc = colOf(m, m.goalI), cm = m.cmin;
    return function (i) {
      var dr = Math.abs(rowOf(m, i) - gr), dc = Math.abs(colOf(m, i) - gc);
      var d = m.diagonals ? Math.max(dr, dc) + (SQRT2 - 1) * Math.min(dr, dc) : dr + dc;
      return cm * d;
    };
  }

  function pathCost(m, path) {
    var total = 0;
    for (var k = 1; k < path.length; k++) {
      var a = path[k - 1], b = path[k];
      var diagonal = rowOf(m, a) !== rowOf(m, b) && colOf(m, a) !== colOf(m, b);
      total += m.cost[b] * (diagonal ? SQRT2 : 1);
    }
    return total;
  }

  // A binary min-heap ordered by key, then by insertion sequence (FIFO among equal keys).
  function before(x, y) { return x.k < y.k || (x.k === y.k && x.s < y.s); }
  function MinHeap() { this.items = []; }
  MinHeap.prototype.size = function () { return this.items.length; };
  MinHeap.prototype.push = function (k, s, v) {
    var a = this.items;
    a.push({ k: k, s: s, v: v });
    var i = a.length - 1;
    while (i > 0) {
      var parent = Math.floor((i - 1) / 2);
      if (!before(a[i], a[parent])) break;
      var t = a[i]; a[i] = a[parent]; a[parent] = t;
      i = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.items;
    var top = a[0];
    var tail = a.pop();
    if (a.length > 0) {
      a[0] = tail;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, best = i;
        if (l < a.length && before(a[l], a[best])) best = l;
        if (r < a.length && before(a[r], a[best])) best = r;
        if (best === i) break;
        var t = a[i]; a[i] = a[best]; a[best] = t;
        i = best;
      }
    }
    return top;
  };

  // Returns { found, path (indices), cost, order (indices in expansion order) }.
  // Each cell is expanded at most once: stale heap entries are skipped, not counted.
  function search(m, algorithm) {
    var N = m.R * m.C, start = m.startI, goal = m.goalI;
    var parent = new Int32Array(N).fill(-1);
    var order = [];
    var found = false;
    var g = new Float64Array(N).fill(Infinity);

    if (algorithm === 'bfs') {
      var seen = new Uint8Array(N);
      var queue = [start];
      var head = 0;
      seen[start] = 1;
      while (head < queue.length) {
        var u = queue[head++];
        order.push(u);
        if (u === goal) { found = true; break; }
        forEachMove(m, u, function (v) {
          if (!seen[v]) { seen[v] = 1; parent[v] = u; queue.push(v); }
        });
      }
    } else {
      var h = algorithm === 'astar' ? heuristicFor(m) : function () { return 0; };
      var closed = new Uint8Array(N);
      var heap = new MinHeap();
      var seq = 0;
      var current = start;
      var relax = function (v, step) {
        if (closed[v]) return;
        var ng = g[current] + step;
        if (ng < g[v]) {
          g[v] = ng;
          parent[v] = current;
          heap.push(ng + h(v), seq++, v);
        }
      };
      g[start] = 0;
      heap.push(h(start), seq++, start);
      while (heap.size() > 0) {
        var w = heap.pop().v;
        if (closed[w]) continue;
        closed[w] = 1;
        order.push(w);
        if (w === goal) { found = true; break; }
        current = w;
        forEachMove(m, w, relax);
      }
    }

    var path = [];
    if (found) {
      for (var p = goal; p !== -1; p = parent[p]) path.push(p);
      path.reverse();
    }
    var cost = found ? (algorithm === 'bfs' ? pathCost(m, path) : g[goal]) : null;
    return { found: found, path: path, cost: cost, order: order };
  }

  function toRC(i) { return [rowOf(map, i), colOf(map, i)]; }

  function showStats(raw) {
    if (raw.found) {
      costEl.textContent = raw.cost.toFixed(4);
      movesEl.textContent = String(raw.path.length - 1);
    } else {
      costEl.textContent = '-';
      movesEl.textContent = '-';
    }
    expandedEl.textContent = String(raw.order.length);
  }

  function showStatus(algorithm, raw) {
    var text;
    if (!raw.found) {
      text = 'No path: the goal cannot be reached from the start (' + LABEL[algorithm] + ' expanded ' + raw.order.length + ' cells).';
    } else if (raw.path.length === 1) {
      text = 'Start is the goal: cost 0, 0 moves.';
    } else {
      text = LABEL[algorithm] + ' found a path of cost ' + raw.cost.toFixed(2) + ' in ' + (raw.path.length - 1) + ' moves.';
    }
    statusEl.setAttribute('data-state', raw.found ? 'found' : 'no-path');
    statusEl.textContent = text;
  }

  // Draw the first 'upto' cells of the order as visited; the path only at the end.
  function paint(k) {
    var total = shown ? shown.order.length : 0;
    var upto = Math.max(0, Math.min(k, total));
    var showPath = shown !== null && shown.found && upto === total;
    for (var i = 0; i < cells.length; i++) {
      var visited = shown !== null && shown.pos[i] >= 0 && shown.pos[i] < upto;
      var onPath = showPath && shown.inPath[i] === 1;
      cells[i].setAttribute('data-visited', visited ? 'true' : 'false');
      cells[i].setAttribute('data-path', onPath ? 'true' : 'false');
      cells[i].style.backgroundColor = onPath ? PATH_COLOUR : visited ? VISITED_COLOUR : COLOUR[map.name[i]];
    }
  }

  function show(algorithm, raw) {
    var N = map.R * map.C;
    var pos = new Int32Array(N).fill(-1);
    for (var k = 0; k < raw.order.length; k++) pos[raw.order[k]] = k;
    var inPath = new Uint8Array(N);
    for (var j = 0; j < raw.path.length; j++) inPath[raw.path[j]] = 1;
    shown = { algorithm: algorithm, found: raw.found, path: raw.path, order: raw.order, pos: pos, inPath: inPath };
    scrubEl.max = String(raw.order.length);
    scrubEl.value = String(raw.order.length);
    paint(raw.order.length);
    showStats(raw);
    showStatus(algorithm, raw);
  }

  function solve(algorithm) {
    if (!map) throw new Error('No map is loaded.');
    if (!LABEL.hasOwnProperty(algorithm)) throw new Error('Unknown algorithm: ' + algorithm);
    stopPlayback();
    var raw = search(map, algorithm);
    show(algorithm, raw);
    var out = {
      found: raw.found,
      path: raw.path.map(toRC),
      cost: raw.cost,
      order: raw.order.map(toRC)
    };
    last = { found: out.found, path: out.path, cost: out.cost, order: out.order, algorithm: algorithm };
    return { found: out.found, path: out.path, cost: out.cost, order: out.order };
  }

  function layout() {
    if (!map) return;
    var bw = boardEl.clientWidth - 24;
    var bh = boardEl.clientHeight - 24;
    var s = Math.floor(Math.min((bw - (map.C - 1) * GAP) / map.C, (bh - (map.R - 1) * GAP) / map.R));
    if (!(s >= MIN_CELL)) s = MIN_CELL;
    gridEl.style.gridTemplateColumns = 'repeat(' + map.C + ', ' + s + 'px)';
    gridEl.style.gridAutoRows = s + 'px';
    for (var i = 0; i < cells.length; i++) {
      cells[i].style.width = s + 'px';
      cells[i].style.height = s + 'px';
    }
  }

  function buildCells() {
    gridEl.textContent = '';
    cells = [];
    for (var r = 0; r < map.R; r++) {
      for (var c = 0; c < map.C; c++) {
        var i = r * map.C + c;
        var el = document.createElement('div');
        el.className = 'cell';
        el.setAttribute('data-r', String(r));
        el.setAttribute('data-c', String(c));
        el.setAttribute('data-terrain', map.name[i]);
        el.setAttribute('data-visited', 'false');
        el.setAttribute('data-path', 'false');
        if (i === map.startI) { el.setAttribute('data-role', 'start'); el.classList.add('is-start'); }
        if (i === map.goalI) { el.setAttribute('data-role', 'goal'); el.classList.add('is-goal'); }
        gridEl.appendChild(el);
        cells.push(el);
      }
    }
    layout();
  }

  function showEmpty() {
    costEl.textContent = '-';
    movesEl.textContent = '-';
    expandedEl.textContent = '-';
    scrubEl.max = '0';
    scrubEl.value = '0';
    statusEl.setAttribute('data-state', 'idle');
    statusEl.textContent = 'Map loaded. Press Run, or click a cell to toggle a wall.';
  }

  function loadGrid(spec) {
    stopPlayback();
    map = parseSpec(spec);
    shown = null;
    last = null;
    buildCells();
    diagEl.checked = map.diagonals;
    paint(0);
    showEmpty();
    return true;
  }

  function setTerrain(i, ch) {
    var r = rowOf(map, i), c = colOf(map, i);
    map.rows[r] = map.rows[r].slice(0, c) + ch + map.rows[r].slice(c + 1);
    map.cost[i] = ch === '#' ? -1 : TERRAIN_COST[ch];
    map.name[i] = TERRAIN_NAME[ch];
    cells[i].setAttribute('data-terrain', map.name[i]);
    map.cmin = computeCmin(map);
  }

  // The displayed algorithm runs again after an edit, or the selected one if nothing is shown.
  function resolveAfterEdit() {
    solve(shown ? shown.algorithm : algoEl.value);
  }

  function toggleCell(i) {
    if (i === map.startI || i === map.goalI) return;
    var current = map.rows[rowOf(map, i)].charAt(colOf(map, i));
    setTerrain(i, current === '#' ? '.' : '#');
    resolveAfterEdit();
  }

  function stopPlayback() {
    if (playRaf !== null) {
      cancelAnimationFrame(playRaf);
      playRaf = null;
    }
    playEl.textContent = 'Play';
  }

  function togglePlay() {
    if (playRaf !== null) { stopPlayback(); return; }
    if (!shown) return;
    var total = shown.order.length;
    if (Number(scrubEl.value) >= total) { scrubEl.value = '0'; paint(0); }
    playEl.textContent = 'Pause';
    var step = Math.max(1, Math.ceil(total / 150));
    var tick = function () {
      var k = Math.min(total, Number(scrubEl.value) + step);
      scrubEl.value = String(k);
      paint(k);
      if (k >= total) {
        playRaf = null;
        playEl.textContent = 'Play';
        return;
      }
      playRaf = requestAnimationFrame(tick);
    };
    playRaf = requestAnimationFrame(tick);
  }

  function guard(fn) {
    try {
      fn();
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
    }
  }

  window.__bench = {
    loadGrid: loadGrid,
    solve: solve,
    last: function () { return last; }
  };

  window.addEventListener('resize', layout);
  gridEl.addEventListener('click', function (event) {
    var target = event.target;
    var el = target && target.closest ? target.closest('[data-r][data-c]') : null;
    if (!el || !map) return;
    var i = Number(el.getAttribute('data-r')) * map.C + Number(el.getAttribute('data-c'));
    guard(function () { toggleCell(i); });
  });
  byId('run').addEventListener('click', function () {
    guard(function () { solve(algoEl.value); });
  });
  playEl.addEventListener('click', togglePlay);
  diagEl.addEventListener('change', function () {
    if (!map) return;
    map.diagonals = diagEl.checked;
    guard(function () { if (shown) solve(shown.algorithm); });
  });
  scrubEl.addEventListener('input', function () {
    stopPlayback();
    if (shown) paint(Number(scrubEl.value));
  });

  try {
    loadGrid({ rows: DEMO_ROWS, start: [1, 1], goal: [18, 30], diagonals: false });
    algoEl.value = 'astar';
    solve('astar');
  } catch (e) {
    errorEl.hidden = false;
    errorEl.textContent = 'Start-up error: ' + (e && e.message ? e.message : String(e));
  }
})();
</script>
</body>
</html>
`

function demoRowsJs(): string {
  return DEMO_ROWS.map((row) => `  '${row}',`).join('\n')
}

/** The good artifact: a complete page that passes every check. */
export const goodArtifact: string = GOOD_TEMPLATE.replace(DEMO_PLACEHOLDER, () => demoRowsJs())

/** Replace one literal region, which must occur exactly once in the source. */
function replaceOnce(source: string, from: string, to: string, label: string): string {
  const occurrences = source.split(from).length - 1
  if (occurrences !== 1) {
    throw new Error(`mutation ${label}: expected the region once, found ${occurrences}`)
  }
  const out = source.replace(from, () => to)
  if (out === source) throw new Error(`mutation ${label}: the replacement did not change the text`)
  return out
}

interface Edit {
  from: string
  to: string
}

function mutate(label: string, edits: Edit[]): string {
  let source = goodArtifact
  for (const edit of edits) source = replaceOnce(source, edit.from, edit.to, label)
  return source
}

/** Mutation 1: cells are a fixed 28 px, so a 24 x 40 map overflows the viewport. */
const FIXED_CELLS = mutate('fixed-cells', [
  {
    from: 'var s = Math.floor(Math.min((bw - (map.C - 1) * GAP) / map.C, (bh - (map.R - 1) * GAP) / map.R));',
    to: 'var s = 28;',
  },
])

/** Mutation 2: Dijkstra explores every reachable cell before returning (A* and BFS still stop). */
const DIJKSTRA_NO_STOP = mutate('dijkstra-no-early-stop', [
  { from: 'if (w === goal) { found = true; break; }', to: "if (w === goal) { found = true; if (algorithm !== 'dijkstra') break; }" },
])

/** Mutation 3: A* uses Manhattan x 1 even when roads cost 0.5. */
const UNSCALED_HEURISTIC = mutate('unscaled-heuristic', [{ from: 'return cm * d;', to: 'return d;' }])

/** Mutation 4: A* runs with h = 0. */
const ZERO_HEURISTIC = mutate('astar-zero-heuristic', [{ from: 'return cm * d;', to: 'return 0;' }])

/** Mutation 5: BFS reports the number of moves as its cost. */
const BFS_MOVE_COST = mutate('bfs-move-cost', [
  { from: '(algorithm === \'bfs\' ? pathCost(m, path) : g[goal])', to: "(algorithm === 'bfs' ? path.length - 1 : g[goal])" },
])

/** Mutation 6: an unreachable goal keeps status 'found' and cost Infinity. */
const NO_PATH_STATUS = mutate('no-path-status', [
  { from: "statusEl.setAttribute('data-state', raw.found ? 'found' : 'no-path');", to: "statusEl.setAttribute('data-state', 'found');" },
  {
    from: "var cost = found ? (algorithm === 'bfs' ? pathCost(m, path) : g[goal]) : null;",
    to: "var cost = found ? (algorithm === 'bfs' ? pathCost(m, path) : g[goal]) : Infinity;",
  },
])

/** Mutation 7: diagonal moves may squeeze between two walls. */
const CORNER_CUTTING = mutate('corner-cutting', [
  {
    from: 'if (m.cost[v] < 0 || m.cost[sideA] < 0 || m.cost[sideB] < 0) continue; // corner rule',
    to: 'if (m.cost[v] < 0) continue;',
  },
])

/** Mutation 8: the scrubber moves but the grid always shows the finished search. */
const SCRUB_STATIC = mutate('scrub-static', [
  { from: 'var upto = Math.max(0, Math.min(k, total));', to: 'var upto = total;' },
])

/** Mutation 9: a click toggles the wall but the old result stays on screen. */
const EDIT_NO_RESOLVE = mutate('edit-no-resolve', [{ from: '    resolveAfterEdit();', to: '    /* the old result stays */' }])

/** Mutation 10: #stat-expanded shows the path length. */
const STAT_EXPANDED = mutate('stat-expanded', [
  { from: 'expandedEl.textContent = String(raw.order.length);', to: 'expandedEl.textContent = String(raw.path.length);' },
])

/** Good variant: every paint replaces the cell elements with fresh ones (a common way to write this page). */
const RERENDER_CELLS = mutate('rerender-cells', [
  {
    from: '      var onPath = showPath && shown.inPath[i] === 1;\n',
    to: '      var onPath = showPath && shown.inPath[i] === 1;\n      var fresh = cells[i].cloneNode(true); cells[i].parentNode.replaceChild(fresh, cells[i]); cells[i] = fresh;\n',
  },
])

/** Good variant: the whole palette written in oklch(), which the Node colour parser does not read. */
const OKLCH_PALETTE = mutate('oklch-palette', [
  {
    from: "  var COLOUR = { wall: '#14161c', open: '#4a5568', mud: '#8b5e34', road: '#e6c229' };\n  var VISITED_COLOUR = '#1f6f78';\n  var PATH_COLOUR = '#ff6ec7';",
    to: "  var COLOUR = { wall: 'oklch(0.2 0.02 265)', open: 'oklch(0.45 0.03 260)', mud: 'oklch(0.5 0.09 60)', road: 'oklch(0.82 0.16 95)' };\n  var VISITED_COLOUR = 'oklch(0.5 0.08 200)';\n  var PATH_COLOUR = 'oklch(0.72 0.22 350)';",
  },
])

/** Good variant: the grid fades in with an entrance animation that fills forwards (opacity 0 at rest). */
const ENTRANCE_FADE = mutate('entrance-fade', [
  {
    from: '#grid{display:grid;gap:2px}',
    to: '#grid{display:grid;gap:2px;opacity:0;animation:path-enter .4s ease-out forwards}@keyframes path-enter{to{opacity:1}}',
  },
])

/** Good variant: the returned object carries an extra field that changes between calls (a timing). */
const EXTRA_RESULT_FIELD = mutate('extra-result-field', [
  {
    from: '    return { found: out.found, path: out.path, cost: out.cost, order: out.order };',
    to: '    return { found: out.found, path: out.path, cost: out.cost, order: out.order, ms: performance.now() };',
  },
])

/** Cheat: solve() returns the same trivial result for every map: a start-only path with cost 0. */
const TRIVIAL_SOLVE = mutate('trivial-solve', [
  { from: 'var raw = search(map, algorithm);', to: 'var raw = { found: true, path: [map.startI], cost: 0, order: [map.startI] };' },
])

/** Cheat: solve() never searches. It returns a fixed route that bounces on the goal, with two cells expanded. */
const NO_SEARCH = mutate('no-search', [
  {
    from: 'var raw = search(map, algorithm);',
    to: 'var raw = { found: true, path: [map.goalI, map.goalI, map.goalI, map.goalI, map.goalI, map.goalI, map.goalI, map.goalI, map.goalI], cost: 0, order: [map.startI, map.goalI] };',
  },
])

/** Broken: BFS reports NaN as its cost (the NaN passed the old comparison). */
const BFS_NAN_COST = mutate('bfs-nan-cost', [
  { from: "(algorithm === 'bfs' ? pathCost(m, path) : g[goal])", to: "(algorithm === 'bfs' ? NaN : g[goal])" },
])

/** Broken: every found result reports NaN as its cost, and the stats show a fixed 123.4567. */
const NAN_ALL_COSTS = mutate('nan-all-costs', [
  { from: "var cost = found ? (algorithm === 'bfs' ? pathCost(m, path) : g[goal]) : null;", to: 'var cost = found ? NaN : null;' },
  { from: 'costEl.textContent = raw.cost.toFixed(4);', to: "costEl.textContent = '123.4567';" },
])

/** Broken: the grid is drawn with opacity 0 (present, but not visible). */
const INVISIBLE_GRID = mutate('invisible-grid', [{ from: '#grid{display:grid;gap:2px}', to: '#grid{display:grid;gap:2px;opacity:0}' }])

/** Broken: the grid sits in a 150 px scrolling box, so most rows of a 24 x 40 map need scrolling. */
const SCROLL_CLIP = mutate('scroll-clip', [
  { from: '.stage{flex:1 1 0;min-height:0;display:flex}', to: '.stage{flex:1 1 0;min-height:0;display:block}' },
  {
    from: '#board{flex:1 1 0;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:12px}',
    to: '#board{flex:0 0 150px;height:150px;min-width:0;min-height:0;display:block;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px}',
  },
  { from: 'var s = Math.floor(Math.min((bw - (map.C - 1) * GAP) / map.C, (bh - (map.R - 1) * GAP) / map.R));', to: 'var s = 12;' },
])

/** Broken: the grid is one pixel outside the window on the left and top. */
const OVERFLOW_1PX = mutate('overflow-1px', [
  { from: '#grid{display:grid;gap:2px}', to: '#grid{display:grid;gap:2px;position:fixed;left:-1px;top:-1px}' },
  { from: 'var s = Math.floor(Math.min((bw - (map.C - 1) * GAP) / map.C, (bh - (map.R - 1) * GAP) / map.R));', to: 'var s = 10;' },
])

/** Broken: the controls row (algorithm, Run, Diagonals, Play, scrubber) is not displayed. */
const NO_UI_CONTROLS = mutate('no-ui-controls', [
  { from: '.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}', to: '.controls{display:none}' },
])

/** Broken: cells are built on the next animation frame, so the page does not redraw synchronously. */
const ASYNC_RENDER = mutate('async-render', [
  {
    from: '    buildCells();\n    diagEl.checked = map.diagonals;\n    paint(0);\n',
    to: '    var m0 = map;\n    requestAnimationFrame(function () { if (map !== m0) return; buildCells(); if (shown) paint(Number(scrubEl.value)); else paint(0); });\n    diagEl.checked = map.diagonals;\n',
  },
])

export interface Fixture {
  name: string
  html: string
  /** The one-line description of what the fixture does. */
  note: string
}

/** Conforming variants that must score 100: they differ from the reference in ways the spec allows. */
export const goodVariants: readonly Fixture[] = [
  { name: 'path-good-rerender-cells', html: RERENDER_CELLS, note: 'every paint replaces the cell elements with new ones' },
  { name: 'path-good-oklch-colours', html: OKLCH_PALETTE, note: 'the palette is written in oklch()' },
  { name: 'path-good-extra-result-field', html: EXTRA_RESULT_FIELD, note: 'solve() returns an extra field that changes between calls' },
  { name: 'path-good-entrance-fade', html: ENTRANCE_FADE, note: 'the grid fades in with an entrance animation that fills forwards' },
]

/** The broken variants, in the order the specification gives them. */
export const brokenArtifacts: readonly Fixture[] = [
  { name: 'path-broken-fixed-cells', html: FIXED_CELLS, note: 'cells are a fixed 28 px; the 24 x 40 grid overflows 1024 px' },
  { name: 'path-broken-dijkstra-no-early-stop', html: DIJKSTRA_NO_STOP, note: 'Dijkstra expands every reachable cell' },
  { name: 'path-broken-unscaled-heuristic', html: UNSCALED_HEURISTIC, note: 'A* uses Manhattan x 1 (no cmin factor)' },
  { name: 'path-broken-astar-zero-heuristic', html: ZERO_HEURISTIC, note: 'A* uses h = 0' },
  { name: 'path-broken-bfs-move-cost', html: BFS_MOVE_COST, note: 'BFS reports the move count as its cost' },
  { name: 'path-broken-no-path-status', html: NO_PATH_STATUS, note: 'unreachable goal: status stays found, cost Infinity' },
  { name: 'path-broken-corner-cutting', html: CORNER_CUTTING, note: 'diagonal moves cut corners' },
  { name: 'path-broken-scrub-static', html: SCRUB_STATIC, note: 'the scrubber moves but the grid shows the finished search' },
  { name: 'path-broken-edit-no-resolve', html: EDIT_NO_RESOLVE, note: 'a click toggles the wall without re-solving' },
  { name: 'path-broken-stat-expanded', html: STAT_EXPANDED, note: '#stat-expanded shows the path length' },
  { name: 'path-broken-trivial-solve', html: TRIVIAL_SOLVE, note: 'solve() always returns a start-only path with cost 0' },
  { name: 'path-broken-no-search', html: NO_SEARCH, note: 'solve() returns a fixed route that bounces on the goal, without searching' },
  { name: 'path-broken-bfs-nan-cost', html: BFS_NAN_COST, note: 'BFS reports NaN as its cost' },
  { name: 'path-broken-nan-costs', html: NAN_ALL_COSTS, note: 'every found result reports NaN as its cost; the stats show 123.4567' },
  { name: 'path-broken-invisible-grid', html: INVISIBLE_GRID, note: 'the grid is drawn with opacity 0' },
  { name: 'path-broken-scroll-clip', html: SCROLL_CLIP, note: 'the grid sits in a 150 px scrolling box with most rows out of sight' },
  { name: 'path-broken-overflow-1px', html: OVERFLOW_1PX, note: 'the grid starts 1 px left and above the window' },
  { name: 'path-broken-no-ui-controls', html: NO_UI_CONTROLS, note: 'the controls row, including the scrubber, is not displayed' },
  { name: 'path-broken-async-render', html: ASYNC_RENDER, note: 'cells are built on the next animation frame, not synchronously' },
]

/**
 * The reference's A* result on the demo map: what solve() returns for the static control. Its
 * markup (cost, moves, expanded count and scrubber range) shows the same numbers, so the control
 * is consistent with itself, and nothing about it is right for any map that is loaded.
 */
function demoResult(): { found: boolean; path: RC[]; cost: number; order: RC[] } {
  const map: PathMap = {
    rows: [...DEMO_ROWS],
    start: [DEMO_START[0], DEMO_START[1]],
    goal: [DEMO_GOAL[0], DEMO_GOAL[1]],
    diagonals: false,
  }
  const { C } = dims(map)
  const raw = referenceSearch(map, { heuristic: (i) => heuristicValue(map, Math.floor(i / C), i % C) })
  if (raw.cost === null) throw new Error('the demo map has no path')
  const rc = (i: number): RC => [Math.floor(i / C), i % C]
  return { found: true, path: raw.path.map(rc), cost: raw.cost, order: raw.order.map(rc) }
}

/**
 * The composite control: the demo map drawn statically, and solve() returns the demo result whatever
 * is loaded. It has every element and id, consistent values, and no behaviour.
 */
function staticFake(): string {
  const colour: Record<string, string> = { '#': '#14161c', '.': '#4a5568', '~': '#8b5e34', '=': '#e6c229' }
  const name: Record<string, string> = { '#': 'wall', '.': 'open', '~': 'mud', '=': 'road' }
  const result = demoResult()
  const expanded = result.order.length
  const body: string[] = []
  DEMO_ROWS.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row.charAt(c)
      const role = r === DEMO_START[0] && c === DEMO_START[1] ? ' data-role="start"' : r === DEMO_GOAL[0] && c === DEMO_GOAL[1] ? ' data-role="goal"' : ''
      body.push(
        `<div class="cell" data-r="${r}" data-c="${c}" data-terrain="${name[ch]}"${role} data-visited="false" data-path="false" style="background-color:${colour[ch]}"></div>`
      )
    }
  })
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pathfinding Lab</title>
<style>
html,body{margin:0;background:#0c0c10;color:#ececf0;font-family:system-ui,sans-serif}
#grid{display:grid;grid-template-columns:repeat(32,20px);gap:2px;margin:12px}
.cell{width:20px;height:20px}
</style>
</head>
<body>
<select id="algo"><option value="bfs">BFS</option><option value="dijkstra">Dijkstra</option><option value="astar" selected>A*</option></select>
<button id="run" type="button">Run</button>
<input type="checkbox" id="diagonals">
<button id="play" type="button">Play</button>
<input type="range" id="scrub" min="0" max="${expanded}" step="1" value="${expanded}">
<div id="grid">${body.join('')}</div>
<output id="stat-cost">${result.cost.toFixed(4)}</output>
<output id="stat-moves">${result.path.length - 1}</output>
<output id="stat-expanded">${expanded}</output>
<div id="status" data-state="found">Found a path.</div>
<script>
window.__bench = {
  loadGrid: function () { return true; },
  solve: function () { return ${JSON.stringify(result)}; },
  last: function () { return null; }
};
</script>
</body>
</html>
`
}

export const staticFakeArtifact: string = staticFake()

/** Every fixture, in the order the specification lists them. */
export const fixtures: readonly Fixture[] = [
  { name: 'path-good', html: goodArtifact, note: 'the reference solution' },
  ...goodVariants,
  ...brokenArtifacts,
  { name: 'path-control-static-fake', html: staticFakeArtifact, note: 'static drawing, fixed solve() result' },
]

/**
 * Which checks each fixture must fail. 'good' passes all; 'static' fails all; a list names
 * the exact checks that fail and every other check passes.
 */
export const expectations: Record<string, 'good' | 'static' | readonly string[]> = {
  'path-good': 'good',
  'path-good-rerender-cells': 'good',
  'path-good-oklch-colours': 'good',
  'path-good-extra-result-field': 'good',
  'path-good-entrance-fade': 'good',
  'path-broken-fixed-cells': ['path-grid-render'],
  'path-broken-dijkstra-no-early-stop': ['path-dijkstra'],
  'path-broken-unscaled-heuristic': ['path-astar-optimal'],
  'path-broken-astar-zero-heuristic': ['path-astar-expansion'],
  'path-broken-bfs-move-cost': ['path-bfs'],
  'path-broken-no-path-status': ['path-no-path-trivial'],
  'path-broken-corner-cutting': ['path-diagonal-rules'],
  'path-broken-scrub-static': ['path-visual-sync'],
  'path-broken-edit-no-resolve': ['path-edit-resolve'],
  'path-broken-stat-expanded': ['path-stats-dom'],
  'path-broken-trivial-solve': ['path-dijkstra', 'path-astar-optimal', 'path-astar-expansion', 'path-bfs', 'path-no-path-trivial', 'path-diagonal-rules', 'path-visual-sync', 'path-edit-resolve', 'path-stats-dom'],
  'path-broken-no-search': ['path-dijkstra', 'path-astar-optimal', 'path-astar-expansion', 'path-bfs', 'path-no-path-trivial', 'path-diagonal-rules', 'path-visual-sync', 'path-edit-resolve', 'path-stats-dom'],
  'path-broken-bfs-nan-cost': ['path-bfs'],
  'path-broken-nan-costs': ['path-dijkstra', 'path-astar-optimal', 'path-astar-expansion', 'path-bfs', 'path-no-path-trivial', 'path-diagonal-rules', 'path-visual-sync', 'path-edit-resolve', 'path-stats-dom'],
  'path-broken-invisible-grid': ['path-grid-render', 'path-visual-sync'],
  'path-broken-scroll-clip': ['path-grid-render', 'path-visual-sync'],
  'path-broken-overflow-1px': ['path-grid-render'],
  'path-broken-no-ui-controls': ['path-stats-dom'],
  'path-broken-async-render': ['path-grid-render', 'path-visual-sync'],
  'path-control-static-fake': 'static',
}
