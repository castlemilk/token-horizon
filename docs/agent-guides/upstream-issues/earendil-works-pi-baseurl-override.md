# Upstream issue draft — `models.json` provider `baseUrl` silently ignored

Repo: https://github.com/earendil-works/pi
Status: DRAFT — paste into a new issue when ready.

---

**Title:** Provider `baseUrl` in `models.json` is silently overridden by the remote catalog merge

**Environment:**
- pi: `@earendil-works/pi-coding-agent` 0.85.1 (global npm install, node 24)
- OS: Linux x86_64
- Provider: `kimi-coding` (also affects any catalog-listed provider)

**Summary:**
A user-configured provider endpoint in `~/.pi/agent/models.json` has no
effect when the provider's models are also present in
`~/.pi/agent/models-store.json`. At startup the remote catalog refresh merges
over local config and the request is sent to the upstream URL from the store,
bypassing the configured endpoint with no warning. This breaks legitimate
setups that route traffic through a local endpoint: usage meters, corporate
TLS-inspecting proxies, and OpenAI-compatible gateways.

**Reproduction:**
1. In `~/.pi/agent/models.json`, set a provider endpoint override:
   ```json
   { "providers": { "kimi-coding": { "baseUrl": "http://127.0.0.1:9246/coding" } } }
   ```
2. Run any prompt with that provider, e.g. `pi -p "say ok"`.
3. Observe (packet capture / receiving-end logs) that the request goes to
   `https://api.kimi.com/coding` — the loopback endpoint is never contacted.

**Expected:**
An explicit user `baseUrl` in `models.json` takes precedence. The catalog
merge should backfill missing models and metadata, but must never overwrite
user-set connection config.

**Actual:**
The store's per-model `baseUrl` wins and the `models.json` value is dead
config. There is no log line indicating which endpoint was selected, so the
misrouting is silent.

**Root cause (from the 0.85.1 bundle):**
- Provider models resolve as
  `mergeModels(provider.getModels(), dynamicModels)`, where a dynamic
  (remote/store) entry *replaces* the local entry wholesale on id match —
  including its `baseUrl`.
- `withRemoteCatalog` refreshes `models-store.json` from
  `/api/models/providers/<id>` at startup (unless `PI_OFFLINE`), so the
  direct upstream URL is re-seeded into the store and from then on shadows
  `models.json` on every launch.

**Suggested fix:**
Treat endpoint fields (`baseUrl`, and by extension auth selection) as
user-owned: during the merge, preserve a locally configured `baseUrl` when
one exists, and/or emit astartup log line stating the effective endpoint per
provider so misrouting is at least visible. A `--print-endpoint` / config
`--dry-run` affordance would also help operators verify routing.

**Workaround (verified):**
Patch `baseUrl` directly in `~/.pi/agent/models-store.json`. Note
`pi update --models` currently preserves the patched value (0.85.1), but any
catalog-side URL change would revert it, so this remains fragile until the
precedence is fixed.
