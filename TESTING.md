# TESTING.md — Token Horizon validation stack

How to validate changes locally. Start with `task --list`; the standard gates are:

| Command | What it runs | When |
|---|---|---|
| `task validate` | `lint` + full `test` (mirrors CI) | Before every PR |
| `task lint` | SwiftLint, errors fail / warnings burn down | After touching Swift |
| `task test` | Full XCTest suite (~2 min, run serially) | Before merging |
| `task test-catalog` | Fast catalog/discovery slice | Iterating on models/pricing |
| `task test-perf` | Budget-gated Models-pipeline guard | Touching pipeline/views |
| `task test-integration` | Loopback Ollama proxy round-trips | Touching telemetry proxy |
| `task test-race` | Thread-sanitized suite (slow) | Concurrency-adjacent changes |
| `task web-test` | Worker + MCP contract tests + Playwright UI suite + budgets (CI `web` job) | Touching `docs/`, `cloud/cloudflare/`, `clients/mcp/` |
| `task bench-leaderboard` | Dashboard render/chart/search/explorer budgets | Touching `docs/leaderboard.html` |
| `task models-refresh` | Regenerate `docs/data/models.json` from the app pipeline | Catalog export changes |
| `task smoke` | Live checklist vs the running app | After `make-app.sh` relaunch |
| `task doctor` | Toolchain + env check | New machine / weird failures |

The Taskfile is the single task runner (the Makefile was retired); `task --list` shows every entry point.

## Layers

- **Lint** (`.swiftlint.yml`, CI step 1): `swiftlint lint` exits non-zero on
  errors only. Warnings are burn-down — do not add new ones (check
  `swiftlint lint` output for your files). Legacy god files are capped at
  warning level until split; error thresholds sit just above current maxima
  to forbid new growth.
- **Unit** (`Tests/TokenHorizonPerfTests/Unit/`): pure-logic suites. Rules:
  no network, no `$HOME`, no shared-singleton mutation — use pure functions,
  fixtures, or UUID-scoped temp state. New parsers/fetchers must factor the
  logic into a pure static (see `parseModelsDev` / `parseOpenRouterModels` /
  `scrapeDeepSeekPricing`) with fixture-driven tests.
- **Fixtures** (`Tests/.../Fixtures/`, wired via `Package.swift` resources,
  loaded with `Bundle.module.url(forResource:subdirectory: "Fixtures")`):
  `catalog-7300.json` (perf), `models-dev-sample.json` + `openrouter-sample.json`
  (ingestion shapes). Keep fixtures small and shaped like the real APIs.
- **Integration** (`Tests/.../Integration/`): loopback-only round-trips
  (Ollama proxy). Live provider calls are forbidden — instead test the
  parse/merge functions with fixtures, and validate live behavior with
  `task smoke` against your own running app.
- **Perf** (`Tests/.../Perf/`): budget-gated suites; a `REGRESSION` failure
  means the pipeline got slower (see AGENTS.md performance budgets). Run
  `./scripts/models/test-models-perf.sh --bench` for numbers without asserts.
- **Smoke** (`task smoke`, implemented task-natively in `Taskfile.yml`): the AGENTS.md checklist
  as code — build-stamp identity (`/health` commit vs `git rev-parse`),
  `/stats`, `/trends`, `/limits`, `/models`, `/models/catalog`, `/discovery/status`, and the MCP
  `tools/list` round-trip. First failure mode is always "stale binary":
  rebuild, don't debug data.

## Concurrency rules for the stack itself

- Never overlap two `swift build` / `swift test` invocations (shared
  `.build` dir): overlapping runs corrupt artifacts and produce phantom
  test failures that vanish on a clean serial rebuild.
- If results look impossible, `task clean` and re-run once, serially.
- Tests must pass serially as run by `swift test` / CI; do not rely on
  execution order (singletons: prefer pure functions or unique ids).

## CI

`.github/workflows/ci.yml` runs `swiftlint lint` then `swift test` on
`macos-15` for pushes to `main` and PRs. Releases stay tag-driven
(`release.yml` builds via `scripts/app/make-app.sh`, the ONLY supported launcher).
