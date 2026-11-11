# Horizon Suite

Seven harder tasks for the benchmark harness, each graded by deterministic checks in
headless Chromium. Every task is one prompt; the model returns one self-contained HTML
artifact; the harness runs the checks against it.

## Why it exists

The older browser tasks mostly check that a page renders, has the right controls or
animates. Strong models all clear those checks and score near the maximum, so the
scores stop separating models. The Horizon tasks ask for behaviour that can be measured
exactly: a numerical integrator that conserves energy to a stated order, a shortest-path
search whose expansion order is bounded, a circuit whose Bode and step response match
closed forms, drawn geometry that matches its own readouts, calendar arithmetic checked
at the pixel level, a keyboard-only board with exact undo, and a price calculator that
must round to the cent. Each check compares the artifact with an independent
computation, a reading of what is drawn, or a reference model. Hidden inputs stop a
page from hard-coding the answers.

## The seven tasks

| Task id | Category | Checks | What it asks for |
| --- | --- | --- | --- |
| `orbit-lab` | advanced-physics | 11 | N-body simulator on canvas: integrator order, symplectic and reversible behaviour, momentum, softening, diagnostics, HUD, camera and trails. |
| `pathfinding-lab` | advanced-game-building | 10 | BFS, Dijkstra and A* on hidden weighted grids: re-costed paths, expansion-order bounds, drawn state and one pointer click. |
| `rlc-response-lab` | advanced-electronics | 10 | Series RLC with Bode and step plots, checked against closed forms at hidden component values. |
| `bicycle-blueprint` | advanced-physics | 12 | Parametric bicycle side elevation in SVG: wheels, frame, drivetrain, tangent chain, spokes and readouts, checked against drawn geometry. |
| `sector-clock` | ui-building | 13 | Analog clock with a 24-hour sub-dial, readouts and sector band, checked at the pixel level against integer calendar arithmetic and a second time zone. |
| `kanban-keyboard-undo` | ui-building | 10 | Keyboard-only kanban board with exact undo and redo, a WIP limit, safe rendering and recovery from corrupt storage. |
| `seat-pricing` | ui-building | 10 | Seat calculator with graduated tiers, exact half-up cent rounding, promo rules, accessible names, contrast and responsive layout. |

Total: 76 checks. Each task's checks sum to 100 points.

## Conventions every check follows

- **Declared budgets.** Checks are built with `defineCheck(name, maxPoints, rationale, run)`
  from `lib/check.ts`. A check that throws, or misses its own 4.5 s deadline, fails and keeps
  its full `maxPoints`. The registry refuses a check without a name and budget, and refuses
  a key that differs from its declared name. A check never returns 0 points for a
  denominator it could not measure.
- **Page budget.** Once 20 s have passed on one page, later checks fail fast with their full
  budget, before the harness's own 25 s batch limit skips them. A deadline probes the page; a
  page that no longer answers is marked poisoned and every later check on it fails fast.
- **Source strings.** Code passed to `page.evaluate` is a plain-JavaScript source string,
  run through `probe(page, source, arg)` (`lib/probe.ts`). Strings avoid the `__name` helper
  that the tsx loader injects into named functions (postmortem 0008). Note that a source
  string given to `Locator.evaluate` is not invoked; use `probe` instead.
- **Existence first.** Every check tests for its hooks (`window.__bench` members or contract
  elements) with an in-page probe before any interaction, so a static or broken page fails in
  milliseconds. Playwright actions are capped at 1500 ms.
- **No clock dependence.** No check depends on wall-clock time, frame rate or the host's
  system clock. Time-zone checks pin the zone through CDP (`pinTimezone`, `altTimezonePage`),
  and calendar expectations come from integer arithmetic (`daysFromCivil`, `isoWeek`).
- **Settle only after real input.** `settle()` waits for two animation frames, with a 250 ms
  cap, and is used only after real keyboard or pointer input and viewport changes.
- **Motion off.** `freezeMotion()` stops CSS transitions and finishes the running animations
  before measuring pixels, so an entrance animation that fills forwards shows its end state;
  an infinite animation is held at its first frame. `finishAnimations()` completes what is left
  inside a try/catch.
- **Pixels.** Pixel checks use `samplePixels` and `sampleBlockMax` on screenshots, and
  `paintDiff` proves that a named element paints where its geometry says by hiding it and
  comparing. Colour distance is the largest per-channel difference (`chan`).
- **Independent references.** Expectations come from `reference.ts` (closed forms, Yoshida
  and RK4 integrators, an exact BigInt pricing reference, a kanban model) and never from the
  artifact's own readouts alone.
- **Errors are visible.** `errorWatch` collects page errors and console errors and scans
  `[role=alert]` for engine-error shapes.
- **Sandbox text.** Orbit-lab keeps the global sandbox constraint. The six DOM and SVG tasks
  set a hygiene-only `sandboxConstraints` (inline, plain JavaScript, storage may be
  unavailable, errors shown in a `role=alert` element, `html,body{margin:0}`).
- **Gallery poses.** `pose.ts` drives an artifact to a public showcase scenario for the
  gallery capture. Pose inputs are public and no check reads them.

## Hidden inputs

Every hidden constant lives in the task's `hidden.ts`, never in a prompt. Each file exports
`HIDDEN_VERSION` (for example `orbit-lab/v2`), which the run log records. The checks and the
fixtures import the same module, so they cannot drift apart. To rotate the inputs, change the
values and bump the version. Rotation matters if the repository becomes public.

## Running the tests

From `benchmarks/`:

```sh
# Plain unit tests (reference arithmetic, spec conformance, prompt rules). No browser.
npx vitest run lib/lab/llm-benchmark/plugins/horizon-suite

# Browser-gated tests, including the fixture matrix for each task.
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright-benchmarks" BENCH_BROWSER_TESTS=1 \
  npx vitest run lib/lab/llm-benchmark/plugins/horizon-suite
```

### The fixture matrix

Each task's `checks.test.ts` calls `fixtureMatrix` (`lib/fixture-matrix.ts`). It runs every
fixture through the real checks with the production budgets (6 s per check, 25 s per run)
and asserts one expectation per fixture:

- `'good'`: every check passes and the score is 100.
- `'static'`: nothing passes and the score is 0 over the full denominator.
- a list of check names: exactly those checks fail and every other check passes.

When the task passes `checksModule`, the good fixture is also scored through the tsx loader in a
child process, the path the sweep CLI takes. On failure the matrix prints one column per fixture, with `!` on every cell that
contradicts its expectation. Fixtures are mutations of the good artifact (`fixtures.ts`), and
the matrix proves that each check discriminates. Set `BENCH_MATRIX_OUT=<dir>` to save every task's matrix to `<dir>/<task>.txt`, pass or fail.

## Adding a task

1. Create `tasks/<id>/` with `task.ts` (export `task: BenchmarkTask`, with `checks` listing
   the names in order and `sandboxConstraints` set for DOM tasks), `checks.ts` (export a
   `checks` map built with `defineCheck`, whose points sum to 100), `fixtures.ts` (a good
   artifact, mutations and cheats, plus `expectations`), `pose.ts` (the public gallery
   scenario) and `hidden.ts` (with `HIDDEN_VERSION`) if the checks need hidden inputs.
2. Write `checks.test.ts` with a `fixtureMatrix` call that covers every check.
3. Import the task and its checks in `index.ts`, add them to the `TASKS` array, and add the
   check map to the `mergeChecks` call. Duplicate check names fail at module load.
4. Keep the prompt free of hidden values and of answers.

## Layout

- `index.ts`: the plugin (`horizonSuite`), registered from `plugins/index.ts`.
- `demo.tsx`, `manifest.json`: the demo note and the plugin manifest.
- `lib/`: shared helpers (`check.ts`, `probe.ts`, `load.ts`, `pixels.ts`, `keys.ts`,
  `sources.ts`, `math.ts`, `fixture-matrix.ts`).
- `tasks/<id>/`: one directory per task.

## Status of each task (2026-11-12)

Six tasks passed an adversarial review and ran in the first Claude sweep: `orbit-lab`,
`pathfinding-lab`, `rlc-response-lab`, `bicycle-blueprint`, `sector-clock` and
`kanban-keyboard-undo`.

`seat-pricing` is held back and is not in the Claude sweep profiles. Its arithmetic,
keyboard, naming, layout and geometry checks are ready. Its 8-point `pricing-contrast`
check measures paint (`tasks/seat-pricing/contrast.ts`):

1. A picture of the page as drawn (A), and one with every candidate's text made transparent (B).
   B holds the backdrop beneath each glyph.
2. Where a glyph may be covered or painted by something other than its colour (a box, an image or
   SVG over the text, an ancestor's pseudo-element, a background-clip glyph, a mask fade, an emoji),
   two more pictures (E and F) with the text forced to black and then to white. A pixel that differs
   between E and F is glyph ink whatever is over or behind it; an emoji keeps its own colour in both,
   so it is not ink.
3. Each candidate owns the pixels of its own text boxes (a control owns its content box, but a label
   laid over it wins). A line's ratio is the mean of the worst quartile of its core pixel ratios, and
   the candidate's ratio is the lowest of its lines' ratios.

### Round 4: the adversarial review (2026-11-12)

Every blocker and major has a fixture in `fixtures.ts` with its expectation, and the matrix proves
it. Every earlier fixture keeps its expectation.

Blockers:

- Text parked off screen (a skip link at `top:-40px`, a translated skip link, one at `left:-9999px`,
  a toast at `translateY(200%)`, an off-canvas drawer, a visually hidden helper). Text that lies wholly
  outside the viewport at its own stop, or that its clipping boxes cut to a sliver, is skipped and
  counted in `skipped`, not failed. Fixtures: `pricing-good-skip-link-top-offscreen`,
  `pricing-good-skip-link-translate-offscreen`, `pricing-good-skip-link-left-offscreen`,
  `pricing-good-toast-parked-offscreen`, `pricing-good-offcanvas-drawer`,
  `pricing-good-visually-hidden-helper`.
- Unreadable text over an `img`, an SVG, a canvas or plain boxes passes. Glyphs are now found by
  E and F, not only by A minus B, and a cover fails a candidate when at least 8 solid glyph pixels
  and 5% of its solid glyph pixels are hidden. A core pixel where A equals B counts as ratio 1, so
  the part that cannot be read is no longer discarded. Fixtures that now fail:
  `pricing-broken-split-band-divs-h1`, `pricing-broken-split-band-lede`,
  `pricing-broken-gradient-clip-fade`, `pricing-broken-mask-fade-blurb`,
  `pricing-broken-white-text-noise-canvas`, `pricing-broken-quartile-band-20pct`,
  `pricing-broken-half-covered-by-block`, `pricing-broken-lede-over-svg-blobs`,
  `pricing-broken-white-h1-over-photo`.
- A readable medium page with a grain overlay, and a very long page, were near the 4.5 s deadline. The
  E and F pair is taken only at stops where a candidate is covered or special, and a later state
  re-measures only the candidates whose fingerprint changed. Fixtures: `pricing-good-medium-page-grain-overlay`,
  `pricing-good-very-long-page`. At normal load they take 1.9 to 2.5 s (see the timing below).

Majors:

- Emoji on a light surface failed as low contrast, because its saturated pixels were read as the
  text colour. Emoji keep their colour in E and F, so they are not ink, and an emoji-only label is
  skipped. Fixtures that now pass: `pricing-good-emoji-light-theme-badges`,
  `pricing-good-emoji-own-span-white-pill`.
- Low-contrast text scrolled out of a scroll box or a carousel was skipped and never measured. Each
  clipped candidate is now skipped only at its own stop, so the other candidates keep their turn and
  get their own `scrollIntoView`. Fixtures that now fail: `pricing-broken-low-contrast-scroll-box`,
  `pricing-broken-low-contrast-carousel-slide`.
- A label laid over a filled input (a muted unit inside `#seats`, an optional hint inside `#promo`)
  failed as not painted. Fixtures that now pass: `pricing-good-seats-suffix-overlay`,
  `pricing-good-promo-input-suffix-overlay`.

Minors:

- Placeholder text is out of scope and is not measured. An empty input is not a candidate. The
  placeholder fixture (`review` page `FP11`) still passes, and so did the original module.
- Generated text in `::before` or `::after` is not a candidate. The generated-text fixture (`FP12`)
  still passes, and the original module passed it too. These are documented limits, not fixed.
- `task.ts` `methodNotes` now describes the paint method and its limits.
- The static fake scores 16 of 100, not 0: its names and contrast checks read a correct palette and
  layout, so they pass by design. `checks.test.ts` asserts this, and it is the one exception to the
  0-point convention for a static fixture.
- At very high natural load a good fixture can miss its deadline. The stated bound is a load of about
  40 on 18 cores; see below.

Timing (the check's own timer, 1-minute load about 22 to 25 on 18 cores): the good page 1.1 s, the
grain-overlay page 2.5 s, the very long page 1.9 s, the long body-glow page 2.3 s, the cookie-banner page
1.4 s. `checks.test.ts` bounds the good page and the heaviest fixture at 3 s, and the grain-overlay and
long pages at 3.5 s.

Load: the matrix passed 34 of 34 on a run whose 1-minute load started at about 38 and fell to about 10,
with no contrary cell in any of the 91 fixtures. It did not pass under sustained load. With deliberate
CPU burners the 1-minute load rose from 24 to 92 during one run, and that matrix failed one test with
nine contrary cells. Each loaded run's contrary `pricing-contrast` cell was a page already made
unresponsive by an earlier check (`pricing-discount-order` or `pricing-exact-rounding` timing out, outside
this audit), not a deadline in the audit itself. Under the ambient load spike of an unrelated period (1-minute
load about 354) three pages (the grain overlay, the long page and the cookie banner) did hit the 4.5 s
deadline inside the audit; each passes at normal load. So the matrix is not yet shown to pass at a sustained
load of about 40, and the limit at high load is set by the other checks on the page.

Known limits: a line with fewer than 8 full-strength pixels is measured only through its candidate's worst
quartile, not on its own. A cover fails a candidate only when at least 8 of its solid glyph pixels and 5%
of them are hidden; a smaller cover is not failed.
A text shadow never adds contrast to opaque text. Placeholder text and generated `::before` or `::after`
text are not measured.

The corpus of 282 unique pages from the review rounds was re-run on the final code. 279 agree with
their verdict (the two known limits above count as passes). Three pages (the grain-overlay, long and
cookie-banner pages) hit the deadline in the run's load spike and pass at normal load. The corpus
verdicts for the cheats, the busy-texture and fade pages, and the four-candidate `W2` and `W4` pages
(which fail the existing minimum-audited rule) match the paint values.

### Rounds 5 and 6: still held (2026-11-12)

Two more fix rounds followed, each reviewed against new hostile pages. Both reviews failed the check, so
`seat-pricing` stays out of the sweep profiles. The light-weight font fix, the background-clip wrapper fix and
the own-stop measurement are in the code. The last review left these open:

Blockers:

- **Sticky or fixed top bars (a regression from round 6).** A candidate's own stop scrolls its piece 8 px below
  the top of the viewport (`dy = target[1] - 8` in `STOP_SOURCE`), which puts it under any top bar, and only
  pieces measured away from their own stop are retried. Readable pages with a sticky nav, a sticky table header
  or a fixed announcement bar fail. The round-4 code passed them. The fix: keep the piece clear of fixed and sticky
  boxes at the top, or re-measure a failing own-stop piece at a centred stop.
- **Text that changes during the audit throws.** A 1-second countdown or a live clock below the fold changes its
  pieces between INIT and its stop, and `stop.items[first].pieces[target]` is undefined. The fix: never index a
  piece the stop did not return; re-resolve the candidate or settle it from the pieces that exist.
- **Light font weights over a layer.** The CSS-colour path only covers plain text. Light weights inside a gradient,
  glass, inset shadow or opacity wrapper are still diluted by antialiasing and read low. The fix: solve for coverage
  from the E and F pair (`alpha = (F - E) / 255`), or take the pictures at device scale 2.
- **Load.** The matrix failed in both loaded runs (load 65 to 156), and very long pages (40 to 60 table rows, 14 to
  20 FAQ items) missed the 4.5 s deadline at load 43 to 141. Most contrary cells come from `pricing-discount-order`
  and `pricing-exact-rounding` probe and navigation timeouts (2000 ms and `NAV_MS` 3000 ms), not from the audit.

Majors: scroll-snap pages skip candidates they cannot scroll to; a later state that dims text through an ancestor
is not re-measured; the animated-mask skip is too broad; aria-hidden separators outside the hard-coded list (`>`,
`›`, `»`, `→`) fail; one fixture overflows at 390 px, so the matrix is red at normal load.

The reviews' pages, logs and corpus results are in the session scratchpad, not in the repository. A pixel audit
keeps finding new page shapes it misreads. Before another round, decide whether `pricing-contrast` should stay a
scored paint check, become a computed-style check that skips any text whose backdrop it cannot determine, or be
reported without points.

## Before a paid run

The tasks need long answers (the design notes estimate 6.5k to 9k output tokens). Check the
model's output cap in `runners/` before a sweep, and install the Playwright Chromium build
that matches the installed Playwright. If the browser is missing, the behavioural scorer
falls back to the structural score, so a run without browsers is not a behavioural score.
