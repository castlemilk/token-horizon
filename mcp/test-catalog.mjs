/**
 * Hermetic tests for the MCP catalog helpers (no network, fixture catalog).
 * Run: node test-catalog.mjs
 */
import assert from "node:assert/strict";
import { unifiedModels, searchCatalog, planList, resetCatalogCache } from "./catalog.mjs";

const CATALOG = {
  schemaVersion: 1,
  plansUpdatedAt: "2026-09-15",
  plans: [
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      providers: ["github-copilot"],
      docUrl: "https://example.com/copilot",
      summary: "Monthly AI credits per tier.",
      billing: "monthly",
      modelCount: 1,
      tiers: [
        { name: "Free", priceMonthly: 0, usage: "allowance" },
        { name: "Pro", priceMonthly: 10, usage: "1,500 credits/month" },
      ],
    },
  ],
  models: [
    // duplicate listings of the same model name; benchmarked+priced wins
    { id: "openai/gpt-test", name: "GPT Test", provider: "openai", providerName: "OpenAI", inputPerM: 5, outputPerM: 25, blendedNetCost: 7.3, priceKnown: true, contextK: 1000, perfScore: 80, benchmarks: { swe: 82, lcb: 79 }, capabilities: { reasoning: true }, plans: ["github-copilot"], hostCount: 3 },
    { id: "nano-gpt/gpt-test", name: "GPT Test", provider: "nano-gpt", providerName: "nano-gpt", inputPerM: 0, outputPerM: 0, priceKnown: false, contextK: 1000, hostCount: 1 },
    { id: "kimi/k3", name: "K3", provider: "kimi", providerName: "Moonshot Kimi", inputPerM: 0, outputPerM: 0, priceKnown: false, contextK: 1048, plans: ["kimi-for-coding"], hostCount: 2 },
    { id: "kimi/kimi-k3", name: "Kimi K3", provider: "kimi", providerName: "Moonshot Kimi", inputPerM: 2.65, outputPerM: 13.28, blendedNetCost: 3.9, priceKnown: true, contextK: 1048, perfScore: 77, benchmarks: { swe: 78, lcb: 74 }, hostCount: 72 },
    { id: "opencode/big-pickle", name: "Big Pickle", provider: "opencode", providerName: "OpenCode", inputPerM: 0, outputPerM: 0, priceKnown: true, isFree: true, contextK: 256, hostCount: 1 },
    { id: "ollama/llama-test", name: "Llama Test", provider: "ollama", providerName: "Ollama (Local)", inputPerM: 0, outputPerM: 0, priceKnown: true, isLocal: true, isFree: true, contextK: 128, hostCount: 1 },
    { id: "unlisted/veo", name: "Veo Test", provider: "google", providerName: "Google", inputPerM: 0, outputPerM: 0, priceKnown: false, contextK: 0, hostCount: 1 },
  ],
};

// --- unified listing dedupe
const unified = unifiedModels(CATALOG.models);
assert.equal(unified.length, CATALOG.models.length - 1, "duplicate name collapses to one listing");
assert.equal(unified.find((m) => m.name === "GPT Test").id, "openai/gpt-test", "benchmarked+priced listing wins");

// --- search + filters
const free = searchCatalog(CATALOG, { scope: "free" });
assert.ok(free.models.every((m) => m.is_free), "free scope only explicit free/local models");
assert.equal(free.total, 2, "Big Pickle + local llama");

const plan = searchCatalog(CATALOG, { scope: "plan" });
assert.deepEqual(plan.models.map((m) => m.id).sort(), ["kimi/k3", "openai/gpt-test"].sort());
assert.equal(plan.models.find((m) => m.id === "kimi/k3").pricing_note.includes("included in plan"), true);

const byPlan = searchCatalog(CATALOG, { plan: "github-copilot" });
assert.equal(byPlan.total, 1);
assert.equal(byPlan.models[0].id, "openai/gpt-test");

const unknown = searchCatalog(CATALOG, { scope: "unknown_price" });
assert.ok(unknown.models.length > 0 && unknown.models.every((m) => m.price_known === false));

// pricing evidence: plan-covered K3 has null prices, not zero
const k3 = searchCatalog(CATALOG, { query: "K3" }).models.find((m) => m.id === "kimi/k3");
assert.equal(k3.price_known, false);
assert.equal(k3.input_per_m, null);
assert.equal(k3.blended_net_cost, null);

// sort: unknown prices last in both directions
const asc = searchCatalog(CATALOG, { sort: "input", limit: 100 }).models;
const firstUnknown = asc.findIndex((m) => m.price_known === false);
assert.ok(firstUnknown === -1 || asc.slice(firstUnknown).every((m) => m.price_known === false), "unknown prices sort last");

const value = searchCatalog(CATALOG, { sort: "value", limit: 100 }).models;
assert.ok(value.length > 0);

// query AND semantics (both K3 rows match "kimi k3")
const kimiQuery = searchCatalog(CATALOG, { query: "kimi k3", limit: 100 });
assert.equal(kimiQuery.total, 2);
assert.deepEqual(kimiQuery.models.map((m) => m.id).sort(), ["kimi/k3", "kimi/kimi-k3"]);
assert.equal(searchCatalog(CATALOG, { query: "does-not-exist" }).total, 0);

// provider filter
assert.equal(searchCatalog(CATALOG, { provider: "openai" }).total, 1);

// --- plans
const plans = planList(CATALOG, {});
assert.equal(plans.count, 1);
assert.equal(plans.plans[0].tiers.length, 2);
assert.equal(plans.plans[0].tiers[1].priceMonthly, 10);
assert.equal(plans.plans[0].model_count, 1);

const withModels = planList(CATALOG, { include_models: true });
assert.equal(withModels.plans[0].models.length, 1);
assert.equal(withModels.plans[0].models[0].id, "openai/gpt-test");

resetCatalogCache();
console.log("✅ MCP catalog helper tests passed");
