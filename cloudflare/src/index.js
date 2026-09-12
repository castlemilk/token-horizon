/**
 * Token Horizon — Cloudflare Edge Webhosting & R2 Leaderboard Backend
 *
 * Provides sub-20ms edge responses globally, direct R2 bucket persistence,
 * dynamic SVG badge generation for READMEs, and static asset webhosting.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Leaderboard-Secret, X-Claim-Token, X-Google-Token",
};

// --- League ladder (mirrors Sources/TokenHorizon/Leaderboard/LeaderboardAnalytics.swift) ---
const SEASON_REWARDS = [
  { icon: "👑", title: "Higher Token Quotas", detail: "Larger rate limits for higher leagues." },
  { icon: "⭐", title: "Exclusive Badge Cosmetics", detail: "Show off your rank across your profile." },
  { icon: "📊", title: "Advanced Analytics", detail: "Unlock deeper usage insights." },
  { icon: "⌨️", title: "API Quota Boosts", detail: "Higher tiers get increased API limits." },
  { icon: "🤝", title: "Team Bragging Rights", detail: "Represent your org on the global stage." }
];

const LEAGUES = [
  { id: "bronze", title: "Bronze", min: 0, max: 50000, color: "#B0774B" },
  { id: "silver", title: "Silver", min: 50000, max: 250000, color: "#AEB6C4" },
  { id: "gold", title: "Gold", min: 250000, max: 1000000, color: "#E0B44C" },
  { id: "platinum", title: "Platinum", min: 1000000, max: 5000000, color: "#4FC3F7" },
  { id: "diamond", title: "Diamond", min: 5000000, max: 20000000, color: "#7C6BF5" },
  { id: "master", title: "Master", min: 20000000, max: 100000000, color: "#B44CF0" },
  { id: "grandmaster", title: "Grandmaster", min: 100000000, max: null, color: "#F0446B" }
];

function leagueIndexForTokens(tokensAll) {
  const tokens = Math.max(0, Number(tokensAll) || 0);
  let idx = 0;
  for (let i = 0; i < LEAGUES.length; i++) {
    if (tokens >= LEAGUES[i].min) idx = i;
  }
  return idx;
}

function mmrFor(tokensAll, streakDays, activeDays, modelCount) {
  const tokens = Math.max(0, Number(tokensAll) || 0);
  const tierIdx = leagueIndexForTokens(tokens);
  const tier = LEAGUES[tierIdx];
  let base;
  if (tier.max) {
    const lo = Math.max(1, tier.min);
    const ratio = Math.max(1, tokens) / lo;
    const span = Math.log(tier.max / lo);
    const progress = span > 0 ? Math.min(1, Math.max(0, Math.log(ratio) / span)) : 0;
    base = tierIdx * 400 + progress * 400;
  } else {
    // Grandmaster: 100M = band base, each decade of tokens adds a full band
    // (continuous with Master's interpolation at 100M).
    const overflow = Math.log(Math.max(1, tokens / tier.min)) / Math.log(10);
    base = tierIdx * 400 + Math.min(1, Math.max(0, overflow)) * 400;
  }
  const streakBonus = Math.min(60, Math.max(0, Number(streakDays) || 0) * 6);
  const activeBonus = Math.min(50, (Number(activeDays) || 0) * 2);
  const diversityBonus = Math.min(40, Math.max(0, (Number(modelCount) || 1) - 1) * 8);
  return Math.round(base + streakBonus + activeBonus + diversityBonus);
}

function standingFor(entry) {
  const models = (entry.breakdown && entry.breakdown.models) || [];
  const mmr = Number(entry.mmr) > 0
    ? Number(entry.mmr)
    : mmrFor(entry.tokensAll, entry.streakDays, entry.breakdown ? entry.breakdown.activeDays : 0, models.length);
  const clamped = Math.max(0, Math.round(mmr));
  const tierIdx = Math.min(LEAGUES.length - 1, Math.floor(clamped / 400));
  const league = LEAGUES[tierIdx];
  const pos = Math.min(Math.max(clamped - tierIdx * 400, 0), 399);
  const division = pos < 133.34 ? 3 : (pos < 266.67 ? 2 : 1);
  const next = LEAGUES[tierIdx + 1] || null;
  return {
    league: league.id,
    leagueTitle: league.title,
    leagueColor: league.color,
    division,
    mmr: clamped,
    mmrToNext: next ? (tierIdx + 1) * 400 - clamped : null,
    progressWithinLeague: Math.round((pos / 400) * 1000) / 1000
  };
}

function seasonFor(date = new Date()) {
  const names = ["Genesis", "Horizon", "Ascension", "Zenith"];
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3);
  const number = (year - 2026) * 4 + quarter + 1;
  const start = new Date(Date.UTC(year, quarter * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3 + 3, 1));
  const daysRemaining = Math.max(0, Math.ceil((end - date) / 86400000));
  const progress = Math.min(1, Math.max(0, (date - start) / (end - start)));
  const name = names[(Math.max(1, number) - 1) % names.length];
  return {
    id: `${year}-Q${quarter + 1}`,
    number,
    name,
    displayName: `Season ${number} — ${name}`,
    start: start.toISOString(),
    end: end.toISOString(),
    daysRemaining,
    progress: Math.round(progress * 1000) / 1000
  };
}

function efficiencyFor(entry) {
  const direct = Number(entry.efficiency);
  if (direct > 0) return Math.round(direct * 10) / 10;
  const models = (entry.breakdown && entry.breakdown.models) || [];
  const total = Number(entry.tokensAll) || 0;
  if (total <= 0) return 0;
  const input = Number(entry.inputTokensAll) || models.reduce((s, m) => s + (Number(m.inputTokens) || 0), 0);
  const output = Number(entry.outputTokensAll) || models.reduce((s, m) => s + (Number(m.outputTokens) || 0), 0);
  const cacheRead = models.reduce((s, m) => s + (Number(m.cacheReadAll) || 0), 0);
  const free = models.reduce((s, m) => s + (m.free ? (Number(m.tokensAll) || 0) : 0), 0);
  const cacheHit = cacheRead / Math.max(1, cacheRead + input);
  const outputRatio = output / Math.max(1, input + output);
  const freeShare = free / Math.max(1, total);
  return Math.min(100, Math.max(0, Math.round((0.45 * cacheHit + 0.35 * outputRatio + 0.20 * freeShare) * 1000) / 10));
}

function achievementsFor(entry, percentile) {
  const published = Array.isArray(entry.achievements) ? entry.achievements : [];
  const models = (entry.breakdown && entry.breakdown.models) || [];
  const requestsAll = Number(entry.requestsAll) || models.reduce((s, m) => s + (Number(m.requests) || 0), 0);
  const out = published.map(a => ({ id: a.id, title: a.title, detail: a.detail, icon: a.icon || "🏅", unlockedAt: a.unlockedAt || null }));
  const has = (id) => out.some(a => a.id === id);
  const add = (id, title, detail, icon, unlocked) => {
    if (unlocked && !has(id)) out.push({ id, title, detail, icon, unlockedAt: null });
  };
  add("century", "Century Club", "100+ requests logged", "💬", requestsAll >= 100);
  add("prompt_master", "Prompt Master", "1,000+ requests logged", "🏆", requestsAll >= 1000);
  add("model_explorer", "Model Explorer", "Used 5+ different models", "🧭", models.length >= 5);
  add("ten_million", "10M Tokens", "Crossed 10M all-time tokens", "📚", (entry.tokensAll || 0) >= 10000000);
  add("hundred_million", "100M Tokens", "Crossed 100M all-time tokens", "🌌", (entry.tokensAll || 0) >= 100000000);
  add("efficiency_expert", "Efficiency Expert", "Efficiency score of 90+", "⚡", efficiencyFor(entry) >= 90);
  add("consistent_creator", "Consistent Creator", "7-day usage streak", "🔥", (entry.streakDays || 0) >= 7);
  add("streak_master", "Streak Master", "30-day usage streak", "☄️", (entry.streakDays || 0) >= 30);
  add("season_grinder", "Season Grinder", "1M+ tokens this season", "🚀", (entry.seasonTokens || 0) >= 1000000);
  add("top_decile", "Top 10%", "Ranked in the global top 10%", "👑", percentile >= 90);
  return out;
}

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

function dayNumber(date = new Date()) {
  return Math.floor(date.getTime() / 1000 / 86400);
}

function nearestSnapshot(entry, targetDay, maxDistance = 3) {
  const snaps = entry.snapshots || [];
  let best = null;
  let bestDist = Infinity;
  for (const s of snaps) {
    const d = Math.abs((s.day || 0) - targetDay);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (best && bestDist <= maxDistance) return best;
  return null;
}

function appendSnapshot(entries, entry) {
  const day = dayNumber();
  const providers = {};
  for (const m of (entry.breakdown && entry.breakdown.models) || []) {
    const p = normalizeProvider(m.provider);
    providers[p] = (providers[p] || 0) + (Number(m.tokensAll) || 0);
  }
  const snap = {
    day,
    tokensAll: entry.tokensAll || 0,
    tokens7d: entry.tokens7d || 0,
    costAll: entry.costAll || 0,
    mmr: entry.mmr || 0,
    league: entry.league || "",
    rank: 0,
    providers
  };
  if (!Array.isArray(entry.snapshots)) entry.snapshots = [];
  const idx = entry.snapshots.findIndex(s => (s.day || 0) === day);
  if (idx !== -1) entry.snapshots[idx] = snap;
  else entry.snapshots.push(snap);
  if (entry.snapshots.length > 60) entry.snapshots = entry.snapshots.slice(-60);

  // Stamp today's rank for every entry (O(n log n), n is small).
  const sorted = [...entries].sort((a, b) => (b.tokensAll || 0) - (a.tokensAll || 0));
  sorted.forEach((e, i) => {
    const s = (e.snapshots || []).find(x => (x.day || 0) === day);
    if (s) s.rank = i + 1;
  });
}

function sanitizeEntry(entry, full = false) {
  const copy = JSON.parse(JSON.stringify(entry));
  if (copy.breakdown) {
    if (!full) {
      delete copy.breakdown.hourly;
      delete copy.breakdown.sessions;
      delete copy.breakdown.modelHistory;
      delete copy.breakdown.daily;
    }
  }
  if (!full) delete copy.snapshots;
  delete copy.claimTokenHash;
  delete copy.ownerId;
  return copy;
}

/// Monotonic time-series merge for publishes: a fresh (or reset) client with a
/// short local window must never truncate days already published by the same
/// handle. Incoming days win; remote-only days are preserved. Other breakdown
/// fields (models, sessions, projects, hourly) stay as published — privacy
/// gating is applied while building the payload locally.
function mergeBreakdownHistory(incoming, previous, maxDays = 130) {
  // Local history points carry epoch-second `day` values.
  const cutoff = (dayNumber() - maxDays) * 86400;
  const dayOf = (p) => Number(p && p.day) || 0;
  const trim = (points) => {
    const byDay = new Map();
    for (const p of points || []) { const d = dayOf(p); if (p && d >= cutoff) byDay.set(d, p); }
    return [...byDay.values()].sort((a, b) => dayOf(a) - dayOf(b));
  };
  const out = { ...incoming };

  const models = new Map();
  for (const m of incoming.modelHistory || []) {
    if (m && m.model) models.set(m.model, { model: m.model, provider: m.provider, points: trim(m.points) });
  }
  for (const m of previous.modelHistory || []) {
    if (!m || !m.model) continue;
    const cur = models.get(m.model);
    const prevPoints = trim(m.points);
    if (!cur) { models.set(m.model, { model: m.model, provider: m.provider, points: prevPoints }); continue; }
    const seen = new Set(cur.points.map(dayOf));
    for (const p of prevPoints) if (!seen.has(dayOf(p))) cur.points.push(p);
    cur.points.sort((a, b) => dayOf(a) - dayOf(b));
    if ((!cur.provider || cur.provider === "other") && m.provider) cur.provider = m.provider;
  }
  out.modelHistory = [...models.values()];

  const daily = new Map();
  for (const p of previous.daily || []) { const d = dayOf(p); if (p && d >= cutoff) daily.set(d, p); }
  for (const p of incoming.daily || []) { const d = dayOf(p); if (p && d >= cutoff) daily.set(d, p); }
  out.daily = [...daily.values()].sort((a, b) => dayOf(a) - dayOf(b));

  const history = new Map();
  for (const p of previous.history || []) history.set(dayOf(p), p);
  for (const p of incoming.history || []) history.set(dayOf(p), p);
  out.history = [...history.values()].sort((a, b) => dayOf(a) - dayOf(b)).slice(-10);
  return out;
}

function computeMovers(entries) {
  const currentRanks = new Map();
  [...entries]
    .sort((a, b) => (b.tokensAll || 0) - (a.tokensAll || 0))
    .forEach((e, i) => currentRanks.set(e.handle.toLowerCase(), i + 1));

  const target = dayNumber() - 7;
  const gains = [];
  const improved = [];
  const promotions = [];
  for (const e of entries) {
    const snap = nearestSnapshot(e, target);
    if (!snap) continue;
    const delta = (e.tokensAll || 0) - (snap.tokensAll || 0);
    const pct = snap.tokensAll > 0 ? Math.round((delta / snap.tokensAll) * 1000) / 10 : (delta > 0 ? 100 : 0);
    const rank = currentRanks.get(e.handle.toLowerCase()) || 0;
    const rankDelta = snap.rank > 0 && rank > 0 ? snap.rank - rank : null;
    const row = {
      handle: e.handle,
      team: e.team || "",
      avatarUrl: e.avatarUrl || "",
      avatarStyle: e.avatarStyle || "",
      league: standingFor(e).league,
      leagueTitle: standingFor(e).leagueTitle,
      tokensAll: e.tokensAll || 0,
      delta,
      deltaFormatted: formatTokens(delta),
      percent: pct,
      rank,
      rankDelta
    };
    gains.push(row);
    improved.push(row);
    const snapLeagueIdx = LEAGUES.findIndex(l => l.id === (snap.league || "").toLowerCase());
    const nowIdx = LEAGUES.findIndex(l => l.id === standingFor(e).league);
    if (snap.league && nowIdx > snapLeagueIdx && snapLeagueIdx !== -1) {
      promotions.push({
        handle: e.handle,
        team: e.team || "",
        from: LEAGUES[snapLeagueIdx].title,
        to: LEAGUES[nowIdx].title,
        at: snap.day * 86400
      });
    }
  }
  gains.sort((a, b) => b.delta - a.delta);
  improved.sort((a, b) => b.percent - a.percent);
  promotions.sort((a, b) => b.at - a.at);
  return {
    gains: gains.slice(0, 5),
    drops: gains.slice(-5).reverse().filter(r => r.delta < 0),
    improved: improved.slice(0, 5),
    promotions: promotions.slice(0, 5)
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Stacked usage-by-model series aggregated across published entries.
/// `days` is the trailing window (dashboard passes its range pill value).
function aggregateUsageHistory(entries, days = 30) {
  const byModel = new Map();
  const allDays = new Set();
  for (const e of entries) {
    for (const mh of (e.breakdown && e.breakdown.modelHistory) || []) {
      const model = mh.model || "unknown";
      if (!byModel.has(model)) {
        byModel.set(model, { model, provider: normalizeProvider(mh.provider), days: new Map() });
      }
      const row = byModel.get(model);
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

function aggregateProviders(entries) {
  const map = new Map();
  for (const e of entries) {
    const models = (e.breakdown && e.breakdown.models) || [];
    for (const m of models) {
      const p = normalizeProvider(m.provider);
      if (!map.has(p)) {
        map.set(p, { provider: p, tokens: 0, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, models: new Set(), users: new Set(), trend: [] });
      }
      const row = map.get(p);
      row.tokens += Number(m.tokensAll) || 0;
      row.cost += Number(m.costAll) || 0;
      row.requests += Number(m.requests) || 0;
      row.inputTokens += Number(m.inputTokens) || 0;
      row.outputTokens += Number(m.outputTokens) || 0;
      if (m.model) row.models.add(m.model);
      row.users.add(e.handle);
    }
  }
  const rows = [...map.values()].map(r => {
    const avgCostPerM = r.tokens > 0 ? Math.round((r.cost / (r.tokens / 1000000)) * 10000) / 10000 : 0;
    return {
      provider: r.provider,
      tokens: r.tokens,
      cost: r.cost,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      models: r.models.size,
      users: r.users.size,
      avgCostPerM,
      tokensFormatted: formatTokens(r.tokens),
      costFormatted: formatCurrency(r.cost),
      avgCostPerMText: avgCostPerM > 0 && avgCostPerM < 0.01 ? "$" + avgCostPerM.toFixed(4) : "$" + avgCostPerM.toFixed(2)
    };
  }).sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  for (const r of rows) r.sharePercent = total > 0 ? Math.round((r.tokens / total) * 1000) / 10 : 0;
  return { rows, total };
}

function aggregateSessions(entries) {
  const sessions = [];
  for (const e of entries) {
    for (const s of (e.breakdown && e.breakdown.sessions) || []) {
      // Titles are private unless the owner opted in; redacted activity rows
      // (no title) never surface in prompt analytics.
      if (!s.title) continue;
      sessions.push({
        title: s.title || "",
        provider: normalizeProvider(s.provider),
        model: s.model || "",
        tokens: Number(s.tokens) || 0,
        cost: Number(s.cost) || 0,
        requests: Number(s.requests) || 0,
        at: Number(s.at) || 0,
        handle: e.handle,
        team: e.team || ""
      });
    }
  }
  return sessions;
}

/// Per-provider daily token series.
/// Modern publishes carry exact per-model daily history (`breakdown.modelHistory`),
/// so those entries are aggregated directly. Snapshots remain the fallback for
/// legacy entries (or days before a client started publishing modelHistory);
/// their cumulative provider totals are diffed and spread across publish gaps.
function providerHistory(entries, days = 30) {
  const end = dayNumber();
  const start = end - days + 1;
  // Local publishes store modelHistory days as epoch seconds; snapshots use
  // day numbers. Normalize both to the UTC day index used by `dayNumber()`.
  const dayIndexOf = (value) => Math.floor((Number(value) || 0) / 86400);

  // Exact daily totals from published modelHistory.
  const exact = new Map();
  const legacyEntries = [];
  for (const e of entries) {
    const modelHistory = (e.breakdown && e.breakdown.modelHistory) || [];
    const hasExact = modelHistory.some(m => (m.points || []).some(p => {
      const day = dayIndexOf(p.day);
      return day >= start && day <= end;
    }));
    if (!hasExact) { legacyEntries.push(e); continue; }
    for (const m of modelHistory) {
      const p = normalizeProvider(m.provider);
      for (const pt of m.points || []) {
        const day = dayIndexOf(pt.day);
        if (day < start || day > end) continue;
        if (!exact.has(day)) exact.set(day, {});
        const bucket = exact.get(day);
        bucket[p] = (bucket[p] || 0) + (Number(pt.tokens) || 0);
      }
    }
  }

  // Legacy snapshot diffing (cumulative per-provider totals → daily usage).
  const byDay = new Map();
  for (const e of legacyEntries) {
    for (const s of e.snapshots || []) {
      const day = s.day || 0;
      if (day < start || day > end) continue;
      if (!byDay.has(day)) byDay.set(day, {});
      const bucket = byDay.get(day);
      for (const [p, tokens] of Object.entries(s.providers || {})) {
        // Snapshots written before provider normalization carry raw ids
        // (e.g. zai-coding-plan); fold them into the canonical key on read.
        const key = normalizeProvider(p);
        bucket[key] = (bucket[key] || 0) + (Number(tokens) || 0);
      }
    }
  }
  const legacyDaily = new Map();
  const legacyDays = [...byDay.keys()].sort((a, b) => a - b);
  for (let i = 0; i < legacyDays.length; i++) {
    const day = legacyDays[i];
    const prev = i > 0 ? byDay.get(legacyDays[i - 1]) : null;
    const current = byDay.get(day);
    const gap = prev ? Math.max(1, day - legacyDays[i - 1]) : 1;
    const row = {};
    for (const p of Object.keys(current)) {
      const cumulative = current[p] || 0;
      const baseline = prev ? (prev[p] || 0) : 0;
      // Spread multi-day gaps across the missing days so sparse publishes
      // don't show up as artificial spikes.
      row[p] = Math.round(i === 0 ? cumulative : Math.max(0, (cumulative - baseline) / gap));
    }
    legacyDaily.set(day, row);
  }

  const dayKeys = [...new Set([...exact.keys(), ...legacyDaily.keys()])].sort((a, b) => a - b);
  const providers = new Set();
  for (const b of exact.values()) Object.keys(b).forEach(p => providers.add(p));
  for (const b of legacyDaily.values()) Object.keys(b).forEach(p => providers.add(p));
  const points = dayKeys.map(day => {
    const row = { day, date: new Date(day * 86400 * 1000).toISOString().slice(0, 10), values: {}, total: 0 };
    for (const p of providers) {
      const v = ((exact.get(day) || {})[p] || 0) + ((legacyDaily.get(day) || {})[p] || 0);
      row.values[p] = v;
      row.total += v;
    }
    return row;
  });
  return { providers: [...providers].sort(), points };
}

function aggregateTeams(entries) {
  const map = new Map();
  for (const e of entries) {
    const team = (e.team || "").trim() || "Unassigned";
    if (!map.has(team)) map.set(team, { team, tokens: 0, cost: 0, members: 0, providers: {}, users: [] });
    const row = map.get(team);
    row.tokens += e.tokensAll || 0;
    row.cost += e.costAll || 0;
    row.members += 1;
    row.users.push({ handle: e.handle, tokensAll: e.tokensAll || 0, avatarUrl: e.avatarUrl || "", avatarStyle: e.avatarStyle || "" });
    for (const m of (e.breakdown && e.breakdown.models) || []) {
      const p = normalizeProvider(m.provider);
      row.providers[p] = (row.providers[p] || 0) + (Number(m.tokensAll) || 0);
    }
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens).map(r => ({
    ...r,
    tokensFormatted: formatTokens(r.tokens),
    costFormatted: formatCurrency(r.cost),
    users: r.users.sort((a, b) => b.tokensAll - a.tokensAll).slice(0, 6)
  }));
}

const DEFAULT_STARTER_ENTRIES = [
  {
    id: "local:benebsworth",
    handle: "benebsworth",
    team: "Castlemilk",
    tokensToday: 2469019625,
    tokens7d: 14382156619,
    tokensAll: 23844909130,
    costToday: 822.40,
    cost7d: 6795.30,
    costAll: 8623.40,
    streakDays: 17,
    topModel: "claude-opus-5",
    hardware: "Apple M5 Max",
    isLocal: true,
    claimed: true,
    ownerId: "google:benebsworth",
    googleEmail: "ben@benebsworth.com",
    avatarUrl: "",
    updatedAt: Date.now() / 1000,
    mmr: 2860,
    league: "grandmaster",
    division: 1,
    efficiency: 84,
    inputTokensToday: 1450000000,
    outputTokensToday: 320000000,
    inputTokensAll: 14100000000,
    outputTokensAll: 3400000000,
    requestsToday: 312,
    requestsAll: 4120,
    seasonId: "2026-Q3",
    seasonTokens: 4200000000,
    achievements: [
      { id: "century", title: "Century Club", detail: "100+ requests logged", icon: "💬" },
      { id: "prompt_master", title: "Prompt Master", detail: "1,000+ requests logged", icon: "🏆" },
      { id: "model_explorer", title: "Model Explorer", detail: "Used 5+ different models", icon: "🧭" },
      { id: "ten_million", title: "10M Tokens", detail: "Crossed 10M all-time tokens", icon: "📚" },
      { id: "hundred_million", title: "100M Tokens", detail: "Crossed 100M all-time tokens", icon: "🌌" },
      { id: "consistent_creator", title: "Consistent Creator", detail: "7-day usage streak", icon: "🔥" },
      { id: "top_decile", title: "Top 10%", detail: "Ranked in the global top 10%", icon: "👑" }
    ],
    breakdown: {
      models: [
        { provider: "claude", model: "claude-opus-5", tokensToday: 1580000000, tokensAll: 14800000000, costToday: 550.00, costAll: 6100.00, sharePercent: 62.1, inputTokens: 9000000000, outputTokens: 2200000000, requests: 2100 },
        { provider: "claude", model: "claude-3-7-sonnet", tokensToday: 620000000, tokensAll: 5800000000, costToday: 210.00, costAll: 2100.00, sharePercent: 24.3, inputTokens: 3600000000, outputTokens: 800000000, requests: 900 },
        { provider: "google", model: "gemini-3.8-flash", tokensToday: 180000000, tokensAll: 1900000000, costToday: 34.00, costAll: 120.00, sharePercent: 8.0, inputTokens: 1100000000, outputTokens: 250000000, requests: 620 },
        { provider: "openai", model: "gpt-5-codex", tokensToday: 89019625, tokensAll: 1344909130, costToday: 28.40, costAll: 303.40, sharePercent: 5.6, inputTokens: 400000000, outputTokens: 150000000, requests: 500 }
      ],
      tools: [
        { tool: "claude", tokensToday: 2200000000, tokensAll: 20600000000, costToday: 760.00, costAll: 8200.00 },
        { tool: "gemini", tokensToday: 180000000, tokensAll: 1900000000, costToday: 34.00, costAll: 120.00 },
        { tool: "codex", tokensToday: 89019625, tokensAll: 1344909130, costToday: 28.40, costAll: 303.40 }
      ],
      history: [
        { day: 1, dayLabel: "Sep 4", tokens: 1850000000, cost: 720.00 },
        { day: 2, dayLabel: "Sep 5", tokens: 2100000000, cost: 840.00 },
        { day: 3, dayLabel: "Sep 6", tokens: 1450000000, cost: 580.00 },
        { day: 4, dayLabel: "Sep 7", tokens: 1950000000, cost: 780.00 },
        { day: 5, dayLabel: "Sep 8", tokens: 2300000000, cost: 920.00 },
        { day: 6, dayLabel: "Sep 9", tokens: 2250000000, cost: 900.00 },
        { day: 7, dayLabel: "Sep 10", tokens: 2469019625, cost: 822.40 }
      ],
      activeDays: 17,
      totalSessions: 42
    }
  }
];

async function sha256Hex(text) {
  if (!text) return "";
  const enc = new TextEncoder().encode(String(text));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- Google Identity Services ID-token verification ---
// The web dashboard signs users in with GSI and sends the resulting ID token
// (RS256 JWT). We verify it against Google's JWKS instead of trusting an
// unsigned payload. When GOOGLE_CLIENT_ID is unset the worker runs in legacy
// mode (unsigned `google:<email>` / body.googleUser accepted) so local dev and
// existing installs keep working; production sets the client ID.

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let googleJwksCache = { fetchedAt: 0, keys: [] };

function b64urlToBytes(input) {
  let b64 = String(input).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlDecodeJson(input) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

async function getGoogleJwks(env) {
  if (env.GOOGLE_JWKS) {
    // Hermetic test / offline override: inline JWKS JSON.
    try { return JSON.parse(env.GOOGLE_JWKS).keys || []; } catch (_) { return []; }
  }
  const now = Date.now();
  if (googleJwksCache.keys.length && now - googleJwksCache.fetchedAt < 3600_000) {
    return googleJwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error("Google JWKS fetch failed: HTTP " + res.status);
  const data = await res.json();
  googleJwksCache = { fetchedAt: now, keys: data.keys || [] };
  return googleJwksCache.keys;
}

async function verifyGoogleIdToken(token, env) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = b64urlDecodeJson(parts[0]);
    payload = b64urlDecodeJson(parts[1]);
  } catch (_) {
    return null;
  }
  if (header.alg !== "RS256") return null;

  let keys;
  try {
    keys = await getGoogleJwks(env);
  } catch (_) {
    return null;
  }
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk && !env.GOOGLE_JWKS) {
    // Unknown kid: refresh once (Google rotates signing keys).
    googleJwksCache.fetchedAt = 0;
    try { keys = await getGoogleJwks(env); } catch (_) { return null; }
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) return null;

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
  } catch (_) {
    return null;
  }
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iat && payload.iat > now + 300) return null;
  if (payload.nbf && payload.nbf > now + 300) return null;
  const iss = String(payload.iss || "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") return null;
  if (env.GOOGLE_CLIENT_ID && payload.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!payload.sub || !payload.email) return null;
  if (payload.email_verified === false) return null;

  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.given_name || ""),
    picture: String(payload.picture || ""),
    verified: true
  };
}

async function parseGoogleAuth(request, body = {}, env = {}) {
  let token = request.headers.get("X-Google-Token") || "";
  if (!token) {
    const auth = request.headers.get("Authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      const candidate = auth.slice(7).trim();
      if (candidate.split(".").length === 3 || candidate.startsWith("google:")) {
        token = candidate;
      }
    }
  }
  if (!token && body.googleToken) token = body.googleToken;
  if (!token && body.googleCredential) token = body.googleCredential;

  if (env.GOOGLE_CLIENT_ID) {
    // Production: only cryptographically verified ID tokens are accepted.
    if (token && token.split(".").length === 3) {
      return await verifyGoogleIdToken(token, env);
    }
    return null;
  }

  // Legacy/dev mode (no GOOGLE_CLIENT_ID configured): unsigned fallbacks.
  if (body.googleUser && body.googleUser.email && (body.googleUser.sub || body.googleUser.id)) {
    return {
      sub: String(body.googleUser.sub || body.googleUser.id),
      email: String(body.googleUser.email).toLowerCase(),
      name: String(body.googleUser.name || ""),
      picture: String(body.googleUser.picture || body.googleUser.avatar || "")
    };
  }

  if (!token) return null;

  if (token.startsWith("google:")) {
    const sub = token.replace(/^google:/, "");
    return {
      sub,
      email: sub.includes("@") ? sub.toLowerCase() : "ben.ebsworth@gmail.com",
      name: sub,
      picture: ""
    };
  }

  try {
    const payload = b64urlDecodeJson(token.split(".")[1]);
    if (payload.sub && payload.email) {
      return {
        sub: String(payload.sub),
        email: String(payload.email).toLowerCase(),
        name: String(payload.name || payload.given_name || ""),
        picture: String(payload.picture || "")
      };
    }
  } catch (e) {
    // Non-fatal
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // 0. Canonicalize hosts → token-horizon.dev (permanent).
    //    The legacy host keeps serving /api/* so existing app installs can
    //    publish/pull until they upgrade; browser traffic 301s.
    if (url.hostname.startsWith("www.")) {
      const canonical = new URL(request.url);
      canonical.hostname = url.hostname.slice(4);
      return Response.redirect(canonical.toString(), 301);
    }
    if (url.hostname === "tokens.benebsworth.com" && !pathname.startsWith("/api/")) {
      const canonical = new URL(request.url);
      canonical.hostname = "token-horizon.dev";
      return Response.redirect(canonical.toString(), 301);
    }

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Health & Status
    if (pathname === "/api/health") {
      const hasBucket = Boolean(env.LEADERBOARD_BUCKET);
      return jsonResponse({
        ok: true,
        service: "token-horizon-cloudflare-leaderboard",
        storage: hasBucket ? "Cloudflare R2" : "Memory Fallback",
        edge_colo: request.cf?.colo || "local",
        edge_country: request.cf?.country || "unknown",
        google_client_id: env.GOOGLE_CLIENT_ID || "",
        timestamp: new Date().toISOString()
      });
    }

    // 2b. Client config (public values only — safe to embed)
    if (pathname === "/api/config") {
      return jsonResponse({
        ok: true,
        googleClientId: env.GOOGLE_CLIENT_ID || "",
        googleAuth: Boolean(env.GOOGLE_CLIENT_ID),
        canonicalUrl: `https://${url.hostname}`,
        season: seasonFor()
      }, 200, { "Cache-Control": "public, max-age=300, s-maxage=600" });
    }

    // 3. GET /api/leaderboard (or /leaderboard with JSON accept / query)
    const isGetLeaderboard = request.method === "GET" && (
      pathname === "/api/leaderboard" ||
      (pathname === "/leaderboard" && (request.headers.get("accept")?.includes("json") || searchParams.has("period") || searchParams.has("format")))
    );
    if (isGetLeaderboard) {
      const period = searchParams.get("period") || "today";
      const teamFilter = searchParams.get("team") || "";
      const leagueFilter = (searchParams.get("league") || "").toLowerCase();
      const full = searchParams.get("full") === "1";

      const entries = await getEntriesFromR2(env);
      let filtered = entries;

      if (teamFilter) {
        filtered = filtered.filter(e => e.team && e.team.toLowerCase().includes(teamFilter.toLowerCase()));
      }
      if (leagueFilter) {
        filtered = filtered.filter(e => standingFor(e).league === leagueFilter);
      }

      // Sort by chosen period score descending
      filtered.sort((a, b) => getPeriodScore(b, period) - getPeriodScore(a, period));

      const topScore = filtered.length > 0 ? getPeriodScore(filtered[0], period) : 1;
      const total = filtered.length;

      const ranked = filtered.map((e, idx) => {
        const rank = idx + 1;
        const score = getPeriodScore(e, period);
        const cost = getPeriodCost(e, period);
        const percentile = Math.round(((total - rank + 1) / Math.max(total, 1)) * 100);
        const relPercent = Math.round(Math.min(100, Math.max(1, (score / Math.max(topScore, 1)) * 100)) * 10) / 10;
        const st = standingFor(e);
        const oldSnap = nearestSnapshot(e, dayNumber() - 7);
        const rankDelta = oldSnap && oldSnap.rank > 0 ? oldSnap.rank - rank : null;
        const models = (e.breakdown && e.breakdown.models) || [];
        const periodRequests = period === "today"
          ? (e.requestsToday || 0)
          : (e.requestsAll || models.reduce((s, m) => s + (Number(m.requests) || 0), 0));
        const periodInput = period === "today"
          ? (e.inputTokensToday || 0)
          : (e.inputTokensAll || models.reduce((s, m) => s + (Number(m.inputTokens) || 0), 0));
        const periodOutput = period === "today"
          ? (e.outputTokensToday || 0)
          : (e.outputTokensAll || models.reduce((s, m) => s + (Number(m.outputTokens) || 0), 0));
        const trend = ((e.breakdown && e.breakdown.history) || []).map(h => h.tokens || 0);

        let badge = `#${rank}`;
        if (rank === 1) badge = "🥇 1st";
        else if (rank === 2) badge = "🥈 2nd";
        else if (rank === 3) badge = "🥉 3rd";
        else if (e.streakDays >= 7) badge = `🔥 ${e.streakDays}d`;

        return {
          rank,
          badge,
          percentile,
          score,
          scoreFormatted: formatTokens(score),
          costFormatted: formatCurrency(cost),
          relativePercent: relPercent,
          league: st.league,
          leagueTitle: st.leagueTitle,
          leagueColor: st.leagueColor,
          division: st.division,
          mmr: st.mmr,
          mmrToNext: st.mmrToNext,
          efficiency: efficiencyFor(e),
          rankDelta7d: rankDelta,
          avgPerRequest: periodRequests > 0 ? Math.round(score / periodRequests) : 0,
          inputFormatted: periodInput > 0 ? formatTokens(periodInput) : "",
          outputFormatted: periodOutput > 0 ? formatTokens(periodOutput) : "",
          requestsFormatted: periodRequests > 0 ? String(periodRequests) : "",
          trend,
          entry: sanitizeEntry(e, full)
        };
      });

      // Calculate Global KPIs + real deltas vs the snapshot closest to 7d ago.
      let totalTokens = 0;
      let totalCost = 0;
      let maxStreak = 0;
      let totalRequests = 0;
      let activeDevs = 0;
      let prevTokens = 0;
      let prevCost = 0;
      let prevActive = 0;
      const targetDay = dayNumber() - 7;
      entries.forEach(e => {
        totalTokens += (e.tokensAll || 0);
        totalCost += (e.costAll || 0);
        totalRequests += (e.requestsAll || 0);
        if ((e.streakDays || 0) > maxStreak) maxStreak = e.streakDays;
        if ((e.tokens7d || 0) > 0) activeDevs += 1;
        const snap = nearestSnapshot(e, targetDay);
        if (snap) {
          prevTokens += snap.tokensAll || 0;
          prevCost += snap.costAll || 0;
          if ((snap.tokens7d || 0) > 0) prevActive += 1;
        }
      });
      const pct = (now, prev) => prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : null;

      return jsonResponse({
        ok: true,
        period,
        team: teamFilter,
        league: leagueFilter,
        total: ranked.length,
        season: seasonFor(),
        leagueLadder: LEAGUES,
        kpis: {
          totalTokens,
          totalTokensFormatted: formatTokens(totalTokens),
          totalCost,
          totalCostFormatted: formatCurrency(totalCost),
          activeDevs,
          maxStreakDays: maxStreak,
          totalRequests,
          totalRequestsFormatted: formatTokens(totalRequests),
          avgTokensPerRequest: totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0,
          totalTokensDelta: pct(totalTokens, prevTokens),
          totalCostDelta: pct(totalCost, prevCost),
          activeDevsDelta: prevActive > 0 ? pct(activeDevs, prevActive) : null
        },
        movers: computeMovers(entries),
        usageHistory: aggregateUsageHistory(entries, Math.min(120, Math.max(7, parseInt(searchParams.get("historyDays") || "30", 10) || 30))),
        leaderboard: ranked
      }, 200, {
        "Cache-Control": "public, max-age=5, s-maxage=5, stale-while-revalidate=10"
      });
    }

    // 3b. GET /api/user (or /api/user/:handle) — Fetch single user's detailed entry & rankings
    if (request.method === "GET" && (pathname === "/api/user" || pathname.startsWith("/api/user/"))) {
      const handleParam = pathname.startsWith("/api/user/")
        ? decodeURIComponent(pathname.slice("/api/user/".length))
        : (searchParams.get("handle") || searchParams.get("user") || "");
      const clean = handleParam.replace(/^@/, "").trim().toLowerCase();
      if (!clean) {
        return jsonResponse({ ok: false, error: "Missing handle parameter" }, 400);
      }

      const entries = await getEntriesFromR2(env);
      const entry = entries.find(e => e.handle.toLowerCase() === clean);
      if (!entry) {
        return jsonResponse({ ok: false, error: `Participant @${handleParam} not found` }, 404);
      }

      const sortedBy = (p) => [...entries].sort((a, b) => getPeriodScore(b, p) - getPeriodScore(a, p));
      const computeRank = (p) => {
        const idx = sortedBy(p).findIndex(e => e.handle.toLowerCase() === clean);
        return idx !== -1 ? idx + 1 : 1;
      };

      const rankToday = computeRank("today");
      let badge = `#${rankToday}`;
      if (rankToday === 1) badge = "🥇 1st";
      else if (rankToday === 2) badge = "🥈 2nd";
      else if (rankToday === 3) badge = "🥉 3rd";
      else if (entry.streakDays >= 7) badge = `🔥 ${entry.streakDays}d`;

      const allRank = computeRank("all");
      const percentile = Math.round(((entries.length - allRank + 1) / Math.max(entries.length, 1)) * 100);
      const st = standingFor(entry);
      const oldSnap = nearestSnapshot(entry, dayNumber() - 7);
      const rankDelta7d = oldSnap && oldSnap.rank > 0 ? oldSnap.rank - rankToday : null;

      // Team peers: rank within the same team by all-time tokens.
      let teamRank = null;
      let teamTotal = 0;
      if (entry.team) {
        const teamPeers = entries
          .filter(e => (e.team || "").toLowerCase() === entry.team.toLowerCase())
          .sort((a, b) => (b.tokensAll || 0) - (a.tokensAll || 0));
        teamTotal = teamPeers.length;
        const idx = teamPeers.findIndex(e => e.handle.toLowerCase() === clean);
        teamRank = idx !== -1 ? idx + 1 : null;
      }

      const models = (entry.breakdown && entry.breakdown.models) || [];
      const rankDeltaHistory = (entry.snapshots || [])
        .filter(s => s.rank > 0)
        .sort((a, b) => a.day - b.day)
        .slice(-30)
        .map(s => ({ day: s.day, rank: s.rank, tokensAll: s.tokensAll || 0, mmr: s.mmr || 0, league: s.league || "" }));

      return jsonResponse({
        ok: true,
        handle: entry.handle,
        rank: rankToday,
        badge,
        ranks: {
          today: computeRank("today"),
          week: computeRank("week"),
          all: allRank,
          streak: computeRank("streak")
        },
        total: entries.length,
        percentile,
        standing: st,
        league: st.league,
        leagueTitle: st.leagueTitle,
        division: st.division,
        mmr: st.mmr,
        mmrToNext: st.mmrToNext,
        efficiency: efficiencyFor(entry),
        rankDelta7d,
        teamRank,
        teamTotal,
        requestsAll: entry.requestsAll || models.reduce((s, m) => s + (Number(m.requests) || 0), 0),
        inputTokensAll: entry.inputTokensAll || models.reduce((s, m) => s + (Number(m.inputTokens) || 0), 0),
        outputTokensAll: entry.outputTokensAll || models.reduce((s, m) => s + (Number(m.outputTokens) || 0), 0),
        achievements: achievementsFor(entry, percentile),
        rankHistory: rankDeltaHistory,
        season: seasonFor(),
        entry: sanitizeEntry(entry, true)
      });
    }

    // 4. POST /api/leaderboard (or POST /leaderboard) — Upsert usage stats (supports Anonymous & Google Auth)
    if (request.method === "POST" && (pathname === "/api/leaderboard" || pathname === "/leaderboard")) {
      try {
        // Optional secret enforcement if set on Worker (bypassed if valid Google Auth is provided)
        const googleAuth = await parseGoogleAuth(request, await request.clone().json().catch(() => ({})), env);
        if (env.LEADERBOARD_SECRET && !googleAuth) {
          const authHeader = request.headers.get("Authorization") || "";
          const customHeader = request.headers.get("X-Leaderboard-Secret") || "";
          const token = authHeader.replace(/^Bearer\s+/i, "").trim() || customHeader.trim();
          if (token !== env.LEADERBOARD_SECRET) {
            return jsonResponse({ ok: false, error: "Unauthorized: invalid write token or Google login required" }, 401);
          }
        }

        const body = await request.json();
        const incoming = body.entry || body;

        if (!incoming.handle) {
          return jsonResponse({ ok: false, error: "Missing handle in payload" }, 400);
        }

        const handleClean = String(incoming.handle).replace(/^@/, "").trim();
        const incomingClaimToken = String(incoming.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        const entries = await getEntriesFromR2(env);

        const numOr = (...vals) => {
          for (const v of vals) {
            if (v !== undefined && v !== null && v !== "") {
              const n = Number(v);
              if (!isNaN(n)) return n;
            }
          }
          return 0;
        };

        const tokensToday = numOr(incoming.tokensToday, incoming.today, incoming.tokens_today, incoming.today_tokens);
        const tokens7d = numOr(incoming.tokens7d, incoming.tokens_7d, incoming.week, incoming.tokensWeek, incoming.tokens_week, tokensToday);
        const tokensAll = numOr(incoming.tokensAll, incoming.tokens_all, incoming.all, incoming.tokensTotal, incoming.tokens_total, incoming.total, tokensToday);
        const costToday = numOr(incoming.costToday, incoming.cost_today, incoming.cost);
        const cost7d = numOr(incoming.cost7d, incoming.cost_7d, incoming.costWeek, incoming.cost_week, costToday);
        const costAll = numOr(incoming.costAll, incoming.cost_all, incoming.costTotal, incoming.cost_total, costToday);
        const streakDays = Math.max(1, numOr(incoming.streakDays, incoming.streak_days, incoming.streak));
        const topModel = String(incoming.topModel || incoming.top_model || incoming.model || "claude-3-7-sonnet").trim();
        const hardware = String(incoming.hardware || incoming.chip || incoming.device || "Apple Silicon").trim();
        const inputTokensToday = numOr(incoming.inputTokensToday, incoming.input_tokens_today);
        const outputTokensToday = numOr(incoming.outputTokensToday, incoming.output_tokens_today);
        const inputTokensAll = numOr(incoming.inputTokensAll, incoming.input_tokens_all);
        const outputTokensAll = numOr(incoming.outputTokensAll, incoming.output_tokens_all);
        const requestsToday = numOr(incoming.requestsToday, incoming.requests_today);
        const requestsAll = numOr(incoming.requestsAll, incoming.requests_all);
        const seasonId = String(incoming.seasonId || "").trim();
        const seasonTokens = numOr(incoming.seasonTokens, incoming.season_tokens);
        const mmr = numOr(incoming.mmr);
        const efficiency = numOr(incoming.efficiency);
        const achievements = Array.isArray(incoming.achievements) ? incoming.achievements : [];

        let breakdown = incoming.breakdown || null;
        if (!breakdown) {
          const prov = topModel.toLowerCase().includes("claude") ? "claude" : (topModel.toLowerCase().includes("gpt") ? "openai" : (topModel.toLowerCase().includes("gemini") ? "google" : "ai"));
          breakdown = {
            models: [
              {
                provider: prov,
                model: topModel,
                tokensToday,
                tokensAll,
                costToday,
                costAll,
                sharePercent: 100.0
              }
            ],
            tools: [
              {
                tool: prov,
                tokensToday,
                tokensAll,
                costToday,
                costAll
              }
            ],
            history: [],
            activeDays: streakDays,
            totalSessions: 1
          };
        }

        const newEntry = {
          id: incoming.id || `cf:${handleClean.toLowerCase()}`,
          handle: handleClean,
          team: String(incoming.team || "").trim(),
          tokensToday,
          tokens7d,
          tokensAll,
          costToday,
          cost7d,
          costAll,
          streakDays,
          topModel,
          hardware,
          isLocal: false,
          updatedAt: Date.now() / 1000,
          breakdown,
          claimed: false,
          ownerId: null,
          googleEmail: null,
          avatarUrl: incoming.avatarUrl || "",
          mmr,
          league: String(incoming.league || "").toLowerCase(),
          division: numOr(incoming.division),
          efficiency,
          inputTokensToday,
          outputTokensToday,
          inputTokensAll,
          outputTokensAll,
          requestsToday,
          requestsAll,
          seasonId,
          seasonTokens,
          achievements,
          snapshots: []
        };

        const existingIdx = entries.findIndex(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        let action = "created";
        let issuedClaimToken = null;

        if (existingIdx !== -1) {
          const prev = entries[existingIdx];

          // Check ownership if already claimed
          if (prev.claimed) {
            const isOwner = googleAuth && (
              prev.ownerId === `google:${googleAuth.sub}` ||
              (prev.googleEmail && prev.googleEmail === googleAuth.email)
            );
            if (!isOwner && !env.LEADERBOARD_SECRET) {
              return jsonResponse({
                ok: false,
                error: `Profile @${handleClean} is claimed by a verified Google account. Sign in with Google as ${prev.googleEmail || "the owner"} to publish updates.`
              }, 403);
            }
            newEntry.claimed = true;
            newEntry.ownerId = prev.ownerId;
            newEntry.googleEmail = prev.googleEmail;
            newEntry.avatarUrl = (googleAuth && googleAuth.picture) || prev.avatarUrl || "";
            newEntry.claimedAt = prev.claimedAt;
          } else {
            // Profile is currently unclaimed
            if (googleAuth) {
              // User is publishing with Google auth — claim profile!
              newEntry.claimed = true;
              newEntry.ownerId = `google:${googleAuth.sub}`;
              newEntry.googleEmail = googleAuth.email;
              newEntry.avatarUrl = googleAuth.picture || prev.avatarUrl || "";
              newEntry.claimedAt = Date.now() / 1000;
            } else {
              // Anonymous update — verify claim token if hash exists
              if (prev.claimTokenHash) {
                if (!incomingClaimToken) {
                  return jsonResponse({
                    ok: false,
                    error: `Profile @${handleClean} was created anonymously. Provide your claim token to update it, or sign in with Google to claim it.`
                  }, 403);
                }
                const tokenHash = await sha256Hex(incomingClaimToken);
                if (tokenHash !== prev.claimTokenHash) {
                  return jsonResponse({
                    ok: false,
                    error: `Invalid claim token for @${handleClean}. Provide the correct token or sign in with Google to claim.`
                  }, 403);
                }
                newEntry.claimTokenHash = prev.claimTokenHash;
              } else if (incomingClaimToken) {
                newEntry.claimTokenHash = await sha256Hex(incomingClaimToken);
              }
              newEntry.claimed = false;
              newEntry.ownerId = null;
            }
          }

          if (!newEntry.team && prev.team) newEntry.team = prev.team;
          if (!newEntry.avatarUrl && prev.avatarUrl) newEntry.avatarUrl = prev.avatarUrl;
          if (newEntry.tokensAll < prev.tokensAll && prev.tokensAll > 0) newEntry.tokensAll = prev.tokensAll;
          if (newEntry.costAll < prev.costAll && prev.costAll > 0) newEntry.costAll = prev.costAll;
          if (newEntry.tokens7d < prev.tokens7d && prev.tokens7d > 0) newEntry.tokens7d = prev.tokens7d;
          if (newEntry.streakDays < prev.streakDays && prev.streakDays > 0) newEntry.streakDays = prev.streakDays;
          if ((!newEntry.hardware || newEntry.hardware === "Apple Silicon") && prev.hardware && prev.hardware !== "Apple Silicon") {
            newEntry.hardware = prev.hardware;
          }
          if ((!newEntry.topModel || newEntry.topModel === "claude-3-7-sonnet") && prev.topModel && prev.topModel !== "claude-3-7-sonnet") {
            newEntry.topModel = prev.topModel;
          }
          if ((!incoming.breakdown || !incoming.breakdown.models || incoming.breakdown.models.length <= 1) && prev.breakdown && prev.breakdown.models && prev.breakdown.models.length > 1) {
            newEntry.breakdown = prev.breakdown;
          }
          // Monotonic history merge: never let a fresh/short local window
          // truncate remote days already published for this handle.
          if (newEntry.breakdown && prev.breakdown && newEntry.breakdown !== prev.breakdown) {
            newEntry.breakdown = mergeBreakdownHistory(newEntry.breakdown, prev.breakdown);
          }
          // Monotonic floors for the analytics fields so a sparse update never
          // regresses published stats.
          if (!newEntry.mmr && prev.mmr) newEntry.mmr = prev.mmr;
          if (!newEntry.league && prev.league) newEntry.league = prev.league;
          if (!newEntry.division && prev.division) newEntry.division = prev.division;
          if (!newEntry.efficiency && prev.efficiency) newEntry.efficiency = prev.efficiency;
          if (!newEntry.seasonId && prev.seasonId) newEntry.seasonId = prev.seasonId;
          if (newEntry.seasonTokens < prev.seasonTokens && prev.seasonTokens > 0) newEntry.seasonTokens = prev.seasonTokens;
          if (newEntry.inputTokensAll < prev.inputTokensAll && prev.inputTokensAll > 0) newEntry.inputTokensAll = prev.inputTokensAll;
          if (newEntry.outputTokensAll < prev.outputTokensAll && prev.outputTokensAll > 0) newEntry.outputTokensAll = prev.outputTokensAll;
          if (newEntry.requestsAll < prev.requestsAll && prev.requestsAll > 0) newEntry.requestsAll = prev.requestsAll;
          if (newEntry.achievements.length === 0 && Array.isArray(prev.achievements)) newEntry.achievements = prev.achievements;
          newEntry.snapshots = Array.isArray(prev.snapshots) ? prev.snapshots : [];
          entries[existingIdx] = newEntry;
          action = "updated";
        } else {
          // Brand new entry
          if (googleAuth) {
            newEntry.claimed = true;
            newEntry.ownerId = `google:${googleAuth.sub}`;
            newEntry.googleEmail = googleAuth.email;
            newEntry.avatarUrl = googleAuth.picture || "";
            newEntry.claimedAt = Date.now() / 1000;
          } else {
            newEntry.claimed = false;
            newEntry.ownerId = null;
            issuedClaimToken = incomingClaimToken || crypto.randomUUID();
            newEntry.claimTokenHash = await sha256Hex(issuedClaimToken);
          }
          entries.push(newEntry);
        }

        // Derive league/MMR server-side when the publisher didn't include them
        // (older clients / CSV imports), then stamp today's rank snapshot.
        const derived = standingFor(newEntry);
        if (!newEntry.league) newEntry.league = derived.league;
        if (!newEntry.division) newEntry.division = derived.division;
        if (!newEntry.mmr) newEntry.mmr = derived.mmr;
        appendSnapshot(entries, newEntry);

        await saveEntriesToR2(env, entries);

        return jsonResponse({
          ok: true,
          action,
          handle: handleClean,
          // Never echo ownership/claim hashes back over the wire.
          entry: sanitizeEntry(newEntry, true),
          claimToken: issuedClaimToken || incomingClaimToken || null,
          claimed: newEntry.claimed,
          totalEntries: entries.length,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 4b. POST /api/claim — Claim an unclaimed profile via Google login
    if (request.method === "POST" && pathname === "/api/claim") {
      try {
        const body = await request.json();
        const handleClean = String(body.handle || "").replace(/^@/, "").trim();
        if (!handleClean) {
          return jsonResponse({ ok: false, error: "Missing handle in payload" }, 400);
        }

        const googleAuth = await parseGoogleAuth(request, body, env);
        if (!googleAuth) {
          return jsonResponse({ ok: false, error: "Sign in with Google is required to claim a profile" }, 401);
        }

        const entries = await getEntriesFromR2(env);
        const idx = entries.findIndex(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (idx === -1) {
          return jsonResponse({ ok: false, error: `Profile @${handleClean} not found to claim` }, 404);
        }

        const entry = entries[idx];
        if (entry.claimed) {
          if (entry.ownerId === `google:${googleAuth.sub}` || entry.googleEmail === googleAuth.email) {
            return jsonResponse({ ok: true, message: `Profile @${handleClean} is already claimed by your Google account`, entry });
          }
          return jsonResponse({ ok: false, error: `Profile @${handleClean} is already claimed by another verified user` }, 409);
        }

        if (entry.claimTokenHash) {
          const rawToken = String(body.claimToken || request.headers.get("X-Claim-Token") || "").trim();
          if (rawToken) {
            const hash = await sha256Hex(rawToken);
            if (hash !== entry.claimTokenHash && !body.forceClaim) {
              return jsonResponse({ ok: false, error: `Claim token mismatch for @${handleClean}` }, 403);
            }
          }
        }

        entry.claimed = true;
        entry.ownerId = `google:${googleAuth.sub}`;
        entry.googleEmail = googleAuth.email;
        if (googleAuth.picture) entry.avatarUrl = googleAuth.picture;
        entry.claimedAt = Date.now() / 1000;
        entries[idx] = entry;

        await saveEntriesToR2(env, entries);

        return jsonResponse({
          ok: true,
          message: `Successfully claimed @${handleClean}!`,
          handle: handleClean,
          entry: sanitizeEntry(entry, true)
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5. GET /api/share — Dynamic SVG badges & Share cards
    if (request.method === "GET" && pathname === "/api/share") {
      const handle = searchParams.get("handle") || "";
      const period = searchParams.get("period") || "today";
      const format = searchParams.get("format") || "svg";

      const entries = await getEntriesFromR2(env);
      entries.sort((a, b) => getPeriodScore(b, period) - getPeriodScore(a, period));

      let targetIdx = -1;
      if (handle) {
        targetIdx = entries.findIndex(e => e.handle.toLowerCase() === handle.toLowerCase().replace(/^@/, ""));
      }
      if (targetIdx === -1 && entries.length > 0) targetIdx = 0;

      if (targetIdx === -1) {
        return new Response("No participant found", { status: 404, headers: CORS_HEADERS });
      }

      const entry = entries[targetIdx];
      const rank = targetIdx + 1;

      if (format === "svg") {
        const svg = generateShareSVG(entry, rank, period);
        return new Response(svg, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "image/svg+xml;charset=utf-8",
            "Cache-Control": "public, max-age=60, s-maxage=120"
          }
        });
      }

      if (format === "markdown") {
        const md = generateShareMarkdown(entry, rank, period);
        return new Response(md, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "text/markdown;charset=utf-8" }
        });
      }

      if (format === "text") {
        const txt = generateShareText(entry, rank, period);
        return new Response(txt, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "text/plain;charset=utf-8" }
        });
      }

      return jsonResponse({
        handle: entry.handle,
        team: entry.team,
        rank,
        period,
        tokensToday: entry.tokensToday,
        tokens7d: entry.tokens7d,
        tokensAll: entry.tokensAll,
        costToday: entry.costToday,
        streakDays: entry.streakDays,
        topModel: entry.topModel,
        hardware: entry.hardware
      });
    }

    // 6. POST /api/sync-sheets — Optional background bridge from Google Sheet to R2
    if (request.method === "POST" && pathname === "/api/sync-sheets") {
      try {
        const body = await request.json().catch(() => ({}));
        const sheetUrl = body.sheet_url || env.GOOGLE_SHEET_URL;
        if (!sheetUrl) {
          return jsonResponse({ ok: false, error: "Missing sheet_url" }, 400);
        }

        const csvExportUrl = sheetUrl.includes("/gviz/tq") ? sheetUrl :
          sheetUrl.replace(/\/edit.*$/, "/gviz/tq?tqx=out:csv");

        const res = await fetch(csvExportUrl);
        if (!res.ok) throw new Error("Failed to fetch Google Sheet CSV: HTTP " + res.status);

        const csvText = await res.text();
        const parsed = parseEntriesFromCSV(csvText);
        if (parsed.length === 0) throw new Error("No entries parsed from sheet CSV");

        await saveEntriesToR2(env, parsed);
        return jsonResponse({ ok: true, syncedCount: parsed.length });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 6b. GET /api/providers — aggregated provider analytics across all nodes
    if (request.method === "GET" && pathname === "/api/providers") {
      const entries = await getEntriesFromR2(env);
      const days = Math.min(60, Math.max(7, parseInt(searchParams.get("days") || "30", 10) || 30));
      const { rows, total } = aggregateProviders(entries);
      const history = providerHistory(entries, days);
      const teams = aggregateTeams(entries);
      const movers = computeMovers(entries);
      const efficient = [...rows].filter(r => r.tokens > 0 && r.cost > 0)
        .sort((a, b) => a.avgCostPerM - b.avgCostPerM);
      const topPrompts = aggregateSessions(entries)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 8);
      return jsonResponse({
        ok: true,
        total,
        totalFormatted: formatTokens(total),
        providers: rows,
        history,
        teams,
        topPrompts,
        insights: {
          mostUsed: rows[0] || null,
          mostEfficient: efficient[0] || null,
          biggestGrowth: movers.improved[0] || null
        },
        season: seasonFor()
      }, 200, { "Cache-Control": "public, max-age=15, s-maxage=30" });
    }

    // 6c. GET /api/teams — team aggregation
    if (request.method === "GET" && pathname === "/api/teams") {
      const entries = await getEntriesFromR2(env);
      return jsonResponse({ ok: true, teams: aggregateTeams(entries), total: entries.length });
    }

    // 6d. GET /api/season — current season, ladder, distribution, promotions
    if (request.method === "GET" && pathname === "/api/season") {
      const entries = await getEntriesFromR2(env);
      const season = seasonFor();
      const distribution = LEAGUES.map(l => ({ ...l, users: 0, tokens: 0, percent: 0 }));
      for (const e of entries) {
        const st = standingFor(e);
        const idx = LEAGUES.findIndex(l => l.id === st.league);
        if (idx !== -1) {
          distribution[idx].users += 1;
          distribution[idx].tokens += e.tokensAll || 0;
        }
      }
      const totalUsers = Math.max(1, entries.length);
      distribution.forEach(d => { d.percent = Math.round((d.users / totalUsers) * 1000) / 10; });
      const movers = computeMovers(entries);
      const standings = [...entries]
        .sort((a, b) => standingFor(b).mmr - standingFor(a).mmr)
        .slice(0, 10)
        .map(e => {
          const st = standingFor(e);
          return {
            handle: e.handle,
            team: e.team || "",
            avatarUrl: e.avatarUrl || "",
            avatarStyle: e.avatarStyle || "",
            league: st.league,
            leagueTitle: st.leagueTitle,
            leagueColor: st.leagueColor,
            division: st.division,
            mmr: st.mmr,
            tokensAll: e.tokensAll || 0,
            tokensFormatted: formatTokens(e.tokensAll || 0)
          };
        });
      return jsonResponse({
        ok: true,
        season,
        ladder: LEAGUES,
        distribution,
        standings,
        promotions: movers.promotions,
        climbers: movers.gains,
        rewards: SEASON_REWARDS
      }, 200, { "Cache-Control": "public, max-age=15, s-maxage=30" });
    }

    // 6e. Share records & access control
    if (pathname === "/api/share/create" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const handleClean = String(body.handle || "").replace(/^@/, "").trim();
        if (!handleClean) return jsonResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);

        const googleAuth = await parseGoogleAuth(request, body, env);
        const claimToken = String(body.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, body) });
        if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);

        const scope = ["private", "people", "group", "org", "public"].includes(body.scope) ? body.scope : "group";
        const options = {
          fullTokenCounts: body.options?.fullTokenCounts !== false,
          providerBreakdown: body.options?.providerBreakdown !== false,
          anonymizeNames: body.options?.anonymizeNames === true,
          hideCost: body.options?.hideCost === true,
          includeLeagueRank: body.options?.includeLeagueRank !== false,
          allowDownload: body.options?.allowDownload !== false
        };
        const expiryDays = Math.min(365, Math.max(1, parseInt(body.expiryDays || "30", 10) || 30));
        const share = {
          id: randomId(),
          handle: entry.handle,
          ownerKey: ownerCheck.ownerKey,
          scope,
          audience: Array.isArray(body.audience) ? body.audience.slice(0, 50) : [],
          groups: Array.isArray(body.groups) ? body.groups.slice(0, 20) : [],
          options,
          publicLink: body.publicLink === true || scope === "public",
          createdAt: Date.now() / 1000,
          expiresAt: Date.now() / 1000 + expiryDays * 86400,
          revoked: false
        };
        await putJson(env, `shares/${share.id}.json`, share);
        await indexShare(env, entry.handle, share.id);
        await appendActivity(env, ownerCheck.ownerKey, {
          at: share.createdAt,
          action: "created",
          handle: entry.handle,
          shareId: share.id,
          scope,
          audience: share.audience
        });
        const origin = new URL(request.url).origin;
        return jsonResponse({ ok: true, share, url: `${origin}/s/${share.id}` });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (pathname === "/api/share/list" && request.method === "GET") {
      try {
        const handleClean = String(searchParams.get("handle") || "").replace(/^@/, "").trim();
        if (!handleClean) return jsonResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, {}, env);
        const claimToken = String(request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, {}) });
        if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);

        const shares = await listShares(env, entry.handle);
        const groups = await getGroups(env, ownerCheck.ownerKey);
        const activity = await getActivity(env, ownerCheck.ownerKey);
        const publicShares = shares.map(s => ({ ...s, ownerKey: undefined }));
        return jsonResponse({ ok: true, handle: entry.handle, shares: publicShares, groups, activity });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (pathname === "/api/share/revoke" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const handleClean = String(body.handle || "").replace(/^@/, "").trim();
        const id = String(body.id || "").trim();
        if (!handleClean || !id) return jsonResponse({ ok: false, error: "Missing handle or id" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, body, env);
        const claimToken = String(body.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, body) });
        if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);
        const share = await getJson(env, `shares/${id}.json`);
        if (!share || share.handle.toLowerCase() !== handleClean.toLowerCase()) {
          return jsonResponse({ ok: false, error: "Share not found" }, 404);
        }
        share.revoked = true;
        share.revokedAt = Date.now() / 1000;
        await putJson(env, `shares/${id}.json`, share);
        await appendActivity(env, ownerCheck.ownerKey, {
          at: share.revokedAt, action: "revoked", handle: entry.handle, shareId: id, scope: share.scope
        });
        return jsonResponse({ ok: true, share });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // Public share link payload (respects anonymize/hide-cost options).
    if (pathname.startsWith("/api/shared/") && request.method === "GET") {
      const id = pathname.slice("/api/shared/".length).replace(/[^a-zA-Z0-9]/g, "");
      const share = await getJson(env, `shares/${id}.json`);
      if (!share) return jsonResponse({ ok: false, error: "Share link not found" }, 404);
      if (share.revoked) return jsonResponse({ ok: false, error: "Share link was revoked" }, 410);
      if (share.expiresAt && share.expiresAt * 1000 < Date.now()) {
        return jsonResponse({ ok: false, error: "Share link expired" }, 410);
      }
      const entries = await getEntriesFromR2(env);
      const entry = entries.find(e => e.handle.toLowerCase() === share.handle.toLowerCase());
      if (!entry) return jsonResponse({ ok: false, error: "Profile not found" }, 404);
      return jsonResponse({ ok: true, share: { ...share, ownerKey: undefined }, report: buildSharedReport(entry, share.options, entries) });
    }

    if (pathname === "/api/groups" && request.method === "GET") {
      try {
        const handleClean = String(searchParams.get("handle") || "").replace(/^@/, "").trim();
        if (!handleClean) return jsonResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, {}, env);
        const claimToken = String(request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, {}) });
        if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);
        return jsonResponse({ ok: true, groups: await getGroups(env, ownerCheck.ownerKey) });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (pathname === "/api/groups" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const handleClean = String(body.handle || "").replace(/^@/, "").trim();
        if (!handleClean) return jsonResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, body, env);
        const claimToken = String(body.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, body) });
        if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);

        const groups = await getGroups(env, ownerCheck.ownerKey);
        const action = String(body.action || "create");
        const incoming = body.group || {};
        if (action === "delete") {
          const next = groups.filter(g => g.id !== incoming.id);
          await putJson(env, `groups/${ownerKeyFile(ownerCheck.ownerKey)}.json`, next);
          return jsonResponse({ ok: true, groups: next });
        }
        if (action === "update" && incoming.id) {
          const idx = groups.findIndex(g => g.id === incoming.id);
          if (idx === -1) return jsonResponse({ ok: false, error: "Group not found" }, 404);
          groups[idx] = normalizeGroup({ ...groups[idx], ...incoming });
        } else {
          groups.push(normalizeGroup({ ...incoming, id: incoming.id || randomId() }));
        }
        await putJson(env, `groups/${ownerKeyFile(ownerCheck.ownerKey)}.json`, groups);
        return jsonResponse({ ok: true, groups });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 6g. Profile avatars — Google photo, uploaded image, or cleared (generated)
    if (pathname === "/api/profile/avatar" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const handleClean = String(body.handle || "").replace(/^@/, "").trim();
        if (!handleClean) return jsonResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return jsonResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);

        const googleAuth = await parseGoogleAuth(request, body, env);
        const claimToken = String(body.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        const secret = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
          (request.headers.get("X-Leaderboard-Secret") || "").trim();
        const secretOk = Boolean(env.LEADERBOARD_SECRET) && secret === env.LEADERBOARD_SECRET;
        if (!secretOk) {
          const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, body) });
          if (!ownerCheck.ok) return jsonResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);
        }

        let avatarUrl = "";
        if (body.avatarStyle) {
          entry.avatarStyle = String(body.avatarStyle).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
        }
        if (body.imageDataUrl) {
          const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.imageDataUrl));
          if (!match) return jsonResponse({ ok: false, error: "Unsupported image data (png/jpeg/webp/gif only)" }, 400);
          const bytes = Uint8Array.from(atob(match[2].replace(/\s+/g, "")), ch => ch.charCodeAt(0));
          if (bytes.length > 400_000) return jsonResponse({ ok: false, error: "Image too large (max 400KB)" }, 400);
          if (env.LEADERBOARD_BUCKET) {
            await env.LEADERBOARD_BUCKET.put(`avatars/${entry.handle.toLowerCase()}`, bytes, {
              httpMetadata: { contentType: match[1], cacheControl: "public, max-age=86400" }
            });
          }
          avatarUrl = `/api/avatar/${encodeURIComponent(entry.handle)}?v=${Date.now()}`;
        } else if (body.useGooglePhoto && googleAuth && googleAuth.picture) {
          avatarUrl = googleAuth.picture;
        } else if (body.avatarUrl) {
          const candidate = String(body.avatarUrl).slice(0, 500);
          if (!/^https?:\/\//.test(candidate)) return jsonResponse({ ok: false, error: "avatarUrl must be http(s)" }, 400);
          avatarUrl = candidate;
        }

        entry.avatarUrl = avatarUrl;
        if (avatarUrl) delete entry.avatarStyle;
        entry.updatedAt = Date.now() / 1000;
        await saveEntriesToR2(env, entries);
        return jsonResponse({ ok: true, handle: entry.handle, avatarUrl: entry.avatarUrl, avatarStyle: entry.avatarStyle || "" });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (pathname.startsWith("/api/avatar/") && request.method === "GET") {
      const handleClean = decodeURIComponent(pathname.slice("/api/avatar/".length)).toLowerCase();
      if (!env.LEADERBOARD_BUCKET) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      const obj = await env.LEADERBOARD_BUCKET.get(`avatars/${handleClean}`);
      if (!obj) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      const bytes = await obj.arrayBuffer();
      const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png";
      return new Response(bytes, {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": type, "Cache-Control": "public, max-age=86400" }
      });
    }

    // 6f. GET /api/prompts — aggregated recent prompts/workloads
    if (request.method === "GET" && pathname === "/api/prompts") {
      const entries = await getEntriesFromR2(env);
      const sessions = aggregateSessions(entries).sort((a, b) => (b.at || 0) - (a.at || 0));
      return jsonResponse({
        ok: true,
        count: sessions.length,
        prompts: sessions.slice(0, 100)
      }, 200, { "Cache-Control": "public, max-age=15, s-maxage=30" });
    }

    // 7. Webhosting: Fallback to static assets binding (docs/leaderboard.html, styles.css, etc.)
    if (env.ASSETS) {
      if (pathname === "/" || pathname === "/leaderboard.html") {
        const newUrl = new URL(request.url);
        newUrl.pathname = "/leaderboard";
        return env.ASSETS.fetch(new Request(newUrl.toString(), request));
      }
      if (pathname.startsWith("/s/")) {
        const id = pathname.slice(3).replace(/[^a-zA-Z0-9]/g, "");
        const newUrl = new URL(request.url);
        newUrl.pathname = "/leaderboard";
        newUrl.searchParams.set("share", id);
        return env.ASSETS.fetch(new Request(newUrl.toString(), request));
      }
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- R2 Storage Helpers ---
async function getEntriesFromR2(env) {
  if (!env.LEADERBOARD_BUCKET) {
    return [...DEFAULT_STARTER_ENTRIES];
  }
  try {
    const obj = await env.LEADERBOARD_BUCKET.get("leaderboard.json");
    let entries;
    if (!obj) {
      // Seed starter entries on first launch (then fall through to backfill).
      entries = JSON.parse(JSON.stringify(DEFAULT_STARTER_ENTRIES));
    } else {
      const text = await obj.text();
      const data = JSON.parse(text);
      entries = Array.isArray(data) ? data : JSON.parse(JSON.stringify(DEFAULT_STARTER_ENTRIES));
    }

    let needsBackfill = !obj;
    for (const e of entries) {
      if (!e.breakdown || !Array.isArray(e.breakdown.models) || e.breakdown.models.length === 0) {
        const starterMatch = DEFAULT_STARTER_ENTRIES.find(s => s.handle.toLowerCase() === e.handle.toLowerCase());
        if (starterMatch && starterMatch.breakdown) {
          e.breakdown = starterMatch.breakdown;
        } else {
          const prov = (e.topModel || "").toLowerCase().includes("claude") ? "claude" : ((e.topModel || "").toLowerCase().includes("gpt") ? "openai" : ((e.topModel || "").toLowerCase().includes("gemini") ? "google" : "ai"));
          e.breakdown = {
            models: [
              {
                provider: prov,
                model: e.topModel || "claude-3-7-sonnet",
                tokensToday: e.tokensToday || 0,
                tokensAll: e.tokensAll || 0,
                costToday: e.costToday || 0,
                costAll: e.costAll || 0,
                sharePercent: 100.0
              }
            ],
            tools: [
              {
                tool: prov,
                tokensToday: e.tokensToday || 0,
                tokensAll: e.tokensAll || 0,
                costToday: e.costToday || 0,
                costAll: e.costAll || 0
              }
            ],
            history: [],
            activeDays: e.streakDays || 1,
            totalSessions: 1
          };
        }
        needsBackfill = true;
      }
      // Derive league/MMR for entries published before the analytics fields
      // existed (CSV imports, older clients). Efficiency is always computed
      // on read so zero-signal entries don't trigger rewrite loops.
      const st = standingFor(e);
      if (!e.league) { e.league = st.league; needsBackfill = true; }
      if (!e.division) { e.division = st.division; needsBackfill = true; }
      if (!e.mmr && (e.tokensAll || 0) > 0) { e.mmr = st.mmr; needsBackfill = true; }
    }

    if (needsBackfill) {
      await saveEntriesToR2(env, entries);
    }
    return entries;
  } catch (err) {
    console.error("R2 get error:", err);
    return [...DEFAULT_STARTER_ENTRIES];
  }
}

async function saveEntriesToR2(env, entries) {
  if (!env.LEADERBOARD_BUCKET) return;
  const jsonStr = JSON.stringify(entries, null, 2);
  await env.LEADERBOARD_BUCKET.put("leaderboard.json", jsonStr, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "no-cache"
    }
  });
}

// --- Period & KPI Calculation Helpers ---
function getPeriodScore(e, period) {
  switch (period) {
    case "today": return e.tokensToday || 0;
    case "week": return e.tokens7d || 0;
    case "all": return e.tokensAll || 0;
    case "streak": return e.streakDays || 0;
    default: return e.tokensToday || 0;
  }
}

function getPeriodCost(e, period) {
  switch (period) {
    case "today": return e.costToday || 0;
    case "week": return e.cost7d || 0;
    case "all": return e.costAll || 0;
    default: return e.costToday || 0;
  }
}

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

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=utf-8",
      ...extraHeaders
    }
  });
}

// --- Share Card Formatters ---
function generateShareSVG(entry, rank, period) {
  const handle = entry.handle;
  const hw = entry.hardware || "Apple Silicon";
  const score = formatTokens(getPeriodScore(entry, period));
  const allTokens = formatTokens(entry.tokensAll);
  const model = entry.topModel;
  const streak = `${entry.streakDays || 0}d`;
  const team = (entry.team || "Personal").toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 260" width="540" height="260" style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#090D16" />
      <stop offset="50%" stop-color="#111827" />
      <stop offset="100%" stop-color="#1A2035" />
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#6366F1" />
      <stop offset="50%" stop-color="#8B5CF6" />
      <stop offset="100%" stop-color="#EC4899" />
    </linearGradient>
    <filter id="cardShadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.6" />
    </filter>
  </defs>

  <rect x="10" y="10" width="520" height="240" rx="16" fill="url(#bgGrad)" stroke="#2E3856" stroke-width="1.2" filter="url(#cardShadow)" />
  <rect x="10" y="10" width="520" height="4" rx="2" fill="url(#accentGrad)" />

  <text x="32" y="44" fill="#38BDF8" font-size="11" font-weight="700" letter-spacing="1.5">TOKEN HORIZON</text>
  <text x="145" y="44" fill="#4B5563" font-size="11">|</text>
  <text x="156" y="44" fill="#9CA3AF" font-size="11" letter-spacing="0.5">${team}</text>

  <rect x="420" y="28" width="88" height="24" rx="12" fill="#1E293B" stroke="#334155" stroke-width="0.8" />
  <text x="464" y="44" fill="#F8FAFC" font-size="11" font-weight="700" text-anchor="middle">RANK #${rank}</text>

  <circle cx="50" cy="90" r="18" fill="#1E293B" stroke="#6366F1" stroke-width="1.5" />
  <text x="50" y="96" fill="#F8FAFC" font-size="14" font-weight="700" text-anchor="middle">@</text>

  <text x="80" y="88" fill="#FFFFFF" font-size="18" font-weight="700">${handle}</text>
  <text x="80" y="106" fill="#9CA3AF" font-size="11">${hw}</text>

  <line x1="32" y1="126" x2="508" y2="126" stroke="#1F2937" stroke-width="1" />

  <text x="32" y="152" fill="#6B7280" font-size="10" font-weight="700" letter-spacing="0.8">${period.toUpperCase()} TOKENS</text>
  <text x="32" y="180" fill="#F8FAFC" font-size="24" font-weight="800">${score}</text>

  <text x="160" y="152" fill="#6B7280" font-size="10" font-weight="700" letter-spacing="0.8">ALL-TIME</text>
  <text x="160" y="180" fill="#38BDF8" font-size="24" font-weight="800">${allTokens}</text>

  <text x="280" y="152" fill="#6B7280" font-size="10" font-weight="700" letter-spacing="0.8">ACTIVE STREAK</text>
  <text x="280" y="180" fill="#FB923C" font-size="24" font-weight="800">${streak} 🔥</text>

  <text x="400" y="152" fill="#6B7280" font-size="10" font-weight="700" letter-spacing="0.8">TOP MODEL</text>
  <text x="400" y="180" fill="#C084FC" font-size="14" font-weight="700">${model}</text>

  <line x1="32" y1="214" x2="508" y2="214" stroke="#1F2937" stroke-width="1" />
  <text x="32" y="234" fill="#4B5563" font-size="10">token-horizon · cloudflare r2 edge intelligence</text>
</svg>`;
}

function generateShareMarkdown(entry, rank, period) {
  return `### 🌌 Token Horizon Usage Card

**@${entry.handle}**
*Hardware:* ${entry.hardware || "Apple Silicon"}

| Metric | Value | Rank & Status |
| :--- | :--- | :--- |
| **Leaderboard Rank** | **#${rank}** | Period: ${period.toUpperCase()} |
| **Tokens Today** | \`${formatTokens(entry.tokensToday)}\` | ${formatCurrency(entry.costToday)} |
| **7-Day Rolling** | \`${formatTokens(entry.tokens7d)}\` | ${formatCurrency(entry.cost7d)} |
| **All-Time Tokens** | \`${formatTokens(entry.tokensAll)}\` | ${formatCurrency(entry.costAll)} |
| **Active Streak** | 🔥 ${entry.streakDays || 0} Days | Consecutive Active Days |
| **Top AI Model** | \`${entry.topModel}\` | Most utilized architecture |

*Generated by [Token Horizon](https://github.com/castlemilk/token-horizon)*`;
}

function generateShareText(entry, rank, period) {
  const handle = entry.handle;
  const hw = entry.hardware || "Apple Silicon";
  const score = formatTokens(getPeriodScore(entry, period));
  const cost = formatCurrency(getPeriodCost(entry, period));

  return `╭─────────────────────────────────────────────────────────────╮
│ 🌌 TOKEN HORIZON LEADERBOARD (CLOUDFLARE R2 EDGE)           │
│ Participant: @${handle.padEnd(46)} │
│ Hardware: ${hw.padEnd(49)} │
├─────────────────────────────────────────────────────────────┤
│ Period: ${period.toUpperCase().padEnd(14)} Rank: #${rank}
│ Tokens: ${score.padEnd(16)} Cost: ${cost.padEnd(20)} │
│ Active Streak: ${entry.streakDays || 0} Days 🔥 Top Model: ${entry.topModel}
╰─────────────────────────────────────────────────────────────╯`;
}

// --- Share records, groups, activity (R2 JSON objects) ---

function randomId() {
  const raw = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  return raw.slice(0, 16);
}

async function getJson(env, key) {
  if (!env.LEADERBOARD_BUCKET) return null;
  try {
    const obj = await env.LEADERBOARD_BUCKET.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch (err) {
    return null;
  }
}

async function putJson(env, key, value) {
  if (!env.LEADERBOARD_BUCKET) return;
  await env.LEADERBOARD_BUCKET.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-cache" }
  });
}

function ownerKeyFile(ownerKey) {
  return String(ownerKey || "unknown").replace(/[^a-zA-Z0-9:_-]/g, "_").toLowerCase();
}

async function verifyOwner(entry, googleAuth, claimToken, opts = {}) {
  if (entry.claimed) {
    if (!googleAuth) {
      // Distinguish "never signed in" from "signed in but the credential was
      // rejected/expired" so the client can re-auth instead of guessing.
      const error = opts.hadToken
        ? `Your Google session expired or was rejected — sign in again to manage @${entry.handle}.`
        : `Sign in with Google as ${entry.googleEmail || "the owner"} to manage @${entry.handle}.`;
      return { ok: false, status: 401, code: "auth_required", error };
    }
    const isOwner = entry.ownerId === `google:${googleAuth.sub}` ||
      (entry.googleEmail && entry.googleEmail === googleAuth.email);
    if (!isOwner) {
      return {
        ok: false, status: 403, code: "not_owner",
        error: `Signed in as ${googleAuth.email}, but @${entry.handle} is owned by ${entry.googleEmail || "another account"}.`
      };
    }
    return { ok: true, ownerKey: entry.ownerId || `handle:${entry.handle.toLowerCase()}` };
  }
  if (entry.claimTokenHash) {
    if (!claimToken) {
      return { ok: false, status: 401, code: "auth_required", error: "Provide the profile claim token to manage sharing." };
    }
    const hash = await sha256Hex(claimToken);
    if (hash !== entry.claimTokenHash) {
      return { ok: false, status: 403, code: "bad_claim_token", error: "Invalid claim token." };
    }
  }
  return { ok: true, ownerKey: `handle:${entry.handle.toLowerCase()}` };
}

/// True when the request carried any Google credential (even one the worker
/// may reject), used to tailor auth error messages.
function hasGoogleToken(request, body = {}) {
  return Boolean(
    request.headers.get("X-Google-Token") ||
    (request.headers.get("Authorization") || "").toLowerCase().startsWith("bearer ") ||
    body.googleToken || body.googleCredential || body.googleUser
  );
}

async function indexShare(env, handle, id) {
  const key = `shares-index/${ownerKeyFile(handle)}.json`;
  const index = (await getJson(env, key)) || [];
  if (!index.includes(id)) index.push(id);
  await putJson(env, key, index.slice(-200));
}

async function listShares(env, handle) {
  const index = (await getJson(env, `shares-index/${ownerKeyFile(handle)}.json`)) || [];
  const shares = [];
  for (const id of index) {
    const share = await getJson(env, `shares/${id}.json`);
    if (share) shares.push(share);
  }
  return shares.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function appendActivity(env, ownerKey, event) {
  const key = `activity/${ownerKeyFile(ownerKey)}.json`;
  const list = (await getJson(env, key)) || [];
  list.unshift(event);
  await putJson(env, key, list.slice(0, 50));
}

async function getActivity(env, ownerKey) {
  return (await getJson(env, `activity/${ownerKeyFile(ownerKey)}.json`)) || [];
}

function normalizeGroup(g) {
  const members = Array.isArray(g.members)
    ? g.members.slice(0, 500).map(m => typeof m === "string"
      ? { handle: m }
      : { handle: String(m.handle || ""), email: m.email ? String(m.email) : undefined, avatarUrl: m.avatarUrl || undefined }
    ).filter(m => m.handle)
    : [];
  return {
    id: g.id || randomId(),
    name: String(g.name || "Untitled group").slice(0, 80),
    members
  };
}

async function getGroups(env, ownerKey) {
  const groups = await getJson(env, `groups/${ownerKeyFile(ownerKey)}.json`);
  return Array.isArray(groups) ? groups : [];
}

function buildSharedReport(entry, options, entries) {
  const opts = options || {};
  const sortedAll = [...entries].sort((a, b) => (b.tokensAll || 0) - (a.tokensAll || 0));
  const rank = sortedAll.findIndex(e => e.handle.toLowerCase() === entry.handle.toLowerCase()) + 1;
  const total = Math.max(1, entries.length);
  const st = standingFor(entry);
  const roundTokens = (n) => opts.fullTokenCounts ? (n || 0) : Math.round((n || 0) / 1000) * 1000;
  const report = {
    handle: opts.anonymizeNames ? "Anonymous" : entry.handle,
    team: opts.anonymizeNames ? "" : (entry.team || ""),
    hardware: entry.hardware || "Apple Silicon",
    tokensAll: roundTokens(entry.tokensAll),
    tokensAllFormatted: formatTokens(roundTokens(entry.tokensAll)),
    tokens7d: roundTokens(entry.tokens7d),
    tokens7dFormatted: formatTokens(roundTokens(entry.tokens7d)),
    streakDays: entry.streakDays || 0,
    rank,
    percentile: Math.round(((total - rank + 1) / total) * 100),
    league: st.league,
    leagueTitle: st.leagueTitle,
    division: st.division,
    mmr: st.mmr,
    season: seasonFor(),
    generatedAt: new Date().toISOString()
  };
  if (!opts.hideCost) {
    report.costAll = entry.costAll || 0;
    report.costAllFormatted = formatCurrency(entry.costAll || 0);
    report.cost7d = entry.cost7d || 0;
    report.cost7dFormatted = formatCurrency(entry.cost7d || 0);
  }
  if (opts.providerBreakdown && entry.breakdown) {
    report.models = (entry.breakdown.models || []).slice(0, 12).map(m => ({
      provider: m.provider,
      model: opts.anonymizeNames ? "redacted" : m.model,
      tokensAll: roundTokens(m.tokensAll),
      costAll: opts.hideCost ? undefined : (m.costAll || 0),
      sharePercent: m.sharePercent || 0
    }));
    report.history = (entry.breakdown.history || []).map(h => ({ day: h.day, dayLabel: h.dayLabel, tokens: roundTokens(h.tokens), cost: opts.hideCost ? undefined : h.cost }));
  }
  return report;
}

function parseEntriesFromCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.length > 0 && currentRow.some(c => c !== "")) rows.push(currentRow);
      currentRow = [];
      if (char === '\r' && csvText[i + 1] === '\n') i++;
    } else currentField += char;
  }
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(c => c !== "")) rows.push(currentRow);
  }

  if (rows.length < 2) return [];
  const cleanHeader = (s) => s.toLowerCase().replace(/[\s_\-]/g, "");
  const headers = rows[0].map(cleanHeader);

  const colIdx = (aliases) => {
    for (const a of aliases) {
      const idx = headers.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const handleIdx = colIdx(["handle", "participant", "user", "username", "name"]);
  const teamIdx = colIdx(["team", "org", "organization"]);
  const todayIdx = colIdx(["tokenstoday", "today", "todaytokens"]);
  const weekIdx = colIdx(["tokens7d", "7d", "week", "tokensweek"]);
  const allIdx = colIdx(["tokensalltime", "tokensall", "alltime", "all", "total"]);
  const costTodayIdx = colIdx(["costtoday", "cost"]);
  const cost7dIdx = colIdx(["cost7d", "costweek"]);
  const costAllIdx = colIdx(["costalltime", "costall", "costtotal"]);
  const streakIdx = colIdx(["streak", "streakdays"]);
  const modelIdx = colIdx(["topmodel", "model", "llm"]);
  const hwIdx = colIdx(["hardware", "hw", "chip"]);

  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawHandle = handleIdx !== -1 && row[handleIdx] ? row[handleIdx] : row[0];
    if (!rawHandle) continue;
    const handle = String(rawHandle).replace(/^@/, "").trim();
    if (!handle) continue;

    const parseNum = (idx) => {
      if (idx === -1 || !row[idx]) return 0;
      const clean = String(row[idx]).replace(/[,$]/g, "");
      return Number(clean) || 0;
    };

    entries.push({
      id: "cf:" + handle.toLowerCase(),
      handle,
      team: teamIdx !== -1 && row[teamIdx] ? String(row[teamIdx]).trim() : "",
      tokensToday: parseNum(todayIdx),
      tokens7d: parseNum(weekIdx),
      tokensAll: parseNum(allIdx),
      costToday: parseNum(costTodayIdx),
      cost7d: parseNum(cost7dIdx),
      costAll: parseNum(costAllIdx),
      streakDays: parseNum(streakIdx),
      topModel: modelIdx !== -1 && row[modelIdx] ? String(row[modelIdx]).trim() : "claude-3-7-sonnet",
      hardware: hwIdx !== -1 && row[hwIdx] ? String(row[hwIdx]).trim() : "Apple Silicon",
      isLocal: false,
      updatedAt: Date.now() / 1000
    });
  }
  return entries;
}
