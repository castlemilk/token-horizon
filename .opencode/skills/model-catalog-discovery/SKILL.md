---
name: model-catalog-discovery
description: Deep discovery and population of the model catalog table — scans models.dev, Ollama local models, opencode providers, and benchmark sources (SWE-bench Verified, LiveCodeBench) to enrich model cards, pricing, context windows, and performance data. Use when user wants to populate, refresh, or deeply enrich the MODELS table.
---

# Model Catalog Discovery

Use ONLY when the user wants to populate, refresh, or deeply enrich the MODELS table with model cards, pricing, benchmarks, and provider metadata.

For the catalog's sources, refresh cadences, the two benchmark tables and the update scripts, see `model-catalog`. This skill covers the MODELS table itself: how rows are built, searched, filtered, sorted and shown in the detail sheet.

## What it does

- **Discovers all models** from every source and merges into one canonical catalog displayed in the MODELS tab.
- Populates pricing (`in/out/cache per 1M`), context windows, provider, and tooling capabilities.
- Enriches with benchmark scores (SWE-bench Verified and LiveCodeBench) and renders them in the sortable SWE-BENCH and LCB columns. AIME and GPQA scores are carried only into the web export.
- Renders provider logos, model cards, and links to official docs.

## Sources (merged, deduped)

| Source | How discovered | Fields populated |
|---|---|---|
| **models.dev** (`https://models.dev/api.json`) | Swift app refetches when its last success is over 600 s old (120 s when the dashboard or MODELS tab appears); the Go daemon when its catalog was loaded more than 24 h ago. Cache: `~/.config/token-horizon/models-cache.json` | `input/output/cache per 1M`, `contextK`, `tool_call`, `reasoning`, `vision`, `open_weights`, `docUrl`, `providerName` |
| **Ollama local** (`http://127.0.0.1:11434/api/tags` + `POST /api/show`) | Live scan via `OllamaClient.fetchInstalled()` + `modelCard(for:)` | `size`, `capabilities` (vision/tools/thinking), `details.parameter_size`, `details.quantization_level`, `details.context_length`, `modified_at`; synthetic `ModelUsage` rows with `0 tokens` so filter `LOCAL` finds them |
| **opencode usage** (`UsageEngine` + `ModelUsage`) | `~/.local/share/opencode/opencode.db` messages + JSONL scanners (claude/codex/kimi) | Live `tokensAll/tokensToday`, `cost`, `cacheReadAll`, `estCost`, `isLocal` flag on each row |
| **Benchmarks** (curated `clients/macos/Resources/benchmarks.json` and sourced `clients/macos/Resources/benchmarks-sourced.json`) | Merged by `ModelCatalog.loadBenchmarks`, curated first. Both are JSON `entries[]` with `match`; see `model-catalog` for fields and the override rules | `swe` (SWE-bench Verified) and `lcb` (LiveCodeBench) shown in the table and detail sheet; `aime`/`gpqa` only in the web export |

## Discovery flow

1. **Fetch** `ModelCatalog.ensureLoaded()` — merges `models.dev` and both benchmark tables into `ModelCatalog.byId` (keys are lowercased ids, both bare and `provider/model`). Falls back to `models-cache.json` when the network fetch fails. Only when the catalog is still empty does it fall back to the benchmark tables alone.
2. **Scan Ollama** — `AppDelegate.refreshOllama()` polls `/api/tags` (every 60s, and on the `refreshModelExtras` notification). Each installed model becomes a synthetic `ModelUsage` (`provider=ollama`, `free=true`) so the table shows it even with `0 tokens`.
3. **Merge for display** — `DashboardTabs.recomputeFilteredRows()` (`UI/DashboardTabs.swift:2917`) calls `ModelsPipeline.compute` (`Catalog/ModelsPipeline.swift:76`). It builds `[ModelRow]` from the catalog entries, `syntheticModels` and `usageModels`, groups rows by the canonical family from `ModelCatalog.canonicalIdentity`, looks up each catalog entry (`ModelCatalog.lookup(id:)`, `ModelsPipeline.swift:109`), and sorts by the active column. `providerDisplay` returns `Ollama (Local)`, `MLX (Local)`, `Splash (Local)` or `TH Engine (Local)` for a local row, else the catalog `providerName`, else a provider-id map (`UI/ModelsViews.swift:20-51`).
4. **User can edit** `clients/macos/Resources/benchmarks.json` to add `match` keys. The installed app reads the copy inside its bundle first (`resourceJSONCandidates`, `Catalog/ModelCatalog.swift:3016-3027`), which `scripts/make-app.sh:177-180` copies from the repository at build time, so rebuild and reinstall with `./scripts/make-app.sh` for the edit to take effect. SYNC (`ModelCatalog.refreshRemote()`, `UI/DashboardTabs.swift:2722`) re-reads whichever copy resolves first, which for the installed app is the bundled one. `~/.config/token-horizon/benchmarks.json` is read only when no bundled copy is found. See `model-catalog` for the override rules. The `refreshModelExtras` notification is posted when the catalog changes (`Catalog/ModelCatalog.swift:994`, `:1739`), when the installed Ollama tag set changes (`LocalModels/ModelDiscoveryEngine.swift:284`) and when a speed benchmark finishes (`LocalModels/OllamaClient.swift:181`). Its observers re-poll Ollama and recompute the table; it does not reload the catalog.

## Table behavior

- **Search**: `modelSearch` matches, case-insensitively, the display name, model id, provider, provider display name, description, parameter size, quantization and the name or short name of a covering plan (`Catalog/ModelsPipeline.swift:355-366`). The `X` button clears it (`UI/DashboardTabs.swift:2611`).
- **Filter scope**: `ModelFilterScope` (`UI/ModelsViews.swift:290`): `ALL`, `CLOUD`, `LOCAL`, `FREE / OPEN`, `BENCHMARKED`, `USED`. A plan filter (`ModelPlanFilter`) applies on top. Each chip shows its row count (`UI/DashboardTabs.swift:2630-2635`).
- **Sortable columns**: every column header sorts by `ModelTableColumn` (`UI/ModelsViews.swift:277`): `MODEL`, `CTX`, `IN / 1M`, `OUT / 1M`, `CACHE`, `SWE-BENCH`, `LCB`, `SPEED`, `USAGE`. Tapping a new header selects that column (ascending for `MODEL`, `IN / 1M` and `OUT / 1M`, descending otherwise). Tapping the active header flips the direction (`UI/DashboardTabs.swift:2878-2890`). The default is `SWE-BENCH` descending (`UI/DashboardTabs.swift:30-31`). A missing score sorts as `-1`, so with descending order it lands at the bottom.
- **Columns**: `MODEL & PROVIDER` (sort column `MODEL`) with provider logo (`ProviderLogoView`), `CTX` (contextK), `IN / 1M`, `OUT / 1M`, `CACHE`, `SWE-BENCH` (colored badge), `LCB`, `SPEED` (tok/s; for a local row the cell is a button that runs `OllamaClient.benchmark`, shown as `⚡ Test` until a speed is measured, `UI/ModelsViews.swift:467-509`; cloud rows show `API`; the toolbar `BENCHMARK` button benchmarks every local model, `UI/DashboardTabs.swift:2703-2719`), `USAGE` (optional, toggled by the `+ USAGE COL` toolbar button; tokens and cost, `UI/ModelsViews.swift:512-524`), and `LINK`, a text header with no sort. Each cloud row's `LINK` cell opens the docs URL with `NSWorkspace.shared.open` (`UI/ModelsViews.swift:533`).
- **Row detail**: Click any row → sheet `ModelDetailView` (`UI/ModelsViews.swift:800`): full description, provider, capability pills (`LOCAL`, `REASONING`, `TOOLS`, `VISION`, `FREE`), discount and plan-coverage blocks, context window and pricing stats, model-card facts (release date, knowledge cutoff, max output), the SWE-bench Verified and LiveCodeBench scores with their source, a `Your Usage` block (tokens, cost, cache hit) when the model has usage, local model configuration metadata for local rows, and a `Docs` button. Implemented as `ModelRowView` → `.onTapGesture { selectedRow = row }` (`UI/DashboardTabs.swift:2787`) → `selectedRow: ModelRow?` → `.sheet(item: $selectedRow)` (`UI/DashboardTabs.swift:154`).

## Populating deeply

To force a deep refresh (e.g., after a rebuild that ships an edited `benchmarks.json`, or to pull newly released remote models), press the SYNC button in the MODELS toolbar. It calls `ModelCatalog.shared.refreshRemote()`, which runs a fetch cycle now, reloads both benchmark tables, and rewrites `models-cache.json` on success. Deleting `~/.config/token-horizon/models-cache.json` does not force a fetch. It only removes the offline fallback, which the next successful fetch rewrites.

Ollama models are rescanned on the 60 s tick and whenever `refreshModelExtras` is posted, so a newly pulled model appears without a deep refresh.

## Files

- `clients/macos/Sources/TokenHorizon/Catalog/ModelCatalog.swift` — fetch/merge/cache + `lookup(id:)` + `docUrl(for:...)`, `remoteRefreshInterval`, `loadBenchmarks`
- `clients/macos/Sources/TokenHorizon/Catalog/ModelsPipeline.swift` — `compute` (filter, sort, rows), `baseKey`, search
- `clients/macos/Sources/TokenHorizon/LocalModels/OllamaClient.swift` — `/api/tags`, `/api/show`, speed benchmarking, bench cache at `~/.config/token-horizon/ollama-benchmarks.json`
- `clients/macos/Resources/benchmarks.json` and `clients/macos/Resources/benchmarks-sourced.json` — curated and sourced benchmark tables (see `model-catalog`)
- `clients/macos/Sources/TokenHorizon/UI/ModelsViews.swift` — `ModelRow`, `ModelRowView` (hover + tap), `ModelDetailView`, `ModelTableColumn`, `ModelFilterScope`
- `clients/macos/Sources/TokenHorizon/UI/DashboardTabs.swift` — MODELS toolbar and SYNC button, `recomputeFilteredRows`, header sort handling, row sheet
