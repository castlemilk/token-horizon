---
name: model-catalog-discovery
description: Deep discovery and population of the model catalog table — scans models.dev, Ollama local models, opencode providers, and benchmark sources (SWE-bench, LiveCodeBench, DeepSWE) to enrich model cards, pricing, context windows, and performance data. Use when user wants to populate, refresh, or deeply enrich the MODELS table.
---

# Model Catalog Discovery

Use ONLY when the user wants to populate, refresh, or deeply enrich the MODELS table with model cards, pricing, benchmarks, and provider metadata.

## What it does

- **Discovers all models** from every source and merges into one canonical catalog displayed in the MODELS tab.
- Populates pricing (`in/out/cache per 1M`), context windows, provider, and tooling capabilities.
- Enriches with benchmark scores (SWE-bench Verified, LiveCodeBench, DeepSWE, AIME, GPQA) and renders them in sortable columns.
- Renders provider logos, model cards, and links to official docs.

## Sources (merged, deduped)

| Source | How discovered | Fields populated |
|---|---|---|
| **models.dev** (`https://models.dev/api.json`) | Cached 24h to `~/.config/token-horizon/models-cache.json` | `input/output/cache per 1M`, `contextK`, `tool_call`, `reasoning`, `vision`, `open_weights`, `docUrl`, `providerName` |
| **Ollama local** (`http://localhost:11434/api/tags` + `POST /api/show`) | Live scan via `OllamaClient.fetchInstalled()` + `modelCard(for:)` | `size`, `capabilities` (vision/tools/thinking), `parameter_size`, `quantization`, `context_length`, `modified_at`; synthetic `ModelUsage` rows with `0 tokens` so filter `LOCAL` finds them |
| **opencode usage** (`UsageEngine` + `ModelUsage`) | `~/.local/share/opencode/opencode.db` messages + JSONL scanners (claude/codex/kimi) | Live `tokensAll/tokensToday`, `cost`, `cacheReadAll`, `estCost`, `isLocal` flag; drives `TOK` and `$$` sort keys |
| **Benchmarks** (`~/.config/token-horizon/benchmarks.json` + bundled `Resources/benchmarks.json`) | Curated JSON `entries[].{match,name,swe,lcb,aime,gpqa,source}` — editable by user | `swe` (SWE-bench Verified), `lcb` (LiveCodeBench), plus `DeepSWE` when present; rendered as colored badges |

## Discovery flow

1. **Fetch** `ModelCatalog.ensureLoaded()` — merges `models.dev` + `benchmarks.json` into `ModelCatalog.byId` (`provider/model` lowercased keys). Falls back to `models-cache.json` on network failure, then to pure `benchmarks.json` entries.
2. **Scan Ollama** — `AppDelegate.refreshOllama()` polls `/api/tags` (every 60s + on `refreshModelExtras`). Each installed model becomes a synthetic `ModelUsage` (`provider=ollama`, `free=true`) so the table shows it even with `0 tokens`.
3. **Merge for display** — `DashboardTabs.filteredModelRows` builds `[ModelRow]` from `usage.models + syntheticModels`, dedupes by `provider/model`, enriches each via `ModelCatalog.lookup(id:)`, and sorts by the active column. `providerDisplay` falls back to `ollama` model name parsing.
4. **User can edit** `Resources/benchmarks.json` (or `~/.config/token-horizon/benchmarks.json` override) to add `match` keys, then trigger a reload via `ModelCatalog.fetchAndMerge()` (exposed as `refreshModelExtras` notification).

## Table behavior

- **Search**: `modelSearch` filters on `model`/`provider`/`catalog.name` (case-insensitive substring). `X` clears.
- **Filter scope**: `ModelFilterScope` (`ALL` / `LOCAL` / `REMOTE` / `FREE`) — counts shown on pill.
- **Sortable columns**: `TOK` (tokensAll), `$$` (effectiveCost), `SWE`, `A-Z` — `ModelSort` enum. Header tap cycles sort. SWE sorts `nil` to bottom.
- **Columns**: `Model & Provider` + monogram logo (`ProviderLogoView`), `CTX` (contextK), `IN/1M` `OUT/1M` `CACHE`, `SWE-BENCH` (colored badge), `LCB`, `SPEED` (tok/s, benchmark button), `USAGE` (optional toggle + sparklines), `LINK` (docUrl via `NSWorkspace.open`).
- **Row detail**: Click any row → sheet `ModelDetailView` (model card): full description, provider, context window, pricing table, capabilities (reasoning/tool_call/vision/open_weights), all benchmark scores with sources, local speed benchmark history, usage sparklines, and `Open Docs` / `Benchmark` actions. Implemented as `ModelRowView.onTapGesture` → `selectedModel: ModelRow?` → `.sheet(item:)`.

## Populating deeply

To force a deep refresh (e.g., after editing `benchmarks.json` or installing a new Ollama model):

```bash
rm ~/.config/token-horizon/models-cache.json
# then in Token Horizon: MODELS tab is already live — it re-fetches on next 60s tick, or
# trigger manually:
osascript -e 'tell application "Token Horizon" to activate'
# or via MCP/HTTP:
curl -s http://127.0.0.1:8765/health
```

Or dispatch from code: `ModelCatalog.shared.ensureLoaded()` is called on `refreshModelExtras`.

## Files

- `Sources/TokenHorizon/ModelCatalog.swift` — fetch/merge/cache + `lookup(id:)` + `docUrl(for:...)`
- `Sources/TokenHorizon/OllamaClient.swift` — `/api/tags`, `/api/show`, speed benchmarking, bench cache at `~/.config/token-horizon/ollama-benchmarks.json`
- `Resources/benchmarks.json` / `~/.config/token-horizon/benchmarks.json` — curated benchmark entries
- `Sources/TokenHorizon/Views.swift` — `ModelRow`, `ModelRowView` (hover + tap), `ModelDetailView`, `filteredModelRows`, header/sort logic
