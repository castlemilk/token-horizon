/**
 * Model-catalog helpers shared by the MCP servers.
 *
 * The catalog is the app-exported artifact served by the local daemon
 * (`GET /models/catalog`) and the hosted edge (`GET /api/models/catalog`).
 * Everything here is pure except `fetchCatalog`, which caches the payload so
 * a session of tool calls only fetches once.
 */

const DEFAULT_URLS = [
  "http://127.0.0.1:8765/models/catalog",
  "https://token-horizon.dev/api/models/catalog",
];

const KNOWN_PROVIDERS = new Set([
  "anthropic", "openai", "google", "deepseek", "kimi", "zhipu", "minimax",
  "alibaba", "meta", "mistral", "xai", "opencode", "upstage", "cohere",
  "amazon", "nvidia", "microsoft", "perplexity", "ollama",
]);

let cache = { at: 0, data: null };

export function resetCatalogCache() {
  cache = { at: 0, data: null };
}

/// Local daemon first (fast, fresh), then the hosted catalog. Set
/// TH_CATALOG_URL to pin a source; TH_CATALOG_TTL_MS tunes the cache.
/// An installed daemon may predate the curated plans payload, so a source
/// without plans keeps looking for one that has them.
export async function fetchCatalog(opts = {}) {
  const ttl = Number(opts.ttlMs ?? process.env.TH_CATALOG_TTL_MS ?? 5 * 60_000);
  if (cache.data && Date.now() - cache.at < ttl) return cache.data;
  const urls = opts.urls ?? (process.env.TH_CATALOG_URL ? [process.env.TH_CATALOG_URL] : DEFAULT_URLS);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let first = null;
  let chosen = null;
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(url.startsWith("http://127.") ? 3000 : 15000) });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status} from ${url}`); continue; }
      const data = await res.json();
      if (!Array.isArray(data?.models) || data.models.length === 0) continue;
      if (!first) first = data;
      if (Array.isArray(data.plans) && data.plans.length) { chosen = data; break; }
    } catch (err) {
      lastError = err;
    }
  }
  chosen = chosen ?? first;
  if (!chosen) {
    throw new Error(`model catalog unavailable (${lastError?.message || "no source"}). Start Token Horizon or check network.`);
  }
  cache = { at: Date.now(), data: chosen };
  return chosen;
}

function normalizedName(model) {
  return String(model.name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasBench(model) {
  return Boolean(model.benchmarks && (model.benchmarks.swe != null || model.benchmarks.lcb != null));
}

function priceKnown(model) {
  return model.priceKnown !== false;
}

function rank(model) {
  return (hasBench(model) ? 8 : 0)
    + (priceKnown(model) && (Number(model.inputPerM) > 0 || Number(model.outputPerM) > 0 || model.isLocal) ? 4 : 0)
    + (KNOWN_PROVIDERS.has(String(model.provider).toLowerCase()) ? 2 : 0)
    + Math.min(1, Number(model.hostCount || 1) / 10);
}

/// One listing per model name (same rule as the web "Unified" view).
export function unifiedModels(models) {
  const best = new Map();
  for (const model of models) {
    const key = normalizedName(model);
    const cur = best.get(key);
    if (!cur || rank(model) > rank(cur) || (rank(model) === rank(cur) && String(model.id).length < String(cur.id).length)) {
      best.set(key, model);
    }
  }
  return [...best.values()];
}

function matchesProvider(model, provider) {
  const want = String(provider || "").toLowerCase();
  if (!want) return true;
  const have = String(model.provider || "").toLowerCase();
  return have === want || have.includes(want) || want.includes(have);
}

function matchesPlan(model, plan) {
  const want = String(plan || "").toLowerCase();
  if (!want) return true;
  const plans = model.plans || (model.plan ? [model.plan] : []);
  return plans.map((p) => String(p).toLowerCase()).includes(want);
}

function matchesScope(model, scope) {
  switch (String(scope || "all").toLowerCase()) {
    case "cloud": return !model.isLocal;
    case "local": return Boolean(model.isLocal);
    case "free": return Boolean(model.isFree || model.isLocal);
    case "benchmarked": return hasBench(model);
    case "plan": return (model.plans || []).length > 0 || Boolean(model.plan);
    case "unknown_price": return !priceKnown(model);
    default: return true;
  }
}

function haystack(model) {
  return [model.name, model.id, model.provider, model.providerName, model.description, model.category]
    .filter(Boolean).join(" ").toLowerCase();
}

/// All query tokens must appear (AND); name matches rank first.
function matchesQuery(model, query) {
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = haystack(model);
  return tokens.every((t) => hay.includes(t));
}

function relevance(model, query) {
  const q = String(query || "").toLowerCase();
  const name = String(model.name || "").toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (String(model.id).toLowerCase().includes(q)) return 3;
  return 4;
}

/// Unknown prices sort last in both directions.
function comparePrice(a, b, key, desc) {
  const ka = priceKnown(a);
  const kb = priceKnown(b);
  if (!ka && !kb) return 0;
  if (!ka) return 1;
  if (!kb) return -1;
  const av = Number(a[key]) || 0;
  const bv = Number(b[key]) || 0;
  return desc ? bv - av : av - bv;
}

function compareModels(a, b, sort, query) {
  const desc = (key) => (Number(b[key]) || -1) - (Number(a[key]) || -1);
  switch (String(sort || "featured").toLowerCase()) {
    case "value": {
      const va = (Number(a.perfScore) || 0) / Math.max(0.02, Number(a.blendedNetCost) || 0.04);
      const vb = (Number(b.perfScore) || 0) / Math.max(0.02, Number(b.blendedNetCost) || 0.04);
      return vb - va;
    }
    case "swe": return (Number(b.benchmarks?.swe ?? -1) - Number(a.benchmarks?.swe ?? -1));
    case "lcb": return (Number(b.benchmarks?.lcb ?? -1) - Number(a.benchmarks?.lcb ?? -1));
    case "context": return (Number(b.contextK) || 0) - (Number(a.contextK) || 0);
    case "input": return comparePrice(a, b, "inputPerM", false);
    case "output": return comparePrice(a, b, "outputPerM", false);
    case "blended": return comparePrice(a, b, "blendedNetCost", false);
    case "name": return String(a.name).localeCompare(String(b.name));
    default: {
      if (query) {
        const r = relevance(a, query) - relevance(b, query);
        if (r !== 0) return r;
      }
      const bench = (hasBench(b) ? 1 : 0) - (hasBench(a) ? 1 : 0);
      if (bench !== 0) return bench;
      const perf = (Number(b.perfScore) || 0) - (Number(a.perfScore) || 0);
      if (perf !== 0) return perf;
      return String(a.name).localeCompare(String(b.name));
    }
  }
}

function compact(model, pricingNote) {
  const known = priceKnown(model);
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    provider_name: model.providerName,
    plan: model.plan || null,
    plans: model.plans || (model.plan ? [model.plan] : []),
    price_known: known,
    is_free: Boolean(model.isFree),
    input_per_m: known ? Number(model.inputPerM) || 0 : null,
    output_per_m: known ? Number(model.outputPerM) || 0 : null,
    cache_read_per_m: known && model.cacheReadPerM != null ? Number(model.cacheReadPerM) : null,
    blended_net_cost: known && model.blendedNetCost != null ? Number(model.blendedNetCost) : null,
    context_k: Number(model.contextK) || 0,
    benchmarks: model.benchmarks || null,
    capabilities: model.capabilities || null,
    category: model.category || null,
    doc_url: model.docUrl || null,
    ...(pricingNote ? { pricing_note: pricingNote } : {}),
  };
}

export function searchCatalog(catalog, args = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const unified = args.unified !== false;
  const base = unified ? unifiedModels(models) : models;
  const total = base.length;
  const query = args.query || args.search || "";
  let list = base.filter((m) =>
    matchesScope(m, args.scope)
    && matchesProvider(m, args.provider)
    && matchesPlan(m, args.plan)
    && matchesQuery(m, query));
  list.sort((a, b) => compareModels(a, b, args.sort, query));
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const rows = list.slice(0, limit).map((m) => compact(m, planNote(m)));
  return {
    count: rows.length,
    total: list.length,
    catalog_total: models.length,
    unified,
    query: query || null,
    filters: { provider: args.provider || null, plan: args.plan || null, scope: args.scope || "all", sort: args.sort || "featured" },
    models: rows,
  };
}

function planNote(model) {
  const plans = model.plans || (model.plan ? [model.plan] : []);
  if (!plans.length) return null;
  if (!priceKnown(model)) return `included in plan(s): ${plans.join(", ")} — no per-token price`;
  return `direct per-token price shown; also included in plan(s): ${plans.join(", ")}`;
}

export function planList(catalog, args = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  let plans = Array.isArray(catalog?.plans) ? catalog.plans : [];
  if (args.plan) {
    const want = String(args.plan).toLowerCase();
    plans = plans.filter((p) => String(p.id).toLowerCase() === want);
  }
  if (args.provider) {
    const want = String(args.provider).toLowerCase();
    plans = plans.filter((p) => (p.providers || []).some((prov) => String(prov).toLowerCase().includes(want))
      || String(p.id).toLowerCase().includes(want));
  }
  const includeModels = args.include_models === true;
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
  const out = plans.map((plan) => {
    const summary = {
      id: plan.id,
      name: plan.name,
      summary: plan.summary,
      billing: plan.billing,
      docs: plan.docUrl,
      providers: plan.providers || [],
      tier_count: (plan.tiers || []).length,
      tiers: plan.tiers || [],
      model_count: Number(plan.modelCount) || 0,
    };
    if (includeModels) {
      summary.models = models
        .filter((m) => matchesPlan(m, plan.id))
        .slice(0, limit)
        .map((m) => ({ id: m.id, name: m.name, provider: m.provider, price_known: priceKnown(m) }));
    }
    return summary;
  });
  return { count: out.length, updated_at: catalog?.plansUpdatedAt || null, plans: out };
}
