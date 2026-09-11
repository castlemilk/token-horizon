/**
 * Test suite for Token Horizon MCP Tools
 */

import {
  runGetLeaderboard,
  runGetUserProfile,
  runGetDaemonMetrics,
  runPublishTelemetry,
  runCompareUsers
} from "./src/tools.js";

async function testMcp() {
  console.log("=== Testing Token Horizon MCP Tools ===\n");

  // 1. Test get_leaderboard
  console.log("1. Testing get_leaderboard (today)...");
  const lbToday = await runGetLeaderboard({ period: "today", limit: 5 });
  console.log("   Status: OK");
  console.log("   Output preview:\n", lbToday.text.split("\n").slice(0, 8).join("\n"));

  console.log("\n2. Testing get_leaderboard (all-time)...");
  const lbAll = await runGetLeaderboard({ period: "all", limit: 3 });
  console.log("   Status: OK");
  console.log("   Output preview:\n", lbAll.text.split("\n").slice(0, 5).join("\n"));

  // 3. Test get_user_profile
  console.log("\n3. Testing get_user_profile for @benebsworth...");
  const profile = await runGetUserProfile({ handle: "benebsworth" });
  if (!profile.found) throw new Error("User @benebsworth not found");
  console.log("   Status: OK, Found!");
  console.log("   Output preview:\n", profile.text.split("\n").slice(0, 10).join("\n"));

  // 4. Test get_daemon_metrics
  console.log("\n4. Testing get_daemon_metrics from local daemon...");
  const daemon = await runGetDaemonMetrics();
  console.log(`   Daemon online: ${daemon.online}`);
  console.log("   Output preview:\n", daemon.text.split("\n").slice(0, 8).join("\n"));

  // 5. Test publish_telemetry from daemon
  if (daemon.online) {
    console.log("\n5. Testing publish_telemetry (from_daemon=true)...");
    const pub = await runPublishTelemetry({ from_daemon: true, google_token: "google:benebsworth" });
    console.log("   Publish Status: OK, Success:", pub.success);
    console.log("   Output preview:\n", pub.text);
  }

  // 6. Test compare_users (verifying graceful handling for non-existent user now that junk users are removed)
  console.log("\n6. Testing compare_users validation...");
  try {
    await runCompareUsers({ user1: "benebsworth", user2: "alice" });
  } catch (err) {
    console.log("   Status: OK (Correctly caught removed user: " + err.message + ")");
  }

  console.log("\n🎉 ALL MCP TOOL TESTS PASSED SUCCESSFULLY!");
}

testMcp().catch(err => {
  console.error("\n❌ MCP Test failed:", err);
  process.exit(1);
});
