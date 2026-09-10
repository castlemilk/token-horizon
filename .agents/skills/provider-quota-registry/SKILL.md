---
name: provider-quota-registry
description: >-
  Master reference and architectural guide for fetching, parsing, and monitoring plan limits,
  rate limits, and quota windows across all AI providers (Alibaba, Anthropic, Google, Zhipu, Kimi, MiniMax, OpenCode, OpenAI, DeepSeek).
---

# Provider Quota & Rate Limit Fetching Master Registry

Token Horizon monitors live plan limits and rolling quota windows for frontier model providers, coding plans, and OAuth developer sessions.

---

## 1. Provider Quota Architecture Overview

All provider limit engines conform to the `ProviderLimit` interface and aggregate into `PlanLimitsEngine.fetchAll()` and `KimiLimitsEngine.fetch()`:

```swift
struct ProviderLimit: Identifiable, Codable {
    var id: String { "\(provider)/\(label)" }
    var provider: String       // e.g. "alibaba", "claude", "gemini", "glm", "kimi", "minimax", "opencode-go"
    var label: String          // e.g. "5h", "weekly", "interval", "monthly", "gemini-2.5-pro"
    var usedPercent: Double    // 0.0 to 100.0
    var resetsAt: Date?        // Next reset window timestamp
    var detail: String         // Extra metadata (e.g. "rate-limited", "120k left")
}
```

---

## 2. Master Provider Mapping Matrix

| Provider | Auth Source | Endpoint / Data Source | Window / Scope | Reset Timing |
|---|---|---|---|---|
| **Alibaba Bailian** | Cookie (`SettingsStore` / env / file) | `POST /data/api.json` (IntlBroadScopeAspnGateway) | 5-Hour rolling & 1-Week rolling | `per5HourResetTime`, `per1WeekResetTime` |
| **Anthropic Claude** | `.credentials.json` / Keychain | `GET /api/oauth/usage` (`oauth-2025-04-20`) | 5h, 7d weekly, weekly model-scoped | `resets_at` (ISO8601) |
| **Google Gemini** | `~/.gemini/oauth_creds.json` | `POST /v1internal:retrieveUserQuota` | Per-model quota buckets | `resetTime` (ISO8601) |
| **Zhipu AI (GLM)** | OpenCode `auth.json` (`zai-coding-plan` / `zai`) | `GET /api/monitor/usage/quota/limit` | 5h, monthly, search units (inverted ratio: `100 - %`) | `nextResetTime` / Real-time |
| **Moonshot Kimi** | `~/.kimi-code/credentials/kimi-code.json` | `GET /coding/v1/usages` (auto-refresh OAuth) | 5h rolling & advanced 100-request window | `reset_time` (epoch ms) |
| **MiniMax** | OpenCode `auth.json` (`minimax-coding-plan`) | `GET /v1/token_plan/remains` | Interval & Weekly remaining % | `end_time`, `weekly_end_time` |
| **OpenCode Go & Free** | OpenCode `auth.json` (`opencode-go`) & `opencode.db` | `GET /zen/go/v1/usage` + SQLite message tracking | Rolling, Weekly, Monthly + Free catalog (`big-pickle`, `x-preview-f-free`) | `resetsAt` (ISO8601) / midnight |
| **OpenAI Codex / Pro** | OpenCode `auth.json` (`openai` OAuth) + local logs | `GET /backend-api/wham/usage` & `~/.codex/sessions/**/*.jsonl` | 7d rolling primary, 5h spark bursting, in-band stream fallback | `reset_at` (epoch seconds) |
| **DeepSeek** | `DEEPSEEK_API_KEY` / `auth.json` | `GET /user/balance` | Balance grants & cache hits | Real-time |

---

## 3. Dedicated Provider Skills

* `provider-quota-alibaba`: Alibaba Cloud Model Studio Bailian Token Plan (Cookie, `sec_token` regex, `cornerstoneParam`, `x-xsrf-token`).
* `provider-quota-anthropic`: Anthropic Claude Code OAuth & macOS Keychain credentials API.
* `provider-quota-google`: Google Gemini Developer CLI OAuth & internal quota buckets.
* `provider-quota-zhipu`: Zhipu AI GLM Coding Plan monitor & quota API with percentage inversion.
* `provider-quota-kimi`: Moonshot Kimi Coding Plan with automatic OAuth token refresh.
* `provider-quota-minimax`: MiniMax Token Plan interval and weekly remainders.
* `provider-quota-opencode`: OpenCode Go Zen rolling/weekly/monthly quota API and SQLite free model discovery (`big-pickle`, etc.).
* `provider-quota-openai`: OpenAI Codex live ChatGPT Pro/Plus backend quota API (`wham/usage`) and recursive JSONL session state.
* `provider-quota-deepseek`: DeepSeek balance API and prompt caching discount tracking.
