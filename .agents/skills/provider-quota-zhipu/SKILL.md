---
name: provider-quota-zhipu
description: >-
  Specifications for querying Zhipu AI GLM Coding Plan quota and monitor limit endpoints in Token Horizon.
---

# Zhipu AI (GLM) Quota Fetching Skill

This skill covers the Zhipu AI (GLM-5 / GLM-4) monitoring API used to track developer plan quotas.

---

## 1. Authentication

* **Source**: `~/.local/share/opencode/auth.json` (or `$OPENCODE_AUTH`)
* **Keys**: `zai-coding-plan` or `zai`

---

## 2. Quota Monitoring Endpoint

* **Endpoint**: `GET https://api.z.ai/api/monitor/usage/quota/limit`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  ```

---

## 3. Response Schema

```json
{
  "code": 200,
  "data": {
    "level": "Pro",
    "limits": [
      {
        "type": "tokens",
        "percentage": 34.0,
        "remaining": 660000.0
      }
    ]
  }
}
```

* **Label**: Derived from `data.level` (e.g. `pro`, `standard`).
* **Detail**: Displays remaining quota units (e.g. `660k left`).
