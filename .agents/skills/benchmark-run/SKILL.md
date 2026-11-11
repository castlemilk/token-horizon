---
name: benchmark-run
description: Use when running, resuming, monitoring, verifying, rescoring or publishing a benchmark sweep in benchmarks/ (the @token-horizon/benchmarks harness). Covers the Claude profiles (claude-smoke, claude-family, claude-effort), cost estimates and per-model budget caps, ANTHROPIC_API_KEY_FILE, results.json and run-log verification, and rebuilding the local report (capture, build, shoot, serve). Not for adding tasks, plugins or scorer checks.
---

# Benchmark Run

This skill is the procedure for the LLM benchmark harness in `benchmarks/` (the `@token-horizon/benchmarks` package). `benchmarks/README.md` is the reference for the harness itself. This file gives the order of work, the cost and budget rules, and the checks that must pass before a number is published. Run commands from `benchmarks/` unless a step says otherwise. A step marked SPENDS MONEY makes paid API calls, and no such step runs without the owner's instruction for that sweep.

## 1. What the harness measures

- Each (model, task) pair runs N iterations. Each iteration is one prompt and one model output (an HTML artifact for the browser tasks), scored by deterministic checks. Behavioural checks drive the artifact in headless Chromium (Playwright 1.60.0). Structural and text checks need no browser.
- Each pair becomes one record in `lib/lab/llm-benchmark/results.json`: `score` (mean over the successful iterations), `scoreAllTrials` (sum over the requested iterations divided by the requested count, so a failed iteration counts as zero), `status`, `failureReason`, token counts, `costUsd`, timings, `scorerVersion`, and `runLogRef` (the per-iteration log under `sweeps/`).
- Not measured: subjective quality. No model judges another model, and `lib/lab/llm-benchmark/feedback.json` holds curator notes that never enter a record or a score. Routes without a per-token price (free, subscription, local) have no cost. CLI token counts are estimates when the CLI does not report them.

**Tiers.** The tier comes from the plugin that supplies a task (`suiteOf` in `lib/lab/report/board.ts`). A task with no `pluginId` is smoke. A plugin id starting with `horizon` is horizon. Any other plugin is classic. Headline means every non-smoke task.

- Headline, ranked (11): `tic-tac-toe`, `gateway-console`, `voxel-lighthouse`, `car-racer` (classic); `orbit-lab`, `pathfinding-lab`, `rlc-response-lab`, `bicycle-blueprint`, `sector-clock`, `kanban-keyboard-undo`, `seat-pricing` (horizon). `seat-pricing` is held back from the Claude profiles until its `pricing-contrast` check passes review (`plugins/horizon-suite/README.md`, "Status of each task"), so it has no records yet.
- Smoke, harness wiring only, never ranked (7): `n-body-field`, `mini-platformer`, `crypto-hash-race`, `landing-page-morph`, `equation-solver`, `physics-pendulum-wave`, `circuit-builder-teaser`.

**Scopes.** The board has four scopes: `headline`, `horizon` (the seven Horizon tasks, a subset of headline), `smoke`, and `earlier` (version 1 records). Headline, horizon and smoke use only version-2 records (`inScopeCell`, `board.ts`).

**Scorer versions.** A record without `scorerVersion` is version 1, scored before 2026-11-10. New records are version 2 (`SCORER_VERSION` in `lib/lab/llm-benchmark/scorer-version.ts`). Version 1 and version 2 are never ranked together. Seeded records (`source: 'seeded'`) are sample data, never measurements.

**Current state.** Counts change while a sweep appends. Count them with the commands in section 9 rather than trusting a figure written here.

## 2. Prerequisites

1. **Node and dependencies.** Node 20 or later (`engines` in `benchmarks/package.json`). From `benchmarks/` run `npm ci`, then `npm run typecheck` and `npm test`. None of these calls a model.
2. **Pinned Chromium.** Playwright 1.60.0 needs Chromium revision 1223, installed into `$HOME/Library/Caches/ms-playwright-benchmarks`, which the Taskfile and `npm run bench` set as `PLAYWRIGHT_BROWSERS_PATH`. Install once with `node node_modules/playwright/cli.js install chromium` under that variable (`task bench:browsers:install` does the same). Do not use `npx playwright install`, which can fetch a different revision. Check that it launches:

```sh
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright-benchmarks" node -e 'import("playwright").then(({chromium})=>chromium.launch({headless:true})).then(b=>b.close()).then(()=>console.log("chromium ok"),e=>{console.error(e.message.split("\n")[0]);process.exit(1)})'
```

3. **Keys.** Provider keys come from the environment: `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` and `ANTHROPIC_API_KEY`. For Anthropic, `ANTHROPIC_API_KEY_FILE` names a file that holds the key. Its location is the operator's personal configuration, which the operator supplies. Do not search for it, open it, print it or copy its contents. If `ANTHROPIC_API_KEY` is set, it wins and the file is not read. To check a file's shape without revealing anything, count lines only:

```sh
grep -c . "$ANTHROPIC_API_KEY_FILE"
grep -c '^[[:space:]]*\(export[[:space:]]\+\)\?ANTHROPIC_API_KEY=' "$ANTHROPIC_API_KEY_FILE"
```

A bare key file has one non-blank line and no name, so the second count is 0. `.env` is read only by `task` commands (`dotenv` in the Taskfile); `npm run bench` and `npx tsx` do not read it.

4. **Ambient Anthropic variables.** Remove them from every Claude sweep so each run sees the same environment. The runner passes its base URL explicitly and strips `ANTHROPIC_CUSTOM_HEADERS` and `ANTHROPIC_AUTH_TOKEN` while it builds its client (`SDK_ENV_TO_IGNORE`, `runners/anthropic.ts`), so this is hygiene rather than the only guard. Every Claude command below carries the prefix `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN`.
5. **Working directory.** `sweeps/`, `.cache/`, `results.json` and any `RESULTS_OUT_PATH` resolve against the current directory. Run from `benchmarks/`. From the repository root, a sweep writes to the wrong place and fails after its paid calls.
6. **Git state of results.** The `task` wrappers (`run`, `smoke`, `cli`, `profile`, `merge`, `seed`) refuse to start while `lib/lab/llm-benchmark/results.json` is untracked. `npm run bench` and `npx tsx` do not check. Before any live write, the owner should have the file committed or backed up. This skill never runs git.

## 3. Claude profiles and their cost

Profiles live in `lib/lab/llm-benchmark/sweep-profiles.json`. `--dump-config` is authoritative for what a profile will run. The values below match the file as of this edit.

| Profile | Models | Tasks | Iter | Conc | Per-call cap | Retries | Cap per model |
|---|---|---|---|---|---|---|---|
| `claude-smoke` | `claude-haiku-5-5` | 7 smoke | 3 | runner default 3 | runner default 10 min | runner default 2 | $2 |
| `claude-family` | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | 10 headline (no `seat-pricing`) | 3 | 2 | 25 min | 1 | $45 |
| `claude-effort` | `claude-haiku-5-5-low`, `-xhigh`; `claude-sonnet-5-5-low`, `-xhigh`; `claude-opus-5-5-low`, `-high`; `claude-fable-5-2-low` | 10 headline (no `seat-pricing`) | 3 | 2 | 25 min | 1 | $30 |

Registry default effort: Fable 5.2 high, Opus 5.5 medium, Sonnet 5.5 high, Haiku 5.5 medium. An effort variant such as `claude-haiku-5-5-xhigh` is its own board row with the same API model and prices, and its own cache entries, because the Anthropic cache key includes the effort, thinking mode and output cap (`cacheModelKey`, `runners/provider.ts`).

**Cost estimate (free, from registry prices).** Cost is `(billed input / 1000) x costPer1kInputUsd + (output / 1000) x costPer1kOutputUsd` (`costFromUsage`, `lib/lab/llm-benchmark/billing.ts`). Billed input is input plus cached read and write tokens. Output includes thinking tokens. Registry prices per 1k tokens, input then output: Haiku 0.0001 and 0.0005; Sonnet 0.002 and 0.010; Opus 0.004 and 0.020; Fable 0.008 and 0.040. The planning assumptions, to be replaced by the pilot's measured `tokensIn` and `tokensOut`, are 3,000 input tokens and 9,000 output tokens per call. The output figure is the top of the 6.5k to 9k range in the Horizon design notes (`lib/lab/llm-benchmark/plugins/horizon-suite/README.md`).

| Model | Per call | One model, headline, 3 iterations (33 calls) |
|---|---|---|
| Haiku 5.5 | $0.0048 | $0.16 |
| Sonnet 5.5 | $0.096 | $3.17 |
| Opus 5.5 | $0.192 | $6.34 |
| Fable 5.2 | $0.384 | $12.67 |

- `claude-smoke`: 21 calls, about $0.10.
- `claude-family`: 132 calls, about $22 in total. No model reaches its $45 cap.
- `claude-effort`: 231 calls, about $32 in total. Each model stays under its $30 cap at these assumptions.
- Pilot: one call, about $0.005.
- Sensitivity: at 20,000 output tokens per call, `claude-family` is about $48 in total and Fable is about $27, still under its cap. Re-estimate from measured tokens before running any xhigh variant.

## 4. The safe sequence

Work through the steps in order. A failed step stops the sequence until its cause is known.

1. **Free checks.** Run `npm run typecheck`, `npm test`, `npx tsx scripts/run-benchmark.mjs --list-profiles`, and the Chromium check in section 2.
2. **Dump the plan.** Nothing is spent. Narrow with `--model` and `--task` if needed, then read section 5:

```sh
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN npm run bench -- --profile claude-family --dump-config
```

3. **Estimate.** Apply section 3 to the model and task counts shown in the dump. Record the figure before the owner is asked to approve the spend.
4. **Pilot, one call, on the cheapest Claude model.** It writes to a scratch results file, so the board is untouched. It uses a horizon task so the token counts reflect a heavy artifact. Pick a task whose pair has no cache entry first. A cached iteration replays with no call, so it proves nothing about the key, the network or a live answer. Check with `jq -r '.entries[] | select(.taskId=="<task>") | .modelId' .cache/llm-benchmark-responses.json | sort -u`: it must not list `claude-haiku-5-5@...`. At the time of writing `orbit-lab` already has three cached iterations for this model at medium, so it is not a valid pilot task:

```sh
mkdir -p tmp
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN RESULTS_OUT_PATH=tmp/pilot-results.json npm run bench -- --profile smoke --model claude-haiku-5-5 --task <uncached-horizon-task> --timeout-ms 1500000 --max-retries 1 --budget-max-usd 1
```

SPENDS MONEY for an uncached pair, about half a cent at the planning figures. Its successful responses are written to `.cache/`, so a later full run with the same model, effort, task and prompt pays only for the iterations it has not seen. A scratch results file that does not exist yet starts as a copy of the committed `results.json` (`readResults` falls back to it), so `tmp/pilot-results.json` is the whole board plus the pilot's record. Find the pilot record with the jq in section 9. Do not add `--bust-cache` to this command: it pays for every call and stores no answer.

5. **Inspect the pilot.** Run the checks in section 9 against `RESULTS_OUT_PATH=tmp/pilot-results.json`. The pilot record is the one with `.iterations == 1` and `.runLogRef.runId` equal to the printed `sweep root`. A `kept existing` line means the pilot failed and the old board record stayed in the scratch copy, so the record you see is not the pilot's. Expect the pilot record to have `status` success, no `failureReason`, `scorerVersion` 2, and token counts near the planning figures. Findings on other records are copied from the board and are not caused by the pilot.
6. **Re-estimate.** Replace the assumptions with the measured tokens. If the projected total is more than twice the plan, stop and report it to the owner.
7. **Full profile.** Dump, then run. SPENDS MONEY:

```sh
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN npm run bench -- --profile claude-family
```

8. **Verify** with section 9, **report** with section 10, and **publish** only under section 11.

Never run two sweeps that write the same results file. Before a live run, `pgrep -fl 'run-benchmark.mjs|sweep-recovery.mjs'` must print nothing. The monitor (`sweep-recovery.mjs`) sleeps between polls, so a plain `run-benchmark.mjs` match misses it, and hand-started sweeps count too. Two sweeps started in the same second get distinct tree names (`-2`, `-3`), but they still share `results.json` and the response cache `.cache/llm-benchmark-responses.json`. The cache is rewritten whole by each process, so two processes running at once lose each other's entries: on 2026-11-10 a parallel re-run lost three paid Opus 5.5 artifacts from the cache, and the "free" re-score that followed paid to generate them again. Run one sweep process at a time, even for different models, and put several models in one `--model` list instead.

## 5. Reading the effective config

Every run prints one row per knob, with its source in parentheses: `flag`, `env`, `profile:<name>` or `default`. Precedence is CLI flag, then environment variable, then profile, then built-in default. Unknown model or task ids are fatal (`Unknown model id(s)` / `Unknown task id(s)`), and so is naming a model or task whose plugin the sweep does not mount.

- `models`: count and names. `tasks`: `all N`, or `k of N` with the ids; `[n excluded by plugin set]` means a plugin is not mounted.
- `plugins`: `all (n)` by default; `none` means builtins only. `iterations`, `concurrency`, `timeoutMs`, `maxRetries`, `bustCache` and `skills` (`none (baseline)` for these profiles): the values the sweep will use.
- `sandbox`: backend, enforcement and prelude parity. `structural` or `remote` means the scores are not local browser measurements.
- `budget`: printed only when a cap is set. `resume`: printed only with `--resume`, giving counts of complete, to-run and recovered pairs.
- `sweep root`: the new tree, the resumed tree, or `SWEEP_ROOT`. `results`: the file the run will write, marked `(env)` when `RESULTS_OUT_PATH` is set.
- `anthropic key`: where the key came from (`ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE`). The value is never printed.
- `quota lock`: `none`, or each locked model and its window, with `would abort` unless `RUN_IGNORE_QUOTA_LOCK` is set.
- `est. duration`: a rough figure from historical runtimes. Pairs without history count as zero.

The dump skips the browser preflight, so check Chromium separately. A live run then prints `Running N iteration(s) at concurrency C for: ...` and `[harness] sweep root: sweeps/<run-id>/`.

## 6. Budget caps

- Set with `--budget-max-usd <n>`, `RUN_BUDGET_MAX_USD`, or a profile's `budgetMaxUsd`, in that precedence. A flag overrides the profile's cap. The value must be a finite number above zero. Omit it for no cap.
- The cap is per model for the whole sweep and cumulative over that model's pairs and tasks. Other models are not stopped by it.
- It is checked at each iteration boundary, after billing. A call in flight is never killed, so the total can exceed the cap by the iteration that crosses it and by iterations already running on that model's other pairs.
- Every billed attempt counts, including retries, refusals and truncated answers.
- On a trip, one `budget` event is written to the run log of the pair that crossed the cap. Every running pair of that model stops at its boundary. The model's remaining iterations and all its later tasks are skipped and write no record. The record in flight carries `budgetExceeded: { spentUsd, capUsd }`.
- A record with `budgetExceeded` can show fewer successes than iterations. That is an operator stop, not a model defect, and it is not a `failureReason`. Do not rank it on `scoreAllTrials`.
- A resume under a different cap prints a warning. Raising a cap is the owner's decision.

## 7. Failures, quota locks, resume and the monitor

A record's `failureReason` is the reason for its last failed iteration (`BenchmarkFailureReason`, `lib/lab/llm-benchmark/types.ts`). The union also has `none`, the success value.

| Reason | Points at | Handling |
|---|---|---|
| `truncated` | model | Anthropic: the answer hit `max_tokens` (128,000 by default, reasoning included; 64,000 before 2026-11-10, and pairs that reached 64,000 were re-run) or the context window. Billed, not retried. Moonshot and local runners' "truncated at the completion-token limit" is retried as transient. The pair's remaining iterations still run. |
| `model_error` | model, or infrastructure for 5xx | A refusal (its message names the category) or any unclassified provider error. Billed, not retried. A refusal does not end the pair. A stream cut off by the per-call cap is also `model_error`, billed with estimated usage, but it is not a per-iteration outcome, so it ends the pair's remaining iterations. |
| `empty_body` | unclear | Read the raw output in the run log before blaming the model. |
| `cli_timeout` | model speed | CLI routes only. A speed result. |
| `endpoint_hung` | infrastructure | Stalled connection, or the runner's per-call timeout firing before any content started. Retried. |
| `rate_limited` | infrastructure | 429 or overload, still failing after retries. |
| `quota_exhausted` | provider | Quota or billing stop. The model's breaker trips (below). |
| `auth_error` | configuration | 401 or 403. Check the key and its scope. |
| `invalid_request` | configuration or harness | 400. Check the request. |

- **Retries.** Transient errors (timeouts before content, network, 5xx including 529, 408, 429) retry up to `--max-retries`, which defaults to 2 and is 1 in the Claude profiles. The wait doubles from 1 s per attempt, is four times longer for rate limits, and is raised to a provider's `retry-after` up to 180 s. Any other non-transient error (auth, validation, unclassified) ends the pair's iteration loop at once. A truncation or refusal does not (`isPerIterationOutcome`, `runners/provider.ts`).
- **Quota.** A quota error trips a per-model breaker. The model's remaining iterations and later tasks are skipped with no record. If the error states a reset window, the record carries `quotaNextResetAt`. A later sweep refuses to start while that window is in the future, unless `RUN_IGNORE_QUOTA_LOCK=1`. Use the override only when the owner knows the estimate is stale. An Anthropic spend-limit refusal ("You have reached your specified API usage limits") is recorded this way, with a reset at the start of the next month. When the owner raises the limit, that date is stale: re-run the pair with the override, and its cached iterations are reused, so only the refused calls are paid (on 2026-11-12 the Opus 5.5 high RLC pair was completed this way for about US$0.91). Check the key with a one-token call before a paid sweep, because the limit has been reached twice.
- **Resume.** `--resume <run-id>` (or `RUN_RESUME`; a profile cannot set it) reuses `sweeps/<run-id>/`. It skips pairs that have an `aggregate` event, re-runs pairs whose aggregate has zero successes, and recovers from the run log, with no call, any pair whose aggregate is missing from `results.json` or stale there. Pass the original `--model`, `--task`, `--plugins` and `--budget-max-usd`: a bare `--resume` runs the default model `kimi-k2.7` on every task. `--bust-cache` overrides the skips. `--bust-cache` (or `RUN_BUST_CACHE=1`, or `BUST=1` in Taskfile) skips reading and writing `.cache/llm-benchmark-responses.json` for that run, so every call is paid and no answer is stored. Use it only on the owner's instruction.
- **Monitor.** `npx tsx scripts/sweep-recovery.mjs` prints one verdict per sweep tree: `complete`, `resume` (models ready to run) or `wait` (a pending model is quota-locked). A run whose last resume made no progress is shown as `stalled` for the rest of that monitor session; that label is the monitor's own judgement, not a plan verdict. `--go` resumes the ready runs one at a time, newest first, and stops at the first failure. `--watch --go` polls every 15 minutes (`--interval <min>` changes this) and caps the spawns per run. `--run <id>` limits the scope. Task forms: `task bench:monitor` and `task bench:monitor -- --go`. `--go` SPENDS MONEY. Never run it while a hand-started sweep is live, because the monitor cannot see that sweep's lock (`sweeps/.recovery.lock`). Decisions are appended to `sweeps/recovery.log`.
- **Model or infrastructure.** Browser fallbacks (`behavioural-run` rows) and budget stops are not model failures. An infrastructure failure does not count against the model: fix the cause and resume the pair. A model failure (truncated, refusal, low checks) stands in the record.

## 8. Scoring stability rules

- **One artifact at a time.** Scoring runs through one process-wide queue. At most `BENCH_SCORE_CONCURRENCY` artifacts (default 1; a value that is not a whole number of at least 1 is an error) are rendered in the browser at once, across every (model, task) pair. Generation is not limited. Parallel rendering once made the same WebGL artifact score 100 in one run and 30 in another.
- **Known-good probe (chromium backend).** A built-in animated WebGL page is scored before a pair's artifacts, again after them when a row failed, and before the third attempt of a timed-out artifact. A failed probe discards the browser and waits 15 s, 45 s and then 90 s before trying again. After the last wait, the sweep stops.
- **Timeout rescore.** A check that ran out of time (a timeout row, never an ordinary failed check) is rescored once on a fresh page after a 2-second wait. Both attempts are written to the run log as `rescore` events. If the rescore also times out, the browser is discarded, the sweep waits 15 s and probes, and the artifact is rescored once more. If that third attempt still times out, `BrowserFallbackError` stops the sweep. No record is written for that model and task. Rerun with `--resume` when the machine is idle.
- **Browser death.** A browser is dead only when Playwright's Browser object reports it disconnected (`isConnected()` or its `disconnected` event). An error message that names a closed page or browser is not evidence. A page that closes itself is an artifact behaviour, scored as failed checks. An artifact whose run fell back because the browser disconnected is rescored once on a relaunched browser. A second fallback throws `BrowserFallbackError`: the jobs already running finish, and no record is written for the pair. Treat it as infrastructure: fix Chromium, then resume.
- **No structure-only scores from a dead browser.** On the chromium backend a browser-scored artifact that falls back to structure keeps a visible `behavioural-run` row, and `verify-results` fails a version-2 record that carries one.
- **Browser preflight.** The task wrappers `profile`, `run` (so `smoke` and `cli` too), `rescore`, `corpus:probe`, `visual-games-fixtures` and `gateway-fixtures` require Chromium to launch before they run. The sweep script also launches it before any model call. If it does not start, the run exits 1, names `PLAYWRIGHT_BROWSERS_PATH` and prints the install command.
- **`BENCH_SANDBOX`.** Leave it unset, or set `chromium`, for real scores. `structural` and `remote` skip the local browser; `remote` needs `PLAYWRIGHT_WS_ENDPOINT`. An unknown value is fatal.

## 9. Verification after a run

1. **Results and run logs.** Run `npx tsx scripts/verify-results.mjs`, or `task bench:verify-results`. It exits 1 on any failure. Add `--strict` before publishing, which promotes warnings (including `stale-prompt`) to failures. `--quiet` prints only the summary line and any failures. `RESULTS_OUT_PATH` and `SWEEPS_DIR` point it at a scratch file or another tree. Key checks: `score-mean` (score is the mean of the successful `iterationScores`); `all-trials-score` (version 2: `scoreAllTrials` within 0 to 100 and not above `score`); `browser-breakdown` (a version-2 browser record with a `behavioural-run` fallback row fails, and a stored timeout row warns); `status-consistency`; `failure-reason`; `runlog-ref` (each log exists and holds an `aggregate` event); `runlog-seq` (a gap warns, a duplicate or decrease fails); `artifact-integrity` (stored blobs still hash to their names); `stale-prompt` (warns when a record was scored under an older prompt bundle); and `budget-sanity`, `usage-sanity`, `telemetry-sanity`, `registry-resolution`, `corpus-provenance` and `curator-feedback`.
2. **Scorer versions.** Count records by version. New records must be version 2:

```sh
jq -r '[.[] | (.scorerVersion // 1)] | group_by(.) | map("version \(.[0]): \(length)")[]' lib/lab/llm-benchmark/results.json
```

3. **Spot-check one record and its log.** Replace the ids:

```sh
jq -c '.[] | select(.modelId=="claude-haiku-5-5" and .taskId=="orbit-lab") | {status, failureReason, score, scoreAllTrials, iterations, iterationsSucceeded, costUsd, scorerVersion, runLogRef, budgetExceeded, quotaNextResetAt}' lib/lab/llm-benchmark/results.json
npx tsx scripts/retrace.mjs --run <run-id> --model claude-haiku-5-5 --task orbit-lab --iteration 0
jq -c 'select(.type=="aggregate" or .type=="failure" or .type=="budget")' sweeps/<run-id>/claude-haiku-5-5-orbit-lab.jsonl
```

The retrace shows the prompt, every attempt, the response, the artifact that was scored, each check's verdict and the aggregate. The log file is named `<modelId>-<taskId>.jsonl`.

4. **Rescore one artifact.** Run `npx tsx scripts/rescore-artifact.mjs --run <run-id> --model <id> --task <id> [--json]` (`task bench:rescore -- ...` runs the same). Exit 0 means it matches or there is no recorded score to compare, 1 means drift, and 2 means the artifact is missing or unreadable, or its bytes do not match their address. A browser task takes seconds per artifact.
5. **After a scorer or check change.** Run `npx tsx scripts/rescore-parity.mjs [--tasks a,b] [--limit N]`. It makes no model call. Every http(s) request the page makes is aborted and counted. It never writes `results.json`; its findings go to `tmp/rescore-parity.json`.
6. **Code gate.** Run `task bench:verify`, which is the typecheck and the benchmark unit tests.

## 10. Rebuilding the report

Run from `benchmarks/`, in this order. Every step reads files, and none calls a model. The isolation test runs before any capture, because capture renders stored model HTML.

1. **Isolation.** Run `npx tsx report/capture-isolation-test.mjs` first, and stop if it exits 1. It loads a hostile probe in the capture context and checks that the capture browser reaches none of the listeners it owns on 127.0.0.1 (HTTP, upgrades, WebSocket and a UDP socket for STUN). A plain browser runs the same probe as a negative control and must reach them. The test exits 1 otherwise. It takes no flags.

2. **Capture.** `npx tsx report/capture.mjs [--models a,b] [--tasks x,y] [--limit N] [--force] [--concurrency 1-4]`. It needs the chromium backend. It renders stored HTML in headless Chromium and writes `report/dist/gallery/<task>/<model>-a.jpg` and `-b.jpg` and `report/data/signals.json`. Pages open at once: default 2. Default models: every Anthropic model in the registry, plus the eight other models with the highest mean live score on plugin tasks. Default tasks: every browser-scored task (`behavioralTaskIds`), which may include smoke tasks, so pass the headline ids with `--tasks` for a headline report. Unchanged cells are skipped unless `--force` is given.

Model HTML is untrusted, so the capture browser is isolated (`report/capture-browser.mjs`). Every connection goes to a proxy that is not listening (`127.0.0.1:9`, bypass `<-loopback>`), WebRTC may send UDP only through that proxy, Chromium's sandbox and web security stay on, and every request is aborted at the route level except `about:blank` and `data:`. The scorer's own browser is launched differently, with `--no-sandbox` and `--disable-web-security` (`CHROMIUM_LAUNCH_ARGS`, `scorers/sandbox-backend.ts`). Do not treat the scorer's launch as isolation.

3. **Build.** `npx tsx report/build.mjs [--no-data] [--now 2026-11-10T12:00:00.000Z]`. Unless `--no-data` is passed, it runs `report/build-data.mjs`, which reads `results.json` (and `report/data/signals.json`) and writes the board into `report/dist/`. The build then copies the page template (`index.html`, `report.css`, `report.js`), the fonts, and the tokens generated from the repository's `docs/theme.css`, and it removes stale `artifacts/` and `frame.js`. `--now` or `REPORT_NOW` makes repeated builds byte-identical. The build warns about any model priced under $0.01 per million tokens (`PRICE_REVIEW_BELOW_PER_M`) and leaves that model's cost unmeasured on the page.
4. **Check the built output.** `npx tsx report/dist-check.mjs` fails if the build contains `iframe` or `srcdoc`, text from a stored artifact, or a `dist/artifacts` folder or `frame.js`. Stop on exit 1.

5. **Shoot.** `REPORT_SHOTS_DIR=<directory outside the repository> npx tsx report/shoot.mjs`. It opens the built page from disk and prints PASS or FAIL for each check: no console errors or page errors, no request from the page, no horizontal overflow, every chart fits at 390 px, every section exists, one tab stop per chart, no label or number cut off or overlapping, the gallery dialog has two captures, the dialog has no run control and no frame, and the synthetic banner shows at 1440 and 390 px. It exits 1 on any FAIL. `REPORT_URL` checks a served page instead. Without `REPORT_SHOTS_DIR`, screenshots go to the OS temp directory (`th-report-shots`), so always set it.
6. **Serve locally.** `node report/serve.mjs [port]`, default port 8787, bound to 127.0.0.1. Then open `http://127.0.0.1:8787/`.

What a reader sees: the page draws values from the board that `lib/lab/report/board.ts` builds from `results.json`. It shows four scopes, each labelled and never averaged with another: Headline tasks, Horizon tasks, Smoke tier, and Earlier runs (scorer v1). The reader never runs model-written HTML. The only model output on the page is the capture images, taken with the network blocked, and the template has no run control. A synthetic board (`source.synthetic`, built by `report/fixtures/synthetic-board.mjs`) carries a synthetic banner and is never published as results.

The report writes only `report/dist/` and `report/data/signals.json`, both git-ignored. The build reads `docs/theme.css` and `docs/fonts/` from the token-horizon repository root (one level above `benchmarks/`) and never writes there.

## 11. Publishing rules

- **Nothing under `docs/` until the owner decides.** `docs/` is what the site publishes. The report stays local and undeployed.
- **Traces.** `npx tsx scripts/publish-traces.mjs` (or `task bench:publish-traces`) copies the run logs that `results.json` cites into `public/lab-data/traces/`, which is committed, and prunes any trace no record claims. Treat it as publication: run it only after `verify-results --strict` passes and the owner has approved publishing.
- **Seeded data.** `task bench:seed` (`scripts/seed-mock-results.mjs`) overwrites `results.json` with sample records. Never run it on a live board.
- **Versions and scope.** Never rank version 1 with version 2; version 1 belongs in the `earlier` scope. Smoke tasks never appear in a headline comparison.
- **Stopped records.** A budget- or quota-stopped record is not ranked on `scoreAllTrials`, because its divisor is the requested count.
- **Every comparison states**, beside it: the iterations per cell (N); the 95% percentile bootstrap interval, which `bootstrapInterval` in `lib/lab/report/board.ts` computes with 2,000 resamples and a fixed seed, and which is null with fewer than six iteration values; the profile name; and the sweep run ids. Overlapping intervals mean the gap between two models is not established. They do not prove a tie. Follow `docs/lab/llm-benchmark/eval-methodology.md`: same profile, same prompt bundle, cited sweeps, and a named guardrail.
- **Verification gate.** Do not publish a number from a run whose `verify-results --strict` fails.
- **Model output.** Do not copy raw model HTML from `sweeps/` or `report/dist/` into any published location.

## 12. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `behavioural scoring needs Chromium, and it did not start` | Pinned Chromium missing from `PLAYWRIGHT_BROWSERS_PATH` | Install as in section 2 and re-run the check. `npm run bench` sets the path. |
| `ANTHROPIC_API_KEY_FILE is set but yields no key` | File missing, empty, or not one header-safe line | The operator fixes the file. Check it with the line and name counts in section 2 only. |
| `ANTHROPIC_API_KEY is set but cannot be sent in a header` | Env value holds a space, control or non-ASCII character, or a quote at either end | Fix or unset the variable. The file is not read in its place. |
| `... is quota-locked until T` | `results.json` holds a future `quotaNextResetAt` | Wait, or let the monitor resume it. Use `RUN_IGNORE_QUOTA_LOCK=1` only if the estimate is stale. |
| `kept existing <model> :: <task> (<status>) — fresh run produced 0 successful iterations` | A fresh run with no successes did not replace a baseline record that has successes | Expected. The old record stands, and only its `quotaNextResetAt` and `budgetExceeded` stamps carry over. Read the failure reasons. |
| `stopped for the rest of this run by its budget cap` | Budget trip | Expected. Raise the cap only on the owner's decision. |
| Sweep stops with `BrowserFallbackError`, no record for the pair | Browser failed on the rescore or on a relaunch | Check Chromium and host load, then `--resume` when the machine is idle. |
| A resumed run used `kimi-k2.7` | `--model` and `--task` not passed with `--resume` | Re-run the resume with the original flags. |
| `Unknown model id(s)` or `Unknown task id(s)` | Typo, or the task's plugin is not mounted | Check the dump and the registry. |
| `Model "..." / Task "..." comes from plugin ..., which this sweep does not mount` | `--plugins` excludes it | Add the plugin, or drop the id. |
| Files appear in the wrong directory, or the cache is not found | Run from the repository root | `cd benchmarks` first. |
| `capture needs the local chromium backend` | `BENCH_SANDBOX` is set | Unset it for capture. |
| `artifact-integrity` FAIL | Stored bytes do not match their content address | Do not publish or rescore. Investigate the blob. |
| Run-log `seq` duplicate or decrease | Damaged run log | Do not use that record. Re-run the pair. |
| `stale-prompt` WARN | Prompt or frame prelude changed since the record | Re-run the pair before publishing. `--strict` is the gate. |
| Taskfile refuses: `results.json` not tracked | File untracked | The owner commits or backs it up first. |
