---
name: provider-quota-deepseek
description: >-
  Specifications for querying DeepSeek balance API and prompt caching discount tracking in Token Horizon.
---

# DeepSeek Balance & Quota Skill

This skill covers DeepSeek balance monitoring and 90% prompt cache savings calculation.

---

## 1. Authentication

* **Source**: `DEEPSEEK_API_KEY` or `auth.json`

---

## 2. Balance Endpoint

* **Endpoint**: `GET https://api.deepseek.com/user/balance`
* **Headers**:
  ```http
  Authorization: Bearer <DEEPSEEK_API_KEY>
  Accept: application/json
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

---

## 4. `is_available` Semantics

`is_available: false` means the balance cannot serve requests (zero or
negative `total_balance`). The row is still emitted — as an exhausted
`balance` limit at `usedPercent: 100` with detail
`"$<total> <CCY> · unavailable"` — rather than hiding the account.
Only a missing/empty `balance_infos` produces no row.
