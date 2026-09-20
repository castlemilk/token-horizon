#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import readline from "node:readline";
import { fetchCatalog, searchCatalog, planList } from "./catalog.mjs";

const BASE = process.env.NOTCHMON_URL || "http://127.0.0.1:8765";
const ENGINE_BASE = process.env.TOKEN_HORIZON_ENGINE_URL || "http://127.0.0.1:8766";
const DB = `${homedir()}/.local/share/opencode/opencode.db`;

const TOOLS = [
  {
    name: "token_horizon_usage",
    description:
      "AI token usage, cost, cache rates, and model/tool breakdown tracked by Token Horizon across local AI coding tools (opencode, claude-code, codex, agy). Each model includes share_percent (0-100 share of its provider's tokens, e.g. fable vs opus within claude). Pass period=today or period=all.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "all"], default: "today" },
      },
    },
  },
  {
    name: "token_horizon_limits",
    description:
      "Provider plan limits, quota reset countdowns, and rate limit status tracked by Token Horizon (AGY Gemini, OpenCode Go, Claude, Kimi, GLM, MiniMax, Alibaba, Codex). Pass provider to filter.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Optional filter by provider name (e.g. 'agy', 'opencode-go', 'kimi', 'glm', 'minimax', 'codex', 'claude', 'alibaba')",
        },
      },
    },
  },
  {
    name: "token_horizon_claude_accounts",
    description:
      "Discovered Claude accounts, organization details, token usage, and live quota limits across all configured Claude Code profiles (e.g. ~/.claude, ~/.claude-1, ~/.claude-2).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "token_horizon_trends",
    description:
      "AI token usage trends over selectable windows (1D, 1W, 1M, 3M, 1Y) with tool-level breakdown and rolling token totals.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["1D", "1W", "1M", "3M", "1Y"], default: "1M" },
      },
    },
  },
  {
    name: "token_horizon_proxy_guide",
    description:
      "Safe startup protocol and configuration examples for routing traffic through Token Horizon's per-vendor request meters for exact per-request token measurement, live tok/s, TTFT, retry-suspect, and error-taxonomy diagnostics, plus full conversation-trace capture (drop-in base URLs for Codex, Claude Code, and local runtimes). Use client=startup for the server/meter startup sequence.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          enum: ["all", "startup", "environment", "opencode", "continue", "python", "curl", "codex", "claude"],
          default: "all",
          description: "Target client or startup protocol to show instructions for (default 'all')",
        },
      },
    },
  },
  {
    name: "token_horizon_system",
    description: "Live macOS system stats from Token Horizon: CPU %, RAM used/total GB, load average, and active proxy status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "token_horizon_processes",
    description:
      "Live process telemetry sorted by CPU%, memory (RSS), disk I/O, or network I/O. Supports process tree hierarchy, substring filtering, and deep PID inspection (open files, threads, runtime).",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ["cpu", "mem", "disk", "net"], default: "cpu" },
        limit: { type: "number", default: 8 },
        filter: { type: "string", description: "Case-insensitive substring filter on process name or command" },
        tree: { type: "boolean", description: "Return full hierarchical process tree if true" },
        pid: { type: "number", description: "Drill-down inspection of a specific PID" },
      },
    },
  },
  {
    name: "token_horizon_sessions",
    description: "Recent AI coding sessions (title, directory, tokens, cost, created time) tracked by Token Horizon.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 10 } },
    },
  },
  {
    name: "token_horizon_history",
    description:
      "Daily AI token usage history (heatmap data) tracked by Token Horizon, per day with per-provider breakdown. Pass days (7-370, default 365).",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", default: 365 } },
    },
  },
  {
    name: "token_horizon_events",
    description: "Recent terminal / shell execution events tracked by Token Horizon (time, cwd, duration, exit code).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 20 } },
    },
  },
  {
    name: "token_horizon_models",
    description:
      "Search and query AI models catalog with net blended pricing (prompt caching discounts), context windows, and SWE-bench / LiveCodeBench rankings. Optionally view Top Picks.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter by model name, provider, or capability" },
        scope: { type: "string", enum: ["ALL", "CODING", "LOCAL", "FREE", "REASONING", "FLAGSHIP"], default: "ALL" },
        top_picks: { type: "boolean", default: false, description: "If true, return top 10 ranked models by benchmark performance and net blended cost" },
      },
    },
  },
  {
    name: "token_horizon_catalog",
    description:
      "Search the unified Token Horizon model catalog — the same merged/deduped list as token-horizon.dev/models. Includes pricing evidence (price_known distinguishes real free tiers from plan-covered or unpriced models), SWE-bench/LiveCodeBench scores, capabilities, context windows, and subscription-plan linkage. Sources: local daemon /models/catalog first, hosted /api/models/catalog fallback.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms; all tokens must match name/id/provider/description" },
        provider: { type: "string", description: "Filter by provider id or label (e.g. 'anthropic', 'kimi', 'github-copilot')" },
        plan: { type: "string", description: "Only models covered by this subscription plan id (see token_horizon_plans)" },
        scope: { type: "string", enum: ["all", "cloud", "local", "free", "benchmarked", "plan", "unknown_price"], default: "all" },
        sort: { type: "string", enum: ["featured", "value", "swe", "lcb", "context", "input", "output", "blended", "name"], default: "featured" },
        limit: { type: "number", default: 20, description: "Max rows to return (1-100)" },
        unified: { type: "boolean", default: true, description: "Collapse duplicate listings into one row per model (recommended)" },
      },
    },
  },
  {
    name: "token_horizon_plans",
    description:
      "Subscription plans in the Token Horizon catalog (GitHub Copilot, Kimi Code, MiniMax Token Plan, GLM Coding Plan, OpenCode Zen, Alibaba, Volcengine, Tencent, Xiaomi, StepFun, ...): verified usage tiers with prices/quota windows, included models, provider docs, and per-plan model counts. Pass include_models=true to list the catalog models each plan covers.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Specific plan id (e.g. 'github-copilot', 'kimi-for-coding', 'minimax-coding-plan')" },
        provider: { type: "string", description: "Filter plans by provider id substring" },
        include_models: { type: "boolean", default: false, description: "Include the covered catalog models per plan" },
        limit: { type: "number", default: 50, description: "Max covered models per plan when include_models=true" },
      },
    },
  },
  {
    name: "token_horizon_discovery",
    description:
      "Monitor or trigger live AI model discovery across local runtime caches (Codex, OpenCode, Ollama) and remote provider APIs. Returns monitored file states and discovered models count.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "scan"], default: "status" },
        include_remote: { type: "boolean", default: true, description: "Whether to include remote provider APIs in scan" },
      },
    },
  },
  {
    name: "token_horizon_workflows",
    description:
      "Inspect, trigger, and track agentic automation workflows in Token Horizon (e.g. CloudGuardian cloud infrastructure & cost assessment, code quality remediation). Actions: 'list' (all workflows), 'run' (trigger a workflow DAG), 'runs' (execution history), 'get_run' (single execution state), 'logs' (run step output logs).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "run", "runs", "get_run", "logs"],
          default: "list",
          description: "Action to perform",
        },
        workflow_id: {
          type: "string",
          description: "ID of workflow to run (e.g. 'cloudguardian-assessment', 'code-quality-remediation')",
        },
        run_id: {
          type: "string",
          description: "ID of workflow run to inspect or get logs for",
        },
        inputs: {
          type: "object",
          description: "Key-value input parameters for the workflow (e.g. { org: '...', model_provider: 'agy', dry_run: true })",
        },
      },
    },
  },
  {
    name: "token_horizon_nodes",
    description:
      "Cross-platform cluster telemetry across macOS (Apple Silicon unified memory), Linux (NVIDIA CUDA / ROCm), and Windows nodes. Reports CPU %, RAM, GPU VRAM, active model processes, and heartbeats.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "Optional node ID to filter by",
        },
      },
    },
  },
  {
    name: "token_horizon_leaderboard",
    description:
      "Fetch, publish, or sync AI token usage rankings across local profiles, teams, peer nodes, cloud (Cloudflare Worker+R2, fast) or Google Spreadsheet backend, and GitHub Pages web app. Actions: 'get' (default, fetch rankings), 'publish' (push your token stats), 'pull' (pull team rows), 'config' (set backend URLs), 'web' (get GitHub Pages web leaderboard URL). The 'backend' param selects 'auto' (cloud when configured, else sheets), 'cloud', or 'sheets'.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "publish", "pull", "config", "web"],
          default: "get",
          description: "Action to perform ('get', 'publish', 'pull', 'config', 'web')",
        },
        backend: {
          type: "string",
          enum: ["auto", "cloud", "sheets"],
          default: "auto",
          description: "Sync backend for publish/pull/config ('auto' uses cloud when configured, else sheets)",
        },
        period: {
          type: "string",
          enum: ["today", "week", "all", "streak"],
          default: "today",
          description: "Leaderboard ranking period (today, week/7d, all, streak)",
        },
        team: {
          type: "string",
          description: "Optional team or organization filter",
        },
        sheets_url: {
          type: "string",
          description: "Optional Google Apps Script Web App URL or Published Google Sheet CSV URL when action is 'config'",
        },
        cloud_url: {
          type: "string",
          description: "Optional Cloudflare Worker base URL (e.g. https://…workers.dev) when action is 'config'",
        },
        cloud_token: {
          type: "string",
          description: "Optional cloud write token when action is 'config' (never logged)",
        },
      },
    },
  },
  {
    name: "token_horizon_share",
    description:
      "Generate a formatted AI token usage share card for social sharing, GitHub READMEs, team reporting, or clipboard copy. Available formats: text, markdown, json, svg.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week", "all", "streak"],
          default: "today",
          description: "Time period for the share card",
        },
        format: {
          type: "string",
          enum: ["text", "markdown", "json", "svg"],
          default: "text",
          description: "Output format of the share card (text, markdown, json, svg)",
        },
        copy: {
          type: "boolean",
          default: false,
          description: "If true, also copy the share card to macOS clipboard",
        },
      },
    },
  },
];

function sh(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

async function api(path, timeoutMs = 6000) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function engineApi(path, options = {}) {
  const res = await fetch(`${ENGINE_BASE}${path}`, {
    signal: AbortSignal.timeout(15000),
    ...options,
  });
  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch {}
    throw new Error(`Engine HTTP ${res.status}: ${errBody || res.statusText}`);
  }
  return res.json();
}

function formatRelativeCountdown(epochSec) {
  if (!epochSec) return null;
  const now = Date.now() / 1000;
  const diff = epochSec - now;
  if (diff <= 0) return "resets now";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const days = Math.floor(hours / 24);
  if (days >= 2) return `${days}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function usageFallback() {
  if (!existsSync(DB)) throw new Error("opencode.db not found");
  // UTC midnight — the API contract is UTC end-to-end; local rendering
  // happens in human-facing frontends only.
  const n = new Date();
  const midnightMs = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  const q = async (sql) =>
    (await sh("sqlite3", [DB, sql])).split("|").map(Number);
  const [allTok, allCost] = await q(
    "SELECT COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write),0)||'|'||printf('%.2f',SUM(cost)) FROM session"
  );
  const [todayTok, todayCost] = await q(
    `SELECT COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write),0)||'|'||printf('%.2f',SUM(cost)) FROM session WHERE time_created > ${midnightMs}`
  );
  return { tokens_today: todayTok, cost_today: todayCost, tokens_all_time: allTok, cost_all_time: allCost, sources: ["opencode"], note: "direct sqlite fallback (app not running)" };
}

async function sessionsFallback(limit) {
  const rows = await sh("sqlite3", [
    DB,
    "SELECT id,title,cost,tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write,directory,time_created FROM session ORDER BY time_updated DESC LIMIT " +
      limit,
  ]);
  return rows.split("\n").filter(Boolean).map((r) => {
    const [id, title, cost, tokens, directory, created] = r.split("|");
    return { id, title, cost: Number(cost), tokens: Number(tokens), directory, created: new Date(Number(created)) };
  });
}

async function callTool(name, args) {
  try {
    switch (name) {
      case "token_horizon_usage": {
        const d = await api("/stats");
        const u = d.usage;
        const models = (u.models || []).map((m) => ({
          model: m.model,
          provider: m.provider,
          tokens_today: m.tokensToday,
          tokens_all: m.tokensAll,
          cost: m.cost,
          free: m.free,
          share_percent: Math.round((m.sharePercent || 0) * 10) / 10,
        }));
        const byTool = (u.perTool || []).map((t) => {
          const total = t.tokensAllTime || 0;
          const cacheRead = t.cacheReadAll || 0;
          const hitRate = total > 0 ? Math.round((cacheRead / total) * 1000) / 10 : 0;
          return {
            tool: t.tool,
            tokens_today: t.tokensToday,
            tokens_all: t.tokensAllTime,
            cost_today: t.costToday,
            cost_all: t.costAllTime,
            cache_read_all: t.cacheReadAll,
            cache_hit_rate_pct: hitRate,
          };
        });
        const freeTokens = models.filter((m) => m.free).reduce((acc, m) => acc + (args?.period === "all" ? m.tokens_all : m.tokens_today), 0);
        const paidTokens = models.filter((m) => !m.free).reduce((acc, m) => acc + (args?.period === "all" ? m.tokens_all : m.tokens_today), 0);

        const base = args?.period === "all"
          ? { tokens: u.tokensAllTime, cost: u.costAllTime, sources: u.sources }
          : { tokens: u.tokensToday, cost: u.costToday, sources: u.sources };

        return {
          ...base,
          summary: {
            free_tokens: freeTokens,
            paid_tokens: paidTokens,
            total_tokens: base.tokens,
            total_cost: base.cost,
          },
          by_tool: byTool,
          models,
          claude_accounts: u.claudeAccounts || [],
        };
      }
      case "token_horizon_claude_accounts": {
        try {
          const res = await api("/claude/accounts");
          if (res?.accounts) return res;
        } catch {}
        try {
          const stats = await api("/stats");
          if (stats?.claudeAccounts) return { accounts: stats.claudeAccounts };
        } catch {}
        return { accounts: [] };
      }
      case "token_horizon_proxy_guide": {
        let health = null;
        let meters = [];
        try {
          health = await api("/health");
          meters = await api("/meters");
        } catch {
          health = { ok: false };
        }
        const configuredUpstream = process.env.TOKEN_HORIZON_OLLAMA_UPSTREAM || "127.0.0.1:11434";
        // /meters: {mode, point: [...], mitm?} (legacy: bare array)
        const meterList = Array.isArray(meters) ? meters : (meters?.point ?? []);
        const runtimeMeter = meterList.find(m => m.vendor === "ollama") || meterList[0] || null;
        const port = (runtimeMeter && runtimeMeter.listen_port) || Number(process.env.TOKEN_HORIZON_OLLAMA_PROXY_PORT || 11435);
        const proxyURL = process.env.OLLAMA_PROXY_URL || `http://127.0.0.1:${port}`;
        const tokenHorizonReachable = health.name === "token-horizon" && health.ok === true;
        // Live meter URL per vendor for drop-in client configs; falls back
        // to the deterministic default ports when /meters is unreachable.
        const defaultMeterPorts = { claude: 9241, openai: 9242, codex: 9243, glm: 9244, opencode: 9245, kimi: 9246, minimax: 9247, alibaba: 9248, deepseek: 9249, gemini: 9250, ollama: 11435, vllm: 9311, sglang: 9312, llamacpp: 9313, mlx: 9314 };
        const meterURLFor = (vendor) => {
          const live = meterList.find(m => m.vendor === vendor && m.listen_port);
          const p = (live && live.listen_port) || defaultMeterPorts[vendor] || port;
          return `http://127.0.0.1:${p}`;
        };
        const target = (args?.client || "all").toLowerCase();

        const guide = {
          meters: {
            active_port: port,
            meter_url: proxyURL,
            upstream_default: `http://${configuredUpstream}`,
            token_horizon_reachable: tokenHorizonReachable,
            running: meterList.map(m => ({ vendor: m.vendor, listen_port: m.listen_port, target: m.target ?? null })),
            by_vendor: Object.fromEntries(meterList.map(m => [m.vendor, `http://127.0.0.1:${m.listen_port}`])),
          },
          summary:
            "Token Horizon measures AI usage with per-vendor request meters: consented loopback listeners that forward bytes unchanged and record exact per-request tokens (provider-reported, never estimated) plus live tok/s, TTFT, retry-suspect, and error-taxonomy diagnostics. Every metered exchange also captures a full conversation trace (capped bodies, auth never stored) — join client logs to traces via the x-token-horizon-event-id response header.",
          meters_guide: {
            purpose: "One loopback listener per vendor, served by the Token Horizon daemon (point methodology). Point a client's base URL at the vendor's meter port and every exchange is measured and traced; traffic sent directly upstream is invisible.",
            upstreams: {
              openai: process.env.TOKEN_HORIZON_OPENAI_UPSTREAM || "https://api.openai.com",
              anthropic: process.env.TOKEN_HORIZON_ANTHROPIC_UPSTREAM || "https://api.anthropic.com",
              ollama: `http://${configuredUpstream}`,
              note: "Upstreams are per-vendor meter targets (settings.json runtimeEndpoints / TH_METERS 'vendor:port->target'); runtimes auto-meter on first sighting.",
            },
            trace_correlation: "Every relayed response carries an x-token-horizon-event-id header; join client-side logs to GET /traces/<id> (and the usage row via GET /analytics/events?id=) on :8765.",
            storage_bounds: "Trace bodies capped at 256KB per side, FIFO-bounded table (2000 rows), local-only in usage.db. Traces never feed usage totals; metered request events are the single counting path. Disable capture with traceCapture=false in settings.json or TH_TRACES=0.",
          },
          configurations: {},
        };

        const appPath = process.env.TOKEN_HORIZON_APP || "/Users/benebsworth/projects/token-horizon/TokenHorizon.app";
        guide.startup = {
          purpose: "Run the local runtime upstream, run Token Horizon beside it, and point the client at the request meter.",
          order: [
            "Keep the runtime daemon on the upstream address; the daemon itself is not routed through the meter.",
            "Start Token Horizon; with .metering consent it listens on deterministic loopback meter ports (visible via GET /meters).",
            "Set the client base URL/host to the meter URL before running an inference request.",
          ],
          runtime_server: {
            upstream: `http://${configuredUpstream}`,
            command: `OLLAMA_HOST="${configuredUpstream}" ollama serve`,
            note: "Run this only when an Ollama daemon is not already managed by the Ollama app.",
          },
          token_horizon: {
            app: appPath,
            command: `open "${appPath}"`,
            note: "Token Horizon starts meters automatically on runtime sighting; ports are listed under GET /meters.",
          },
          client: {
            proxy_url: proxyURL,
            environment: `export OLLAMA_HOST="${proxyURL}"`,
            command: `OLLAMA_HOST="${proxyURL}" ollama run <model>`,
          },
          verify: [
            `${BASE}/health`,
            `${BASE}/meters`,
            `${BASE}/metrics`,
          ],
          do_not: [
            `Do not run OLLAMA_HOST="${proxyURL}" ollama serve; that would try to bind the meter port instead of starting the upstream daemon.`,
            "Do not send metered clients directly to the upstream address if measurement is required.",
            "Do not replace the plain ollama command with a global alias; use a scoped client environment or wrapper.",
          ],
        };

        if (target !== "all" && target !== "startup") delete guide.startup;

        if (target === "all" || target === "environment") {
          guide.configurations.environment = {
            description: "Set default Ollama client target in your shell (~/.zshrc or ~/.bashrc)",
            commands: [
              `export OLLAMA_HOST="${proxyURL}"`,
              `export OLLAMA_BASE_URL="${proxyURL}"`,
            ],
          };
        }

        if (target === "all" || target === "opencode") {
          guide.configurations.opencode = {
            description: "Configure OpenCode to route local models through the request meter in ~/.config/opencode/opencode.json",
            snippet: {
              provider: {
                ollama: {
                  options: {
                    baseURL: proxyURL,
                  },
                },
              },
            },
          };
        }

        if (target === "all" || target === "continue") {
          guide.configurations.continue_dev = {
            description: "Configure Continue.dev (VS Code / JetBrains) in ~/.continue/config.json",
            snippet: {
              models: [
                {
                  title: "Ollama (via Token Horizon meter)",
                  provider: "ollama",
                  model: "llama3.2",
                  apiBase: proxyURL,
                },
              ],
            },
          };
        }

        if (target === "all" || target === "python") {
          guide.configurations.python = {
            description: "Using the official ollama or openai Python SDKs",
            code: [
              "# Official ollama-python client:",
              "import ollama",
              `client = ollama.Client(host='${proxyURL}')`,
              "response = client.generate(model='llama3.2', prompt='Hello world')",
              "",
              "# OpenAI-compatible endpoint client:",
              "import openai",
              `client = openai.OpenAI(base_url='${proxyURL}/v1', api_key='ollama')`,
            ].join("\n"),
          };
        }

        if (target === "all" || target === "curl") {
          guide.configurations.curl = {
            description: "Direct REST API call via cURL",
            command: `curl ${proxyURL}/api/generate -d '{"model": "llama3.2", "prompt": "Why is the sky blue?"}'`,
          };
        }

        if (target === "all" || target === "codex") {
          guide.configurations.codex = {
            description: "Route Codex (or any OpenAI SDK / Responses API client) through the openai meter for measurement + full-trace capture",
            commands: [
              `export OPENAI_BASE_URL="${meterURLFor("openai")}"`,
              `codex --model gpt-5 "explain this repo"`,
            ],
            config_toml_alternative: [
              "# ~/.codex/config.toml — when env override is not picked up:",
              "[model_providers.token-horizon]",
              `base_url = "${meterURLFor("openai")}/v1"`,
              'wire_api = "responses"',
            ].join("\n"),
            note: "API key handling is unchanged (the meter forwards your Authorization header upstream); only the base URL moves.",
          };
        }

        if (target === "all" || target === "claude") {
          guide.configurations.claude = {
            description: "Route Claude Code through the anthropic meter for measurement + full-trace capture",
            commands: [
              `export ANTHROPIC_BASE_URL="${meterURLFor("claude")}"`,
              `claude --model sonnet`,
            ],
            note: "Auth env (ANTHROPIC_AUTH_TOKEN / login) is unchanged; only the base URL moves. Traces appear under provider=anthropic.",
          };
        }

        guide.observability = {
          ui_tracking: "Measured tokens/second appear live in Token Horizon's MODELS tab and runtime views.",
          prometheus_exporter: "http://127.0.0.1:8765/metrics",
          stats_api: "http://127.0.0.1:8765/stats",
          traces_api: "http://127.0.0.1:8765/traces (list, bodies omitted) and http://127.0.0.1:8765/traces/<id> (full trace)",
          proxy_stats_api: "http://127.0.0.1:8765/proxy/stats?provider=openai&hours=24 (TTFT, tok/s, retry, error rates)",
        };

        return guide;
      }
      case "token_horizon_system": {
        const d = await api("/stats");
        return d.system;
      }
      case "token_horizon_limits": {
        // Cold /limits refreshes every provider in turn; give it room instead
        // of timing out and being misreported as an unknown tool below.
        const d = await api("/limits", 20000);
        let limits = (d.limits || []).map((lim) => {
          const usedPct = lim.usedPercent ?? 0;
          const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
          const isRateLimited = (lim.detail || "").toLowerCase().includes("rate-limited") || usedPct >= 100;
          const status = isRateLimited ? "rate_limited" : usedPct >= 80 ? "high_usage" : "ok";
          return {
            provider: lim.provider,
            label: lim.label,
            used_percent: usedPct,
            remaining_percent: remainingPct,
            detail: lim.detail || "",
            status,
            resets_at: lim.resetsAt ? new Date(lim.resetsAt * 1000).toISOString() : null,
            resets_in: lim.resetsAt ? formatRelativeCountdown(lim.resetsAt) : null,
          };
        });
        if (args?.provider && args.provider !== "all") {
          const filterP = args.provider.toLowerCase();
          limits = limits.filter((l) => l.provider.toLowerCase().includes(filterP));
        }
        return {
          count: limits.length,
          limits,
          weekly_resets: d.weeklyResets || [],
          next_weekly_reset: d.nextWeeklyReset || null,
          maximizer_recommendation: d.maximizerRecommendation || null,
        };
      }
      case "token_horizon_trends": {
        const win = ["1D", "1W", "1M", "3M", "1Y"].includes(args?.window?.toUpperCase()) ? args.window.toUpperCase() : "1M";
        const d = await api(`/trends?window=${win}`);
        return {
          window: d.window,
          total_tokens: d.total,
          points: d.points,
        };
      }
      case "token_horizon_sessions": {
        const limit = Math.min(args?.limit ?? 10, 50);
        const d = await api("/stats");
        return d.usage.recentSessions?.slice(0, limit) ?? [];
      }
      case "token_horizon_processes": {
        const sort = ["cpu", "mem", "disk", "net"].includes(args?.sort) ? args.sort : "cpu";
        const limit = Math.min(Math.max(args?.limit ?? 25, 1), 200);
        const filter = (args?.filter || "").toLowerCase();
        const tree = args?.tree === true;
        const detailPid = args?.pid;
        if (detailPid) {
          return await api(`/process?pid=${encodeURIComponent(detailPid)}`);
        }
        if (tree) {
          const p = await api("/processes");
          return p.tree;
        }
        const p = await api("/processes");
        const map = { cpu: p.byCPU ?? p.all, mem: p.byMem ?? p.all, disk: p.byDisk ?? p.all, net: p.byNet ?? p.all };
        let list = map[sort] || p.all || p.byCPU;
        if (filter) list = list.filter((r) => r.name.toLowerCase().includes(filter) || r.command.toLowerCase().includes(filter));
        return list.slice(0, limit);
      }
      case "token_horizon_history": {
        const days = Math.min(Math.max(args?.days ?? 365, 7), 370);
        const d = await api(`/history?days=${days}`);
        return { streak: d.streak, days: d.days, points: d.points };
      }
      case "token_horizon_events": {
        const limit = Math.min(Math.max(args?.limit ?? 20, 1), 100);
        const d = await api("/events");
        return Array.isArray(d) ? d.slice(0, limit) : [];
      }
      case "token_horizon_models": {
        if (args?.top_picks) {
          const d = await api("/top-picks");
          return d.topPicks;
        }
        const search = encodeURIComponent(args?.search || "");
        const scope = encodeURIComponent(args?.scope || "ALL");
        const d = await api(`/models?search=${search}&scope=${scope}`);
        return d;
      }
      case "token_horizon_catalog": {
        const catalog = await fetchCatalog();
        return searchCatalog(catalog, args || {});
      }
      case "token_horizon_plans": {
        const catalog = await fetchCatalog();
        return planList(catalog, args || {});
      }
      case "token_horizon_discovery": {
        const action = args?.action || "status";
        if (action === "scan") {
          const remote = args?.include_remote !== false ? "1" : "0";
          const res = await fetch(`${BASE}/discovery/scan?remote=${remote}`, { method: "POST", signal: AbortSignal.timeout(10000) });
          return res.json();
        }
        const d = await api("/discovery/status");
        return d;
      }
      case "token_horizon_workflows": {
        const action = args?.action || "list";
        if (action === "list") {
          return await engineApi("/api/workflows");
        }
        if (action === "run") {
          const wfId = args?.workflow_id;
          if (!wfId) throw new Error("workflow_id is required for action 'run'");
          return await engineApi(`/api/workflows/${encodeURIComponent(wfId)}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputs: args?.inputs || {} }),
          });
        }
        if (action === "runs") {
          return await engineApi("/api/runs");
        }
        if (action === "get_run") {
          const runId = args?.run_id;
          if (!runId) throw new Error("run_id is required for action 'get_run'");
          return await engineApi(`/api/runs/${encodeURIComponent(runId)}`);
        }
        if (action === "logs") {
          const runId = args?.run_id;
          if (!runId) throw new Error("run_id is required for action 'logs'");
          return await engineApi(`/api/runs/${encodeURIComponent(runId)}/logs`);
        }
        throw new Error(`unknown workflows action ${action}`);
      }
      case "token_horizon_nodes": {
        const nodes = await engineApi("/api/nodes");
        if (args?.node_id) {
          const filtered = nodes.filter((n) => n.id === args.node_id || n.hostname.toLowerCase().includes(args.node_id.toLowerCase()));
          return filtered.length === 1 ? filtered[0] : filtered;
        }
        return nodes;
      }
      case "token_horizon_leaderboard": {
        const action = args?.action || "get";
        // Resolve backend once: explicit choice wins, otherwise cloud when the
        // app reports one configured, else legacy sheets.
        const resolveBackend = async (want) => {
          if (want === "cloud" || want === "sheets") return want;
          try {
            const cfg = await api("/leaderboard/sheets/config");
            if (cfg.cloudConfigured) return "cloud";
          } catch { /* fall through to sheets */ }
          return "sheets";
        };
        if (action === "publish") {
          const backend = await resolveBackend(args?.backend);
          const res = await fetch(`${BASE}/leaderboard/${backend}/publish`, { method: "POST", signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`publish error: HTTP ${res.status}`);
          return await res.json();
        }
        if (action === "pull") {
          const backend = await resolveBackend(args?.backend);
          const res = await fetch(`${BASE}/leaderboard/${backend}/pull`, { method: "POST", signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`pull error: HTTP ${res.status}`);
          return await res.json();
        }
        if (action === "config") {
          if (args?.sheets_url || args?.cloud_url || args?.cloud_token) {
            const body = JSON.stringify({
              ...(args?.sheets_url ? {sheetsURL: args.sheets_url} : {}),
              ...(args?.cloud_url ? {cloudURL: args.cloud_url} : {}),
              ...(args?.cloud_token ? {cloudToken: args.cloud_token} : {}),
            });
            const res = await fetch(`${BASE}/leaderboard/sheets/config`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: AbortSignal.timeout(6000),
            });
            return await res.json();
          }
          return await api("/leaderboard/sheets/config");
        }
        if (action === "web" || action === "pages") {
          const cfg = await api("/leaderboard/sheets/config").catch(() => ({ sheetsURL: "", cloudURL: "", cloudConfigured: false }));
          let webUrl = "";
          if (cfg.cloudConfigured && cfg.cloudURL) {
            webUrl = cfg.cloudURL.endsWith("/leaderboard.html") ? cfg.cloudURL : `${cfg.cloudURL}/leaderboard.html`;
          } else {
            const sheetParam = cfg.sheetsURL ? `?sheet=${encodeURIComponent(cfg.sheetsURL)}` : "";
            webUrl = `https://token-horizon.dev/leaderboard${sheetParam}`;
          }
          return {
            web_url: webUrl,
            cloud_url: cfg.cloudURL || null,
            sheets_url: cfg.sheetsURL || null,
            message: cfg.cloudConfigured ? "Open in browser to view live team leaderboard hosted on Cloudflare Edge + R2" : "Open in browser to view live team leaderboard hosted on GitHub Pages",
          };
        }
        const period = args?.period || "today";
        const team = args?.team ? `&team=${encodeURIComponent(args.team)}` : "";
        return await api(`/leaderboard?period=${period}${team}`);
      }
      case "token_horizon_share": {
        const period = args?.period || "today";
        const format = args?.format || "text";
        const copy = args?.copy ? "&copy=1" : "";
        const res = await fetch(`${BASE}/leaderboard/share?period=${period}&format=${format}${copy}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const card = await res.text();
        return { period, format, card };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (err) {
    if (name === "token_horizon_workflows" || name === "token_horizon_nodes") {
      throw new Error(`Token Horizon Engine daemon not reachable at ${ENGINE_BASE} (${err.message}). Ensure the engine is running ('npm start' in engine/).`);
    }
    const known = TOOLS.some((t) => t.name === name);
    if (!known) throw new Error(`unknown tool ${name}`);
    if (name === "token_horizon_limits") {
      throw new Error(`limits need the Token Horizon app running at ${BASE} (${err.message})`);
    }
    if (name === "token_horizon_system") throw new Error("system stats require the Token Horizon app running (http://127.0.0.1:8765)");
    if (name === "token_horizon_history") throw new Error("history requires the Token Horizon app running (http://127.0.0.1:8765)");
    if (!existsSync(DB)) throw new Error(`${name} needs the Token Horizon app running at ${BASE} (${err.message})`);
    if (name === "token_horizon_usage") return usageFallback();
    if (name === "token_horizon_sessions") return sessionsFallback(Math.min(args?.limit ?? 10, 25));
    if (name === "token_horizon_processes") {
      const sort = ["cpu", "mem", "disk", "net"].includes(args?.sort) ? args.sort : "cpu";
      const limit = Math.min(Math.max(args?.limit ?? 8, 1), 20);
      const filter = (args?.filter || "").toLowerCase();
      const out = await sh("ps", ["-Ao", "%cpu=,rss=,comm=", "-r"]);
      let rows = out.split("\n").filter(Boolean).map((line) => {
        const m = line.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/);
        if (!m) return null;
        return { name: m[3].split("/").pop(), cpu: parseFloat(m[1]), memMB: parseInt(m[2], 10) / 1024, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0 };
      }).filter(Boolean);
      if (filter) rows = rows.filter((r) => r.name.toLowerCase().includes(filter));
      const sorted = sort === "mem" ? rows.sort((a, b) => b.memMB - a.memMB) : sort === "disk" || sort === "net" ? rows : rows.sort((a, b) => b.cpu - a.cpu);
      return sorted.slice(0, limit);
    }
    throw new Error(`${name} failed: ${err.message}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize")
    return send({ id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "token-horizon", version: "0.3.5" } } });
  if (method === "tools/list")
    return send({ id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const out = await callTool(params.name, params.arguments);
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
    } catch (e) {
      send({ id, result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (method?.startsWith("notifications/")) return;
  if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
