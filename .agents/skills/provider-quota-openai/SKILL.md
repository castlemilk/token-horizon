---
name: provider-quota-openai
description: >-
  Specifications for monitoring OpenAI Codex stateful JSONL sessions, live ChatGPT Pro/Plus backend quota APIs (wham/usage), and Platform billing quotas in Token Horizon.
---

# OpenAI Codex & ChatGPT Quota Skill

This skill explains how Token Horizon retrieves live rate limits and token usage for OpenAI models (GPT-5 Sol, Terra, Luna, o1, o3, GPT-4o, and GPT-5.3-Codex-Spark).

---

## 1. Live ChatGPT Pro / Plus / Codex Backend Quota API

Token Horizon polls OpenAI's live backend quota and rolling rate-limit endpoint out-of-band:

* **Endpoint**: `GET https://chatgpt.com/backend-api/wham/usage`
* **Multi-account discovery** (`CodexAccountDiscovery`; `PlanLimitsEngine.openai()` delegates to `fetchAllLimits()`):
  1. Every existing `~/.codex*` profile directory, `$CODEX_HOME`, `~/.config/codex`, and saved `ManagedCLIProfileStore` Codex homes is inspected independently for `auth.json` (`tokens.access_token` / `refresh_token` / `account_id` / `id_token`; expiry from the access JWT `exp`).
  2. opencode OpenAI OAuth entries are also discovered across `OPENCODE_AUTH` and the standard auth candidates (`access` / `refresh` / `expires` ms epoch / `accountId`).
  3. Credentials are grouped by actual ChatGPT account/workspace ID. The freshest credential wins **within the same account**, preserving every profile directory and source path. Different workspace IDs remain separate even when their email addresses match. Never select one globally freshest login for all accounts.
  4. Only the selected credential for each account is refreshed and polled. Each refresh retains its original `OpenAIAuth.Source`; credentials must never be copied into a shared/default auth file. After refresh or a concurrent CLI rotation, reparse the returned access JWT before regrouping accounts.
* **Credential storage**: this integration reads file-based OAuth stores. API-key mode has no ChatGPT plan quota, and keyring/ephemeral-only profiles show an explicit unavailable/sign-in status. Newly created native profiles set `cli_auth_credentials_store = "file"` in their own private config and launch with that override; importing a profile preserves its existing policy. Official storage and `CODEX_HOME` behavior: [Authentication](https://learn.chatgpt.com/docs/auth#credential-storage), [Config and state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations).
* **Token Auto-Refresh** (`OAuthRefresh` + `ensureFreshOpenAIAuth`): when the access token is inside a 5-minute expiry window, the engine POSTs JSON `{grant_type: "refresh_token", refresh_token, client_id: "app_EMoamEEZ73f0CkXaXp7hrann"}` to `https://auth.openai.com/oauth/token` and writes the rotated tokens back into the same file (atomic write, 0600 preserved). The file is re-read before writing — if its refresh token changed, the CLI already rotated and its newer auth is adopted instead. Rejected refreshes throttle for 10 minutes. This keeps quota polling alive indefinitely without the user ever launching `codex`.
* **Header Construction**:
  ```http
  Authorization: Bearer <access_token>
  ChatGPT-Account-ID: <chatgpt_account_id>
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
  Accept: application/json
  ```

### Account ID Extraction
The current access JWT's `https://api.openai.com/auth.chatgpt_account_id` takes precedence over stored `tokens.account_id` (Codex) / `accountId` (opencode). An `id_token` claim can supply a missing account hint. Access-token profile claims and a matching ID token provide email/name/plan metadata; they are display hints, and the quota API validates the bearer token. A stored account ID must never override a different account in a refreshed/adopted JWT:
   ```json
   {
     "https://api.openai.com/auth": {
       "chatgpt_account_id": "dd80d0db-a29a-4b97-8be4-21cadd623ad4",
       "chatgpt_plan_type": "pro"
     }
   }
   ```

`CodexAccount` is a non-secret snapshot with stable account identity, email, plan, all config directories, quota rows, and per-profile status. Missing credentials retain known account metadata but do not borrow another account's quota. Transient usage failures retain the same account's last successful rows marked `stale`; HTTP 429 backs off that account and marks remembered rows `rate-limited`; 401/403 clears its quota cache and requests sign-in. Opaque tokens without an account ID invalidate remembered quotas when the token changes. Both `codex` and `codex (...)` live rows replace the global session-file fallback in the native UI, HTTP limits response, and widget.

### Response Schema & Window Types
```json
{
  "plan_type": "pro",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 17,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 579451,
      "reset_at": 1788660440
    }
  },
  "additional_rate_limits": [
    {
      "limit_name": "GPT-5.3-Codex-Spark",
      "metered_feature": "codex_bengalfox",
      "rate_limit": {
        "primary_window": {
          "used_percent": 0,
          "limit_window_seconds": 18000,
          "reset_at": 1788098989
        }
      }
    }
  ]
}
```

* **Primary and secondary windows**: parse both `rate_limit.primary_window` and `secondary_window`, plus both windows in each `additional_rate_limits` entry. A `604800s` window is `7d`; `18000s` is `5h`. Do not assume the primary slot always holds the weekly window.
* **Model-scoped windows**: prepend the reported `limit_name` to its window label (e.g. `gpt-5.3-codex-spark 5h`). Missing `used_percent` skips a window; never invent a zero.

---

## 2. Local Session Ingestion & In-Band Rate Limits

When offline or when scanning history, Token Horizon parses local Codex JSONL session files:

* **Directories**:
  - `<profile>/sessions/YYYY/MM/DD/*.jsonl` (scanned recursively across all nested date directories).
  - `<profile>/archived_sessions/*.jsonl`.
  - The usage scanner shares the account discovery roots, including managed profile homes. All roots share one `codexFiles` state dictionary; changing account defaults must never reset offsets or watermarks.
* **Stateful Offsets**:
  - Byte offsets and monotonic watermarks (`input`, `output`, `cached`, `reasoning`) are preserved per file.
* **Model Identification**:
  - Extracted from `payload.turn_context.model`, `payload.managed_instructions.model`, or `payload.personality.model` (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, etc.).
* **In-Band Quota Fallback**:
  - Reads `payload.rate_limits.primary` (`used_percent`, `window_minutes`, `resets_at`) from completed completion turns.
  - This remains an unscoped `codex` fallback; do not present it as a separate extra account when live account quotas exist.

### Native account launches

The native Terminals tab's Accounts & terminals view creates/imports profile metadata and launches Ghostty windows with the chosen `CODEX_HOME`. Native Codex sign-in uses `codex login --device-auth`; newly created profiles additionally pass `-c 'cli_auth_credentials_store="file"'`. Selected account variables are reapplied after login-shell startup, and ambient API-key/access-token overrides are removed. Existing terminal sessions keep their own environment when the default profile changes. Profiles, defaults, and terminal labels persist without OAuth tokens; account metadata is hydrated through `UsageSnapshot.codexAccounts`.

Regression coverage: `CodexAccountDiscoveryTests` (injected files/refresh/network), `CLIAccountRenderingTests` (multiple rows, fallback replacement, snapshot compatibility), and `OAuthRefreshIntegrationTests` (loopback refresh/write-back). Tests must not read live credentials, contact live quota endpoints, or start sign-ins.

---

## 3. Canonical Model Normalization

In `ModelCatalog.swift`, variant dot-version models automatically normalize into canonical catalog rows:

| Raw Session Model ID | Canonical Family ID | Display Name | Provider |
|---|---|---|---|
| `gpt-5.6-sol`, `gpt-5-sol`, `sol` | `gpt-5-sol` | **GPT-5 Sol** | OpenAI |
| `gpt-5.6-terra`, `gpt-5-terra`, `terra` | `gpt-5-terra` | **GPT-5 Terra** | OpenAI |
| `gpt-5.6-luna`, `gpt-5.6-luna-fast`, `gpt-5-luna`, `luna` | `gpt-5-luna` | **GPT-5 Luna** | OpenAI |

---

## 4. Platform API Billing Quota (API Key Mode)

* **Endpoint**: `GET https://api.openai.com/v1/dashboard/billing/usage`
* **Headers**:
  ```http
  Authorization: Bearer <OPENAI_API_KEY>
  ```
