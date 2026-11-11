---
name: provider-quota-minimax
description: >-
  Specifications for querying MiniMax Token Plan interval and weekly remaining quotas in Token Horizon.
---

# MiniMax Quota Fetching Skill

This skill covers MiniMax Token Plan quota monitoring.

---

## 1. Authentication

* **Source**: the `minimax-coding-plan` key in opencode `auth.json`. `OPENCODE_AUTH` is tried first, then `~/.local/share/opencode/auth.json`, `~/.config/opencode/auth.json` and `~/.opencode/auth.json` (`PlanLimitsEngine.authKeys()`, `clients/macos/Sources/TokenHorizon/Limits/PlanLimitsEngine.swift:54-84`; `HomeDiscovery.swift:134-142`).

---

## 2. API Endpoint

* **Endpoint**: `GET https://www.minimax.io/v1/token_plan/remains`
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  User-Agent: opencode/1.0.0 (darwin; arm64)
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
* Labels are `interval` and `weekly`. The detail is `<remaining>% left`. Reset times come from `end_time` and `weekly_end_time`, which are epoch seconds or milliseconds (values above 1e12 are milliseconds) (`PlanLimitsEngine.swift:482-499`, `:1073-1077`).
* The Swift engine reads only `model_remains[0]`, and it reads the remaining percentages only as integers (`as? Int`). The Go adapter also accepts strings and reads up to four more entries, labelled `interval · <model>` (`daemons/go/internal/providers/limits/vendors/minimax.go:33-50`).
