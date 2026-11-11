---
name: provider-quota-kimi
description: >-
  Specifications for Moonshot Kimi Coding Plan OAuth token auto-refresh and usage API monitoring in Token Horizon.
---

# Moonshot Kimi Quota Fetching Skill

This skill covers Kimi Coding Plan OAuth refresh flow and usages API monitoring.

---

## 1. Credential Locations & Auto-Refresh

* **Locations** (`KimiLimitsEngine.credentialPaths()`, `clients/macos/Sources/TokenHorizon/Limits/KimiLimitsEngine.swift:44-63`):
  1. `$KIMI_CODE_HOME/credentials/kimi-code.json` when `KIMI_CODE_HOME` is set, otherwise `~/.kimi-code/credentials/kimi-code.json`
  2. `$KIMI_HOME/credentials/kimi-code.json` when `KIMI_HOME` is set
  3. `~/.kimi/credentials/kimi-code.json`
  4. `~/.kimi*` variant directories that hold `credentials/kimi-code.json` (Swift only)
* **Fields**: `access_token`, `refresh_token`, `expires_at` (epoch seconds)
* **Selection**: the Swift engine uses the first file that holds an `access_token` (`readCredentials()`, `:65-75`). The Go adapter reads every such file and, when there is more than one, labels its rows `kimi (<profile>)` (`daemons/go/internal/providers/limits/vendors/kimi.go:31-52`, `:112-140`; `daemons/go/internal/usage/usageparse.go:130-156`).

### Automatic Refresh Flow
If `expires_at` is greater than 0 and `Date() + 300s > expires_at`:
* **Endpoint**: `POST https://auth.kimi.com/api/oauth/token`
* **Body**: form-encoded with `Content-Type: application/x-www-form-urlencoded` (`KimiLimitsEngine.swift:162-169`; `kimi.go:66-99`):
  ```
  client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token=<refresh_token>
  ```
* On success the new `access_token` is stored, the new `refresh_token` replaces the old one when the response has one, and `expires_at` becomes now plus `expires_in` (default 3600). The file is rewritten as JSON with `access_token`, `refresh_token`, `expires_at`, `scope` set to `kimi-code` and `token_type` set to `Bearer` (`KimiLimitsEngine.swift:77-87`, `:89-98`, `:180-183`).
* If the refresh fails, the Swift engine returns no rows for Kimi (`:93`).

---

## 2. Usages API Endpoint

* **Endpoint**: `GET https://api.kimi.com/coding/v1/usages`
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  User-Agent: OpenUsage
  Accept: application/json
  ```

---

## 3. Response Schema

The Swift parser (`KimiLimitsEngine.fetch()`, `KimiLimitsEngine.swift:115-143`) reads only these fields:

```json
{
  "usage": {
    "limit": 1000000,
    "used": 350000,
    "resetTime": "<ISO 8601 timestamp>"
  },
  "user": {
    "membership": { "level": "LEVEL_<PLAN>" }
  },
  "limits": [
    {
      "window": { "duration": 300, "timeUnit": "<unit containing MINUTE, HOUR or DAY>" },
      "detail": { "limit": 100, "remaining": 40, "resetTime": "<ISO 8601 timestamp>" }
    }
  ]
}
```

* `usage` row: `usedPercent = (used / limit) * 100`, clamped to 0-100. `limit` and `used` may be JSON numbers or strings with a `K`, `M` or `B` suffix (`parseQuota` and `flexibleNumber`, `KimiLimitsEngine.swift:186-205`).
* The `usage` row label is `user.membership.level` lowercased with `LEVEL_` removed, or `plan` when the field is absent (`membership`, `:207-211`). The Go adapter labels this row `week` instead (`kimi.go:174-200`).
* `resetsAt` for the `usage` row is parsed from the ISO 8601 string `resetTime` by `parseDate` (`:224-228`). It is not epoch milliseconds. `window_size` is not read.
* `limits[]`: only the first two entries are read (`:128-142`). An entry needs `detail.limit` and `detail.remaining`. `usedPercent = (limit - remaining) / limit * 100`, clamped. The label comes from `window` (`windowLabel`, `:148-160`): a MINUTE unit that divides evenly into hours gives `Nh`, other MINUTE values give `Nm`, HOUR gives `Nh`, DAY gives `Nd`, and anything else gives `window`. `resetsAt` comes from `detail.resetTime`. The detail text is `<remaining> / <limit> left`.
* The Go adapter also synthesises rows from `usages.limit_5h` and `usages.limit_7d` (`used_ratio`, a 0-1 fraction or a percent, and `reset_time`) when `limits[]` has no matching window (`kimi.go:174-270`). The Swift engine does not read `usages`.

---

## 4. Edge Cases

* The `usage` row detail is `<used> / <limit>` (`KimiLimitsEngine.swift:126`).
* The Swift engine makes one usages request per call. A non-2xx response or a body that is not JSON returns no rows (`KimiLimitsEngine.swift:106-113`). The Go adapter retries up to three times with a 400 ms sleep between failed attempts (`kimi.go:141-160`).
