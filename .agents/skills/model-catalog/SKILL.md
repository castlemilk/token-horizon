---
name: model-catalog
description: >-
  Guidelines, procedures, and tools for updating, auto-discovering, normalizing, and populating model catalog entries,
  SWE-bench/LiveCodeBench benchmarks, pricing rates, context limits, and provider brand identities in Token Horizon.
---

# Model Catalog, Auto-Discovery & Benchmark Management Skill

This skill explains how Token Horizon discovers, auto-syncs, normalizes, deduplicates, and renders AI model entries across cloud API providers, coding plans, and local Ollama instances.

---

## 1. Multi-Tier Auto-Discovery Architecture

Token Horizon auto-discovers newly released models and pricing through four interconnected channels:

1. **Live Provider API Polling & Direct Source Injection (`ModelCatalog.swift`)**:
   - **OpenAI Tiered Architecture**: Direct injection and discovery for GPT-5 Sol (flagship), GPT-5 Terra (balanced), GPT-5 Luna (fast), GPT-5 Codex, GPT-4.5, GPT-4o, o1, o3, o4.
   - **Google Gemini & Gemma**: Direct discovery and specs for Gemini 3.7 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 2.5 Pro, Gemini 2.5 Flash, Gemma 4, Gemma 3, Imagen 4, Veo 3.1.
   - **Zhipu GLM**: Dynamically queries `https://open.bigmodel.cn/api/paas/v4/models` using the user's `zai-coding-plan` / `zai` key from `auth.json`. New releases (e.g. `glm-5.3-flash`, `glm-5.3`, `glm-5-turbo`, `glm-4.5-air`) are immediately registered with live capabilities and coding plan rates.
   - **DeepSeek**: Direct source calibrated rates for DeepSeek V4 Pro, DeepSeek V3, DeepSeek R1, DeepSeek Coder.
   - **Moonshot Kimi & MiniMax**: Probed via dynamic model endpoints when user plan credentials are present (Kimi K2, MiniMax M3).
   - **Cohere, Amazon Nova, Perplexity, xAI Grok, Mistral, Meta LLaMA**: Universal canonical identification and provider branding across 204+ providers.
   - **Local Ollama Runtime**: Live poll of `http://localhost:11434/api/tags` auto-detects newly pulled local models, parameter sizes, and quantization.

2. **Remote Provider Catalog (`models.dev/api.json`)**:
   - Automatically downloaded on startup and periodic background timer (every 30m).
   - Ingests pricing ($/1M input, output, cache-read), context windows, reasoning flags, tool call, and vision capabilities across 7,300+ models and 204 providers.
   - Persisted to local cache: `~/.config/token-horizon/models-cache.json`.

3. **Session Usage Auto-Ingestion**:
   - Any model actively used in OpenCode sqlite databases (`message.data`), Claude Code credentials, or Codex logs is automatically parsed, registered, and attributed.

4. **Curated Ground-Truth Benchmarks (`Resources/benchmarks.json`)**:
   - Verified SWE-bench Verified %, LiveCodeBench %, AIME 2024, and GPQA Diamond scores mapped by regex/normalized key.

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
  - `qwen3-coder-flash` → `Qwen 3 Coder Flash` (Provider: `Alibaba Cloud`)
  - `claude-4-sonnet` → `Claude 4 Sonnet` (Provider: `Anthropic`)
* **Deduplication Hierarchy**:
  - Aggregator and reseller endpoints (Bedrock, Vertex, Azure, OpenRouter) collapse under the canonical primary creator.
  - Multi-host availability is highlighted via the `N hosts` pill.

---

## 3. Performance & Sorting Invariants

* **Sort Responsiveness**: Clicking table headers triggers `recomputeFilteredRows(force: true)`. The caching key `baseKey` includes `catalog.count`, `usage.count`, `synthetic.count`, `search`, `scope`, `sortColumn`, and `sortAscending` to ensure instant re-sorting.
* **Pipeline Execution**: Filtering and sorting run asynchronously in `Task.detached(priority: .userInitiated)` via `ModelsPipeline.compute`, preserving 60fps UI responsiveness across 7,300+ entries.

1. **In-App Manual Sync**: Click **`[ 🔄 SYNC ]`** in the MODELS tab toolbar to immediately query live provider APIs and remote catalog without restarting.
2. **Catalog Update Script** (`scripts/update-catalog.py`):
   ```bash
   python3 scripts/update-catalog.py --fetch-remote
   ```
