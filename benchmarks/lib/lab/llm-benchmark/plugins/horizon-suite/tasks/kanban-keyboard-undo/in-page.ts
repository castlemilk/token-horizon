/**
 * In-page source strings for the kanban checks. Each is a plain-JavaScript arrow
 * function written as a string, run through probe(page, SOURCE, arg), so nothing
 * here is compiled by tsx and no helper is captured (postmortem 0008). No template
 * placeholders are evaluated at run time; ACT_AND_READ is assembled once at load time
 * from the other sources by plain text replacement.
 */
import { VISIBLE } from '../../lib/sources'

/**
 * Read the whole board: titles per column in DOM order, counts (trimmed), boxes, per-card
 * vertical containment, history buttons, status, focus. A card is vertically contained when it
 * lies inside its column, or inside the scroll content of a scroll container between the card
 * and the column (the column included) whose scrollHeight exceeds its clientHeight.
 */
export const READ_BOARD = `(arg) => {
  var cols = ['todo', 'doing', 'done'];
  var out = { titles: {}, counts: {}, cardBoxes: {}, colBoxes: {}, vContained: {}, undoDisabled: null, redoDisabled: null, status: null, statusChildren: null, active: null };
  function boxOf(el) { var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }
  function vContained(li, sec) {
    var b = li.getBoundingClientRect();
    var col = sec.getBoundingClientRect();
    if (b.top >= col.top - 1 && b.bottom <= col.bottom + 1) return true;
    for (var n = li.parentElement; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        var nb = n.getBoundingClientRect();
        var top = b.top - (nb.top + n.clientTop) + n.scrollTop;
        var bottom = b.bottom - (nb.top + n.clientTop) + n.scrollTop;
        if (top >= -1 && bottom <= n.scrollHeight + 1) return true;
      }
      if (n === sec) break;
    }
    return false;
  }
  cols.forEach(function (c) {
    var sec = document.querySelector('[data-column="' + c + '"]');
    if (!sec) { out.titles[c] = null; out.counts[c] = null; out.cardBoxes[c] = []; out.colBoxes[c] = null; out.vContained[c] = []; return; }
    var cards = Array.prototype.slice.call(sec.querySelectorAll('[data-list] > [data-card]'));
    out.titles[c] = cards.map(function (li) { var t = li.querySelector('[data-card-title]'); return t ? t.textContent : null; });
    out.cardBoxes[c] = cards.map(boxOf);
    out.colBoxes[c] = boxOf(sec);
    out.vContained[c] = cards.map(function (li) { return vContained(li, sec); });
    var cnt = sec.querySelector('[data-count]');
    out.counts[c] = cnt ? cnt.textContent.trim() : null;
  });
  var u = document.getElementById('undo');
  var r = document.getElementById('redo');
  out.undoDisabled = u ? u.disabled : null;
  out.redoDisabled = r ? r.disabled : null;
  var st = document.getElementById('status');
  out.status = st ? st.textContent : null;
  out.statusChildren = st ? st.children.length : null;
  var a = document.activeElement;
  if (!a || a === document.body) {
    out.active = { kind: 'body' };
  } else if (a.matches && a.matches('[data-card]')) {
    var t2 = a.querySelector('[data-card-title]');
    out.active = { kind: 'card', title: t2 ? t2.textContent : null };
  } else {
    out.active = { kind: 'id', id: a.id || '', tag: a.tagName };
  }
  return out;
}`;

/** Focus the single card whose title is exactly arg. Returns { ok, n }. */
export const FOCUS_CARD = `(title) => {
  var hits = Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
    var t = li.querySelector('[data-card-title]');
    return t !== null && t.textContent === title;
  });
  if (hits.length !== 1) return { ok: false, n: hits.length };
  hits[0].focus();
  return { ok: document.activeElement === hits[0], n: 1 };
}`;

/** Focus the first card of column arg (by DOM position, so repeated titles are fine). Returns { ok }. */
export const FOCUS_FIRST = `(col) => {
  var li = document.querySelector('[data-column="' + col + '"] [data-list] > [data-card]');
  if (!li) return { ok: false };
  li.focus();
  return { ok: document.activeElement === li };
}`;

/** Focus an element by id. Returns { ok }. */
export const FOCUS_ID = `(id) => {
  var el = document.getElementById(id);
  if (!el) return { ok: false };
  el.focus();
  return { ok: document.activeElement === el };
}`;

/** Blur whatever has focus so the document body holds it. */
export const BLUR = `() => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return { ok: document.activeElement === document.body || document.activeElement === null };
}`;

/**
 * Set the value of #new-title and dispatch input and change events, as a user's typing
 * would, so a form that keeps its draft from input events sees the value. Returns { ok }.
 */
export const SET_INPUT = `(value) => {
  var input = document.getElementById('new-title');
  if (!input) return { ok: false };
  input.value = value;
  var ok = input.value === value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: ok };
}`;

/** Describe the add-error element and the input's wiring, for the add-validation check. */
export const ADD_WIRING = `() => {
  var input = document.getElementById('new-title');
  var err = document.getElementById('add-error');
  if (!input || !err) return { ok: false };
  var ids = (input.getAttribute('aria-describedby') || '').split(/\\s+/);
  return {
    ok: true,
    describedBy: ids.indexOf('add-error') >= 0,
    invalid: input.getAttribute('aria-invalid'),
    errorText: err.textContent,
    value: input.value,
    isActive: document.activeElement === input
  };
}`;

/**
 * Focus a robust-session target: body, the pick-th enabled button, or the pick-th card.
 * Returns { ok, kind }. Falls back to the body when the chosen kind has no element.
 */
export const KEY_TARGET = `(arg) => {
  if (arg.target === 'button') {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) { return !b.disabled; });
    if (buttons.length > 0) {
      buttons[Math.min(buttons.length - 1, Math.floor(arg.pick * buttons.length))].focus();
      return { ok: true, kind: 'button' };
    }
  }
  if (arg.target === 'card') {
    var cards = document.querySelectorAll('[data-card]');
    if (cards.length > 0) {
      cards[Math.min(cards.length - 1, Math.floor(arg.pick * cards.length))].focus();
      return { ok: true, kind: 'card' };
    }
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return { ok: true, kind: 'body' };
}`;

/**
 * In-page click on the delete button of the card titled arg, read in the same turn: the
 * expected focus is computed before the click (next card, else previous, else #new-title),
 * and the column's titles before and after are returned so the caller can check that the
 * card, and only that card, was removed.
 */
export const DELETE_CLICK_FOCUS = `(title) => {
  var hits = Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
    var t = li.querySelector('[data-card-title]');
    return t !== null && t.textContent === title;
  });
  if (hits.length !== 1) return { error: 'card ' + hits.length };
  var li = hits[0];
  var sec = li.closest('[data-column]');
  function titlesOfSec() {
    return Array.prototype.slice.call(sec.querySelectorAll('[data-list] > [data-card]')).map(function (c) {
      var t = c.querySelector('[data-card-title]');
      return t ? t.textContent : null;
    });
  }
  var colBefore = titlesOfSec();
  var kids = Array.prototype.slice.call(li.parentElement.children);
  var i = kids.indexOf(li);
  var nxt = kids[i + 1] || kids[i - 1] || null;
  var expectTitle = null;
  if (nxt) { var nt = nxt.querySelector('[data-card-title]'); expectTitle = nt ? nt.textContent : null; }
  var btn = li.querySelector('button[data-action="delete"]');
  if (!btn) return { error: 'no delete button' };
  btn.click();
  var a = document.activeElement;
  var activeTitle = null;
  if (a && a.matches && a.matches('[data-card]')) {
    var at = a.querySelector('[data-card-title]');
    activeTitle = at ? at.textContent : null;
  }
  return {
    expectInput: nxt === null,
    expectTitle: expectTitle,
    activeKind: a === document.body ? 'body' : (a && a.matches && a.matches('[data-card]') ? 'card' : 'id'),
    activeTitle: activeTitle,
    activeId: a ? a.id || '' : '',
    colBefore: colBefore,
    colAfter: titlesOfSec()
  };
}`;

/**
 * The status element's safety facts for the safe-rendering check: how many img, b, i or
 * script descendants it holds, and its text. A title written as text may sit in any
 * plain element (strong, span); markup built from the title may not.
 */
export const STATUS_SAFE = `() => {
  var st = document.getElementById('status');
  if (!st) return { found: false, bad: 0, text: '' };
  return { found: true, bad: st.querySelectorAll('img, b, i, script').length, text: st.textContent || '' };
}`;

/** Facts for the structure check: landmarks, lang, card tab stops. */
export const STRUCTURE_FACTS = `() => {
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-card]'));
  return {
    h1: document.querySelectorAll('h1').length,
    main: document.querySelectorAll('main').length,
    lang: document.documentElement.getAttribute('lang'),
    cardCount: cards.length,
    cardTabindex: cards.map(function (li) { return li.getAttribute('tabindex'); })
  };
}`;

/** Describe the card titled arg for the safe-rendering check. */
export const HOSTILE_INFO = `(title) => {
  var hits = Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
    var t = li.querySelector('[data-card-title]');
    return t !== null && t.textContent === title;
  });
  if (hits.length !== 1) return { found: hits.length };
  var li = hits[0];
  var t = li.querySelector('[data-card-title]');
  return {
    found: 1,
    titleElementChildren: t.children.length,
    badElements: li.querySelectorAll('img, b, i, script').length,
    buttons: li.querySelectorAll('button').length
  };
}`;

/** Column and card containment for the long-title check: [data-card-title] inside card inside column. */
export const LONG_TITLE_GEOMETRY = `(title) => {
  var hits = Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
    var t = li.querySelector('[data-card-title]');
    return t !== null && t.textContent === title;
  });
  if (hits.length !== 1) return { found: hits.length };
  var li = hits[0];
  var sec = li.closest('[data-column]');
  var t = li.querySelector('[data-card-title]');
  var rt = t.getBoundingClientRect(), rl = li.getBoundingClientRect(), rs = sec.getBoundingClientRect();
  return {
    found: 1,
    titleRight: rt.right,
    cardRight: rl.right,
    cardLeft: rl.left,
    colRight: rs.right,
    colLeft: rs.left,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  };
}`;

/** Count stored localStorage keys, or report that storage is unavailable. */
export const STORAGE_KEYS = `() => {
  try {
    var n = window.localStorage.length;
    return { ok: true, n: n };
  } catch (e) {
    return { ok: false, n: 0, why: e.name };
  }
}`;

/** Overwrite every existing localStorage key with arg. Returns { ok, n }. */
export const OVERWRITE_STORAGE = `(value) => {
  try {
    var keys = [];
    for (var i = 0; i < window.localStorage.length; i++) keys.push(window.localStorage.key(i));
    keys.forEach(function (k) { window.localStorage.setItem(k, value); });
    return { ok: true, n: keys.length };
  } catch (e) {
    return { ok: false, n: 0, why: e.name };
  }
}`;

/** Number of duplicated non-empty ids in the document. */
export const DUPLICATE_IDS = `() => {
  var seen = {};
  var dups = 0;
  Array.prototype.slice.call(document.querySelectorAll('[id]')).forEach(function (el) {
    if (el.id === '') return;
    if (seen[el.id]) dups++;
    seen[el.id] = true;
  });
  return dups;
}`;

/** Tag the first ten To do cards from index arg.tagIndices and start counting mutation nodes on body. */
export const OBSERVER_START = `(arg) => {
  var sec = document.querySelector('[data-column="todo"]');
  var cards = sec.querySelectorAll('[data-list] > [data-card]');
  var tagged = [];
  for (var i = 0; i < arg.tagIndices.length; i++) {
    var li = cards[arg.tagIndices[i]];
    if (li) { li.__benchTag = true; tagged.push(li); }
  }
  var state = { sum: 0, tagged: tagged, obs: null };
  state.obs = new MutationObserver(function (records) {
    records.forEach(function (r) { state.sum += r.addedNodes.length + r.removedNodes.length; });
  });
  state.obs.observe(document.body, { childList: true, subtree: true });
  window.__kbBudget = state;
  return { tagged: tagged.length, todo: cards.length };
}`;

/** Drain pending mutation records into the running sum. Returns { sum, intact, tagged }. */
export const OBSERVER_FLUSH = `() => {
  var s = window.__kbBudget;
  if (!s) return { sum: -1, intact: false, tagged: 0 };
  s.obs.takeRecords().forEach(function (r) { s.sum += r.addedNodes.length + r.removedNodes.length; });
  var intact = s.tagged.every(function (el) { return el.isConnected && el.__benchTag === true; });
  return { sum: s.sum, intact: intact, tagged: s.tagged.length };
}`;

/** Zero the running sum, discarding records already queued. */
export const OBSERVER_RESET = `() => {
  var s = window.__kbBudget;
  if (!s) return false;
  s.obs.takeRecords();
  s.sum = 0;
  return true;
}`;

/**
 * One in-page action and the board, the add wiring and the add-error visibility, all read in the
 * same turn. arg.op is one of: add (set #new-title with input events, then click #add-btn),
 * add-many (the same for each title in arg.titles), action (click the card's button, found by
 * title and data-action; a disabled button is reported, not clicked), id (click #undo or #redo
 * unless disabled), undo-many (click #undo up to arg.count times while it is enabled).
 * Returns { act, board, wiring, addError }.
 */
const ACT_BODY = `(arg) => {
  function setField(value) {
    var input = document.getElementById('new-title');
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function clickAdd() {
    var btn = document.getElementById('add-btn');
    if (!btn) return false;
    btn.click();
    return true;
  }
  function cardsTitled(title) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-card]')).filter(function (li) {
      var t = li.querySelector('[data-card-title]');
      return t !== null && t.textContent === title;
    });
  }
  function act(a) {
    if (a.op === 'add') {
      if (!setField(a.title)) return { ok: false, why: 'no add form' };
      if (!clickAdd()) return { ok: false, why: 'no add button' };
      return { ok: true };
    }
    if (a.op === 'add-many') {
      var n = 0;
      for (var i = 0; i < a.titles.length; i++) {
        if (!setField(a.titles[i])) return { ok: false, why: 'no add form', n: n };
        if (!clickAdd()) return { ok: false, why: 'no add button', n: n };
        n++;
      }
      return { ok: true, n: n };
    }
    if (a.op === 'action') {
      var hits = cardsTitled(a.title);
      if (hits.length !== 1) return { ok: false, why: 'card ' + hits.length };
      var target = hits[0].querySelector('button[data-action="' + a.action + '"]');
      if (!target) return { ok: false, why: 'no button' };
      if (target.disabled) return { ok: true, disabled: true };
      target.click();
      return { ok: true, disabled: false };
    }
    if (a.op === 'id') {
      var el = document.getElementById(a.id);
      if (!el) return { ok: false, why: 'no #' + a.id };
      if (el.disabled) return { ok: true, disabled: true };
      el.click();
      return { ok: true, disabled: false };
    }
    if (a.op === 'undo-many') {
      var u = document.getElementById('undo');
      if (!u) return { ok: false, why: 'no #undo', n: 0 };
      var done = 0;
      while (done < a.count && !u.disabled) { u.click(); done++; }
      return { ok: true, n: done };
    }
    return { ok: false, why: 'unknown op' };
  }
  var result = act(arg);
  return {
    act: result,
    board: __READ__(undefined),
    wiring: __WIRING__(undefined),
    addError: __VISIBLE__('#add-error')
  };
}`;

// Each helper is wrapped in parentheses before it is spliced in: a bare arrow
// function followed by "(undefined)" is a syntax error inside an object literal.
export const ACT_AND_READ: string = ACT_BODY.split('__READ__')
  .join(`(${READ_BOARD})`)
  .split('__WIRING__')
  .join(`(${ADD_WIRING})`)
  .split('__VISIBLE__')
  .join(`(${VISIBLE})`);
