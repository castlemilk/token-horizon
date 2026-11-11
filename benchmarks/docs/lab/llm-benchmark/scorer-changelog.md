# Scorer changelog

This file records changes to how a benchmark record is scored. Each record
carries the version of the scoring contract it was produced under in
`scorerVersion`. A record without the field is version 1.

**Smoke tier.** A smoke task is one whose checks test only that a page renders,
animates or reacts once. Its outcome is a wiring and sanity check, not a ranking
measure. The seven smoke tasks are `n-body-field`, `mini-platformer`,
`crypto-hash-race`, `landing-page-morph`, `equation-solver`,
`physics-pendulum-wave` and `circuit-builder-teaser`; the `claude-smoke` sweep
profile runs them. Use their outcomes to see that a page renders and responds,
and not to rank models against each other. The headline tasks are the ranked
ones.

## Version 2 (2026-11-10)

Version 2 is these changes and no others. The version number stays 2 through the
review round that finished on this date. Records stamped version 2 before the
scoring-process rules below (the semaphore, the probe, the rescore events) carry
no `scoringRescores` and no scoring events, and were scored without those rules.

- **Declared checks.** Each behavioural check declares its name and point budget
  (`defineCheck`). A check that throws, times out or is skipped keeps its points in
  the denominator with zero points, so it scores as a clean failure of the same
  budget. A returned row that disagrees with its declaration is recorded as a
  failure, and points are clamped to the budget. A plugin check that is not built
  with `defineCheck` is refused at registration (`check-undeclared`).
- **No structure-only score from a failed browser.** A browser-scored artifact the
  browser could not run leaves a visible `behavioural-run` fallback row. Whether
  the browser died is read from the Playwright `Browser` object (`isConnected()`
  and its `disconnected` event), never from error text. A page that closes itself,
  navigates away, or throws an error that mentions a closed browser is the
  artifact's behaviour: its checks are scored as failed rows. On the `chromium`
  backend, a real disconnect discards the browser and rescores the artifact once
  on a fresh browser. If the second attempt also falls back, the sweep stops with a
  non-zero exit and writes no record for that model and task. `verify-results`
  fails a version-2 record of a browser-scored task that carries a fallback row,
  or no breakdown (or an empty one) for an iteration it scored. A task with no
  checks defined also leaves a fallback row, but that is a configuration fact, not
  a browser failure, so it is not retried.
- **A check that could not finish is rescored once.** A check row that says the
  check did not finish in time is rescored once on a fresh page, after a 2-second
  wait, and never for an ordinary failed check. The rows that count are the
  sandbox's per-check timer and batch skip (`check timeout after Nms`,
  `skipped: batch timeout`); the horizon kit's `<action> timed out after N ms`
  rows, its check deadline and page-budget rows, and the page-unresponsive rows
  that follow a poisoned page; a check that stopped at its own deadline; and a
  Playwright `TimeoutError` or `Timeout Nms exceeded` a check returned as its
  detail. A fallback row and a zero-budget row (such as `no-runtime-errors`) never
  count. Both attempts are written to the run log as a `rescore` event with its
  reason, and the number of rescores is the record's `telemetry.scoringRescores`.
  A rescore that also times out is treated as a busy machine, not the artifact's
  result: the browser is discarded, the sweep waits 15 seconds and probes the
  machine, and the artifact is rescored once more. A timeout that survives that
  stops the sweep with no record for the pair (`BrowserFallbackError`), so a 30
  from a busy machine is not published. `verify-results` warns on a stored
  version-2 record that still carries a timeout row, for records written before
  this rule.
- **Artifacts are scored one at a time, by default.** A process-wide scoring
  semaphore lets at most `BENCH_SCORE_CONCURRENCY` artifacts (default 1) be
  rendered in the browser at once, across every (model, task) pair. A pair's
  iterations are scored one after another. Generation is not limited. The time a
  scoring call spent queued is written to the run log as a `scoringWait` event.
- **Known-good probe.** On the `chromium` backend, a built-in animated WebGL page
  (`scorers/browser-probe.ts`), scored with the artifact budgets, runs before a
  pair's artifacts render, again after them when a check failed, and before the
  third attempt of an artifact whose rescore also timed out. A probe that
  fails discards the browser, waits 15, 45 and then 90 seconds, and tries again.
  After the last retry the sweep stops and writes no record. A probe that cannot
  launch a browser at all stops the sweep at once. Each probe is a `scoringProbe`
  event. The probe covers a machine that cannot keep time between its probes; it
  does not re-score an artifact that failed a clean check while the machine was
  busy, and a run on a busy machine should still be rescored (see the parity note
  below).
- **Structural rule reads markup only.** The doubled-bracket rule (`<<` or `>>`)
  reads the markup of the page. The contents of `<script>` and `<style>` elements,
  and comments, are not read, so a bit shift in a script (`a << 2`, `x >> 1`,
  `y >>> 0`) loses no points. A stray pair in the markup still loses the 15
  cleanliness points. The composite is `0.7 x behavioural + 0.3 x structural`, so a
  record gains at most 0.3 of the structural points it regains.
- **`scoreAllTrials`.** A record's `scoreAllTrials` is the sum of every requested
  iteration's score, divided by the requested count, rounded to one decimal. An
  iteration that produced no artifact counts as zero, and there is no floor of 1.
  `score` is unchanged: it is still the mean over the successful iterations. A
  record whose run stopped early (a budget or quota stop) is divided by the
  requested count, so it must not be ranked on `scoreAllTrials`.
- **Every new record is stamped `scorerVersion: 2`.** The sweep stamps it, and so
  does `rescore-cli-pair.mjs` on the records it writes.

**Not in version 2: a new pixel measure.** The canvas measures are the byte-level
proxies of version 1 (`pixelDiffScore` and `canvasContentScore` over the PNG file,
with their original thresholds). The canvas is captured with an element
screenshot, as version 1 records dated 2026-09-22 and later have been (the capture is
in commit `30f76c4`, dated 2026-10-16).
A decoded-pixel measure and a canvas-only capture were evaluated on 2026-11-10 and
were not adopted. See `scorer-v2-impact.md`. `scorers/pixels.ts` remains as a
tested utility that no legacy check uses.

### What is comparable between version 1 and version 2

The parity run (`scripts/rescore-parity.mjs`) scored the 174 stored, live,
browser-scored HTML records of the nine behavioural tasks with today's scorer, and
compared each check's pass or fail with the stored iteration that produced the
published artifact. Every difference is given a cause the script measured: the
artifact was scored again under each regime below, and the cause is the regime
that reproduces the stored outcome. When both regimes reproduce it, the cause is
the landing check alone, because the two regimes share that check and differ only
in the capture.

**Version 1 regimes, by date.** The stored readings differ with the capture and
the landing check that produced them.

1. `canvas.toDataURL` capture, with the landing check that read the canvas only
   (before 2026-10-19 in the source repository). Records dated up to and including
   2026-08-26.
2. Element screenshot capture (from 2026-09-22 on), with the same landing check.
3. Element screenshot capture, with the current landing check (from 2026-10-19 in
   the source code). The landing check's stored detail text changes with it: the
   first records with the current detail text are dated 2026-10-24.

No legacy record is dated between 2026-08-27 and 2026-09-21. The capture change is
dated by the records, not by the commit that carries it: commit `30f76c4` is a
checkpoint dated 2026-10-16 that includes the element capture, and the first
element-capture records are dated 2026-09-22.

So the parity figures rest on two stored-reading facts: stored records from before
2026-09-22 were scored with the `canvas.toDataURL` capture, and landing records from
before 2026-10-19 with the earlier landing check.

**Result (last measured run).** 144 of 174 records have identical check outcomes
(83%). The 30 that differ:

- **19 canvas records** (all dated 2026-07-03 to 2026-08-26). Their stored readings
  came from `canvas.toDataURL`, and they reproduce under that capture. Under the
  element screenshot, 16 of them change from fail to pass and 3 from pass to fail.
  The 3 that change from pass to fail are `nemotron-3-nano-omni`
  `pendulum-renders` (stored pass at 36%, now fail at 9%), `qwen3-8b-ollama`
  `pendulum-renders` (stored pass at 35%, now fail at 14%) and `gpt-oss-120b-agy`
  `mini-platformer` (stored pass at 95.7% and 95.3%, now fail at 0.0% and 0.2%).
  The 16 that change from fail to pass include `nbody-animates` 0.0% stored, 91% to
  99% now, and `pendulum-renders` 3% stored, 22% and 34% now on two records.
- **9 landing records** (8 dated 2026-08-07 or earlier, 1 dated 2026-09-22). They
  reproduce under regime 1's landing check, under both captures, so the cause is the
  landing check alone. Under the current check they pass on motion declared on real
  elements.
- **2 records with a stored breakdown that cannot be compared by name**, labelled by
  the script as `stored-structure-only-fallback` and `stored-breakdown-unnamed`:
  - `car-racer` (2026-10-24, `kimi-k3.1-pro`) stores an empty breakdown and a score
    of 90. Under version 2 its four checks would pass and it would score 100. The
    90 is a structure-only score that was never tested in a browser. **It is flagged
    for a rescore, and was not rescored here.**
  - `voxel-lighthouse` (2026-10-24, `flint-40b-a2b-q8-llamacpp`) stores three
    timed-out rows with no names. Version 1 named a failed row after its check
    function, and those functions are anonymous.
  Neither has a `scorerVersion`, so the version 2 verifier rule does not reach them.
  Their differences are facts about the stored record, not about either regime.

**Comparability, by version 1 regime.** Of the 156 stored records of the five legacy
tasks, 134 are dated up to 2026-08-26 and 22 from 2026-09-22 on. All 134 earlier
records were measured with `canvas.toDataURL`.

- For the 22 records from 2026-09-22 on, a version 2 check outcome matches the
  stored one for 21. The one that differs is the 2026-09-22 landing record, whose
  landing check changed on 2026-10-19. These 22 are comparable with version 2.
- For the 134 earlier records, a version 2 check outcome matches the stored one for
  107. The 27 that differ are the 19 canvas records and 8 landing records above.
  These are not comparable with version 2 on the checks that differ.
- The other four browser-scored tasks match in 16 of 18 records (`tic-tac-toe` 7 of
  7, `gateway-console` 5 of 5, `voxel-lighthouse` 2 of 3, `car-racer` 2 of 3). The two
  that differ are the two stored-breakdown records listed above.

**A known consequence of the element capture.** It reads the page's region, not
the canvas alone. Five stored artifacts that the `canvas.toDataURL` reading scores
as blank or near blank now pass the `renders` check: two pendulum records (3% stored,
34% and 22% now) and three `n-body-field` records (0.0% stored, 21% to 24% now).
Four circuit artifacts whose canvas does not change under `toDataURL` now pass
`circuit-interact` at 13% to 99%. The `canvas.toDataURL` capture reads a WebGL canvas
as blank, so neither capture is right for every artifact. This is a measurement
limit of version 2, not a fixed defect.

**Structural points.** 10 of the 174 compared artifacts gain 110 structural points
under the markup-only rule (10 of the 188 live HTML records overall). The composite
moves by 0.3 of that.

**What this means for the board.** Version 1 and version 2 records are comparable
for check outcomes on the records listed above, not on the 134 earlier legacy
records. The report does not yet split rankings by `scorerVersion`, so version 1 and
version 2 scores should not be ranked together on the same board until it does.
Which capture the legacy tasks use from now on is a decision for the maintainer: the
element capture is the one the sweep uses today.

## Version 1 (before 2026-11-10)

Version 1 is every record scored before 2026-11-10. These records have no
`scorerVersion` and no `scoreAllTrials`. They were scored under the earlier check
and comparison rules, and they are kept as they are. The verifier skips the
all-trials invariant and the browser-breakdown rule for them.

## Run script, billing and harness changes (2026-11-10)

These changes are in `scripts/run-benchmark.mjs`, `runners/` and `scorers/`. They
apply to every new record, whatever its scorer version.

- **Browser preflight.** When a selected task is scored in the browser and the
  sandbox backend is `chromium`, the run launches the browser once before any model
  is called. If the launch fails, the run exits with a non-zero code, names
  `PLAYWRIGHT_BROWSERS_PATH` and prints the install command. Before this change, a
  missing browser silently produced structure-only scores. `--dump-config` and
  `--list-profiles` do not run the preflight.
- **Browser fallback stops the sweep** (version 2 rule above). The stop is a
  `BrowserFallbackError`, which the job pool rethrows after the jobs already
  running have finished and recorded their results.
- **Per-model cap stops every running pair.** When a model's spend reaches its
  cap, every pair of that model still running stops at its own iteration boundary,
  not only the pair that crossed the cap. A pair that starts an iteration after the
  cap is reached stops there too. One budget event is written per model.
- **A budget stamp is written only where the pair paid.** A pair stopped by another
  pair's trip, with nothing billed of its own, carries no `budgetExceeded` stamp.
  The verifier rejects a trip on a record that spent nothing.
- **A resumed sweep carries its spend.** A `--resume` seeds each model's cap with
  the cost of that model's completed pairs (the sum of their record costs), and
  prints the carried figure. A pair of a model already at its cap is not run. The
  pairs that run again are not counted: their earlier spend sits in an incomplete
  log, and a rerun may replay it from the cache.
- **Billed retries are part of the record.** A billed attempt that is retried
  (a transient failure, or an empty body) is priced into its iteration's
  tokens and cost, marked with its own provenance. A record's `costUsd` equals
  what the per-model budget counted.
- **A cache replay keeps the original call's cost.** A replayed response is priced
  at the tokens and usage source of the call that produced it, so the record's
  tokens, usage source and cost are that artifact's production cost. Telemetry
  marks the iteration as a cache hit (`cacheHits`) and carries no timing for it
  (`meanTtftMs` and the tokens-per-second figures exclude it). The record's
  `runtimeMs` is still the mean over successful iterations, and a replay contributes
  the original call's runtime there, as it did before this round.
- **Cut-off estimate has a time floor.** A stream cut off at the runner's cap after
  its first content block is billed for `min(max_tokens, max(reported so far,
  visible characters / 3, seconds since the first content block x 150))`, marked
  `estimated`. A call cut off before any content block is a transient timeout, but
  the input tokens the provider had read at `message_start` are billed.
- **The runner's clock decides.** The outer clock around an Anthropic call sits
  5 seconds above the runner's own cap, so the runner stops the stream and bills
  what it generated.
- **Retry-after.** A 429 or 529 response's `retry-after` is honoured: the retry
  waits at least that long, capped at 180 seconds.
- **Key file.** A quoted key must be followed by nothing but whitespace or a
  ` #` comment; anything else refuses the value rather than cutting it. A key
  that still carries quote characters at either end is refused. An environment
  key that cannot be sent in an HTTP header stops the run with a fatal message
  that names `ANTHROPIC_API_KEY`, and the key file is not used in its place. The key
  is never printed.
- **Browser close.** Closing the shared browser claims the handle first, so a
  browser launched while a close is in flight is still closed later. One relaunch
  is logged as `[harness] browser discarded and relaunched for <task>`.
- **Browser preflight and dependency inlining** are unchanged.
