---
name: provider-quota-anthropic
description: >-
  Guidelines and specifications for extracting Claude Code credentials from disk and macOS Keychain,
  and querying the Anthropic OAuth usage API for 5h, 7d, and model-scoped quotas in Token Horizon.
---

# Anthropic Claude Quota Fetching Skill

This skill explains how Token Horizon retrieves OAuth tokens and queries Claude Code usage quotas.

---

## 1. Credential Discovery

Token Horizon checks two locations:

1. **Config File**:
   - Path: `$CLAUDE_CONFIG_DIR/.credentials.json` (defaults to `~/.claude/.credentials.json`).
   - JSON path: `claudeAiOauth.accessToken` or `oauth.accessToken`.
2. **macOS Keychain Fallback**:
   - Command: `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w`
   - Decodes JSON payload to extract `accessToken`.

---

## 2. API Endpoint & Headers

* **Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`
* **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  Accept: application/json
  ```

---

## 3. Response Schema & Quota Windows

```json
{
  "five_hour": {
    "utilization": 42.5,
    "resets_at": "2026-08-27T18:00:00Z"
  },
  "seven_day": {
    "utilization": 68.0,
    "resets_at": "2026-08-30T00:00:00Z"
  },
  "seven_day_oauth_apps": {
    "utilization": 15.0,
    "resets_at": "2026-08-30T00:00:00Z"
  },
  "limits": [
    {
      "kind": "weekly_scoped",
      "scope": {
        "model": { "display_name": "Claude 3.7 Sonnet" }
      },
      "utilization": 54.0,
      "resets_at": "2026-08-30T00:00:00Z"
    }
  ]
}
```

* **5h Window**: Short-term prompt bursting protection.
* **7d Weekly Window**: Standard subscription rolling quota.
* **Weekly Model-Scoped**: High-demand models (Sonnet / Opus) with dedicated sub-quotas.
