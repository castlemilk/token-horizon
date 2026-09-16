/**
 * Hermetic stdio-server checks: tool listing, unknown-tool vs known-tool
 * failure reporting, and catalog failure text. No daemon, no network — the
 * server is pointed at dead endpoints so failures are deterministic.
 *
 * Regression: a slow/failing /limits call used to surface as
 * "unknown tool token_horizon_limits" because the catch-all masked the real
 * error. Known tools must keep their identity in failure messages.
 *
 * Run: node test-server-errors.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "token-horizon-mcp.mjs");

function runSession(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        NOTCHMON_URL: "http://127.0.0.1:9",       // dead: every daemon call fails fast
        TOKEN_HORIZON_ENGINE_URL: "http://127.0.0.1:9",
        TH_CATALOG_URL: "http://127.0.0.1:9/api/models/catalog",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = [];
    let buffer = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("server timeout")); }, 15000);
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
        const ids = new Set(responses.map((r) => r.id));
        if (ids.size === requests.length) {
          clearTimeout(timer);
          proc.kill();
          resolve(new Map(responses.map((r) => [r.id, r])));
        }
      }
    });
    proc.on("error", reject);
    for (const req of requests) proc.stdin.write(JSON.stringify(req) + "\n");
  });
}

const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const responses = await runSession([
  { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  call(2, "token_horizon_limits"),
  call(3, "token_horizon_definitely_not_a_tool"),
  call(4, "token_horizon_catalog", { query: "k3" }),
]);
const list = responses.get(1);
const limits = responses.get(2);
const unknown = responses.get(3);
const catalog = responses.get(4);

const names = list.result.tools.map((t) => t.name);
assert.ok(names.includes("token_horizon_limits"), "limits advertised");
assert.equal(names.length, 18, "tool count");

const limitsText = limits.result.content[0].text;
assert.ok(limitsText.includes("limits need the Token Horizon app"), `limits failure text: ${limitsText}`);
assert.ok(!/unknown tool/.test(limitsText), "known tool must not be reported as unknown");

const unknownText = unknown.result.content[0].text;
assert.ok(unknownText.includes("unknown tool token_horizon_definitely_not_a_tool"), unknownText);
assert.equal(unknown.result.isError, true);

const catalogText = catalog.result.content[0].text;
assert.ok(catalogText.includes("token_horizon_catalog"), `catalog failure text: ${catalogText}`);
assert.ok(!/unknown tool/.test(catalogText), "catalog must not be reported as unknown");

console.log("✅ MCP server error-reporting tests passed");
