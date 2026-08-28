---
name: provider-quota-minimax
description: >-
  Specifications for querying MiniMax Token Plan interval and weekly remaining quotas in Token Horizon.
---

# MiniMax Quota Fetching Skill

This skill covers MiniMax Token Plan quota monitoring.

---

## 1. Authentication

* **Source**: `~/.local/share/opencode/auth.json` (key `minimax-coding-plan`)

---

## 2. API Endpoint

* **Endpoint**: `GET https://www.minimax.io/v1/token_plan/remains`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  ```

---

## 3. Response Schema

```json
{
  "model_remains": [
    {
      "current_interval_remaining_percent": 80,
      "end_time": 1787800000000,
      "current_weekly_remaining_percent": 65,
      "weekly_end_time": 1788200000000
    }
  ]
}
```

* **Interval Window**: `usedPercent = 100 - current_interval_remaining_percent`
* **Weekly Window**: `usedPercent = 100 - current_weekly_remaining_percent`
