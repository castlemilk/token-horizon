#!/usr/bin/env node
/**
 * token-horizon-mcp — MCP server for Token Horizon
 * Exposes live leaderboard inspection, daemon telemetry, user analytics, and publishing.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  runGetLeaderboard,
  runGetUserProfile,
  runGetDaemonMetrics,
  runPublishTelemetry,
  runClaimProfile,
  runCompareUsers,
  runSearchModels,
  runGetPlans,
  DEFAULT_API_BASE,
  DEFAULT_DAEMON_BASE
} from "./tools.js";

const server = new Server(
  {
    name: "token-horizon-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOL_DEFINITIONS = [
  {
    name: "get_leaderboard",
    description: "Fetch ranked LLM token participants, spend metrics, streaks, and platform KPIs from the Token Horizon leaderboard.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week", "all", "streak"],
          description: "Ranking period: 'today' (default), 'week' (7 days), 'all' (all-time), or 'streak'."
        },
        team: {
          type: "string",
          description: "Optional team filter."
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default 20, max 100)."
        }
      }
    }
  },
  {
    name: "get_user_profile",
    description: "Retrieve comprehensive telemetry breakdown for a specific participant: ranks across periods, 7-day activity history, model allocation shares, tool usage, and verification status.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Participant handle (e.g. 'benebsworth')."
        }
      },
      required: ["handle"]
    }
  },
  {
    name: "get_daemon_metrics",
    description: "Fetch live LLM metrics directly from the local macOS Token Horizon daemon (127.0.0.1:8765): current session tokens, costs, model catalog, and hardware telemetry.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "publish_telemetry",
    description: "Sync and publish telemetry metrics to the public/team leaderboard. Can publish directly from the running local daemon or via custom payload. Protected by claim token or Google auth.",
    inputSchema: {
      type: "object",
      properties: {
        from_daemon: {
          type: "boolean",
          description: "If true (default), pulls live telemetry from the local daemon at 127.0.0.1:8765."
        },
        entry: {
          type: "object",
          description: "Optional custom entry payload when from_daemon is false."
        },
        claim_token: {
          type: "string",
          description: "Optional claim token secret if updating an existing anonymous handle."
        },
        google_token: {
          type: "string",
          description: "Optional Google ID token / JWT for verified publishing."
        }
      }
    }
  },
  {
    name: "claim_profile",
    description: "Claim an unclaimed leaderboard profile using a Google authentication token to lock the handle and earn a verified badge.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Handle to claim (e.g. 'benebsworth')."
        },
        google_token: {
          type: "string",
          description: "Google ID token (JWT) verifying account ownership."
        },
        claim_token: {
          type: "string",
          description: "Optional claim token if previously registered as anonymous."
        }
      },
      required: ["handle", "google_token"]
    }
  },
  {
    name: "compare_users",
    description: "Side-by-side performance comparison between two participants on the leaderboard (volume, effective $/M tokens, models, streaks).",
    inputSchema: {
      type: "object",
      properties: {
        user1: {
          type: "string",
          description: "First user handle."
        },
        user2: {
          type: "string",
          description: "Second user handle."
        }
      },
      required: ["user1", "user2"]
    }
  },
  {
    name: "search_models",
    description: "Search the unified Token Horizon model catalog (token-horizon.dev/models): deduped listings with pricing evidence (price_known separates real free tiers from plan-covered/unpriced models), SWE-bench/LiveCodeBench scores, context windows, capabilities, and subscription-plan linkage.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms; all tokens must match name/id/provider/description." },
        provider: { type: "string", description: "Provider filter (e.g. 'anthropic', 'kimi', 'github-copilot')." },
        plan: { type: "string", description: "Only models covered by this subscription plan id (see get_plans)." },
        scope: { type: "string", enum: ["all", "cloud", "local", "free", "benchmarked", "plan", "unknown_price"], description: "Catalog scope filter." },
        sort: { type: "string", enum: ["featured", "value", "swe", "lcb", "context", "input", "output", "blended", "name"], description: "Sort order (unknown prices always last)." },
        limit: { type: "number", description: "Max rows (default 20, max 100)." },
        unified: { type: "boolean", description: "Collapse duplicate listings into one row per model (default true)." }
      }
    }
  },
  {
    name: "get_plans",
    description: "Subscription plans in the Token Horizon catalog (GitHub Copilot, Kimi Code, MiniMax Token Plan, GLM Coding Plan, OpenCode Zen, ...): verified usage tiers with prices and quota windows, included models, provider docs, and per-plan catalog model counts.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Specific plan id (e.g. 'github-copilot', 'kimi-for-coding')." },
        provider: { type: "string", description: "Filter plans by provider id substring." },
        include_models: { type: "boolean", description: "Include the covered catalog models per plan." },
        limit: { type: "number", description: "Max covered models per plan (default 50)." }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOL_DEFINITIONS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "get_leaderboard": {
        const result = await runGetLeaderboard(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "get_user_profile": {
        const result = await runGetUserProfile(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "get_daemon_metrics": {
        const result = await runGetDaemonMetrics();
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "publish_telemetry": {
        const result = await runPublishTelemetry(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "claim_profile": {
        const result = await runClaimProfile(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "compare_users": {
        const result = await runCompareUsers(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "search_models": {
        const result = await runSearchModels(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      case "get_plans": {
        const result = await runGetPlans(args);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${error.message}`,
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Token Horizon MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal MCP error:", error);
  process.exit(1);
});
