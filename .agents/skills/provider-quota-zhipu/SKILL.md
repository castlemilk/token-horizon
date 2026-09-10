---
name: provider-quota-zhipu
description: >-
  Specifications for querying Zhipu AI GLM Coding Plan quota, percentage inversion, and monitor limit endpoints in Token Horizon.
---

# Zhipu AI (GLM) Quota Fetching Skill

This skill covers the Zhipu AI (GLM-5 / GLM-4) monitoring API used to track developer coding plan quotas.

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

## 3. Response Schema & Quota Inversion

```json
{
  "code": 200,
  "data": {
    "level": "Pro",
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "percentage": 1.0,
        "remaining": 20000.0,
        "nextResetTime": 1788102501326,
        "refreshInterval": 18000000
      },
      {
        "type": "MONTHLY_LIMIT",
        "percentage": 21.0,
        "remaining": 420000.0,
        "nextResetTime": 1788589444998
      },
      {
        "type": "SEARCH_LIMIT",
        "percentage": 100.0,
        "remaining": 1000.0
      }
    ]
  }
}
```

### Critical Invariant: Inverted Percentage
In the Z.ai monitor API, `percentage` denotes the **remaining percentage**:
* **`usedPercent = 100.0 - percentage`**
* When `percentage == 0` (0% left), `usedPercent = 100.0` (rate-limited / exhausted).
* When `usedPercent >= 100`, the limit is tagged with `detail: "0% left (exhausted)"` and MCP status `rate_limited`.

---

## 4. Multi-Window Extraction

* **5h Window (`refreshInterval == 18000000` / 5 hours)**: Short-term prompt bursting window.
* **Monthly Window (`MONTHLY_LIMIT`)**: Plan billing cycle quota.
* **Search Limit (`SEARCH_LIMIT`)**: Web browsing and tool invocation allowance.
