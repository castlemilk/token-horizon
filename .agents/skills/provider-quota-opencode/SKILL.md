---
name: provider-quota-opencode
description: >-
  Specifications for querying OpenCode Go Zen multi-window usage quotas and tracking free models (big-pickle, x-preview-f-free, etc.) in Token Horizon.
---

# OpenCode Go & Free Models Quota Skill

This skill covers OpenCode Go Zen subscription quotas and OpenCode free-tier model discovery and usage tracking.

---

## 1. OpenCode Go Zen Subscription Quota API

* **Authentication Source**: `~/.local/share/opencode/auth.json` (key `opencode-go`)
* **Endpoint**: `GET https://opencode.ai/zen/go/v1/usage`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
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

---

## 2. OpenCode Free Models & SQLite Database Tracking

OpenCode provides free zero-cost models (such as `big-pickle`, `x-preview-f-free`, `muse-spark-1.2-contributor-free`, and `ox-alpha-free`) recorded directly in the local OpenCode SQLite database.

* **Database Path**: `~/.local/share/opencode/opencode.db`
* **SQLite Table**: `message` where `json_extract(data, '$.role') = 'assistant'`
* **Complete Token Sum Expression**:
  ```sql
  COALESCE(
    json_extract(data, '$.tokens.total'),
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
  Today's usage uses `todayBucket()` (`Calendar.current.startOfDay(for: Date())`) to sum tokens with `time_created > localMidnightMs`.
