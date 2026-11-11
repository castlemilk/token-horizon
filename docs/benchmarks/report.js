/*
 * Token Horizon benchmark report. Plain browser script, no build step.
 *
 * Reads window.__BOARD__ (set by data/board.js). Everything on the page is
 * rendered from that object; there are no hard-coded models, tasks or numbers.
 * Model-written HTML is never run here. The page shows only the captured images
 * (taken by the capture step) and the stored measurements.
 *
 * Layout of this file:
 *   1. constants and small helpers (DOM, number formats, scales, tooltip, chart focus)
 *   2. data indexes and the filter state
 *   3. one render function per section
 *   4. artifact dialog, theme toggle, hash state, resize handling, startup
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var B = window.__BOARD__ || null;
  var D = null;
  var TIERS = ['fable', 'opus', 'sonnet', 'haiku'];
  var TIER_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
  var SCOPE_LABEL = { headline: 'Headline tasks', horizon: 'Horizon tasks', smoke: 'Smoke tier', earlier: [].join('') };
  var SCOPE_ORDER = ['headline', 'horizon', 'smoke', 'earlier'];
  var MODEL_LABEL = { claude: 'Claude family', all: 'All models' };
  var MODEL_ORDER = ['claude', 'all'];
  var SUITE_ORDER = ['horizon', 'classic', 'smoke'];
  var RAMP_LOWS = [0, 20, 40, 60, 80, 95];
  var RAMP_LABELS = ['0 to 19.9', '20 to 39.9', '40 to 59.9', '60 to 79.9', '80 to 94.9', '95 to 100'];
  var ROUTE_LABEL = { api: 'API', cli: 'Command-line agent', local: 'Local runtime' };
  var PRICING_LABEL = { priced: 'priced per token', 'no-per-token-price': 'no per-token price', 'price-under-review': 'price under review' };
  var EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  /** Base models with at least two effort levels anywhere on the board. The section is hidden when there are none. */
  var EFFORT_BASES = [];
  /** A model covers a scope when it has results for at least this share of the scope's tasks. */
  var COVER_SHARE = 0.8;
  /** Scorer version 2 is the current scorer. Headline, horizon and smoke use only its records; earlier holds version 1. */
  var CURRENT_SCORER = 2;
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { /* no matchMedia */ }

  var state = { scope: 'headline', models: 'all', tableKey: 'score', tableDir: 'desc', pendingSection: null };
  var uidN = 0;
  var pending = null;
  var tipEl = null;

  // ── 1. helpers ─────────────────────────────────────────────────────────

  function uid(prefix) { uidN += 1; return prefix + '-' + uidN; }
  function slot(id) { return document.getElementById('body-' + id); }
  function clear(node) { if (node) node.replaceChildren(); }

  /** HTML element builder. props: attributes, `text`, and on* listeners. */
  function h(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') { node.textContent = tight(v); return; }
      if (k.indexOf('on') === 0 && typeof v === 'function') { node.addEventListener(k.slice(2), v); return; }
      node.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    if (child instanceof Node) { node.appendChild(child); return; }
    node.appendChild(document.createTextNode(String(child)));
  }

  /** SVG element builder. Attribute values are set as strings; `text` sets textContent. */
  function svgNode(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') { n.textContent = String(v); return; }
      n.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i]) n.appendChild(arguments[i]);
    }
    return n;
  }

  /**
   * Root svg with a <title> and aria-label that state what the chart shows. Charts with focusable
   * marks use role "group" so the marks, not the whole chart, are what assistive tools announce.
   */
  function svgRoot(width, height, label, desc, role) {
    var titleId = uid('svg-title');
    var root = svgNode('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: role || 'img', 'aria-label': label, 'aria-labelledby': titleId, focusable: 'false', class: 'chart'
    });
    root.appendChild(svgNode('title', { id: titleId, text: label }));
    if (desc) root.appendChild(svgNode('desc', { text: desc }));
    return root;
  }

  /**
   * The layout width is read once per render, before any section is cleared. Reading a
   * width mid-render forces a layout of a half-empty page, and the browser then clamps
   * the scroll position.
   */
  var layoutW = 0;
  function readLayoutWidth() {
    var main = document.getElementById('main');
    layoutW = main ? main.clientWidth : 0;
  }
  /** Inner width of a chart inside a .panel: main less the wrap gutters, less the panel padding and border. */
  /** From this page width, every frontier member and base model is named beside its dot; narrower, frontier members are numbered and listed by name. */
  var NAMES_FIT_WIDTH = 900;
  function plotWidth(min) {
    return Math.max(min, layoutW - 32 - 34);
  }

  function linear(d0, d1, r0, r1) {
    var span = d1 - d0 || 1;
    return function (v) { return r0 + (v - d0) * (r1 - r0) / span; };
  }
  function logScale(d0, d1, r0, r1) {
    var a = Math.log10(d0), b = Math.log10(d1), span = b - a || 1;
    return function (v) { return r0 + (Math.log10(v) - a) * (r1 - r0) / span; };
  }

  function hasNum(v) { return typeof v === 'number' && isFinite(v); }
  /**
   * One decimal, rounded half up. The epsilon stops binary noise from rounding a true half down: 96.05 is stored as
   * 96.0499999..., and toFixed alone would print 96.0. Every one-decimal figure on the page is formatted here.
   */
  function oneDp(v) { return (Math.round(v * 10 + 1e-9) / 10).toFixed(1); }
  /** A whole count of tokens with its thousands separators, for example 128,000. */
  function tokenCount(v) { return hasNum(v) ? Math.round(v).toLocaleString('en-US') : 'not measured'; }
  function num(v, digits) { return hasNum(v) ? (digits === 1 ? oneDp(v) : v.toFixed(digits)) : 'not measured'; }
  /** Dollars to three significant figures, trailing zeros kept ($1.60, $0.370), as the findings print them. */
  function usd(v) {
    if (!hasNum(v)) return 'not measured';
    if (v === 0) return '$0';
    return '$' + v.toPrecision(3);
  }
  function secs(ms) { return hasNum(ms) ? oneDp((ms / 1000)) + ' s' : 'not measured'; }
  function ttftSecs(ms) { return hasNum(ms) ? (ms / 1000).toFixed(2) + ' s' : 'not measured'; }
  function tps(v) { return hasNum(v) ? oneDp(v) + ' tokens/s' : 'not measured'; }
  function integer(v) { return hasNum(v) ? Math.round(v).toLocaleString('en-US') : 'not measured'; }
  function pct(v) { return hasNum(v) ? oneDp((v * 100)) + '%' : 'not measured'; }
  function intervalText(iv) {
    if (!iv) return 'not measured';
    return '[' + oneDp(iv[0]) + ' to ' + oneDp(iv[1]) + ']';
  }
  function rampStep(score) {
    var k = 0;
    for (var i = 0; i < RAMP_LOWS.length; i++) if (score >= RAMP_LOWS[i]) k = i;
    return k;
  }
  function rel(path) { return './' + String(path).replace(/^dist\//, ''); }
  /** Name with its effort in brackets, unless the name already says the effort. */
  function labelName(m) {
    var paren = /\(([^)]+)\)\s*$/.exec(m.name);
    var said = !!(paren && /low|medium|high|max|ultra/i.test(paren[1]));
    return m.name + (m.effort && !said ? ' (' + effortWord(m.effort) + ' effort)' : '');
  }
  /** Effort in words, as the findings say it: "extra high" for xhigh. */
  function effortWord(effort) { return effort === 'xhigh' ? 'extra high' : effort; }
  function tierOf(m) {
    if (!m || m.group !== 'claude') return null;
    var text = (m.name + ' ' + (m.family || '') + ' ' + (m.baseModelId || '')).toLowerCase();
    for (var i = 0; i < TIERS.length; i++) if (text.indexOf(TIERS[i]) >= 0) return TIERS[i];
    return null;
  }
  function tierClass(m) { var t = tierOf(m); return t ? 'tier-' + t : 'tier-other'; }
  function strokeClass(m) { var t = tierOf(m); return t ? 'stroke-' + t : 'stroke-other'; }
  function ordinal(list, value) { var i = list.indexOf(value); return i < 0 ? 999 : i; }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  /**
   * Text as the page shows it: a number and the word after it are joined by a no-break space ("98.5 pts",
   * "1024 x 720", "2 of 5"), so a figure never splits from its unit at a line end.
   */
  function tight(s) {
    return String(s).replace(/(\d) (?=[A-Za-z%])/g, '$1 ').replace(/(\d) x (?=\d)/g, '$1 x ');
  }
  /** A span that never breaks across lines: a date, a timestamp or a range. */
  function nw(text) { return h('span', { class: 'nw', text: text }); }

  /** Median of finite values; null when none. */
  function median(xs) {
    var v = xs.filter(hasNum).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // ── tooltip (one shared element) ───────────────────────────────────────

  function tipNode() {
    if (!tipEl) {
      tipEl = h('div', { id: 'tip', class: 'tip', role: 'presentation', 'aria-hidden': 'true', hidden: true });
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(anchor, content) {
    if (!content) return;
    var t = tipNode();
    t.replaceChildren();
    t.appendChild(h('strong', { class: 'tip-title', text: content.title }));
    content.lines.forEach(function (line) {
      t.appendChild(h('div', { class: 'tip-line', text: line }));
    });
    t.hidden = false;
    var r = anchor.getBoundingClientRect();
    var sx = window.scrollX, sy = window.scrollY;
    var tw = t.offsetWidth, th = t.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var left = r.left + r.width / 2 + sx - tw / 2;
    left = Math.max(sx + 8, Math.min(left, sx + vw - tw - 8));
    var top = r.top + sy - th - 10;
    if (top < sy + 8) top = r.bottom + sy + 10;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }
  /** Hover and keyboard focus both show the tooltip. `fn` is called lazily. */
  function bindTip(node, fn) {
    node.addEventListener('pointerenter', function () { showTip(node, fn()); });
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', function () { showTip(node, fn()); });
    node.addEventListener('blur', hideTip);
  }

  // ── roving tabindex: one tab stop per chart, arrow keys between its marks ─

  /**
   * Makes a chart one tab stop. Tab reaches the current mark; arrow keys (and Home and End) move
   * between marks. Scatter, reliability and speed charts use it, so a chart costs one stop, not one per mark.
   */
  function rovingMarks(svg, selector) {
    var items = Array.prototype.slice.call(svg.querySelectorAll(selector));
    if (!items.length) return;
    function setStop(current) {
      items.forEach(function (g) { g.setAttribute('tabindex', g === current ? '0' : '-1'); });
    }
    function markOf(node) { return node && node.closest ? node.closest(selector) : null; }
    setStop(items[0]);
    // The chart root is not a stop of its own: an SVG with a focus listener is focusable in Chromium,
    // which would add a second Tab stop before the first mark.
    svg.setAttribute('tabindex', '-1');
    svg.addEventListener('focusin', function (e) {
      var m = markOf(e.target);
      if (m && items.indexOf(m) >= 0) setStop(m);
    });
    svg.addEventListener('keydown', function (e) {
      var keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
      if (keys.indexOf(e.key) < 0) return;
      var i = items.indexOf(markOf(e.target));
      if (i < 0) return;
      var n = i;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = Math.min(items.length - 1, i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = Math.max(0, i - 1);
      else if (e.key === 'Home') n = 0;
      else n = items.length - 1;
      e.preventDefault();
      setStop(items[n]);
      items[n].focus();
    });
  }

  // ── roving tabindex for grids (heat map, checks matrix) ─────────────────

  function enableGrid(container) {
    var cells = function () { return Array.prototype.slice.call(container.querySelectorAll('[data-r][data-c]')); };
    var all = cells();
    all.forEach(function (c, i) { c.setAttribute('tabindex', i === 0 ? '0' : '-1'); });
    container.addEventListener('focusin', function (e) {
      if (!e.target.hasAttribute || !e.target.hasAttribute('data-r')) return;
      cells().forEach(function (c) { c.setAttribute('tabindex', c === e.target ? '0' : '-1'); });
    });
    container.addEventListener('keydown', function (e) {
      var keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (keys.indexOf(e.key) < 0) return;
      var cur = e.target;
      if (!cur.hasAttribute || !cur.hasAttribute('data-r')) return;
      var r = Number(cur.getAttribute('data-r')), c = Number(cur.getAttribute('data-c'));
      var list = cells();
      var target = null;
      if (e.key === 'Home') target = list.filter(function (x) { return Number(x.getAttribute('data-r')) === r; })[0];
      else if (e.key === 'End') { var row = list.filter(function (x) { return Number(x.getAttribute('data-r')) === r; }); target = row[row.length - 1]; }
      else {
        var dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        var dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (dr) {
          // skip header rows that hold no cells; stay in the same column where possible
          var rowNum = r + dr;
          var maxRow = Math.max.apply(null, list.map(function (x) { return Number(x.getAttribute('data-r')); }));
          while (rowNum >= 0 && rowNum <= maxRow) {
            var rowCells = list.filter(function (x) { return Number(x.getAttribute('data-r')) === rowNum; });
            if (rowCells.length) {
              target = rowCells.reduce(function (best, x) {
                return Math.abs(Number(x.getAttribute('data-c')) - c) < Math.abs(Number(best.getAttribute('data-c')) - c) ? x : best;
              });
              break;
            }
            rowNum += dr;
          }
        } else if (dc) {
          target = list.filter(function (x) {
            return Number(x.getAttribute('data-r')) === r && Number(x.getAttribute('data-c')) === c + dc;
          })[0];
        }
      }
      if (target) { e.preventDefault(); target.focus(); }
    });
  }

  // ── 2. data indexes and filter state ───────────────────────────────────

  function prepare(board) {
    var d = {
      board: board,
      models: new Map(),
      tasks: new Map(),
      cellsByModel: new Map(),
      cellByKey: new Map(),
      summaryByKey: new Map(),
      suiteLabel: new Map()
    };
    board.models.forEach(function (m) { d.models.set(m.id, m); });
    board.tasks.forEach(function (t) { d.tasks.set(t.id, t); });
    board.suites.forEach(function (s) { d.suiteLabel.set(s.id, s.label); });
    board.cells.forEach(function (c) {
      d.cellByKey.set(c.modelId + '|' + c.taskId, c);
      var list = d.cellsByModel.get(c.modelId);
      if (!list) { list = []; d.cellsByModel.set(c.modelId, list); }
      list.push(c);
    });
    board.summaries.forEach(function (s) { d.summaryByKey.set(s.modelId + '|' + s.scope, s); });
    return d;
  }

  function taskInScope(task, scope) {
    if (!task) return false;
    if (scope === 'earlier') return true;
    if (scope === 'headline') return !!task.headline;
    if (scope === 'horizon') return task.suite === 'horizon';
    return task.suite === 'smoke';
  }
  /** A cell is in a scope when its task is, and its scorer is the scope's own: version 2 or later, or version 1 for earlier. */
  function cellInScope(c, scope) {
    var current = (c.scorerVersion || 1) >= CURRENT_SCORER;
    if (scope === 'earlier') return !current;
    return current && taskInScope(D.tasks.get(c.taskId), scope);
  }
  function cellsIn(modelId, scope) {
    return (D.cellsByModel.get(modelId) || []).filter(function (c) { return cellInScope(c, scope); });
  }
  /** The cell for a 'model|task' key, when it belongs to the scope on screen; otherwise undefined (shown as not run). */
  function cellAt(key) {
    var c = D.cellByKey.get(key);
    return c && cellInScope(c, state.scope) ? c : undefined;
  }
  function summaryFor(modelId, scope) {
    var s = D.summaryByKey.get(modelId + '|' + scope);
    return s && s.tasksCovered > 0 ? s : null;
  }
  function modelPasses(m, models) { return models !== 'claude' || m.group === 'claude'; }
  /** True when a model has results for at least 80% of the scope's tasks. */
  function coversScope(s) { return s.tasksTotal > 0 && s.tasksCovered >= COVER_SHARE * s.tasksTotal; }

  /**
   * Model rows with results in a scope. Models covering at least 80% of the scope's tasks come first,
   * then by the mean over the tasks each model ran (its all-trials score), best first.
   */
  function rowsFor(scope, models) {
    var rows = [];
    D.board.models.forEach(function (m) {
      if (!modelPasses(m, models)) return;
      var s = summaryFor(m.id, scope);
      if (!s) return;
      rows.push({ m: m, s: s, cells: cellsIn(m.id, scope) });
    });
    rows.sort(function (a, b) {
      return (Number(coversScope(b.s)) - Number(coversScope(a.s))) ||
        (b.s.meanScoreAllTrials - a.s.meanScoreAllTrials) || a.m.name.localeCompare(b.m.name);
    });
    return rows;
  }
  /**
   * The tasks the checks matrix and the gallery show for a scope: the horizon tasks in the horizon scope, and the
   * headline tasks in the headline scope and in the earlier runs. The smoke tier has neither.
   */
  function focusTasks(scope) {
    return D.board.tasks.filter(function (t) {
      return scope === 'horizon' ? t.suite === 'horizon' : !!t.headline;
    });
  }
  /** Models with results on the scope's focus tasks (focusTasks), for the checks matrix and gallery. */
  function focusRows(models, scope) {
    var rows = [];
    var tasks = focusTasks(scope);
    D.board.models.forEach(function (m) {
      if (!modelPasses(m, models)) return;
      var cells = cellsIn(m.id, scope).filter(function (c) { return tasks.indexOf(D.tasks.get(c.taskId)) >= 0; });
      if (!cells.length) return;
      var s = summaryFor(m.id, scope);
      rows.push({ m: m, s: s, cells: cells });
    });
    rows.sort(function (a, b) {
      var sa = a.s ? a.s.meanScoreAllTrials : -1, sb = b.s ? b.s.meanScoreAllTrials : -1;
      return (sb - sa) || a.m.name.localeCompare(b.m.name);
    });
    return rows;
  }
  /** The task ids a scope has data for (board.scopeTasks): a task is in a scope when a record of its scorer covers it. */
  function scopeTaskIds(scope) { return (D.board.scopeTasks && D.board.scopeTasks[scope]) || []; }
  function taskCount(scope) { return scopeTaskIds(scope).length; }
  function orderedTasks(scope) {
    var ids = scopeTaskIds(scope);
    return D.board.tasks.filter(function (t) { return ids.indexOf(t.id) >= 0; }).sort(function (a, b) {
      return ordinal(SUITE_ORDER, a.suite) - ordinal(SUITE_ORDER, b.suite);
    });
  }
  function claudeHeadlineModels() {
    return D.board.models.filter(function (m) { return m.group === 'claude' && summaryFor(m.id, 'headline'); });
  }
  function defaultModels() { return claudeHeadlineModels().length >= 2 ? 'claude' : 'all'; }

  /** The scope line under each section heading. Earlier runs say they are not comparable. */
  function scopeLine(id, rowCount) {
    var el = document.querySelector('[data-scope-line="' + id + '"]');
    if (!el) return;
    var sc = state.scope;
    var text = 'Scope: ' + SCOPE_LABEL[sc] + ' (' + taskCount(sc) + ' tasks). Models: ' + MODEL_LABEL[state.models] +
      (typeof rowCount === 'number' ? ', ' + rowCount + ' with results in this scope.' : '.');
    // The held-back task is stated once, in the method (renderMethod), not in every scope line.
    if (sc === 'earlier') text += [].join('');
    el.textContent = tight(text);
  }

  /** True for the public build (board.source.target), which has no earlier runs and no harness commands. */
  function isPublic() { return !!(D && D.board.source && D.board.source.target === 'public'); }
  /** True when the board carries the smoke scope (the smoke tier has version 2 data). */
  function hasSmoke() { return (D.board.scopes || []).indexOf('smoke') >= 0; }
  /** True when a model stopped at a provider spend limit or quota, in a cell or before any iteration ran. */
  function anyStopped() { return (D.board.source.stoppedCells || 0) > 0 || (D.board.stoppedNotRun || []).length > 0; }

  /**
   * The empty state for a section with no rows in the current scope. It names the scopes that have data for
   * the current model group, and how many models each has, so the reader can switch to one of them.
   * countFn(scope, group) counts models, in every section.
   */
  function emptyNote(box, reason, countFn) {
    var withData = SCOPE_ORDER.filter(function (sc) { return sc !== state.scope && countFn(sc, state.models) > 0; })
      .map(function (sc) { return SCOPE_LABEL[sc] + ' (' + plural(countFn(sc, state.models), 'model') + ')'; });
    box.appendChild(h('div', { class: 'notice-empty', role: 'status' },
      h('strong', { text: 'Nothing to show in ' + SCOPE_LABEL[state.scope] + ' for ' + MODEL_LABEL[state.models] + '. ' }),
      reason + ' ',
      withData.length ? 'Scopes with data for these models: ' + withData.join('; ') + '.' : 'No other scope has a model with results for these models.'));
  }

  /** Names the task columns hidden because no model in view has a record for them. */
  function hiddenNote(hidden) {
    if (!hidden.length) return null;
    return h('p', { class: 'section-foot hidden-note', text: 'Hidden, because no model in view has a record for ' +
      (hidden.length === 1 ? 'this task' : 'these tasks') + ': ' + hidden.map(function (t) { return t.title; }).join('; ') + '.' });
  }

  /** Fills every element that quotes the cost definition from the board, so the page and the data use the same words. */
  function fillCostDefinitions() {
    var text = (D.board.definitions && D.board.definitions.costPerAttempt) || '';
    Array.prototype.forEach.call(document.querySelectorAll('[data-cost-definition]'), function (el) { el.textContent = text; });
  }
  function costDefinition() { return (D.board.definitions && D.board.definitions.costPerAttempt) || ''; }

  /** Tier colour legend for the tiers present among the given models. */
  function tierLegend(models) {
    var present = {};
    models.forEach(function (m) { var t = tierOf(m); if (t) present[t] = true; });
    return TIERS.filter(function (t) { return present[t]; }).map(function (t) {
      return h('span', { class: 'legend-item' }, h('span', { class: 'swatch tier-' + t }), TIER_LABEL[t]);
    });
  }

  // ── header and filters ─────────────────────────────────────────────────

  /**
   * The lede: what the page is showing right now, for the scope and model group on screen. The whole data set is in the
   * method, so the lede does not describe records the reader is not looking at.
   */
  function renderHeader() {
    var rows = rowsFor(state.scope, state.models);
    var cells = [];
    rows.forEach(function (r) { cells = cells.concat(r.cells); });
    var req = cells.reduce(function (s, c) { return s + c.iterations; }, 0);
    var done = cells.reduce(function (s, c) { return s + (c.succeeded || 0); }, 0);
    var dates = cells.map(function (c) { return c.createdAt; }).sort();
    var sentence = document.getElementById('scope-sentence');
    if (!rows.length) {
      sentence.textContent = tight('Showing ' + SCOPE_LABEL[state.scope] + ' for ' + MODEL_LABEL[state.models] + ': no model has results in this scope.');
    } else {
      sentence.replaceChildren(
        'Showing ', h('span', { class: 'num', text: SCOPE_LABEL[state.scope] }), ' for ', MODEL_LABEL[state.models] + ': ',
        h('span', { class: 'num', text: rows.length }), ' ' + (rows.length === 1 ? 'model' : 'models') + ' with results on ',
        h('span', { class: 'num', text: taskCount(state.scope) }), ' ' + (taskCount(state.scope) === 1 ? 'task' : 'tasks') + ', ',
        h('span', { class: 'num', text: integer(req) }), ' iterations requested (',
        h('span', { class: 'num', text: integer(done) }), ' completed), runs dated ',
        nw(dates[0] ? dates[0].slice(0, 10) : 'not measured'), ' to ', nw(dates.length ? dates[dates.length - 1].slice(0, 10) : 'not measured'),
        '. Scored by deterministic checks; every record is listed in the method.');
    }
    var src = D.board.source;
    var banner = document.getElementById('synthetic-banner');
    if (banner) {
      if (src.synthetic) {
        banner.hidden = false;
        banner.textContent = 'Synthetic data. Every result on this page was invented to test the layout. These are not benchmark results.';
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }
    }
  }

  function buildFilters() {
    var scopeBox = document.getElementById('scope-options');
    var modelBox = document.getElementById('models-options');
    clear(scopeBox);
    clear(modelBox);
    // A scope with no tasks in the data has nothing to show, so it is not offered (the smoke tier has no runs yet).
    SCOPE_ORDER.filter(function (sc) { return taskCount(sc) > 0; }).forEach(function (sc) {
      scopeBox.appendChild(radioOption('scope', sc, SCOPE_LABEL[sc] + ' (' + plural(taskCount(sc), 'task') + ')'));
    });
    var modelCounts = { claude: D.board.models.filter(function (m) { return m.group === 'claude' && (D.cellsByModel.get(m.id) || []).length; }).length };
    modelCounts.all = D.board.models.filter(function (m) { return (D.cellsByModel.get(m.id) || []).length; }).length;
    MODEL_ORDER.forEach(function (mo) {
      modelBox.appendChild(radioOption('models', mo, MODEL_LABEL[mo] + ' (' + modelCounts[mo] + ')'));
    });
    var toggle = document.getElementById('theme-toggle');
    toggle.addEventListener('click', toggleTheme);
    syncFilterUI();
    syncThemeButton();
  }

  function radioOption(group, value, label) {
    var input = h('input', {
      type: 'radio', name: group + '-group', value: value, id: group + '-' + value,
      onchange: function () { setFilter(group, value); }
    });
    return h('label', null, input, h('span', { text: label }));
  }

  function syncFilterUI() {
    var pairs = [['scope', state.scope], ['models', state.models]];
    pairs.forEach(function (p) {
      var inputs = document.querySelectorAll('input[name="' + p[0] + '-group"]');
      Array.prototype.forEach.call(inputs, function (inp) { inp.checked = inp.value === p[1]; });
    });
    var note = document.getElementById('filter-note');
    var rows = rowsFor(state.scope, state.models).length;
    note.textContent = tight('Showing ' + SCOPE_LABEL[state.scope] + ' for ' + MODEL_LABEL[state.models] + ': ' + rows +
      ' model rows with results in this scope.');
  }

  function setFilter(group, value) {
    if (group === 'scope') state.scope = value;
    else state.models = value;
    writeHash();
    renderAll();
  }

  // ── hash state ─────────────────────────────────────────────────────────

  function stateHash() { return '#scope=' + state.scope + '&models=' + state.models; }
  function writeHash() {
    try { history.replaceState(null, '', stateHash()); } catch (_) { /* file URLs may refuse; the view still works */ }
  }
  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    if (raw.indexOf('=') < 0) { state.pendingSection = decodeURIComponent(raw); return; }
    var params = new URLSearchParams(raw);
    var sc = params.get('scope');
    if (sc && SCOPE_ORDER.indexOf(sc) >= 0) state.scope = sc;
    var mo = params.get('models');
    if (mo && MODEL_ORDER.indexOf(mo) >= 0) state.models = mo;
  }

  // ── theme ──────────────────────────────────────────────────────────────

  function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
  function syncThemeButton() {
    var btn = document.getElementById('theme-toggle');
    var cur = currentTheme();
    btn.textContent = cur === 'dark' ? 'Light theme' : 'Dark theme';
    btn.setAttribute('aria-label', 'Switch to ' + (cur === 'dark' ? 'light' : 'dark') + ' theme');
  }
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('th-theme', next); } catch (_) { /* private windows may refuse storage */ }
    syncThemeButton();
  }

  // ── at a glance ────────────────────────────────────────────────────────

  /** The failed iterations of one row, with the output-cap truncations counted and named apart from other reasons. */
  function failedWords(row) {
    // A stopped cell's unrun iterations are not failures and not requested: they are named apart, with the stop's label.
    // The stop label is built in board.ts (row.stopLabel); the page only prints it.
    var stopped = row.stopLabel || '';
    if (!row.failed) return '0 of ' + integer(row.requested) + (stopped ? '; ' + stopped : '');
    var parts = [];
    if (row.truncated) parts.push(integer(row.truncated) + ' truncated at the output cap');
    var other = row.failed - row.truncated;
    if (other > 0) parts.push(integer(other) + ' failed' + (row.failureReason ? ' (' + row.failureReason + ')' : ''));
    return integer(row.failed) + ' of ' + integer(row.requested) + ': ' + parts.join('; ') + (stopped ? '; ' + stopped : '');
  }

  /** The scope callout: the cell size, the ceiling sentence, and the configurations at 100 on every iteration. */
  function calloutBox(guide) {
    if (!guide || !guide.callout || !guide.callout.length) return null;
    return h('div', { class: 'scope-callout', role: 'note' }, guide.callout.map(function (s) { return h('p', { text: s }); }));
  }

  /**
   * The at-a-glance block: the scope callout, at most three computed sentences, then one row per configuration in view.
   * Configurations that cover at least 80% of the scope's tasks come first; the rest sit under a sub-heading.
   */
  function renderGlance() {
    var box = slot('glance');
    clear(box);
    var block = (D.board.glance && D.board.glance[state.scope] && D.board.glance[state.scope][state.models]) || { rows: [], sentences: [], notCovering: null };
    var guide = (D.board.guides && D.board.guides[state.scope] && D.board.guides[state.scope][state.models]) || { callout: [] };
    scopeLine('glance', block.rows.length);
    if (!block.rows.length) {
      emptyNote(box, 'No model has results in this scope for the models chosen.', heatCount);
      return;
    }
    var callout = calloutBox(guide);
    if (callout) box.appendChild(callout);
    // A one-line pointer to the answer box, which sits in the findings below. On a phone the answer is otherwise two screens down.
    if (guide.answer && guide.answer.length) {
      box.appendChild(h('p', { class: 'glance-pointer' }, 'Which model for what: ', h('a', { href: '#answer-title', text: 'the answer for this scope' })));
    }
    if (block.sentences.length) {
      box.appendChild(h('ul', { class: 'glance-sentences', 'aria-label': 'Computed sentences about the table below' },
        block.sentences.map(function (s) { return h('li', { text: s }); })));
    }
    var bodyRows = [];
    var subAdded = false;
    block.rows.forEach(function (row) {
      if (!row.covering && !subAdded && block.notCovering) {
        subAdded = true;
        bodyRows.push(h('tr', { class: 'sub-heading' }, h('th', { scope: 'rowgroup', colspan: 5, text: block.notCovering })));
      }
      bodyRows.push(h('tr', null,
        h('th', { scope: 'row', text: row.name + ' (' + row.tasksCovered + ' of ' + plural(row.tasksTotal, 'task') + ')' }),
        h('td', { class: 'num', 'data-label': 'Score (95% interval)', text: num(row.score, 1) + ' ' + intervalText(row.interval) }),
        h('td', { class: 'num', 'data-label': 'Cost per attempt', text: row.costPerAttempt === null ? 'not measured' : usd(row.costPerAttempt) }),
        h('td', { class: 'num', 'data-label': 'Median seconds per completed iteration', text: hasNum(row.medianSecondsPerIteration) ? oneDp(row.medianSecondsPerIteration) : 'not measured' }),
        h('td', { 'data-label': 'Failed, of requested', text: failedWords(row) })));
    });
    box.appendChild(h('div', { class: 'scroll-x' }, h('table', { class: 'data glance' },
      h('caption', { text: 'Configurations in view, sorted by all-trials score. Interval is the 95% bootstrap interval.' }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Configuration' }),
        h('th', { scope: 'col', class: 'num', text: 'Score (95% interval)' }),
        h('th', { scope: 'col', class: 'num', text: 'Cost per attempt (USD)' }),
        h('th', { scope: 'col', class: 'num', text: 'Median seconds per completed iteration' }),
        h('th', { scope: 'col', text: 'Failed, of requested' }))),
      h('tbody', null, bodyRows))));
  }

  // ── findings ───────────────────────────────────────────────────────────

  /** The findings for the current scope and model group. Each was computed by the data build for that pair. */
  function renderFindings() {
    var box = slot('findings');
    clear(box);
    var byGroup = (D.board.insights && D.board.insights[state.scope]) || {};
    var list = byGroup[state.models] || [];
    var guides = (D.board.guides && D.board.guides[state.scope]) || {};
    var guide = guides[state.models] || { answer: [], caveats: [] };
    var line = document.querySelector('[data-scope-line="findings"]');
    // The callout under the scope line: the cell size, the ceiling, and the configurations at 100 on every iteration.
    var callout = calloutBox(guide);
    if (callout) box.appendChild(callout);
    if (line) {
      line.textContent = tight('Computed by the data build for ' + SCOPE_LABEL[state.scope] + ' over ' + MODEL_LABEL[state.models] +
        ': ' + plural(list.length, 'finding') + '. A finding names only configurations that cover at least 80% of the scope’s tasks.');
    }
    // The answer comes first, then the limits on it, then the findings it is computed from.
    if (guide.answer.length) {
      box.appendChild(h('div', { class: 'answer', 'aria-labelledby': 'answer-title' },
        h('h3', { id: 'answer-title', text: 'Which model for what, in this scope' }),
        h('ul', null, guide.answer.map(function (s) { return h('li', { text: s }); }))));
    }
    if (guide.caveats.length) {
      box.appendChild(h('div', { class: 'caveats' },
        h('h3', { text: 'Read these results with their limits' }),
        h('ul', null, guide.caveats.map(function (s) { return h('li', { text: s }); }))));
    }
    if (!list.length) {
      emptyNote(box, 'No model covers at least 80% of the tasks in this scope, so no finding can name one.', heatCount);
      return;
    }
    box.appendChild(h('h3', { class: 'findings-head', text: 'Findings' }));
    box.appendChild(h('ol', { class: 'findings' },
      list.map(function (ins) {
        return h('li', null,
          h('span', { class: 'fig' },
            h('span', { class: 'fig-value', text: ins.figure }),
            h('span', { class: 'fig-unit', text: ins.figureUnit })),
          h('div', { class: 'body-cell' },
            h('h3', { text: ins.title }),
            h('p', { text: ins.body }),
            h('a', { class: 'see', href: '#' + ins.anchor, text: 'See chart' })));
      })));
    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'What cost per attempt means' }),
      h('p', { class: 'section-foot', text: costDefinition() })));
  }

  // ── score against cost ─────────────────────────────────────────────────

  /** Models left out of the chart because they have no per-token price. */
  function unpricedRows(rows) { return rows.filter(function (r) { return r.m.pricing === 'no-per-token-price'; }); }
  /** Models left out of the chart because their positive price is under review. */
  function reviewRows(rows) { return rows.filter(function (r) { return r.m.pricing === 'price-under-review'; }); }

  function frontierCount(sc, mo) {
    return rowsFor(sc, mo).filter(function (r) { return r.s.costPerAttempt !== null; }).length;
  }

  /** The largest 1, 2 or 5 times a power of ten at or below v. */
  function stepBelow(v) {
    var e = Math.floor(Math.log10(v));
    var ks = [5, 2, 1];
    for (var i = 0; i < ks.length; i++) if (ks[i] * Math.pow(10, e) <= v * (1 + 1e-9)) return ks[i] * Math.pow(10, e);
    return Math.pow(10, e);
  }
  /** The smallest 1, 2 or 5 times a power of ten above v. */
  function stepAbove(v) {
    var e = Math.floor(Math.log10(v));
    var ks = [1, 2, 5, 10];
    for (var i = 0; i < ks.length; i++) if (ks[i] * Math.pow(10, e) > v * (1 + 1e-9)) return ks[i] * Math.pow(10, e);
    return 10 * Math.pow(10, e);
  }

  function usdTick(v) {
    if (!(v > 0)) return '$0';
    if (v >= 1) return '$' + String(v);
    var digits = Math.max(0, -Math.floor(Math.log10(v)));
    return '$' + v.toFixed(digits);
  }

  /** A model is eligible for the frontier with a measured cost and at least 80% of the scope's tasks. */
  function frontierEligible(s) {
    return s.costPerAttempt !== null && s.tasksTotal > 0 && s.tasksCovered >= COVER_SHARE * s.tasksTotal;
  }
  function frontierStatus(r) {
    if (r.s.onFrontier) return 'on the frontier';
    if (frontierEligible(r.s)) return 'eligible, not on the frontier';
    return 'not eligible';
  }

  function renderFrontier() {
    var box = slot('frontier');
    clear(box);
    var rows = rowsFor(state.scope, state.models);
    scopeLine('frontier', rows.length);
    var priced = rows.filter(function (r) { return r.s.costPerAttempt !== null; });
    var unpriced = unpricedRows(rows);
    var review = reviewRows(rows);
    var excludedNote = excludedSentence(unpriced, review);
    if (!priced.length) {
      emptyNote(box, 'No model in view has a measured cost per attempt for these tasks.', frontierCount);
      if (rows.length) box.appendChild(h('p', { class: 'section-foot', text: excludedNote }));
      if (rows.length) box.appendChild(h('details', { class: 'disclose' }, h('summary', { text: 'View as table' }), h('div', { class: 'scroll-x' }, tableFrontier(rows))));
      return;
    }
    var low = priced.filter(function (r) { return !frontierEligible(r.s); });

    // A wide chart is taller, so the names beside the dots have room between the whiskers.
    var W = plotWidth(300), H = layoutW >= NAMES_FIT_WIDTH ? 540 : 430;
    var narrowF = W < 520;
    // The narrow left margin keeps the rotated axis title clear of the widest tick label.
    // On a wide chart the top margin is a band for frontier names that fit nowhere beside their dots, above the 100 line.
    var M = narrowF ? { l: 52, r: 16, t: 14, b: 58 } : { l: 60, r: 44, t: layoutW >= NAMES_FIT_WIDTH ? 64 : 14, b: 58 };
    var plotL = M.l, plotR = W - M.r, plotT = M.t, plotB = H - M.b;

    // Both axes are zoomed to the data: x from the 1, 2 or 5 step at or below the cheapest cost to the step above the
    // dearest; y from the lowest score or interval bound, rounded down to a ten. The y axis then does not start at zero.
    var mn = Math.min.apply(null, priced.map(function (r) { return r.s.costPerAttempt; }));
    var mx = Math.max.apply(null, priced.map(function (r) { return r.s.costPerAttempt; }));
    var lo = stepBelow(mn), hi = stepAbove(mx);
    var xOfLog = logScale(lo, hi, plotL, plotR);
    var lowest = Math.min.apply(null, priced.map(function (r) {
      return r.s.interval ? Math.min(r.s.interval[0], r.s.meanScoreAllTrials) : r.s.meanScoreAllTrials;
    }));
    // The floor is the lowest interval bound less 5 points, rounded down to a ten; a score axis starting above zero says so.
    var yMin = Math.max(0, Math.floor((lowest - 5) / 10) * 10);
    var yOf = linear(yMin, 100, plotB, plotT);
    function xFor(r) { return xOfLog(Math.min(hi, Math.max(lo, r.s.costPerAttempt))); }

    var svg = svgRoot(W, H,
      'Score against cost per attempt for ' + priced.length + ' model configurations',
      'x: cost per attempt in US dollars, log scale. y: all-trials score from ' + yMin + ' to 100. Dots are models. Whiskers are 95% intervals. The stepped line is the frontier. Hollow dots cover fewer than 80% of tasks and are not eligible.',
      'group');

    // Gridlines and the y scale.
    var yStep = (100 - yMin) > 60 ? 20 : 10;
    var yTicks = [];
    for (var yv = yMin; yv <= 100; yv += yStep) yTicks.push(yv);
    // The 100 tick is always drawn: it is the ceiling every score and interval is read against.
    if (yTicks[yTicks.length - 1] !== 100) yTicks.push(100);
    yTicks.forEach(function (v) {
      svg.appendChild(svgNode('line', { class: 'grid', x1: plotL, x2: plotR, y1: yOf(v), y2: yOf(v) }));
      svg.appendChild(svgNode('text', { class: 'tick', x: plotL - 8, y: yOf(v) + 4, 'text-anchor': 'end', text: String(v) }));
    });
    svg.appendChild(svgNode('text', {
      class: 'axis-title', x: 0, y: 0, transform: 'translate(12 ' + ((plotT + plotB) / 2) + ') rotate(-90)',
      'text-anchor': 'middle', text: 'All-trials score (pts, ' + yMin + ' to 100)'
    }));

    // x axis: ticks at 1, 2 and 5 times each decade. Decade labels are kept only when they fit clear of each other.
    svg.appendChild(svgNode('line', { class: 'axis', x1: plotL, x2: plotR, y1: plotB, y2: plotB }));
    var decades = [];
    var e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
    for (var e = e0; e <= e1; e++) {
      [1, 2, 5].forEach(function (mm) {
        var v = mm * Math.pow(10, e);
        if (v < lo * 0.999 || v > hi * 1.001) return;
        var x = xOfLog(v);
        svg.appendChild(svgNode('line', { class: 'axis', x1: x, x2: x, y1: plotB, y2: plotB + (mm === 1 ? 6 : 3) }));
        if (mm !== 1) return;
        var text = usdTick(v);
        var w = text.length * 7.4;
        var anchor = x - plotL < 24 ? 'start' : (plotR - x < 24 ? 'end' : 'middle');
        var left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
        decades.push({ x: x, text: text, anchor: anchor, left: left, right: left + w });
      });
    }
    function labelsFit(list) {
      var last = -Infinity;
      for (var i = 0; i < list.length; i++) {
        if (list[i].left < last + 8) return false;
        last = list[i].right;
      }
      return true;
    }
    var shown = decades;
    if (!labelsFit(shown)) shown = decades.filter(function (d, i) { return i % 2 === 0; });
    if (!labelsFit(shown)) shown = decades.length ? [decades[0], decades[decades.length - 1]].filter(function (d, i, a) { return a.indexOf(d) === i; }) : [];
    shown.forEach(function (d) {
      svg.appendChild(svgNode('text', { class: 'tick', x: d.x, y: plotB + 20, 'text-anchor': d.anchor, text: d.text }));
    });
    svg.appendChild(svgNode('text', {
      class: 'axis-title', x: (plotL + plotR) / 2, y: H - 10, 'text-anchor': 'middle',
      text: 'Cost per attempt (US dollars, log scale)'
    }));

    // Each priced dot has an index. A label may sit beside its own dot, never nearer another dot, and every
    // other dot's box (with a margin) is an obstacle. Lines and whiskers are obstacles for every label.
    priced.forEach(function (r, i) { r.dotIndex = i; });
    var dots = priced.map(function (r) { return { i: r.dotIndex, x: xFor(r), y: yOf(r.s.meanScoreAllTrials) }; });
    var obstacles = [];
    var front = priced.filter(function (r) { return r.s.onFrontier; }).sort(function (a, b) { return xFor(a) - xFor(b); });
    if (front.length > 1) {
      var d = '';
      var prev = null;
      front.forEach(function (r, i) {
        var x = xFor(r), y = yOf(r.s.meanScoreAllTrials);
        if (i === 0) d += 'M' + x + ' ' + y;
        else d += ' H' + x + ' V' + y;
        if (prev) {
          obstacles.push({ kind: 'line', dot: -1, x0: prev.x, x1: x, y0: prev.y - 2, y1: prev.y + 2 });
          obstacles.push({ kind: 'line', dot: -1, x0: x - 2, x1: x + 2, y0: Math.min(prev.y, y), y1: Math.max(prev.y, y) });
        }
        prev = { x: x, y: y };
      });
      svg.appendChild(svgNode('path', { d: d, class: 'frontier-line' }));
    }

    // Whiskers and their caps are obstacles too, so no label is set across an interval.
    priced.forEach(function (r) {
      var x = xFor(r);
      if (r.s.interval) {
        // y grows downward, so the interval's top is the smaller y: the box takes min and max.
        var y0 = yOf(r.s.interval[0]), y1 = yOf(r.s.interval[1]);
        svg.appendChild(svgNode('line', { class: strokeClass(r.m), x1: x, x2: x, y1: y0, y2: y1, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
        svg.appendChild(svgNode('line', { class: strokeClass(r.m), x1: x - 4, x2: x + 4, y1: y0, y2: y0, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
        svg.appendChild(svgNode('line', { class: strokeClass(r.m), x1: x - 4, x2: x + 4, y1: y1, y2: y1, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
        obstacles.push({ kind: 'line', dot: -1, x0: x - 2, x1: x + 2, y0: Math.min(y0, y1) - 2, y1: Math.max(y0, y1) + 2 });
        obstacles.push({ kind: 'line', dot: -1, x0: x - 4, x1: x + 4, y0: y0 - 2, y1: y0 + 2 });
        obstacles.push({ kind: 'line', dot: -1, x0: x - 4, x1: x + 4, y0: y1 - 2, y1: y1 + 2 });
      }
    });

    // Frontier members numbered by cost. A number is listed under the chart with the member's name, at every width.
    var members = priced.filter(function (r) { return r.s.onFrontier; })
      .sort(function (a, b) { return a.s.costPerAttempt - b.s.costPerAttempt; });
    members.forEach(function (r, i) { r.frontierNumber = i + 1; });
    // Below the names-fit width no frontier member is named beside its dot: each is numbered and listed under the chart.
    var narrowFrontier = layoutW < NAMES_FIT_WIDTH;

    // Dots: neutral first, focus models on top. Ineligible models are hollow; frontier models get a ring.
    var ordered = priced.slice().sort(function (a, b) { return (tierOf(a.m) ? 1 : 0) - (tierOf(b.m) ? 1 : 0); });
    var labels = [];
    ordered.forEach(function (r) {
      var x = xFor(r), y = yOf(r.s.meanScoreAllTrials);
      var focus = !!tierOf(r.m);
      var eligible = frontierEligible(r.s);
      var g = svgNode('g', {
        class: 'mark', tabindex: 0, role: 'img',
        'aria-label': labelName(r.m) + ': ' + num(r.s.meanScoreAllTrials, 1) + ' points at ' + usd(r.s.costPerAttempt) + ' per attempt, ' + frontierStatus(r)
      });
      g.setAttribute('data-dot', String(r.dotIndex));
      g.setAttribute('data-base', isBaseModel(r.m) ? '1' : '0');
      g.setAttribute('data-top', atTopValue(r) ? '1' : '0');
      g.appendChild(svgNode('circle', { cx: x, cy: y, r: 10, fill: 'transparent' }));
      g.appendChild(svgNode('circle', { class: 'focus-ring', cx: x, cy: y, r: 10 }));
      if (r.s.onFrontier) g.appendChild(svgNode('circle', { class: 'frontier-ring', cx: x, cy: y, r: 9 }));
      if (eligible) {
        g.appendChild(svgNode('circle', {
          class: 'mark-dot ' + tierClass(r.m), cx: x, cy: y, r: focus ? 5.5 : 4.5, 'fill-opacity': 1
        }));
      } else {
        g.appendChild(svgNode('circle', { class: 'mark-dot hollow ' + (focus ? tierClass(r.m) : 'tier-other'), cx: x, cy: y, r: focus ? 5 : 4 }));
      }
      svg.appendChild(g);
      // A dot's box is an obstacle to every other label, with a 3px margin; its own label skips it (see placeLabels).
      obstacles.push({ kind: 'dot', dot: r.dotIndex, x0: x - 9, x1: x + 9, y0: y - 9, y1: y + 9 });
      // The frontier ring is an obstacle to every label, its own included: a label beside its dot must clear the ring.
      if (r.s.onFrontier) obstacles.push({ kind: 'ring', dot: r.dotIndex, x0: x - 10, x1: x + 10, y0: y - 10, y1: y + 10 });
      bindTip(g, function () { return frontierTip(r); });
      // Named: every frontier member, every base model in view, and every eligible focus model (a variant). Variants go first.
      if (r.s.onFrontier || isBaseModel(r.m) || (focus && eligible) || atTopValue(r)) labels.push(labelFor(r, x, y));
    });
    // With no label queued at all, the top three eligible models by score are named in text colour.
    if (!labels.length) {
      priced.filter(function (r) { return frontierEligible(r.s); })
        .sort(function (a, b) { return b.s.meanScoreAllTrials - a.s.meanScoreAllTrials; }).slice(0, 3)
        .forEach(function (r) { labels.push(labelFor(r, xFor(r), yOf(r.s.meanScoreAllTrials))); });
    }
    // Placed in rank order, so a label that cannot fit is a variant before it is ever a frontier member or a base model.
    labels.sort(function (a, b) { return a.rank - b.rank; });

    // The panel is attached before labels are placed: text widths are only measurable in the document.
    var legend = h('div', { class: 'legend', 'aria-hidden': 'false' });
    var present = {};
    priced.forEach(function (r) { var t = tierOf(r.m); if (t) present[t] = true; });
    TIERS.forEach(function (t) {
      if (present[t]) legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch tier-' + t }), TIER_LABEL[t]));
    });
    if (priced.some(function (r) { return !tierOf(r.m) && frontierEligible(r.s); })) {
      legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch tier-other' }), 'Other model'));
    }
    if (low.length) {
      legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch hollow' }), 'Hollow dot: covers fewer than 80% of tasks, not eligible'));
    }
    if (front.length) {
      legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch ring' }), 'On the frontier'));
    }
    if (front.length > 1) {
      legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch line' }), 'Frontier line'));
    }
    if (priced.some(function (r) { return r.s.interval; })) {
      legend.appendChild(h('span', { class: 'legend-item' }, h('span', { class: 'swatch whisker' }), '95% interval'));
    }

    // Under the chart at narrow widths: every frontier member by name, numbered in the order of its cost.
    var listEl = narrowFrontier && members.length
      ? h('ol', { class: 'frontier-names', 'aria-label': 'Frontier models, numbered by cost per attempt' },
        members.map(function (r) {
          return h('li', { value: r.frontierNumber, text: labelName(r.m) + ': ' + usd(r.s.costPerAttempt) + ' per attempt, ' + num(r.s.meanScoreAllTrials, 1) + ' pts' });
        }))
      : null;
    var notesEl = h('p', { class: 'section-foot' });
    var panel = h('div', { class: 'panel' },
      legend,
      h('div', { class: 'plot-box' }, svg),
      listEl,
      h('p', { class: 'section-foot' },
        'All-trials score counts a failed iteration as zero. The frontier is the stepped line through eligible models (a measured cost and at least 80% of the scope’s tasks) for which no other eligible model is both at most as costly and at least as accurate, and better on one of the two.'),
      h('p', { class: 'section-foot', text: costDefinition() }),
      notesEl);
    box.appendChild(panel);

    var dropped = 0;
    var numberedLabels = [];
    function setNumber(lab) {
      lab.number = String(lab.dot.frontierNumber);
      lab.node.textContent = lab.number;
      lab.node.setAttribute('class', 'lbl num-label');
      lab.numbered = true;
    }
    if (labels.length) {
      labels.forEach(function (lab) {
        lab.node = svgNode('text', { class: 'lbl', text: lab.text, 'data-dot': String(lab.dotIndex) });
        svg.appendChild(lab.node);
      });
      var bounds = { x0: plotL - 4, x1: W - 2, y0: plotT - 4, y1: plotB + 40 };
      var placed = [];
      // The leader lines drawn so far, shared by both passes: no later label's box may cross one.
      var leaders = [];
      var numberOnly = narrowFrontier ? labels.filter(function (lab) { return lab.ring; }) : [];
      var named = narrowFrontier ? labels.filter(function (lab) { return !lab.ring; }) : labels;
      numberOnly.forEach(setNumber);
      var missed = placeLabels(named, obstacles, bounds, placed, dots, true, leaders);
      // A frontier member whose name fits nowhere is numbered beside its dot. It stays in the list under the chart either way.
      missed.forEach(function (lab) {
        if (lab.ring) { setNumber(lab); numberedLabels.push(lab); numberOnly.push(lab); }
        else { lab.node.remove(); dropped += 1; }
      });
      var stillMissed = placeLabels(numberOnly, obstacles, bounds, placed, dots, false, leaders);
      stillMissed.forEach(function (lab) { lab.node.remove(); });
    }

    var notes = [];
    if (low.length) notes.push(low.length + (low.length === 1 ? ' model covers' : ' models cover') + ' fewer than 80% of the scope’s tasks and ' + (low.length === 1 ? 'is' : 'are') + ' drawn hollow. ' + (low.length === 1 ? 'It is' : 'They are') + ' not eligible for the frontier.');
    if (excludedNote) notes.push(excludedNote);
    if (yMin > 0) notes.push('The score axis starts at ' + yMin + ', not zero, so the differences between models are visible.');
    if (narrowFrontier && members.length) notes.push('Frontier models are numbered on the chart and listed by name under it, because this width has no room for names beside the dots.');
    if (!narrowFrontier && numberedLabels.length) notes.push('Numbered dots are frontier models whose names did not fit beside their dots: ' +
      numberedLabels.map(function (lab) { return lab.number + ' ' + labelName(lab.dot.m) + ' (' + usd(lab.dot.s.costPerAttempt) + ', ' + num(lab.dot.s.meanScoreAllTrials, 1) + ' pts)'; }).join('; ') + '.');
    if (dropped) notes.push(dropped + ' ' + (dropped === 1 ? 'label is' : 'labels are') + ' left off to avoid overlap. Hover or focus a dot to read its name.');
    notesEl.textContent = notes.join(' ');

    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'View as table' }),
      h('div', { class: 'scroll-x' }, tableFrontier(rows))));
    rovingMarks(svg, 'g.mark');
  }

  /** The sentence that says which models are not plotted and why. The names are in the table view. */
  function excludedSentence(unpriced, review) {
    var parts = [];
    if (unpriced.length) {
      parts.push(plural(unpriced.length, 'model') + ' ' + (unpriced.length === 1 ? 'has' : 'have') +
        ' no per-token price (free tiers, subscription command-line routes and local models) and ' +
        (unpriced.length === 1 ? 'is' : 'are') + ' not plotted or eligible for the frontier. Their names are in the table view.');
    }
    if (review.length) {
      parts.push(review.map(function (r) { return labelName(r.m) + ' (' + PRICING_LABEL['price-under-review'] + ')'; }).join('; ') +
        ' ' + (review.length === 1 ? 'is' : 'are') + ' not plotted: a positive registry price under one cent per million tokens is under review, so no cost is shown.');
    }
    return parts.join(' ');
  }

  function frontierTip(r) {
    var iter = r.s.interval ? 'Interval (95%): ' + intervalText(r.s.interval) : 'Interval: not measured';
    var eligible = frontierEligible(r.s);
    return {
      title: labelName(r.m),
      lines: [
        'All-trials score: ' + num(r.s.meanScoreAllTrials, 1) + ' pts',
        iter,
        'Cost per attempt: ' + usd(r.s.costPerAttempt) + ' (measured on ' + r.s.pricedCells + ' of ' + r.s.tasksCovered + ' tasks)',
        'Tasks covered: ' + r.s.tasksCovered + ' of ' + r.s.tasksTotal,
        'Frontier: ' + (r.s.onFrontier ? 'yes' : eligible ? 'no' : 'not eligible (' + (r.s.costPerAttempt === null ? 'cost not measured' : 'covers fewer than 80% of tasks') + ')') + '. Route: ' + ROUTE_LABEL[r.m.access]
      ]
    };
  }

  /** True when the box meets an obstacle. A dot's own box does not count against its own label (`own` is that dot's index). */
  function overlapsAny(box, list, own) {
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.kind === 'dot' && o.dot === own) continue;
      if (box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0) return true;
    }
    return false;
  }

  /** Text width in pixels: measured in the document, with an estimate only if the browser reports zero. */
  function labelWidth(node, text) {
    var w = 0;
    try { w = node.getComputedTextLength ? node.getComputedTextLength() : 0; } catch (_) { w = 0; }
    return w > 0 ? w : text.length * 7.4;
  }

  /** A base model is the model itself, not an effort variant of another: its id is its base id. */
  function isBaseModel(m) { return !!m && m.baseModelId === m.id; }
  /**
   * A configuration at the top value (every iteration at 100) that covers at least 80% of the scope's tasks is named like a
   * base model, so no crowded chart drops its name. One that ran fewer tasks is not compared, so it is not singled out.
   */
  function atTopValue(r) { return r.s.meanScoreAllTrials >= 100 - 1e-9 && coversScope(r.s); }

  /**
   * The label for a dot: its full name. Rank orders placement: frontier members first, then base models, then the other
   * eligible models (variants), so a variant is the first to be left off when the chart is crowded.
   */
  function labelFor(r, x, y) {
    var top = atTopValue(r);
    var rank = r.s.onFrontier ? 0 : (isBaseModel(r.m) || top ? 1 : 2);
    return { node: null, px: x, py: y, ring: !!r.s.onFrontier, base: isBaseModel(r.m) || top, rank: rank, text: chartName(r.m), dot: r, dotIndex: r.dotIndex };
  }
  /**
   * The name a chart label is set in: the full name without its leading "Claude", so a base model's name fits in the gap
   * between two whiskers. Every chart label uses this form; tooltips, lists and tables keep the full name.
   */
  function chartName(m) { return labelName(m).replace(/^Claude\s+/, ''); }

  /**
   * Places each label in the first free slot around its dot. A ringed dot is 20px across, so its candidates sit 13px out.
   * Labels are tried in the order given. Returns the labels that fit nowhere.
   */
  function placeLabels(labels, obstacles, bounds, placed, dots, calloutOK, leaders) {
    var fs = 12;
    /**
     * A label's anchor is the point its text is set from (a little above the text's middle). Its own dot must be
     * the nearest dot to that anchor, by at least 2px, so a label never reads as naming a neighbouring dot.
     */
    function ownDotNearest(lab, ax, ay) {
      var own = Infinity, other = Infinity;
      dots.forEach(function (d) {
        var dist = Math.hypot(ax - d.x, ay - d.y);
        if (d.i === lab.dotIndex) own = Math.min(own, dist);
        else other = Math.min(other, dist);
      });
      return own + 2 <= other;
    }
    /** Whether a straight segment meets a box (Liang-Barsky clip, so the test is exact, not sampled). */
    function segmentCrossesBox(x1, y1, x2, y2, b) {
      var t0 = 0, t1 = 1, dx = x2 - x1, dy = y2 - y1;
      var p = [-dx, dx, -dy, dy], q = [x1 - b.x0, b.x1 - x1, y1 - b.y0, b.y1 - y1];
      for (var i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return false; continue; }
        var r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return t0 <= t1;
    }
    function crossesLeader(box) {
      return leaders.some(function (s) { return segmentCrossesBox(s[0], s[1], s[2], s[3], box); });
    }
    /** Whether a leader from a label to its dot would cross a placed label, or a dot or ring that is not its own. */
    function leaderBlocked(x1, y1, x2, y2, own) {
      if (placed.some(function (b) { return segmentCrossesBox(x1, y1, x2, y2, b); })) return true;
      // A dot's hit box is wider than the dot, so the leader is tested against the drawn dot, inset by its 3px margin.
      return obstacles.some(function (o) {
        if (o.kind !== 'dot' && o.kind !== 'ring') return false;
        if (o.dot === own) return false;
        var drawn = { x0: o.x0 + 3, x1: o.x1 - 3, y0: o.y0 + 3, y1: o.y1 - 3 };
        return segmentCrossesBox(x1, y1, x2, y2, drawn);
      });
    }
    function tryPlace(lab, w) {
      var o = lab.ring ? 13 : 9;
      var cands = [
        { x: lab.px + o, y: lab.py + 4, a: 'start' },
        { x: lab.px - o, y: lab.py + 4, a: 'end' },
        { x: lab.px, y: lab.py - o - 1, a: 'middle' },
        { x: lab.px, y: lab.py + o + 11, a: 'middle' },
        { x: lab.px + o, y: lab.py - o + 1, a: 'start' },
        { x: lab.px - o, y: lab.py - o + 1, a: 'end' },
        { x: lab.px + o, y: lab.py + o + 7, a: 'start' },
        { x: lab.px - o, y: lab.py + o + 7, a: 'end' }
      ];
      // On a wide chart a name that fits nowhere close to its dot is tried further out.
      if (layoutW >= NAMES_FIT_WIDTH) {
        [o + 14, o + 28].forEach(function (f) {
          cands.push({ x: lab.px + f, y: lab.py + 4, a: 'start' }, { x: lab.px - f, y: lab.py + 4, a: 'end' },
            { x: lab.px, y: lab.py - f - 1, a: 'middle' }, { x: lab.px, y: lab.py + f + 11, a: 'middle' },
            { x: lab.px + f, y: lab.py - f + 1, a: 'start' }, { x: lab.px - f, y: lab.py - f + 1, a: 'end' },
            { x: lab.px + f, y: lab.py + f + 7, a: 'start' }, { x: lab.px - f, y: lab.py + f + 7, a: 'end' });
        });
      }
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var x0 = c.a === 'start' ? c.x : c.a === 'end' ? c.x - w : c.x - w / 2;
        var box = { x0: x0 - 2, x1: x0 + w + 2, y0: c.y - fs - 1, y1: c.y + 5 };
        if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
        if (overlapsAny(box, placed) || overlapsAny(box, obstacles, lab.dotIndex)) continue;
        if (crossesLeader(box)) continue;
        if (!ownDotNearest(lab, c.x, c.y - 4)) continue;
        // The first eight places are beside the dot. Any further out is not adjacent, so a leader line joins it to the dot.
        var leader = null;
        if (i >= 8) {
          var ax = Math.max(x0, Math.min(lab.px, x0 + w)), ay = Math.max(c.y - fs + 2, Math.min(lab.py, c.y + 3));
          var len = Math.hypot(ax - lab.px, ay - lab.py) || 1;
          var lx = lab.px + (ax - lab.px) * 7 / len, ly = lab.py + (ay - lab.py) * 7 / len;
          if (leaderBlocked(lx, ly, ax, ay, lab.dotIndex)) continue;
          leader = [lx, ly, ax, ay];
        }
        lab.node.setAttribute('x', String(c.x));
        lab.node.setAttribute('y', String(c.y));
        lab.node.setAttribute('text-anchor', c.a);
        if (leader) {
          lab.node.setAttribute('data-leader', '1');
          lab.node.parentNode.insertBefore(svgNode('line', { class: 'leader', x1: leader[0], y1: leader[1], x2: leader[2], y2: leader[3] }), lab.node);
          leaders.push(leader);
        }
        placed.push(box);
        return true;
      }
      return false;
    }
    /** Places a name in the band above the plot, centred over its dot, with a leader line down to the dot. */
    function tryCallout(lab, w) {
      var svgEl = lab.node.parentNode;
      // Frontier names take the band above the plot; a base model's name may also sit in the top rows of the plot, where it is free.
      var ys = lab.ring ? [24, 38, 52] : [24, 38, 52, 66, 80, 94];
      for (var yi = 0; yi < ys.length; yi++) {
        for (var k = 0; k <= 40; k++) {
          var dx = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8;
          var x = lab.px + dx, y = ys[yi];
          var x0 = x - w / 2;
          var box = { x0: x0 - 6, x1: x0 + w + 6, y0: y - fs - 1, y1: y + 5 };
          if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < 2) continue;
          if (overlapsAny(box, placed) || overlapsAny(box, obstacles, lab.dotIndex)) continue;
          if (crossesLeader(box)) continue;
          // The leader line, not nearness, ties this name to its dot: the text sits too far above for nearness to decide.
          var leader = [lab.px, lab.py - 10, Math.max(x0, Math.min(lab.px, x0 + w)), y + 3];
          if (leaderBlocked(leader[0], leader[1], leader[2], leader[3], lab.dotIndex)) continue;
          lab.node.setAttribute('x', String(x));
          lab.node.setAttribute('y', String(y));
          lab.node.setAttribute('text-anchor', 'middle');
          lab.node.setAttribute('data-leader', '1');
          svgEl.insertBefore(svgNode('line', { class: 'leader', x1: leader[0], y1: leader[1], x2: leader[2], y2: leader[3] }), lab.node);
          leaders.push(leader);
          placed.push(box);
          return true;
        }
      }
      return false;
    }
    /**
     * Last resort for a frontier member (its number, below 900 px, or its name) and for a base model or top-value configuration:
     * the first free place in rings of growing distance around the dot, joined to it by a leader line. The distance grows until
     * a place is free, so these labels are drawn rather than dropped. Variants never get this, so they are the ones left off.
     */
    function tryFar(lab, w) {
      var o = lab.ring ? 13 : 9;
      var radii = [o + 14, o + 28, o + 44, o + 62, o + 84, o + 110, o + 140, o + 175, o + 215];
      for (var ri = 0; ri < radii.length; ri++) {
        var r = radii[ri], px = lab.px, py = lab.py;
        // Sixteen directions round the dot. The anchor sits on the ray; a label to the right or left is set from its edge.
        var cands = [];
        for (var di = 0; di < 16; di++) {
          var ang = di * Math.PI / 8, ux = Math.cos(ang), uy = Math.sin(ang);
          cands.push({
            x: px + ux * r,
            y: py + uy * r + (uy > 0.3 ? 11 : uy < -0.3 ? -1 : 4),
            a: ux > 0.3 ? 'start' : ux < -0.3 ? 'end' : 'middle'
          });
        }
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          var x0 = c.a === 'start' ? c.x : c.a === 'end' ? c.x - w : c.x - w / 2;
          var box = { x0: x0 - 2, x1: x0 + w + 2, y0: c.y - fs - 1, y1: c.y + 5 };
          if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
          if (overlapsAny(box, placed) || overlapsAny(box, obstacles, lab.dotIndex)) continue;
          if (crossesLeader(box)) continue;
          var ax = Math.max(x0, Math.min(px, x0 + w)), ay = Math.max(c.y - fs + 2, Math.min(py, c.y + 3));
          var len = Math.hypot(ax - px, ay - py) || 1;
          var lx = px + (ax - px) * 7 / len, ly = py + (ay - py) * 7 / len;
          if (leaderBlocked(lx, ly, ax, ay, lab.dotIndex)) continue;
          lab.node.setAttribute('x', String(c.x));
          lab.node.setAttribute('y', String(c.y));
          lab.node.setAttribute('text-anchor', c.a);
          lab.node.setAttribute('data-leader', '1');
          lab.node.parentNode.insertBefore(svgNode('line', { class: 'leader', x1: lx, y1: ly, x2: ax, y2: ay }), lab.node);
          leaders.push([lx, ly, ax, ay]);
          placed.push(box);
          return true;
        }
      }
      return false;
    }
    var missed = [];
    labels.forEach(function (lab) {
      var w = labelWidth(lab.node, lab.node.textContent);
      var ok = tryPlace(lab, w);
      // On a wide chart a frontier member or base model whose name fits nowhere beside its dot is set in the band above
      // the plot, with a leader line. Variants are never set there, so they are the labels left off first.
      if (!ok && calloutOK && layoutW >= NAMES_FIT_WIDTH && (lab.ring || lab.base)) {
        ok = tryCallout(lab, w);
      }
      if (!ok && (lab.ring || lab.base)) ok = tryFar(lab, w);
      if (!ok) missed.push(lab);
    });
    return missed;
  }

  /** Cost cell for the table: a value, or the reason it is not one. */
  function costCell(r) {
    if (r.m.pricing === 'no-per-token-price') return { main: 'not priced', sub: 'no per-token price', title: 'No per-token price in the registry' };
    if (r.m.pricing === 'price-under-review') return { main: 'price under review', sub: 'not shown', title: 'Positive registry price under review' };
    if (r.s.costPerAttempt === null) return { main: null, sub: null, title: 'not measured' };
    return { main: usd(r.s.costPerAttempt), sub: r.s.pricedCells + ' of ' + r.s.tasksCovered + ' tasks', title: '' };
  }

  function tableFrontier(rows) {
    return h('table', { class: 'data' },
      h('caption', { text: 'Score against cost: one row per model configuration in the current scope, including models that are not plotted. ' + costDefinition() }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', text: 'Effort' }),
        h('th', { scope: 'col', class: 'num', text: 'All-trials score (pts)' }),
        h('th', { scope: 'col', text: '95% interval (pts)' }),
        h('th', { scope: 'col', class: 'num', text: 'Cost per attempt (USD)' }),
        h('th', { scope: 'col', text: 'Pricing' }),
        h('th', { scope: 'col', text: 'Frontier' }))),
      h('tbody', null, rows.map(function (r) {
        var cc = costCell(r);
        return h('tr', null,
          h('th', { scope: 'row', text: labelName(r.m) }),
          h('td', { text: r.m.effort ? effortWord(r.m.effort) : 'none' }),
          h('td', { class: 'num', text: num(r.s.meanScoreAllTrials, 1) }),
          h('td', { text: r.s.interval ? intervalText(r.s.interval) : 'interval not measured' }),
          h('td', { class: 'num', text: cc.main !== null ? cc.main + (cc.sub && r.s.costPerAttempt !== null ? ' (' + cc.sub + ')' : '') : 'not measured' }),
          h('td', { text: PRICING_LABEL[r.m.pricing] }),
          h('td', { text: r.s.onFrontier ? 'yes' : frontierEligible(r.s) ? 'no' : 'not eligible' }));
      })));
  }

  // ── model by task ──────────────────────────────────────────────────────

  function heatCount(sc, mo) { return rowsFor(sc, mo).length; }

  function crossSvg() {
    return svgNode('svg', { class: 'cross', width: 9, height: 9, viewBox: '0 0 9 9', 'aria-hidden': 'true', focusable: 'false' },
      svgNode('line', { x1: 1, y1: 1, x2: 8, y2: 8 }), svgNode('line', { x1: 8, y1: 1, x2: 1, y2: 8 }));
  }
  /** Legend key for the hatched "not run" cells. */
  function hatchKey() {
    return svgNode('svg', { class: 'swatch-svg', width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' },
      svgNode('rect', { width: 14, height: 14, rx: 2, fill: 'url(#hatch)', stroke: 'none' }));
  }

  function renderHeatmap() {
    var box = slot('heatmap');
    clear(box);
    var rows = rowsFor(state.scope, state.models);
    scopeLine('heatmap', rows.length);
    var allTasks = orderedTasks(state.scope);
    var tasks = allTasks.filter(function (t) { return rows.some(function (r) { return cellAt(r.m.id + '|' + t.id); }); });
    var hiddenTasks = allTasks.filter(function (t) { return tasks.indexOf(t) < 0; });
    if (!rows.length || !tasks.length) {
      emptyNote(box, 'No model in view has results for these tasks.', heatCount);
      return;
    }
    // suite groups for the header
    var groups = [];
    tasks.forEach(function (t, i) {
      var last = groups[groups.length - 1];
      if (last && last.suite === t.suite) last.count += 1;
      else groups.push({ suite: t.suite, label: D.suiteLabel.get(t.suite) || t.suite, count: 1, start: i });
    });
    var headRow1 = h('tr', null,
      h('th', { scope: 'col', class: 'model', rowspan: 2, text: 'Model' }),
      h('th', { scope: 'col', class: 'mean', rowspan: 2, text: 'Mean over tasks run (pts)' }),
      groups.map(function (g) { return h('th', { scope: 'colgroup', class: 'suite', colspan: g.count, text: g.label }); }));
    var headRow2 = h('tr', null, tasks.map(function (t) {
      return h('th', { scope: 'col', class: 'task', title: t.title, text: t.title });
    }));
    var body = rows.map(function (r, ri) {
      var cells = tasks.map(function (t, ci) {
        var cell = cellAt(r.m.id + '|' + t.id);
        var dataAttrs = { 'data-r': ri, 'data-c': ci };
        if (!cell) {
          return h('td', Object.assign({ class: 'cell not-run', 'aria-label': labelName(r.m) + ' on ' + t.title + ': not run' }, dataAttrs),
            h('span', { class: 'val', text: 'not run' }));
        }
        var score = cell.scoreAllTrials;
        var allFailed = cell.succeeded === 0;
        var trunc = cell.truncatedIterations || 0;
        var td = h('td', Object.assign({
          class: 'cell ramp-' + rampStep(score),
          'aria-label': labelName(r.m) + ' on ' + t.title + ': ' + oneDp(score) + ' points' + (allFailed ? ', every iteration failed' : '') + (trunc ? ', ' + trunc + ' truncated at the output cap' : '') + (cell.stopLabel ? ', ' + cell.stopLabel : '')
        }, dataAttrs),
          h('span', { class: 'val', text: oneDp(score) }),
          allFailed ? crossSvg() : null,
          trunc ? h('span', { class: 'trunc-badge', 'aria-hidden': 'true', text: 'T' }) : null,
          cell.stopped ? h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }) : null);
        bindTip(td, function () { return heatTip(r.m, t, cell); });
        return td;
      });
      var covered = r.s.tasksCovered + ' of ' + r.s.tasksTotal;
      return h('tr', null,
        h('th', { scope: 'row', class: 'model', text: labelName(r.m) }),
        h('td', { class: 'mean num' },
          h('span', { class: 'val', text: num(r.s.meanScoreAllTrials, 1) }),
          h('span', { class: 'cover' + (coversScope(r.s) ? '' : ' partial'), text: covered + ' tasks' })),
        cells);
    });
    var table = h('table', { class: 'heat', 'aria-label': 'All-trials score by model and task, ' + SCOPE_LABEL[state.scope] + ', ' + MODEL_LABEL[state.models] },
      h('thead', null, headRow1, headRow2),
      h('tbody', null, body));
    var scrollBox = h('div', { class: 'scroll-x heat-scroll' }, table);
    enableGrid(scrollBox);
    var hint = h('p', { class: 'scroll-hint', text: 'Scroll sideways to see all ' + tasks.length + ' tasks.' });
    var panel = h('div', { class: 'panel', style: 'padding:12px' },
      h('div', { class: 'legend' },
        h('span', { class: 'legend-item' }, 'All-trials score (pts):'),
        h('span', { class: 'legend-ramp' }, RAMP_LABELS.map(function (lab, i) {
          return h('span', { class: 'step nw ramp-' + i, text: lab });
        })),
        h('span', { class: 'legend-item' }, hatchKey(), 'not run'),
        h('span', { class: 'legend-item' }, '0 with a cross: every iteration failed'),
        h('span', { class: 'legend-item' }, h('span', { class: 'trunc-badge', 'aria-hidden': 'true', text: 'T' }), 'truncated at the output cap, counted as zero'),
        anyStoppedCell() ? h('span', { class: 'legend-item' }, h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }), 'stopped at a provider spend limit or quota, counted over the iterations that ran') : null),
      tasks.length > 2 ? hint : null,
      hiddenNote(hiddenTasks),
      scrollBox,
      h('p', { class: 'section-foot', text: 'Rows: models covering at least 80% of the tasks in scope come first, then by the mean over the tasks each model ran; the coverage is printed under each mean. Use the arrow keys to move between cells. Each cell gives its exact score and sample size on hover or focus.' }));
    box.appendChild(panel);
    // The hint is for a table that does not fit. Measured once attached: a table that fits says nothing about sideways scrolling.
    if (hint.parentNode && scrollBox.scrollWidth <= scrollBox.clientWidth + 1) hint.remove();
    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'View as table' }),
      h('div', { class: 'scroll-x' }, tableHeatmap(rows, tasks))));
  }

  /** True when some cell stopped before its planned iterations ran. The stop key is shown only then. */
  function anyStoppedCell() {
    return D.board.cells.some(function (c) { return !!c.stopped; });
  }

  function heatTip(m, t, cell) {
    var lines = [
      'All-trials score: ' + oneDp(cell.scoreAllTrials) + ' pts (' + t.title + ')',
      'Completed iterations: ' + cell.succeeded + ' of ' + cell.iterations,
      'Cost: ' + usd(cell.costUsd) + '. Runtime: ' + secs(cell.runtimeMs),
      'Checks: ' + (cell.checks.length
        ? cell.checks.map(function (c) { return c.name + ' ' + Math.round(c.passRate * 100) + '% of ' + c.runs + ' runs'; }).join(', ')
        : 'no named check rows (score ' + oneDp(cell.scoreAllTrials) + ')')
    ];
    if (cell.truncatedIterations) lines.splice(2, 0, 'Truncated at the output cap: ' + cell.truncatedIterations + ' of ' + cell.iterations + ' iterations, counted as zero' +
      (cell.failureReason === 'truncated' ? '' : ' (the failure reason is not recorded for every truncation)'));
    if (cell.failureReason && cell.failureReason !== 'truncated') lines.push('Failure reason: ' + cell.failureReason);
    if (cell.stopSentence) lines.splice(2, 0, cell.stopSentence);
    return { title: labelName(m), lines: lines };
  }

  function tableHeatmap(rows, tasks) {
    return h('table', { class: 'data' },
      h('caption', { text: 'All-trials score (pts) per model and task. Not run means no record.' }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Model' }),
        h('th', { scope: 'col', class: 'num', text: 'Mean over tasks run (pts)' }),
        h('th', { scope: 'col', class: 'num', text: 'Tasks covered' }),
        tasks.map(function (t) { return h('th', { scope: 'col', class: 'num', text: t.title }); }))),
      h('tbody', null, rows.map(function (r) {
        return h('tr', null, h('th', { scope: 'row', text: labelName(r.m) }),
          h('td', { class: 'num', text: num(r.s.meanScoreAllTrials, 1) }),
          h('td', { class: 'num', text: r.s.tasksCovered + ' of ' + r.s.tasksTotal }),
          tasks.map(function (t) {
            var cell = cellAt(r.m.id + '|' + t.id);
            return h('td', { class: 'num', text: cell ? oneDp(cell.scoreAllTrials) : 'not run' });
          }));
      })));
  }

  // ── reasoning effort ───────────────────────────────────────────────────

  /** Sets EFFORT_BASES: the base models with at least two effort levels on the board. The section shows only when there are some. */
  function computeEffortBases() {
    var levels = {};
    D.board.models.forEach(function (m) {
      if (!m.effort) return;
      (levels[m.baseModelId] = levels[m.baseModelId] || {})[m.effort] = true;
    });
    EFFORT_BASES = Object.keys(levels).filter(function (b) { return Object.keys(levels[b]).length >= 2; });
  }
  /** The model rows in view whose base model has two or more effort levels. */
  function effortRows(sc, mo) {
    return rowsFor(sc, mo).filter(function (r) { return r.m.effort && EFFORT_BASES.indexOf(r.m.baseModelId) >= 0; });
  }
  function effortCount(sc, mo) { return effortRows(sc, mo).length; }
  /**
   * The effort comparisons in view, from board.effort[scope][group]. The data build compares each base's levels only
   * over the tasks every one of them ran in the scope, so the page draws them as they are and does no arithmetic here.
   */
  function effortComparisonsIn(sc, mo) {
    return (D.board.effort && D.board.effort[sc] && D.board.effort[sc][mo]) || [];
  }
  /** The line under a base's charts: which tasks its levels were compared on. */
  function comparedSentence(comp) {
    if (!comp.tasks.length) return 'No task was run by every effort level in this scope, so these levels are not compared.';
    var titles = comp.tasks.map(function (id) { var t = D.tasks.get(id); return t ? t.title : id; });
    return 'Compared on the ' + plural(comp.tasks.length, 'task') + ' every effort level ran: ' + titles.join('; ') + '.';
  }

  function renderEffort() {
    var section = document.getElementById('effort');
    var box = slot('effort');
    clear(box);
    if (!EFFORT_BASES.length) { section.hidden = true; return; }
    section.hidden = false;
    var rows = effortRows(state.scope, state.models);
    scopeLine('effort', rows.length);
    var comps = effortComparisonsIn(state.scope, state.models);
    if (!comps.length) {
      emptyNote(box, 'No base model with two or more effort levels has results in this scope.', effortCount);
      return;
    }
    comps.forEach(function (comp) {
      var cols = window.matchMedia && window.matchMedia('(min-width: 901px)').matches ? 3 : 1;
      var panelW = Math.max(270, Math.floor((layoutW - 32 - (cols - 1) * 12) / cols) - 34);
      var grid = h('div', { class: 'effort-grid' });
      var specs = [
        { key: 'score', title: 'All-trials score (pts)', max: 100, get: function (l) { return l.score; }, fmt: function (v) { return oneDp(v); } },
        { key: 'cost', title: 'Cost per attempt (USD)', max: null, get: function (l) { return l.costPerAttempt; }, fmt: usd },
        { key: 'secs', title: 'Median seconds per completed iteration', max: null, get: function (l) { return l.medianSeconds; }, fmt: function (v) { return oneDp(v) + ' s'; } }
      ];
      specs.forEach(function (spec) {
        var vals = comp.levels.map(spec.get).filter(hasNum);
        var top = spec.max !== null ? spec.max : (vals.length ? Math.max.apply(null, vals) * 1.15 : 1);
        if (spec.max === null && !(top > 0)) top = 1;
        grid.appendChild(effortPanel(spec, comp, top, panelW));
      });
      box.appendChild(h('div', { class: 'effort-model' },
        h('h3', { text: comp.name + ' (' + plural(comp.levels.length, 'effort level') + ' in view)' }),
        grid,
        comp.truncationNotes.length || comp.stopNotes.length ? h('div', { class: 'effort-trunc' },
          comp.truncationNotes.length ? h('p', { class: 'section-foot' }, h('span', { class: 'trunc-badge', 'aria-hidden': 'true', text: 'T' }), ' Marks an effort level with truncated iterations, counted as zero.') : null,
          comp.stopNotes.length ? h('p', { class: 'section-foot' }, h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }), ' Marks an effort level with a cell stopped at a provider spend limit or quota; the level is counted over the iterations that ran.') : null,
          comp.truncationNotes.map(function (t) { return h('p', { class: 'section-foot', text: t }); }),
          comp.stopNotes.map(function (t) { return h('p', { class: 'section-foot', text: t }); })) : null,
        h('p', { class: 'section-foot effort-compared', text: comparedSentence(comp) })));
    });
    box.appendChild(h('p', { class: 'section-foot', text: costDefinition() }));
    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'View as table' }),
      h('div', { class: 'scroll-x' }, tableEffort(comps))));
  }

  /** Round axis ticks (1, 2 or 5 times a power of ten) from zero to at least `max`. */
  function niceTicks(max) {
    if (!(max > 0)) return { top: 1, ticks: [0, 0.5, 1], step: 0.5 };
    var raw = max / 3;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10].map(function (m) { return m * p; }).filter(function (s) { return s >= raw; })[0];
    var ticks = [];
    for (var k = 0; k * step < max - 1e-9; k++) ticks.push(Math.round(k * step * 1e9) / 1e9);
    ticks.push(Math.round(ticks.length * step * 1e9) / 1e9);
    return { top: ticks[ticks.length - 1], ticks: ticks, step: step };
  }

  /** One chart for one base model: its levels on the effort axis, each value taken over the tasks the levels share. */
  function effortPanel(spec, comp, top, W) {
    var list = comp.levels;
    var H = 230, M = { l: 52, r: 16, t: 40, b: 40 };
    var plotL = M.l, plotR = W - M.r, plotT = M.t, plotB = H - M.b;
    var allLevels = list.map(function (l) { return l.effort; });
    // The levels sit inside the plot by an inset, so a value label at the first or last level clears the y-axis ticks.
    var inset = 26;
    var xOfLevel = function (e) {
      var i = allLevels.indexOf(e);
      return allLevels.length > 1 ? plotL + inset + i * (plotR - plotL - 2 * inset) / (allLevels.length - 1) : (plotL + plotR) / 2;
    };
    // The axis runs to the last round tick, and each tick is labelled from its own value.
    var axis = niceTicks(top);
    var yOf = linear(0, axis.top, plotB, plotT);
    // Tick labels carry the decimals of the step, so two ticks never print the same value.
    var decimals = axis.step < 1 ? Math.min(4, -Math.floor(Math.log10(axis.step))) : 0;
    var svg = svgRoot(W, H, spec.title + ' by reasoning effort, ' + comp.name,
      'x: effort level, low to max. y: ' + spec.title + ', starting at 0. Each value is over the ' + plural(comp.tasks.length, 'task') + ' every level ran.', 'group');
    axis.ticks.forEach(function (v) {
      svg.appendChild(svgNode('line', { class: 'grid', x1: plotL, x2: plotR, y1: yOf(v), y2: yOf(v) }));
      var text = spec.key === 'cost' ? (v === 0 ? '$0' : '$' + v.toFixed(decimals)) : (spec.key === 'score' ? String(Math.round(v)) : v.toFixed(decimals));
      svg.appendChild(svgNode('text', { class: 'tick', x: plotL - 6, y: yOf(v) + 4, 'text-anchor': 'end', text: text }));
    });
    svg.appendChild(svgNode('line', { class: 'axis', x1: plotL, x2: plotR, y1: plotB, y2: plotB }));
    // The first and last level are set inside the plot, so the longest name at the right edge is never cut off.
    allLevels.forEach(function (e, i) {
      var anchor = i === 0 ? 'start' : (i === allLevels.length - 1 ? 'end' : 'middle');
      svg.appendChild(svgNode('text', { class: 'tick', x: xOfLevel(e), y: plotB + 18, 'text-anchor': anchor, text: effortWord(e) }));
      var lvl = list[i];
      if (lvl && lvl.truncated > 0) {
        svg.appendChild(svgNode('text', { class: 'tick trunc', x: xOfLevel(e), y: plotB + 33, 'text-anchor': anchor, text: lvl.truncated + ' truncated' }));
      }
      if (lvl && lvl.stoppedCells > 0) {
        svg.appendChild(svgNode('text', { class: 'tick trunc', x: xOfLevel(e), y: plotB + (lvl.truncated > 0 ? 48 : 33), 'text-anchor': anchor, text: lvl.stopMark }));
      }
    });
    var first = D.models.get(list[0].modelId);
    // One line through the levels, drawn first so the value labels and dots sit on top.
    var linePts = list.filter(function (l) { return hasNum(spec.get(l)); }).map(function (l) {
      return xOfLevel(l.effort) + ' ' + yOf(spec.get(l));
    });
    if (linePts.length > 1) {
      svg.appendChild(svgNode('polyline', { points: linePts.join(' '), fill: 'none', 'stroke-width': 1.75, class: strokeClass(first) }));
    }
    if (spec.key === 'score') {
      list.forEach(function (l) {
        if (!l.interval || !hasNum(l.score)) return;
        var wx = xOfLevel(l.effort), wy0 = yOf(l.interval[0]), wy1 = yOf(l.interval[1]);
        var wm = D.models.get(l.modelId);
        svg.appendChild(svgNode('line', { class: 'whisker ' + strokeClass(wm), x1: wx, x2: wx, y1: wy1, y2: wy0, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
        svg.appendChild(svgNode('line', { class: 'whisker ' + strokeClass(wm), x1: wx - 4, x2: wx + 4, y1: wy0, y2: wy0, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
        svg.appendChild(svgNode('line', { class: 'whisker ' + strokeClass(wm), x1: wx - 4, x2: wx + 4, y1: wy1, y2: wy1, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
      });
    }
    // Everything a value label must clear: the line between the levels, every whisker and cap, every point and the
    // level's own truncation mark. Each value label placed is added to this list, so no two values overlap.
    var valueAvoid = [];
    var valuePts = list.filter(function (l) { return hasNum(spec.get(l)); }).map(function (l) {
      return { x: xOfLevel(l.effort), y: yOf(spec.get(l)) };
    });
    for (var pi = 0; pi + 1 < valuePts.length; pi++) {
      valueAvoid.push({ seg: true, x1: valuePts[pi].x, y1: valuePts[pi].y, x2: valuePts[pi + 1].x, y2: valuePts[pi + 1].y });
    }
    valuePts.forEach(function (p) { valueAvoid.push({ x0: p.x - 6, x1: p.x + 6, y0: p.y - 6, y1: p.y + 6 }); });
    if (spec.key === 'score') {
      list.forEach(function (l) {
        if (!l.interval || !hasNum(l.score)) return;
        var wx = xOfLevel(l.effort), wy0 = yOf(l.interval[0]), wy1 = yOf(l.interval[1]);
        valueAvoid.push({ seg: true, x1: wx, y1: wy1, x2: wx, y2: wy0 });
        valueAvoid.push({ seg: true, x1: wx - 4, y1: wy0, x2: wx + 4, y2: wy0 });
        valueAvoid.push({ seg: true, x1: wx - 4, y1: wy1, x2: wx + 4, y2: wy1 });
      });
    }
    var valueBounds = { x0: plotL + 1, x1: plotR + 14, y0: plotT - 30, y1: plotB + 2 };
    list.forEach(function (l) {
      var v = spec.get(l);
      if (!hasNum(v)) return;
      var m = D.models.get(l.modelId);
      var x = xOfLevel(l.effort), y = yOf(v);
      var li = list.indexOf(l);
      var g = svgNode('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': labelName(m) + ': ' + spec.fmt(v) });
      g.appendChild(svgNode('circle', { cx: x, cy: y, r: 10, fill: 'transparent' }));
      g.appendChild(svgNode('circle', { class: 'focus-ring', cx: x, cy: y, r: 10 }));
      g.appendChild(svgNode('circle', { class: 'mark-dot ' + tierClass(m), cx: x, cy: y, r: 4.5 }));
      // The value sits in the first spot around its point that no line, whisker, other point or other value crosses.
      var at = valueSpot(spec.fmt(v), x, y, valueAvoid, valueBounds);
      if (at.box) valueAvoid.push(at.box);
      g.appendChild(svgNode('text', { class: 'tick val', x: at.x, y: at.y, 'text-anchor': at.a, text: spec.fmt(v) }));
      // A level whose iterations hit the output cap carries a T beside its point, on every chart, in the first free spot
      // that no line, whisker, point or value crosses. Its box is avoided by the values placed after it.
      if (l.truncated > 0) {
        var tAt = valueSpot('T', x, y, valueAvoid, valueBounds);
        if (tAt.box) valueAvoid.push(tAt.box);
        g.appendChild(svgNode('text', { class: 'trunc-mark', x: tAt.box ? tAt.x : x - 8, y: tAt.box ? tAt.y : y + 4, 'text-anchor': tAt.box ? tAt.a : 'end', text: 'T' }));
      }
      // A level with a cell stopped at the account's spend limit or a quota carries an S, placed like the T.
      if (l.stoppedCells > 0) {
        var sAt = valueSpot('S', x, y, valueAvoid, valueBounds);
        if (sAt.box) valueAvoid.push(sAt.box);
        g.appendChild(svgNode('text', { class: 'trunc-mark stop-mark', x: sAt.box ? sAt.x : x - 8, y: sAt.box ? sAt.y : y + 4, 'text-anchor': sAt.box ? sAt.a : 'end', text: 'S' }));
      }
      svg.appendChild(g);
      bindTip(g, function () {
        var lines = [spec.title + ': ' + spec.fmt(v), 'Tasks compared: ' + comp.tasks.length];
        if (spec.key === 'score' && l.interval) lines.push('95% interval: ' + intervalText(l.interval));
        if (l.truncated > 0) lines.push('T: ' + l.truncated + ' of ' + l.requested + ' requested iterations hit the output cap and count as zero');
        if (l.stopTip) lines.push(l.stopTip);
        if (spec.key === 'cost') lines.push('Cost measured on ' + l.pricedTasks + ' of the ' + comp.tasks.length + ' tasks');
        if (spec.key === 'secs') lines.push('Runtime measured on ' + l.timedTasks + ' of the ' + comp.tasks.length + ' tasks');
        return { title: labelName(m), lines: lines };
      });
    });
    rovingMarks(svg, 'g.mark');
    return h('div', { class: 'panel' }, h('h3', { text: spec.title }), h('div', { class: 'plot-box' }, svg));
  }

  /** Whether a segment crosses a box: sampled every pixel, which is exact enough for segments a few hundred pixels long. */
  function segmentHitsBox(x1, y1, x2, y2, b) {
    var n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (var i = 0; i <= n; i++) {
      var t = i / n, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return true;
    }
    return false;
  }

  /**
   * The spot for a value label: the first of a few spots around its point that no segment, box or placed value crosses,
   * with the anchor the text is set from and the box it takes. The spots start above the point. Returns no box when none is free.
   */
  function valueSpot(text, x, y, avoid, bounds) {
    var w = text.length * 6.6 + 2, hgt = 12;
    var spots = [
      { x: x, y: y - 10, a: 'middle' },
      { x: x + 9, y: y + 4, a: 'start' },
      { x: x - 9, y: y + 4, a: 'end' },
      { x: x, y: y + 20, a: 'middle' },
      { x: x + 9, y: y + 18, a: 'start' },
      { x: x - 9, y: y + 18, a: 'end' },
      { x: x + 9, y: y - 9, a: 'start' },
      { x: x - 9, y: y - 9, a: 'end' }
    ];
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      var x0 = s.a === 'start' ? s.x : s.a === 'end' ? s.x - w : s.x - w / 2;
      var box = { x0: x0 - 2, x1: x0 + w + 2, y0: s.y - hgt + 3, y1: s.y + 4 };
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
      var hit = avoid.some(function (o) {
        if (o.seg) return segmentHitsBox(o.x1, o.y1, o.x2, o.y2, box);
        return box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0;
      });
      if (hit) continue;
      return { x: s.x, y: s.y, a: s.a, box: box };
    }
    return { x: x, y: y - 10, a: 'middle', box: null };
  }

  function tableEffort(comps) {
    var body = [];
    comps.forEach(function (comp) {
      comp.levels.forEach(function (l) {
        var m = D.models.get(l.modelId);
        body.push(h('tr', null,
          h('th', { scope: 'row', text: m ? labelName(m) : l.modelId }),
          h('td', { text: effortWord(l.effort) }),
          h('td', { class: 'num', text: num(l.score, 1) }),
          h('td', { class: 'num', text: intervalText(l.interval) }),
          h('td', { class: 'num', text: usd(l.costPerAttempt) }),
          h('td', { class: 'num', text: hasNum(l.medianSeconds) ? oneDp(l.medianSeconds) : 'not measured' }),
          h('td', { class: 'num', text: l.truncated + ' of ' + plural(l.requested, 'requested iteration') }),
          h('td', { class: 'num', text: plural(comp.tasks.length, 'task') + ' compared' })));
      });
    });
    return h('table', { class: 'data' },
      h('caption', { text: 'Reasoning effort: one row per effort level, compared over the tasks every level of its base model ran in the current scope.' }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', text: 'Effort' }),
        h('th', { scope: 'col', class: 'num', text: 'Score (pts)' }), h('th', { scope: 'col', class: 'num', text: 'Interval (95%)' }),
        h('th', { scope: 'col', class: 'num', text: 'Cost per attempt (USD)' }),
        h('th', { scope: 'col', class: 'num', text: 'Median seconds per completed iteration' }),
        h('th', { scope: 'col', class: 'num', text: 'Truncated at the output cap' }), h('th', { scope: 'col', class: 'num', text: 'Tasks compared' }))),
      h('tbody', null, body));
  }

  // ── reliability ────────────────────────────────────────────────────────

  /**
   * Per-iteration values for one model's cells. Failed iterations are counted, not plotted as scores.
   * `values` is the list of plotted scores; `crosses` counts failed iterations; `unknown` counts completed
   * iterations with no per-iteration score in the record.
   */
  function iterationPoints(cells) {
    var pts = [], crosses = 0, unknown = 0;
    cells.forEach(function (c) {
      var failed = Math.max(0, c.iterations - c.succeeded);
      var scores = c.iterationScores || [];
      if (scores.length === c.iterations && c.iterations > 0) {
        scores.forEach(function (v) {
          if (v === 0 && failed > 0) crosses += 1;
          else pts.push(v);
        });
        return;
      }
      if (scores.length > 0) {
        scores.forEach(function (v) { pts.push(v); });
        crosses += failed;
        unknown += Math.max(0, c.iterations - scores.length - failed);
        return;
      }
      crosses += failed;
      unknown += c.succeeded;
    });
    return { pts: pts, crosses: crosses, unknown: unknown };
  }

  function renderReliability() {
    var box = slot('reliability');
    clear(box);
    var rows = rowsFor(state.scope, state.models);
    scopeLine('reliability', rows.length);
    if (!rows.length) { emptyNote(box, 'No model in view has iterations for these tasks.', heatCount); return; }
    var W = plotWidth(300);
    // On a phone the model name sits above its row, so the plot keeps the full width.
    var narrow = W < 520;
    var rowH = narrow ? 50 : 30, top = 24;
    // The name column is as wide as the longest measured name needs, and never more than 40% of the width.
    var longest = Math.max.apply(null, rows.map(function (r) { return labelName(r.m).length; }));
    var nameW = narrow ? 0 : Math.min(Math.floor(W * 0.4), Math.max(150, Math.ceil(longest * 7.4) + 16));
    var nameMaxPx = narrow ? W - 16 : Math.floor(W * 0.4) - 12;
    var rightW = narrow ? 84 : 150;
    var gutterLeft = narrow ? 8 : nameW;
    // Failed iterations sit in a fixed gutter left of the 0 tick: one cross and a count per row.
    var plotL = gutterLeft + 54, plotR = W - rightW - (narrow ? 14 : 0);
    // The axis title sits 12px below the tick labels: the chart is taller than the rows so the two never meet.
    var H = top + rows.length * rowH + 42;
    var xOf = linear(0, 100, plotL, plotR);
    var svg = svgRoot(W, H, 'Iteration scores for ' + rows.length + ' models',
      'Each row is one model. Each dot is one completed iteration scored 0 to 100. A cross at the left of each row, with a count, is failed iterations. The right column is completed over requested iterations.', 'group');
    [0, 25, 50, 75, 100].forEach(function (v) {
      if (narrow) {
        // Gridlines run only through each row's dot band, so they never cross a name.
        rows.forEach(function (r, i) {
          var y0 = top + i * rowH + 22, y1 = top + i * rowH + 46;
          svg.appendChild(svgNode('line', { class: 'grid', x1: xOf(v), x2: xOf(v), y1: y0, y2: y1 }));
        });
      } else {
        svg.appendChild(svgNode('line', { class: 'grid', x1: xOf(v), x2: xOf(v), y1: top, y2: top + rows.length * rowH }));
      }
      svg.appendChild(svgNode('text', { class: 'tick', x: xOf(v), y: top + rows.length * rowH + 14, 'text-anchor': 'middle', text: String(v) }));
    });
    svg.appendChild(svgNode('text', { class: 'axis-title', x: (plotL + plotR) / 2, y: H - 6, 'text-anchor': 'middle', text: 'Iteration score (pts)' }));
    svg.appendChild(narrow
      ? svgNode('text', { class: 'axis-title', x: W - 8, y: 14, 'text-anchor': 'end', text: 'Completed' })
      : svgNode('text', { class: 'axis-title', x: plotR + rightW / 2, y: 14, 'text-anchor': 'middle', text: 'Completed / requested' }));
    if (!narrow) svg.appendChild(svgNode('text', { class: 'axis-title', x: gutterLeft + 12, y: 14, text: 'Failed' }));
    rows.forEach(function (r, i) {
      var cy = narrow ? top + i * rowH + 34 : top + i * rowH + rowH / 2;
      var p = iterationPoints(r.cells);
      var done = r.cells.reduce(function (s, c) { return s + c.succeeded; }, 0);
      var req = r.cells.reduce(function (s, c) { return s + c.iterations; }, 0);
      var g = svgNode('g', { class: 'rel-row', tabindex: 0, role: 'img', 'aria-label': labelName(r.m) + ': ' + done + ' of ' + req + ' iterations completed, ' + p.pts.length + ' scores plotted, ' + p.crosses + ' failed' });
      g.appendChild(svgNode('rect', { class: 'row-band', x: 0, y: top + i * rowH + 3, width: W, height: rowH - 6, rx: 4 }));
      var nm = labelName(r.m);
      if (!narrow && nm.length * 7.4 > nameMaxPx) nm = nm.slice(0, Math.floor(nameMaxPx / 7.4) - 1) + '…';
      g.appendChild(svgNode('text', { class: 'lbl', x: 8, y: narrow ? cy - 16 : cy + 4, text: nm }));
      // Equal scores stack: up to five dots at one value are offset vertically, and more than five show a count.
      var byValue = {};
      p.pts.forEach(function (v) { (byValue[v] = byValue[v] || []).push(v); });
      Object.keys(byValue).forEach(function (key) {
        var list = byValue[key];
        var x = xOf(Number(key));
        var shown = list.length > 5 ? 5 : list.length;
        for (var k = 0; k < shown; k++) {
          var dy = (k - (shown - 1) / 2) * 5;
          g.appendChild(svgNode('circle', { class: 'mark-dot dot-iter ' + tierClass(r.m), cx: x, cy: cy + dy, r: 3.2, 'fill-opacity': 0.55 }));
        }
        // A stack of more than five is drawn as five dots; its count goes to a tooltip, because a printed count
        // collides with the neighbouring dots on the same row.
        if (list.length > 5) g.appendChild(svgNode('title', { text: list.length + ' iterations scored ' + key + ' points' }));
      });
      if (p.crosses > 0) {
        var cx = gutterLeft + (narrow ? 8 : 30);
        g.appendChild(svgNode('path', { class: 'cross-mark', d: 'M' + (cx - 4) + ' ' + (cy - 4) + ' L' + (cx + 4) + ' ' + (cy + 4) + ' M' + (cx + 4) + ' ' + (cy - 4) + ' L' + (cx - 4) + ' ' + (cy + 4), fill: 'none' }));
        g.appendChild(svgNode('text', { class: 'lbl', x: cx + 8, y: cy + 4, text: String(p.crosses) }));
      }
      if (!p.pts.length && done > 0) {
        // On a phone the note starts at the plot edge, short enough to stay clear of the count at the right.
        var unplotted = narrow
          ? { x: plotL, anchor: 'start', text: done + ' completed, not plotted' }
          : { x: xOf(50), anchor: 'middle', text: done + ' completed, scores not recorded' };
        g.appendChild(svgNode('text', { class: 'tick', x: unplotted.x, y: cy + 4, 'text-anchor': unplotted.anchor, text: unplotted.text }));
      }
      g.appendChild(svgNode('text', { class: 'lbl', x: W - 8, y: cy + 4, 'text-anchor': 'end', text: done + ' / ' + req }));
      svg.appendChild(g);
      bindTip(g, function () {
        var reasons = {};
        r.cells.forEach(function (c) {
          var failed = c.iterations - c.succeeded;
          var cut = Math.min(failed, c.truncatedIterations || 0);
          if (cut > 0) reasons['truncated at the output cap'] = (reasons['truncated at the output cap'] || 0) + cut;
          failed -= cut;
          if (failed > 0) reasons[c.failureReason || 'no reason recorded'] = (reasons[c.failureReason || 'no reason recorded'] || 0) + failed;
        });
        var reasonText = Object.keys(reasons).map(function (k) { return k + ' ' + reasons[k]; }).join(', ');
        var lines = [
          'Completed: ' + done + ' of ' + req + ' iterations (' + (req ? oneDp(((done / req) * 100)) : 'not measured') + '%)',
          'Scores plotted: ' + p.pts.length + '. Failed (cross): ' + p.crosses + (reasonText ? ' (' + reasonText + ')' : '') + '.'
        ];
        if (p.unknown) lines.push(p.unknown + ' completed iterations have no per-iteration score in the record and are not plotted.');
        lines.push('Scores: ' + (p.pts.length ? p.pts.slice().sort(function (a, b) { return a - b; }).join(', ') : 'not measured'));
        return { title: labelName(r.m), lines: lines };
      });
    });
    rovingMarks(svg, 'g.rel-row');
    box.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'legend' },
        h('span', { class: 'legend-item' }, h('span', { class: 'swatch tier-other' }), 'Iteration score'),
        h('span', { class: 'legend-item' }, h('span', { class: 'cross-key', 'aria-hidden': 'true', text: '×' }), 'Failed iterations, counted at the left of each row'),
        tierLegend(rows.map(function (r) { return r.m; }))),
      h('div', { class: 'plot-box' }, svg),
      h('p', { class: 'section-foot', text: 'Iterations with no per-iteration score in the record cannot be plotted. They are counted in the row text and in completed / requested.' })));
    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'View as table' }),
      h('div', { class: 'scroll-x' }, tableReliability(rows))));
  }

  function tableReliability(rows) {
    return h('table', { class: 'data' },
      h('caption', { text: 'Completed and requested iterations per model in the current scope.' }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', class: 'num', text: 'Completed (iterations)' }),
        h('th', { scope: 'col', class: 'num', text: 'Requested (iterations)' }), h('th', { scope: 'col', class: 'num', text: 'Completion (%)' }))),
      h('tbody', null, rows.map(function (r) {
        var done = r.cells.reduce(function (s, c) { return s + c.succeeded; }, 0);
        var req = r.cells.reduce(function (s, c) { return s + c.iterations; }, 0);
        return h('tr', null, h('th', { scope: 'row', text: labelName(r.m) }),
          h('td', { class: 'num', text: done }), h('td', { class: 'num', text: req }),
          h('td', { class: 'num', text: req ? oneDp(((done / req) * 100)) : 'not measured' }));
      })));
  }

  // ── speed ──────────────────────────────────────────────────────────────

  var SPEED_NOTE = 'Output speed is output tokens divided by the time after the first visible token. Output tokens include any reasoning tokens the provider bills, so a model that thinks before it answers shows a higher speed than its visible text alone would give. Command-line agent routes carry no timings.';

  function renderSpeed() {
    var box = slot('speed');
    clear(box);
    var all = rowsFor(state.scope, state.models);
    var rows = all.filter(function (r) {
      return r.m.access !== 'cli' && (hasNum(r.s.medianTtftMs) || hasNum(r.s.medianTokensPerSec));
    });
    var excluded = all.filter(function (r) { return r.m.access === 'cli'; }).length;
    scopeLine('speed', rows.length);
    if (!rows.length) {
      emptyNote(box, 'No model in view has a measured time to first visible token or output speed.', function (sc, mo) {
        return rowsFor(sc, mo).filter(function (r) {
          return r.m.access !== 'cli' && (hasNum(r.s.medianTtftMs) || hasNum(r.s.medianTokensPerSec));
        }).length;
      });
      return;
    }
    var ttftRows = rows.filter(function (r) { return hasNum(r.s.medianTtftMs); })
      .sort(function (a, b) { return a.s.medianTtftMs - b.s.medianTtftMs; });
    var tpsRows = rows.filter(function (r) { return hasNum(r.s.medianTokensPerSec); })
      .sort(function (a, b) { return b.s.medianTokensPerSec - a.s.medianTokensPerSec; });
    var two = h('div', { class: 'two-up' });
    var twoUp = window.matchMedia && window.matchMedia('(min-width: 901px)').matches;
    var panelW = Math.max(300, Math.floor((layoutW - 32 - (twoUp ? 14 : 0)) / (twoUp ? 2 : 1)) - 34);
    two.appendChild(barPanel({
      title: 'Median time to first visible token (seconds)',
      note: 'Measured at the model endpoint (API or local runtime). Lower is better.',
      rows: ttftRows, value: function (r) { return r.s.medianTtftMs / 1000; },
      fmt: function (v) { return v.toFixed(2) + ' s'; }, width: panelW
    }));
    two.appendChild(barPanel({
      title: 'Median output speed (tokens per second)',
      note: 'Output tokens divided by the time after the first visible token; billed reasoning tokens count as output. Higher is faster.',
      rows: tpsRows, value: function (r) { return r.s.medianTokensPerSec; },
      fmt: function (v) { return oneDp(v) + ' tokens/s'; }, width: panelW
    }));
    box.appendChild(two);
    box.appendChild(h('p', { class: 'section-foot', text: SPEED_NOTE + ' Agent command-line routes are left out' + (excluded ? ' (' + excluded + ' in view)' : '') + '. Only models whose records report a decode-rate measurement appear.' }));
    box.appendChild(h('details', { class: 'disclose' },
      h('summary', { text: 'View as table' }),
      h('div', { class: 'scroll-x' }, tableSpeed(rows))));
  }

  function barPanel(spec) {
    var W = spec.width;
    if (!spec.rows.length) {
      return h('div', { class: 'panel' }, h('h3', { text: spec.title }), h('p', { class: 'section-foot', text: 'not measured for these models' }));
    }
    // Below about 520px the name sits on its own line and the bar takes the full width, so the bar is never a sliver.
    // Both columns are sized from the text they hold: the longest model name, and the longest value label
    // (with its coverage). When the wide layout would leave less than 140px for the bars, the names stack
    // above their bars instead, and the coverage moves into the name line.
    var longestName = Math.max.apply(null, spec.rows.map(function (r) { return labelName(r.m).length; }));
    var longestCover = Math.max.apply(null, spec.rows.map(function (r) {
      return (spec.fmt(spec.value(r)) + ' (' + r.s.tasksCovered + ' of ' + r.s.tasksTotal + ')').length;
    }));
    var longestFmt = Math.max.apply(null, spec.rows.map(function (r) { return spec.fmt(spec.value(r)).length; }));
    var wideValW = Math.max(120, Math.ceil(longestCover * 7.6) + 16);
    var wideNameW = Math.min(Math.floor(W * 0.6), Math.max(120, Math.ceil(longestName * 7.6) + 16));
    var narrow = !(W >= 520 && W - wideValW - wideNameW >= 140);
    var rowH = narrow ? 52 : 30;
    // The value carries its coverage (tasks covered of tasks in scope), so one task of four is never read as four.
    var valW = narrow ? Math.max(84, Math.ceil(longestFmt * 7.6) + 16) : wideValW;
    var nameW = narrow ? 0 : wideNameW;
    var H = Math.max(60, spec.rows.length * rowH + 14);
    var plotL = narrow ? 6 : nameW, plotR = W - valW;
    var top = Math.max(1, Math.max.apply(null, spec.rows.map(function (r) { return spec.value(r); })));
    // The longest bar ends 4px short of the value column, and narrow layouts keep room beside it for its value label.
    var x = linear(0, top * (narrow ? 1.3 : 1.0), plotL, plotR - 4);
    var nameMax = narrow ? Math.max(12, Math.floor((W - 12) / 7.6)) : Math.max(12, Math.floor((nameW - 12) / 7.6));
    var svg = svgRoot(W, H, spec.title + ' for ' + spec.rows.length + ' models', spec.note, 'group');
    spec.rows.forEach(function (r, i) {
      var y = 8 + i * rowH;
      var v = spec.value(r);
      var barY = narrow ? y + 18 : y + 3;
      var g = svgNode('g', { class: 'mark', tabindex: 0, role: 'img', 'aria-label': labelName(r.m) + ': ' + spec.fmt(v) });
      g.appendChild(svgNode('rect', { class: 'focus-bg', x: 0, y: y - 2, width: W, height: rowH - 2, rx: 4 }));
      var cover = r.s.tasksCovered + ' of ' + r.s.tasksTotal;
      var nm = labelName(r.m);
      nm = nm.length > nameMax ? nm.slice(0, nameMax - 1) + '…' : nm;
      g.appendChild(svgNode('text', { class: 'lbl', x: 6, y: narrow ? y + 12 : y + 14, text: nm }));
      // On a phone the coverage sits under the bar, so the model name is never cut short to make room for it.
      if (narrow) g.appendChild(svgNode('text', { class: 'tick', x: 6, y: y + 46, text: cover + ' tasks' }));
      g.appendChild(svgNode('rect', { class: 'bar ' + tierClass(r.m), x: plotL, y: barY, width: Math.max(2, x(v) - plotL), height: 14 }));
      g.appendChild(svgNode('text', { class: 'tick', x: narrow ? x(v) + 6 : plotR + 6, y: barY + 11, text: narrow ? spec.fmt(v) : spec.fmt(v) + ' (' + cover + ')' }));
      svg.appendChild(g);
      bindTip(g, function () {
        return { title: labelName(r.m), lines: [spec.fmt(v), 'Route: ' + ROUTE_LABEL[r.m.access], 'Tasks covered: ' + r.s.tasksCovered + ' of ' + r.s.tasksTotal] };
      });
    });
    rovingMarks(svg, 'g.mark');
    return h('div', { class: 'panel' }, h('h3', { text: spec.title }),
      h('p', { class: 'section-foot', style: 'margin-top:0', text: spec.note }),
      h('div', { class: 'legend' }, tierLegend(spec.rows.map(function (r) { return r.m; }))),
      h('div', { class: 'plot-box' }, svg));
  }

  function tableSpeed(rows) {
    return h('table', { class: 'data' },
      h('caption', { text: 'Median time to first visible token and median output speed, API and local routes only.' }),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', text: 'Route' }),
        h('th', { scope: 'col', class: 'num', text: 'Median time to first visible token (s)' }),
        h('th', { scope: 'col', class: 'num', text: 'Median output speed (tokens/s)' }))),
      h('tbody', null, rows.map(function (r) {
        return h('tr', null, h('th', { scope: 'row', text: labelName(r.m) }),
          h('td', { text: ROUTE_LABEL[r.m.access] }),
          h('td', { class: 'num', text: hasNum(r.s.medianTtftMs) ? (r.s.medianTtftMs / 1000).toFixed(2) : 'not measured' }),
          h('td', { class: 'num', text: hasNum(r.s.medianTokensPerSec) ? oneDp(r.s.medianTokensPerSec) : 'not measured' }));
      })));
  }

  // ── what failed (checks matrix) ────────────────────────────────────────

  function checksCount(sc, mo) { return sc === 'smoke' ? 0 : focusRows(mo, sc).length; }

  function renderChecks() {
    var box = slot('checks');
    clear(box);
    if (state.scope === 'smoke') {
      scopeLine('checks', 0);
      emptyNote(box, 'The checks matrix covers headline and horizon tasks only.', checksCount);
      return;
    }
    var rows = focusRows(state.models, state.scope);
    scopeLine('checks', rows.length);
    var allFocus = focusTasks(state.scope);
    var tasks = allFocus.filter(function (t) { return rows.some(function (r) { return cellAt(r.m.id + '|' + t.id); }); });
    var hiddenChecks = allFocus.filter(function (t) { return tasks.indexOf(t) < 0; });
    if (!rows.length || !tasks.length) { emptyNote(box, 'No model in view has results on these tasks.', checksCount); return; }
    var head = h('tr', null, h('th', { scope: 'col', class: 'model', text: 'Check (points)' }),
      rows.map(function (r) { return h('th', { scope: 'col', class: 'task', title: labelName(r.m), text: labelName(r.m) }); }));
    var bodyRows = [];
    tasks.forEach(function (t) {
      bodyRows.push(h('tr', { class: 'suite-row' }, h('th', { scope: 'rowgroup', colspan: rows.length + 1, class: 'model', text: t.title + ' (' + (D.board.categories.filter(function (c) { return c.slug === t.category; })[0] || { label: t.category }).label + ')' })));
      var checkRows = (t.checks || []).map(function (ck) {
        var vals = rows.map(function (r) {
          var cell = cellAt(r.m.id + '|' + t.id);
          if (!cell) return { state: 'notrun' };
          var cc = (cell.checks || []).filter(function (x) { return x.name === ck.name; })[0];
          var stopFields = { stopped: cell.stopped, stopLabel: cell.stopLabel, stopSentence: cell.stopSentence };
          return cc ? Object.assign({ state: 'ok', v: cc.passRate, runs: cc.runs, n: cell.iterations }, stopFields) : Object.assign({ state: 'absent', trunc: cell.truncatedIterations || 0 }, stopFields);
        });
        var present = vals.filter(function (v) { return v.state === 'ok'; });
        var mean = present.length ? present.reduce(function (s, v) { return s + v.v; }, 0) / present.length : null;
        return { ck: ck, vals: vals, mean: mean };
      });
      checkRows.sort(function (a, b) {
        if (a.mean === null) return 1;
        if (b.mean === null) return -1;
        return a.mean - b.mean;
      });
      var passedAll = function (cr) { return cr.vals.every(function (v) { return v.state === 'ok' && v.v === 1; }); };
      var allPassed = checkRows.filter(passedAll);
      checkRows.filter(function (cr) { return !passedAll(cr); }).forEach(function (cr) {
        bodyRows.push(h('tr', null,
          h('th', { scope: 'row', class: 'model', text: cr.ck.name + ' (' + cr.ck.maxPoints + ' pts)' }),
          cr.vals.map(function (v, ci) {
            var dataAttrs = { 'data-r': bodyRows.length, 'data-c': ci + 1 };
            if (v.state === 'notrun') return h('td', Object.assign({ class: 'cell not-run', 'aria-label': 'not run' }, dataAttrs), h('span', { class: 'val', text: 'not run' }));
            if (v.state === 'absent' && v.trunc) return h('td', Object.assign({ class: 'cell not-run trunc-cell', 'aria-label': 'truncated at the output cap, so no check row was recorded' }, dataAttrs), h('span', { class: 'val', text: 'truncated' }));
            if (v.state === 'absent') return h('td', Object.assign({ class: 'cell', 'aria-label': 'no named check row for this cell' + (v.stopLabel ? ', ' + v.stopLabel : '') }, dataAttrs), h('span', { class: 'val', text: '—' }), v.stopped ? h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }) : null);
            var td = h('td', Object.assign({ class: 'cell ramp-' + rampStep(v.v * 100), 'aria-label': cr.ck.name + ' passed in ' + Math.round(v.v * 100) + '% of ' + v.runs + ' runs' + (v.stopLabel ? ', ' + v.stopLabel : '') }, dataAttrs),
              h('span', { class: 'val', text: Math.round(v.v * 100) + '%' }), v.stopped ? h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }) : null);
            bindTip(td, function () {
              var tipLines = ['Passed in ' + Math.round(v.v * 100) + '% of ' + v.runs + ' runs (' + v.n + ' iterations)', 'Points: ' + cr.ck.maxPoints + ' maximum', labelName(rows[ci].m)];
              if (v.stopSentence) tipLines.splice(1, 0, v.stopSentence);
              return { title: cr.ck.name + ' on ' + t.title, lines: tipLines };
            });
            return td;
          })));
      });
      if (allPassed.length) {
        bodyRows.push(h('tr', { class: 'pass-row' }, h('th', { scope: 'row', class: 'model', colspan: rows.length + 1, text: allPassed.length + ' ' + (allPassed.length === 1 ? 'check' : 'checks') + ' passed by every model in view (named in the table view)' })));
      }
    });
    var grid = h('div', { class: 'scroll-x' }, h('table', { class: 'heat checks', 'aria-label': 'Share of iterations passing each check, ' + SCOPE_LABEL[state.scope] + ', ' + MODEL_LABEL[state.models] },
      h('thead', null, head), h('tbody', null, bodyRows)));
    enableGrid(grid);
    box.appendChild(h('div', { class: 'panel', style: 'padding:12px' },
      h('div', { class: 'legend' },
        h('span', { class: 'legend-item' }, 'Share of iterations with a recorded result that passed:'),
        h('span', { class: 'legend-ramp' }, RAMP_LABELS.map(function (lab, i) { return h('span', { class: 'step ramp-' + i, text: lab + '%' }); })),
        h('span', { class: 'legend-item' }, hatchKey(), 'not run'),
        h('span', { class: 'legend-item' }, h('span', { class: 'dash-key', 'aria-hidden': 'true', text: '—' }), 'check not recorded for this model'),
        anyStoppedCell() ? h('span', { class: 'legend-item' }, h('span', { class: 'stop-badge', 'aria-hidden': 'true', text: 'S' }), 'stopped at a provider spend limit or quota, counted over the iterations that ran') : null),
      grid,
      hiddenNote(hiddenChecks),
      h('p', { class: 'section-foot', text: 'Checks are grouped by task and sorted by the mean pass share across models, weakest first. Use the arrow keys to move between cells.' })));
    box.appendChild(h('details', { class: 'disclose' }, h('summary', { text: 'View as table' }), h('div', { class: 'scroll-x' }, tableChecks(rows, tasks))));
  }

  function tableChecks(rows, tasks) {
    var lines = [];
    tasks.forEach(function (t) {
      (t.checks || []).forEach(function (ck) {
        lines.push(h('tr', null,
          h('th', { scope: 'row', text: t.title + ': ' + ck.name }),
          h('td', { class: 'num', text: ck.maxPoints + ' pts' }),
          rows.map(function (r) {
            var cell = cellAt(r.m.id + '|' + t.id);
            var cc = cell ? (cell.checks || []).filter(function (x) { return x.name === ck.name; })[0] : null;
            if (!cell) return h('td', { class: 'num', text: 'not run' });
            return h('td', { class: 'num', text: (cc ? Math.round(cc.passRate * 100) + '%' : 'check not recorded') + (cell.stopped ? ' (S)' : '') });
          })));
      });
    });
    return h('table', { class: 'data' },
      h('caption', { text: 'Share of iterations with a recorded result that passed each check, ' + SCOPE_LABEL[state.scope] + '. A dash means no named check row was recorded.' }),
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Check' }), h('th', { scope: 'col', class: 'num', text: 'Points' }),
        rows.map(function (r) { return h('th', { scope: 'col', class: 'num', text: labelName(r.m) }); }))),
      h('tbody', null, lines));
  }

  // ── gallery ────────────────────────────────────────────────────────────

  /** Why a cell has no capture: out of date, every iteration failed (truncated at the cap or not), or never captured. */
  function noCaptureText(cell, stale) {
    if (stale) return 'capture out of date';
    if (cell.succeeded === 0) return cell.truncatedIterations ? 'no capture: truncated at the output cap' : 'no capture: every iteration failed';
    return 'no capture';
  }

  function renderGallery() {
    var box = slot('gallery');
    clear(box);
    if (state.scope === 'smoke') {
      scopeLine('gallery', 0);
      emptyNote(box, 'The gallery shows headline and horizon tasks only.', checksCount);
      return;
    }
    var rows = focusRows(state.models, state.scope);
    scopeLine('gallery', rows.length);
    var tasks = focusTasks(state.scope).filter(function (t) {
      return rows.some(function (r) { var c = cellAt(r.m.id + '|' + t.id); return !!(c && c.shots && c.shots.length); });
    });
    if (!tasks.length) { emptyNote(box, 'No task in view has a captured artifact.', checksCount); return; }
    tasks.forEach(function (t) {
      var strip = h('div', { class: 'strip', role: 'group', 'aria-label': 'Captured artifacts for ' + t.title });
      rows.forEach(function (r) {
        var cell = cellAt(r.m.id + '|' + t.id);
        if (!cell) {
          strip.appendChild(h('div', { class: 'thumb', 'aria-disabled': 'true' },
            h('div', { class: 'nocap', text: 'not run' }),
            h('span', { class: 'cap-name', text: labelName(r.m) }), h('span', { class: 'cap-score', text: 'not run' })));
          return;
        }
        // A capture taken from an earlier output is not shown: the thumbnail says so instead of showing it.
        var hasShot = !!(cell.shots && cell.shots.length);
        var stale = cell.captureStatus === 'out-of-date';
        var img = hasShot
          ? h('img', { src: rel(cell.shots[0]), alt: '', width: 176, height: 132 })
          : h('div', { class: 'nocap', text: noCaptureText(cell, stale) });
        var btn = h('button', {
          type: 'button', class: 'thumb', disabled: !hasShot, 'data-key': r.m.id + '|' + t.id,
          'aria-label': 'Open ' + labelName(r.m) + ' on ' + t.title + ', score ' + oneDp(cell.scoreAllTrials) + ' points' + (hasShot ? '' : ', ' + noCaptureText(cell, stale))
        }, img,
          h('span', { class: 'cap-name', text: labelName(r.m) }),
          h('span', { class: 'cap-score', text: oneDp(cell.scoreAllTrials) + ' pts' + (hasShot ? '' : ', ' + noCaptureText(cell, stale)) }));
        if (cell.shots && cell.shots.length) btn.addEventListener('click', function () { openArtifact(t, r.m, cell, btn); });
        strip.appendChild(btn);
      });
      box.appendChild(h('div', { class: 'gallery-task' },
        h('h3', { text: t.title + ' (' + ((D.board.categories.filter(function (c) { return c.slug === t.category; })[0] || { label: t.category }).label) + ')' }),
        strip));
    });
  }

  // ── artifact dialog ────────────────────────────────────────────────────

  /**
   * The dialog shows the two captures, the check results and the cost, tokens and time of one cell.
   * Nothing from the artifact runs here: the page holds only the captured images and the stored numbers.
   */
  function openArtifact(task, model, cell, opener) {
    var dlg = document.getElementById('artifact-dialog');
    document.getElementById('artifact-title').textContent = labelName(model) + ' on ' + task.title;
    document.getElementById('artifact-notice').textContent = 'Captures and stored results only. The model’s HTML is not run on this page.';
    fillDialogShots(task, model, cell);
    fillDialogDetails(task, model, cell);
    fillDialogCommand(task, model, cell);
    document.documentElement.classList.add('dialog-open');
    pending = { key: model.id + '|' + task.id, opener: opener };
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  /** One line that says what a capture is: its viewport, its time after load, and whether the showcase pose was applied. */
  function captureText(cap, index) {
    var which = index === 0 ? 'Capture 1' : 'Capture 2';
    var when = hasNum(cap.afterLoadMs) ? oneDp((cap.afterLoadMs / 1000)) + ' s after load' : 'time after load not measured';
    var pose = cap.posed ? 'after the task’s showcase pose' : 'with no showcase pose applied: the state the artifact reached on load';
    return which + ': ' + cap.viewport + ' viewport, ' + when + ', ' + pose + '.';
  }

  function fillDialogShots(task, model, cell) {
    var box = document.getElementById('artifact-shots');
    box.replaceChildren();
    var shots = cell.shots || [];
    var caps = cell.captures || [];
    shots.slice(0, 2).forEach(function (shot, i) {
      var cap = caps[i] || { viewport: i === 0 ? '1024 x 720' : '390 x 844', afterLoadMs: null, posed: false };
      var text = captureText(cap, i);
      box.appendChild(h('figure', { class: 'dlg-shot' },
        h('img', { src: rel(shot), alt: labelName(model) + ' on ' + task.title + '. ' + text, width: i === 0 ? 768 : 250, height: 540 }),
        h('figcaption', { text: text + ' Taken in headless Chromium with the network blocked.' })));
    });
    if (!shots.length) box.appendChild(h('p', { class: 'section-foot', text: 'No captured screenshot for this cell.' }));
  }

  /**
   * The one local command that scores this artifact again in the harness's sandbox and captures it again. It takes
   * the model and task ids from the record, so it runs as printed from the benchmarks directory.
   */
  function fillDialogCommand(task, model, cell) {
    var box = document.getElementById('artifact-command');
    // The public page names no harness command: the harness is not published yet (see renderMethod).
    if (isPublic()) { box.replaceChildren(); return; }
    
  }

  function fillDialogDetails(task, model, cell) {
    var box = document.getElementById('artifact-details');
    box.replaceChildren();
    var checks = cell.checks.length
      ? h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Check' }), h('th', { scope: 'col', class: 'num', text: 'Passed' }), h('th', { scope: 'col', class: 'num', text: 'Mean points' }))),
        h('tbody', null, cell.checks.map(function (c) {
          return h('tr', null, h('th', { scope: 'row', text: c.name + ' (' + c.maxPoints + ' pts)' }),
            h('td', { class: 'num', text: Math.round(c.passRate * 100) + '% of ' + c.runs }),
            h('td', { class: 'num', text: oneDp(c.meanPoints) + ' / ' + c.maxPoints }));
        })))
      : h('p', { class: 'box-note', text: 'No check results recorded for this cell.' });
    var n = cell.iterations + ' ' + (cell.iterations === 1 ? 'iteration' : 'iterations');
    var perAttempt = cell.succeeded === 0 ? 'none: every iteration failed'
      : hasNum(cell.costPerIteration) ? usd(cell.costPerIteration)
      : model.pricing === 'priced' ? 'not measured' : PRICING_LABEL[model.pricing];
    var billed = hasNum(cell.costUsd) ? usd(cell.costUsd) + (cell.usageSource ? ' (' + cell.usageSource + ')' : '')
      : model.pricing === 'priced' ? 'not measured' : PRICING_LABEL[model.pricing];
    box.appendChild(h('div', { class: 'dlg-details' },
      h('div', null, h('h3', { text: 'Check results for this cell' }), h('div', { class: 'scroll-x' }, checks),
        h('p', { class: 'section-foot dlg-foot', text: 'Each pass share is over the iterations in which that check’s row was recorded. Iterations that failed are not counted in it.' })),
      h('div', null,
        h('h3', { text: 'Cost, tokens and time' }),
        h('p', { class: 'section-foot', text: costDefinition() }),
        h('dl', null,
          h('dt', null, 'Iterations completed'), h('dd', null, cell.succeeded + ' of ' + cell.iterations),
          h('dt', null, 'Failure reason'), h('dd', null, cell.failureReason || (cell.succeeded === cell.iterations ? 'none (all completed)' : 'none recorded')),
          h('dt', null, 'All-trials score'), h('dd', null, oneDp(cell.scoreAllTrials) + ' pts'),
          h('dt', null, 'Cost per attempt (this cell)'), h('dd', null, perAttempt),
          h('dt', null, 'Billed cost over ' + n), h('dd', null, billed),
          h('dt', null, 'Tokens in, total over ' + n), h('dd', null, integer(cell.tokensIn)),
          h('dt', null, 'Tokens out, total over ' + n + ' (billed)'), h('dd', null, integer(cell.billedTokensOut)),
          h('dt', null, 'Runtime, mean per completed iteration'), h('dd', null, secs(cell.runtimeMs)),
          h('dt', null, 'Time to first visible token'), h('dd', null, ttftSecs(cell.ttftMs)),
          h('dt', null, 'Output speed'), h('dd', null, tps(cell.tokensPerSec))))));
  }

  // ── full results table ─────────────────────────────────────────────────

  /** Shows a value, or a dash whose title says it was not measured. */
  function valueCell(text, sub, title) {
    if (text === null || text === undefined) {
      return { main: h('span', { class: 'dash', title: 'not measured', 'aria-label': 'not measured', text: '—' }), sub: null };
    }
    return { main: text, sub: sub || null, title: title || null };
  }

  function tableColumns() {
    return [
      { key: 'model', label: 'Model', text: true, val: function (r) { return labelName(r.m); }, cell: function (r) { return { main: labelName(r.m) }; } },
      { key: 'effort', label: 'Effort', text: true, val: function (r) { return r.m.effort || ''; }, cell: function (r) { return { main: r.m.effort || 'none' }; } },
      { key: 'route', label: 'Route', text: true, val: function (r) { return r.m.access; }, cell: function (r) { return { main: ROUTE_LABEL[r.m.access] }; } },
      { key: 'covered', label: 'Tasks covered', val: function (r) { return r.s.tasksCovered; }, cell: function (r) { return { main: r.s.tasksCovered + ' of ' + r.s.tasksTotal }; } },
      { key: 'score', label: 'All-trials score (pts)', val: function (r) { return r.s.meanScoreAllTrials; }, cell: function (r) {
        return { main: num(r.s.meanScoreAllTrials, 1), sub: r.s.interval ? intervalText(r.s.interval) : null, subTitle: r.s.interval ? '95% interval' : 'interval not measured' };
      } },
      { key: 'mean', label: 'Mean when run (pts)', val: function (r) { return r.s.meanScore; }, cell: function (r) { return valueCell(hasNum(r.s.meanScore) ? oneDp(r.s.meanScore) : null); } },
      { key: 'done', label: 'Completed / requested', val: function (r) { return r.s.successRate; }, cell: function (r) {
        var done = r.cells.reduce(function (s, c) { return s + c.succeeded; }, 0);
        var req = r.cells.reduce(function (s, c) { return s + c.iterations; }, 0);
        return { main: done + ' / ' + req, sub: req ? oneDp(((done / req) * 100)) + '%' : null };
      } },
      { key: 'cost', label: 'Cost per attempt (USD)', val: function (r) { return r.s.costPerAttempt; }, cell: function (r) {
        if (r.m.pricing === 'no-per-token-price') return { main: 'not priced', sub: 'no per-token price' };
        if (r.m.pricing === 'price-under-review') return { main: 'price under review', sub: 'not shown' };
        if (r.s.costPerAttempt === null) return valueCell(null);
        return { main: usd(r.s.costPerAttempt), sub: r.s.pricedCells + ' of ' + r.s.tasksCovered + ' tasks' };
      } },
      { key: 'runtime', label: 'Median seconds per completed iteration', val: function (r) { return r.s.medianRuntimeMs; }, cell: function (r) { return valueCell(hasNum(r.s.medianRuntimeMs) ? oneDp((r.s.medianRuntimeMs / 1000)) : null); } },
      { key: 'ttft', label: 'Median time to first visible token (s)', val: function (r) { return r.s.medianTtftMs; }, cell: function (r) { return valueCell(hasNum(r.s.medianTtftMs) ? (r.s.medianTtftMs / 1000).toFixed(2) : null); } },
      { key: 'tps', label: 'Output speed (tokens/s)', val: function (r) { return r.s.medianTokensPerSec; }, cell: function (r) { return valueCell(hasNum(r.s.medianTokensPerSec) ? oneDp(r.s.medianTokensPerSec) : null); } },
      { key: 'outtok', label: 'Output tokens per attempt', val: function (r) { return r.s.outputTokensPerTask; }, cell: function (r) { return valueCell(hasNum(r.s.outputTokensPerTask) ? Math.round(r.s.outputTokensPerTask).toLocaleString('en-US') : null); } }
    ];
  }

  function renderTable() {
    var box = slot('table');
    clear(box);
    var rows = rowsFor(state.scope, state.models);
    scopeLine('table', rows.length);
    if (!rows.length) { emptyNote(box, 'No model in view has a summary for this scope.', heatCount); return; }
    var cols = tableColumns();
    var col = cols.filter(function (c) { return c.key === state.tableKey; })[0] || cols[4];
    var dir = state.tableDir === 'asc' ? 1 : -1;
    var sorted = rows.slice().sort(function (a, b) {
      var va = col.val(a), vb = col.val(b);
      var na = va === null || va === undefined || va === '' || (typeof va === 'number' && !isFinite(va));
      var nb = vb === null || vb === undefined || vb === '' || (typeof vb === 'number' && !isFinite(vb));
      if (na && nb) return a.m.name.localeCompare(b.m.name);
      if (na) return 1;
      if (nb) return -1;
      var c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return c * dir || a.m.name.localeCompare(b.m.name);
    });
    var headers = cols.map(function (c, i) {
      var active = c.key === col.key;
      var th = h('th', { scope: 'col', class: (c.text ? '' : 'num') + (i === 0 ? ' sticky' : ''), 'aria-sort': active ? (state.tableDir === 'asc' ? 'ascending' : 'descending') : null },
        h('button', {
          type: 'button', class: 'sort', text: c.label,
          onclick: function () {
            if (state.tableKey === c.key) state.tableDir = state.tableDir === 'asc' ? 'desc' : 'asc';
            else { state.tableKey = c.key; state.tableDir = c.text ? 'asc' : 'desc'; }
            renderTable();
            var again = box.querySelector('button.sort[data-key="' + c.key + '"]');
            if (again) again.focus({ preventScroll: true });
          },
          'data-key': c.key
        }));
      return th;
    });
    var body = sorted.map(function (r) {
      return h('tr', null, cols.map(function (c, i) {
        var cell = c.cell(r);
        var content = [];
        if (cell.main && typeof cell.main === 'object' && cell.main.nodeType) content.push(cell.main);
        else content.push(h('span', { class: 'main', text: cell.main === undefined ? 'not measured' : String(cell.main) }));
        if (cell.sub) content.push(h('span', { class: 'sub', title: cell.subTitle || null, text: cell.sub }));
        if (i === 0) return h('th', { scope: 'row', class: 'sticky' }, content);
        return h('td', { class: (c.text ? '' : 'num') + (cell.title ? ' has-title' : ''), title: cell.title || null }, content);
      }));
    });
    box.appendChild(h('div', { class: 'scroll-x table-scroll' },
      h('table', { class: 'data full' },
        h('caption', { text: 'Summaries for ' + SCOPE_LABEL[state.scope] + ', ' + MODEL_LABEL[state.models] + '. Select a heading to sort.' }),
        h('thead', null, h('tr', null, headers)),
        h('tbody', null, body))));
    box.appendChild(h('p', { class: 'section-foot', text: costDefinition() + ' A dash means the record did not carry the value (not measured). Intervals are not measured with fewer than six iteration values. Models with no per-token price show “not priced”, and the price under review shows “price under review”: neither has a cost.' }));
  }

  // ── method ─────────────────────────────────────────────────────────────

  function renderMethod() {
    var box = slot('method');
    clear(box);
    var src = D.board.source;
    var cells = D.board.cells;
    var companies = {};
    D.board.models.forEach(function (m) { if ((D.cellsByModel.get(m.id) || []).length && m.company) companies[m.company] = true; });
    var companyList = Object.keys(companies).sort();
    var iterCounts = cells.map(function (c) { return c.iterations; });
    var lowIter = cells.filter(function (c) { return c.iterations <= 3; }).length;
    var scorerVersions = {};
    cells.forEach(function (c) { scorerVersions[c.scorerVersion] = (scorerVersions[c.scorerVersion] || 0) + 1; });
    var failureCounts = {};
    cells.forEach(function (c) {
      var failed = c.iterations - (c.succeeded || 0);
      if (failed > 0) { var k = c.failureReason || 'no reason recorded'; failureCounts[k] = (failureCounts[k] || 0) + failed; }
    });
    var failureText = Object.keys(failureCounts).sort().map(function (k) { return k + ' ' + failureCounts[k]; }).join(', ') || 'none';
    var fallbackCount = src.fallbackCells || 0;
    var fallbackNote = h('li', null, fallbackCount
      ? fallbackCount + (fallbackCount === 1 ? ' cell was' : ' cells were') + ' scored by the structural fallback, because no program could be extracted from the artifact. Its score is a structural check, not a behavioural one.'
      : 'No cell was scored by the structural fallback.');
    var versionText = Object.keys(scorerVersions).sort().map(function (v) { return 'version ' + v + ': ' + scorerVersions[v] + ' cells'; }).join('; ');
    var dates = cells.map(function (c) { return c.createdAt; }).sort();
    var liveTaskIds = {};
    cells.forEach(function (c) { liveTaskIds[c.taskId] = true; });
    var liveTasks = D.board.tasks.filter(function (t) { return liveTaskIds[t.id]; });
    var suites = D.board.suites.map(function (s) {
      return h('li', null, h('strong', { text: s.label + ': ' }), s.note);
    });
    // The held-back task is named once, here (its title and why it is not reported), not in each scope line.
    var heldPara = D.board.heldBack && D.board.heldBack.length
      ? h('p', { text: D.board.heldBack.map(function (t) { return t.sentence; }).join(' ') })
      : null;
    var unpricedModels = D.board.models.filter(function (m) { return m.pricing === 'no-per-token-price' && (D.cellsByModel.get(m.id) || []).length; });
    var reviewModels = D.board.models.filter(function (m) { return m.pricing === 'price-under-review' && (D.cellsByModel.get(m.id) || []).length; });

    box.appendChild(h('div', { class: 'method-grid' },
      h('div', null,
        h('h3', { text: 'Suites' }),
        h('ul', null, suites),
        heldPara,
        h('p', { text: 'Headline numbers (the headline scope, the findings and the frontier) use the classic and horizon suites only.' + (hasSmoke() ? ' The smoke tier is shown in its own scope and is not averaged into them.' : '') }),
        h('h3', { text: 'Definitions' }),
        h('dl', null,
          h('dt', null, 'All-trials score'),
          h('dd', null, 'The mean over tasks of each task’s all-trials score. A cell’s all-trials score is the mean over every requested iteration, with a failed iteration counted as zero. Where the record has no per-iteration scores and some iterations failed, it is the score times completed over requested.'),
          h('dt', null, 'Mean when run'),
          h('dd', null, 'The mean over tasks of each task’s score over its completed iterations, using only the tasks where at least one iteration completed. Failures do not count, so a model with one completed iteration at 100 and failures elsewhere shows 100 here. Like the all-trials score it is a mean over tasks, so it is never below the all-trials score.'),
          h('dt', null, 'Coverage'),
          h('dd', null, 'The tasks a model ran, of the tasks the scope has data for: a task is in a scope when a record of that scope’s scorer version covers it. Models covering at least 80% of those tasks are ranked above the rest in the heat map, and only they are named in findings.'),
          h('dt', null, 'Findings'),
          h('dd', null, 'Computed by the data build for each scope and model group. A finding names only configurations that cover at least 80% of the scope’s tasks. Its sample clause gives the configurations used and the iterations behind its number: requested iterations for a number that counts failed iterations as zero, and completed iterations for speed. A reliability finding gives completed over requested. Its figure and unit are set from the data, not read from the sentence.'),
          h('dt', null, '95% interval'),
          h('dd', null, 'A percentile bootstrap over the model’s cells: 2,000 resamples, each drawing cells with replacement and, within a drawn cell that has per-iteration scores, its iteration values with replacement. A fixed seed makes the same results give the same interval. Not measured with fewer than six iteration values.'),
          h('dt', null, 'Cost per attempt'),
          h('dd', null, costDefinition() + ' Only for a model with a positive per-token price in the registry. The mean of the measured costs over the cells in scope, with the count of cells that carry one beside it. Free tiers, subscription command-line routes and local models have no per-token price, so their cost is not measured whatever usage their records carry. A positive price under one cent per million tokens is under review, so its cost is not shown.'),
          h('dt', null, 'Scopes and scorer versions'),
          h('dd', null, isPublic() ? 'Headline and horizon use only records from the current scorer. The horizon scope is the Horizon tasks alone, a part of the headline scope. Older runs scored differently and are not shown. A scope with no data shows an empty state that names the scopes that have data.' : 'Headline, horizon and smoke use only records scored by scorer version 2 or later. The horizon scope is the Horizon tasks alone, a part of the headline scope. Earlier runs (scorer v1) are shown in their own scope and are not comparable with them: a version 1 record is scored differently, so it is never averaged with a version 2 record. A scope with no data shows an empty state that names the scopes that have data.'),
          h('dt', null, 'Reasoning effort'),
          h('dd', null, 'For each base model with two or more effort levels, the levels are compared only over the tasks that every one of them ran in the current scope; the section says how many tasks that is. Score is the mean all-trials score over those tasks, with its 95% interval. Cost per attempt is the mean over those tasks. Median seconds per completed iteration is the median over those tasks of each cell’s runtime per completed iteration. A change between two levels is established only when their intervals do not overlap.'),
          h('dt', null, 'Output cap'),
          h('dd', null, 'Each call may produce up to ' + tokenCount(D.board.definitions.outputCapTokens) + ' output tokens, reasoning included. The first pass used ' + tokenCount(D.board.definitions.firstPassCapTokens) + '. Every model and task pair that reached ' + tokenCount(D.board.definitions.firstPassCapTokens) + ' was run again under ' + tokenCount(D.board.definitions.outputCapTokens) + ', and the published record is the re-run. An iteration that reaches the cap is truncated: it counts as zero in the all-trials score, and it is billed. A failed iteration is counted as truncated when its record says so, or when a cell with no completed iteration and no recorded reason has exactly the cap in output tokens on every iteration; the page marks those cells T.'),
          anyStopped() ? h('dt', null, 'Stopped runs') : null,
          anyStopped() ? h('dd', null, (D.board.definitions.stoppedRule || '') + ' ' + (D.board.definitions.stoppedCount || '')) : null,
          h('dt', null, 'Captures'),
          h('dd', null, 'Each cell has two images, taken from the stored output in headless Chromium with the network blocked. The browser cannot reach the network: every connection goes to a proxy that is not listening, and WebRTC may send no UDP outside that proxy. A hostile artifact checks this' + (isPublic() ? '' : [].join('')) + ', and a plain browser must fail the same check. The images are a desktop viewport (1024 by 720) and a phone viewport (390 by 844), each taken after the task’s showcase pose where the task has one, so every model is shown in the same state. Each caption gives the viewport and the time after load. The page never runs the HTML itself.'),
          h('dt', null, 'What failed'),
          h('dd', null, 'The share of iterations whose recorded check row passed. A check row carries points out of a maximum, but these shares count rows, not points, so they are not the task score.'),
          h('dt', null, 'Frontier'),
          h('dd', null, 'Among models with a measured cost that cover at least 80% of the scope’s tasks, a model is on the frontier when no other such model is at least as cheap and at least as accurate, and better on one of the two.'),
          h('dt', null, 'Time to first visible token'),
          h('dd', null, 'The time from the request to the first visible token, measured at the model endpoint. Only when the record’s telemetry is a decode-rate measurement. Agent command-line routes report first-output timing, which is not a token time, so they are not shown.'),
          h('dt', null, 'Output speed'),
          h('dd', null, 'Output tokens divided by the time after the first visible token. Output tokens include any reasoning tokens the provider bills, so a model that thinks before it answers shows a higher speed than its visible text alone would give. Only for API and local routes with a decode-rate measurement; command-line routes carry no timings.'),
          h('dt', null, 'Not measured'),
          h('dd', null, 'The record did not carry the value. No value is substituted, and missing values are never shown as zero. A dash in a table is a value that was not measured.'))),
      h('div', null,
        h('h3', { text: 'Counts from the data build' }),
        h('dl', { class: 'counts' },
          h('dt', null, isPublic() ? 'Records used' : 'Records in results.json'), h('dd', null, integer(src.records)),
          h('dt', null, 'Live records used'), h('dd', null, integer(src.liveRecords)),
          h('dt', null, 'Seeded records excluded'), h('dd', null, integer(src.seededExcluded)),
          h('dt', null, 'Model configurations with live runs'), h('dd', null, integer(D.board.models.filter(function (m) { return (D.cellsByModel.get(m.id) || []).length; }).length)),
          h('dt', null, 'Tasks with live runs'), h('dd', null, integer(liveTasks.length) + ' of ' + integer(D.board.tasks.length) + ' registered tasks (' + integer(liveTasks.filter(function (t) { return t.headline; }).length) + ' headline' + (hasSmoke() ? ', ' + integer(liveTasks.filter(function (t) { return !t.headline; }).length) + ' smoke' : '') + ')'),
          h('dt', null, 'Cells (model by task)'), h('dd', null, integer(cells.length)),
          h('dt', null, 'Iterations requested'), h('dd', null, integer(cells.reduce(function (s, c) { return s + c.iterations; }, 0))),
          h('dt', null, 'Iterations not run (stopped cells)'), h('dd', null, integer(src.iterationsNotRun || 0)),
          h('dt', null, 'Run dates'), h('dd', null, nw((dates[0] || 'not measured').slice(0, 10)), ' to ', nw((dates[dates.length - 1] || 'not measured').slice(0, 10))),
          isPublic() ? null : h('dt', null, 'Scorer versions'),
          isPublic() ? null : h('dd', null, versionText || 'not measured'),
          h('dt', null, 'Models without a per-token price'), h('dd', null, unpricedModels.length ? unpricedModels.map(function (m) { return m.name; }).join(', ') : 'none'),
          h('dt', null, 'Models with a price under review'), h('dd', null, reviewModels.length ? reviewModels.map(function (m) { return m.name; }).join(', ') : 'none'),
          h('dt', null, 'Data built at'), h('dd', null, nw(D.board.generatedAt)),
          h('dt', null, 'results.json sha256'), h('dd', { class: 'hash' }, src.resultsSha256)),
        h('h3', { text: 'Limits' }),
        h('ul', null,
          h('li', null, companyList.length === 1
            ? 'One vendor so far (' + companyList[0] + '). These results do not show how other vendors compare.'
            : companyList.length + ' vendors in the data (' + companyList.join(', ') + '). Coverage per vendor is uneven, so vendor comparisons are indicative only.'),
          h('li', null, lowIter + ' of ' + cells.length + ' cells ran 3 or fewer iterations (iterations per cell range from ' + Math.min.apply(null, iterCounts) + ' to ' + Math.max.apply(null, iterCounts) + '). With few iterations an interval has few values to resample: below six values it is not measured.'),
          h('li', null, 'The task types are common (for example tic-tac-toe and a racing game), so a model may have seen similar tasks in training. The harness does not test for this.'),
          h('li', null, 'Failed iterations count as zero in the all-trials score, including provider-side failures such as quota, a hung endpoint or a rate limit. Failure reasons recorded across the cells: ' + failureText + '.'),
          fallbackNote,
          h('li', null, 'The maintainers chose which models and tasks to run. This is not a random sample and not an exhaustive one.'),
          hasSmoke() ? h('li', null, 'Smoke tasks test that a page renders, animates or reacts to one input, so strong models cluster near the maximum.') : null,
          h('li', null, 'Cost is measured only for models with a positive per-token price. ' + plural(unpricedModels.length, 'model') + (unpricedModels.length === 1 ? ' has' : ' have') + ' no per-token price (free tiers, subscription command-line routes and local models) and ' + (unpricedModels.length === 1 ? 'is' : 'are') + ' left out of the cost chart and the frontier. Cost excludes hardware, power and subscriptions.'),
          h('li', null, 'Model-written HTML is never run by this page. The captures run it once, in headless Chromium with the network blocked (see Captures), and a broken artifact can stall that browser; the capture has a time limit for that reason. The cell’s score comes from the deterministic checks, not from the captured image.'),
          h('li', null, 'Output speed is output tokens divided by the time after the first visible token. Output tokens include the reasoning tokens the provider bills, so a model that thinks before it answers shows a higher figure than its visible text alone would give.'),
          h('li', null, 'Command-line agent routes are not timed for speed, so the speed charts omit them.'),
          h('li', null, 'Costs shown are the billed costs of the published runs. First-pass runs that were replaced by a re-run also cost money, and they are not included.'),
          h('li', null, 'Each scope states its iterations per cell and its interval width in the limits above its findings. A difference inside the 95% intervals is not established, and a task that scores 100 for every configuration cannot separate them.'))))
    );

    
    // The public page does not carry the reproduce commands: the harness is not published yet. It says so once, here.
    if (isPublic()) {
      box.appendChild(h('p', { class: 'section-foot', text: 'The harness that produced these results is not yet published; the method above describes how each number is computed.' }));
    } else {
      
    }
  }

  // ── orchestration ──────────────────────────────────────────────────────

  /** The section under the reading line, so a filter change keeps the reader in the same place. */
  function readingSection() {
    var bar = document.querySelector('.filter-bar');
    var barBottom = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    var y = Math.min(window.innerHeight - 1, barBottom + 60);
    var el = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(y));
    var sec = el && el.closest ? el.closest('#main > section.section') : null;
    if (sec && !sec.hidden) return sec;
    var sections = document.querySelectorAll('#main > section.section');
    var found = null;
    Array.prototype.forEach.call(sections, function (s) {
      if (!s.hidden && s.getBoundingClientRect().top <= y) found = s;
    });
    return found;
  }

  var renderedOnce = false;
  function renderAll() {
    if (!B || !D) return;
    // Keep the section under the reading line in place: its top is measured before the render and restored after it.
    // Not on the first render, nor when the page is at its top: the header is still growing then, and restoring the
    // reading line would push the title out of view.
    var keepReading = renderedOnce && window.scrollY > 0;
    renderedOnce = true;
    var anchorSection = keepReading ? readingSection() : null;
    var anchorBefore = anchorSection ? anchorSection.getBoundingClientRect().top : null;
    readLayoutWidth();
    syncFilterUI();
    renderHeader();
    renderGlance();
    renderFindings();
    renderFrontier();
    renderHeatmap();
    renderEffort();
    renderReliability();
    renderSpeed();
    renderChecks();
    renderGallery();
    renderTable();
    hideTip();
    if (anchorSection && anchorSection.isConnected && anchorBefore !== null) {
      var after = anchorSection.getBoundingClientRect().top;
      if (Math.abs(after - anchorBefore) >= 1) window.scrollBy(0, after - anchorBefore);
    }
  }

  function fail(message) {
    var lede = document.getElementById('scope-sentence');
    if (lede) lede.textContent = message;
    var main = document.getElementById('main');
    if (main) main.appendChild(h('div', { class: 'notice-empty', role: 'alert', text: message }));
  }

  /**
   * Page text that depends on the board: the build date in the footer, and the sentences about spend-limit stops, which
   * the page keeps only when a cell stopped (or a record stopped before any iteration ran).
   */
  function applyPageText() {
    var built = document.querySelector('[data-built-on]');
    if (built && B.generatedAt) built.textContent = String(B.generatedAt).slice(0, 10);
    if (!anyStopped()) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-stops]'), function (el) { el.parentNode.removeChild(el); });
    }
    if (!hasSmoke()) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-smoke]'), function (el) { el.parentNode.removeChild(el); });
    }
  }

  function init() {
    if (!B || !Array.isArray(B.models) || !Array.isArray(B.cells)) {
      // The private build may say how to rebuild it; the public page only asks the reader to reload.
      var rebuild = document.documentElement.getAttribute('data-target') === 'private' ? [].join('') : '';
      fail('The report data did not load. Reload the page.' + rebuild);
      return;
    }
    D = prepare(B);
    applyPageText();
    computeEffortBases();
    fillCostDefinitions();
    state.models = defaultModels();
    readHash();
    // A scope with no tasks is not offered, so a link to one falls back to the headline scope.
    if (!taskCount(state.scope)) state.scope = 'headline';
    buildFilters();
    renderMethod();
    renderAll();
    writeHash();
    if (state.pendingSection) {
      var target = document.getElementById(state.pendingSection);
      if (target) target.scrollIntoView({ block: 'start' });
    }
    window.addEventListener('hashchange', function () {
      readHash();
      renderAll();
    });
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      var target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      var heading = target.matches('section') ? target.querySelector('h2') : null;
      if (heading && heading.hasAttribute('tabindex')) heading.focus({ preventScroll: true });
      writeHash();
    });
    var dlg = document.getElementById('artifact-dialog');
    document.getElementById('artifact-close').addEventListener('click', function () { dlg.close(); });
    // Clicking the backdrop closes the dialog. A click on its content has the content as its target.
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTip(); });
    var resizeDeferred = false;
    dlg.addEventListener('close', function () {
      document.documentElement.classList.remove('dialog-open');
      var key = pending ? pending.key : null;
      var opener = pending ? pending.opener : null;
      pending = null;
      // A deferred re-render rebuilds the gallery and detaches the opener, so focus is put back after it.
      if (resizeDeferred) { resizeDeferred = false; renderAll(); }
      var thumbs = document.querySelectorAll('#gallery button.thumb');
      var again = null;
      for (var i = 0; key && i < thumbs.length; i++) { if (thumbs[i].getAttribute('data-key') === key) again = thumbs[i]; }
      if (again && !again.disabled) again.focus();
      else if (opener && opener.isConnected) opener.focus();
    });
    var main = document.getElementById('main');
    var lastWidth = main.clientWidth;
    var scheduled = false;
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (main.clientWidth === lastWidth || scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(function () {
          scheduled = false;
          var w = main.clientWidth;
          if (Math.abs(w - lastWidth) < 8) return;
          // Re-rendering rebuilds the gallery, which would detach the opener of an open dialog and lose its focus return.
          if (dlg.open) { resizeDeferred = true; return; }
          lastWidth = w;
          renderAll();
        });
      }).observe(main);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
