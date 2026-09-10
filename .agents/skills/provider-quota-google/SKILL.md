---
name: provider-quota-google
description: >-
  Guidelines and protocols for querying Google Gemini Developer OAuth quota buckets and remaining fractions via internal CloudCode APIs in Token Horizon.
---

# Google Gemini Quota Fetching Skill

This skill explains how Token Horizon discovers Google Gemini CLI credentials and monitors per-model quota buckets.

---

## 1. Authentication Discovery

* **Path**: `~/.gemini/oauth_creds.json`
* **Fields Extracted**:
  - `access_token`: Google OAuth Bearer token
  - `project_id`: Associated Google Cloud / Developer Project ID

---

## 2. Endpoint & Internal Request

* **Endpoint**: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
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

---

## 4. Antigravity (AGY) Language Server Quotas

Token Horizon integrates directly with Google Antigravity's local language server:
* **Token Extraction**:
  - Checks Keychain for `service: "antigravity_oauth_token"`, `account: "gemini"`
  - Decodes `go-keyring-base64:` UTF-8 payloads if prefixed.
* **Port Discovery**:
  - Fast-path regex scan of `~/.gemini/antigravity-cli/cli.log` matching `port at (\d+) for HTTP`.
  - Targeted process check: `pgrep -x agy` + `lsof -p <PID>` (~20ms instead of 30s system-wide `lsof`).
  - Active port is cached in-memory (`cachedAgyPort`) to eliminate shell spawning on repeated polls.
* **RPC Endpoint**:
  - `POST http://127.0.0.1:<PORT>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
  - Body: `{"request": {"version": "1.0"}}`
  - Returns `user_quota_summary`: `gemini_quota_summary` and `third_party_quota_summary` with `allowed_headroom_fraction` and `duration_until_reset`.
* **Dynamic Model Normalization**:
  - Checks `~/.gemini/antigravity-cli/settings.json` to attribute tokens to the configured model (`gemini-3.8-flash`) rather than hardcoding.
