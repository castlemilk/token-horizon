/**
 * Token Horizon MCP Client Session Runner
 * Spawns token-horizon-mcp over stdio, performs MCP handshake,
 * and calls leaderboard tools to access and display live data.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

async function runSession() {
  console.log("=================================================================");
  console.log("🤖 Starting MCP Client & connecting to Token Horizon Server");
  console.log("=================================================================\n");

  const serverPath = path.resolve("src/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      TOKEN_HORIZON_API_BASE: "https://token-horizon.dev",
      TOKEN_HORIZON_DAEMON_BASE: "http://127.0.0.1:8765"
    }
  });

  const client = new Client(
    {
      name: "token-horizon-cli-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log("✅ MCP Handshake Complete! Connected via StdioClientTransport.\n");

  // 1. List Available Tools
  console.log("📋 1. Discovering MCP Tools (tools/list)...");
  const toolsResponse = await client.listTools();
  console.log(`   Found ${toolsResponse.tools.length} available tools:`);
  toolsResponse.tools.forEach(t => {
    console.log(`   - 🛠️  ${t.name.padEnd(20)}: ${t.description.slice(0, 80)}...`);
  });
  console.log("");

  // 2. Query Leaderboard (Today)
  console.log("🏆 2. Invoking tool: get_leaderboard (period='today')...\n");
  const lbToday = await client.callTool({
    name: "get_leaderboard",
    arguments: { period: "today", limit: 10 }
  });
  console.log(lbToday.content[0].text);
  console.log("-----------------------------------------------------------------\n");

  // 3. Query Participant Profile
  console.log("👤 3. Invoking tool: get_user_profile (handle='benebsworth')...\n");
  const userProfile = await client.callTool({
    name: "get_user_profile",
    arguments: { handle: "benebsworth" }
  });
  console.log(userProfile.content[0].text);
  console.log("-----------------------------------------------------------------\n");

  // 4. Query Local Daemon Telemetry
  console.log("⚡ 4. Invoking tool: get_daemon_metrics (local macOS daemon)...\n");
  const daemonMetrics = await client.callTool({
    name: "get_daemon_metrics",
    arguments: {}
  });
  console.log(daemonMetrics.content[0].text);
  console.log("-----------------------------------------------------------------\n");

  // 5. Compare Developers Validation
  console.log("⚔️  5. Invoking tool: compare_users (validating removed junk user 'alice')...\n");
  const comparison = await client.callTool({
    name: "compare_users",
    arguments: { user1: "benebsworth", user2: "alice" }
  });
  console.log("   Result:", comparison.content[0].text);
  console.log("-----------------------------------------------------------------\n");

  console.log("🛑 Closing MCP Session...");
  await client.close();
  console.log("✅ MCP Session gracefully closed.");
}

runSession().catch(err => {
  console.error("❌ MCP Session error:", err);
  process.exit(1);
});
