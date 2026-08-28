---
name: provider-quota-kimi
description: >-
  Specifications for Moonshot Kimi Coding Plan OAuth token auto-refresh and usage API monitoring in Token Horizon.
---

# Moonshot Kimi Quota Fetching Skill

This skill covers Kimi Coding Plan OAuth refresh flow and usages API monitoring.

---

## 1. Credential Locations & Auto-Refresh

* **Locations**:
  1. `$KIMI_CODE_HOME/credentials/kimi-code.json`
  2. `~/.kimi-code/credentials/kimi-code.json`
  3. `~/.kimi/credentials/kimi-code.json`
* **Fields**: `access_token`, `refresh_token`, `expires_at`

### Automatic Refresh Flow
If `Date() + 300s > expires_at`:
* **Endpoint**: `POST https://auth.kimi.com/api/oauth/token`
* **Body**:
  ```json
  {
    "client_id": "17e5f671-d194-4dfb-9706-5516cb48c098",
    "grant_type": "refresh_token",
    "refresh_token": "<refresh_token>"
  }
  ```
* Saves refreshed credentials back to disk automatically.

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

```json
{
  "usage": {
    "limit": 1000000,
    "used": 350000,
    "reset_time": 1787800000000,
    "window_size": "5h"
  }
}
```

* `usedPercent = (used / limit) * 100`
* `resetsAt`: Converted from epoch milliseconds `reset_time`.
