# Token Horizon Leaderboard MCP Server (`token-horizon-mcp`)

Model Context Protocol (MCP) server for **Token Horizon** — seamlessly inspect real-time LLM token leaderboards, query live macOS daemon telemetry, sync participant metrics, and compare dev efficiency directly from any MCP client (Claude Code, Claude Desktop, Cursor, Antigravity).

## Features

- **🏆 Real-Time Leaderboard**: Query platform metrics, KPIs, and rankings by period (`today`, `week`, `all`, `streak`) or team.
- **👤 Deep Participant Profiles**: Access 7-day activity sparklines/histograms, model allocation inventories (up to 36 models), tool spend, hardware info, and verification badges.
- **⚡ Local Daemon Integration**: Query the running macOS Token Horizon daemon (`127.0.0.1:8765`) live for local dev metrics without leaving your AI assistant.
- **🚀 Telemetry Sync & Publishing**: One-click publish from the local daemon or custom payloads to the public edge leaderboard (`token-horizon.dev`), protected by cryptographic claim tokens or Google Auth.
- **⭐ Ownership & Verification**: Claim profiles with Google login to lock handles and activate the verified badge.
- **⚔️ Dev Comparison**: Head-to-head comparison between participants (token volume, effective $/M tokens, model preference, streaks).

---

## Quickstart

### 1. Installation

```bash
cd ~/projects/token-horizon/mcp
npm install
```

To run directly:
```bash
node src/index.js
```

---

## Client Configurations

### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "token-horizon": {
      "command": "node",
      "args": [
        "/Users/benebsworth/projects/token-horizon/mcp/src/index.js"
      ],
      "env": {
        "TOKEN_HORIZON_API_BASE": "https://token-horizon.dev",
        "TOKEN_HORIZON_DAEMON_BASE": "http://127.0.0.1:8765"
      }
    }
  }
}
```

### Claude Code / Codex CLI
```bash
claude mcp add token-horizon node /Users/benebsworth/projects/token-horizon/mcp/src/index.js
```

---

## Tool Catalog

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `get_leaderboard` | `period` (`today`\|`week`\|`all`\|`streak`), `team`, `limit` | Fetch ranked participants, spend, active streaks, and platform KPIs. |
| `get_user_profile` | `handle` | Full breakdown for a participant: ranks, models, telemetry tools, 7-day activity, and verification status. |
| `get_daemon_metrics` | _none_ | Live LLM metrics directly from the local macOS Token Horizon daemon (`127.0.0.1:8765`). |
| `publish_telemetry` | `from_daemon` (bool), `entry`, `claim_token`, `google_token` | Sync/publish metrics to the edge leaderboard. |
| `claim_profile` | `handle`, `google_token`, `claim_token` | Claim an unclaimed profile using Google OAuth JWT to lock ownership. |
| `compare_users` | `user1`, `user2` | Side-by-side performance and efficiency comparison between two developers. |
| `search_models` | `query`, `provider`, `plan`, `scope`, `sort`, `limit`, `unified` | Search the unified model catalog with pricing evidence (priced / free / plan-covered / unpriced), SWE-bench & LiveCodeBench scores, context windows, and plan linkage. |
| `get_plans` | `plan`, `provider`, `include_models`, `limit` | Subscription plans with verified usage tiers (prices, quota windows, included models) and per-plan catalog model counts. |

---

## Testing

Run the automated test suite:
```bash
npm test
```

## MCP Apps and OpenAI extensions

The hosted connector and local stdio server share a self-contained Usage
observatory resource. Compatible hosts discover global/sidebar and thread
entrypoints through `token_horizon_app`; `token_horizon_overview` also renders the
app inline. Text tools continue to work in hosts without MCP Apps support.

The app follows host light/dark theme and accepts `/models`, `/usage`, `/traces`
deep links through `openai/deepLink`. Composer mentions use
`token_horizon_search_mentions` and exact `tokenhorizon://models/{encoded-id}`
resources. Unknown or arbitrary resource URLs are rejected. The app can attach
metadata to context and ask a question in chat only after the user clicks the
corresponding button. It declares inline/fullscreen display support and a CSP
with no external network/resource domains.

Hosted connections show published community KPIs and catalog metadata. They do
not access local usage, device traces, prompts or account credentials. Local
stdio connections read the configured local daemon's usage and bounded trace
metadata; prompt/response bodies, raw error text and session keys are excluded.
Failures remain unavailable with a warning, rather than becoming fabricated
zero totals. Catalog prices are estimates per million tokens, not billed spend.
This extension does not activate proxy routing or modify credentials.

Build and verify the pinned SDK bundle:

```bash
npm ci --prefix cloudflare --ignore-scripts
node scripts/build-mcp-ui.mjs
node scripts/build-mcp-ui.mjs --check
node --test mcp/test-extensions.mjs cloudflare/connector.test.mjs
node scripts/test-mcp-extensions-ui.mjs
```

The fixture exercises the actual SDK message bridge without a connected account,
live network or user browser profile. The bundle is vendored for offline loading.
General file viewers, forms and resource writes are not advertised: the app is a
read-only metadata observatory. [Extension specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md).
