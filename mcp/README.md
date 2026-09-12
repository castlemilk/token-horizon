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

---

## Testing

Run the automated test suite:
```bash
npm test
```
