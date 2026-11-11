/**
 * The pathfinding-lab task row: the prompt the model receives, the sandbox contract that
 * follows it, and the notes that say what the checks do and do not verify.
 *
 * The prompt is the specification's final_prompt, copied verbatim (checks.test.ts compares it
 * with the JSON file when that file exists). The sandbox contract is the hygiene-only text
 * from prompts.ts: the first eight lines of SANDBOX_CONSTRAINTS and one sentence. It is copied
 * here, not imported, so that a change to the global contract does not silently change this task.
 */
import type { BenchmarkTask } from '../../../../types'

export const PROMPT = `Build a single-file HTML page, "Pathfinding Lab": a weighted grid map on which BFS, Dijkstra and A* are run, replayed and compared. A grading script loads its own hidden maps through the JavaScript API below, checks every returned path and expansion order against its own solver, and then checks that what you DRAW matches what you returned. Use every id, data attribute and function name exactly as written.

MAP
- A grid of rows x cols cells, up to 24 x 40. Terrain per cell: '#' wall (impassable), '.' open (cost 1), '~' mud (cost 5), '=' road (cost 0.5).
- A move goes from a cell to a neighbouring non-wall cell and costs the terrain cost of the cell being ENTERED. Path cost is the sum over its moves; the start cell's own terrain is never charged. The path from a cell to itself has cost 0.
- With diagonals off, the neighbours are the 4 orthogonal cells. With diagonals on, the 4 diagonal neighbours are added; a diagonal move costs sqrt(2) times the entered cell's cost and is allowed only if BOTH orthogonal cells it passes between are non-wall (no cutting corners).

ALGORITHMS (deterministic, no randomness; each stops the moment the goal cell is taken off the frontier and expanded)
- 'bfs': breadth-first search that ignores terrain costs and returns a path with the fewest moves. Its reported cost is still the true terrain cost of that path.
- 'dijkstra': uniform-cost search; returns a minimum-cost path.
- 'astar': A* using EXACTLY this heuristic: h(cell) = cmin * D, where cmin is the smallest terrain cost among the map's non-wall cells and D is the Manhattan distance to the goal (diagonals off) or the octile distance max(dr, dc) + (sqrt(2) - 1) * min(dr, dc) (diagonals on). It must return a minimum-cost path.
- "Expanded" means removed from the frontier and finalised. Each cell is expanded at most once: skip stale queue entries and do not count them. Cells that were discovered but never expanded are NOT part of the expansion order.

API (define window.__bench synchronously while the page loads)
- __bench.loadGrid({rows, start, goal, diagonals}): rows is an array of equal-length strings over the characters # . ~ = ; start and goal are [r, c], 0-based, never walls, possibly equal; diagonals is a boolean. Replaces the map, clears any previous result, stops any playback and redraws synchronously.
- __bench.solve(algorithm): runs 'bfs', 'dijkstra' or 'astar' on the current map synchronously, makes it the displayed result with the scrubber at its maximum, and returns {found, path, cost, order}: found is a boolean; path is [[r,c], ...] from start to goal inclusive, or [] when not found; cost is a number, or null when not found; order is [[r,c], ...], the cells in the order they were expanded (start first; the goal last when found; when not found, every cell reachable from the start, each exactly once).
- __bench.last(): the most recent result object with an added algorithm field, or null straight after loadGrid.

DRAWING (plain HTML elements, so the grader can read them)
- Inside <div id="grid">, one element per cell carrying data-r, data-c and data-terrain="wall|open|mud|road". The start and goal cells also carry data-role="start" or data-role="goal".
- Cells are square, all the same size (at least 8 px a side), in a regular grid: row r above row r+1, column c left of column c+1. The WHOLE grid is visible without scrolling in a 1024 x 720 window for any map up to 24 x 40.
- Each cell element's own CSS background-color carries its state, with no transition or animation on it. The four terrains have four clearly different colours. An expanded cell has data-visited="true" and a background colour different from the one it has when not expanded. A cell on the shown path has data-path="true" (as well as data-visited="true"), and ALL path cells share one single background colour that no other cell uses. Every other cell carries data-visited="false" and data-path="false". Mark start and goal with an inner marker or outline, not by breaking these rules.
- <input type="range" id="scrub" min="0"> with max = N = order.length. At scrubber value k (set by the user, or by script through .value plus an 'input' event) exactly the first k cells of the order are shown as visited, synchronously; the path is shown only when k = N and a path was found.
- <output id="stat-cost">, <output id="stat-moves">, <output id="stat-expanded">: the displayed result's cost (a plain number correct to at least 4 decimal places), its number of moves (path length - 1) and its order length. With no path, cost and moves show a dash. <div id="status" data-state="idle|found|no-path"> with a short message; when there is no path the message contains the words "no path".

INTERACTION
- <select id="algo"> with options bfs, dijkstra, astar; <button id="run">; a checkbox #diagonals; a Play button that animates the scrubber from 0 to N.
- Clicking a cell (start and goal ignore clicks) turns a wall into open and any other terrain into a wall, then synchronously re-solves with the algorithm of the displayed result (or the selected one if there is none) and updates grid, stats, status and scrubber. __bench.last() returns the new result.
- On page load show a built-in 20 x 32 demo map that uses all four terrains, already solved with A*.`

export const SANDBOX_CONTRACT = `EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:
- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.
- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.
- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.
- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.
- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.
- No alert/confirm/prompt; render all feedback into the page itself.
- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.
Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.`

export const task: BenchmarkTask = {
  id: 'pathfinding-lab',
  slug: 'pathfinding-lab',
  category: 'advanced-game-building',
  title: 'Pathfinding Lab: optimal paths on hidden weighted maps',
  blurb: 'BFS, Dijkstra and A* on weighted grids, graded on hidden maps by re-costed paths, expansion-order bounds and the drawn state.',
  prompt: PROMPT,
  runtimeHint: 'Browser, DOM grid, window.__bench API and one pointer click on a cell',
  iterationsDefault: 3,
  methodNotes:
    'Each search answer must be a real walk on the grader\'s map: its path is re-walked and re-costed by an independent Node reference, its order is checked against the path, and every reported cost is compared with a NaN-safe test. Expansion orders are tested against the set bounds, which hold for every tie-breaking rule, so the grade does not depend on which equal-cost cell an algorithm picks. path-dijkstra also counts Math.random calls and requires two identical solves of the path, cost and order (extra fields are ignored). path-visual-sync sets the scrubber in one JavaScript turn, requires every cell to be drawn and hit-testable, and compares attributes and exact computed colours. path-edit-resolve makes one real pointer click on a path cell. path-stats-dom reads the displayed numbers and checks them against the grader\'s own re-walk of the returned path. Each map is loaded, solved and read in one page turn, so a page that redraws on a later frame is judged by what it draws at that turn. The maps are generated from hidden seeds (hidden.ts), so the prompt carries no map data. Not verified: visual quality, the built-in demo on load, the #run button, the #algo select, the #diagonals checkbox, the Play animation, narrow or mobile layouts, status wording beyond the words "no path", or the internal structure of the solvers (only their outcomes and expansion orders are measured). Cell geometry is read from getBoundingClientRect: sizes and alignment within 1 px, and the window bounds exactly (0.01 px of floating-point slack). A cell is drawn only when checkVisibility passes and elementFromPoint at its centre finds the cell, so covered, clipped or hidden grids fail. Known limit (suite review): the demo button, #run, #algo, #diagonals and Play are not checked.',
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: [
    'path-grid-render',
    'path-dijkstra',
    'path-astar-optimal',
    'path-astar-expansion',
    'path-bfs',
    'path-no-path-trivial',
    'path-diagonal-rules',
    'path-visual-sync',
    'path-edit-resolve',
    'path-stats-dom',
  ],
  sandboxConstraints: SANDBOX_CONTRACT,
}
