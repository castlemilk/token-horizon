---
name: provider-quota-devin
description: >-
  Specifications for Devin CLI local data sources (session transcripts,
  sessions.db project attribution) and the seat-management quota API that is
  NOT reachable with local credentials in Token Horizon.
---

# Devin Data Skill

Devin usage is ingested **locally** from the Devin CLI's own stores — no
network calls. There is currently no reachable quota/billing endpoint with
the credentials on disk (see §3).

---

## 1. Usage Source — Session Transcripts

* **Path**: `~/.local/share/devin/cli/transcripts/<session_id>.json`
* **Format**: one whole JSON document per session, **rewritten** as steps
  append (not JSONL — no byte-offset tail).

```json
{
  "schema_version": 1,
  "session_id": "towering-frill",
  "agent": {"name": "devin", "version": "3000.11.1", "model_name": "SWE-2 High"},
  "steps": [
    {"step_id": 1, "timestamp": "2026-09-22T05:18:34.257569+00:00",
     "source": "system"},
    {"step_id": 8, "timestamp": "...", "source": "agent",
     "model_name": "SWE-2 High",
     "metrics": {"prompt_tokens": 161200, "completion_tokens": 912,
                 "cached_tokens": 158208}}
  ],
  "final_metrics": {"total_prompt_tokens": 12807806,
                    "total_completion_tokens": 61849,
                    "total_cached_tokens": 12269568, "total_steps": 128}
}
```

* Only `agent` steps carry `metrics`; `system`/`user` steps have none.
* `prompt_tokens` **includes** `cached_tokens` (OpenAI semantics):
  `input = prompt - cached`, `cacheRead = cached`, `output = completion`,
  `cacheWrite = 0`. Total per step = `prompt + completion`.
* Model: `step.model_name` → fallback `agent.model_name` → `"devin"`.

### Scanner (`UsageEngine.scanDevin`)

* Keys live in `genericFiles` under `devin::<abs path>` — persistence,
  `mergedHourlyLocked`, and purge-by-prefix come free.
* Re-parse gate = **(size, mtime)** in `devinMtimes` (in-memory): a same-size
  rewrite can change a step's metrics, so size alone is insufficient.
  `st.offset` persists only as the shrink detector (rotate/recreate → reset).
* Per-step `step_id` → `watermarkDelta` dedups re-parses and absorbs
  cumulative metric rewrites (growth counts as delta only).
* Parse failure (torn write) keeps last-good state; fingerprint recorded
  before parse so a broken doc isn't re-read every tick.

## 2. Project Attribution — sessions.db

* **Path**: `~/.local/share/devin/cli/sessions.db` (sqlite, WAL).
* `SELECT id, working_directory FROM sessions` — transcript filename stem is
  the session id. Read via `devinProjectDirs(base:)`, opened
  `READONLY | FULLMUTEX`, fingerprint-gated on db/-wal/-shm mtime+size.
* `sessions.metadata` carries `{"total_credit_cost":…,"total_acu_cost":…}`
  per session (ACU totals — a cost signal, not a quota).

## 3. Quota/Billing API — NOT reachable (verified 2026-09)

* `~/.local/share/devin/credentials.toml` holds
  `windsurf_api_key = "devin-session-token$<JWT>"` where the JWT payload is
  only `{"session_id": "windsurf-session-…"}` — a **session-scoped** token,
  not a user credential.
* Connect-RPC seat endpoints on `api_server_url`
  (`https://server.codeium.com`):
  `POST /exa.seat_management_pb.SeatManagementService/GetUserStatus` and
  `…/GetCliTeamSettings` return `invalid_argument` for every auth variant
  tried (full token / raw JWT bearer, `x-api-key`, `x-session-token`,
  `session_id`/`api_key` body fields). These back the CLI's `/usage`,
  `/session-stats` (monthly credits, `plan_info`, `devin_info`).
* `https://api.devin.ai` org REST endpoints (`/v3/sessions`, `/v1/usage`,
  `/v1/secrets`) need a **`cog_…` service API key** — not present locally.
* To add Devin *quota* rows later: need either a real user-level token
  (post-PKCE `ExchangeDevinCLIPKCECode` credential — check for newer
  credential files) or a user-supplied `DEVIN_API_KEY` service key, then map
  `monthly_prompt_credits`/`devin_info` usage into `ProviderLimit`.
