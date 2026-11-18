// Code-only source excerpts; no profile records or private values.
// commit: b468206e9378c8d7a6788b67072494982e7de17d

// Exact excerpt: cloudflare/src/index.js:158-179
function normalizeProvider(p) {
  const v = String(p || "").toLowerCase();
  if (v.includes("anthropic")) return "anthropic";
  if (v.includes("claude")) return "anthropic";
  if (v.includes("openai") || v.includes("gpt") || v.includes("codex")) return "openai";
  if (v.includes("google") || v.includes("gemini")) return "google";
  if (v.includes("minimax")) return "minimax";
  if (v.includes("kimi") || v.includes("moonshot")) return "kimi";
  if (v.includes("zhipu") || v.includes("glm") || v.includes("zai")) return "zhipu";
  if (v.includes("opencode")) return "opencode";
  if (v.includes("openrouter")) return "openrouter";
  if (v.includes("ollama") || v.includes("mlx")) return "local";
  if (v.includes("meta") || v.includes("llama")) return "meta";
  if (v.includes("alibaba") || v.includes("qwen")) return "alibaba";
  if (v.includes("mistral")) return "mistral";
  if (v.includes("xai") || v.includes("grok")) return "xai";
  if (v.includes("deepseek")) return "deepseek";
  if (v.includes("agy") || v.includes("antigravity")) return "agy";
  if (v.includes("upstage") || v.includes("solar")) return "upstage";
  if (!v || v === "?") return "other";
  return v;
}

// Exact excerpt: cloudflare/src/index.js:181-183
function dayNumber(date = new Date()) {
  return Math.floor(date.getTime() / 1000 / 86400);
}

// Exact excerpt: cloudflare/src/index.js:228-245
function sanitizeEntry(entry, full = false) {
  const copy = JSON.parse(JSON.stringify(entry));
  if (copy.breakdown) {
    if (!full) {
      delete copy.breakdown.hourly;
      delete copy.breakdown.hourlyHistory;
      delete copy.breakdown.sessions;
      delete copy.breakdown.modelHistory;
      delete copy.breakdown.daily;
    }
  }
  if (!full) delete copy.snapshots;
  delete copy.claimTokenHash;
  delete copy.ownerId;
  delete copy.identityId;
  delete copy.accountEmail;
  return copy;
}

// Exact excerpt: cloudflare/src/index.js:303-303
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Exact excerpt: cloudflare/src/index.js:307-345
function aggregateUsageHistory(entries, days = 30) {
  const byModel = new Map();
  const allDays = new Set();
  for (const e of entries) {
    for (const mh of (e.breakdown && e.breakdown.modelHistory) || []) {
      const model = mh.model || "unknown", provider = normalizeProvider(mh.provider);
      const key = JSON.stringify([provider, model]);
      if (!byModel.has(key)) byModel.set(key, { model, provider, days: new Map() });
      const row = byModel.get(key);
      for (const p of mh.points || []) {
        const day = Number(p.day) || 0;
        row.days.set(day, (row.days.get(day) || 0) + (Number(p.tokens) || 0));
        allDays.add(day);
      }
    }
  }
  const dayKeys = [...allDays].sort((a, b) => a - b).slice(-days);
  const models = [...byModel.values()].map(m => ({
    model: m.model,
    provider: m.provider,
    total: dayKeys.reduce((s, d) => s + (m.days.get(d) || 0), 0),
    values: dayKeys.map(d => m.days.get(d) || 0)
  })).filter(m => m.total > 0).sort((a, b) => b.total - a.total);
  const series = models.slice(0, 8);
  const rest = models.slice(8);
  if (rest.length) {
    series.push({
      model: "Other",
      provider: "other",
      total: rest.reduce((s, m) => s + m.total, 0),
      values: dayKeys.map((_, i) => rest.reduce((s, m) => s + m.values[i], 0))
    });
  }
  const labels = dayKeys.map(d => {
    const date = new Date(d * 1000);
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  });
  return { days: dayKeys, labels, series, total: series.reduce((s, m) => s + m.total, 0) };
}

// Exact excerpt: cloudflare/src/index.js:458-463
function publishedUsageValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Exact excerpt: cloudflare/src/index.js:465-476
function accumulateTeamDaily(daily, records, start, end) {
  if (!Array.isArray(records)) return;
  for (const point of records) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) continue;
    const seconds = publishedUsageValue(point.day), tokens = publishedUsageValue(point.tokens);
    if (seconds === null || tokens === null || tokens < 0) continue;
    const day = Math.floor(seconds / 86400);
    if (day < start || day > end) continue;
    const total = (daily.get(day) || 0) + tokens;
    if (Number.isFinite(total)) daily.set(day, total);
  }
}

// Exact excerpt: cloudflare/src/index.js:478-512
function aggregateTeams(entries) {
  const map = new Map(), end = dayNumber(), start = end - 118;
  for (const e of entries) for (const membership of entryTeams(e).length ? entryTeams(e) : [null]) {
    const team = membership?.name || (e.team || "").trim() || "Unassigned";
    const teamId = membership?.id || e.teamId;
    const key = teamId ? `id:${teamId}` : `legacy:${team}`;
    if (!map.has(key)) map.set(key, { team, ...(teamId ? { teamId } : {}), tokens: 0, tokensToday: 0, tokens7d: 0, recentWindowProfiles: { today: 0, week: 0 }, cost: 0, members: 0, providers: {}, users: [], daily: new Map() });
    const row = map.get(key);
    row.tokens += e.tokensAll || 0;
    // Window totals are the profiles' last published values. Provider mix and
    // shared cost remain all-time; unpublished members contribute no usage.
    const today = publishedUsageValue(e.tokensToday), week = publishedUsageValue(e.tokens7d);
    row.tokensToday += today ?? 0;
    row.tokens7d += week ?? 0;
    if (today !== null) row.recentWindowProfiles.today += 1;
    if (week !== null) row.recentWindowProfiles.week += 1;
    row.cost += e.costAll || 0;
    row.members += 1;
    row.users.push({ handle: e.handle, tokensAll: e.tokensAll || 0, avatarUrl: e.avatarUrl || "", avatarStyle: e.avatarStyle || "" });
    // Only published records enter the bounded UTC history. Missing dates are
    // not manufactured as zero activity, and an empty array stays unavailable.
    accumulateTeamDaily(row.daily, e.breakdown?.daily, start, end);
    for (const m of (e.breakdown && e.breakdown.models) || []) {
      const p = normalizeProvider(m.provider);
      row.providers[p] = (row.providers[p] || 0) + (Number(m.tokensAll) || 0);
    }
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens).map(r => ({
    ...r,
    daily: [...r.daily.entries()].sort((a, b) => a[0] - b[0]).map(([day, tokens]) => ({ day: day * 86400, tokens })),
    tokensFormatted: formatTokens(r.tokens),
    costFormatted: formatCurrency(r.cost),
    users: r.users.sort((a, b) => b.tokensAll - a.tokensAll).slice(0, 6)
  }));
}

// Exact excerpt: cloudflare/src/index.js:2287-2300
function formatTokens(n) {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + "T";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}

function formatCurrency(n) {
  if (!n || n <= 0) return "$0";
  if (n >= 1000) return "$" + Math.round(n).toLocaleString();
  return "$" + n.toFixed(2);
}

// Exact excerpt: cloudflare/src/team-invites.js:12-12
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// Exact excerpt: cloudflare/src/team-invites.js:93-96
export function entryTeams(entry) {
  const teams = Array.isArray(entry?.teams) ? entry.teams : entry?.teamId ? [{ id: entry.teamId, name: entry.team }] : [];
  return [...new Map(teams.filter(team => validId(team?.id)).map(team => [team.id, team])).values()];
}

// Harness-only export list; function bodies above are unchanged.
export { aggregateUsageHistory, aggregateTeams, sanitizeEntry };
