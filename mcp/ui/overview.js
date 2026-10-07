import { App } from '../../cloudflare/node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js';
import { OpenAIExtensions } from '../../cloudflare/node_modules/@openai/mcp-extensions/dist/app/index.js';

const app = new App({ name: 'Token Horizon observatory', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const extensions = new OpenAIExtensions(app);
let data, tab = 'models', loading = false, selected;
const el = id => document.getElementById(id);
function hostContext() {
  const context = app.getHostContext();
  document.documentElement.dataset.theme = context?.theme === 'dark' ? 'dark' : 'light';
  const link = extensions.deepLink?.getCurrent();
  if (link?.url) {
    const route = new URL(link.url, 'https://token-horizon.invalid');
    if (['/models', '/usage', '/traces'].includes(route.pathname)) tab = route.pathname.slice(1);
    selected = route.searchParams.get('model') || undefined;
  }
  if (data) render();
}
function table(headers, rows) {
  const table = document.createElement('table'), head = table.createTHead().insertRow();
  headers.forEach(label => { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); });
  const body = table.createTBody();
  rows.forEach(cells => { const row = body.insertRow(); cells.forEach(value => { const cell = row.insertCell(); cell.textContent = value == null ? 'Not reported' : String(value); }); });
  return table;
}
function render() {
  el('source').textContent = data.source;
  el('privacy').textContent = data.privacy;
  el('status').textContent = data.warnings?.join(' ') || 'Metadata ready';
  el('traces-tab').disabled = data.mode !== 'local';
  if (data.mode !== 'local' && tab === 'traces') tab = 'models';
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  const host = el('content'); host.replaceChildren();
  if (tab === 'models') {
    const query = el('search').value.toLowerCase();
    const models = (data.models || []).filter(m => `${m.name || ''} ${m.id} ${m.provider || ''}`.toLowerCase().includes(query));
    const visible = selected ? models.filter(m => m.id === selected) : models;
    host.append(table(['Model', 'Provider', 'Input $/M', 'Output $/M'], visible.map(m => [m.name || m.id, m.provider, m.priceKnown === false ? null : m.inputPerM, m.priceKnown === false ? null : m.outputPerM])));
    const note = document.createElement('p'); note.textContent = 'Catalog prices are estimates, not billed spend. Unknown prices remain unavailable. Showing up to 100 models; use composer mentions to search the catalog.'; host.append(note);
  } else if (tab === 'traces') {
    host.append(table(['Model / provider', 'Tokens in / out', 'Duration ms', 'State / coverage'], (data.traces || []).map(t => [t.model + ' / ' + t.provider, `${t.usage?.inputTokens ?? '?'} / ${t.usage?.outputTokens ?? '?'}`, t.durationMs == null ? null : Math.round(t.durationMs), `${t.completionState || t.errorClass || 'unknown'} / ${t.usageCoverage || t.usage?.source || 'unknown'}`])));
    if (!data.traces?.length) { const p = document.createElement('p'); p.textContent = 'No captured request metadata. Only traffic explicitly routed through the local gateway can appear here.'; host.append(p); }
  } else {
    const usage = data.mode === 'local' ? data.usage : data.community?.kpis;
    host.append(table(['Measured field', 'Value'], Object.entries(usage || {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string')));
    if (!usage || !Object.keys(usage).length) { const p = document.createElement('p'); p.textContent = 'Usage totals are unavailable in this connection. Local and published community data have separate scopes.'; host.append(p); }
  }
  el('context').disabled = false; el('ask').disabled = false;
}
async function refresh() {
  if (loading) return;
  loading = true; el('status').textContent = 'Reading connected metadata…';
  try {
    const result = await app.callServerTool({ name: 'token_horizon_overview', arguments: {} });
    if (result.isError || !result.structuredContent) throw new Error('Metadata unavailable.');
    data = result.structuredContent; render();
  } catch { el('status').textContent = 'Could not read metadata. Retry when the service is ready.'; }
  finally { loading = false; }
}
app.ontoolresult = result => {
  if (!result.structuredContent) return;
  data = result.structuredContent;
  if (data.pending) { el('source').textContent = data.source; void refresh(); }
  else render();
};
app.addEventListener('hostcontextchanged', hostContext);
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => { tab = button.dataset.tab; selected = undefined; if (data && !data.pending) render(); };
el('search').oninput = () => { selected = undefined; if (data && !data.pending) render(); };
el('refresh').onclick = refresh;
el('context').onclick = async () => {
  if (!data || data.pending) return;
  // Context changes require a deliberate user action. No prompt/body fields
  // are present in this result, and scope is included in every attachment.
  try { await app.updateModelContext({ content: [{ type: 'text', text: JSON.stringify({ source: data.source, view: tab, metadata: tab === 'traces' ? data.traces : tab === 'models' ? data.models : data.usage || data.community }) }] }); el('status').textContent = 'Selected metadata added to conversation context.'; }
  catch { el('status').textContent = 'This host does not support context attachments.'; }
};
el('ask').onclick = async () => {
  try { await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `Explain the ${tab} metadata in Token Horizon (${data?.source || 'connected scope'}). Distinguish measured usage, unknown values and estimated costs.` }] }); }
  catch { el('status').textContent = 'This host does not support sending a conversation message.'; }
};
try { await app.connect(); hostContext(); }
catch { el('status').textContent = 'Open this view through a compatible MCP host. Text tools remain available.'; }
