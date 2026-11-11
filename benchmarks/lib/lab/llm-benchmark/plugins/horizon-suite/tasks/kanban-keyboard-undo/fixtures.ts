/**
 * Fixtures for the kanban-keyboard-undo suite: the good reference artifact, conforming
 * variants that must score 100, the broken variants (the specification's named mutations
 * and the cheats found in review), and the static fake. Every variant is a documented,
 * targeted edit of the good source, so each one changes one behaviour and nothing else.
 * The expectation table gives, per fixture, the exact checks that must fail. Node only
 * (vitest and the matrix).
 */
import { readFileSync } from 'node:fs'

export const goodArtifact: string = readFileSync(new URL('./good-artifact.html', import.meta.url), 'utf8')

/** Replace exactly one occurrence of `from` with `to`. Throws unless the text occurs once and changes. */
export function replaceOnce(src: string, from: string, to: string, label: string): string {
  const count = src.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected the text once, found ${count}`)
  const out = src.replace(from, () => to)
  if (out === src) throw new Error(`${label}: the replacement did not change the source`)
  return out
}

/** Replace the region from the start marker up to (not including) the end marker. Both markers must be unique. */
export function replaceRegion(src: string, startMarker: string, endMarker: string, to: string, label: string): string {
  const starts = src.split(startMarker).length - 1
  const ends = src.split(endMarker).length - 1
  if (starts !== 1 || ends !== 1) throw new Error(`${label}: markers occur ${starts}/${ends} times`)
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker)
  if (b <= a) throw new Error(`${label}: end marker precedes start marker`)
  const out = src.slice(0, a) + to + src.slice(b)
  if (out === src) throw new Error(`${label}: the region did not change`)
  return out
}

// ---------------------------------------------------------------------------
// Broken variants named by the specification
// ---------------------------------------------------------------------------

/** Card buttons with glyphs only: no accessible names. Fails structure-names only. */
function unnamedCardButtons(src: string): string {
  return replaceOnce(src, "      b.setAttribute('aria-label', label);\n", '', 'unnamed-card-buttons')
}

/** Titles are trimmed but inner whitespace is kept, and 81 characters are accepted. Fails add-validation only. */
function noWhitespaceCollapse(src: string): string {
  let out = replaceOnce(
    src,
    'function normalise(raw) { return String(raw).trim().replace(/\\s+/g, \' \'); }',
    'function normalise(raw) { return String(raw).trim(); }',
    'no-whitespace-collapse normalise'
  )
  out = replaceOnce(
    out,
    'function validTitle(t) { return t.length >= 1 && t.length <= MAX_TITLE; }',
    'function validTitle(t) { return t.length >= 1 && t.length <= MAX_TITLE + 1; }',
    'no-whitespace-collapse limit'
  )
  return out
}

/** Shift+ArrowDown on the second-to-last card is treated as the bottom. Fails keyboard-moves only. */
function swapEdgeOffByOne(src: string): string {
  return replaceOnce(
    src,
    'if (j < 0 || j >= board[loc.col].length) return false;',
    'if (j < 0 || j >= board[loc.col].length || (dir > 0 && j === board[loc.col].length - 1)) return false;',
    'swap-edge-off-by-one'
  )
}

/** Cards are re-inserted without focus(), and a delete leaves focus on body. Fails focus-management only. */
function focusDropped(src: string): string {
  let out = replaceOnce(src, 'function focusCard(card) { card.el.focus(); }', 'function focusCard(card) { }', 'focus-dropped focusCard')
  out = replaceOnce(out, 'if (next) focusCard(next); else input.focus();', 'if (next) focusCard(next);', 'focus-dropped delete')
  return out
}

/** The limit is enforced for keys but not for the move-right button. Fails wip-limit only. */
function wipButtonBypass(src: string): string {
  return replaceOnce(src, 'function () { tryMove(card, 1, true); }', 'function () { tryMove(card, 1, false); }', 'wip-button-bypass')
}

/** Keyboard edge no-ops push a history entry. Fails undo-redo only. */
function noopInHistory(src: string): string {
  let out = replaceOnce(
    src,
    'if (ti < 0 || ti >= COLS.length) return false;',
    "if (ti < 0 || ti >= COLS.length) { undoStack.push({ kind: 'noop', card: card, from: null, to: null }); redoStack.length = 0; return false; }",
    'noop-in-history move'
  )
  out = replaceOnce(
    out,
    'var j = loc.index + dir;\n      if (j < 0 || j >= board[loc.col].length) return false;',
    "var j = loc.index + dir;\n      if (j < 0 || j >= board[loc.col].length) { undoStack.push({ kind: 'noop', card: card, from: null, to: null }); redoStack.length = 0; return false; }",
    'noop-in-history swap'
  )
  return out
}

/** The restore path builds cards with innerHTML. Fails safe-rendering only. */
function innerhtmlRestore(src: string): string {
  return replaceOnce(
    src,
    '        var card = makeCard(title);\n        put(card, col, board[col].length);',
    "        var card = makeCard(title);\n        card.el.querySelector('[data-card-title]').innerHTML = title;\n        put(card, col, board[col].length);",
    'innerhtml-restore'
  )
}

/**
 * JSON.parse with no shape check. The storage read stays guarded, so this fails
 * persistence-recovery only (the opaque start-up still reaches the first-load board).
 */
function trustingRestore(src: string): string {
  return replaceRegion(
    src,
    '    function readStored() {',
    '    var source = readStored() || FIRST_LOAD;',
    "    function readStored() {\n      var raw = null;\n      try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }\n      return raw === null ? null : JSON.parse(raw);\n    }\n\n",
    'trusting-restore'
  )
}

/**
 * Every action rebuilds all three lists from state, then refocuses the moved card by
 * title. Fails update-budget only.
 */
function fullRerender(src: string): string {
  const rerender = [
    'function rerenderAll() {',
    '  var active = document.activeElement;',
    "  var title = (active && active.matches && active.matches('[data-card]')) ? active.querySelector('[data-card-title]').textContent : null;",
    '  COLS.forEach(function (col) {',
    '    var list = listOf(col);',
    '    while (list.firstChild) list.removeChild(list.firstChild);',
    '    board[col].forEach(function (c) {',
    '      buildCard(c);',
    '      list.appendChild(c.el);',
    "      c.left.disabled = col === 'todo';",
    "      c.right.disabled = col === 'done';",
    '    });',
    '  });',
    '  if (title !== null) focusCard({ title: title });',
    '}',
    'function afterChange() {',
    '      rerenderAll();',
  ].join('\n')
  let out = replaceOnce(src, 'function afterChange() {', rerender, 'full-rerender afterChange')
  out = replaceOnce(
    out,
    'function focusCard(card) { card.el.focus(); }',
    "function focusCard(card) { var el = null; Array.prototype.forEach.call(document.querySelectorAll('[data-card]'), function (li) { var t = li.querySelector('[data-card-title]'); if (t && t.textContent === card.title) el = li; }); if (el) el.focus(); }",
    'full-rerender focusCard'
  )
  return out
}

/** Ctrl+Z with an empty history dereferences pop()'s result. Fails robust-session only. */
function undoEmptyThrows(src: string): string {
  return replaceOnce(src, '      var cmd = undoStack.pop();\n      if (!cmd) return;', '      var cmd = undoStack.pop();', 'undo-empty-throws')
}

/** localStorage read at start-up without try/catch. Fails robust-session only. */
function unguardedStorage(src: string): string {
  // Only the storage read is unguarded. JSON parsing keeps its own try/catch, so corrupt
  // values still recover; the difference is the opaque origin, where getItem throws.
  return replaceOnce(
    src,
    '      try {\n        var raw = window.localStorage.getItem(STORE_KEY);\n        if (raw === null) return null;',
    '      var raw = window.localStorage.getItem(STORE_KEY);\n      try {\n        if (raw === null) return null;',
    'unguarded-storage read'
  )
}

// ---------------------------------------------------------------------------
// Broken variants from the review: cheats that passed, and documented gaps
// ---------------------------------------------------------------------------

/**
 * Every click and submit does its work in the next animation frame. The prompt makes each
 * handler synchronous, so a read in the same turn must see the card, the move or the history
 * change. Fails each check that reads a click or submit.
 */
function deferredClicks(src: string): string {
  let out = replaceOnce(src, '    var cardByEl = new WeakMap();\n', '    var cardByEl = new WeakMap();\n    function defer(fn) { requestAnimationFrame(fn); }\n', 'deferred defer')
  out = replaceOnce(out, 'function () { tryMove(card, -1, true); }', 'function () { defer(function () { tryMove(card, -1, true); }); }', 'deferred move-left')
  out = replaceOnce(out, 'function () { tryMove(card, 1, true); }', 'function () { defer(function () { tryMove(card, 1, true); }); }', 'deferred move-right')
  out = replaceOnce(out, 'function () { deleteCard(card); }', 'function () { defer(function () { deleteCard(card); }); }', 'deferred delete')
  out = replaceOnce(out, '      addCard(title);', '      defer(function () { addCard(title); });', 'deferred add')
  out = replaceOnce(out, "    undoBtn.addEventListener('click', undo);", "    undoBtn.addEventListener('click', function () { defer(undo); });", 'deferred undo')
  out = replaceOnce(out, "    redoBtn.addEventListener('click', redo);", "    redoBtn.addEventListener('click', function () { defer(redo); });", 'deferred redo')
  return out
}

/** The Shift+arrow move keys are not handled at all: focus stays where it is and nothing moves. */
function noShiftArrows(src: string): string {
  return replaceOnce(
    src,
    "        if (key === 'ArrowUp') { e.preventDefault(); swapBy(card, -1); }\n" +
      "        else if (key === 'ArrowDown') { e.preventDefault(); swapBy(card, 1); }\n" +
      "        else if (key === 'ArrowLeft') { e.preventDefault(); moveBy(card, -1); }\n" +
      "        else if (key === 'ArrowRight') { e.preventDefault(); moveBy(card, 1); }\n",
    '',
    'no-shift-arrows'
  )
}

/** A move into Done lands at the top, and a move out of Done does nothing. */
function doneColumnBroken(src: string): string {
  return replaceOnce(
    src,
    "      commit({ kind: 'move', card: card, from: loc, to: { col: to, index: board[to].length } });",
    "      if (loc.col === 'done') return false;\n      commit({ kind: 'move', card: card, from: loc, to: { col: to, index: to === 'done' ? 0 : board[to].length } });",
    'done-column-broken'
  )
}

/** Only Ctrl with lower-case z and y work: no Cmd, and no Ctrl+Shift+Z. */
function ctrlOnlyShortcuts(src: string): string {
  return replaceOnce(
    src,
    "      if (e.ctrlKey || e.metaKey) {\n        var k = String(key).toLowerCase();\n        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }\n        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }",
    "      if (e.ctrlKey) {\n        if (key === 'z') { e.preventDefault(); undo(); }\n        else if (key === 'y') { e.preventDefault(); redo(); }",
    'ctrl-only-shortcuts'
  )
}

/** Plain arrows wrap from the last card to the first and back. */
function arrowsWrap(src: string): string {
  return replaceOnce(
    src,
    '      var target = board[loc.col][loc.index + dir];',
    '      var n = board[loc.col].length;\n      var target = board[loc.col][(loc.index + dir + n) % n];',
    'arrows-wrap'
  )
}

/** The WIP rejection is announced only the first time. */
function firstRejectionOnly(src: string): string {
  return replaceOnce(
    src,
    '        setStatus(\'Doing is full (limit 3). "\' + card.title + \'" was not moved.\');',
    '        if (!window.__said) { window.__said = true; setStatus(\'Doing is full (limit 3). "\' + card.title + \'" was not moved.\'); }',
    'first-rejection-only'
  )
}

/** The board is drawn at opacity 0 (a hidden decoy): the DOM is right, nothing is visible. */
function opacityBoard(src: string): string {
  return replaceOnce(
    src,
    '.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    '.board{opacity:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    'opacity-board'
  )
}

/** The history keeps 12 levels, not the 100 the specification asks for. */
function historyCap12(src: string): string {
  return replaceOnce(src, 'var HISTORY_CAP = 200;', 'var HISTORY_CAP = 12;', 'history-cap-12')
}

/** The restore path has no shape check: a parsed value is used as it is. */
function noShapeRestore(src: string): string {
  return replaceRegion(
    src,
    '    function readStored() {',
    '    var source = readStored() || FIRST_LOAD;',
    "    function readStored() {\n      try {\n        var raw = window.localStorage.getItem(STORE_KEY);\n        return raw === null ? null : JSON.parse(raw);\n      } catch (e) {\n        return null;\n      }\n    }\n\n",
    'no-shape-restore'
  )
}

/**
 * Ctrl+Z on an empty history throws inside undo(); the function catches it and writes the
 * message into the alert element. The specification's alert scan must see it.
 */
function undoAlertsOnEmpty(src: string): string {
  return replaceRegion(
    src,
    '    function undo() {',
    '    function redo() {',
    "    function undo() {\n      try {\n        var cmd = undoStack.pop();\n        applyCmd(cmd, false);\n        redoStack.push(cmd);\n        setStatus('Undid: ' + sentence(cmd, true) + '.');\n        afterChange();\n      } catch (err) {\n        document.getElementById('app-error').textContent = String(err);\n      }\n    }\n\n",
    'undo-alerts-on-empty'
  )
}

/** The history buttons use aria-disabled instead of the disabled attribute. */
function ariaDisabledHistory(src: string): string {
  let out = replaceOnce(
    src,
    '<button id="undo" type="button" disabled>Undo</button>',
    '<button id="undo" type="button" aria-disabled="true">Undo</button>',
    'aria-disabled undo button'
  )
  out = replaceOnce(
    out,
    '<button id="redo" type="button" disabled>Redo</button>',
    '<button id="redo" type="button" aria-disabled="true">Redo</button>',
    'aria-disabled redo button'
  )
  out = replaceOnce(
    out,
    '      undoBtn.disabled = undoStack.length === 0;\n      redoBtn.disabled = redoStack.length === 0;',
    "      undoBtn.setAttribute('aria-disabled', String(undoStack.length === 0));\n      redoBtn.setAttribute('aria-disabled', String(redoStack.length === 0));",
    'aria-disabled after change'
  )
  out = replaceOnce(
    out,
    '    undoBtn.disabled = true;\n    redoBtn.disabled = true;',
    "    undoBtn.setAttribute('aria-disabled', 'true');\n    redoBtn.setAttribute('aria-disabled', 'true');",
    'aria-disabled at start'
  )
  return out
}

/** Delete buttons are named with their glyph only, so no delete button can be found by its name. */
function unnamedDeleteButtons(src: string): string {
  return replaceOnce(src, `'✕', 'Delete "' + title + '"'`, `'✕', '✕'`, 'unnamed-delete-buttons')
}

/** Start-up error replaced by a generic message, with the storage read unguarded. */
function unguardedGenericAlert(src: string): string {
  return replaceOnce(
    unguardedStorage(src),
    "alertBox.textContent = 'Startup error: ' + (err && err.message ? err.message : String(err));",
    "alertBox.textContent = 'Something went wrong while starting the board.';",
    'generic-alert'
  )
}

/**
 * The status line is built from DOM nodes: the title is text in a strong element. Its text
 * is literal, but the specification's safe-rendering method requires #status to have no element
 * children. Kept as a documented spec conflict (fails safe-rendering only).
 */
function strongStatus(src: string): string {
  return replaceOnce(
    src,
    '    function setStatus(text) { statusEl.textContent = text; }',
    "    function setStatus(text) { var s = document.createElement('strong'); s.textContent = text; statusEl.textContent = ''; statusEl.appendChild(s); }",
    'strong-status'
  )
}

// ---------------------------------------------------------------------------
// Conforming variants: each must score 100
// ---------------------------------------------------------------------------

/** The To do list scrolls inside a fixed height. Cards sit in the list's scroll content. */
function scrollingColumns(src: string): string {
  return replaceOnce(
    src,
    'ul.list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0}',
    'ul.list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;min-width:0;max-height:calc(100vh - 330px);overflow-y:auto}li[data-card]{flex:0 0 auto}',
    'scrolling-columns'
  )
}

/** A 100vh app shell: each column scrolls inside the shell. */
function appShellColumns(src: string): string {
  let out = replaceOnce(
    src,
    'main{padding:16px;max-width:1120px;margin:0 auto;box-sizing:border-box}',
    'main{padding:16px;max-width:1120px;margin:0 auto;box-sizing:border-box;height:100vh;display:flex;flex-direction:column;overflow:hidden}',
    'shell main'
  )
  out = replaceOnce(out, '.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}', '.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;flex:1 1 auto;min-height:0}', 'shell board')
  out = replaceOnce(
    out,
    '.column{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}',
    '.column{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0;min-height:0;overflow-y:auto}',
    'shell column'
  )
  out = replaceOnce(out, 'li[data-card]{background', 'li[data-card]{flex:0 0 auto;background', 'shell card')
  return out
}

/** The add form keeps its draft from input events and reads that draft on submit. */
function draftFromInputEvents(src: string): string {
  let out = replaceOnce(
    src,
    "    document.getElementById('add-form').addEventListener('submit', function (e) {",
    "    var draft = '';\n    input.addEventListener('input', function () { draft = input.value; });\n    document.getElementById('add-form').addEventListener('submit', function (e) {",
    'draft listener'
  )
  out = replaceOnce(out, '      var title = normalise(input.value);', '      var title = normalise(draft);', 'draft read')
  out = replaceOnce(out, "      input.value = '';\n      addError.textContent = '';", "      input.value = '';\n      draft = '';\n      addError.textContent = '';", 'draft clear')
  return out
}

/** The add error paragraph is also a status region (a second role=status on the page). */
function roleStatusError(src: string): string {
  return replaceOnce(src, '<p id="add-error"></p>', '<p id="add-error" role="status"></p>', 'role-status error')
}

/** The add button reads "+ Add card": the specification's name query is not exact. */
function plusAddCard(src: string): string {
  return replaceOnce(src, '<button id="add-btn" type="submit">Add card</button>', '<button id="add-btn" type="submit">+ Add card</button>', 'plus add card')
}

/** The counts carry spaces around the number. */
function paddedCount(src: string): string {
  return replaceOnce(src, '        var text = String(board[col].length);', "        var text = ' ' + String(board[col].length) + ' ';", 'padded count')
}

/** Conforming variants of the good artifact, each with one permitted difference. */
const goodVariants = {
  // The status line holds the title inside a <strong> built with createElement and textContent.
  'kanban-good-status-strong-title': strongStatus(goodArtifact),
  // Button names come from visually hidden text, not from aria-label.
  'kanban-good-sr-only-names': variant('good-sr-only-names'),
  'kanban-good-scrolling-columns': scrollingColumns(goodArtifact),
  'kanban-good-app-shell-columns': appShellColumns(goodArtifact),
  'kanban-good-input-events-draft': draftFromInputEvents(goodArtifact),
  'kanban-good-role-status-error': roleStatusError(goodArtifact),
  'kanban-good-plus-add-card': plusAddCard(goodArtifact),
  'kanban-good-padded-count': paddedCount(goodArtifact),
} as const

/** Every broken fixture, by name, built from the good artifact (the static fake is separate). */
export const brokenArtifacts: Record<string, string> = {
  'kanban-broken-unnamed-card-buttons': unnamedCardButtons(goodArtifact),
  'kanban-broken-unnamed-delete-buttons': unnamedDeleteButtons(goodArtifact),
  'kanban-broken-no-whitespace-collapse': noWhitespaceCollapse(goodArtifact),
  'kanban-broken-swap-edge-off-by-one': swapEdgeOffByOne(goodArtifact),
  'kanban-broken-focus-dropped': focusDropped(goodArtifact),
  'kanban-broken-wip-button-bypass': wipButtonBypass(goodArtifact),
  'kanban-broken-noop-in-history': noopInHistory(goodArtifact),
  'kanban-broken-innerhtml-restore': innerhtmlRestore(goodArtifact),
  'kanban-broken-trusting-restore': trustingRestore(goodArtifact),
  'kanban-broken-full-rerender': fullRerender(goodArtifact),
  'kanban-broken-undo-empty-throws': undoEmptyThrows(goodArtifact),
  'kanban-control-unguarded-storage': unguardedStorage(goodArtifact),
  'kanban-broken-deferred-clicks': deferredClicks(goodArtifact),
  'kanban-broken-no-shift-arrows': noShiftArrows(goodArtifact),
  'kanban-broken-done-column-moves': doneColumnBroken(goodArtifact),
  'kanban-broken-no-lang': variant('broken-no-lang'),
  'kanban-broken-swap-no-refocus': variant('broken-swap-no-refocus'),
  'kanban-broken-add-and-store-only': variant('broken-add-and-store-only'),
  'kanban-broken-ctrl-only-shortcuts': ctrlOnlyShortcuts(goodArtifact),
  'kanban-broken-arrows-wrap': arrowsWrap(goodArtifact),
  'kanban-broken-first-rejection-only': firstRejectionOnly(goodArtifact),
  'kanban-broken-opacity-board': opacityBoard(goodArtifact),
  'kanban-broken-history-cap-12': historyCap12(goodArtifact),
  'kanban-broken-no-shape-restore': noShapeRestore(goodArtifact),
  'kanban-broken-undo-empty-alert': undoAlertsOnEmpty(goodArtifact),
  'kanban-broken-aria-disabled-history': ariaDisabledHistory(goodArtifact),
  'kanban-broken-unguarded-generic-alert': unguardedGenericAlert(goodArtifact),
}

/** Read a page kept under variants/ (conforming variants and faults written by the reviewer). */
function variant(file: string): string {
  return readFileSync(new URL(`./variants/${file}.html`, import.meta.url), 'utf8')
}

/** The static fake: the first-load board as static markup with no handlers. */
export const staticFake = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sprint Board</title>
<style>html,body{margin:0;min-height:100%;background:#0c0c10;color:#ececf0;font-family:system-ui}main{padding:16px}.board{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}section{border:1px solid #2e2e3a;border-radius:12px;padding:12px}li{list-style:none;margin:6px 0;padding:8px;border:1px solid #2e2e3a}</style>
</head>
<body>
<main>
<h1>Sprint Board</h1>
<form id="add-form" onsubmit="return false"><label for="new-title">New card title</label><input id="new-title" type="text" aria-describedby="add-error"><button id="add-btn" type="submit">Add card</button><p id="add-error"></p></form>
<div><button id="undo" type="button" disabled>Undo</button> <button id="redo" type="button" disabled>Redo</button></div>
<div id="status" role="status" aria-live="polite"></div>
<div class="board">
<section data-column="todo" aria-labelledby="h-todo"><h2 id="h-todo">To do</h2><span data-count>3</span><ul data-list>
<li data-card tabindex="0"><span data-card-title>Draft release notes</span> <button data-action="move-left" disabled aria-label="Move &quot;Draft release notes&quot; left">&larr;</button><button data-action="move-right" aria-label="Move &quot;Draft release notes&quot; right">&rarr;</button><button data-action="delete" aria-label="Delete &quot;Draft release notes&quot;">&times;</button></li>
<li data-card tabindex="0"><span data-card-title>Fix login redirect</span> <button data-action="move-left" aria-label="Move &quot;Fix login redirect&quot; left">&larr;</button><button data-action="move-right" aria-label="Move &quot;Fix login redirect&quot; right">&rarr;</button><button data-action="delete" aria-label="Delete &quot;Fix login redirect&quot;">&times;</button></li>
<li data-card tabindex="0"><span data-card-title>Update pricing copy</span> <button data-action="move-left" aria-label="Move &quot;Update pricing copy&quot; left">&larr;</button><button data-action="move-right" aria-label="Move &quot;Update pricing copy&quot; right">&rarr;</button><button data-action="delete" aria-label="Delete &quot;Update pricing copy&quot;">&times;</button></li>
</ul></section>
<section data-column="doing" aria-labelledby="h-doing"><h2 id="h-doing">Doing</h2><p>Limit: 3 cards</p><span data-count>1</span><ul data-list>
<li data-card tabindex="0"><span data-card-title>Migrate billing cron</span> <button data-action="move-left" aria-label="Move &quot;Migrate billing cron&quot; left">&larr;</button><button data-action="move-right" aria-label="Move &quot;Migrate billing cron&quot; right">&rarr;</button><button data-action="delete" aria-label="Delete &quot;Migrate billing cron&quot;">&times;</button></li>
</ul></section>
<section data-column="done" aria-labelledby="h-done"><h2 id="h-done">Done</h2><span data-count>1</span><ul data-list>
<li data-card tabindex="0"><span data-card-title>Rotate API keys</span> <button data-action="move-left" aria-label="Move &quot;Rotate API keys&quot; left">&larr;</button><button data-action="move-right" disabled aria-label="Move &quot;Rotate API keys&quot; right">&rarr;</button><button data-action="delete" aria-label="Delete &quot;Rotate API keys&quot;">&times;</button></li>
</ul></section>
</div>
</main>
</body>
</html>
`;

const ALL_NAMES = [
  'kanban-structure-names',
  'kanban-add-validation',
  'kanban-keyboard-moves',
  'kanban-focus-management',
  'kanban-wip-limit',
  'kanban-undo-redo',
  'kanban-safe-rendering',
  'kanban-persistence-recovery',
  'kanban-update-budget',
  'kanban-robust-session',
]

/** Every fixture, in matrix order: the good artifact, conforming variants, broken variants, controls. */
const fixtureOrder: string[] = [
  'kanban-good',
  ...Object.keys(goodVariants),
  ...Object.keys(brokenArtifacts),
  'kanban-control-static-fake',
]

/** The checks each fixture must fail: 'good' or the exact list. */
export const expectations: Record<string, 'good' | readonly string[]> = {
  'kanban-good': 'good',
  'kanban-good-scrolling-columns': 'good',
  'kanban-good-app-shell-columns': 'good',
  'kanban-good-input-events-draft': 'good',
  'kanban-good-role-status-error': 'good',
  'kanban-good-plus-add-card': 'good',
  'kanban-good-padded-count': 'good',
  'kanban-good-status-strong-title': 'good',
  'kanban-good-sr-only-names': 'good',
  'kanban-broken-unnamed-card-buttons': ['kanban-structure-names'],
  'kanban-broken-unnamed-delete-buttons': ['kanban-structure-names'],
  'kanban-broken-no-whitespace-collapse': ['kanban-add-validation'],
  'kanban-broken-swap-edge-off-by-one': ['kanban-keyboard-moves'],
  'kanban-broken-focus-dropped': ['kanban-focus-management'],
  'kanban-broken-wip-button-bypass': ['kanban-wip-limit'],
  'kanban-broken-noop-in-history': ['kanban-undo-redo'],
  'kanban-broken-innerhtml-restore': ['kanban-safe-rendering'],
  'kanban-broken-trusting-restore': ['kanban-persistence-recovery'],
  'kanban-broken-full-rerender': ['kanban-update-budget'],
  'kanban-broken-undo-empty-throws': ['kanban-robust-session'],
  'kanban-control-unguarded-storage': ['kanban-robust-session'],
  'kanban-broken-deferred-clicks': [
    'kanban-add-validation',
    'kanban-keyboard-moves',
    'kanban-focus-management',
    'kanban-wip-limit',
    'kanban-undo-redo',
    'kanban-safe-rendering',
    'kanban-persistence-recovery',
    'kanban-update-budget',
    'kanban-robust-session',
  ],
  'kanban-broken-no-shift-arrows': [
    'kanban-keyboard-moves',
    'kanban-focus-management',
    'kanban-wip-limit',
    'kanban-undo-redo',
    'kanban-update-budget',
  ],
  'kanban-broken-done-column-moves': ['kanban-keyboard-moves'],
  'kanban-broken-no-lang': ['kanban-structure-names'],
  'kanban-broken-swap-no-refocus': ['kanban-focus-management'],
  'kanban-broken-add-and-store-only': [
    'kanban-keyboard-moves',
    'kanban-focus-management',
    'kanban-wip-limit',
    'kanban-undo-redo',
    'kanban-safe-rendering',
    'kanban-persistence-recovery',
    'kanban-update-budget',
    'kanban-robust-session',
  ],
  'kanban-broken-ctrl-only-shortcuts': ['kanban-undo-redo'],
  'kanban-broken-arrows-wrap': ['kanban-focus-management'],
  'kanban-broken-first-rejection-only': ['kanban-wip-limit'],
  'kanban-broken-opacity-board': ['kanban-structure-names', 'kanban-undo-redo'],
  'kanban-broken-history-cap-12': ['kanban-undo-redo'],
  'kanban-broken-no-shape-restore': ['kanban-persistence-recovery'],
  'kanban-broken-undo-empty-alert': ['kanban-robust-session'],
  'kanban-broken-aria-disabled-history': ['kanban-structure-names', 'kanban-undo-redo', 'kanban-persistence-recovery'],
  'kanban-broken-unguarded-generic-alert': ['kanban-robust-session'],
  // Specification: passes only kanban-structure-names. Every other check must fail.
  'kanban-control-static-fake': ALL_NAMES.filter((n) => n !== 'kanban-structure-names'),
}

/** Every fixture, in matrix order. */
export function allFixtures(): Array<{ name: string; html: string }> {
  return fixtureOrder.map((name) => ({
    name,
    html:
      name === 'kanban-good'
        ? goodArtifact
        : name === 'kanban-control-static-fake'
          ? staticFake
          : (goodVariants as Record<string, string>)[name] ?? brokenArtifacts[name]!,
  }))
}
