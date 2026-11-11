# @token-horizon/benchmarks

The task benchmark harness for LLMs. It runs each model against a set of
generative tasks (single-file web artifacts such as games, simulations and
tools), scores the output with deterministic and behavioural checks, and
records the results. The package contains:

- **runners**: provider adapters for API models (OpenRouter, Moonshot, OpenAI,
  Anthropic, Google, Ollama, local) and CLI-backed models (agy, codex, devin,
  opencode, and the Claude Code provider; see "Running a real benchmark").
- **scorers**: text and HTML checks, a sandboxed Chromium runner for behavioural
  checks, and executable and canvas-capture scorers.
- **registry**: the model and task registry, plus the plugin system for extra
  tasks, checks and providers (`lib/lab/llm-benchmark/plugins/`).
- **results**: `lib/lab/llm-benchmark/results.json` and its merge rules, the
  curator feedback sidecar, and the failure regression corpus.
- **sweeps**: resumable multi-model runs, quota-recovery planning, sweep
  profiles, and sample-data seeding.
- **run logs**: per-iteration JSONL logs under `sweeps/`, with content-addressed
  spill files and artifacts, and the scripts that verify, retrace and publish
  them.
- **MCP server**: `scripts/bench-mcp.mjs` exposes the results to MCP clients
  (list models and tasks, get results and traces, resolve `bench://` references).

## Provenance

This package was copied from `benebsworth.com` at commit
`a1d5193c3aaa785774815a16b445c916ad613c38` on 2026-11-10. The copied paths are
`lib/lab/llm-benchmark/`, the benchmark tools in `scripts/` (see "Deliberately
left behind" for the rest), `content/lab/llm-benchmark/`,
`docs/lab/llm-benchmark/`, `docs/postmortem/` (except one file, below),
`public/lab-data/traces/`, and two operator skills,
`.claude/skills/llm-benchmark/SKILL.md` and
`.claude/skills/benchmark-orchestration/SKILL.md`. The Taskfile is a port of
`taskfiles/benchmark.yml`. The harness files are byte-identical to the source.
`Taskfile.yml`, `package.json`, `vitest.config.ts`, `.gitignore` and this README
were written for this package.

Dependencies are pinned to the versions the source has installed: tsx 4.22.4,
vitest 4.1.7, react 19.2.6, @types/react 19.2.15, @types/node 25.9.1,
typescript 6.0.3, playwright 1.60.0 and gray-matter 4.0.3. `@playwright/test` is
not a dependency. Nothing imports it, and its CLI would install a different
Chromium revision from the one the harness needs.

## Layout

The directory layout mirrors the source repository. This package is the
equivalent of the source repo root, so the import graph, the layering test
(`lib/lab/llm-benchmark/layering.test.ts` resolves the root three directories up
and expects scripts in `scripts/`) and every documented path work without
rewrites. Keep this mirroring when files are added or moved.

## Deliberately left behind

These were not copied, and each has a reason:

- **Site UI and landing-page code**: `nav.ts`, `content.ts`, `brandbrain.ts`,
  `brandbrain-flow.ts`, `gamma.ts`, `gamma-visual.ts`, `comfy.ts`, `mlx.ts`,
  `images.ts`, `capture.ts`, `loops.ts`, `reward.ts`, `runners/opencode-loops.ts`
  and their tests. Nothing else in the harness imports them, which was checked
  by grep after the copy.
- **Website scripts**: the source `scripts/` holds 49 files and 27 were copied.
  The 22 not copied serve the site build, deploys, prose linting or the blog:
  `build-archive.sh`, `deploy.sh`, `deploy-pages.sh`, `gen-hero.mjs`,
  `lint-prose.mjs`, `prose-lint.mjs`, `prose-sources.json`, `og-rewrite.mjs`,
  `render-diagram.py`, `seed-vector-assets.mjs`, `capture-lab-poster.mjs`,
  `gen-benchmark-outputs.mjs`, `inline-benchmark-outputs.mjs`,
  `verify-benchmark-renders.mjs`, `check-benchmark-demo.mjs`,
  `capture-benchmark-screenshots.mjs`, `verify-k3-posts.mjs`,
  `methodology-check.mjs`, `gen-md-siblings.mjs`, `test-kimi-one.mjs`,
  `gen-harness-eval.mjs` and `run-benchmark-loops.ts`.
- **Failure corpus bytes**: `failure-corpus/cases/` is gitignored. The
  provenance file (`failure-corpus/provenance.json`) is copied, and the bytes can
  be re-derived from a sweep with `scripts/ingest-failures.mjs`.
- **Large HTML result variants**: `results-*-html.json` files are never committed.
- **Local sweep state**: `sweeps/` and `.cache/` were not copied. See "Local
  sweep state" below.
- **Secrets**: no `.env` file was copied.
- **Generated site data**: `public/lab-data/llm-benchmark/` is rebuilt by the site
  build.
- **Another lab's postmortem**: `docs/postmortem/0005-harness-eval-clobber.md`
  concerns a different lab.
- **Local-LLM dataset tasks**: the `local`, `local:sync` and `local:bench` tasks
  in the source Taskfile read `lib/lab/local-llm/` and `~/projects/ollama-bench`,
  which are not part of this harness.

## Setup and checks

Run these from this directory, or with `task -d benchmarks <name>` from the
token-horizon root. None of them calls a model.

```sh
npm install                       # installs the pinned dependencies
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run (unit tests; browser tests are skipped)
task visual-games-fixtures        # browser fixtures; needs Chromium (see below)
task dump -- --model kimi-k2.7 --task equation-solver   # a run's effective config, nothing runs
npx tsx scripts/run-benchmark.mjs --list-profiles
npx tsx scripts/verify-results.mjs   # checks results.json and any run logs
task --list                       # the Taskfile; from the root use -d benchmarks or -t benchmarks/Taskfile.yml
```

`npx tsx scripts/verify-results.mjs` reads paths relative to the current
directory, so run it from this directory (the task form does this for you).

The browser fixtures can also run without the task. The task also sets the
browser path, so the direct form needs it too:

```sh
BENCH_BROWSER_TESTS=1 PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright-benchmarks \
  npx vitest run lib/lab/llm-benchmark/plugins/visual-games/checks.test.ts lib/lab/llm-benchmark/scorers/canvas-capture.test.ts
```

**`methodology.test.ts` runs in its own vitest project.** Its 24 tests are split
across two projects in `vitest.config.ts`. The 22 tests that cover
`methodology.ts` run, and only the two tests in `describe('the real content
tree')` are filtered out by name. That block reads the website's blog posts under
`content/blog/`, which this package does not contain. So `npm test` reports 22
passed and 2 skipped for that file.

## Chromium for behavioural checks

Behavioural checks load each generated page in headless Chromium through
Playwright. Playwright 1.60.0 needs Chromium revision 1223.

- The Taskfile sets `PLAYWRIGHT_BROWSERS_PATH` to
  `$HOME/Library/Caches/ms-playwright-benchmarks`, which is separate from the
  default cache (`~/Library/Caches/ms-playwright`). A value exported in the shell
  wins.
- Install it once with `task browsers:install`. That runs
  `node node_modules/playwright/cli.js install chromium`. Do not use
  `npx playwright install`: `npx` can resolve a different Playwright and install
  a different revision. The installer also deletes browsers in
  `PLAYWRIGHT_BROWSERS_PATH` that this Playwright version does not use, so keep
  that directory for this package alone.
- **Preflight.** Before any model is called, `scripts/run-benchmark.mjs` launches
  Chromium once if a selected task is scored in the browser and the sandbox
  backend is `chromium`. If the launch fails, the run stops with a non-zero exit,
  names `PLAYWRIGHT_BROWSERS_PATH` and prints the install command. Before this
  check, a missing browser silently produced structure-only scores in
  `scorers/behavioral.ts`. `--dump-config` and `--list-profiles` skip the
  preflight, because they run nothing.
- **Guard.** `run` (and so `smoke` and `cli`), `profile`, `rescore`,
  `corpus:probe`, `visual-games-fixtures` and `gateway-fixtures` also refuse to
  start unless Chromium launches.
- `BENCH_SANDBOX=structural` or `remote` skips the local-browser checks. Those
  runs do not measure behaviour in a local browser, so check the sandbox line of
  `--dump-config` before reading their scores.
- `npx tsx scripts/run-benchmark.mjs` and `npm run bench` run the preflight. `npm
  run bench` also defaults `PLAYWRIGHT_BROWSERS_PATH` to
  `$HOME/Library/Caches/ms-playwright-benchmarks` when it is not already set.

## Running a real benchmark

**A real run makes paid API calls and uses provider quota.** The `run`,
`smoke`, `cli`, `profile`, `monitor -- --go` and `devin-preflight` tasks all
spend money or quota. Always pass `MODELS=` (or `--model`) to scope a run, and
check the plan first with `task dump -- <flags>` or `--dump-config`.

**Run from `benchmarks/`.** Some scripts resolve paths against the current
directory, not the package: `run-benchmark.mjs` (`sweeps/`, `results.json`,
`.cache/`), `merge-benchmark-results.mjs`, `seed-mock-results.mjs`,
`rescore-cli-pair.mjs` and `probe-devin.mjs`. From the token-horizon root,
`npx tsx benchmarks/scripts/run-benchmark.mjs` creates `sweeps/` and `.cache/`
in the parent repo, and `--dump-config` prints paths under the wrong directory.
Its results write then fails after the paid calls, because the root has no
`lib/lab/llm-benchmark/` directory. From the root, use one of these instead:
`task -d benchmarks <task> -- <flags>`, `npm --prefix benchmarks run bench -- <flags>`
(no browser guard), or `cd benchmarks` first. Never run these scripts from the root.

**Sweep profiles.** `--profile <name>` applies a recipe from
`lib/lab/llm-benchmark/sweep-profiles.json`; `--list-profiles` lists them and
`--dump-config` prints the effective settings with no call. Three Claude recipes
ship. The two paid recipes run 10 of the 11 headline tasks (`tic-tac-toe`,
`gateway-console`, `voxel-lighthouse`, `car-racer`, `orbit-lab`, `pathfinding-lab`,
`rlc-response-lab`, `bicycle-blueprint`, `sector-clock`, `kanban-keyboard-undo`).
`seat-pricing` is held back until its contrast check passes review (see the
horizon-suite README):

- `claude-family`: Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 at their default
  effort, 3 iterations, concurrency 2, a 25-minute per-call cap, one retry and a
  $45 cap per model.
- `claude-effort`: Haiku 5.5 and Sonnet 5.5 at low and xhigh, Opus 5.5 at low and
  high, and Fable 5.2 at low, with the same tasks and settings and a $30 cap per
  model.
- `claude-smoke`: Haiku 5.5 on the seven smoke tasks (`n-body-field`,
  `mini-platformer`, `crypto-hash-race`, `landing-page-morph`, `equation-solver`,
  `physics-pendulum-wave`, `circuit-builder-teaser`), 3 iterations and a $2 cap.
  Smoke tasks check wiring only and are never ranked.

**Browser scoring.** Artifacts are rendered in the browser one at a time by
default. `BENCH_SCORE_CONCURRENCY=<n>` allows `n` at once across every pair of the
process; generation is not limited. A scoring call's queue wait is logged as a
`scoringWait` event. A check that could not finish (a per-check or batch timeout, a
Playwright timeout, or the horizon kit's bounded, deadline or page-budget rows) is
rescored once on a fresh page after 2 seconds, and both attempts are logged as a
`rescore` event; the count is the record's `telemetry.scoringRescores`. A rescore
that also times out is treated as a busy machine: the browser is relaunched, the
sweep waits 15 seconds and probes, and the artifact is rescored once more. A timeout
that survives that stops the sweep and writes no record for the pair. On the
chromium backend, a known-good WebGL probe runs before a pair's renders, after them
when a check failed, and before that last rescore: a probe that keeps failing stops
the sweep after waits of 15, 45 and 90 seconds, and writes no record.
A browser that disconnects is relaunched once; a second disconnect stops the sweep.
Whether a browser died is read from the Browser object, never from error text.

**Rescore parity.** `npx tsx scripts/rescore-parity.mjs [--tasks a,b] [--limit N]`
rescores the stored browser-scored artifacts with the current scorer and compares
each check's outcome with the stored one. Scoring goes through the scoring
semaphore, so one artifact renders at a time by default. A difference is given a measured
cause: the artifact is scored again under each capture and landing-check regime the
board has used, and the cause is the regime that reproduces the stored outcome.
It makes no model call, uses no network and never writes `results.json`; its
findings go to `tmp/rescore-parity.json`. See
`docs/lab/llm-benchmark/scorer-changelog.md` for what the result means.

**Keys.** Keys are read from the environment: `OPENROUTER_API_KEY`,
`MOONSHOT_API_KEY` (with `MOONSHOT_BASE_URL`), `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `GOOGLE_API_KEY`. The Taskfile loads `.env` (gitignored)
for `task` commands. `npx tsx` does not load it.

**`ANTHROPIC_API_KEY_FILE`** names a file that holds the Anthropic key, so the key
does not have to sit in the shell environment. The file may hold the bare key on
its own line, or `NAME=value` lines (optionally prefixed with `export ` and
optionally quoted); the `ANTHROPIC_API_KEY` line is used. Blank lines and `#`
comments are ignored. `ANTHROPIC_API_KEY` wins when both are set, and the file is
not read in that case. If the file is named but missing or empty, and the sweep
includes an Anthropic model, the run stops before any call. The key is never
printed; the run only reports that it came from the file. A leading `~/` in the
path is expanded.

```sh
ANTHROPIC_API_KEY_FILE="$HOME/.config/<your-dir>/anthropic-api-key" npm run bench -- --model claude-haiku-5-5 --task equation-solver --dump-config
```

`OPENROUTER_REFERER` and `OPENROUTER_TITLE` set the headers sent to OpenRouter.
Their defaults name the website and its author. Set both in `.env` to what this
project should send before the first OpenRouter run.

**CLI providers.** agy, codex, devin and opencode use their locally authenticated
binary and need no key.

**The Claude Code provider is not an Anthropic route.** It runs
`kimi-k3.1-pro`, a Kimi model reached through the `claude` CLI, and it needs
`MOONSHOT_API_KEY` from `~/.config/kimi.env` or the environment. On every call it
overwrites `~/.claude/settings.json` with a block that carries that key, and it
restores the file in a `finally`. A crash or SIGKILL leaves the replaced settings
file, and the key, on disk. Any Claude Code session running at the time reads the
replaced file. So do not run it while another Claude Code session is live, do not
run it from inside an agent session, and keep it out of automated sweeps: always
pass `MODELS=` explicitly.

**The Anthropic runner** (`runners/anthropic.ts`) calls the Messages API through
the official SDK, streamed, so each record carries a time to first content block
(`ttftMs`, which for a thinking model is the start of its reasoning, the same
clock its thinking tokens are counted on). It sends no sampling parameters (no `temperature`, `top_p` or
`top_k`). It never sends a `fallbacks` parameter or a beta that lets another
model answer, so a result always comes from the model it names. The SDK's own
retries are off (`maxRetries: 0`): the harness owns retries and logs each one.

- **Effort is pinned.** The registry's `reasoningEffort` is sent as
  `output_config.effort`. Every entry that accepts an effort pins it, so a record
  never depends on the API default. `claude-haiku-4-5` accepts none and pins none. An effort variant such as `claude-sonnet-5-5-low` is its own
  board row with the same API model and prices as its base (`baseModelId`).
- **Thinking.** Adaptive thinking is sent only where the registry says
  `thinking: 'adaptive'`. Thinking blocks are not part of the scored artifact.
- **Output cap.** Each call may produce up to 128,000 output tokens, the API
  maximum for the current models, reasoning included (a registry entry with a
  lower ceiling sets `maxOutputTokens`). Until 2026-11-10 the cap was 64,000;
  every pair that reached it in the first Claude sweep was run again under
  128,000, and no completed record came near the old cap.
- **Stops.** An answer that hits its output cap (`stop_reason: max_tokens`) is
  recorded as `truncated` and is not retried, because the same cap would cut the
  same answer again. A refusal is recorded as a model error that names the
  refusal category, and is not retried. Neither ends the pair: the remaining
  iterations still run, so the record measures how often it happens. Both are billed, so their tokens and cost
  are recorded and count against a `--budget-max-usd` cap. A stream the runner's own cap
  cuts off while it is still generating is recorded as a model error with the
  usage it produced (estimated), not as a timeout, and is not retried.
- **Keys.** The key comes from `ANTHROPIC_API_KEY` or from the file named by
  `ANTHROPIC_API_KEY_FILE`. A key file holds either a single bare line or
  `NAME=value` lines (other names are ignored). A bare file with more than one
  line, or a value with a space or control character, yields no key, and the
  sweep refuses to start. The key is never written to a
  record, a log or the console.
- **Models.** The new ids are `claude-fable-5-2`, `claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-5-5` (each with its `-low`, `-medium`,
  `-high` or `-xhigh` effort variants) and the earlier `claude-fable-5-1`,
  `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`,
  `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6` and `claude-haiku-4-5`.
  The seeded `claude-4` entry is unchanged. The Haiku 5.5 prices apply to prompts
  of 100,000 tokens or fewer, which every task here is. `claude-haiku-4-5` accepts
  neither an effort nor a thinking parameter, so its entry pins neither.

**Writes.** These tasks write committed or shared files:

- `run`, `smoke`, `cli`, `profile` and `merge` write
  `lib/lab/llm-benchmark/results.json`. `seed` overwrites it with sample records
  and asks first. All six refuse to start while `results.json` is untracked, so
  commit `benchmarks/` before any write. A bad write can then be reverted.
- `feedback` writes `lib/lab/llm-benchmark/feedback.json`, `corpus:ingest` writes
  `failure-corpus/provenance.json`, and `publish-traces` writes
  `public/lab-data/traces/` and prunes traces no record claims.
- `monitor -- --go` spawns `run-benchmark.mjs` children. It is not guarded by the
  browser check and has no precondition of its own.
- `scripts/rescore-cli-pair.mjs --write` rewrites `results.json`. No task wraps it.

**Git provenance.** `scripts/rescore-cli-pair.mjs --write` checks that the scorer
files have no uncommitted changes (`git diff --quiet HEAD`), then records
`git rev-parse HEAD` as `scorerCommit`. While `benchmarks/` is untracked, that
check sees nothing, and the recorded commit is the token-horizon HEAD, which does
not contain the scorer. Commit `benchmarks/` before using `--write`. The commit
SHAs already in results, traces and docs (for example `rescoreOf.scorerCommit`
`01ea98c5…`) belong to benebsworth.com.

**Task names.** Every task also has a `bench:` alias, so commands printed by the
harness and written in the copied docs run as written, for example
`task bench:run MODELS=a,b`. `bench:outputs`, `bench:methodology-check` and
`task build` belong to the website. `bench:methodology-check` is referenced in
`docs/lab/llm-benchmark/eval-methodology.md`. Run `task verify` and
`task verify-results` by hand: this package has no pre-push hook.

**Standalone Taskfile.** The Taskfile has a top-level `dotenv`, so the
token-horizon root Taskfile cannot `include` it. Use `-d benchmarks` or
`-t benchmarks/Taskfile.yml` instead.

Each task states what it spends and what it writes in its summary, which is
printed by `task <name> --summary`.

## Local sweep state

`sweeps/` and `.cache/` are not in this package. In the source checkout,
`sweeps/` holds 39 run directories and 238 run logs, and
`.cache/llm-benchmark-responses.json` holds cached model responses. As a result:

- At the time of the port, `publish-traces` reported 82 run logs referenced by
  `results.json` that had no source here and no published copy.
- `--resume`, `monitor`, `rescore`, `retrace --run` and `corpus:ingest` have no
  runs to work on here, and any response cached only in the source is paid for
  again.
- `verify-results`, `retrace` and `rescore-artifact` read the source's sweeps
  without writing anything. Point them there with
  `SWEEPS_DIR=<path-to-benebsworth.com>/sweeps`. The MCP server
  does not read `SWEEPS_DIR`.
- Do not point `publish-traces`, `sweep-clean` or `sweep-recovery` (the monitor)
  at the source. They write or delete under `SWEEPS_DIR`: `publish-traces` prunes
  traces, `sweep-clean` deletes run directories, and the monitor writes
  `recovery.log` and a lock there.

## MCP server

`scripts/bench-mcp.mjs` serves the board read-only. This package does not own
the token-horizon root's `.mcp.json`, so add the entry there:

```json
{ "mcpServers": { "bench": { "command": "npx", "args": ["--prefix", "benchmarks", "tsx", "benchmarks/scripts/bench-mcp.mjs"] } } }
```

Clients start it from the token-horizon root. The server changes to its own
package directory when it starts, so the root is only the launch directory.

## Results

The published leaderboard is `lib/lab/llm-benchmark/results.json`. It is written
incrementally after each completed task and model job, and each write re-reads
the file first. Curator ratings are kept separately in
`lib/lab/llm-benchmark/feedback.json` and never enter `results.json`.

Each record carries two scores. `score` is the mean over the iterations that
produced an artifact, which is the number stored before scorer version 2. The
new `scoreAllTrials` divides the same sum by every requested iteration, so an
iteration that produced nothing counts as zero, and a model that failed some of
its trials cannot look better than its record says. Records written under scorer
version 2 carry `scorerVersion: 2`; records without the field are version 1
(see `docs/lab/llm-benchmark/scorer-changelog.md`). `npx tsx scripts/verify-results.mjs`
checks that `scoreAllTrials` is present, within 0 to 100, and no higher than
`score` on version-2 records.
