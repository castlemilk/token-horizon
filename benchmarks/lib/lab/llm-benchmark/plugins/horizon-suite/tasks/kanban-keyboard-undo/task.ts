/**
 * The kanban-keyboard-undo row. The prompt is the specification's final_prompt, copied
 * verbatim (a unit test compares it with the spec file when that file exists).
 * Hidden inputs live in hidden.ts and the checks, never in this file.
 */
import type { BenchmarkTask } from '../../../../types'
import { checks } from './checks'

export const PROMPT = `Build a single-file HTML kanban board called Sprint Board that can be used entirely from the keyboard and supports undo and redo. It should look like a polished, shippable tool. An automated browser script grades it against the exact contract below, using card titles and operation sequences you have not seen. Use every id and data attribute exactly as written.

BOARD
- Three columns in this order: elements with data-column="todo", "doing" and "done". Each is a region (a <section> or role="region") whose accessible name is exactly "To do", "Doing" or "Done".
- Each column contains one list element with the attribute data-list (a <ul>, <ol> or role="list") whose direct children are that column's cards in board order, top to bottom, and one element with the attribute data-count whose text is the number of cards in the column.
- A card is a list item (<li> or role="listitem") with the attribute data-card and tabindex="0". It contains its title in an element with the attribute data-card-title, and three buttons: data-action="move-left", data-action="move-right" and data-action="delete", with the accessible names Move "TITLE" left, Move "TITLE" right and Delete "TITLE" (the card's own title, in double quotes). move-left is disabled on cards in To do, move-right on cards in Done.
- First load, when nothing is stored: To do holds "Draft release notes", "Fix login redirect", "Update pricing copy"; Doing holds "Migrate billing cron"; Done holds "Rotate API keys".
- Doing holds at most 3 cards. Show that limit in its header.

ADDING CARDS
- <form id="add-form"> containing <input id="new-title" type="text"> (accessible name "New card title"), <button id="add-btn" type="submit"> (accessible name "Add card") and <p id="add-error">. Submitting, by the button or by Enter, adds a card at the END of To do.
- The title is normalised first: trim it and collapse every run of whitespace into one space. It is valid if the result is 1 to 80 characters long.
- Invalid: add nothing, show a message in #add-error (referenced by aria-describedby on #new-title), set aria-invalid="true" on #new-title and leave the typed text alone.
- Valid: add the card, empty #new-title and #add-error, set aria-invalid="false" and keep focus in #new-title.
- Titles are user data. Render them as text, never as HTML, on every code path, including restoring after a reload. An 80-character title without spaces wraps inside its card instead of overflowing.

MOVING CARDS (each successful operation here is one action)
- With a card element focused: Shift+ArrowUp or Shift+ArrowDown swaps it with the card above or below in the same column. Shift+ArrowLeft or Shift+ArrowRight moves it to the END of the neighbouring column; the move-left and move-right buttons do the same. The Delete key removes it; so does the delete button.
- Plain ArrowUp or ArrowDown on a focused card moves focus to the previous or next card in the column, without wrapping. That is not an action.
- These are no-ops and are NOT actions: up from the top, down from the bottom, left from To do, right from Done, and any move into Doing while it already holds 3 cards.
- After a keyboard swap or move, the card keeps focus. After a delete, by key or by button, focus goes to the next card in that column, otherwise to the previous card, otherwise to #new-title.
- The order of card elements in the DOM is always the board order, and cards are drawn in that order. Do not reorder with CSS.

UNDO AND REDO
- <button id="undo"> (accessible name "Undo") and <button id="redo"> (accessible name "Redo"). Each has the disabled attribute whenever it has nothing to do.
- The actions are add, swap, move and delete. Undo reverts the latest action exactly, so a deleted or moved card returns to its previous column and position. Redo applies it again. A new action empties the redo history. Keep at least 100 levels. No-ops never enter the history.
- Keyboard: Ctrl+Z or Cmd+Z is undo; Ctrl+Y, Ctrl+Shift+Z or Cmd+Shift+Z is redo. Compare the letter case-insensitively. The shortcuts work while focus is on a card, a button or the page, and must be left alone while focus is in #new-title. With nothing to undo or redo they do nothing.

STATUS MESSAGES
- <div id="status" role="status" aria-live="polite">. After every action, undo and redo, set its text to a sentence containing the card's title; after a move it also contains the destination column's name. After a move rejected because Doing is full, the text contains the word "limit".

PERSISTENCE
- Save the board, but not the history, to localStorage after every change and restore it on load. After a reload both history buttons are disabled.
- If the stored value is missing, is not valid JSON or does not describe a valid board, start from the first-load board without throwing.
- localStorage can throw on any access. Wrap every use in try/catch: the board must work completely without it.

ENGINEERING QUALITY
- Update the DOM in place. An action must not re-create cards it does not touch: with 100 cards on the board, one swap or move may add or remove at most 20 DOM nodes in total (counted as a MutationObserver watching <body> with childList and subtree reports added plus removed nodes), and every other card stays the same element object.
- Everything is synchronous: when a key, click or submit handler returns, the DOM, counts, button states, status text and focus are already final. No animations or transitions.
- <html lang="en">, exactly one <h1>, all content inside <main>. No uncaught exceptions and no console.error output, whatever is typed, pressed or clicked.`

export const SANDBOX_HYGIENE = `EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:
- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.
- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.
- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.
- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.
- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.
- No alert/confirm/prompt; render all feedback into the page itself.
- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.
Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Open the document with <html lang="en">. Every control must work; no placeholder text. Output only the HTML document.`

const CHECK_NAMES = Object.keys(checks)

export const task: BenchmarkTask = {
  id: 'kanban-keyboard-undo',
  slug: 'kanban-keyboard-undo',
  category: 'ui-building',
  title: 'Keyboard Kanban with Undo',
  blurb: 'A keyboard-only kanban board with exact undo and redo, a WIP limit, safe rendering and recovery from corrupt storage.',
  prompt: PROMPT,
  runtimeHint: 'Browser, DOM and keyboard, localStorage with a throwing fallback',
  iterationsDefault: 3,
  methodNotes:
    '100-point behavioural score over ten checks: structure and names (7), add validation (8), Shift+arrow moves with edge no-ops (13), focus management (11), WIP limit (8), undo and redo against a reference model (16), safe rendering on add and restore (9), persistence and recovery (9), per-action DOM budget (10) and a robust session including storage-throws mode (9). The checks verify observable behaviour: the DOM after real key and click events, the board against an independent model, focus, status text, history and node counts. They do not grade visual design, colour contrast, responsive layout or code quality, and they do not test drag and drop, which the prompt does not require.',
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: CHECK_NAMES,
  sandboxConstraints: '\n' + SANDBOX_HYGIENE,
}
