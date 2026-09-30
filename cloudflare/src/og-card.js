// Pure, deterministic social card model and SVG. Rasterization lives in the Worker.
export const OG_CARD_VERSION = "horizon-3";

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

// Publication dates anchor old profiles: a historical card never drifts with the clock.
function calendar(entry, round) {
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
  const model = {
    handle: anonymize ? "Anonymous" : text(entry.handle || "Profile"), team: anonymize ? "" : text(entry.team), hardware: anonymize ? "" : text(entry.hardware),
    tokensToday: round(entry.tokensToday), tokens7d: round(entry.tokens7d), tokensAll: round(entry.tokensAll),
    costAll: options.hideCost || entry.costAll == null ? null : number(entry.costAll), costToday: options.hideCost || entry.costToday == null ? null : number(entry.costToday),
    requestsAll: round(entry.requestsAll ?? (Array.isArray(entry.breakdown?.models) ? entry.breakdown.models : []).reduce((sum, row) => number(sum + number(row?.requests)), 0)), streakDays: Math.floor(number(entry.streakDays)),
    updatedAt: Number.isFinite(Number(entry.updatedAt)) && ogDay(entry.updatedAt) !== null ? number(entry.updatedAt) / (Number(entry.updatedAt) > 1e12 ? 1000 : 1) : 0,
    mix, history: [], season: options.season || null, includeLeagueRank: rankVisible, anonymize, fullTokenCounts: options.fullTokenCounts !== false,
    ...calendar(entry, round)
  };
  model.history = model.calendarDays.filter(day => day.day <= model.calendarEnd).slice(-14).map(({ tokens }) => tokens);
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
  const cellX = 490, cellY = 224, stepX = 38, stepY = 34, cellW = 30, cellH = 28;
  let heatmap = "", months = "";
  let lastMonth = -1;
  for (let col = 0; col < 17; col++) {
    const first = days[col * 7];
    if (!first) continue;
    const date = new Date(first.day * DAY * 1000), month = date.getUTCMonth();
    if (month !== lastMonth && (vm.publishedDay !== null || vm.calendarAvailable)) months += mono(cellX + col * stepX, 207, date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), 11);
    lastMonth = month;
    for (let row = 0; row < 7; row++) {
      const d = days[col * 7 + row];
      const dateKnown = vm.publishedDay !== null || vm.calendarAvailable;
      heatmap += `<rect ${dateKnown ? `data-heatmap-day="${d.date}" ` : ""}x="${cellX + col * stepX}" y="${cellY + row * stepY}" width="${cellW}" height="${cellH}" rx="4" fill="${d.level < 0 ? C.paper : LEVELS[d.level]}"${d.level < 0 ? ` stroke="${C.line}" stroke-dasharray="2 3"` : ""}><title>${dateKnown ? `${esc(d.date)} · ${esc(compact(d.tokens))} tokens` : "Daily activity not published"}</title></rect>`;
    }
  }
  const label = vm.calendarAvailable ? `${shortDate(vm.calendarStart)} — ${shortDate(vm.calendarEnd)} · ${vm.activeDays} active days` : "Daily activity not published";
  let providers = "";
  if (vm.mix?.length) {
    providers = mono(454, 527, "PROVIDER MIX", 10);
    let x = 454;
    for (const p of vm.mix) {
      const width = p.share * 688;
      providers += `<rect x="${x.toFixed(2)}" y="541" width="${width.toFixed(2)}" height="5" fill="${p.color}"/>`;
      x += width;
    }
    let labelX = 454;
    for (const p of vm.mix) {
      providers += `<circle cx="${labelX + 3}" cy="565" r="3" fill="${p.color}"/>` + t(labelX + 12, 569, `${truncate(p.label, 13)} ${Math.round(p.share * 100)}%`, 12, C.muted);
      labelX += p.label.length * 6.1 + 60;
    }
  } else providers = mono(454, 553, "TOKENS TRACKED. PERSPECTIVE GAINED.", 11);
  const league = [vm.leagueTitle, roman(vm.division)].filter(Boolean).join(" ").toUpperCase();
  const badge = vm.includeLeagueRank ? mono(1142, 57, `#${vm.rank} OVERALL${league ? "  /  " + truncate(league, 22) : ""}`, 11, C.forest, 'text-anchor="end"') : mono(1142, 57, "PUBLISHED USAGE", 11, C.forest, 'text-anchor="end"');
  const updated = vm.publishedDay === null ? "Publication date unavailable" : `Published through ${dateLabel(vm.publishedDay)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="card-title card-desc">
  <title id="card-title">${esc(handle)} · Token Horizon usage</title><desc id="card-desc">${esc(compact(vm.tokensAll))} all-time tokens. ${vm.calendarAvailable ? "17-week published token activity heatmap." : "Daily activity not published."}</desc>
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
  ${mono(44, 593, vm.anonymize ? "token-horizon.dev" : `token-horizon.dev/u/${truncate(vm.handle, 22)}`, 10, "#AAB8AD")}
  ${t(454, 134, "Your usage, in orbit.", 32, C.ink, 600, 'letter-spacing="-0.6"')}${t(455, 165, "17 weeks of published token activity · UTC", 15, C.muted)}
  ${months}${mono(455, 243, "M", 10)}${mono(455, 311, "W", 10)}${mono(455, 379, "F", 10)}${heatmap}
  ${mono(490, 481, label, 10)}${mono(976, 481, "LESS", 9)}${LEVELS.map((fill, i) => `<rect x="${1013 + i * 20}" y="471" width="15" height="12" rx="2" fill="${fill}"/>`).join("")}${mono(1118, 481, "MORE", 9)}
  ${providers}${mono(454, 608, updated, 10)}${mono(1142, 608, "TOKEN HORIZON / PROFILE", 9, C.muted, 'text-anchor="end"')}
  </svg>`;
}

export function renderRestrictedOgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title"><title id="title">Private usage report · Token Horizon</title><rect width="1200" height="630" fill="${C.paper}"/><rect width="1200" height="90" fill="${C.ink}"/>${eclipse(42, 30, C.mint)}${t(82, 53, "Token Horizon", 22, C.white, 600)}${eclipse(545, 160, C.forest, 110)}${t(600, 340, "Private usage report", 48, C.ink, 600, 'text-anchor="middle"')}${t(600, 384, "Sign in to view this shared report.", 23, C.muted, 400, 'text-anchor="middle"')}<path d="M48 555H1152" stroke="${C.line}"/>${mono(48, 593, "token-horizon.dev", 12)}${mono(1152, 593, "YOUR USAGE. YOUR CONTROL.", 11, C.forest, 'text-anchor="end"')}</svg>`;
}
