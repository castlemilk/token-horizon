// Pure, deterministic social card model and SVG. Rasterization lives in the Worker.
import { ogLeagueIcon } from './og-league-assets.js';

export const OG_CARD_VERSION = "horizon-6";

const DAY = 86400;
const MAX_DAY = 2932896; // Last supported ISO year: 9999.
const C = { paper: "#F3F4EF", ink: "#121714", white: "#FFFFFF", line: "#CDD3CC", muted: "#56635A", forest: "#235E43", mint: "#B6F2CF" };
const LEVELS = ["#E1E6DE", "#C1DDC8", "#83B795", "#478966", "#235E43"];
const PROVIDERS = {
  anthropic: ["Anthropic", "#D97757"], openai: ["OpenAI", "#235E43"], google: ["Google", "#4285F4"],
  meta: ["Meta", "#0866FF"], opencode: ["OpenCode", "#7665B5"], minimax: ["MiniMax", "#B98027"],
  kimi: ["Kimi", "#B45685"], zhipu: ["Zhipu", "#288895"], deepseek: ["DeepSeek", "#4D6BFE"],
  alibaba: ["Alibaba", "#CE6427"], openrouter: ["OpenRouter", "#78877C"], mistral: ["Mistral", "#B98027"],
  xai: ["xAI", "#343E37"], local: ["Local", "#478966"], other: ["Other", "#89978B"]
};
const UNATTRIBUTED = { provider: "unattributed", label: "Unattributed", color: "#A6B1A8" };
const providerStyle = provider => ({ provider, label: PROVIDERS[provider]?.[0] || truncate(provider, 16), color: PROVIDERS[provider]?.[1] || PROVIDERS.other[1] });

const number = value => Number.isFinite(Number(value)) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(value))) : 0;
const text = value => String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").slice(0, 256);
const esc = value => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const truncate = (value, limit) => { const chars = Array.from(text(value)); return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : chars.join(""); };
const iso = day => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const dateLabel = day => new Date(day * DAY * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = day => new Date(day * DAY * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const roman = value => ({ 1: "I", 2: "II", 3: "III" })[value] || "";

export function ogDay(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / (DAY * 1000));
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const day = Math.floor(n > 1e12 ? n / (DAY * 1000) : n > 1e8 ? n / DAY : n);
  return day <= MAX_DAY ? day : null;
}

function dailyTotals(entry) {
  const breakdown = entry.breakdown || {};
  const values = new Map();
  const addRows = (rows, target, sum = false) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const day = ogDay(row?.day ?? row?.date ?? row?.dayLabel);
      if (day === null) continue;
      const tokens = number(row.tokens);
      target.set(day, sum ? number((target.get(day) || 0) + tokens) : Math.max(target.get(day) || 0, tokens));
    }
  };
  addRows(breakdown.daily, values);
  if (!values.size) {
    for (const model of Array.isArray(breakdown.modelHistory) ? breakdown.modelHistory : []) {
      const perModel = new Map();
      addRows(model?.points, perModel);
      for (const [day, tokens] of perModel) values.set(day, number((values.get(day) || 0) + tokens));
    }
  }
  if (!values.size) addRows(breakdown.history, values);
  return values;
}

// Publication dates anchor old profiles: a historical card never drifts with the clock.
function calendar(entry, round, values) {
  const publishedDay = entry.updatedAt ? ogDay(entry.updatedAt) : null;
  const latestDay = values.size ? [...values.keys()].reduce((max, day) => Math.max(max, day), 0) : null;
  const anchor = publishedDay ?? latestDay ?? 0;
  const weekday = (new Date(anchor * DAY * 1000).getUTCDay() + 6) % 7;
  const start = anchor - weekday - 16 * 7;
  const max = [...values].reduce((max, [day, tokens]) => day >= start && day <= anchor ? Math.max(max, round(tokens)) : max, 1);
  const days = Array.from({ length: 119 }, (_, index) => {
    const day = start + index;
    const tokens = round(values.get(day) || 0);
    return { day, date: iso(day), tokens: day > anchor ? 0 : tokens, level: day > anchor ? -1 : tokens > 0 ? Math.max(1, Math.min(4, Math.ceil(tokens / max * 4))) : 0 };
  });
  return { calendarDays: days, calendarAvailable: values.size > 0, calendarStart: start, calendarEnd: anchor, publishedDay, activeDays: days.filter(d => d.tokens > 0).length };
}

function colorProviderChart(entry, model, totals, normalize, rounded, visible) {
  model.chartProviders = [];
  model.chartProviderAvailable = false;
  for (const day of model.chartDays) day.segments = [];
  if (!visible) return;
  const byDay = new Map();
  const window = new Set(model.chartDays.map(point => point.day));
  for (const series of Array.isArray(entry.breakdown?.modelHistory) ? entry.breakdown.modelHistory : []) {
    const provider = normalize(series?.provider || "other");
    const perModel = new Map();
    for (const point of Array.isArray(series?.points) ? series.points : []) {
      const day = ogDay(point?.day ?? point?.date ?? point?.dayLabel);
      if (!window.has(day)) continue;
      perModel.set(day, Math.max(perModel.get(day) || 0, number(point.tokens)));
    }
    for (const [day, tokens] of perModel) {
      if (!tokens) continue;
      if (!byDay.has(day)) byDay.set(day, new Map());
      const providers = byDay.get(day);
      providers.set(provider, number((providers.get(provider) || 0) + tokens));
    }
  }
  if (!byDay.size) return; // All-time percentages cannot supply daily attribution.
  for (const point of model.chartDays) {
    if (!point.tokens) continue;
    const canonical = totals.get(point.day) || 0;
    const measured = [...(byDay.get(point.day) || [])].filter(([, tokens]) => tokens > 0);
    const measuredTotal = measured.reduce((sum, [, tokens]) => number(sum + tokens), 0);
    // Conflicting measurements retain the canonical total without scaling providers.
    const parts = measuredTotal > canonical ? [["unattributed", canonical]] : [...measured, ...(measuredTotal < canonical ? [["unattributed", canonical - measuredTotal]] : [])];
    if (rounded) {
      // Round the partition in whole thousands, preserving its rounded total.
      // Largest remainders prevent independent rounding from inflating the bar.
      const units = parts.map(([, tokens]) => Math.floor(tokens / 1000));
      let remaining = Math.round(point.tokens / 1000) - units.reduce((sum, value) => sum + value, 0);
      const order = parts.map(([, tokens], index) => ({ index, remainder: tokens / 1000 - units[index] }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
      for (const { index } of order) { if (remaining-- <= 0) break; units[index]++; }
      point.segments = parts.map(([provider], index) => ({ provider, tokens: units[index] * 1000 })).filter(part => part.tokens > 0);
    } else point.segments = parts.map(([provider, tokens]) => ({ provider, tokens })).filter(part => part.tokens > 0);
  }
  const observed = new Map();
  for (const day of model.chartDays) for (const part of day.segments) observed.set(part.provider, number((observed.get(part.provider) || 0) + part.tokens));
  const leaders = [...observed].filter(([provider]) => !["unattributed", "other"].includes(provider)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([provider]) => provider);
  const grouped = new Map();
  for (const day of model.chartDays) {
    const parts = new Map();
    for (const part of day.segments) {
      const provider = part.provider === "unattributed" || leaders.includes(part.provider) ? part.provider : "other";
      parts.set(provider, number((parts.get(provider) || 0) + part.tokens));
    }
    day.segments = [...parts].map(([provider, tokens]) => ({ ...(provider === "unattributed" ? UNATTRIBUTED : providerStyle(provider)), tokens }));
    for (const part of day.segments) grouped.set(part.provider, number((grouped.get(part.provider) || 0) + part.tokens));
  }
  const total = [...grouped.values()].reduce((sum, tokens) => number(sum + tokens), 0);
  const keys = [...leaders, ...(grouped.has("other") ? ["other"] : []), ...(grouped.has("unattributed") ? ["unattributed"] : [])];
  model.chartProviders = keys.map(provider => ({ ...(provider === "unattributed" ? UNATTRIBUTED : providerStyle(provider)), tokens: grouped.get(provider), share: total ? grouped.get(provider) / total : 0 }));
  model.chartProviderAvailable = keys.some(provider => provider !== "unattributed");
  for (const day of model.chartDays) day.segments.sort((a, b) => keys.indexOf(a.provider) - keys.indexOf(b.provider));
}

export function buildOgModel(entry = {}, options = {}) {
  const anonymize = options.anonymize === true;
  const round = options.fullTokenCounts === false ? value => Math.round(number(value) / 1000) * 1000 : number;
  const rankVisible = options.includeLeagueRank !== false;
  const st = options.standing || {};
  const total = Math.max(1, Math.floor(number(options.total)));
  const normalize = options.normalizeProvider || (value => text(value).toLowerCase() || "other");
  const byProvider = new Map();
  if (!anonymize && options.providerBreakdown !== false) {
    for (const model of Array.isArray(entry.breakdown?.models) ? entry.breakdown.models : []) {
      if (!model || typeof model !== "object") continue;
      const key = normalize(model.provider || "other");
      byProvider.set(key, number((byProvider.get(key) || 0) + number(model.tokensAll)));
    }
  }
  const providers = [...byProvider].filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]);
  const providerTotal = providers.reduce((sum, [, tokens]) => number(sum + tokens), 0);
  const top = providers.slice(0, 4);
  if (providers.length > 4) top.push(["other", providers.slice(4).reduce((sum, [, tokens]) => number(sum + tokens), 0)]);
  const mix = top.map(([provider, tokens]) => ({ provider, label: PROVIDERS[provider]?.[0] || truncate(provider, 16), color: PROVIDERS[provider]?.[1] || PROVIDERS.other[1], tokens: round(tokens), share: providerTotal ? tokens / providerTotal : 0 }));
  const rank = Math.max(1, Math.floor(number(options.rank)));
  const totals = dailyTotals(entry);
  const model = {
    handle: anonymize ? "Anonymous" : text(entry.handle || "Profile"), team: anonymize ? "" : text(entry.team), hardware: anonymize ? "" : text(entry.hardware),
    tokensToday: round(entry.tokensToday), tokens7d: round(entry.tokens7d), tokensAll: round(entry.tokensAll),
    costAll: options.hideCost || entry.costAll == null ? null : number(entry.costAll), costToday: options.hideCost || entry.costToday == null ? null : number(entry.costToday),
    requestsAll: round(entry.requestsAll ?? (Array.isArray(entry.breakdown?.models) ? entry.breakdown.models : []).reduce((sum, row) => number(sum + number(row?.requests)), 0)), streakDays: Math.floor(number(entry.streakDays)),
    updatedAt: Number.isFinite(Number(entry.updatedAt)) && ogDay(entry.updatedAt) !== null ? number(entry.updatedAt) / (Number(entry.updatedAt) > 1e12 ? 1000 : 1) : 0,
    mix, history: [], season: options.season || null, includeLeagueRank: rankVisible, anonymize, fullTokenCounts: options.fullTokenCounts !== false,
    ...calendar(entry, round, totals)
  };
  model.history = model.calendarDays.filter(day => day.day <= model.calendarEnd).slice(-14).map(({ tokens }) => tokens);
  model.chartDays = model.calendarDays.filter(day => day.day <= model.calendarEnd).slice(-30).map(({ day, date, tokens }) => ({ day, date, tokens }));
  model.chartAvailable = model.calendarAvailable;
  colorProviderChart(entry, model, totals, normalize, options.fullTokenCounts === false, !anonymize && options.providerBreakdown !== false);
  if (rankVisible) Object.assign(model, { rank, rankToday: Math.max(1, Math.floor(number(options.rankToday))), total, percentile: Math.min(100, Math.max(1, Math.ceil(rank / total * 100))), league: text(st.league), leagueTitle: text(st.title || st.leagueTitle || st.league), leagueColor: /^#[a-f\d]{6}$/i.test(st.color || st.leagueColor || "") ? st.color || st.leagueColor : C.forest, division: Math.floor(number(st.division)), mmr: Math.floor(number(st.mmr)) });
  return model;
}

function compact(value) {
  const n = number(value);
  for (const [size, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n >= size) return (n / size).toFixed(n / size >= 100 ? 0 : n / size >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "") + suffix;
  }
  return Math.round(n).toLocaleString("en-US");
}
function t(x, y, value, size = 16, color = C.ink, weight = 400, attrs = "") {
  return `<text x="${x}" y="${y}" font-family="Token Horizon Sans" font-size="${size}" font-weight="${weight}" fill="${color}" ${attrs}>${esc(value)}</text>`;
}
function mono(x, y, value, size = 12, color = C.muted, attrs = "") {
  return `<text x="${x}" y="${y}" font-family="JetBrains Mono" font-size="${size}" fill="${color}" ${attrs}>${esc(value)}</text>`;
}
function eclipse(x, y, color, size = 28) {
  const r = size / 2;
  return `<circle cx="${x + r}" cy="${y + r}" r="${r - 1}" fill="none" stroke="${color}" stroke-width="1.6"/><path d="M${x + 2} ${y + r}H${x + size - 2}" stroke="${color}" stroke-width="1.6"/><path d="M${x + 5} ${y + r + 3}Q${x + r} ${y + size + 2} ${x + size - 5} ${y + r + 3}" fill="${color}"/>`;
}

export function renderProfileOgSvg(vm) {
  const handle = vm.anonymize ? "Anonymous" : "@" + vm.handle.replace(/^@/, "");
  const days = vm.calendarDays || [];
  const cellX = 490, cellY = 359, stepX = 33, stepY = 27, cellW = 24, cellH = 24;
  const chartDays = vm.chartDays || [];
  const chartMax = chartDays.reduce((max, point) => Math.max(max, point.tokens), 1);
  const chartBase = 278, chartHeight = 104, chartX = 490, chartWidth = 638;
  const chartStep = chartWidth / Math.max(1, chartDays.length);
  const chartBars = vm.chartAvailable ? chartDays.map((point, index) => {
    if (!point.tokens) return "";
    const height = Math.max(2, point.tokens / chartMax * chartHeight);
    const x = chartX + index * chartStep + 2;
    const width = Math.max(1, chartStep - 5);
    if (!point.segments?.length) return `<rect data-chart-day="${point.date}" x="${x.toFixed(2)}" y="${(chartBase - height).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="2" fill="${PROVIDERS.other[1]}"><title>${esc(point.date)} · ${esc(compact(point.tokens))} tokens</title></rect>`;
    let used = 0;
    const clip = `bar-${index}`;
    return `<defs><clipPath id="${clip}"><rect x="${x.toFixed(2)}" y="${(chartBase - height).toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="2"/></clipPath></defs><g clip-path="url(#${clip})">${point.segments.map((part, layer) => {
      const segmentHeight = layer === point.segments.length - 1 ? height - used : height * part.tokens / point.tokens;
      used += segmentHeight;
      return `<rect data-chart-day="${point.date}" data-chart-provider="${esc(part.provider)}" x="${x.toFixed(2)}" y="${(chartBase - used).toFixed(2)}" width="${width.toFixed(2)}" height="${Math.max(0, segmentHeight).toFixed(2)}" fill="${part.color}"><title>${esc(point.date)} · ${esc(part.label)} · ${esc(compact(part.tokens))} tokens</title></rect>`;
    }).join("")}</g>`;
  }).join("") : "";
  const chart = `<g data-usage-chart="daily-tokens">${[0, .5, 1].map(fraction => `<path d="M${chartX} ${chartBase - fraction * chartHeight}H1128" stroke="${C.line}" stroke-width="1"/>${mono(477, chartBase - fraction * chartHeight + 4, fraction === 0 ? "0" : compact(chartMax * fraction), 9, C.muted, 'text-anchor="end"')}`).join("")}${chartBars}${!vm.chartAvailable ? t(808, 234, "Daily usage not published", 17, C.muted, 400, 'text-anchor="middle"') : ""}${vm.chartAvailable ? mono(chartX, 296, shortDate(chartDays[0].day), 10) + mono(1128, 296, shortDate(chartDays.at(-1).day), 10, C.muted, 'text-anchor="end"') : ""}</g>`;
  let heatmap = "", months = "";
  let lastMonth = -1;
  for (let col = 0; col < 17; col++) {
    const first = days[col * 7];
    if (!first) continue;
    const date = new Date(first.day * DAY * 1000), month = date.getUTCMonth();
    if (month !== lastMonth && (vm.publishedDay !== null || vm.calendarAvailable)) months += mono(cellX + col * stepX, 348, date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), 10);
    lastMonth = month;
    for (let row = 0; row < 7; row++) {
      const d = days[col * 7 + row];
      const dateKnown = vm.publishedDay !== null || vm.calendarAvailable;
      heatmap += `<rect ${dateKnown ? `data-heatmap-day="${d.date}" ` : ""}x="${cellX + col * stepX}" y="${cellY + row * stepY}" width="${cellW}" height="${cellH}" rx="4" fill="${d.level < 0 ? C.paper : LEVELS[d.level]}"${d.level < 0 ? ` stroke="${C.line}" stroke-dasharray="2 3"` : ""}><title>${dateKnown ? `${esc(d.date)} · ${esc(compact(d.tokens))} tokens` : "Daily activity not published"}</title></rect>`;
    }
  }
  let providers = "";
  const legend = vm.chartProviderAvailable ? vm.chartProviders : vm.mix || [];
  if (legend.length) {
    providers = mono(454, 574, vm.chartProviderAvailable ? "PROVIDERS / 30D" : "ALL-TIME MIX", 8);
    let labelX = 565;
    const fontSize = Math.min(11, (577 - legend.length * 20) / legend.reduce((sum, p) => sum + truncate(p.label, 12).length + 5, 0) / .62);
    for (const p of legend) {
      const label = `${truncate(p.label, 12)} ${Math.round(p.share * 100)}%`;
      providers += `<circle cx="${labelX + 3}" cy="570" r="3" fill="${p.color}"/>` + t(labelX + 12, 574, label, fontSize, C.muted);
      labelX += label.length * fontSize * .62 + 20;
    }
  } else providers = mono(454, 574, "TOKENS TRACKED. PERSPECTIVE GAINED.", 10);
  const league = [vm.leagueTitle, roman(vm.division)].filter(Boolean).join(" ").toUpperCase();
  const badge = vm.includeLeagueRank ? mono(1142, 57, `#${vm.rank} OVERALL${league ? "  /  " + truncate(league, 22) : ""}`, 11, C.forest, 'text-anchor="end"') : mono(1142, 57, "PUBLISHED USAGE", 11, C.forest, 'text-anchor="end"');
  const leagueIcon = vm.includeLeagueRank ? ogLeagueIcon(vm.league) : "";
  const leagueArtwork = leagueIcon ? `<image data-league-icon="${esc(vm.league)}" x="286" y="491" width="92" height="92" href="${leagueIcon}"><title>${esc(league)} league badge</title></image>${mono(63, 550, truncate(league, 24), 11, C.mint)}` : "";
  const updated = vm.publishedDay === null ? "Publication date unavailable" : `Published through ${dateLabel(vm.publishedDay)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="card-title card-desc">
  <title id="card-title">${esc(handle)} · Token Horizon usage</title><desc id="card-desc">${esc(compact(vm.tokensAll))} all-time tokens. ${vm.calendarAvailable ? "30-day token usage chart above a 17-week published activity heatmap." : "Daily activity not published."}</desc>
  <rect width="1200" height="630" fill="${C.paper}"/><rect width="416" height="630" fill="${C.ink}"/>
  <path d="M416 0V630M454 87H1142M454 588H1142" stroke="${C.line}" stroke-width="1"/>
  ${eclipse(42, 34, C.mint)}${t(82, 57, "Token Horizon", 22, C.white, 600)}${badge}
  ${t(42, 135, truncate(handle, 19), 34, C.white, 600)}${t(43, 166, truncate(vm.team || "Your AI usage, made visible.", 34), 15, "#AAB8AD")}
  ${mono(44, 227, "ALL-TIME TOKENS", 12, "#AAB8AD")}${t(39, 310, compact(vm.tokensAll), 82, C.mint, 600, 'letter-spacing="-3"')}
  ${t(44, 340, "Every token tells a story.", 16, "#AAB8AD")}
  <path d="M44 371H372M44 486H372" stroke="#35463A"/>
  ${mono(44, 399, "TODAY", 10, "#AAB8AD")}${mono(217, 399, "LAST 7 DAYS", 10, "#AAB8AD")}
  ${t(42, 450, compact(vm.tokensToday), 36, C.white, 500)}${t(215, 450, compact(vm.tokens7d), 36, C.white, 500)}
  <circle cx="49" cy="520" r="4" fill="${C.mint}"/>${t(63, 526, `${vm.streakDays} day streak`, 19, C.white, 500)}
  ${leagueArtwork}
  ${mono(44, 593, vm.anonymize ? "token-horizon.dev" : `token-horizon.dev/u/${truncate(vm.handle, 22)}`, 10, "#AAB8AD")}
  ${t(454, 133, "Token usage", 27, C.ink, 600, 'letter-spacing="-0.5"')}${mono(1142, 133, "LAST 30 DAYS / UTC", 10, C.muted, 'text-anchor="end"')}${chart}
  ${t(454, 326, "Activity heatmap", 24, C.ink, 600, 'letter-spacing="-0.4"')}${mono(1142, 326, "17 WEEKS / UTC", 10, C.muted, 'text-anchor="end"')}
  ${months}${mono(455, 375, "M", 10)}${mono(455, 429, "W", 10)}${mono(455, 483, "F", 10)}${heatmap}
  ${t(1097, 417, vm.calendarAvailable ? vm.activeDays : "—", 40, C.forest, 600, 'text-anchor="middle"')}${mono(1097, 439, "ACTIVE DAYS", 8, C.muted, 'text-anchor="middle"')}
  ${mono(1054, 484, "LESS", 8)}${mono(1140, 484, "MORE", 8, C.muted, 'text-anchor="end"')}${LEVELS.map((fill, i) => `<rect x="${1054 + i * 18}" y="493" width="14" height="14" rx="2" fill="${fill}"/>`).join("")}
  ${!vm.calendarAvailable ? mono(490, 553, "Daily activity not published", 9) : ""}
  ${providers}${mono(454, 608, updated, 10)}${mono(1142, 608, "TOKEN HORIZON / PROFILE", 9, C.muted, 'text-anchor="end"')}
  </svg>`;
}

export function renderRestrictedOgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title"><title id="title">Private usage report · Token Horizon</title><rect width="1200" height="630" fill="${C.paper}"/><rect width="1200" height="90" fill="${C.ink}"/>${eclipse(42, 30, C.mint)}${t(82, 53, "Token Horizon", 22, C.white, 600)}${eclipse(545, 160, C.forest, 110)}${t(600, 340, "Private usage report", 48, C.ink, 600, 'text-anchor="middle"')}${t(600, 384, "Sign in to view this shared report.", 23, C.muted, 400, 'text-anchor="middle"')}<path d="M48 555H1152" stroke="${C.line}"/>${mono(48, 593, "token-horizon.dev", 12)}${mono(1152, 593, "YOUR USAGE. YOUR CONTROL.", 11, C.forest, 'text-anchor="end"')}</svg>`;
}
