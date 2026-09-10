/**
 * Token Horizon — Cloudflare Edge Webhosting & R2 Leaderboard Backend
 *
 * Provides sub-20ms edge responses globally, direct R2 bucket persistence,
 * dynamic SVG badge generation for READMEs, and static asset webhosting.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Leaderboard-Secret",
};

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
    updatedAt: Date.now() / 1000,
    breakdown: {
      models: [
        { provider: "claude", model: "claude-opus-5", tokensToday: 1580000000, tokensAll: 14800000000, costToday: 550.00, costAll: 6100.00, sharePercent: 62.1 },
        { provider: "claude", model: "claude-3-7-sonnet", tokensToday: 620000000, tokensAll: 5800000000, costToday: 210.00, costAll: 2100.00, sharePercent: 24.3 },
        { provider: "google", model: "gemini-3.8-flash", tokensToday: 180000000, tokensAll: 1900000000, costToday: 34.00, costAll: 120.00, sharePercent: 8.0 },
        { provider: "openai", model: "gpt-5-codex", tokensToday: 89019625, tokensAll: 1344909130, costToday: 28.40, costAll: 303.40, sharePercent: 5.6 }
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
  },
  {
    id: "claude:claude",
    handle: "ben.ebsworth (Claude)",
    team: "Frontier AI",
    tokensToday: 1002198684,
    tokens7d: 7528838077,
    tokensAll: 7528838077,
    costToday: 701.35,
    cost7d: 5252.09,
    costAll: 5252.09,
    streakDays: 16,
    topModel: "claude-3-7-sonnet",
    hardware: "Apple M5 Max",
    isLocal: false,
    updatedAt: Date.now() / 1000 - 120,
    breakdown: {
      models: [
        { provider: "claude", model: "claude-3-7-sonnet", tokensToday: 750000000, tokensAll: 5646628557, costToday: 525.00, costAll: 3939.00, sharePercent: 75.0 },
        { provider: "claude", model: "claude-3-5-haiku", tokensToday: 252198684, tokensAll: 1882209520, costToday: 176.35, costAll: 1313.09, sharePercent: 25.0 }
      ],
      tools: [
        { tool: "claude", tokensToday: 1002198684, tokensAll: 7528838077, costToday: 701.35, costAll: 5252.09 }
      ],
      history: [
        { day: 1, dayLabel: "Sep 4", tokens: 980000000, cost: 685.00 },
        { day: 2, dayLabel: "Sep 5", tokens: 1100000000, cost: 770.00 },
        { day: 3, dayLabel: "Sep 6", tokens: 890000000, cost: 620.00 },
        { day: 4, dayLabel: "Sep 7", tokens: 1050000000, cost: 735.00 },
        { day: 5, dayLabel: "Sep 8", tokens: 1250000000, cost: 875.00 },
        { day: 6, dayLabel: "Sep 9", tokens: 1256639393, cost: 865.74 },
        { day: 7, dayLabel: "Sep 10", tokens: 1002198684, cost: 701.35 }
      ],
      activeDays: 16,
      totalSessions: 28
    }
  },
  {
    id: "peer:alice",
    handle: "alice",
    team: "Core Team",
    tokensToday: 450000000,
    tokens7d: 3100000000,
    tokensAll: 14200000000,
    costToday: 120.00,
    cost7d: 840.00,
    costAll: 3800.00,
    streakDays: 24,
    topModel: "gpt-6-astra",
    hardware: "Apple M4 Max",
    isLocal: false,
    updatedAt: Date.now() / 1000 - 300,
    breakdown: {
      models: [
        { provider: "openai", model: "gpt-6-astra", tokensToday: 320000000, tokensAll: 9940000000, costToday: 85.00, costAll: 2660.00, sharePercent: 70.0 },
        { provider: "openai", model: "gpt-5-codex", tokensToday: 130000000, tokensAll: 4260000000, costToday: 35.00, costAll: 1140.00, sharePercent: 30.0 }
      ],
      tools: [
        { tool: "codex", tokensToday: 450000000, tokensAll: 14200000000, costToday: 120.00, costAll: 3800.00 }
      ],
      history: [
        { day: 1, dayLabel: "Sep 4", tokens: 410000000, cost: 110.00 },
        { day: 2, dayLabel: "Sep 5", tokens: 480000000, cost: 130.00 },
        { day: 3, dayLabel: "Sep 6", tokens: 390000000, cost: 105.00 },
        { day: 4, dayLabel: "Sep 7", tokens: 450000000, cost: 120.00 },
        { day: 5, dayLabel: "Sep 8", tokens: 460000000, cost: 125.00 },
        { day: 6, dayLabel: "Sep 9", tokens: 460000000, cost: 130.00 },
        { day: 7, dayLabel: "Sep 10", tokens: 450000000, cost: 120.00 }
      ],
      activeDays: 24,
      totalSessions: 35
    }
  }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

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
        timestamp: new Date().toISOString()
      });
    }

    // 3. GET /api/leaderboard (or /leaderboard with JSON accept / query)
    const isGetLeaderboard = request.method === "GET" && (
      pathname === "/api/leaderboard" ||
      (pathname === "/leaderboard" && (request.headers.get("accept")?.includes("json") || searchParams.has("period") || searchParams.has("format")))
    );
    if (isGetLeaderboard) {
      const period = searchParams.get("period") || "today";
      const teamFilter = searchParams.get("team") || "";

      const entries = await getEntriesFromR2(env);
      let filtered = entries;

      if (teamFilter) {
        filtered = filtered.filter(e => e.team && e.team.toLowerCase().includes(teamFilter.toLowerCase()));
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
          entry: e
        };
      });

      // Calculate Global KPIs
      let totalTokens = 0;
      let totalCost = 0;
      let maxStreak = 0;
      entries.forEach(e => {
        totalTokens += (e.tokensAll || 0);
        totalCost += (e.costAll || 0);
        if ((e.streakDays || 0) > maxStreak) maxStreak = e.streakDays;
      });

      return jsonResponse({
        ok: true,
        period,
        team: teamFilter,
        total: ranked.length,
        kpis: {
          totalTokens,
          totalTokensFormatted: formatTokens(totalTokens),
          totalCost,
          totalCostFormatted: formatCurrency(totalCost),
          activeDevs: entries.length,
          maxStreakDays: maxStreak
        },
        leaderboard: ranked
      }, 200, {
        "Cache-Control": "public, max-age=5, s-maxage=5, stale-while-revalidate=10"
      });
    }

    // 4. POST /api/leaderboard (or POST /leaderboard) — Upsert usage stats from Token Horizon
    if (request.method === "POST" && (pathname === "/api/leaderboard" || pathname === "/leaderboard")) {
      try {
        // Optional secret enforcement if set on Worker
        if (env.LEADERBOARD_SECRET) {
          const authHeader = request.headers.get("Authorization") || "";
          const customHeader = request.headers.get("X-Leaderboard-Secret") || "";
          const token = authHeader.replace(/^Bearer\s+/i, "").trim() || customHeader.trim();
          if (token !== env.LEADERBOARD_SECRET) {
            return jsonResponse({ ok: false, error: "Unauthorized: invalid write token" }, 401);
          }
        }

        const body = await request.json();
        const incoming = body.entry || body;

        if (!incoming.handle) {
          return jsonResponse({ ok: false, error: "Missing handle in payload" }, 400);
        }

        const handleClean = String(incoming.handle).replace(/^@/, "").trim();
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
          breakdown
        };

        const existingIdx = entries.findIndex(e => e.handle.toLowerCase() === handleClean.toLowerCase());
        let action = "created";
        if (existingIdx !== -1) {
          const prev = entries[existingIdx];
          if (!newEntry.team && prev.team) newEntry.team = prev.team;
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
          entries[existingIdx] = newEntry;
          action = "updated";
        } else {
          entries.push(newEntry);
        }

        await saveEntriesToR2(env, entries);

        return jsonResponse({
          ok: true,
          action,
          handle: handleClean,
          entry: newEntry,
          totalEntries: entries.length,
          timestamp: new Date().toISOString()
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

    // 7. Webhosting: Fallback to static assets binding (docs/leaderboard.html, styles.css, etc.)
    if (env.ASSETS) {
      if (pathname === "/" || pathname === "/leaderboard") {
        const newUrl = new URL(request.url);
        newUrl.pathname = "/leaderboard.html";
        return env.ASSETS.fetch(new Request(newUrl.toString(), request));
      }
      return env.ASSETS.fetch(request);
    }

    // Default redirect to leaderboard.html
    return Response.redirect(`${url.origin}/leaderboard.html`, 302);
  }
};

// --- R2 Storage Helpers ---
async function getEntriesFromR2(env) {
  if (!env.LEADERBOARD_BUCKET) {
    return [...DEFAULT_STARTER_ENTRIES];
  }
  try {
    const obj = await env.LEADERBOARD_BUCKET.get("leaderboard.json");
    if (!obj) {
      // Seed starter entries on first launch
      await env.LEADERBOARD_BUCKET.put("leaderboard.json", JSON.stringify(DEFAULT_STARTER_ENTRIES, null, 2), {
        httpMetadata: { contentType: "application/json" }
      });
      return [...DEFAULT_STARTER_ENTRIES];
    }
    const text = await obj.text();
    const data = JSON.parse(text);
    const entries = Array.isArray(data) ? data : DEFAULT_STARTER_ENTRIES;

    let needsBackfill = false;
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
