---
name: provider-quota-alibaba
description: >-
  Detailed specifications, authentication handshake, cookie extraction, sec_token regex parsing,
  and API payload schema for fetching Alibaba Cloud Model Studio (Bailian) Token Plan quota usage in Token Horizon.
---

# Alibaba Cloud Model Studio (Bailian) Quota Fetching Skill

This skill documents how Token Horizon extracts authentication tokens, performs security handshakes, and fetches real-time 5-hour and 1-week rolling quota usages for Alibaba Cloud Bailian Token Plans (Qwen 2.5 / Qwen 3 Coder).

---

## 1. Authentication Sources & Precedence

Token Horizon checks credentials in the following order:

1. `SettingsStore.alibabaCookie` (`~/.config/token-horizon/settings.json`)
2. `ALIBABA_COOKIE_FILE` environment variable
3. `ALIBABA_TOKEN_PLAN_COOKIE` environment variable
4. `~/.config/token-horizon/alibaba-cookie.txt`

### Required Cookie Attributes
The cookie string must contain at least:
* `cna` (Anonymous device identifier)
* `login_aliyunid_csrf` (XSRF/CSRF token)
* Session authentication tokens (e.g. `_aliyun_choice_`, `aliyun_country_code`, `login_aliyunid_pk`)

---

## 2. Security Handshake & `sec_token` Extraction

Bailian OneConsole endpoints require a dynamic `sec_token` embedded in the Model Studio dashboard HTML.

1. **Dashboard Request**:
   - URL: `https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan`
   - Headers: `Cookie: <cookie>`, `User-Agent: Mozilla/5.0 ...`
2. **Regex Parsing**:
   ```regex
   sec[_-]?token["'\s:=]+([A-Za-z0-9_%\-]{16,})
   ```
   Extracts the security token value for subsequent API signing.

---

## 3. Gateway API Request Specification

* **Endpoint**: `POST https://bailian-singapore-cs.alibabacloud.com/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage&_v=undefined`
* **Headers**:
  ```http
  Content-Type: application/x-www-form-urlencoded
  Accept: application/json, text/plain, */*
  Cookie: <full_cookie>
  Origin: https://modelstudio.console.alibabacloud.com
  Referer: https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan
  X-Requested-With: XMLHttpRequest
  x-xsrf-token: <login_aliyunid_csrf>
  x-csrf-token: <login_aliyunid_csrf>
  ```
* **Payload Parameters**:
  ```json
  {
    "Api": "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
    "V": "1.0",
    "Data": {
      "cornerstoneParam": {
        "feTraceId": "<uuid>",
        "feURL": "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan",
        "protocol": "V2",
        "console": "ONE_CONSOLE",
        "productCode": "p_efm",
        "switchUserType": 3,
        "domain": "modelstudio.console.alibabacloud.com",
        "consoleSite": "MODELSTUDIO_ALBABACLOUD",
        "X-Anonymous-Id": "<cna>",
        "xsp_lang": "en-US"
      }
    }
  }
  ```
  Sent as form fields: `product=sfm_bailian`, `action=IntlBroadScopeAspnGateway`, `region=ap-southeast-1`, `language=en-US`, `params=<json_string>`, `sec_token=<sec_token>`.

---

## 4. Response Parsing & Window Ratios

The JSON response contains:
* `per5HourPercentage`: 0.0 to 1.0 (or 0-100) utilization ratio.
* `per5HourResetTime`: Epoch timestamp in milliseconds.
* `per1WeekPercentage`: 0.0 to 1.0 (or 0-100) utilization ratio.
* `per1WeekResetTime`: Epoch timestamp in milliseconds.

### Edge Case Handling
* **Intermittent 5h Window Absence**: The Alibaba gateway occasionally omits the 5h window from responses during high traffic. Token Horizon automatically retries up to 3 times with 400ms jitter.
