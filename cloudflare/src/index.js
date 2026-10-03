/**
 * Token Horizon — Cloudflare Edge Webhosting & R2 Leaderboard Backend
 *
 * Provides sub-20ms edge responses globally, direct R2 bucket persistence,
 * dynamic SVG badge generation for READMEs, dynamic PNG OG share cards
 * (resvg-wasm), and static asset webhosting.
 */

import { handleTeamRequest, applyTeamMemberships, getPublicTeam, getInviteTeam, enrichTeamAggregates, loadTeamLogoDataUri } from './team-invites.js';
import { handleBrowserAuth, browserIdentity, identityOwnerId, identityOwns, githubConfigured, sessionsConfigured } from './browser-auth.js';
import { handleDesktopAuth, desktopPublishIdentity, DesktopAuthError } from './desktop-auth.js';
import { buildOgModel, renderProfileOgSvg, renderRestrictedOgSvg, OG_CARD_VERSION } from './og-card.js';
import { loadOgAvatar } from './og-avatar.js';
import { renderTeamOgSvg, TEAM_OG_VERSION } from './og-team.js';
import { boundedText } from './request-body.js';
import { injectPageMetadata, routePageMetadata, SITE_ORIGIN, PRIVATE_ROBOTS } from './page-metadata.js';

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Leaderboard-Secret, X-Claim-Token, X-Google-Token",
};

// --- League ladder (mirrors Sources/TokenHorizon/Leaderboard/LeaderboardAnalytics.swift) ---
const SEASON_REWARDS = [
  { icon: "shield", title: "Your league shield", detail: "Your published profile and share preview carry your league." },
  { icon: "activity", title: "A history of progress", detail: "Usage heatmaps and ranking snapshots show how your activity develops." },
  { icon: "users", title: "Your team, together", detail: "Published team usage contributes to community team standings." }
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
  delete copy.accountEmail;
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
    const avgCostPerM = r.tokens > 0 ? r.cost / (r.tokens / 1000000) : 0;
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
      // Adaptive precision (~3 significant digits): tiny rates must not
      // collapse to "$0.00" like fixed toFixed(2)/toFixed(4) does.
      avgCostPerMText: avgCostPerM <= 0 ? "$0" : avgCostPerM >= 0.01 ? "$" + avgCostPerM.toPrecision(3) : "$" + avgCostPerM.toPrecision(2)
    };
  }).sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  for (const r of rows) r.sharePercent = total > 0 ? Math.round((r.tokens / total) * 1000) / 10 : 0;
  return { rows, total };
}

/// Per-model adoption rollup for the catalog explorer: tokens/cost/requests
/// and distinct publisher count, ranked by tokens. Provider ids are
/// normalized so `claude`/`anthropic` merge the same way analytics does.
function aggregateModelUsage(entries, limit = 400) {
  const map = new Map();
  for (const e of entries) {
    const models = (e.breakdown && e.breakdown.models) || [];
    for (const m of models) {
      const provider = normalizeProvider(m.provider);
      const model = String(m.model || "unknown");
      const key = `${provider}|${model.toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, { provider, model, tokens: 0, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, users: new Set() });
      }
      const row = map.get(key);
      row.tokens += Number(m.tokensAll) || Number(m.tokensToday) || 0;
      row.cost += Number(m.costAll) || Number(m.costToday) || 0;
      row.requests += Number(m.requests) || 0;
      row.inputTokens += Number(m.inputTokens) || 0;
      row.outputTokens += Number(m.outputTokens) || 0;
      row.users.add(e.handle);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  return rows.slice(0, limit).map(r => ({
    provider: r.provider,
    model: r.model,
    tokens: r.tokens,
    cost: r.cost,
    requests: r.requests,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    users: r.users.size,
    sharePercent: total > 0 ? Math.round((r.tokens / total) * 1000) / 10 : 0,
    tokensFormatted: formatTokens(r.tokens),
    costFormatted: formatCurrency(r.cost)
  }));
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
    const key = e.teamId ? `id:${e.teamId}` : `legacy:${team}`;
    if (!map.has(key)) map.set(key, { team, ...(e.teamId ? { teamId: e.teamId } : {}), tokens: 0, cost: 0, members: 0, providers: {}, users: [] });
    const row = map.get(key);
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

function teamUsageStats(team, entries) {
  const peers = entries.filter(entry => entry.teamId === team.id);
  const row = aggregateTeams(peers)[0] || { team: team.name, teamId: team.id, tokens: 0, cost: 0, members: 0, providers: {}, users: [], tokensFormatted: '0', costFormatted: '$0' };
  const daily = new Map();
  const start = dayNumber() - 118, end = dayNumber();
  for (const entry of peers) {
    for (const point of entry.breakdown?.daily || []) {
      const day = Math.floor((Number(point.day) || 0) / 86400);
      const tokens = Number(point.tokens);
      if (day >= start && day <= end && Number.isFinite(tokens) && tokens > 0) daily.set(day, (daily.get(day) || 0) + tokens);
    }
  }
  return {
    ...row, publishedProfiles: row.members, memberCount: team.memberCount,
    tokensToday: peers.reduce((total, entry) => total + (Number(entry.tokensToday) || 0), 0),
    tokens7d: peers.reduce((total, entry) => total + (Number(entry.tokens7d) || 0), 0),
    daily: [...daily.entries()].sort((a, b) => a[0] - b[0]).map(([day, tokens]) => ({ day: day * 86400, tokens })),
    providerHistory: providerHistory(peers, 30)
  };
}

async function getTeamPublicData(env, id) {
  const team = await getPublicTeam(env, id);
  if (!team) return null;
  const entries = await getEntriesFromR2(env);
  return { team, stats: teamUsageStats(team, entries) };
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
  const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true }, signal: AbortSignal.timeout(8000), redirect: 'manual' });
  if (!res.ok) throw new Error("Google JWKS fetch failed: HTTP " + res.status);
  const data = JSON.parse(await boundedText(res, 65536, { timeoutMs: 8000 }));
  googleJwksCache = { fetchedAt: now, keys: data.keys || [] };
  return googleJwksCache.keys;
}

export async function verifyGoogleIdToken(token, env, nonce) {
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
  if (payload.email_verified !== true) return null;
  // Connector consent is bound to this browser transaction, not a reusable login.
  if (nonce !== undefined && (!env.GOOGLE_CLIENT_ID || payload.email_verified !== true || payload.nonce !== nonce)) return null;

  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.given_name || ""),
    picture: String(payload.picture || ""),
    verified: true
  };
}

// Kept as the compatibility seam for native Google-token clients; browser
// sessions can represent either supported provider.
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
  if (!token) {
    const identity = await browserIdentity(request, env);
    if (identity) return identity;
  }

  if (env.GOOGLE_CLIENT_ID || githubConfigured(env)) {
    // Production: only cryptographically verified ID tokens are accepted.
    if (env.GOOGLE_CLIENT_ID && token && token.split(".").length === 3) {
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

    const authResponse = await handleBrowserAuth(request, env, { verifyGoogleIdToken });
    if (authResponse) return authResponse;
    const desktopResponse = await handleDesktopAuth(request, env, ctx);
    if (desktopResponse) return desktopResponse;

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
        githubAuth: githubConfigured(env),
        webSessions: sessionsConfigured(env),
        canonicalUrl: `https://${url.hostname}`,
        season: seasonFor()
      }, 200, { "Cache-Control": "public, max-age=300, s-maxage=600" });
    }

    const teamResponse = await handleTeamRequest(request, env, { parseGoogleAuth, jsonResponse,
      getTeamStats: async team => teamUsageStats(team, await getEntriesFromR2(env)) });
    if (teamResponse) return teamResponse;

    // Account discovery must use verified ownership, never leaderboard rank
    // or a matching public email address to choose the viewer's workspace.
    if (request.method === "GET" && pathname === "/api/account/profiles") {
      const headers = { "Cache-Control": "private, no-store" };
      try {
        const googleAuth = await parseGoogleAuth(request, {}, env);
        if (!googleAuth) {
          return jsonResponse({
            ok: false,
            code: "auth_required",
            error: hasGoogleToken(request, {})
              ? "Your sign-in session expired or was rejected — sign in again."
              : "Sign in to view your profiles."
          }, 401, headers);
        }
        const entries = await getAccountProfileEntriesFromR2(env);
        const profiles = entries
          .filter(entry => entry.claimed === true && identityOwns(entry, googleAuth))
          .map(entry => ({ handle: entry.handle, displayName: String(entry.displayName || entry.handle) }))
          .sort((a, b) => a.handle.localeCompare(b.handle));
        return jsonResponse({ profiles }, 200, headers);
      } catch (_) {
        return jsonResponse({ ok: false, error: "Could not load your profiles. Try again." }, 503, headers);
      }
    }

    // 3. GET /api/leaderboard (or the legacy /leaderboard JSON endpoint).
    // A browser reload of a period deep link must still render the page.
    const accepts = request.headers.get("accept") || "";
    const isGetLeaderboard = request.method === "GET" && (
      pathname === "/api/leaderboard" ||
      (pathname === "/leaderboard" && (accepts.includes("json") ||
        (!accepts.includes("text/html") && (searchParams.has("period") || searchParams.has("format")))))
    );
    if (isGetLeaderboard) {
      const period = searchParams.get("period") || "today";
      const teamFilter = searchParams.get("team") || "";
      const leagueFilter = (searchParams.get("league") || "").toLowerCase();
      const full = searchParams.get("full") === "1";

      const entries = await getEntriesFromR2(env);
      let filtered = entries;

      if (teamFilter) {
        filtered = filtered.filter(e => e.teamId
          ? e.teamId === teamFilter
          : e.team && e.team.toLowerCase().includes(teamFilter.toLowerCase()));
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
        "Cache-Control": "public, max-age=5, s-maxage=5, stale-while-revalidate=10",
        ...(pathname === "/leaderboard" ? { "Vary": "Accept" } : {})
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
          .filter(e => entry.teamId ? e.teamId === entry.teamId : !e.teamId && (e.team || "").toLowerCase() === entry.team.toLowerCase())
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

    // 4. POST /api/leaderboard (or POST /leaderboard) — Upsert usage stats.
    if (request.method === "POST" && (pathname === "/api/leaderboard" || pathname === "/leaderboard")) {
      try {
        const body = await request.json();
        const incoming = body.entry || body;
        const desktopAuth = await desktopPublishIdentity(request, env, incoming.handle);
        // A verified identity may publish its own profile. The deployment's
        // write credential is a separate authority and must actually be sent.
        const googleAuth = desktopAuth?.identity || await parseGoogleAuth(request, body, env);
        const authHeader = request.headers.get("Authorization") || "";
        const customHeader = request.headers.get("X-Leaderboard-Secret") || "";
        const writeToken = customHeader.trim() || authHeader.replace(/^Bearer\s+/i, "").trim();
        const hasWriteSecret = Boolean(env.LEADERBOARD_SECRET && writeToken === env.LEADERBOARD_SECRET);
        if (env.LEADERBOARD_SECRET && !googleAuth && !hasWriteSecret) {
          return jsonResponse({ ok: false, error: "Unauthorized: invalid write token or sign-in required" }, 401);
        }

        if (!incoming.handle) {
          return jsonResponse({ ok: false, error: "Missing handle in payload" }, 400);
        }

        const handleClean = desktopAuth?.handle || String(incoming.handle).replace(/^@/, "").trim();
        const incomingClaimToken = String(incoming.claimToken || request.headers.get("X-Claim-Token") || "").trim();
        // Scoped native grants must recheck current ownership against real
        // records. A transient read failure cannot substitute starter data.
        const entries = desktopAuth
          ? await getAccountProfileEntriesFromR2(env).catch(() => {
            throw new DesktopAuthError(503, "auth_unavailable", "Could not verify current profile ownership. Try Sync again.");
          })
          : await getRawEntriesFromR2(env);

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
            const isOwner = identityOwns(prev, googleAuth, { legacyEmail: !desktopAuth });
            if (!isOwner && !hasWriteSecret) {
              return jsonResponse({
                ok: false,
                error: `Profile @${handleClean} is claimed by a verified account. Sign in as the owner to publish updates.`
              }, 403);
            }
            newEntry.claimed = true;
            newEntry.ownerId = prev.ownerId;
            newEntry.googleEmail = prev.googleEmail;
            if (prev.accountEmail) newEntry.accountEmail = prev.accountEmail;
            newEntry.avatarUrl = (googleAuth && googleAuth.picture) || prev.avatarUrl || "";
            newEntry.claimedAt = prev.claimedAt;
          } else {
            // Profile is currently unclaimed
            if (desktopAuth && (!prev.claimTokenHash || prev.claimTokenHash !== desktopAuth.claimTokenHash)) {
              return jsonResponse({ ok: false, code: "claim_required", error: `Reconnect from the app that created @${handleClean}, or choose a new handle.` }, 403);
            }
            if (googleAuth) {
              // Publishing with a verified account claims this profile.
              newEntry.claimed = true;
              newEntry.ownerId = identityOwnerId(googleAuth);
              if (googleAuth.provider === 'github') newEntry.accountEmail = googleAuth.email;
              else newEntry.googleEmail = googleAuth.email;
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
            newEntry.ownerId = identityOwnerId(googleAuth);
            if (googleAuth.provider === 'github') newEntry.accountEmail = googleAuth.email;
            else newEntry.googleEmail = googleAuth.email;
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

        // Account membership wins over old clients' local team labels. It is
        // read fresh on writes; public metadata caching never decides ownership.
        await applyTeamMemberships(env, [newEntry], { fresh: true });

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
        if (err instanceof DesktopAuthError) return jsonResponse({ ok: false, code: err.code, error: err.message }, err.status);
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
          return jsonResponse({ ok: false, error: "Sign in is required to claim a profile" }, 401);
        }

        const entries = await getRawEntriesFromR2(env);
        const idx = entries.findIndex(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (idx === -1) {
          return jsonResponse({ ok: false, error: `Profile @${handleClean} not found to claim` }, 404);
        }

        const entry = entries[idx];
        if (entry.claimed) {
          if (identityOwns(entry, googleAuth, { legacyEmail: true })) {
            await applyTeamMemberships(env, [entry], { fresh: true });
            return jsonResponse({ ok: true, message: `Profile @${handleClean} is already claimed by your account`, entry: sanitizeEntry(entry, true) });
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
        entry.ownerId = identityOwnerId(googleAuth);
        if (googleAuth.provider === 'github') entry.accountEmail = googleAuth.email;
        else entry.googleEmail = googleAuth.email;
        if (googleAuth.picture) entry.avatarUrl = googleAuth.picture;
        entry.claimedAt = Date.now() / 1000;
        await applyTeamMemberships(env, [entry], { fresh: true });
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
      const teams = await enrichTeamAggregates(env, aggregateTeams(entries));
      const movers = computeMovers(entries);
      const efficient = [...rows].filter(r => r.tokens > 0 && r.cost > 0)
        .sort((a, b) => a.avgCostPerM - b.avgCostPerM);
      // Prompt history is never public outside the individual profile: the
      // aggregated top-prompts surface only exists when the deployment is
      // explicitly opted in via PROMPTS_PUBLIC=1.
      const topPrompts = env.PROMPTS_PUBLIC ? aggregateSessions(entries)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 8) : [];
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
      return jsonResponse({ ok: true, teams: await enrichTeamAggregates(env, aggregateTeams(entries)), total: entries.length }, 200, { 'Cache-Control': 'public, max-age=15, s-maxage=30' });
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
      const privateResponse = (data, status = 200) => jsonResponse(data, status, { "Cache-Control": "private, no-store" });
      try {
        const handleClean = String(searchParams.get("handle") || "").replace(/^@/, "").trim();
        if (!handleClean) return privateResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return privateResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, {}, env);
        const claimToken = String(request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, {}) });
        if (!ownerCheck.ok) return privateResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);

        const shares = await listShares(env, entry.handle);
        const groups = await getGroups(env, ownerCheck.ownerKey);
        const activity = await getActivity(env, ownerCheck.ownerKey);
        const publicShares = shares.map(s => ({ ...s, ownerKey: undefined }));
        return privateResponse({ ok: true, handle: entry.handle, shares: publicShares, groups, activity });
      } catch (err) {
        return privateResponse({ ok: false, error: err.message }, 500);
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

    // Restricted reports require verified ownership or an explicitly named
    // audience. A public-link capability deliberately makes the report public.
    if (pathname.startsWith("/api/shared/") && request.method === "GET") {
      const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
      const id = pathname.slice("/api/shared/".length).replace(/[^a-zA-Z0-9]/g, "");
      const share = await getJson(env, `shares/${id}.json`);
      if (!share) return jsonResponse({ ok: false, error: "Share link not found" }, 404, privateHeaders);
      if (share.revoked) return jsonResponse({ ok: false, error: "Share link was revoked" }, 410, privateHeaders);
      if (share.expiresAt && share.expiresAt * 1000 <= Date.now()) {
        return jsonResponse({ ok: false, error: "Share link expired" }, 410, privateHeaders);
      }
      const entries = await getEntriesFromR2(env);
      const entry = entries.find(e => e.handle.toLowerCase() === String(share.handle || "").toLowerCase());
      if (!entry) return jsonResponse({ ok: false, error: "Profile not found" }, 404, privateHeaders);
      const access = await canReadSharedReport(env, request, share, entry, entries).catch(() => ({ ok: false, status: 503, code: "share_access_unavailable", error: "Report access could not be verified. Try again shortly." }));
      if (!access.ok) return jsonResponse({ ok: false, code: access.code, error: access.error }, access.status, privateHeaders);
      return jsonResponse({ ok: true, share: recipientShareMetadata(share), report: buildSharedReport(entry, share.options, entries) }, 200, privateHeaders);
    }

    if (pathname === "/api/groups" && request.method === "GET") {
      const privateResponse = (data, status = 200) => jsonResponse(data, status, { "Cache-Control": "private, no-store" });
      try {
        const handleClean = String(searchParams.get("handle") || "").replace(/^@/, "").trim();
        if (!handleClean) return privateResponse({ ok: false, error: "Missing handle" }, 400);
        const entries = await getEntriesFromR2(env);
        const entry = entries.find(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        if (!entry) return privateResponse({ ok: false, error: `Profile @${handleClean} not found` }, 404);
        const googleAuth = await parseGoogleAuth(request, {}, env);
        const claimToken = String(request.headers.get("X-Claim-Token") || "").trim();
        const ownerCheck = await verifyOwner(entry, googleAuth, claimToken, { hadToken: hasGoogleToken(request, {}) });
        if (!ownerCheck.ok) return privateResponse({ ok: false, code: ownerCheck.code || "", error: ownerCheck.error }, ownerCheck.status);
        return privateResponse({ ok: true, groups: await getGroups(env, ownerCheck.ownerKey) });
      } catch (err) {
        return privateResponse({ ok: false, error: err.message }, 500);
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

    // 6f. GET /api/prompts — aggregated recent prompts/workloads.
    // Prompt history lives in the individual profile only; it is never public
    // unless the deployment is explicitly opted in via PROMPTS_PUBLIC=1.
    if (request.method === "GET" && pathname === "/api/prompts") {
      if (!env.PROMPTS_PUBLIC) {
        return jsonResponse({ ok: false, error: "Prompt history is private on this deployment" }, 404);
      }
      const entries = await getEntriesFromR2(env);
      const sessions = aggregateSessions(entries).sort((a, b) => (b.at || 0) - (a.at || 0));
      return jsonResponse({
        ok: true,
        count: sessions.length,
        prompts: sessions.slice(0, 100)
      }, 200, { "Cache-Control": "public, max-age=15, s-maxage=30" });
    }

    // 6c. Model catalog: the static artifact the Mac app exports
    // (`scripts/refresh-models.sh` → docs/data/models.json). Served through
    // the worker with CORS so static mirrors (GitHub Pages) and the MCP shim
    // read the same list; edge-cached since the file only changes on refresh.
    if (request.method === "GET" && pathname === "/api/models/catalog") {
      if (env.ASSETS) {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = "/data/models.json";
        const conditionalHeaders = new Headers();
        for (const name of ["If-None-Match", "If-Modified-Since"]) {
          if (request.headers.has(name)) conditionalHeaders.set(name, request.headers.get(name));
        }
        const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { headers: conditionalHeaders }));
        if (asset.ok || asset.status === 304) {
          // Keep the asset validators so a stale browser cache can revalidate
          // without downloading the entire catalog again.
          const headers = new Headers(asset.headers);
          for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
          headers.set("Content-Type", "application/json;charset=utf-8");
          headers.set("X-Robots-Tag", "noindex");
          headers.set("Cache-Control", "public, max-age=300, s-maxage=3600");
          return new Response(asset.status === 304 ? null : asset.body, {
            status: asset.status,
            headers
          });
        }
      }
      return jsonResponse({ ok: false, error: "Model catalog not published" }, 503);
    }

    // 6d. Community model adoption: aggregate per-model totals across every
    // published profile so the explorer can show which models people run.
    if (request.method === "GET" && pathname === "/api/models/usage") {
      const entries = await getRawEntriesFromR2(env);
      const models = aggregateModelUsage(entries);
      return jsonResponse({ ok: true, count: models.length, models }, 200, {
        "Cache-Control": "public, max-age=30, s-maxage=60"
      });
    }

    // Dynamic raster cards and their SVG source share the same published
    // model. HEAD computes metadata without allocating a rasterizer.
    const teamOgMatch = pathname.match(/^\/api\/og\/team\/([a-f0-9]{32})\.(png|svg)$/);
    if (['GET', 'HEAD'].includes(request.method) && teamOgMatch) {
      let data;
      try { data = await getTeamPublicData(env, teamOgMatch[1]); }
      catch { return new Response(request.method === 'HEAD' ? null : 'Team preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
      if (!data) return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const { team, stats } = data;
      const wantsSvg = teamOgMatch[2] === 'svg' || searchParams.get('format') === 'svg';
      let svg = renderTeamOgSvg(team, stats);
      const fingerprint = await teamOgFingerprint(team, stats, svg);
      const headers = {
        ...CORS_HEADERS, 'Content-Type': wantsSvg ? 'image/svg+xml;charset=utf-8' : 'image/png',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'ETag': `"og-team-${wantsSvg ? 'svg' : 'png'}-${fingerprint}"`,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      };
      if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
      if (request.method === 'HEAD') return new Response(null, { headers });
      const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
      const cacheKey = edgeCache ? new Request(`${url.origin}/api/og/team/${team.id}.${wantsSvg ? 'svg' : 'png'}?v=${fingerprint}`) : null;
      if (edgeCache) {
        try { const hit = await edgeCache.match(cacheKey); if (hit) return new Response(hit.body, { headers }); }
        catch { /* A cache outage must not hide real team totals. */ }
      }
      const logoDataUri = await loadTeamLogoDataUri(team, env);
      if (logoDataUri) svg = renderTeamOgSvg(team, stats, { logoDataUri });
      let body = svg, unavailableLogo = Boolean(team.logoUrl && !logoDataUri);
      if (!wantsSvg) {
        try { body = await renderOgPng(svg); }
        catch (error) {
          if (!logoDataUri) throw error;
          body = await renderOgPng(renderTeamOgSvg(team, stats));
          unavailableLogo = true;
        }
      }
      if (unavailableLogo) { headers['Cache-Control'] = 'public, max-age=15, s-maxage=15'; delete headers.ETag; }
      const response = new Response(body, { headers });
      if (edgeCache && !unavailableLogo) {
        const write = edgeCache.put(cacheKey, response.clone()).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
      }
      return response;
    }
    if (["GET", "HEAD"].includes(request.method) && pathname.startsWith("/api/og/")) {
      const rest = safeDecode(pathname.slice("/api/og/".length));
      const stripExt = s => s.replace(/\.(png|svg)$/i, "");
      const wantsSvg = /\.svg$/i.test(rest) || searchParams.get("format") === "svg";
      const shared = rest.startsWith("share/");
      const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
      let svg, model;
      if (shared) {
        const id = stripExt(rest.slice(6)).replace(/[^a-zA-Z0-9]/g, "");
        const share = await getJson(env, `shares/${id}.json`);
        if (!share || share.revoked || (share.expiresAt && share.expiresAt * 1000 <= Date.now())) {
          return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: privateHeaders });
        }
        if (!isPublicShare(share)) {
          // Even an authenticated owner receives the same private preview:
          // crawlers cannot carry credentials, and their caches are public.
          svg = renderRestrictedOgSvg();
        } else {
          const entries = await getEntriesFromR2(env);
          const entry = entries.find(e => e.handle.toLowerCase() === String(share.handle || "").toLowerCase());
          if (!entry) return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: privateHeaders });
          model = ogCardModel(entry, entries, shareOgOptions(share));
          svg = generateOgSvg(model);
        }
      } else {
        const entries = await getEntriesFromR2(env);
        const handle = stripExt(rest.replace(/^profile\//, "")).replace(/^@/, "").trim().toLowerCase();
        const entry = handle && entries.find(e => e.handle.toLowerCase() === handle);
        if (!entry) return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
        model = ogCardModel(entry, entries);
        svg = generateOgSvg(model);
      }
      const photoRevision = ogAvatarRevision(model);
      const fingerprint = await ogFingerprint(svg, model, photoRevision);
      const headers = {
        ...CORS_HEADERS,
        "Content-Type": wantsSvg ? "image/svg+xml;charset=utf-8" : "image/png",
        "Cache-Control": shared ? "private, no-store" : "public, max-age=300, s-maxage=300",
        "ETag": `"og-${wantsSvg ? "svg" : "png"}-${fingerprint}"`,
        "X-Content-Type-Options": "nosniff",
        ...(shared ? { "Referrer-Policy": "no-referrer", "X-Robots-Tag": PRIVATE_ROBOTS } : {})
      };
      if (!shared && request.headers.get("If-None-Match") === headers.ETag) return new Response(null, { status: 304, headers });
      if (request.method === "HEAD") return new Response(null, { headers });
      // Resolve the current model before looking up the content-addressed edge
      // image. A newly published card gets a new key immediately; generic or
      // older ?v= links cannot pin a stale image beyond the five-minute TTL.
      const edgeCache = !shared && typeof caches !== "undefined" ? caches.default : null;
      const cacheKey = edgeCache ? new Request(`${url.origin}/api/og/profile/${encodeURIComponent(model.handle)}.${wantsSvg ? "svg" : "png"}?v=${fingerprint}`) : null;
      if (edgeCache) {
        try {
          const cached = await edgeCache.match(cacheKey);
          if (cached) return new Response(cached.body, { headers });
        } catch (_) { /* A cache outage must not hide published cards. */ }
      }
      // Page metadata, HEAD, validators and warm images never wait for a photo.
      // The published avatar URL/version participates in the model fingerprint;
      // resolve its bytes only when generating a new image, then embed them.
      const avatarDataUri = model ? await loadOgAvatar(model, env, { anonymize: model.anonymize, cacheRevision: photoRevision }) : "";
      if (avatarDataUri) svg = renderProfileOgSvg(model, { avatarDataUri });
      let unavailablePhoto = Boolean(model?.avatarUrl && !avatarDataUri);
      let body = svg;
      if (!wantsSvg) {
        try { body = await renderOgPng(svg); }
        catch (error) {
          if (!avatarDataUri) throw error;
          // Invalid compressed photo data must not take the usage card down.
          body = await renderOgPng(generateOgSvg(model));
          unavailablePhoto = true;
        }
      }
      if (unavailablePhoto) {
        // A failed optional photo must not pin a blank portrait in edge caches.
        headers["Cache-Control"] = shared ? "private, no-store" : "public, max-age=15, s-maxage=15";
        delete headers.ETag;
      }
      const image = new Response(body, { headers });
      if (edgeCache && !unavailablePhoto) {
        const write = edgeCache.put(cacheKey, image.clone()).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(write);
        else await write;
      }
      return image;
    }

    // Canonicalize the model explorer: /leaderboard?view=models → /models
    // (the flat catalog route). The Providers analytics tab only exists in the
    // dashboard shell, so tab=providers keeps the leaderboard URL. Internal
    // asset fetches below bypass routing, so this never loops through the
    // /models rewrite.
    const modelsTab = searchParams.get("tab");
    if ((pathname === "/leaderboard" || pathname === "/leaderboard.html")
        && searchParams.get("view") === "models"
        && !["providers", "plans", "cheapest"].includes(modelsTab)) {
      const canonical = new URL(request.url);
      canonical.pathname = "/models";
      canonical.searchParams.delete("view");
      canonical.searchParams.delete("flat");
      return Response.redirect(canonical.toString(), 302);
    }
    // Trailing slash would make the SPA's relative asset paths resolve under
    // /models/ (vendor/data/brand 404s) — canonicalize to the bare route.
    if (pathname === "/models/") {
      const canonical = new URL(request.url);
      canonical.pathname = "/models";
      return Response.redirect(canonical.toString(), 301);
    }

    // 7. Webhosting: Fallback to static assets binding (docs/leaderboard.html, styles.css, etc.)
    if (env.ASSETS) {
      const teamPageMatch = pathname.match(/^\/t\/([^/]+)\/?$/);
      if (teamPageMatch) return serveTeamPage(env, request, safeDecode(teamPageMatch[1]));
      const invitePageMatch = pathname.match(/^\/(?:invite|join)\/([^/]+)\/?$/);
      if (invitePageMatch) {
        if (pathname.startsWith('/join/')) {
          const canonical = new URL(request.url); canonical.pathname = `/invite/${invitePageMatch[1]}`;
          return new Response(null, { status: 302, headers: { Location: canonical.href, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': PRIVATE_ROBOTS } });
        }
        return serveTeamInvitePage(env, request, safeDecode(invitePageMatch[1]));
      }
      // Clean profile permalink: /u/<handle> serves the SPA with per-profile
      // OG/Twitter meta + a dynamic PNG card injected into <head>. The SPA
      // parses the path itself (init/popstate) — no query rewrite needed.
      const profileMatch = pathname.match(/^\/u\/([^\/?#]+)\/?$/);
      if (profileMatch) {
        if (!isProfileDocumentQuery(searchParams)) return serveRoutePage(env, request, new URL('/leaderboard', request.url));
        return serveProfilePage(env, request, safeDecode(profileMatch[1]));
      }
      if (pathname === "/" || pathname === "/leaderboard.html") {
        // Legacy deep links (?user=<handle>) get the same unfurl treatment.
        const legacyUser = searchParams.get("user");
        if (legacyUser && isProfileDocumentQuery(searchParams)) return serveProfilePage(env, request, legacyUser);
        // The public root introduces the product. Existing dashboard query
        // links still open the SPA, including sign-in and shared reports.
        const dashboardLink = ["view", "tab", "share", "invite", "signin", "period", "model", "provider", "plan", "flat"]
          .some(key => searchParams.has(key));
        if (pathname === "/" && !dashboardLink) return env.ASSETS.fetch(request);
        const newUrl = new URL(request.url);
        newUrl.pathname = "/leaderboard";
        return serveRoutePage(env, request, newUrl);
      }
      if (pathname === "/leaderboard" && searchParams.get("user") && isProfileDocumentQuery(searchParams)) {
        return serveProfilePage(env, request, searchParams.get("user"));
      }
      if (pathname.startsWith("/s/")) {
        const id = pathname.slice(3).replace(/[^a-zA-Z0-9]/g, "");
        return serveSharePage(env, request, id);
      }
      // Dedicated discovery route: token-horizon.dev/models renders the flat
      // catalog explorer (same SPA shell, deep-linkable).
      if (pathname === "/models" || pathname === "/models/") {
        const newUrl = new URL(request.url);
        newUrl.pathname = "/leaderboard";
        newUrl.searchParams.set("view", "models");
        return serveRoutePage(env, request, newUrl);
      }
      if (pathname === "/login" || pathname === "/login/") {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
        if (pathname === "/login/") {
          const canonical = new URL(request.url); canonical.pathname = '/login';
          return new Response(null, { status: 301, headers: { Location: canonical.href, 'Cache-Control': 'public, max-age=300, s-maxage=600' } });
        }
        const assetUrl = new URL('/leaderboard', request.url);
        // The cached document is the anonymous shell; identity is only read
        // through /api/auth/session, whose response is always private/no-store.
        return serveRoutePage(env, request, assetUrl, 'public, max-age=300, s-maxage=600');
      }
      if (pathname === '/leaderboard') return serveRoutePage(env, request, url);
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- R2 Storage Helpers ---
async function getAccountProfileEntriesFromR2(env) {
  if (!env.LEADERBOARD_BUCKET) throw new Error('Profile storage is unavailable');
  const obj = await env.LEADERBOARD_BUCKET.get('leaderboard.json');
  if (!obj) return [];
  const entries = JSON.parse(await obj.text());
  if (!Array.isArray(entries)) throw new Error('Profile storage is invalid');
  return entries;
}

async function getEntriesFromR2(env) {
  const entries = await getRawEntriesFromR2(env);
  return await applyTeamMemberships(env, entries);
}

// Backfills persist the original exported entry data before membership is
// overlaid. Joining a team never rewrites this shared usage-statistics object.
async function getRawEntriesFromR2(env) {
  if (!env.LEADERBOARD_BUCKET) {
    return JSON.parse(JSON.stringify(DEFAULT_STARTER_ENTRIES));
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
    return JSON.parse(JSON.stringify(DEFAULT_STARTER_ENTRIES));
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
      "X-Robots-Tag": "noindex",
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
        ? `Your sign-in session expired or was rejected — sign in again to manage @${entry.handle}.`
        : `Sign in as the owner to manage @${entry.handle}.`;
      return { ok: false, status: 401, code: "auth_required", error };
    }
    const isOwner = identityOwns(entry, googleAuth, { legacyEmail: true });
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
    body.googleToken || body.googleCredential || body.googleUser ||
    (request.headers.get("Cookie") || "").includes("__Host-th-session=")
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

function isPublicShare(share) { return share.publicLink === true || share.scope === "public"; }

function shareOgOptions(share) {
  const options = share.options || {};
  return {
    anonymize: options.anonymizeNames === true,
    hideCost: options.hideCost === true,
    providerBreakdown: options.providerBreakdown !== false,
    includeLeagueRank: options.includeLeagueRank !== false,
    fullTokenCounts: options.fullTokenCounts !== false
  };
}

// A recipient needs the report's controls, never its private audience list.
function recipientShareMetadata(share) {
  return {
    id: share.id,
    ...(share.options?.anonymizeNames ? {} : { handle: share.handle }),
    scope: share.scope,
    options: share.options || {},
    publicLink: isPublicShare(share),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt
  };
}

async function canReadSharedReport(env, request, share, entry, entries) {
  if (isPublicShare(share)) return { ok: true };
  const google = await parseGoogleAuth(request, {}, env);
  if (google && entry.claimed === true && identityOwns(entry, google)) return { ok: true };
  const claimToken = String(request.headers.get("X-Claim-Token") || "").trim();
  if (!entry.claimed && entry.claimTokenHash && claimToken && await sha256Hex(claimToken) === entry.claimTokenHash) return { ok: true };
  if (!google) return { ok: false, status: 401, code: "auth_required", error: "Sign in to view this private report." };

  // Public handles are identifiers, not credentials. Only handles whose
  // ownership matches this verified Google subject can authorize a reader.
  const handles = new Set(entries.filter(e => e.claimed === true && identityOwns(e, google))
    .map(e => e.handle.toLowerCase()));
  const normalizedHandle = value => String(typeof value === "string" ? value : value?.handle || "").replace(/^@/, "").trim().toLowerCase();
  const hasNamedRecipient = values => (Array.isArray(values) ? values : []).some(value => handles.has(normalizedHandle(value)));
  if (share.scope === "people" && hasNamedRecipient(share.audience)) return { ok: true };
  if (share.scope === "group") {
    const groups = await getGroups(env, share.ownerKey);
    const selected = new Set([...(Array.isArray(share.groups) ? share.groups : []), ...(Array.isArray(share.audience) ? share.audience : [])]
      .map(value => String(typeof value === "string" ? value : value?.id || "").trim()));
    if (groups.some(group => (selected.has(group.id) || selected.has(group.name)) && hasNamedRecipient(group.members))) return { ok: true };
  }
  if (share.scope === "org") {
    // A matching display label or email domain cannot prove team membership.
    // Fresh authoritative records also admit teammates before they publish.
    const recipient = { handle: "_recipient", claimed: true, ownerId: identityOwnerId(google) };
    await applyTeamMemberships(env, [entry, recipient], { fresh: true });
    if (entry.teamId && entry.teamId === recipient.teamId) return { ok: true };
  }
  return { ok: false, status: 403, code: "share_access_denied", error: "This report is shared with a different audience." };
}

function buildSharedReport(entry, options, entries) {
  const opts = options || {};
  const sortedAll = [...entries].sort((a, b) => (b.tokensAll || 0) - (a.tokensAll || 0));
  const rank = sortedAll.findIndex(e => e.handle.toLowerCase() === entry.handle.toLowerCase()) + 1;
  const total = Math.max(1, entries.length);
  const st = standingFor(entry);
  const roundTokens = (n) => opts.fullTokenCounts !== false ? (n || 0) : Math.round((n || 0) / 1000) * 1000;
  const report = {
    handle: opts.anonymizeNames ? "Anonymous" : entry.handle,
    team: opts.anonymizeNames ? "" : (entry.team || ""),
    ...(opts.anonymizeNames ? {} : { hardware: entry.hardware || "" }),
    tokensAll: roundTokens(entry.tokensAll),
    tokensAllFormatted: formatTokens(roundTokens(entry.tokensAll)),
    tokensToday: roundTokens(entry.tokensToday),
    tokensTodayFormatted: formatTokens(roundTokens(entry.tokensToday)),
    tokens7d: roundTokens(entry.tokens7d),
    tokens7dFormatted: formatTokens(roundTokens(entry.tokens7d)),
    streakDays: entry.streakDays || 0,
    updatedAt: Number(entry.updatedAt) || 0,
    ...(opts.includeLeagueRank === false ? {} : {
      rank,
      percentile: Math.round(((total - rank + 1) / total) * 100),
      league: st.league,
      leagueTitle: st.leagueTitle,
      division: st.division,
      mmr: st.mmr
    }),
    season: seasonFor(),
    generatedAt: new Date().toISOString()
  };
  if (!opts.hideCost) {
    report.costAll = entry.costAll || 0;
    report.costAllFormatted = formatCurrency(entry.costAll || 0);
    report.cost7d = entry.cost7d || 0;
    report.cost7dFormatted = formatCurrency(entry.cost7d || 0);
  }
  if (opts.providerBreakdown !== false && entry.breakdown) {
    report.models = (Array.isArray(entry.breakdown.models) ? entry.breakdown.models : []).filter(m => m && typeof m === "object").slice(0, 12).map(m => ({
      provider: m.provider,
      model: opts.anonymizeNames ? "redacted" : m.model,
      tokensAll: roundTokens(m.tokensAll),
      costAll: opts.hideCost ? undefined : (m.costAll || 0),
      sharePercent: m.sharePercent || 0
    }));
  }
  if (entry.breakdown) {
    report.history = (Array.isArray(entry.breakdown.history) ? entry.breakdown.history : []).filter(h => h && typeof h === "object").slice(-130).map(h => ({ day: h.day, dayLabel: h.dayLabel, tokens: roundTokens(h.tokens), cost: opts.hideCost ? undefined : h.cost }));
    report.daily = (Array.isArray(entry.breakdown.daily) ? entry.breakdown.daily : []).filter(h => h && typeof h === "object").slice(-130).map(h => ({ day: h.day, tokens: roundTokens(h.tokens) }));
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

// --- Dynamic OG share cards -------------------------------------------------
// `GET /api/og/profile/<handle>.png` renders a 1200×630 "quick view" usage
// card at the edge: identity, token totals, a 30-day chart above a 17-week heatmap, and a
// provider-mix bar. Social crawlers need a raster
// image (SVG og:images are ignored), so resvg-wasm rasterizes the SVG —
// bundled Token Horizon Sans and JetBrains Mono fonts, since system fonts
// don't exist in Workers.

// Dynamic imports keep `node --test` working (Node can't resolve .wasm/.ttf);
// wrangler/esbuild still bundles the modules for the worker.
let ogWasmReady = null;
function ogInit() {
  if (!ogWasmReady) {
    ogWasmReady = Promise.all([
      import("@resvg/resvg-wasm"),
      import("@resvg/resvg-wasm/index_bg.wasm")
    ]).then(async ([resvgMod, wasmMod]) => {
      await resvgMod.initWasm(wasmMod.default);
      return resvgMod;
    });
  }
  return ogWasmReady;
}

let ogFontsReady = null;
function ogFonts() {
  if (!ogFontsReady) {
    ogFontsReady = Promise.all([
      import("../fonts/JetBrainsMono-Regular.ttf"),
      import("../fonts/JetBrainsMono-Bold.ttf"),
      import("../fonts/JetBrainsMono-ExtraBold.ttf"),
      import("../fonts/TokenHorizonSans-Regular.ttf"),
      import("../fonts/TokenHorizonSans-SemiBold.ttf")
    ]).then(mods => mods.map(m => new Uint8Array(m.default)));
  }
  return ogFontsReady;
}

const OG_PROVIDER_LABELS = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", meta: "Meta",
  opencode: "OpenCode", minimax: "MiniMax", kimi: "Kimi", zhipu: "Zhipu",
  deepseek: "DeepSeek", alibaba: "Alibaba", openrouter: "OpenRouter",
  mistral: "Mistral", xai: "xAI", local: "Local", other: "Other"
};

/// decodeURIComponent that never throws on malformed %-sequences.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function ogRoman(n) { return ({ 1: "I", 2: "II", 3: "III" })[n] || String(n || ""); }

/// Flatten an entry + its standing into the card's view model. `opts.anonymize`
/// strips identity + provider attribution (share-report privacy), `hideCost`
/// omits cost figures.
function ogCardModel(entry, entries, opts = {}) {
  const rankBy = key => [...entries].sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0))
    .findIndex(e => e.handle.toLowerCase() === entry.handle.toLowerCase()) + 1;
  const standing = standingFor(entry);
  return buildOgModel(entry, {
    rank: rankBy("tokensAll") || 1,
    rankToday: rankBy("tokensToday") || 1,
    total: Math.max(1, entries.length),
    standing: { ...standing, title: standing.leagueTitle, color: standing.leagueColor },
    season: seasonFor(),
    normalizeProvider,
    ...opts
  });
}

function generateOgSvg(vm) { return renderProfileOgSvg(vm); }

function ogAvatarRevision(model) {
  // External photos can change at the same URL. Refresh their validators and
  // cached bytes together, without fetching a photo to serve page metadata.
  return /^https:\/\//i.test(model?.avatarUrl || "") ? String(Math.floor(Date.now() / 300000)) : "";
}

async function ogFingerprint(svg, model, photoRevision = ogAvatarRevision(model)) {
  return `${OG_CARD_VERSION}-${(await sha256Hex(svg + (model ? JSON.stringify(model) : "") + photoRevision)).slice(0, 20)}`;
}

async function teamOgFingerprint(team, stats, svg = renderTeamOgSvg(team, stats)) {
  return `${TEAM_OG_VERSION}-${(await sha256Hex(svg + JSON.stringify({ team, stats }))).slice(0, 20)}`;
}

async function renderOgPng(svg) {
  const [resvgMod, fontBuffers] = await Promise.all([ogInit(), ogFonts()]);
  const resvg = new resvgMod.Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Token Horizon Sans" },
    background: "#F3F4EF"
  });
  let rendered;
  try {
    rendered = resvg.render();
    // Copy out of WASM before releasing its buffers.
    return rendered.asPng().slice();
  } finally {
    rendered?.free();
    resvg.free();
  }
}

// --- OG meta injection (crawler-safe profile/share pages) -------------------

function ogPageResponse(request, response, privatePage = false) {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Accept, User-Agent");
  headers.set("Referrer-Policy", "no-referrer");
  if (privatePage) {
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Robots-Tag", PRIVATE_ROBOTS);
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}

async function plainOgPage(env, request, privatePage = false) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/leaderboard";
  assetUrl.search = "";
  const asset = await fetchCompleteOgAsset(env, assetUrl, request);
  const html = injectPageMetadata(await asset.text(), {
    noindex: true, private: privatePage, type: 'website',
    title: `${privatePage ? 'Share link unavailable' : 'Profile unavailable'} · Token Horizon`,
    description: privatePage ? 'This Token Horizon report may have expired or been revoked.' : 'This Token Horizon profile could not be found.',
    url: `${SITE_ORIGIN}${new URL(request.url).pathname}`
  });
  return ogPageResponse(request, new Response(html, { status: asset.status, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": PRIVATE_ROBOTS } }), privatePage);
}

function fetchCompleteOgAsset(env, assetUrl, request) {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  headers.delete("Range");
  // The asset is an anonymous shell. Forwarding account credentials to the
  // static binding would undermine the same cached-shell guarantee as /login.
  for (const name of ['Cookie', 'Authorization', 'X-Google-Token', 'X-Claim-Token', 'X-Leaderboard-Secret']) headers.delete(name);
  return env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET", headers }));
}

function isProfileDocumentQuery(params) {
  return [null, '', 'players'].includes(params.get('view')) && !['share', 'invite', 'signin', 'flat'].some(key => params.has(key));
}

async function serveRoutePage(env, request, assetUrl, cacheControl) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405,
    headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  const meta = routePageMetadata(new URL(request.url));
  const asset = await fetchCompleteOgAsset(env, assetUrl, request);
  if (!asset.ok) return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers: asset.headers });
  const html = injectPageMetadata(await asset.text(), meta);
  const headers = new Headers(asset.headers);
  // Asset validators describe the unmodified SPA, not this route's document.
  for (const name of ['ETag', 'Last-Modified', 'Content-Length', 'Content-Encoding', 'Content-Range', 'Accept-Ranges']) headers.delete(name);
  headers.set('Cache-Control', meta.private ? 'private, no-store' : cacheControl || 'public, max-age=0, s-maxage=300, must-revalidate');
  headers.set('Referrer-Policy', 'no-referrer');
  const vary = new Set((headers.get('Vary') || '').split(',').map(s => s.trim()).filter(Boolean));
  vary.add('Accept'); headers.set('Vary', [...vary].join(', '));
  if (meta.noindex || meta.private) headers.set('X-Robots-Tag', PRIVATE_ROBOTS);
  return new Response(request.method === 'HEAD' ? null : html, { status: asset.status, headers });
}

/// Fetch the SPA asset and inject per-target OG/Twitter meta into <head>.
/// `<base href="/">` keeps the SPA's relative asset paths working when the
/// page is served at a nested clean URL (/u/<handle>, /s/<id>).
async function servePageWithOg(env, request, meta) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/leaderboard";
  assetUrl.search = "";
  const res = await fetchCompleteOgAsset(env, assetUrl, request);
  if (!res.ok) {
    const headers = new Headers(res.headers); headers.set('X-Robots-Tag', PRIVATE_ROBOTS);
    return ogPageResponse(request, new Response(res.body, { status: res.status, headers }), meta.private);
  }
  const html = injectPageMetadata(await res.text(), meta);
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": meta.private ? "private, no-store" : "no-cache", "Vary": "Accept, User-Agent", "Referrer-Policy": "no-referrer", ...(meta.private || meta.noindex ? { 'X-Robots-Tag': PRIVATE_ROBOTS } : {}) }
  });
}

async function serveTeamPage(env, request, id) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  let data;
  try { data = await getTeamPublicData(env, id); }
  catch { return new Response(request.method === 'HEAD' ? null : 'Team temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  if (!data) {
    const response = await servePageWithOg(env, request, {
      noindex: true, type: 'website', title: 'Team unavailable · Token Horizon',
      description: 'This Token Horizon team could not be found.', url: `${SITE_ORIGIN}/leaderboard?view=teams`
    });
    return new Response(response.body, { status: 404, headers: response.headers });
  }
  const { team, stats } = data;
  const fingerprint = await teamOgFingerprint(team, stats);
  const image = `${SITE_ORIGIN}/api/og/team/${team.id}.png?v=${fingerprint}`;
  return servePageWithOg(env, request, {
    type: 'website', schemaType: 'ProfilePage', title: `${team.name} · ${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'} · Token Horizon`,
    description: `${team.name} on Token Horizon: ${team.memberCount} team ${team.memberCount === 1 ? 'member' : 'members'}, ${stats.tokensFormatted} published tokens and ${stats.publishedProfiles} public ${stats.publishedProfiles === 1 ? 'profile' : 'profiles'}. Explore the crew’s AI activity and provider mix.`,
    alt: `${team.name} team card: ${team.memberCount} members, ${stats.tokensFormatted} published tokens, ${stats.publishedProfiles} published profiles${team.logoUrl ? ', custom team icon' : ''} and provider mix.`,
    url: team.url, image
  });
}

async function serveTeamInvitePage(env, request, token) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': PRIVATE_ROBOTS } });
  let invitation;
  try { invitation = await getInviteTeam(env, token); } catch { /* Invalid/expired links keep a neutral, private preview. */ }
  if (!invitation) return servePageWithOg(env, request, {
    private: true, type: 'website', schemaType: null, title: 'Join your crew · Token Horizon',
    description: 'Sign in to join your friends’ team and explore your AI usage together.',
    url: `${SITE_ORIGIN}/leaderboard?view=teams`, image: `${SITE_ORIGIN}/assets/og-leaderboard.png`,
    alt: 'Join your friends on Token Horizon.'
  });
  const { team } = invitation;
  let stats;
  try { stats = teamUsageStats(team, await getEntriesFromR2(env)); }
  catch { stats = teamUsageStats(team, []); }
  const image = `${SITE_ORIGIN}/api/og/team/${team.id}.png?v=${await teamOgFingerprint(team, stats)}`;
  return servePageWithOg(env, request, {
    private: true, type: 'website', schemaType: null, title: `Join ${team.name} · Token Horizon`,
    description: `Your crew is waiting. Join ${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'} in ${team.name} and explore your AI activity together. Sign in with Google or GitHub to accept the invite.`,
    alt: `${team.name}: ${team.memberCount} team members${team.logoUrl ? ' and custom team icon' : ''}. Join your crew on Token Horizon.`,
    // A secret invite grants membership; only the separate public team URL
    // belongs in crawler-visible canonical metadata and preview artwork.
    url: team.url, image
  });
}

/// /u/<handle> — clean profile permalink with a dynamic OG card. Unknown
/// handles still get the SPA (it renders its own not-found state).
async function serveProfilePage(env, request, handle) {
  const clean = handle.replace(/^@/, "").trim().toLowerCase();
  const entries = await getEntriesFromR2(env);
  const entry = clean && entries.find(e => e.handle.toLowerCase() === clean);
  if (!entry) {
    return plainOgPage(env, request);
  }
  const url = new URL(request.url);
  const vm = ogCardModel(entry, entries);
  const fingerprint = await ogFingerprint(generateOgSvg(vm), vm);
  const image = `${url.origin}/api/og/profile/${encodeURIComponent(entry.handle)}.png?v=${fingerprint}`;
  // curl / AI agents / JSON clients get a text rendition instead of HTML
  // (social unfurlers still get the SPA + OG meta for the PNG card).
  const tv = textViewKind(request, url.searchParams);
  if (tv === "json") {
    return ogPageResponse(request, jsonResponse({ ok: true, card: vm, url: `${SITE_ORIGIN}/u/${encodeURIComponent(entry.handle)}`, image }, 200, { "Cache-Control": "public, max-age=120" }));
  }
  if (tv) {
    return ogPageResponse(request, new Response(ogTextCard(vm, { origin: SITE_ORIGIN, color: tv === "cli" }), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=120" }
    }));
  }
  const canon = `${SITE_ORIGIN}/u/${encodeURIComponent(entry.handle)}`;
  return servePageWithOg(env, request, {
    type: 'profile', schemaType: 'ProfilePage', profileHandle: entry.handle,
    title: `@${entry.handle} · ${vm.leagueTitle} ${ogRoman(vm.division)} · #${vm.rankToday} today · Token Horizon`,
    description: `${formatTokens(vm.tokensToday)} tokens today · ${formatTokens(vm.tokensAll)} all-time · ${vm.streakDays}d streak — Token Horizon leaderboard`,
    alt: `Token Horizon usage card for @${entry.handle}: ${formatTokens(vm.tokensToday)} tokens today, ${formatTokens(vm.tokensAll)} all-time, ${vm.streakDays}-day streak and activity heatmap.`,
    url: canon,
    image
  });
}

/// /s/<id> — shared-report pages get the same unfurl treatment, honoring the
/// share's anonymize/hide-cost privacy options.
async function serveSharePage(env, request, id) {
  const share = id && await getJson(env, `shares/${id}.json`);
  const url = new URL(request.url);
  const tv = textViewKind(request, url.searchParams);
  if (share && !share.revoked && !(share.expiresAt && share.expiresAt * 1000 <= Date.now()) && !isPublicShare(share)) {
    const image = `${url.origin}/api/og/share/${id}.png?v=${await ogFingerprint(renderRestrictedOgSvg())}`;
    if (tv === "json") return ogPageResponse(request, jsonResponse({ ok: true, restricted: true, url: `${SITE_ORIGIN}/s/${id}`, image }), true);
    if (tv) return ogPageResponse(request, new Response("Token Horizon\nPrivate usage report. Sign in to view if it was shared with you.\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }), true);
    return servePageWithOg(env, request, {
      private: true, type: "website", title: "Private usage report · Token Horizon",
      description: "A private Token Horizon usage report. Sign in to view if it was shared with you.",
      alt: "Token Horizon private usage report. Sign in to view.",
      url: `${SITE_ORIGIN}/s/${id}`, image
    });
  }
  if (share && !share.revoked && !(share.expiresAt && share.expiresAt * 1000 <= Date.now())) {
    const entries = await getEntriesFromR2(env);
    const entry = entries.find(e => e.handle.toLowerCase() === String(share.handle || "").toLowerCase());
    if (entry) {
      const vm = ogCardModel(entry, entries, shareOgOptions(share));
      const image = `${url.origin}/api/og/share/${id}.png?v=${await ogFingerprint(generateOgSvg(vm), vm)}`;
      if (tv === "json") {
        return ogPageResponse(request, jsonResponse({ ok: true, card: vm, url: `${SITE_ORIGIN}/s/${id}`, image }), true);
      }
      if (tv) {
        return ogPageResponse(request, new Response(ogTextCard(vm, { origin: SITE_ORIGIN, color: tv === "cli" }), {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        }), true);
      }
      return servePageWithOg(env, request, {
        private: true,
        title: `${vm.handle === "Anonymous" ? "Shared usage report" : `@${vm.handle} — usage report`} · Token Horizon`,
        description: `${formatTokens(vm.tokensAll)} tokens all-time${vm.leagueTitle ? ` · ${vm.leagueTitle} league` : ""} · ${vm.streakDays}d streak`,
        alt: `Shared Token Horizon usage report: ${formatTokens(vm.tokensAll)} tokens all-time, ${vm.streakDays}-day streak and activity heatmap.`,
        url: `${SITE_ORIGIN}/s/${id}`,
        image
      });
    }
  }
  if (tv === "json") return ogPageResponse(request, jsonResponse({ ok: false, error: "Share link unavailable" }), true);
  if (tv) return ogPageResponse(request, new Response("Token Horizon\nShare link unavailable. It may have expired or been revoked.\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }), true);
  return plainOgPage(env, request, true);
}

// --- Text rendition for CLI tools & AI agents ------------------------------
// Social unfurlers need HTML + og: meta and browsers get the SPA — but curl,
// wget, httpie, and AI agents (GPTBot, ClaudeBot, ChatGPT-User, Perplexity…)
// get a framed text card: a text-mode mirror of the PNG OG card. Returns
// "cli" (ANSI color welcome), "ai" (plain — escape codes pollute LLM
// context), "json" (structured data), or null (browser/crawler → HTML).
const OG_CLI_UA = /\bcurl|wget|httpie|lynx|w3m|links\b|aria2|python-requests|python-urllib|aiohttp|httpx|go-http-client|undici|axios|got\/|insomnia|postmanruntime|powershell|java\/|okhttp/i;
const OG_AI_UA = /gptbot|chatgpt|oai-searchbot|claudebot|claude-web|anthropic|perplexity|cohere-ai|meta-externalagent|bytespider|amazonbot|devin|swe-agent|vertex|bedrock|langchain|llamaindex|cloudflare.*ai|duckassist/i;

function textViewKind(request, searchParams) {
  const fmt = (searchParams.get("format") || "").toLowerCase();
  if (fmt === "json") return "json";
  if (fmt === "text" || fmt === "ascii" || searchParams.has("ascii")) return "ai";
  const accept = (request.headers.get("Accept") || "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) return "json";
  const ua = request.headers.get("User-Agent") || "";
  if (OG_AI_UA.test(ua)) return "ai";
  if (OG_CLI_UA.test(ua)) return "cli";
  if (accept.includes("text/plain") && !accept.includes("text/html")) return "ai";
  return null;
}

const OG_ANSI_BY_LEAGUE = {
  bronze: "\x1b[33m", silver: "\x1b[37m", gold: "\x1b[93m", platinum: "\x1b[96m",
  diamond: "\x1b[94m", master: "\x1b[95m", grandmaster: "\x1b[91m"
};

/// Framed ~78-col text card mirroring the PNG layout. `color` enables ANSI
/// (curl/httpie terminals); AI agents get clean text for easier parsing.
function ogTextCard(vm, opts = {}) {
  const ansi = opts.color === true;
  const R = ansi ? "\x1b[0m" : "";
  const bold = (s) => ansi ? `\x1b[1m${s}${R}` : s;
  const dim = (s) => ansi ? `\x1b[2m${s}${R}` : s;
  const green = (s) => ansi ? `\x1b[92m${s}${R}` : s;
  const cyan = (s) => ansi ? `\x1b[96m${s}${R}` : s;
  const amber = (s) => ansi ? `\x1b[93m${s}${R}` : s;
  const league = (s) => ansi ? `${OG_ANSI_BY_LEAGUE[vm.league] || "\x1b[96m"}${s}${R}` : s;
  const MIX_COLORS = ["\x1b[91m", "\x1b[94m", "\x1b[92m", "\x1b[95m", "\x1b[96m"];
  const mixPaint = ansi ? (i, s) => `${MIX_COLORS[i % MIX_COLORS.length]}${s}${R}` : (i, s) => s;

  const INNER = 74;
  const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const row = (inner = "") => `│ ${inner}${" ".repeat(Math.max(0, INNER - visLen(inner)))} │`;
  const split = (l, r) => {
    const pad = Math.max(1, INNER - visLen(l) - visLen(r));
    return `│ ${l}${" ".repeat(pad)}${r} │`;
  };

  const blocks = "▁▂▃▄▅▆▇█";
  const sparkline = (vals) => {
    if (!vals || vals.length < 2) return "collecting…";
    const max = Math.max(...vals, 1);
    return vals.map(v => blocks[Math.min(7, Math.round((v / max) * 7))]).join("");
  };
  const mixChars = "█▓▒░";
  const mixBar = (mix, width = 26) => {
    if (!mix.length) return "";
    let used = 0;
    return mix.map((s, i) => {
      const n = i === mix.length - 1 ? Math.max(1, width - used) : Math.max(1, Math.round(s.share * width));
      used += n;
      const glyph = ansi ? "█" : mixChars[Math.min(i, mixChars.length - 1)];
      return mixPaint(i, glyph.repeat(n));
    }).join("");
  };

  const season = vm.season ? vm.season.displayName.toUpperCase() : "";
  const title = " TOKEN HORIZON · AI USAGE LEADERBOARD ";
  const footer = `${(opts.origin || "https://token-horizon.dev").replace(/^https?:\/\//, "")}${vm.handle === "Anonymous" ? "" : "/u/" + vm.handle}`;
  const updated = vm.updatedAt ? new Date(vm.updatedAt * 1000).toISOString().slice(0, 10) : "";

  const chips = [
    ...(vm.includeLeagueRank !== false ? [
    `#${vm.rankToday} TODAY`,
    `${vm.leagueTitle} ${ogRoman(vm.division)}`.trim().toUpperCase(),
    `${formatTokens(vm.mmr)} MMR`,
    `TOP ${Math.max(1, Math.round(Number(vm.percentile) || 0))}%`
    ] : []),
    `${vm.streakDays}D STREAK`
  ];
  const chipLine = chips.map((c, i) => {
    const t = `[${c}]`;
    if (!ansi) return t;
    return [cyan, league, dim, amber, cyan][i](t);
  }).join(" ");

  const stat = (label, value, right = "") => {
    const l = `  ${dim(label.toUpperCase().padEnd(12))} ${bold(String(value))}`;
    return right ? split(l, `${dim(right)}`) : row(l);
  };

  const mixLegend = vm.mix.map(s => `${OG_PROVIDER_LABELS[s.provider] || s.provider} ${Math.round(s.share * 100)}%`).join(" · ");
  const history = vm.history.length ? vm.history : (vm.calendarDays || []).filter(day => day.day <= vm.calendarEnd).slice(-14).map(day => day.tokens);

  return [
    `╭─${title}${"─".repeat(Math.max(0, INNER + 4 - visLen(title) - visLen(` ${season} `)))} ${season} ─╮`,
    row(),
    split(`   ${bold("@" + vm.handle)}`, `${dim(vm.team || "")} `),
    row(`   ${dim(vm.hardware || "")}`),
    row(`   ${chipLine}`),
    row(),
    row(`  ${dim("TOKENS TODAY")}`),
    split(`   ${green(bold(formatTokens(vm.tokensToday)))}`, vm.costToday != null ? `${dim(`≈ ${formatCurrency(vm.costToday)} est. today`)}` : ""),
    stat("last 7 days", formatTokens(vm.tokens7d), vm.includeLeagueRank !== false ? `rank #${vm.rank} of ${vm.total}` : ""),
    stat("all-time", formatTokens(vm.tokensAll), vm.costAll != null ? `${formatCurrency(vm.costAll)} est. spend` : ""),
    stat("requests", formatTokens(vm.requestsAll), `${vm.streakDays}-day streak`),
    row(),
    split(`  ${dim("ACTIVITY · " + history.length + "D")}    ${cyan(sparkline(history))}`, ""),
    ...(vm.mix.length ? [
      row(),
      row(`  ${dim("PROVIDER MIX")}   ${mixBar(vm.mix)}`),
      row(`  ${" ".repeat(15)}${dim(mixLegend)}`)
    ] : []),
    row(),
    split(`   ${dim(footer)}`, `${dim(updated)} `),
    `╰${"─".repeat(INNER + 4)}╯`,
    ""
  ].join("\n");
}
