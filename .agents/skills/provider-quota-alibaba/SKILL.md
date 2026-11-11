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

Token Horizon checks credentials in the following order (`PlanLimitsEngine.alibaba()`, `clients/macos/Sources/TokenHorizon/Limits/PlanLimitsEngine.swift:123-137`; the Go chain in `daemons/go/internal/providers/limits/vendors/alibaba.go:26-44` is the same):

1. The file named by the `ALIBABA_COOKIE_FILE` environment variable
2. `ALIBABA_TOKEN_PLAN_COOKIE` environment variable
3. `~/.config/token-horizon/alibaba-cookie.txt`
4. `alibabaCookie` in `~/.config/token-horizon/settings.json` (`SettingsStore.shared.alibabaCookie`, `clients/macos/Sources/TokenHorizon/Persistence/SettingsStore.swift:388-430`)

### Cookie Contents
The only check is that the value contains `=`. A leading `cookie:` prefix is removed (`PlanLimitsEngine.swift:138-141`). The whole string is sent as the `Cookie` header. The code reads two cookies from it and validates neither. Whether the gateway needs the other cookies in the same string is vendor behaviour that the code does not check:
* `cna` (anonymous device identifier): sent as `X-Anonymous-Id` in the payload when present (`PlanLimitsEngine.swift:178-180`)
* `login_aliyunid_csrf` (CSRF token): sent as `x-xsrf-token` and `x-csrf-token` when present (`PlanLimitsEngine.swift:211-214`)

---

## 2. Security Handshake & `sec_token` Extraction

The gateway call carries a dynamic `sec_token` scraped from the Model Studio dashboard HTML. If the scrape finds none, the call is still sent without that form field (`PlanLimitsEngine.swift:148-163`, `:197`; `alibaba.go:68-80`, `:104-106`).

1. **Dashboard Request**:
   - URL: `https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan`
   - Headers: `Cookie: <cookie>`, `User-Agent: Mozilla/5.0 ...`
2. **Regex Parsing**:
   ```regex
   sec[_-]?token["'\s:=]+([A-Za-z0-9_%\-]{16,})
   ```
   Extracts the token, which is sent as the form field `sec_token`. The regex is at `PlanLimitsEngine.swift:1058-1059` and `alibaba.go:49`, and `extractSecToken(from:)` is at `PlanLimitsEngine.swift:1063`.

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
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36
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
        "userNickName": "",
        "userPrincipalName": "",
        "X-Anonymous-Id": "<cna>",
        "xsp_lang": "en-US"
      }
    }
  }
  ```
  Sent as form fields: `product=sfm_bailian`, `action=IntlBroadScopeAspnGateway`, `region=ap-southeast-1`, `language=en-US`, `params=<json_string>`, and `sec_token=<sec_token>` only when a token was scraped (`PlanLimitsEngine.swift:181-197`). `X-Anonymous-Id` is present only when the cookie has a `cna` value.

---

## 4. Response Parsing & Window Ratios

The parser takes the first JSON object that contains `per5HourPercentage` or `per1WeekPercentage`. It searches nested objects to a depth of 10 (`findDict`, `PlanLimitsEngine.swift:233-266`). It reads:
* `per5HourPercentage`: a value at or below 1 is multiplied by 100, and a larger value is used as a percent. The result is clamped to 0-100. The row label is `5h`.
* `per5HourResetTime`: epoch timestamp. Values above 1e12 are read as milliseconds and smaller values as seconds (`epochMS`, `PlanLimitsEngine.swift:268-272`).
* `per1WeekPercentage`: same rule as `per5HourPercentage`. The row label is `weekly`.
* `per1WeekResetTime`: same rule as `per5HourResetTime`.

### Edge Case Handling
* **Intermittent 5h Window Absence**: The Alibaba gateway occasionally omits the 5h window from responses during high traffic. When neither window can be parsed, the code retries up to 3 times with a fixed 400 ms sleep. There is no jitter. The Swift engine (`PlanLimitsEngine.swift:224-229`) parses the same response body again on each attempt and sends no new request, so its retry cannot receive a different response. The Go adapter (`alibaba.go:129-174`) sends a new request on each attempt.
