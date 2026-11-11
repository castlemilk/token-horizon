---
name: provider-quota-zhipu
description: >-
  Specifications for querying Zhipu AI GLM Coding Plan quota, percentage inversion, and monitor limit endpoints in Token Horizon.
---

# Zhipu AI (GLM) Quota Fetching Skill

This skill covers the Zhipu AI (GLM-5 / GLM-4) monitoring API used to track developer coding plan quotas.

---

## 1. Authentication

* **Source**: opencode `auth.json`. `OPENCODE_AUTH` is tried first, then `~/.local/share/opencode/auth.json`, `~/.config/opencode/auth.json` and `~/.opencode/auth.json` (`PlanLimitsEngine.authKeys()`, `clients/macos/Sources/TokenHorizon/Limits/PlanLimitsEngine.swift:54-84`; `clients/macos/Sources/TokenHorizon/Discovery/HomeDiscovery.swift:134-142`).
* **Keys**: `zai-coding-plan` is tried first, then `zai` (`PlanLimitsEngine.swift:89`; `daemons/go/internal/providers/limits/vendors/zhipu.go:18-20`).

---

## 2. Quota Monitoring Endpoint

* **Endpoint**: `GET https://api.z.ai/api/monitor/usage/quota/limit` (`PlanLimitsEngine.swift:409-410`; `zhipu.go:27`)
* **Headers**:
  ```http
  Authorization: Bearer <key>
  Accept: application/json
  User-Agent: opencode/1.0.0 (darwin; arm64)
  ```

---

## 3. Response Schema & Quota Inversion

Only `data.limits[]` is read. Each entry needs a numeric `percentage`. Entries without one are skipped (`parseZaiPayload`, `PlanLimitsEngine.swift:414-473`).

```json
{
  "code": 200,
  "data": {
    "level": "Pro",
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 1.0,
        "remaining": 20000.0
      },
      {
        "type": "TOKENS_LIMIT",
        "unit": 6,
        "number": 1,
        "percentage": 21.0,
        "remaining": 420000.0,
        "nextResetTime": 1788589444998
      },
      {
        "type": "TIME_LIMIT",
        "percentage": 20.0,
        "usage": 100.0,
        "currentValue": 25.0,
        "remaining": 75.0
      }
    ]
  }
}
```

### Critical Invariant: `percentage` Is the Used Share
For every row type, `percentage` is the share **used** (`currentValue / usage` where a row carries both). It is not inverted. Until 2026-11-11 the Swift engine read `TOKENS_LIMIT` as the remaining share and inverted it. It was changed to agree with the Go adapter, on this evidence:
* Public payload samples with counts: `currentValue` 15 of `usage` 2000 gives `percentage` 1; 556 of 2000 gives 27.
* The repository's "Real Z.ai payload" test fixture: a 5h row at 0 with no reset time and a monthly row at 100. That only makes sense if the value is the used share.
* No `TOKENS_LIMIT` sample with raw counts was found. If one ever contradicts this, change both engines together.

For `TOKENS_LIMIT` rows (Swift `PlanLimitsEngine.parseZaiPayload`; Go `zhipuLimits` in `daemons/go/internal/providers/limits/vendors/zhipu.go`, pinned by `zhipu_test.go`):
* **`usedPercent = percentage`**, clamped to 0-100.
* In Swift, the remaining share is `100 - usedPercent`. When it is 0, the detail is `0% left (exhausted)`.
* The MCP `token_horizon_limits` tool reports status `rate_limited` for any limit with `usedPercent >= 100` or a detail containing `rate-limited` (`mcp/token-horizon-mcp.mjs`).

For `TIME_LIMIT` rows, the Swift engine computes `usedPercent = currentValue / usage * 100` when `usage` is above 0 and `currentValue` is present, and otherwise uses `percentage`. The detail is `<remaining> left` from `remaining`.

Other types use `percentage` as-is.

The engines still differ in two ways. The Go adapter always uses `percentage` for `TIME_LIMIT` and never computes the ratio, and its detail for every row is `<remaining> left`. Both read the same `percentage`, so the used share agrees whenever `percentage` equals `currentValue / usage`.

---

## 4. Multi-Window Extraction

Windows are identified by `type`, `unit` and `number`. `refreshInterval` is not read (`PlanLimitsEngine.swift:423-437`; `zhipu.go:43-69`). Rows use the provider string `glm`.

* **5h window**: `TOKENS_LIMIT` with `unit` 3 and `number` 5 gives label `5h`. The label is `<number>h` for unit 3.
* **Monthly window**: `TOKENS_LIMIT` with `unit` 6 gives label `monthly` when `number` is 1, otherwise `<number>mo`.
* **Weekly window**: `TOKENS_LIMIT` with `unit` 5 gives label `weekly` when `number` is 1, otherwise `<number>w`.
* **Daily window**: `TOKENS_LIMIT` with `unit` 4 gives label `daily` when `number` is 1, otherwise `<number>d`.
* **Search window**: `TIME_LIMIT` gives label `search`.
* **Other types**: the label is the type with `_LIMIT` removed and lowercased.

Reset times (`epochMS`, `PlanLimitsEngine.swift:439`, `:268-272`):
* `nextResetTime` is an epoch timestamp. Values above 1e12 are milliseconds and smaller values are seconds.
* When a `TOKENS_LIMIT` row has no `nextResetTime` (the real Z.ai payload omits it for the rolling 5h burst window), `resetsAt` is nil and the detail gets the suffix ` · rolling window` (`:447-449`; test `PlanLimitsEngineTests.swift:110-128`).
