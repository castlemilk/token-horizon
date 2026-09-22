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
* **Authentication Sources** (freshest expiry wins, `PlanLimitsEngine.openaiAuth`):
  1. `$CODEX_HOME/auth.json` / `~/.codex/auth.json` — Codex CLI's own store (`tokens.access_token` / `refresh_token` / `account_id`; expiry from the JWT `exp` claim). Usually freshest since the CLI refreshes on every run.
  2. opencode `auth.json` (`~/.local/share/opencode/auth.json`, key `"openai"`; `access` / `refresh` / `expires` ms epoch / `accountId`).
* **Token Auto-Refresh** (`OAuthRefresh` + `ensureFreshOpenAIAuth`): when the access token is inside a 5-minute expiry window, the engine POSTs JSON `{grant_type: "refresh_token", refresh_token, client_id: "app_EMoamEEZ73f0CkXaXp7hrann"}` to `https://auth.openai.com/oauth/token` and writes the rotated tokens back into the same file (atomic write, 0600 preserved). The file is re-read before writing — if its refresh token changed, the CLI already rotated and its newer auth is adopted instead. Rejected refreshes throttle for 10 minutes. This keeps quota polling alive indefinitely without the user ever launching `codex`.
* **Header Construction**:
  ```http
  Authorization: Bearer <access_token>
  ChatGPT-Account-ID: <chatgpt_account_id>
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
  Accept: application/json
  ```

### Account ID Extraction
The `ChatGPT-Account-ID` header is extracted in two ways:
1. `auth.json` entry field `accountId`.
2. Decoded JWT payload from the `access` token:
   ```json
   {
     "https://api.openai.com/auth": {
       "chatgpt_account_id": "dd80d0db-a29a-4b97-8be4-21cadd623ad4",
       "chatgpt_plan_type": "pro"
     }
   }
   ```

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

* **Primary 7-Day Window (`604800s`)**: Standard rolling subscription limit with dynamic countdown.
* **Bursting 5-Hour Window (`18000s`)**: High-speed dedicated sub-tier limits (e.g. `gpt-5.3-codex-spark 5h`).

---

## 2. Local Session Ingestion & In-Band Rate Limits

When offline or when scanning history, Token Horizon parses local Codex JSONL session files:

* **Directories**:
  - `~/.codex/sessions/YYYY/MM/DD/*.jsonl` (scanned recursively across all nested date directories).
  - `~/.codex/archived_sessions/*.jsonl`.
* **Stateful Offsets**:
  - Byte offsets and monotonic watermarks (`input`, `output`, `cached`, `reasoning`) are preserved per file.
* **Model Identification**:
  - Extracted from `payload.turn_context.model`, `payload.managed_instructions.model`, or `payload.personality.model` (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, etc.).
* **In-Band Quota Fallback**:
  - Reads `payload.rate_limits.primary` (`used_percent`, `window_minutes`, `resets_at`) from completed completion turns.

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
