#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import readline from "node:readline";

const BASE = process.env.NOTCHMON_URL || "http://127.0.0.1:8765";
const DB = `${homedir()}/.local/share/opencode/opencode.db`;

const TOOLS = [
  {
    name: "token_horizon_usage",
    description:
      "AI token usage, cost, cache rates, and model/tool breakdown tracked by Token Horizon across local AI coding tools (opencode, claude-code, codex, agy). Pass period=today or period=all.",
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
      "Safe startup protocol and configuration examples for routing Ollama and local LLM traffic through Token Horizon's telemetry proxy for ground-truth tok/s measurement, prompt eval rates, and streaming metrics. Use client=startup for the server/proxy startup sequence.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          enum: ["all", "startup", "environment", "opencode", "continue", "python", "curl"],
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

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  const midnightMs =
    new Date(new Date().setHours(0, 0, 0, 0)).getTime();
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
        };
      }
      case "token_horizon_proxy_guide": {
        let health = null;
        try {
          health = await api("/health");
        } catch {
          health = { ok: false, ollama_proxy_port: 11435 };
        }
        const configuredUpstream = process.env.TOKEN_HORIZON_OLLAMA_UPSTREAM || "127.0.0.1:11434";
        const port = health.ollama_proxy_port || Number(process.env.TOKEN_HORIZON_OLLAMA_PROXY_PORT || 11435);
        const proxyURL = process.env.OLLAMA_PROXY_URL || `http://127.0.0.1:${port}`;
        const tokenHorizonReachable = health.name === "token-horizon" && health.ok === true;
        let proxyReachable = false;
        let proxyError = null;
        try {
          const proxyResponse = await fetch(`${proxyURL}/api/tags`, { signal: AbortSignal.timeout(2000) });
          proxyReachable = proxyResponse.ok;
          if (!proxyResponse.ok) proxyError = `HTTP ${proxyResponse.status}`;
        } catch (error) {
          proxyError = error instanceof Error ? error.message : String(error);
        }
        const target = (args?.client || "all").toLowerCase();

        const guide = {
          proxy_status: {
            active_port: port,
            proxy_url: proxyURL,
            upstream_default: `http://${configuredUpstream}`,
            token_horizon_reachable: tokenHorizonReachable,
            ollama_reachable_through_proxy: proxyReachable,
            proxy_error: proxyError,
          },
          summary:
            "Token Horizon bundles a loopback proxy that transparently relays Ollama requests/responses and parses exact completion metadata (eval_count, eval_duration) to track ground-truth generation tok/s without estimating from hardware usage.",
          configurations: {},
        };

        const appPath = process.env.TOKEN_HORIZON_APP || "/Users/benebsworth/projects/token-horizon/TokenHorizon.app";
        guide.startup = {
          purpose: "Run Ollama upstream, run Token Horizon beside it, and point the Ollama client at the proxy.",
          order: [
            "Keep the Ollama daemon on the upstream address; ollama serve is not itself routed through the proxy.",
            "Start Token Horizon; its in-process relay listens on the reported loopback proxy port.",
            "Set the client OLLAMA_HOST to the proxy URL before running an inference request.",
          ],
          ollama_server: {
            upstream: `http://${configuredUpstream}`,
            command: `OLLAMA_HOST="${configuredUpstream}" ollama serve`,
            note: "Run this only when an Ollama daemon is not already managed by the Ollama app.",
          },
          token_horizon: {
            app: appPath,
            command: `open "${appPath}"`,
            note: "Token Horizon starts the proxy automatically; it may select the next loopback port if the requested port is occupied.",
          },
          client: {
            proxy_url: proxyURL,
            environment: `export OLLAMA_HOST="${proxyURL}"`,
            command: `OLLAMA_HOST="${proxyURL}" ollama run <model>`,
          },
          localllm: {
            check: "task proxy:check",
            smoke: "task smoke",
            observed_profile: "task profile:run:observed MODEL=<model> CONTEXT=<tokens>",
            long_context_preflight: "task context:preflight:observed",
          },
          verify: [
            `curl --fail ${proxyURL}/api/tags`,
            `${BASE}/health`,
            `${BASE}/metrics`,
          ],
          do_not: [
            `Do not run OLLAMA_HOST="${proxyURL}" ollama serve; that would try to bind the proxy port instead of starting the upstream daemon.`,
            "Do not send benchmark clients directly to the upstream address if telemetry is required.",
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
            description: "Configure OpenCode to route local models through the telemetry proxy in ~/.config/opencode/opencode.json",
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
                  title: "Ollama (via Token Horizon Proxy)",
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

        guide.observability = {
          ui_tracking: "Tracked tokens/second appear live in Token Horizon's MODELS and MLX/Ollama tabs.",
          prometheus_exporter: "http://127.0.0.1:8765/metrics",
          stats_api: "http://127.0.0.1:8765/stats",
        };

        return guide;
      }
      case "token_horizon_system": {
        const d = await api("/stats");
        return d.system;
      }
      case "token_horizon_limits": {
        const d = await api("/limits");
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
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch {
    if (!existsSync(DB)) throw new Error("Token Horizon app not reachable and no local data found");
    if (name === "token_horizon_usage") return usageFallback();
    if (name === "token_horizon_system") throw new Error("system stats require the Token Horizon app running (http://127.0.0.1:8765)");
    if (name === "token_horizon_sessions") return sessionsFallback(Math.min(args?.limit ?? 10, 25));
    if (name === "token_horizon_history") throw new Error("history requires the Token Horizon app running (http://127.0.0.1:8765)");
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
    throw new Error(`unknown tool ${name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize")
    return send({ id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "token-horizon", version: "0.2.0" } } });
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
