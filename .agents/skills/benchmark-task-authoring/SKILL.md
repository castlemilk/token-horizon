---
name: benchmark-task-authoring
description: >-
  Use when adding, changing or reviewing a benchmark task in the Token Horizon benchmarks package (benchmarks/), when writing or fixing a behavioural page check, when calibrating a task after a pilot, or when deciding whether a task separates strong models. Covers the Horizon suite kit (defineCheck, probe, hookPresent, freshLoad, pinTimezone, samplePixels, paintDiff, SVG_GEOM, fixtureMatrix), the contract-first prompt, fixtures, pilot calibration and plugin registration.
---

# Benchmark Task Authoring

This skill covers writing and changing tasks in `benchmarks/`, the benchmark package of Token Horizon. The reference is the Horizon suite, a plugin at `benchmarks/lib/lab/llm-benchmark/plugins/horizon-suite/`: shared kit in `lib/`, one directory per task in `tasks/<id>/`. Read `benchmarks/README.md` and the suite's `README.md` first. Sections 1 to 3 set the rules, 4 to 12 are the work, 13 lists known traps and scoring rules, 14 covers what the report shows readers, and the checklist closes the file. Run every command in this file from `benchmarks/`.

---

## 1. What a task measures

1. Each task is one prompt. The model returns one self-contained HTML document. The scorer loads it into headless Chromium as a top-level document in a fresh browser context (`scorers/sandbox.ts`), not in an iframe. The Horizon kit loads it on an opaque origin (`loadOpaque`) or a bench origin (`freshLoad`), aborts every request except the page's own root document (`lib/load.ts`), and then runs the task's checks. The prompt tells the model that it runs inside a `sandbox="allow-scripts"` iframe with no network access. No reader-facing page in this package renders artifacts (section 14).
2. A record's composite is `0.7 x behavioural + 0.3 x structural` (`docs/lab/llm-benchmark/scorer-changelog.md`). A well-formed page earns most structural points, so ranking comes from behavioural points.
3. Tiers. HEADLINE tasks are ranked: the four classic plugin tasks (`tic-tac-toe` in community-tasks, `gateway-console` in gateway-tasks, `voxel-lighthouse` and `car-racer` in visual-games) and the seven Horizon tasks (`orbit-lab`, `pathfinding-lab`, `rlc-response-lab`, `bicycle-blueprint`, `sector-clock`, `kanban-keyboard-undo`, `seat-pricing`). SMOKE tasks are the seven built-in tasks that have no plugin id (`n-body-field`, `mini-platformer`, `crypto-hash-race`, `landing-page-morph`, `equation-solver`, `physics-pendulum-wave`, `circuit-builder-teaser`). They are harness checks only and are never ranked. The tier comes from `suiteOf` in `lib/lab/report/board.ts`. A task meant for the board is a headline task.
4. Records carry `scorerVersion`. Version 1 is everything scored before 2026-11-10. Version 1 and version 2 records are never ranked together (section 9).

## 2. Is the task worth adding

A task earns its place only if it separates strong models. Strong models pass presence checks (the page draws, the buttons exist) and score near the maximum, so those checks say nothing about which model is better. A check that every configuration passes, or every configuration fails, carries no information.

Answer these in writing before any code:

- **What is measured?** The task must ask for behaviour that can be checked against an independent computation or a reading of what is drawn: an integrator that conserves energy to a stated order, a path search with a bounded expansion count, a response that matches a closed form, drawn geometry, exact cents.
- **Which skill does it cover that no other task covers?** Cross-cutting checks (responsive layout, contrast, persistence) should be assigned to one task only, so that one skill is not counted twice.
- **Does a strong model finish inside its output budget?** The Horizon design notes estimate 6.5k to 9k output tokens per answer (`horizon-suite/README.md`; an estimate, not a measurement). An answer near 10k tokens or more tends to measure truncation, not skill.
- **Is it bimodal?** A task whose first step is editing a long verbatim stub fails every check for a reason unrelated to the skill. Reject that design.
- **Does it need a fragile host feature?** Local Chromium time zones and fonts are acceptable only where the section 5.6 rules bound them.

Write down the expected spread of scores before the pilot. It stays a forecast until a pilot measures it.

## 3. Task directory

`tasks/<id>/` holds these files. `tasks/sector-clock/` is a complete example:

- `task.ts`: exports `task: BenchmarkTask` (`id`, `slug`, `category`, `title`, `blurb`, `prompt`, `runtimeHint`, `iterationsDefault`, `methodNotes`, `demoComponentName`, `scorer: 'behavioral'`, `checks` in order, `sandboxConstraints`).
- `hidden.ts`: every hidden constant, the tolerance table `TOL`, and `HIDDEN_VERSION`.
- `reference.ts` and `reference.test.ts`: independent arithmetic. `reference.test.ts` cross-checks it against Date UTC getters and the shared `math.ts` calendar.
- `checks.ts`: `CHECK_SPECS` (name and points, in order, summing to 100), the `checks` map, and `PROMPT_SHA256`.
- `fixtures.ts`: the good artifact, mutations, cheats, variants and `expectations`.
- `pose.ts`: the public gallery scenario.
- `checks.test.ts`: definition tests and one `fixtureMatrix` call.

Copy the shape of the directory, not the code.

## 4. The prompt: contract first

Write the contract before any check. A check may test only what the contract states. In order:

1. **Ids, classes and data attributes**, written exactly (`#dial`, `line.tick`, `data-*`). Checks locate elements by these and never guess markup.
2. **A `window.__bench` API**, with each function's name, arguments, synchronous behaviour and return value. sector-clock: `setInstant(utcMs, offsetMinutes)` and `setSector(startMinutes, endMinutes)` apply at once and return `true`; any argument that is not an integer in range returns `false` without changing the page.
3. **Numbers with ranges and precision**: "between 0.90R and 1.00R", "at least 1.5 times as long", "do not round to fewer than 2 decimal places".
4. **Public defaults only.** The on-load state may be stated (sector-clock states its default instant and sector, and the pose uses them). Hidden instants, answers and seeds never appear in the prompt.
5. **The sandbox contract.** DOM and SVG tasks set `sandboxConstraints` to the first eight non-empty lines of the global `SANDBOX_CONSTRAINTS` in `lib/lab/llm-benchmark/prompts.ts`, followed by a closing sentence, dropping the canvas and `requestAnimationFrame` guidance. sector-clock and pathfinding-lab do this. orbit-lab leaves the field unset. The applied contract is appended to the prompt by `withSandboxConstraints`, and the amended prompt is what the prompt bundle hash and the response cache key cover, so editing the contract re-pays a sweep.

Two rules hold for every prompt:

- Every constraint a check tests is stated, and every stated constraint is tested. Untested constraints are decoration. Tested but unstated constraints are a trap (`docs/lab/llm-benchmark/plugins-authoring.md`).
- Tests pin a hash of the prompt (`PROMPT_SHA256`) and assert that no hidden value appears in its text. Tests must not read files outside the package. `tasks/sector-clock/checks.test.ts` reads `lib/lab/llm-benchmark/prompts.ts` by absolute path on every run, and a scratchpad spec by absolute path when that file exists, so it fails on any other machine. Do not copy that pattern.

## 5. Check rules

5.1 **Declare every check** with `defineCheck(name, maxPoints, rationale, run)` from the kit's `lib/check.ts`. The rationale is required. The map key must equal the declared name. Points sum to 100 per task, and `structureProblems` in `lib/fixture-matrix.ts` fails the matrix otherwise. A run returns `boolean` or `{ passed, detail }`. A detail states the measured value and the bound, for example `energy drift 3.1e-5 > 2e-6`. Details are clipped at 240 characters.

5.2 **Budgets are kept on failure.** A throw, a missed deadline or a poisoned page scores the full budget as a failure. Never return zero points for something the check could not measure, because that shrinks the denominator. The budgets in force are 4.5 s per check (`CHECK_DEADLINE_MS`), 20 s per page before later checks fail fast (`PAGE_BUDGET_MS`), and the harness's 6 s per check and 25 s per run.

A check that times out is rescored once on a fresh page after 2 s (`scorers/browser-fallback.ts`). If that rescore also times out, the harness waits, probes a fresh browser, rescores once more, and then stops the sweep without writing a record for the pair. At most one artifact is scored in the browser at a time (`BENCH_SCORE_CONCURRENCY`, default 1). Browser death is read from the Browser object only, never from error text. A page that closes itself is scored as failed checks.

5.3 **Page code is a source string.** Run it with `probe(page, source, arg, timeoutMs)`, where `source` is a plain JavaScript string of the form `(...) => ...`. A function compiled by tsx can capture the `__name` helper, which does not exist in the page (`docs/postmortem/0008-browser-callback-loader.md`). A source string given to `Locator.evaluate` is never invoked, so use `probe`. Source strings written as template literals (`sources.ts` uses `String.raw`) contain no backtick and no `${`.

5.4 **Existence before interaction.** Call `hookPresent(page, '__bench.setInstant')` or a selector before any click, fill or focus, so a static page fails in milliseconds. Cap every Playwright action at 1500 ms.

5.5 **Measure, never trust.** A check must not believe what the page reports about itself.

- Hands are read as drawn line endpoints through `getScreenCTM` and compared with `reference.ts`. bicycle-blueprint uses the kit's `SVG_GEOM` (`lib/sources.ts`); sector-clock inlines the same reading. The readout text alone is not evidence.
- Sectors and shapes are judged from decoded screenshots (`samplePixels`), not from `isPointInFill`.
- "Drawn" is proved with `paintDiff`: it hides a named element and reports the largest per-channel change at each sample point. The change must reach the stated threshold.
- Set and read happen in one in-page turn (`SET_READ_SOURCE` in sector-clock). A page that draws after its hook returns is read before the draw and fails. The fixtures `clock-broken-deferred-timeout` and `clock-broken-deferred-microtask` prove this.

5.6 **No clock, frame-rate or host dependence.**

- Pin the zone with `pinTimezone` (CDP). Test a second zone with `altTimezonePage`. The sector-clock host check uses `Pacific/Chatham`.
- Expectations come from integer arithmetic (`daysFromCivil` and `isoWeekOf` in `reference.ts`; `isoWeek` in `lib/math.ts`), never from `Date` local getters.
- `freezeMotion` (bicycle-blueprint, pathfinding-lab, seat-pricing) or `finishAnimations` (sector-clock) runs before any measurement. `settle` (two frames, 250 ms cap) runs only after real input or a viewport change.
- Font metrics matter only where a text box is read. Then widen the band and say so in the rationale.

5.7 **Tolerances are derived and written down.** Each tolerance in `TOL` (in `hidden.ts`) has a rationale tied to the mathematics or the rendering precision. Write comparisons as `if (!(value <= bound))` so that NaN fails. Never loosen a tolerance to rescue a failing check. Fix the check, or find out whether the fixture or the prompt is wrong.

5.8 **Read only what you need.** Each check declares the elements it reads (the `CHECK_IDS` pattern), so a missing readout costs only the checks that read it. Errors are visible: `errorWatch` collects page and console errors and scans `[role=alert]` for engine-error shapes.

## 6. Hidden inputs

- Every hidden constant lives in `hidden.ts`. Checks and fixtures import the same module, so they cannot drift apart.
- `hidden.ts` exports `HIDDEN_VERSION` (for example `sector-clock/v1`). No harness file outside `tasks/*/` reads it, and the run log does not record it, although `horizon-suite/README.md` says it does. Do not rely on it being recorded.
- Rotate inputs by changing the values and bumping the version. That is a measurement change (section 9). Rotation matters once the repository is public.
- Choose cases that defeat hard-coding. The sector-clock cases cover a midnight crossing, the 1900 and 2100 calendar rules, pre-1970 and sub-second instants, and whole-minute offsets that are not whole hours.

## 7. Fixtures

Every task ships fixtures that prove its checks discriminate.

1. **A good artifact**, written as a careful expert would write it, scores 100. It is a `String.raw` template with no backtick and no `${`.
2. **Good variants** are valid artifacts that differ in style, layout, animation or method. They must score 100 too. A check that fails a valid variant is a check bug. sector-clock has four.
3. **One broken variant per check**, made by one small, documented mutation of the good source. Each mutation replaces a span that must occur exactly once (`replaceOnce` asserts the change). Name them `<prefix>-broken-<what>`, where the prefix is the task's short name (sector-clock uses `clock`). Each expectation names exactly the checks that must fail (usually one). sector-clock has 19.
4. **Every successful cheat becomes a fixture** named `<prefix>-cheat-<what>`: a page that draws the answer elsewhere, or paints a decoy. A cheat that earns points is a gap. Add the fixture, then fix the check. sector-clock has two cheats (`clock-cheat-ghost-paint`, `clock-cheat-sector-elsewhere`).
5. **A static fake** has hooks that return `true` and draw nothing. The matrix expects `'static'`, meaning zero points over the full denominator. A composite control that draws the default view and does nothing else earns points from the checks that read only that view, so give it an explicit list of expected failures instead. sector-clock's `clock-control-static-picture` expects every check to fail except `clock-structure` and `clock-ticks-numerals`, which the default view passes.
6. **`expectations`** has one entry per fixture: `'good'`, `'static'`, or the exact names of the failing checks. Every fixture needs an entry, and every name must be a real check. If the matrix shows extra failures, do not loosen the expectation. Work out which side is wrong.

The sector-clock `expectations` has 27 entries: the good artifact, four variants, 19 broken variants, two cheats (21 mutated entries in total) and one control.

## 8. Matrix and repeat runs

- `checks.test.ts` calls `fixtureMatrix({ taskId, checks, fixtures, expectations })` from `lib/fixture-matrix.ts`. Pass `checksModule` too where possible, so the good fixture also runs through the tsx loader, the path the sweep CLI takes. sector-clock does not pass it yet.
- Unit tests, no browser: `npx vitest run lib/lab/llm-benchmark/plugins/horizon-suite` from `benchmarks/`.
- Browser matrix: `PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright-benchmarks" BENCH_BROWSER_TESTS=1 npx vitest run lib/lab/llm-benchmark/plugins/horizon-suite`, from `benchmarks/`.
- Run the browser matrix three times in a row, then once more while the machine is under CPU load. A check that passes on one run and fails on another depends on timing. Fix the timing dependence in the check. Do not raise the budget.
- A matrix failure prints one column per fixture (F1 to Fn) and a `!` on each cell that contradicts its expectation. Read the `!` lines first.

## 9. Versioning

- A record must be reproducible from its version. Any change to what is measured counts: the prompt, the sandbox contract, `HIDDEN_VERSION`, a check's logic, a tolerance, or a point budget. After results exist, make a new version and do not rank it with the old one.
- `BenchmarkTask` has no version field at the time of writing (`lib/lab/llm-benchmark/types.ts`). Until one exists, give the changed task a new id and slug (for example `sector-clock-v2`) and bump `HIDDEN_VERSION`.
- Keep the old task registered while any record cites it: `registry.test.ts` requires every result to reference a registered task. Agree with the owner how it leaves the sweep profiles.
- Scorer changes are versioned separately. `scorerVersion` is 2 (`lib/lab/llm-benchmark/scorer-version.ts`, dated 2026-11-10) and is stamped on every record. Record each scorer change in `docs/lab/llm-benchmark/scorer-changelog.md`.
- Calibration before the first ranked sweep costs nothing. After it, a budget change is a new version.
- The response cache key is (model, task, amended prompt hash, iteration index, frame-prelude fingerprint), built by `buildCacheKey` in `lib/lab/llm-benchmark/cache.ts`. A check-only change leaves cached answers valid as rescoring input. Pass `BUST=1` only when fresh paid calls are wanted. It skips reading and writing the response cache: every call is paid and no answer is stored.

## 10. Registering the task

1. Create `tasks/<id>/` with the files in section 3.
2. In `index.ts`, import `task` and `checks`, add the task to the `TASKS` array, and add the check map to the `mergeChecks` call. A duplicate check name fails at module load.
3. The Horizon plugin is already rostered (`plugins/index.ts` calls `registerPlugin(horizonSuite)`), so a task inside it needs no roster change. A new plugin needs its own roster line (`plugins-authoring.md`).
4. The category must be a slug in `BENCHMARK_CATEGORIES` (`registry.ts`). Every task in an HTML-runnable category must declare `scorer: 'behavioral'` (`registry.test.ts`).
5. `demoComponentName` must be a key of the plugin's `demos` record. The Horizon plugin registers `demos: { HorizonSuiteDemo }` in `plugins/horizon-suite/index.ts`. This package has no `demo-registry.tsx`.
6. `manifest.json` is documentation only: no validator or loader reads it, and `scripts/plugin-scaffold.mjs` writes it. Keep it in step by hand.
7. Check files must not import `scorers/sandbox.ts` (it pulls Playwright into the client bundle) or `lib/fixture-matrix.ts` (test-only).
8. For a headline task, ask the owner to add its id to the `tasks` arrays of `claude-family` and `claude-effort` in `lib/lab/llm-benchmark/sweep-profiles.json`, and to update the task counts in those profiles' descriptions. The profiles list their tasks explicitly, so a new task does not run in them otherwise.

Tests that must pass before a paid run:

- `task bench:verify`: `tsc --noEmit` plus `vitest run lib/lab/llm-benchmark/`. This includes `registry.test.ts`, `layering.test.ts` and `validate-plugin.test.ts`.
- `task bench:plugin-validate -- horizon-suite`: exit 1 on errors, warnings never fail.
- The task's `checks.test.ts` in browser mode (section 8).
- `reference.test.ts`.
- New coverage in `plugins/registry.test.ts`, as `plugins-authoring.md` step 7 asks.

## 11. Review loop before any paid run

Paid runs cost real money, so review before the first one.

1. The author writes the good artifact, the variants, the broken variants and cheats, then the checks, and runs the matrix.
2. An adversarial reviewer receives the prompt and the public contract, not the values in `hidden.ts`. The reviewer tries two things:
   - to cheat: pass checks without doing the work (hard-coded readouts, static hooks, decoy drawing, reading the system clock, a transition that completes before the read);
   - to fail a conforming artifact: a valid draw that meets the stated precision but differs in colour, font, layout, rounding within precision, or animation.
3. Every cheat that scores becomes a fixture and a check fix. Every conforming failure is a check bug. If the prompt was ambiguous, change the prompt before any results exist, or version it after.
4. Pilot only after the matrix passes three runs and the reviewer finds nothing new.

## 12. Calibrating after a pilot

1. Print the effective config with no calls: `task bench:dump -- --model <id> --task <id>`.
2. Pilot with one iteration per configuration. Check that `pgrep -fl 'run-benchmark.mjs|sweep-recovery.mjs'` prints nothing, then run from `benchmarks/`: `mkdir -p tmp && RESULTS_OUT_PATH=tmp/pilot-<id>.json RUN_BUDGET_MAX_USD=<n> task bench:run MODELS=<a>,<b> TASKS=<id> ITER=1`. This spends money, so set a cap and scope it to the models and the task. The scratch file starts as a copy of the board, so read only the records whose `.runLogRef.runId` is this run's. The pilot never writes `results.json`, so its records cannot reach the ranked board.
3. Build the per-check table from `tmp/pilot-<id>.json`, one row per check and one column per configuration.
4. A check that every configuration passes, or every configuration fails, carries no information. Halve its points and move the freed points to the check in the same task whose pass rate is nearest 50 per cent. The task still sums to 100.
5. Re-run the fixture matrix. The budgets changed, so `structureProblems` must still pass.
6. Never loosen a tolerance to rescue a check. If strong models fail a check for a reason the prompt does not state, fix the prompt or the check and record why. Once results exist, a prompt change is a new version (section 9).
7. The full run follows the pilot. The response cache replays the iteration the pilot already paid for, so a three-iteration run after a one-iteration pilot pays only for iterations 2 and 3.

Sweep profiles live in `lib/lab/llm-benchmark/sweep-profiles.json`. List them with `npx tsx scripts/run-benchmark.mjs --list-profiles` from `benchmarks/`. The Claude profiles are `claude-family` (Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 on the 11 headline tasks, $45 cap per model), `claude-effort` (seven effort variants on the same 11 tasks, $30 cap per model) and `claude-smoke` (Haiku 5.5 on the seven smoke tasks, $2 cap, never ranked). Results are written incrementally to `lib/lab/llm-benchmark/results.json`, and per-pair run logs go under `sweeps/<run-id>/`. Run `task bench:verify-results` after a sweep and before publishing traces. The owner commits or backs up `results.json` first; the run tasks refuse to start while it is untracked.

## 13. Known traps and scoring rules

- **Denominator loss.** A thrown or timed-out check once recorded zero points, which shrank the denominator and let a broken page score higher. `defineCheck` now keeps the budget. Keep to that rule in every new check.
- **Bracket rule.** `<<` or `>>` in a script once cost structural points. Scorer version 2 reads markup only, not the contents of script and style elements or comments. Do not add a check that reads script text.
- **Output cap.** The Anthropic runner sets `max_tokens` from the model's `maxOutputTokens`, falling back to `DEFAULT_MAX_OUTPUT_TOKENS`, which is 128,000 tokens including reasoning (`runners/anthropic.ts:68`). The cap was 64,000 before 2026-11-10, and pairs that reached 64,000 were re-run. An answer that stops at its cap is a `truncated` failure. A refusal is a `model_error`. Both are billed and neither is retried, and a truncation or refusal does not end the pair: the remaining iterations still run (`isPerIterationOutcome`, `runners/provider.ts:253`).
- **Stale absolute paths** in `tasks/sector-clock/checks.test.ts` (section 4).
- **Pose.** No check reads `pose.ts` (its header says so). `report/capture.mjs` does: it loads `plugins/horizon-suite/tasks/<id>/pose.ts` and applies the pose after load, so each model's capture of a task shows the same state. A pose that throws is recorded and the capture still goes ahead.

## 14. The report and what readers see

- The report (`benchmarks/report/`, built by `report/build.mjs`) has four scopes: Headline, Horizon tasks, Smoke tier and Earlier runs (scorer v1). Headline, Horizon and Smoke hold only version 2 or later records. Earlier runs holds version 1 records, labelled as not comparable. Never rank across the two.
- The reader's browser never runs model-written HTML. Each gallery item shows two stored captures (1024 by 720 and 390 by 844), the check results, and the cost, tokens and time. Nothing is loaded into a frame. The command the gallery dialog gives re-scores the artifact inside the harness's sandbox. `report/dist-check.mjs` fails if the built output contains an `iframe` or `srcdoc`, or text from a stored artifact.
- The captures (`report/capture.mjs`, `report/capture-browser.mjs`) do run stored output, in headless Chromium with the network blocked. Every connection goes to a proxy that is not listening, WebRTC may send UDP only through that proxy (`disable_non_proxied_udp`), and every request is aborted at the route level except `about:blank` and `data:`. `report/capture-isolation-test.mjs` checks the first layer on its own.
- When describing the report, say that the reader's browser runs no model HTML. Do not say that the captures run no model code, and do not say that they have no network access without the proxy and route layers.

---

## Checklist

- [ ] The task is headline, or deliberately smoke, and its tier is stated.
- [ ] Each check measures behaviour with an independent computation or a reading of the drawn result.
- [ ] The prompt states every constraint a check tests, uses only public defaults, and has no hidden value.
- [ ] `sandboxConstraints` is set for DOM and SVG tasks, with the first eight contract lines and the closing sentence.
- [ ] Every check is built with `defineCheck`, has a rationale, and its name matches its key.
- [ ] Point budgets sum to 100 and match `CHECK_SPECS` in order.
- [ ] No check returns zero points for an unmeasured result.
- [ ] Page code is a source string, and no check calls an action before `hookPresent`.
- [ ] Time, frame rate and host zone are pinned or avoided, and expectations use integer arithmetic.
- [ ] Every tolerance has a written derivation and no tolerance was loosened to pass a check.
- [ ] `hidden.ts` holds every hidden value, with `HIDDEN_VERSION`, and no test reads files outside the package.
- [ ] One good artifact scores 100, with at least one valid variant.
- [ ] Each check has a broken fixture, and every successful cheat is a fixture.
- [ ] A static fake and any composite control are in `expectations`.
- [ ] `fixtureMatrix` passes three times, and once under CPU load.
- [ ] An adversarial review tried to cheat and to fail a conforming artifact, and its findings are fixed.
- [ ] `task bench:verify`, `task bench:plugin-validate -- horizon-suite` and the registry tests pass.
- [ ] The pilot has been calibrated: no check passes or fails in every configuration, and no tolerance was loosened.
- [ ] Any change after results exist has a new task id or version, and is not ranked with the old.
- [ ] `docs/lab/llm-benchmark/scorer-changelog.md` is updated if the scorer changed.
