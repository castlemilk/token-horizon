---
name: provider-quota-deepseek
description: >-
  Specifications for querying DeepSeek balance API in Token Horizon.
---

# DeepSeek Balance & Quota Skill

This skill covers DeepSeek balance monitoring. The limits code has no prompt-cache savings calculation for DeepSeek.

---

## 1. Authentication

* **Source**: the `deepseek` key in opencode `auth.json` (the first readable file of the candidates in `HomeDiscovery.opencodeAuthCandidates()`), then the `DEEPSEEK_API_KEY` environment variable (`PlanLimitsEngine.swift:787-790`; `daemons/go/internal/providers/limits/vendors/deepseek.go:16-18`).

---

## 2. Balance Endpoint

* **Endpoint**: `GET https://api.deepseek.com/user/balance`
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
  "is_available": true,
  "balance_infos": [
    {
      "currency": "USD",
      "total_balance": "150.00",
      "granted_balance": "50.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

Only the first entry of `balance_infos` is read (`PlanLimitsEngine.swift:795-810`). `currency` defaults to `USD`. `total_balance` may be a string or a number. `granted_balance` and `topped_up_balance` are not read. The row has `resetsAt` nil.

---

## 4. `is_available` Semantics

`is_available: false` means the balance cannot serve requests (zero or
negative `total_balance`). The row is still emitted — as an exhausted
`balance` limit at `usedPercent: 100` with detail
`"$<total> <CCY> · unavailable"` — rather than hiding the account.
No row is produced when no key is configured, when the request fails or returns a non-2xx status (`get()` returns nil, `PlanLimitsEngine.swift:370-385`), or when `balance_infos` is missing or empty. The Go adapter (`deepseek.go:27-29`) returns no row when `is_available` is false, which differs from the Swift engine.
