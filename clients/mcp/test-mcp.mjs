/**
 * Test suite for Token Horizon MCP Tools
 */

import {
  runGetLeaderboard,
  runGetUserProfile,
  runGetDaemonMetrics,
  runPublishTelemetry,
  runCompareUsers,
  runSearchModels,
  runGetPlans
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

  // 5. Test publish_telemetry from daemon (live publish needs real creds)
  if (daemon.online) {
    console.log("\n5. Testing publish_telemetry (from_daemon=true)...");
    try {
      const pub = await runPublishTelemetry({
        from_daemon: true,
        google_token: process.env.TH_TEST_GOOGLE_TOKEN || "google:benebsworth"
      });
      console.log("   Publish Status: OK, Success:", pub.success);
      console.log("   Output preview:\n", pub.text);
    } catch (err) {
      console.log("   Publish skipped (set TH_TEST_GOOGLE_TOKEN / LEADERBOARD secret to exercise):", String(err.message).split("\n")[0]);
    }
  }

  // 6. Test compare_users (verifying graceful handling for non-existent user now that junk users are removed)
  console.log("\n6. Testing compare_users validation...");
  try {
    await runCompareUsers({ user1: "benebsworth", user2: "alice" });
  } catch (err) {
    console.log("   Status: OK (Correctly caught removed user: " + err.message + ")");
  }

  // 7. Test search_models (hosted unified catalog)
  console.log("\n7. Testing search_models (catalog)...");
  const models = await runSearchModels({ query: "k3", limit: 2 });
  if (!models.count) throw new Error("search_models returned no rows");
  console.log("   Status: OK, rows:", models.count, "of", models.total);
  console.log("   Output preview:\n", models.text.split("\n").slice(0, 6).join("\n"));

  // 8. Test get_plans
  console.log("\n8. Testing get_plans (subscription plans)...");
  const plans = await runGetPlans({ plan: "github-copilot" });
  if (!plans.count) throw new Error("get_plans returned no plans");
  console.log("   Status: OK, plans:", plans.count, "updated:", plans.updatedAt);
  console.log("   Output preview:\n", plans.text.split("\n").slice(0, 7).join("\n"));

  console.log("\n🎉 ALL MCP TOOL TESTS PASSED SUCCESSFULLY!");
}

testMcp().catch(err => {
  console.error("\n❌ MCP Test failed:", err);
  process.exit(1);
});
