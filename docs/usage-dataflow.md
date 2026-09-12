# Usage data flow — where information lives and how it travels

This document traces a single LLM request through Token Horizon: measured at
the wire, attributed to a tool, priced, bounded by account limits, stored
locally, read back by local consumers, and (optionally) pushed to the cloud.

Design rules (invariant #14): **meters measure, files annotate, limits
bound — and everything is stored raw at full resolution.** Provider/tool
session files never create or modify usage rows; vendor/model spellings are
stored as received and canonicalized only at query time; the meter's
observations and the file's claims coexist and their rank is resolved on
read, not merged on write.

---

## 1. The pipeline at a glance

```
 tool (claude code / codex / pi / opencode / kimi cli / ...)
        │  HTTP via loopback meter port (user points tool's base URL at it)
        ▼
 ┌─────────────────────── RequestMeter ───────────────────────┐
 │  relays bytes unchanged to the real API and back           │
 │  on completion:                                            │
 │   • tokens (from the PROVIDER's usage payload)             │
 │   • rates: TTFT → prompt tok/s, stream time → gen tok/s    │
 │   • tool label: explicit port label → User-Agent sniff     │
 │   • accountID: SHA-256(truncated) of the credential header │
 │   • requestID (+ alt: Anthropic header req_… AND body msg_…)│
 │   • cost: CostEngine decision                              │
 │   • wire rate limits: x-ratelimit-* / anthropic-ratelimit-*│
 └───────┬──────────────────────────────────────┬─────────────┘
         │ insertMetered(UsageEvent)            │ recordLimits(LimitSnapshot)
         ▼                                      ▼
 ┌───────────────────────────────────────────────────────────┐
 │                 usage.db  (SQLite, WAL)                   │
 │  usage_event ◄── annotate() joins by vendor+request_id ── │
 │  file_annotation ▲─────────────────────────────┘          │
 │  limit_snapshot ◄── meters + quota APIs + codex files     │
 │  context_state, sync_state                                │
 └───────┬───────────────────────────────────────┬───────────┘
         │ local reads (source of truth)         │ push-only deltas
         ▼                                       ▼
  loopback API :8765 (CoreAPIRouter)      CloudSync → cloud DB
  → macOS app / Tauri UI / MCP / shell    (leaderboard derived cloud-side;
                                           offline = deltas accumulate,
                                           cursor advances only on ACK)
```

Files session logs (`.claude/`, `.codex/`, `.pi/`, `.kimi/`, opencode.db) are
polled every 60s by `FilePoller` (consent-gated). They contribute only
`FileAnnotation`s (the file's claim of tool label + tool-reported cost,
keyed by provider request id) and, for codex, `LimitSnapshot`s. Annotations
are stored in their own table and **LEFT JOINed at read time** — timing is a
non-issue by construction: a file line written before or after the response
completes produces exactly the same query result, and no usage row is ever
modified after insert.

---

## 2. Write path, step by step

### 2.1 Measurement (the only usage source)

`Metering/RequestMeter.swift` — one loopback listener per vendor
(`TH_METERS="vendor:port->target,…"` or settings-managed runtime endpoints;
requires `.metering` consent).

Per completed exchange (`event(from:)`):

| Field | Established by |
|---|---|
| `tokens` (input/output/reasoning/cacheRead/cacheWrite) | wire-format parser (`AnthropicMeter`, `OpenAICompatibleMeter`, `GeminiMeter`, `OllamaMeter`) reading the provider's own usage payload |
| `vendor` | the meter's vendor key, canonicalized at insert (`Canonical.vendor`) |
| `model` | request body / path / response, canonicalized at insert |
| `product` + `productSource` | explicit port label (`.explicitLabel`) → User-Agent table (`.headerSniffed`) → later file join (`.fileJoined`) |
| `accountID` | `AccountKey.forRequestHeaders` — vendor + truncated SHA-256 of `Authorization`/`x-api-key` (raw credential never stored) |
| `requestID` / `requestIDAlt` | Anthropic: `request-id` header + body `msg_…` id; OpenAI-style: body `chatcmpl-`/`resp-` id |
| `cost` + `costSource` | `CostEngine.decide` (see §2.3) |
| `promptTokPerSec` / `generationTokPerSec` / `latencyMs` | measured: TTFT and body-streaming duration (Ollama: exact ns durations) |
| `thinkingLevel` / `thinkingRaw` | per-format request parsing, normalized off/low/medium/high/adaptive |
| `attestation` | `.measured` (upgraded to `.reconciled` when cross-checked) |

→ `SQLiteUsageStore.insertMetered` (`Usage/Events/SQLiteUsageStore.swift`):
inserts the row (`INSERT OR IGNORE`, event UUID is the dedup key) **with raw
vendor/model spellings as received**. That is the entire write path — no
reconciliation, no cross-writer merging: there is only one writer.

### 2.2 Attribution and file-sourced limits (files never measure)

`Usage/Consolidation/FileConsolidator.swift` via `FilePoller` (60s,
`.fileReading` consent) or one-off `TH_CONSOLIDATE=1`:

| Tool file | Emits | Join key |
|---|---|---|
| `~/.claude/projects`, `~/.claude/transcripts` | `FileAnnotation(product: "claude-code")` | transcript `requestId` == wire `request-id` header |
| `~/.pi/agent/sessions` | `FileAnnotation(product: "pi", cost: reported)` | `responseId` == body id (OpenAI-style `chatcmpl-`/`resp-`; Anthropic `msg_…` via `request_id_alt`) |
| `~/.codex/sessions` | `LimitSnapshot`s from `rate_limits.primary/secondary` (5h/weekly windows) | — (no request id in codex files → no tool annotation; UA sniff covers codex) |
| `~/.kimi/sessions` `wire.jsonl` | `FileAnnotation(product: "kimi-cli")` when a request id exists (usually absent) | request id |
| opencode.db | `FileAnnotation(product: "opencode", cost: reported)` when the row exposes an upstream response id | response id |

→ `SQLiteUsageStore.annotate`: `INSERT OR IGNORE` into `file_annotation`
(natural key `vendor + request_id`) — nothing else. The join happens in the
read queries (`LEFT JOIN` on `request_id`/`request_id_alt`, at most one
annotation row per usage row). Rank resolution is a query-time decision:

- effective product = `.explicitLabel` > file record > `.headerSniffed`
  (`UsageEvent.effectiveProduct`; the `.product` aggregate groups by the
  same expression in SQL);
- effective cost = file-reported > meter decision
  (`UsageEvent.effectiveCost`, `effectiveCostSource == .reported`) — the
  reported figure reflects the account's actual plan.

A file record with no provider request id yields nothing; unmatched
annotations sit in their table and count for nothing. Spoofed files can
therefore only *mislabel* a real metered request — never inflate usage, and
the meter's own observation is still right there next to the claim.

### 2.3 Cost (`Usage/CostEngine.swift`)

Decision order per request:

1. **reported** — the tool's own file record joins with an actual billed cost
   (pi, opencode). Authoritative; applied by the annotation sweep.
2. **planFree (0)** — subscription/plan vendors (`kimi`, `glm`, `minimax`,
   `alibaba`, `opencode`) and local compute (`ollama`, `vllm`, `sglang`,
   `llamacpp`, `mlx`): zero marginal cost; the quota window tracked by the
   limits channel *is* the cost. Charging list prices here would double count.
3. **computed** — API-billed vendors: `ModelCatalog` pricing × measured
   tokens, cache-read aware (`input·in/1M + output·out/1M + cacheRead·cache/1M`).
4. **unknown (0)** — model not in catalog; no pricing basis.

The vendor×tooling cost difference is inferred through (vendor, model) →
plan table → catalog, and corrected to the true billed figure whenever the
tool reports it.

### 2.4 Limits — three sources, consolidated per vendor account

All limits land in the same `limit_snapshot` table, keyed
`(minute, machine, provider, account_id, label)`:

1. **Wire (freshest)** — meters parse `x-ratelimit-*` (OpenAI-style, reset as
   duration) and `anthropic-ratelimit-*` (reset as RFC3339) response headers
   on every exchange. Account from the request's credential hash. Labels:
   `requests (wire)`, `tokens (wire)`.
2. **Quota APIs** — `LimitsEngine`/`VendorLimitsAdapter` per-vendor pollers
   (`Providers/<Vendor>/`). Multi-account adapters iterate labeled
   credentials (`credentials()`) and stamp `accountKey(for:)` per row
   (Claude does; others default to the single-account key `""`).
3. **Files** — codex `token_count.rate_limits` windows (account unknown →
   `""`), via `CodexConsolidator`.

`AccountKey` (`Usage/AccountKey.swift`) = `canonicalVendor:sha256(credential)[:16]`.
Same credential → same key across sources and restarts; windows for
different accounts of one vendor are separate rows and never merge.
`ProviderLimit.accountID` carries this through to `/limits` and the UI.

### 2.5 Query-time canonicalization and raw storage

Every write stores spellings exactly as the source produced them
(`anthropic` from one meter config, `claude` from a transcript,
`claude-opus-4.5` vs `claude-opus-4-5-20251101` across tools). Resolution to
canonical identity happens only when reading — and **all folds run in SQL**:

- **vendor** folds via `vendorCaseSQL`: `Canonical.vendorTable` rendered as
  a static `CASE` expression in `GROUP BY` and vendor filters (also reused
  for limit `provider` filters);
- **model** folds via the `spelling` table: a read-side cache mapping
  `vendor/raw-model → canonical-model`, refreshed lazily (30s TTL) from
  `SELECT DISTINCT vendor, model`. Aggregations `LEFT JOIN` it and
  `GROUP BY COALESCE(sm.canon, model)`; model filters match through a
  subquery on the canonical form. Stored rows are never rewritten — the
  table is pure derivative state, droppable at any time;

The `CloudSchema` mapper applies the same resolution at the sync boundary,
so the cloud always receives canonical vendor/model and rank-resolved
product/cost while the local store keeps full-resolution raw facts.

### 2.6 Capture modes (point ↔ mitm)

How requests get measured is a swappable mode
(`SettingsStore.meterCaptureMode`, env `TH_CAPTURE_MODE`), selected once at
startup via `CoreAPIRouter.startCaptureMode()`:

- **point (default; corporate-safe)** — tools are explicitly configured at
  loopback meters (`TH_METERS`, runtime endpoints) AND every detected local
  runtime gets an auto-started meter on its deterministic port
  (`LocalInferenceRuntime.defaultMeterListenPort`: ollama 11435, vllm 9311,
  sglang 9312, llamacpp 9313, mlx 9314) via
  `InferenceMonitor.onRuntimeSighting` → `CoreAPIRouter.startAutoMetering`
  (consent-gated, deduped by vendor, retried each poll so late consent
  still converges). Internal clients route through live meters via
  `MeterRegistry.routedURL` — the app's own Ollama traffic is measured on
  the same path, no per-vendor wiring. Nothing is intercepted; every
  measured byte was deliberately routed.
- **mitm (personal machines, opt-in)** — `Metering/Mitm/`: a scoped local
  proxy intercepts TLS **for AI vendor API hosts only**; every other
  connection passes through undecrypted (`tls_clienthello` ignore in the
  addon). The TLS core is delegated to mitmproxy (`mitmdump`); the manager
  owns consent (`.mitm` — never auto-granted), addon deployment, process
  lifecycle, and a setup checklist with user-run remediation commands
  (`GET /meters` → `mitm.next_steps`). Privileged steps (CA trust, proxy
  config) are never performed silently.

Both modes emit identical UsageEvents into the same store — the MITM addon
POSTs to `POST /analytics/events` with `attestation: measured`, so
analytics, annotations, sync, and leaderboards are mode-agnostic. MITM mode
additionally covers hardcoded-endpoint apps (desktop clients, IDEs) whose
traffic cannot be pointed.

### 2.7 Self-managed runtimes (unchanged channel)

`RuntimeUsageLedger` feeds the *legacy* `UsageEngine` aggregates (app
parity), and runtime request meters (`OllamaMeter`, OpenAI-compatible) emit
per-request `UsageEvent`s with `source = .selfManaged`, cost `.planFree`.

---

## 3. Storage: what lives where

### 3.1 `usage.db` (SQLite, WAL) — `Platform.paths.configDirectory/usage.db`

| Table | One row per | Key / dedup | Notes |
|---|---|---|---|
| `usage_event` | measured request | `id` UUID, `INSERT OR IGNORE` | raw vendor/model spellings, tokens (5 types), meter cost + `cost_source`, meter product + `product_source`, `machine_id` (alias joined from `machine`), `account_id`, `request_id`/`_alt`, rates, latency, context occupancy/limit, thinking level/raw, session, attestation. Indexes: ts, vendor+ts, machine+ts, product+ts, request_id |
| `file_annotation` | tool attribution fact from a file | `(vendor, request_id)` | file's product claim, file-reported cost, ts, source_file — joined at READ time, never modifies usage rows |
| `spelling` | raw→canonical model mapping | `(kind, raw)` | read-side derivative cache for SQL model folds; rebuilt lazily, droppable |
| `machine` | one row per machine | `machine_id` | id → inferred alias; upserted on insert, joined at read |
| `limit_snapshot` | one quota observation (minute-granular) | `(recorded_at, machine_id, provider, account_id, label)` | used_percent, resets_at, detail; 370-day retention |
| `context_state` | live session context occupancy | `session_id` upsert | state, not events |
| `sync_state` | per-dataset push cursor | `dataset` | advanced only on ACKed cloud push |

Migrations do not exist (see §3.3): the schema is v1 (`PRAGMA user_version
= 1`) and legacy databases are archived aside on open. Stored vendor/model
spellings are RAW everywhere; canonicalization is pure read-path SQL
(vendor CASE, spelling-table JOIN).

### 3.2 Machine identity and alias

Every row is stamped `machine_id` (persisted UUID, `machine-id` file). The
human label lives **once per machine** in the `machine` table
(`machine_id → alias`, upserted on open and on every metered insert) and is
JOINed at read time — no per-row alias storage. Resolution order:
`TH_MACHINE_ALIAS` env > `machine-alias` file > sanitized hostname
(`.local` stripped) > `machine-<id prefix>`. The id remains the identity;
the alias is display-only (may collide) and surfaces in `/health`, machine
groupings (`aggregate(.machine)` groups by the joined alias), event JSON,
and the cloud sync envelope.

### 3.3 Schema version: v1, no migrations

The current schema is the FIRST state of the database — the pre-v1
implementation was discarded, not migrated. On open, any database with a
`usage_event` table but `user_version = 0` is archived aside as
`usage.legacy-<ts>.db` (never deleted) and a fresh v1 store is created.

### 3.4 Other local media

| Medium | Holds |
|---|---|
| `settings.json`, `consents.json` (config dir) | settings, per-scope consent grants |
| `runtime-usage.json` | durable runtime-ledger deltas (self-managed parity) |
| `machine-id` (config dir, 0600) | stable per-machine UUID |
| Keychain / platform credential store | secrets — never sqlite |
| in-memory only | telemetry rollups, runtime histories, event ring buffer |

### 3.5 What is deliberately NOT stored locally

Leaderboards (derived cloud-side from usage deltas — "usage rows ARE the
pending state"), other machines' rows (sync is push-only; the local store
holds only this machine's data, every row stamped `machine_id`), and raw
credentials (only SHA-256-derived account keys).

---

## 4. Read path — how information reaches the customer

All local consumers read the **same** loopback API (`CoreAPIRouter`,
`Platform/CoreAPIRouter.swift`) served by the macOS app or the headless
daemon; the store is the source of truth whether or not the cloud is
reachable.

| Endpoint | Serves | Backed by |
|---|---|---|
| `GET /analytics/events` | tabular requests, newest-first, cursor-paginated | `query` |
| `GET /analytics/buckets` | chart series at snapped resolution | `buckets` |
| `GET /analytics/aggregate` | totals by vendor/model/machine/product/session/day | `aggregate` |
| `GET /analytics/summary` | provider→model rollups with avg measured rates | `summarize` |
| `GET /analytics/sync` | delta feed (rowid cursor) | `events(afterSequence:)` |
| `GET /limits` (+ history) | current quota windows + timeline | `cachedLimits` / `limitHistory` |
| `GET /stats`, `/trends` | app dashboard (legacy UsageEngine reconciled with store) | engine + `buckets` |
| `GET /meters`, `/files`, `/health` | pipeline liveness | meter list, `FilePoller.lastReport` |

Consumers: the macOS app, the Tauri/Svelte UI, `mcp/token-horizon-mcp.mjs`
(plus its read-only sqlite fallback), and `shell/token-horizon.zsh`.
Event JSON now includes `product_source`, `cost_source`, `account_id`,
`request_id` — clients can show *how* each label/price was established.

### Cloud relay (`Sync/CloudSync.swift`)

Push-only, per dataset (`usage_events` by rowid, `limits` by timestamp):
read cursor → pull delta → map to cloud schema (`CloudSchema`, includes
`account_id`, `product_source`, `cost_source`, `request_id` for cloud-side
verification) → POST with identity envelope → **advance cursor only on
acknowledged push**. Offline = deltas accumulate; event UUIDs make
redelivery idempotent. Leaderboards must weight by `attestation` —
`selfReported` rows never rank.

---

## 5. Trust model summary

| Threat | Containment |
|---|---|
| Spoofed tool files (fake usage) | Files create no usage rows and modify none; worst case is a competing tool LABEL next to the meter's own observation on a real metered request. Leaderboards rank only `measured`+ |
| Fake traffic through the meter | Meter targets are pinned to real vendor APIs; forged usage requires the provider to actually serve (and bill) it |
| Meter bypass | Under-counts only the bypasser |
| Multi-account quota mixing | `AccountKey` separates ceilings; PK enforces it |
| Double counting (meter + file) | Structurally impossible: one writer; files live in their own table and only JOIN at read |
| Information loss from early merging | None: every observation stored raw at full resolution; ranks and canonical forms resolve at query time |
| Replay / re-poll duplication | UUID dedup on events, natural keys on annotations, minute keys on limits |
