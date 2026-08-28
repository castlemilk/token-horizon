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
