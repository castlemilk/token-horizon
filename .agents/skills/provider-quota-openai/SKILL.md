---
name: provider-quota-openai
description: >-
  Specifications for monitoring OpenAI Codex stateful JSONL sessions and Platform usage quotas in Token Horizon.
---

# OpenAI Codex & Platform Quota Skill

This skill covers stateful token tracking and platform billing quota monitoring for OpenAI models (GPT-5 Sol, Terra, Luna, o1, o3, GPT-4o).

---

## 1. Local Codex Stateful Tracking

* **Session Directory**: `~/.codex/sessions/*.jsonl`
* **Stateful Offsets**:
  - Maintained per file with byte offsets and watermark tracking.
  - Consumes `total_token_usage` event payloads to measure exact session consumption.

---

## 2. Platform Usage & Billing API

* **Endpoint**: `GET https://api.openai.com/v1/dashboard/billing/usage`
* **Headers**:
  ```http
  Authorization: Bearer <OPENAI_API_KEY>
  ```
