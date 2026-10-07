import { overviewHTML } from './ui/overview.generated.mjs';

export const APP_URI = 'ui://token-horizon/usage-v1.html';
const icon = { src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="12" cy="12" rx="11" ry="4" fill="none" stroke="currentColor" stroke-width="1.5" transform="rotate(-30 12 12)"/></svg>'), mimeType: 'image/svg+xml' };
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const schema = properties => ({ type: 'object', properties, required: [], additionalProperties: false });
export const extensionTools = [
  { name: 'token_horizon_app', title: 'Usage observatory', description: 'Open the Token Horizon usage and model observatory. Reads metadata only; never changes routing or accounts.', inputSchema: schema({}), annotations: readonly, icons: [icon], _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } },
  { name: 'token_horizon_overview', title: 'Usage and model overview', description: 'Read usage, catalog and trace metadata in the connected data scope. Local traces remain local; hosted connections expose published community data only.', inputSchema: schema({}), annotations: readonly, _meta: { ui: { resourceUri: APP_URI } } },
  { name: 'token_horizon_search_mentions', title: 'Find a model or usage reference', description: 'Search model references for composer mentions. Empty query lists models; at most 20 references. Returned resources contain metadata, never prompts or credentials.', inputSchema: { ...schema({ query: { type: 'string', maxLength: 200 } }), required: ['query'] }, annotations: readonly, _meta: { ui: { visibility: ['app'] }, 'openai/extensions': { 'mentions/search': {} } } }
];
const resourceMeta = { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } }, 'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } };
export const extensionResources = [{ uri: APP_URI, name: 'Usage observatory', mimeType: 'text/html;profile=mcp-app', _meta: resourceMeta }];
export const extensionTemplates = [{ uriTemplate: 'tokenhorizon://models/{id}', name: 'Model reference', description: 'Exact model metadata and price provenance from the connected catalog.', mimeType: 'application/json' }];
export function validateExtensionArgs(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  const definition = extensionTools.find(t => t.name === name);
  if (!definition) throw new Error('Unknown extension tool.');
  for (const key of Object.keys(args)) if (!(key in definition.inputSchema.properties)) throw new Error('Unknown argument.');
  if (name === 'token_horizon_search_mentions' && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('query must be a string of at most 200 characters.');
}
export function modelMetadata(m) {
  // An allowlist avoids turning catalog descriptions, prompts or future API
  // identity fields into implicit model context.
  return Object.fromEntries(['id', 'name', 'provider', 'context', 'contextWindow', 'inputPerM', 'outputPerM', 'priceKnown', 'isLocal', 'generatedAt'].filter(k => m[k] !== undefined).map(k => [k, m[k]]));
}
export function traceMetadata(t) {
  const result = Object.fromEntries(['id', 'provider', 'endpoint', 'model', 'requestedModel', 'startedAt', 'ttftMs', 'durationMs', 'stream', 'statusCode', 'usage', 'errorClass', 'retrySuspect', 'source', 'client', 'providerRequestId', 'providerResponseId', 'estCostUSD', 'completionState', 'usageCoverage', 'captureMode'].filter(k => t[k] !== undefined && k !== 'usage').map(k => [k, t[k]]));
  if (t.usage) result.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'source'].filter(k => typeof t.usage[k] === 'number' || (k === 'source' && typeof t.usage[k] === 'string')).map(k => [k, t.usage[k]]));
  return result;
}
export async function callExtension(name, args, { mode, read }) {
  validateExtensionArgs(name, args);
  const base = { mode, source: mode === 'local' ? 'Local daemon metadata; not published' : 'Published community data; no device traces', privacy: 'Prompts, responses, credentials and session titles are excluded.' };
  if (name === 'token_horizon_app') return { ...base, pending: true };
  if (name === 'token_horizon_search_mentions') {
    const catalog = await read('catalog');
    const query = args.query.toLowerCase();
    return { items: (catalog.models || []).filter(m => `${m.id} ${m.name || ''} ${m.provider || ''}`.toLowerCase().includes(query)).slice(0, 20).map(m => ({ type: 'resource_link', uri: 'tokenhorizon://models/' + encodeURIComponent(m.id), name: String(m.name || m.id), description: String(m.provider || 'Unknown provider'), mimeType: 'application/json' })) };
  }
  const keys = mode === 'local' ? ['usage', 'catalog', 'traces'] : ['community', 'catalog'];
  const results = await Promise.allSettled(keys.map(key => read(key)));
  const data = { ...base, pending: false, models: [], traces: [], warnings: [] };
  results.forEach((r, i) => {
    const key = keys[i];
    if (r.status !== 'fulfilled') { data.warnings.push(`${key} is unavailable. Retry when the connected service is ready.`); return; }
    if (key === 'catalog') data.models = (r.value.models || []).slice(0, 100).map(modelMetadata);
    else if (key === 'traces') data.traces = (Array.isArray(r.value) ? r.value : r.value.traces || r.value.items || []).slice(0, 20).map(traceMetadata);
    else if (key === 'usage') {
      const v = r.value;
      data.usage = Object.fromEntries(['todayTokens', 'allTokens', 'todayCost', 'allCost', 'tokensToday', 'tokensAll', 'costToday', 'costAll', 'updatedAt'].filter(k => v[k] !== undefined).map(k => [k, v[k]]));
    } else data.community = { total: typeof r.value.total === 'number' ? r.value.total : null, kpis: Object.fromEntries(['totalTokens', 'totalCost', 'activeDevs', 'maxStreakDays', 'totalRequests', 'avgTokensPerRequest', 'totalTokensDelta', 'totalCostDelta', 'activeDevsDelta'].filter(k => typeof r.value.kpis?.[k] === 'number').map(k => [k, r.value.kpis[k]])) };
  });
  return data;
}
export async function readExtensionResource(uri, context) {
  if (uri === APP_URI) return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: overviewHTML, _meta: resourceMeta }] };
  const match = /^tokenhorizon:\/\/models\/([^/?#]+)$/.exec(uri);
  if (!match) throw new Error('Unknown resource URI.');
  let id;
  try { id = decodeURIComponent(match[1]); } catch { throw new Error('Invalid model reference.'); }
  if (!id || id.length > 200) throw new Error('Invalid model reference.');
  const catalog = await context.read('catalog');
  const model = (catalog.models || []).find(m => m.id === id);
  if (!model) throw new Error('Model not found in the connected catalog.');
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ model: modelMetadata(model), source: 'Catalog metadata; prices are USD per million tokens, not billed spend.' }) }] };
}
