---
name: provider-quota-google
description: >-
  Guidelines and protocols for querying Google Gemini Developer OAuth quota buckets and remaining fractions via internal CloudCode APIs in Token Horizon.
---

# Google Gemini Quota Fetching Skill

This skill explains how Token Horizon discovers Google Gemini CLI credentials and monitors per-model quota buckets.

---

## 1. Authentication Discovery

* **Path**: `~/.gemini/oauth_creds.json`, then the `~/.gemini*` variant directories (`HomeDiscovery.geminiCredentialPaths()`, `clients/macos/Sources/TokenHorizon/Discovery/HomeDiscovery.swift:145-154`; Go `daemons/go/internal/providers/limits/vendors/gemini.go:37-73`). The Swift engine uses the first file with an `access_token`. The Go adapter queries every such file.
* **Fields Extracted**:
  - `access_token`: Google OAuth Bearer token
  - `project_id`: Associated Google Cloud / Developer Project ID (empty string when absent)
* **Keychain fallback**: when no file holds a token, the generic password with service `gemini` and account `antigravity` is read with `/usr/bin/security find-generic-password -w`. A `go-keyring-base64:` prefix is removed, the rest is base64-decoded as JSON, and `token.access_token` (or a top-level `access_token`) is used (`PlanLimitsEngine.swift:544-546`, `:765-784`; Go `gemini.go:31`).

---

## 2. Endpoint & Internal Request

* **Endpoint**: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
  Accept: application/json
  User-Agent: opencode/1.0.0 (darwin; arm64)
  ```
* **Body**:
  ```json
  {
    "project": "<project_id>"
  }
  ```

---

## 3. Response Structure & Utilization Math

```json
{
  "buckets": [
    {
      "modelId": "gemini-2.5-pro",
      "remainingFraction": 0.72,
      "resetTime": "2026-08-27T16:00:00Z"
    },
    {
      "modelId": "gemini-2.5-flash",
      "remainingFraction": 0.95,
      "resetTime": "2026-08-27T16:00:00Z"
    }
  ]
}
```

* **Utilization**: `usedPercent = (1.0 - remainingFraction) * 100`
* **Reset**: Parsed from ISO8601 string `resetTime`.
* Buckets without a numeric `remainingFraction` are skipped. The row label is `modelId`, then `tokenType`, and the provider string is `google` (`parseGeminiBucketsPayload`, `PlanLimitsEngine.swift:569-581`). The Go adapter labels these rows with provider `gemini` (`gemini.go:126`).
* If the request yields no bucket but a token exists, the Swift engine returns one `agy` row with label `tier`, detail `Active · Pro` and `usedPercent` 0 (`PlanLimitsEngine.swift:557-565`).

---

## 4. Antigravity (AGY) Language Server Quotas

Token Horizon integrates directly with Google Antigravity's local language server:

`PlanLimitsEngine.gemini()` calls the language server first and returns its `agy` rows when any are found. The CloudCode request in section 2 runs only when it returns none (`PlanLimitsEngine.swift:526-530`).

* **Token Extraction**:
  - The local RPC sends no bearer token. It sends the header `x-codeium-csrf-token` with the value from `PlanLimitsEngine.agyCsrfToken()` (`PlanLimitsEngine.swift:594-611`, `:690-692`). That value comes from the cache, then `~/.config/token-horizon/agy-csrf`, then `~/.config/token-horizon/cache/agy-csrf`, then the `ANTIGRAVITY_CSRF_TOKEN` environment variable. `setAgyCsrfToken` (`:586-592`) writes the file. The Go adapter sends no CSRF header (`gemini.go:157-166`).
* **Port Discovery**:
  - Sources are tried in this order (`discoverAgyPorts()`, `PlanLimitsEngine.swift:613-676`): the cached port (`cachedAgyPort`), the port in `ANTIGRAVITY_LS_ADDRESS`, the port in `~/.config/token-horizon/agy-port`, the last three matches of `port at (\d+) for HTTP\b` in `~/.gemini/antigravity-cli/cli.log` (newest first), then the `127.0.0.1:<port>` listeners from `lsof` (highest port first).
  - The `lsof` check runs `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -c agy -a -i4` and writes its output to a temp file. It does not use `pgrep`. Go runs `lsof` from PATH with the same arguments (`gemini.go:135-155`).
  - Active port is cached in-memory (`cachedAgyPort`) to eliminate shell spawning on repeated polls.
* **RPC Endpoint**:
  - `POST http://127.0.0.1:<PORT>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
  - Body: `{}` with `Content-Type: application/json`, 1.5 s timeout (`PlanLimitsEngine.swift:686-693`).
  - Response: `response.groups[]`. Each group has `displayName` and `buckets[]`. Each bucket has `remainingFraction`, `window` (or `bucketId`) and `resetTime`. The row label is `<prefix> <window>`. In Swift the prefix is `argon`, `gemini`, `3p` (for claude or gpt groups) or otherwise the lowercased `displayName`. The detail is `<N>% left`. The provider string is `agy` (`parseAgyLanguageServerGroups`, `PlanLimitsEngine.swift:732-763`).
  - When a port answers 401 or 403, the Swift engine clears the cached port, reloads the CSRF token and discovers ports once more (`:707-727`).
* **Dynamic Model Normalization**:
  - This is token attribution in `UsageEngine`, not quota. `UsageEngine.configuredAgyModel()` (`clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift:313-326`) reads `model` from `~/.gemini/antigravity-cli/settings.json` and maps a value containing `3.8` and `flash`, `3.7` and `flash`, `2.5` and `flash`, or `2.5` and `pro` to `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-2.5-flash` or `gemini-2.5-pro`. Any other value is returned unchanged. It returns `gemini-3.8-flash` when the file or the key is missing.
