# Token Horizon connector

An installable Codex plugin for the model explorer, prices and plans, community leaderboard, and your claimed Token Horizon profiles.

## Install

From a checkout of this repository, add the repository marketplace root using `codex plugin marketplace add /absolute/path/to/token-horizon`, then install `codex plugin add token-horizon@personal` (the repository marketplace is named `personal`). A personal marketplace copy may use a different existing marketplace name; use that marketplace's name when installing.

Alternatively download the package from https://token-horizon.dev/downloads/token-horizon-plugin.zip. Any compatible MCP client can use `https://token-horizon.dev/mcp` directly. Public-only clients can use `https://token-horizon.dev/mcp/public` without authentication.

Follow your client's OAuth prompt. Google verifies your identity; Token Horizon issues its own scoped credentials. Read access covers claimed profiles, published analytics and private sharing/group settings. Optional management access allows revoking report links. Optional persistent access lasts up to 30 days. Disconnect applications at https://token-horizon.dev/connect.

Claim a community profile using the same Google account before expecting personal data. The hosted connector does not access unpublished usage, local traces, provider credentials, notch or widget state. For those, separately configure the repository's local `mcp/token-horizon-mcp.mjs` server.

This is a distributable repository plugin, not a claim of acceptance into a third-party curated marketplace.
