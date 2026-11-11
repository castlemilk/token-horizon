---
name: provider-quota-opencode
description: >-
  Specifications for querying OpenCode Go Zen multi-window usage quotas and tracking free models (big-pickle, x-preview-f-free, etc.) in Token Horizon.
---

# OpenCode Go & Free Models Quota Skill

This skill covers OpenCode Go Zen subscription quotas and OpenCode free-tier model discovery and usage tracking.

---

## 1. OpenCode Go Zen Subscription Quota API

* **Authentication Source**: `OPENCODE_AUTH` is tried first. `~/.local/share/opencode/auth.json`, `~/.config/opencode/auth.json` and `~/.opencode/auth.json` follow; the first file that parses and holds a key wins (key `opencode-go`) (`HomeDiscovery.opencodeAuthCandidates()`, `clients/macos/Sources/TokenHorizon/Discovery/HomeDiscovery.swift:134-142`).
* **Endpoint**: `GET https://opencode.ai/zen/go/v1/usage`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  User-Agent: opencode/1.0.0 (darwin; arm64)
  ```
* **Response Schema**:
  ```json
  {
    "usage": {
      "rolling": { "percent": 45.0, "status": "active", "resetsAt": "2026-08-27T18:00:00Z" },
      "weekly": { "percent": 100.0, "status": "rate-limited", "resetsAt": "2026-08-31T00:00:00Z" },
      "monthly": { "percent": 79.0, "status": "active", "resetsAt": "2026-09-08T12:39:39Z" }
    }
  }
  ```

Each key under `usage` becomes a row labelled with that key (`rolling`, `weekly`, `monthly`, or any other key). `percent` is clamped to 0-100 and used as `usedPercent`. A `status` of `rate-limited` sets the detail to `rate-limited`. `resetsAt` is parsed as an ISO 8601 string (`parseOpencodeGoPayload`, `clients/macos/Sources/TokenHorizon/Limits/PlanLimitsEngine.swift:508-522`; Go `daemons/go/internal/providers/limits/vendors/opencode.go:19-41`).

---

## 2. OpenCode Free Models & SQLite Database Tracking

OpenCode provides free zero-cost models (such as `big-pickle`, `x-preview-f-free`, `muse-spark-1.2-contributor-free`, and `ox-alpha-free`) recorded directly in the local OpenCode SQLite database.

* **Database Path**: `~/.local/share/opencode/opencode.db`. The Swift engine also reads `~/Library/Application Support/opencode/opencode.db` (`opencodeDatabasePaths`, `clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift:2830-2835`).
* **SQLite Table**: whichever generation the db has — probe `sqlite_master` for
  `session_message` first, fall back to `message`:
  * **live**: `session_message` where `type = 'assistant'`, or `type = 'compaction'` with `data.$.tokens` an object (`OpencodeSchema.v2`, `UsageEngine.swift:2893`) (opencode migrated
    `session`/`message` → `session_v2`/`session_message` and **froze the v1
    tables at the cutover** — a `message`-only query reports usage as it stood
    on the day opencode upgraded and nothing since)
  * **legacy** (un-migrated installs): `message` where
    `json_extract(data, '$.role') = 'assistant'`
  * v2 is a strict **superset** of v1 (same ids, higher running totals), so
    read one generation only — never the union, or totals double-count
  * v2 also moved the model block: `data.$.model.providerID` / `data.$.model.id`
    (v1 kept them top-level as `data.$.providerID` / `data.$.modelID`), and it
    dropped `data.$.tokens.total`
* **Complete Token Sum Expression**:
  ```sql
  COALESCE(
    json_extract(data, '$.tokens.total'),        -- legacy rows only
    COALESCE(json_extract(data, '$.tokens.input'), 0) +
    COALESCE(json_extract(data, '$.tokens.output'), 0) +
    COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
    COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
    COALESCE(json_extract(data, '$.tokens.cache.write'), 0),
    0
  )
  ```
* **Free Model Classification**:
  A model row is marked `free: true` when:
  `cost < 0.0001 || provider.contains("free") || model.contains("free") || model.contains("pickle")`
* **Daily Midnight Reset**:
  Today's usage uses `todayBucket(now:)` (`Calendar.current.startOfDay(for:)`, `UsageEngine.swift:1511-1513`), called with `collectionDate ?? Date()`. The sums use `time_created > midnightMs`, where `midnightMs` is that day start in milliseconds (`UsageEngine.swift:2930-2947`, `:3081`).
