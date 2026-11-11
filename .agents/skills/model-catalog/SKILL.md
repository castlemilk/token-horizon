---
name: model-catalog
description: >-
  Guidelines, procedures, and tools for updating, auto-discovering, normalizing, and populating model catalog entries,
  SWE-bench/LiveCodeBench benchmarks, pricing rates, context limits, and provider brand identities in Token Horizon.
---

# Model Catalog, Auto-Discovery & Benchmark Management Skill

This skill explains how Token Horizon discovers, auto-syncs, normalizes, deduplicates, and renders AI model entries across cloud API providers, coding plans, and local Ollama instances.

This skill covers the catalog itself: its sources, refresh cadences, benchmark tables, canonical names and the update scripts. For the MODELS table's search, filters, sort columns, row detail and the SYNC button, see `model-catalog-discovery`.

---

## 1. Multi-Tier Auto-Discovery Architecture

Token Horizon auto-discovers newly released models and pricing through four interconnected channels:

1. **Live Provider API Polling & Direct Source Injection (`clients/macos/Sources/TokenHorizon/Catalog/ModelCatalog.swift`)**:
   - **OpenAI Tiered Architecture**: Direct flagship rows for GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol and Luna, GPT-5.6 and GPT-5 Sol, Terra and Luna (`injectDirectFlagships`, `ModelCatalog.swift:2058`). The rules at `ModelCatalog.swift:1425` also cover GPT-4o, GPT-4.5, o1, o3 and o4. Live model list from `fetchLiveOpenAIModels` (`:2419`).
   - **Google Gemini & Gemma**: Direct flagship rows for Gemini 3.7 Flash, Gemini 3.5 Flash, Gemini 2.5 Pro and Gemini 2.5 Flash (`ModelCatalog.swift:2124-2140`). Any id containing `gemini`, `gemma`, `imagen` or `veo` is matched by rule (`ModelCatalog.swift:1359`). Live model list from `fetchLiveGeminiModels` (`:2686`).
   - **Anthropic & OpenRouter**: live model lists from `fetchLiveAnthropicModels` (`ModelCatalog.swift:2640`) and `fetchLiveOpenRouterModels` (`:2727`).
   - **Zhipu GLM**: Dynamically queries `https://open.bigmodel.cn/api/paas/v4/models` using the `zai-coding-plan` or `zai` key from the opencode `auth.json` (`PlanLimitsEngine.authKeys()`, `fetchLiveZaiModels`, `ModelCatalog.swift:2238-2241`). New releases (e.g. `glm-5.3-flash`, `glm-5.3`) are registered from that live response.
   - **DeepSeek**: Direct flagship rows for DeepSeek V4.1 Flash and DeepSeek V4 Pro (`-0813`), with authoritative Pro pricing (`ModelCatalog.swift:2145-2150`). Live model list from `fetchLiveDeepSeekModels` (`:2493`).
   - **Moonshot Kimi & MiniMax**: No live model list is fetched for either vendor; their rows come from the shared sources. Canonical provider and display names come from the model-id rules in `resolveIdentity` (`ModelCatalog.swift:1518-1536`). For an id the catalog does not hold, `lookup(id:)` synthesizes an entry with estimated pricing (`ModelCatalog.swift:753-778`).
   - **Cohere, Amazon Nova, Perplexity, xAI Grok, Mistral, Meta LLaMA**: Universal canonical identification and provider branding across 204+ providers.
   - **Local Ollama Runtime**: Live poll of `http://127.0.0.1:11434/api/tags` (`OllamaClient.swift:32`; the telemetry proxy's URL is used instead when it sets one) auto-detects newly pulled local models, parameter sizes, and quantization.

2. **Remote Provider Catalog (`models.dev/api.json`)**:
   - Downloaded at startup. The Swift app refetches when its last successful fetch is older than 600 s (`ModelCatalog.remoteRefreshInterval`, `ModelCatalog.swift:1043`), checked on each 60 s tick. When the dashboard or the MODELS tab appears, the app uses a 120 s interval instead (`interactiveRefreshInterval`, `ModelCatalog.swift:1046`, used at `DashboardTabs.swift:123` and `:2841`). A failed fetch is retried after 60 s (`failedRetryInterval`). The Go daemon reloads when its catalog was last loaded more than 24 h ago (`daemons/go/internal/providers/catalog/catalog.go:133`). That timestamp is set on every load, including a load from the cache file. `ModelDiscoveryEngine` also runs a 300 s timer that refetches the live provider lists and starts a models.dev fetch when the last successful one is older than 600 s (`LocalModels/ModelDiscoveryEngine.swift:150-157`, `:290-325`).
   - Ingests pricing ($/1M input, output, cache-read), context windows, reasoning flags, tool call, and vision capabilities across 7,300+ models and 204 providers.
   - Persisted to local cache: `~/.config/token-horizon/models-cache.json`. The Swift app writes its encoded catalog there after each successful fetch and reads it back when a fetch fails. The Go daemon reads and writes the same file.

3. **Session Usage Auto-Ingestion**:
   - Models that appear in usage data are added as rows: OpenCode's `opencode.db` message data (`UsageEngine.swift:2884-2895`) and the per-tool JSONL logs (for example `scanKimi`, `UsageEngine.swift:1045`). Codex's `~/.codex/models_cache.json` is read into the catalog (`fetchCodexCachedModels`, `ModelCatalog.swift:2301`).

4. **Curated and Sourced Benchmark Tables**: see the Benchmark Tables section below.

---

## 2. Dynamic Canonical Normalization

When a new model is discovered (e.g. `gpt-5-sol`, `glm-5.3-flash`, `gemini-3.7-flash`, `deepseek-v4-pro`, `qwen3-coder-flash`, `claude-4-sonnet`), Token Horizon's `ModelCatalog.canonicalIdentity` and `formatModelDisplayName` dynamically parse and format the model:

* **Variant & Suffix Preservation**: Retains differentiating suffixes like `Sol`, `Terra`, `Luna`, `Flash`, `Pro`, `Plus`, `Turbo`, `Coder`, `Reasoner`, `Air`, `Mini`, `Ultra`, `Thinking`, while stripping transient snapshot dates (e.g. `-20250219`, `-0813`, `-latest`).
* **Title Formatting**:
  - `gpt-5-sol` → `GPT-5 Sol` (Provider: `OpenAI`)
  - `gpt-5-terra` → `GPT-5 Terra` (Provider: `OpenAI`)
  - `gpt-5-luna` → `GPT-5 Luna` (Provider: `OpenAI`)
  - `gemini-3.7-flash` → `Gemini 3.7 Flash` (Provider: `Google`)
  - `glm-5.3-flash` → `GLM 5.3 Flash` (Provider: `Zhipu AI`)
  - `deepseek-v4-pro` → `DeepSeek V4 Pro` (Provider: `DeepSeek`)
  - `qwen3-coder-flash` → `Qwen3 Coder Flash` (Provider: `Alibaba Cloud`; the `qwen3` token is capitalized as one word, `ModelCatalog.swift:1094`)
  - `claude-4-sonnet` → `Claude 4 Sonnet` (Provider: `Anthropic`)
* **Deduplication Hierarchy**:
  - Aggregator and reseller endpoints (Bedrock, Vertex, Azure, OpenRouter) collapse under the canonical primary creator.
  - Multi-host availability is highlighted via the `N hosts` pill.

---

## 2b. Benchmark Tables

Two JSON tables supply scores. Both list entries under a top-level `entries` array, and each entry is keyed by its `match` string.

* **Curated table** (`clients/macos/Resources/benchmarks.json`, 101 entries). Scores transcribed from provider announcements. Fields: `match`, `name`, `swe`, `lcb`, `aime`, `gpqa`, `approx`, `source`. `swe` is SWE-bench Verified % and `lcb` is LiveCodeBench %. `aime` and `gpqa` are read only by the web export (`clients/macos/Sources/TokenHorizon/Catalog/ModelCatalogExport.swift:404-426`), not by the app. `approx: true` marks an estimate.
* **Sourced table** (`clients/macos/Resources/benchmarks-sourced.json`, 100 entries). Generated by `scripts/refresh-sourced-benchmarks.py`, which fetches the SWE-bench leaderboard data and the LiveCodeBench v5 data and writes the file (`--check` reports without writing). Fields: `match`, `name`, `swe`, `lcb`, `approx`, `source`. `swe` is the best SWE-bench Verified run per model on the leaderboard. `lcb` is LiveCodeBench v5 pass@1 averaged over the questions released with the model. Each `source` names the board; SWE-bench entries also carry the run date.

**Merge rule** (`ModelCatalog.loadBenchmarks`, `ModelCatalog.swift:2857`): the curated table is read first and wins. A sourced entry is used only when no curated entry matches the same key or one of its separator and date variants (`benchmarkKeyVariants`). Entries with neither `swe` nor `lcb` are name aliases and are skipped.

**Override file**: the Swift loader (`resourceJSONCandidates`, `ModelCatalog.swift:3011-3019`) lists the bundled copy first, then `~/.config/token-horizon/benchmarks.json`. The bundled copy is copied into the app by `scripts/make-app.sh`, so the user file is used only when no bundled copy is found. The Go daemon is different: it reads `~/.config/token-horizon/benchmarks.json` whenever that file exists and uses it in place of its embedded copy (`daemons/go/internal/providers/catalog/benchmarks.go:40`).

**Go daemon copy**: `daemons/go/internal/providers/catalog/benchmarks.json` is embedded in the daemon. It has 94 entries, so it is not identical to the 101-entry Swift copy. The daemon reads neither the sourced table nor the AIME and GPQA fields.

---

## 3. Performance & Sorting Invariants

* **Sort Responsiveness**: Clicking table headers calls `recomputeFilteredRows(force: true)` (`clients/macos/Sources/TokenHorizon/UI/DashboardTabs.swift:2878-2890`). The cache key `ModelsPipeline.baseKey` (`clients/macos/Sources/TokenHorizon/Catalog/ModelsPipeline.swift:61-74`) includes the catalog count and revision, the usage and synthetic row counts, a content fingerprint of the usage rows, `search`, `scope`, the plan filter, `sortColumn` and `sortAscending`.
* **Pipeline Execution**: Filtering and sorting run asynchronously in `Task.detached(priority: .userInitiated)` via `ModelsPipeline.compute`, preserving 60fps UI responsiveness across 7,300+ entries.

1. **In-App Manual Sync**: Click **SYNC** (arrow icon) in the MODELS toolbar (`DashboardTabs.swift:2722`) to run a catalog cycle now. It calls `ModelCatalog.refreshRemote()`, which fetches models.dev and the live provider lists and reloads both benchmark tables. No restart is needed.
2. **Catalog Update Script** (`scripts/update-catalog.py`):
   ```bash
   python3 scripts/update-catalog.py            # report differences only
   python3 scripts/update-catalog.py --add-missing --dry-run
   ```
   `clients/macos/Resources/benchmarks.json` is the single source of truth for scores (commit `e12cd82`); to change a curated score, edit that file directly. The script compares its `CURATED_BENCHMARKS` list (68 rows) with the file, matched by `match`, prints the rows that differ and the curated rows the file lacks, and writes nothing by default. `--add-missing` appends the missing rows and never changes an existing one; `--overwrite` also applies the script's values to existing rows; `--dry-run` prints what would be written. No run drops a row, and unknown arguments are an error. `--fetch-remote` only checks that models.dev parses: the script does not write `~/.config/token-horizon/models-cache.json`, which the app and the Go daemon write themselves in the `[String: Entry]` shape they decode (`ModelCatalog.swift`, `daemons/go/internal/providers/catalog/catalog.go`).
3. **Web Export**: `scripts/refresh-models.sh` (or `task models-refresh`) regenerates `docs/data/models.json` through the app's own pipeline. The `models-refresh` workflow (`.github/workflows/models-refresh.yml`, cron `17 */6 * * *`) runs every 6 hours and commits the file when it changes.
