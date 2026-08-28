---
name: provider-quota-opencode
description: >-
  Specifications for querying OpenCode Go Zen multi-window usage quotas in Token Horizon.
---

# OpenCode Go (Zen) Quota Fetching Skill

This skill covers OpenCode Go Zen subscription quota tracking.

---

## 1. Authentication

* **Source**: `~/.local/share/opencode/auth.json` (key `opencode-go`)

---

## 2. API Endpoint

* **Endpoint**: `GET https://opencode.ai/zen/go/v1/usage`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  ```

---

## 3. Response Schema

```json
{
  "usage": {
    "rolling": { "percent": 45.0, "status": "active", "resetsAt": "2026-08-27T18:00:00Z" },
    "weekly": { "percent": 60.0, "status": "active", "resetsAt": "2026-08-31T00:00:00Z" },
    "monthly": { "percent": 75.0, "status": "active", "resetsAt": "2026-09-01T00:00:00Z" }
  }
}
```
