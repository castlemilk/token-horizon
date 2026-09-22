---
name: provider-quota-anthropic
description: >-
  Guidelines and specifications for extracting Claude Code credentials from disk and macOS Keychain,
  and querying the Anthropic OAuth usage API for 5h, 7d, and model-scoped quotas in Token Horizon.
---

# Anthropic Claude Quota Fetching Skill

This skill explains how Token Horizon retrieves OAuth tokens and queries Claude Code usage quotas.

---

## 1. Multi-Account & Credential Discovery

Token Horizon automatically discovers all Claude profiles configured on the host:
- Default directory: `~/.claude`
- Profile directories matching `~/.claude*` (e.g. `~/.claude-1`, `~/.claude-2`, `~/.claude-work`)
- Custom directory: `$CLAUDE_CONFIG_DIR`
- Standard config directory: `~/.config/claude`

For each discovered profile directory:
1. **Metadata Discovery**:
   - Reads `.claude.json` from `<dir>/.claude.json` (or `~/.claude.json` for `~/.claude`).
   - Extracts `oauthAccount`: `emailAddress`, `displayName`, `organizationName`, `organizationType`, `organizationRateLimitTier`, `hasExtraUsageEnabled`.
   - Reads `cachedUsageUtilization` as fallback when offline or unauthenticated.
2. **Access Token Resolution**:
   - Checks `<dir>/.credentials.json` on disk.
   - Computes 8-character SHA-256 hash of the expanded path: `SHA256(expandedPath).prefix(8)`
   - Queries macOS Keychain:
     - For default `~/.claude`: service `"Claude Code-credentials"` (fallback: `"Claude Code-credentials-\(hash)"`)
     - For other profiles: service `"Claude Code-credentials-\(hash)"` (fallback: `"Claude Code-credentials"`)
   - Decodes JSON payload to extract `claudeAiOauth.accessToken` (or `oauth.accessToken`, `claudeOAuth.accessToken`).
3. **Access Token Auto-Refresh** (`findAccessToken` → `OAuthRefresh`): access tokens live ~8h (`expires_in: 28800`); Claude Code normally only refreshes them on launch. When the stored `expiresAt` is inside a 5-minute window and a `refreshToken` exists, the engine POSTs JSON `{grant_type: "refresh_token", refresh_token, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"}` to `https://platform.claude.com/v1/oauth/token` (fallback `https://console.anthropic.com/v1/oauth/token`) and writes the rotated credentials back into the same store — `security add-generic-password -U` for Keychain items (account = the item's `acct` attribute), atomic JSON write for `.credentials.json` (0600 preserved). The store is re-read before writing: a changed refresh token means the CLI rotated first, and its newer access token is adopted. Rejected refreshes (invalid_grant) throttle per config dir for 10 minutes.
4. **Usage Tracking**:
   - Automatically scans `projects/` and `transcripts/` across all discovered profile directories.
   - Computes per-account token consumption and cost alongside overall combined totals.

---

## 2. API Endpoint & Headers

* **Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`
* **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-code/0.2.29
  Accept: application/json
  ```
* **Rate Limiting & Anti-429 Discipline**:
  - `ClaudeDiscovery.fetchAllLimits()` queries all discovered accounts **sequentially** with a **100ms pause** between calls rather than concurrent fan-out, avoiding Cloudflare `HTTP 429 Too Many Requests`.
  - In-memory `lastSuccessfulLiveLimits` caches the last valid live limits per account so transient Cloudflare blips never zero out or downgrade active quotas.
  - Disk cache entries in `.claude.json` (`cachedUsageUtilization`) older than **2 hours (7,200 seconds)** are discarded as stale to prevent displaying expired days-old limits.

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
      "group": "weekly",
      "percent": 51.0,
      "severity": "normal",
      "resets_at": "2026-08-30T00:00:00Z",
      "scope": {
        "model": { "id": null, "display_name": "Fable" }
      }
    }
  ]
}
```

* **5h Window**: Short-term prompt bursting protection.
* **7d Weekly Window**: Standard subscription rolling quota.
* **Weekly Model-Scoped**: Per-model sub-quotas (Fable, Sonnet, Opus) under `limits[]`
  with `kind: "weekly_scoped"`. Live entries carry **`percent`** (older payloads
  used `utilization`) — the parser accepts both, plus a null `resets_at`.
  Never treat a missing percent as 0; skip the row. In the Plan Limits table
  scoped rows ride in the `extra` slot and subtitle (`Fable 51%`) — they must
  never compete for the burst/cycle slots or their reset dates will hijack the
  weekly headroom column.
