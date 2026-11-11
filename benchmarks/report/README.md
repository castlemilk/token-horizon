# Benchmark report

A static, local page over the benchmark results. It shows what each model built
for each task, how the built artifacts scored against deterministic checks, and
what each attempt cost, how reliable it was and how fast it was.

## Status

- **Local and not published.** The report is generated on a maintainer's machine
  from `lib/lab/llm-benchmark/results.json`. It is not deployed. Nothing under
  `docs/` is written by this report, and `docs/` is the directory the workflow
  publishes, so the output must never be placed there.
- **Maintainer-run data.** The runs are made by the maintainers on their own
  machines and paid for by them. The page says so.
- **No network and no paid calls.** The build reads files. The capture step
  renders stored artifacts in headless Chromium, which cannot reach the network:
  every connection goes to a proxy that is not listening, and WebRTC may send no
  UDP outside it. `report/capture-isolation-test.mjs` checks this with a hostile
  artifact.
- **The page never runs model-written HTML.** Each gallery item shows two stored
  captures, the check results, and the cost, tokens and time. Nothing is loaded
  into a frame. To run an artifact again, use the command the dialog gives, which
  scores it inside the harness's sandbox.

## Commands

Run these from the `benchmarks` directory. Each one is independent; they are
listed in the order they are normally run.

1. **Capture the artifacts.** `npx tsx report/capture.mjs`

   By default it captures every scorer-version-2 cell of a browser-scored task, whatever
   its model, as well as the model selection in the script header. `--models` turns the
   wider set off. For each cell (model and browser-scored task) it renders the stored output in
   headless Chromium with the network blocked (`report/capture-browser.mjs`), and
   writes two images:
   capture 1 at a 1024 by 720 viewport and capture 2 at a 390 by 844 viewport.
   Each capture is taken after the task's showcase pose (`pose.ts` under
   `plugins/horizon-suite/tasks/<id>/`) when the task has one, so every model's
   artifact for that task is shown in the same state. A task without a pose is
   captured in the state the artifact reaches on load. Each capture's caption
   gives its viewport and its time after load. A capture is attached to a record
   only when its output hash matches the record's output; a re-run record shows
   "capture out of date" until the capture is taken again. Unchanged cells are
   skipped; `--force` captures them again. Options are listed in the script header.

1a. **Check the capture browser cannot reach the network.** `npx tsx report/capture-isolation-test.mjs`

   Loads a hostile artifact (`report/fixtures/hostile/capture-probe.html`: prefetch,
   speculation rules, image, fetch, XHR, EventSource, WebSocket, beacon, iframe and
   WebRTC STUN) with no request interception, in the capture's own browser settings,
   and checks that no listener on 127.0.0.1 is reached. A plain browser runs the same
   probe as a negative control and must reach the listeners.

2. **Build the data.** `npx tsx report/build-data.mjs [--now <iso-time>]`

   Writes `dist/data/board.js` and `board.json` from `results.json`, the registry,
   and `data/signals.json` (the capture measurements). `--now` fixes the
   generation time so repeated builds are byte-identical.

3. **Build the page.** `npx tsx report/build.mjs [--no-data]`

   Runs step 2 (unless `--no-data`), copies the page, its styles, the fonts and
   the colour tokens into `dist/`, and removes any bundle left by an earlier
   design (`dist/artifacts`, `dist/frame.js`).

4. **Check the render.** `npx tsx report/shoot.mjs`

   Renders the real board (the headline and horizon scopes, then earlier runs) and the
   synthetic board in every scope, at 1440 light and dark and 390, and saves screenshots to
   `$REPORT_SHOTS_DIR` (default: a folder under the system temp directory). It
   checks the page: no console errors, no request off the page, no sideways scroll,
   every section present, one tab stop per chart, no clipped or overlapping chart
   text, no label across a whisker, every frontier member and base model named
   beside its dot from 900 px (every frontier member listed by name below the chart
   under it), every label's nearest dot its own, no number, date or range broken across lines (page
   text, header and dialog), the scroll hint only for an overflowing table, the cost
   definition quoted where cost is shown, and the gallery dialog's captures and
   command line. The synthetic board is drawn with labelled placeholder images.

5. **Check the built report holds no artifact.** `npx tsx report/dist-check.mjs`

   Fails if `dist/` contains `iframe` or `srcdoc` in its HTML or JavaScript, any
   text from three stored outputs (three distinctive lines, each from a different
   task, taken from live records whose capture is on the board), or a
   `dist/artifacts` folder or `frame.js`. Its search is self-tested: a line written
   into a temporary copy of `dist` must be found.

6. **Serve it.** `node report/serve.mjs 8787` serves `dist/` on 127.0.0.1 with a
   Content-Security-Policy. `REPORT_URL=http://127.0.0.1:8787/ npx tsx report/shoot.mjs`
   checks the page as served.

Run the report's unit tests with `npx vitest run lib/lab/report`.

## Where output goes

| Path | Written by | What it is |
| --- | --- | --- |
| `report/dist/index.html`, `report.css`, `report.js`, `tokens.css`, `fonts/` | build | the page, its styles, fonts and colours |
| `report/dist/data/board.js`, `board.json` | build-data | the data the page reads |
| `report/dist/gallery/<task>/<model>-a.jpg`, `-b.jpg` | capture | the desktop and phone captures of each cell |
| `report/data/signals.json` | capture | per-cell measurements and the capture notes (viewport, time after load, pose applied) |

`report/dist/` and `report/data/signals.json` are gitignored: they are generated.

## Data rules

- **Scorer versions are never mixed.** Headline, horizon and smoke use only records scored
  by scorer version 2 or later. **Horizon tasks** is the horizon suite on its own, a part of
  the headline scope. The last scope, **Earlier runs (scorer v1)**, shows the version 1
  records, labelled as not comparable.
- **Reasoning effort.** For each base model with two or more effort levels in view, the
  levels are compared only over the tasks every one of them ran in the scope. `board.effort`
  holds the comparison (score, cost per attempt and median seconds per iteration over those
  tasks, with the task list), and the findings use the same comparison over the levels that
  cover at least 80% of the scope's tasks. A scope with no data
  shows an empty state that names the scopes that have data.
- **Cost per attempt.** For each cell: the billed cost divided by the iterations
  requested, failed iterations included in the division. A model's cost per
  attempt is the mean over its cells in scope. A cell in which every iteration
  failed has no cost per attempt. A model with no per-token price has none. The
  board carries this definition (`board.definitions.costPerAttempt`), and the
  page quotes it wherever cost is shown.
- **Price under review.** A positive registry price under one cent per million
  tokens is not plotted and has no cost. The price field is per 1k tokens as
  entered; a per-1k value entered in a per-token field is what this catches.
- **Coverage.** A model covers a scope when it has results for at least 80% of the
  scope's tasks. Only covering models are ranked above the rest in the heat map,
  and only they are named in findings or placed on the frontier.
- **Findings.** `board.insights[scope][group]` holds the findings for each scope
  and model group. A finding's figure and unit are set from the data, not read
  from its sentence. Its sample clause counts exactly the iterations behind the
  number. For the check finding that is the completed iterations of the cells
  that carry the check, and of those, the iterations in which its row was
  recorded.
- **Columns.** A task with no record for any model in view is hidden from the
  heat map and the checks matrix, and a line names it.
- **Reliability.** A failed iteration is a cross with a count; a completed
  iteration with no per-iteration score is counted, not plotted.
- **Synthetic boards.** `source.synthetic` is true only for a board built by
  `fixtures/synthetic-board.mjs`. The page then shows a banner. Such a board is
  never a result and must never be published as one.

## Fixtures

- `fixtures/synthetic-board.mjs` builds a board through the real `buildBoard`
  from the real registry, with invented results. It has three Claude tiers
  (Opus, Sonnet, Haiku), each at three effort levels, on every task, scored by
  scorer version 2, with cost and time that rise with effort and a few partial
  cells; a priced non-Claude model on every task; two earlier Claude models scored
  by version 1 on the eleven tasks that have version 1 records, so the earlier-runs
  scope has its own task set; a model whose every iteration failed; a free route
  with no per-token price; a model with low coverage; a model whose price is under
  review; and captures for the headline cells, with one model without captures and
  one capture taken from an earlier output. The board carries a synthetic-data
  banner. `npx tsx report/fixtures/synthetic-board.mjs` prints a summary.

## Adding a chart

1. Add a `<section id="…">` in `template/index.html` with a `p.what` line that says
   what the chart measures, a `p.scope-line` with `data-scope-line="<id>"`, and an
   empty `div` with `id="body-<id>"`.
2. Add a `render<Name>()` function in `template/report.js`. It should call
   `rowsFor(state.scope, state.models)` (or `headlineRows`) for the rows in view,
   call `scopeLine('<id>', count)` so the scope line stays current, and call
   `emptyNote` when there are no rows, so the empty state names the scopes with data.
3. Draw with `svgRoot` and `svgNode`, and make the chart one tab stop with
   `rovingMarks`. Give each mark an `aria-label`, and a tooltip with `bindTip`.
4. Add the id to `SPEC_SECTIONS` in `report/shoot.mjs`, so the render check
   requires it. Run `npx tsx report/shoot.mjs` and look at the 1440 and 390
   screenshots, on the synthetic board and on the real one.

## Tests

- `lib/lab/report/board.test.ts` and `board-review.test.ts`: the data layer. The
  fixtures are scorer version 2 unless a test says otherwise.
- `lib/lab/report/template-safety.test.ts`: the page source, and the capture
  browser's settings. It fails if the page adds a frame, a sandbox, a run control,
  an artifact loader, a network request from the page, or any way to write markup
  or run strings as code; and if the capture browser loses its dead proxy, its
  WebRTC policy or its sandbox, or regains web-security bypass.
- `report/capture-isolation-test.mjs`: the capture browser reaches no listener,
  and a plain browser does (the negative control), in a real browser.
- `lib/lab/report/board-effort.test.ts`: the effort comparison over shared tasks, and the
  horizon scope.
- `lib/lab/report/artifact-js.test.ts`: the file-name helper used by the capture.
- `report/dist-check.mjs`: the built output holds no frame and no stored artifact
  text, and its search can find a line (self-test).
- `report/shoot.mjs`: the rendered page, in a browser.
