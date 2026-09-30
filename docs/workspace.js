/* Token Horizon Workspace. Data is supplied by the authenticated route controller;
   this view never chooses a profile implicitly or reads a device over loopback. */
(function () {
  "use strict";

  const views = new WeakMap();
  const palette = ["#235e43", "#82b89c", "#78909d", "#adbdb5", "#d8dfda"];
  const compactFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const integerFormatter = new Intl.NumberFormat("en");
  const moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const present = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const compact = value => compactFormatter.format(num(value));
  const integer = value => integerFormatter.format(num(value));
  const money = value => num(value) > 0 ? moneyFormatter.format(num(value)) : "—";
  const paths = {
    overview: '<path d="M4 19V9m8 10V4m8 15v-7"/>',
    models: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5M12 13v8"/>',
    activity: '<path d="M7 3h7l4 4v14H6V3h1Zm6 0v5h5M9 12h6m-6 4h6"/>',
    optimize: '<path d="M19 3C9 3 4 7 5 13s8 6 11 1 3-11 3-11ZM4 21 15 9m-7 5h5"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    compare: '<path d="M4 7h15l-4-4m5 14H5l4 4M19 7l-4 4M5 17l4-4"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    device: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    retry: '<path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5"/>',
    folder: '<path d="M3 6h6l2 3h10v11H3V6Z"/>',
    source: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>'
  };
  const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.info}</svg>`;
  const modelLink = (m, label) => `<a class="tw-model-link" href="?view=models&amp;model=${encodeURIComponent(m.model || "")}" data-model-link data-model="${esc(m.model)}" data-provider="${esc(m.provider)}">${esc(label || m.model || "Unknown model")}</a>`;
  const provider = key => ({ claude: "Anthropic", anthropic: "Anthropic", openai: "OpenAI", codex: "OpenAI", google: "Google", gemini: "Google", openrouter: "OpenRouter", ollama: "Ollama", mlx: "MLX", grok: "xAI", xai: "xAI", deepseek: "DeepSeek", kimi: "Kimi", minimax: "MiniMax", qwen: "Qwen", glm: "GLM", other: "Other" }[String(key).toLowerCase()] || String(key || "Other"));
  const stamp = value => {
    if (value === null || value === undefined || value === "") return NaN;
    if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) return Date.parse(value);
    const n = num(value);
    return n > 1e12 ? n : n > 1e8 ? n * 1000 : n * 86400000;
  };
  const dateLabel = value => {
    const date = new Date(stamp(value));
    return Number.isFinite(date.getTime()) ? dayFormatter.format(date) : "Unknown date";
  };
  const sessionTime = value => {
    const date = new Date(stamp(value));
    if (!Number.isFinite(date.getTime())) return '<span>Time not published</span>';
    return `<time datetime="${date.toISOString()}">${esc(dateLabel(value))} · ${esc(timeFormatter.format(date))}</time>`;
  };
  const relative = value => {
    if (!value) return "Update time unavailable";
    const seconds = Math.max(0, Math.floor((Date.now() - stamp(value)) / 1000));
    if (!Number.isFinite(seconds)) return "Update time unavailable";
    if (seconds < 60) return "Just published";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  };
  const stale = entry => Number.isFinite(stamp(entry?.updatedAt)) && Date.now() - stamp(entry.updatedAt) > 86400000;
  const empty = (title, detail) => `<div class="tw-empty-panel"><p>${esc(title)}</p><span>${esc(detail)}</span></div>`;

  function profileControl(options, entry) {
    const profiles = (options.profiles || []).map(p => typeof p === "string" ? { handle: p } : p).filter(p => p && p.handle);
    const selected = options.selectedHandle || entry?.handle || "";
    const owned = options.signedIn && profiles.some(p => p.handle === selected);
    if (selected && !profiles.some(p => p.handle === selected)) profiles.unshift({ handle: selected });
    if (!profiles.length) return "";
    return `<label class="tw-profile"><span>${owned ? "Your profile" : "Published profile"}</span><select data-tw-profile aria-label="Select profile"><option value=""${!selected ? " selected" : ""}>Choose a profile</option>${profiles.map(p => `<option value="${esc(p.handle)}"${p.handle === selected ? " selected" : ""}>${esc(p.displayName || p.handle)}${p.displayName ? " · @" + esc(p.handle) : ""}</option>`).join("")}</select></label>`;
  }

  function heading(options, entry) {
    const old = stale(entry);
    const knownTime = Number.isFinite(stamp(entry?.updatedAt));
    const description = knownTime ? `Published ${new Date(stamp(entry.updatedAt)).toLocaleString()}.${old ? " This snapshot is more than 24 hours old. Its daily and weekly totals describe the period at publication." : ""}` : "The publisher did not include an update time.";
    return `<header class="tw-heading"><div><div class="tw-eyebrow">TOKEN HORIZON / OBSERVABILITY</div><h1>Workspace</h1><p>Understand your usage. Find your next improvement.</p></div><div class="tw-heading-controls">${profileControl(options, entry)}${entry ? `<div class="tw-source${old ? " tw-source-stale" : !knownTime ? " tw-source-unknown" : ""}" title="${esc(description)}"><i></i><span>${old ? "Historical snapshot" : "Published snapshot"}<small>${esc(relative(entry.updatedAt))}</small></span>${icon("info")}</div>` : ""}</div></header>`;
  }

  function skeleton(options) {
    return `<section class="th-workspace" aria-busy="true">${heading(options, null)}<div class="tw-loading-message" role="status"><span class="tw-eclipse" aria-hidden="true"></span>Opening your workspace<span class="tw-loading-detail">Loading the published snapshot…</span></div><div class="tw-skeleton-summary" aria-hidden="true">${Array.from({ length: 4 }, () => '<div><i></i><b></b><i></i></div>').join("")}</div><div class="tw-overview-grid tw-skeleton-panels" aria-hidden="true"><div class="tw-panel"><i></i><div class="tw-skeleton-chart">${[25, 32, 19, 43, 48, 32, 64, 53, 78, 65, 88, 72].map(h => `<b style="height:${h}%"></b>`).join("")}</div></div><div class="tw-panel">${Array.from({ length: 3 }, () => '<div class="tw-skeleton-row"><i></i><b></b><i></i></div>').join("")}</div></div></section>`;
  }

  function onboarding(options) {
    const error = options.error;
    return `<section class="th-workspace">${heading(options, null)}<div class="tw-welcome"><div class="tw-welcome-art" aria-hidden="true"><span class="tw-eclipse"></span><span class="tw-orbit"></span></div><div class="tw-welcome-copy"><span class="tw-eyebrow">YOUR MODELS. YOUR ACTIVITY.</span><h2>${error ? "The snapshot couldn’t load." : "Your AI activity, in one clear view."}</h2><p>${error ? esc(error) : "See token usage, model costs, session activity, and opportunities to optimize. Choose a published profile, or sign in to find the profiles you own."}</p><div class="tw-actions">${error ? `<button class="tw-button tw-primary" data-tw-retry>${icon("retry")}Try again</button>` : !options.signedIn ? '<button class="tw-button tw-primary" data-tw-signin>Sign in to your workspace</button>' : '<a class="tw-button tw-primary" href="./docs/#leaderboard">Publish from the desktop app</a>'}<a class="tw-button" href="tokenhorizon://dashboard">${icon("device")}Open desktop app</a></div><form class="tw-handle-form" data-tw-open-profile><label for="tw-public-handle">Or open a published profile</label><div><span aria-hidden="true">@</span><input id="tw-public-handle" data-tw-handle name="handle" placeholder="Profile handle" aria-label="Published profile handle" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" required value="${esc(options.selectedHandle || "")}"/><button class="tw-button" type="submit">Open profile ${icon("arrow")}</button></div></form><p class="tw-welcome-note">${icon("lock")}Full traces and device telemetry stay on your device.</p></div></div><div class="tw-feature-grid">${[["overview", "Usage that adds up", "Explore published tokens, requests, and costs across your models."], ["activity", "Context for your activity", "Follow recent sessions and project totals without exposing private titles."], ["optimize", "Evidence for better choices", "Find cost concentrations and compare equivalent model listings."]].map(([key, title, text]) => `<div>${icon(key)}<h3>${title}</h3><p>${text}</p></div>`).join("")}</div>${localStrip()}</section>`;
  }

  function localStrip() {
    return `<aside class="tw-local-strip">${icon("device")}<div><strong>Local traces stay on your device</strong><p>Inspect full traces, plan limits, system telemetry, and inference engines in the desktop app.</p></div><a class="tw-button" href="tokenhorizon://dashboard">Open desktop workspace ${icon("external")}</a></aside>`;
  }

  function summary(entry, response, state) {
    const key = { today: "Today", week: "7d", all: "All" }[state.period];
    const old = stale(entry);
    const label = { today: old ? "Snapshot day" : "Today", week: old ? "7 days at snapshot" : "Last 7 days", all: "All time" }[state.period];
    const requestsKey = state.period === "today" ? "requestsToday" : "requestsAll";
    const requests = entry[requestsKey] ?? response[requestsKey];
    const requestLabel = state.period === "today" ? (old ? "Snapshot day" : "Today") : "All time";
    const models = entry.breakdown?.models || [];
    return `<div class="tw-summary" aria-label="Usage summary"><div><span>Tokens</span><strong>${present(entry["tokens" + key]) ? compact(entry["tokens" + key]) : "—"}</strong><small>${label}</small></div><div><span>Estimated cost <span title="Published usage estimates in USD, not a provider invoice. Cost dashes mean zero, hidden, or unavailable; published data does not distinguish them.">${icon("info")}</span></span><strong class="${num(entry["cost" + key]) ? "" : "tw-unavailable"}">${money(entry["cost" + key])}</strong><small>${label} · USD</small></div><div><span>Requests</span><strong>${present(requests) ? compact(requests) : "—"}</strong><small>${present(requests) ? requestLabel : "Not published"}</small></div><div><span>Active models</span><strong>${integer(models.filter(m => num(m.tokensAll) > 0).length)}</strong><small>All time · published models</small></div></div><p class="tw-cost-note">Cost dashes mean zero, hidden, or unavailable; published data does not distinguish them.</p>`;
  }

  function chart(entry, state) {
    const history = entry.breakdown?.modelHistory || [];
    const series = new Map();
    const dayMap = new Map();
    for (const model of history) {
      const name = model.model === "Other" ? "Other" : provider(model.provider);
      if (!series.has(name)) series.set(name, new Map());
      for (const point of model.points || []) {
        const day = String(point.day);
        dayMap.set(day, point.dayLabel || dateLabel(point.day));
        series.get(name).set(day, (series.get(name).get(day) || 0) + num(point.tokens));
      }
    }
    if (!series.size) {
      const daily = entry.breakdown?.daily?.length ? entry.breakdown.daily : entry.breakdown?.history || [];
      const points = new Map();
      for (const point of daily) { const day = String(point.day); dayMap.set(day, point.dayLabel || dateLabel(point.day)); points.set(day, num(point.tokens)); }
      if (points.size) series.set("Tokens", points);
    }
    const days = [...dayMap.keys()].sort((a, b) => stamp(a) - stamp(b)).slice(state.period === "all" ? -28 : -7);
    const ranked = [...series.entries()].map(([name, points]) => ({ name, points, total: days.reduce((sum, day) => sum + (points.get(day) || 0), 0) })).sort((a, b) => b.total - a.total);
    let plotted = ranked.slice(0, 4);
    if (ranked.length > 4) {
      const points = new Map(days.map(day => [day, ranked.slice(4).reduce((sum, s) => sum + (s.points.get(day) || 0), 0)]));
      plotted.push({ name: "Other", points, total: [...points.values()].reduce((a, b) => a + b, 0) });
    }
    const total = plotted.reduce((sum, s) => sum + s.total, 0);
    const max = Math.max(1, ...days.map(day => plotted.reduce((sum, s) => sum + (s.points.get(day) || 0), 0)));
    const w = 720, h = 226, left = 49, top = 18, bottom = 192, right = 704;
    const step = (right - left) / Math.max(1, days.length);
    const barWidth = Math.min(48, step * .66);
    let bars = "";
    days.forEach((day, i) => {
      let y = bottom;
      const dayTotal = plotted.reduce((sum, s) => sum + (s.points.get(day) || 0), 0);
      const rects = plotted.map((s, j) => {
        const height = (s.points.get(day) || 0) / max * (bottom - top);
        y -= height;
        return `<rect x="${left + i * step + (step - barWidth) / 2}" y="${y}" width="${barWidth}" height="${height}" fill="${palette[j]}"/>`;
      }).join("");
      bars += `<g><title>${esc(dayMap.get(day))}: ${integer(dayTotal)} tokens${plotted.map(s => `; ${esc(s.name)} ${integer(s.points.get(day) || 0)}`).join("")}</title>${rects}</g>`;
      if (days.length <= 8 || i % Math.ceil(days.length / 7) === 0 || i === days.length - 1) bars += `<text x="${left + i * step + step / 2}" y="214" text-anchor="middle">${esc(dayMap.get(day))}</text>`;
    });
    const grid = [0, .25, .5, .75, 1].map(t => `<line x1="${left}" x2="${right}" y1="${bottom - t * (bottom - top)}" y2="${bottom - t * (bottom - top)}"/><text x="${left - 10}" y="${bottom - t * (bottom - top) + 4}" text-anchor="end">${compact(max * t)}</text>`).join("");
    return `<section class="tw-panel tw-usage"><div class="tw-panel-heading"><div><h2>Token usage</h2><span>${days.length ? `${days.length} published days · ${esc(dayMap.get(days[0]))} – ${esc(dayMap.get(days[days.length - 1]))}` : "Daily history"}</span></div><span class="tw-label">${history.length ? "By provider" : "Total tokens"}</span></div>${days.length ? `<svg class="tw-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(integer(total) + " published tokens across " + days.length + " days, grouped by provider")}">${grid}${bars}</svg><div class="tw-chart-legend">${plotted.map((s, i) => `<span><i style="background:${palette[i]}"></i>${esc(s.name)}<b>${total ? Math.round(s.total / total * 100) : 0}%</b></span>`).join("")}</div>` : empty("No daily history published", "Your next desktop sync can include usage history.")}${tokenClasses(entry)}</section>`;
  }

  function tokenClasses(entry) {
    const input = entry.inputTokensAll, output = entry.outputTokensAll;
    return `<div class="tw-token-classes"><div><span>Input tokens</span><strong>${present(input) ? compact(input) : "—"}</strong><small>${present(input) ? "All time" : "Not published"}</small></div><div><span>Output tokens</span><strong>${present(output) ? compact(output) : "—"}</strong><small>${present(output) ? "All time" : "Not published"}</small></div><div><span>Cache reads</span><strong class="tw-unavailable">—</strong><small>Not published</small></div><div><span>Cache writes</span><strong class="tw-unavailable">—</strong><small>Not published</small></div></div>`;
  }

  function opportunities(entry, expanded) {
    const models = [...(entry.breakdown?.models || [])].sort((a, b) => num(b.costAll) - num(a.costAll));
    const costs = models.reduce((sum, m) => sum + num(m.costAll), 0);
    const sessions = [...(entry.breakdown?.sessions || [])].sort((a, b) => num(b.tokens) - num(a.tokens));
    const top = models.find(m => m.model);
    const items = [];
    if (top) items.push({ icon: "compare", type: "Model choice", title: "Compare provider listings", text: "Check equivalent model listings before choosing where to route your next request.", evidence: `${top.model}${num(top.tokensAll) ? " · " + compact(top.tokensAll) + " published tokens" : ""}`, action: modelLink(top, "Compare listings →") });
    if (costs > 0 && num(models[0].costAll) > 0) items.push({ icon: "optimize", type: "Cost focus", title: "Start with your largest model cost", text: `${models[0].model} accounts for ${Math.round(num(models[0].costAll) / costs * 100)}% of published model costs. Review whether its capabilities match each task.`, evidence: `${money(models[0].costAll)} of ${money(costs)} · all time`, action: '<button class="tw-text-button" data-tw-jump="models">Review model costs →</button>' });
    if (sessions.length && num(sessions[0].tokens) > 0) items.push({ icon: "activity", type: "Activity", title: "Review your largest session", text: "Inspect its context and repeated work in the desktop app to decide where to simplify.", evidence: `${compact(sessions[0].tokens)} tokens · ${dateLabel(sessions[0].at)}`, action: '<button class="tw-text-button" data-tw-jump="activity">View published sessions →</button>' });
    if (!items.length) items.push({ icon: "source", type: "Next step", title: "Publish a usage snapshot", text: "Model and session breakdowns turn usage totals into specific places to investigate.", evidence: "Publish from Token Horizon on your device", action: '<a class="tw-text-button" href="tokenhorizon://dashboard">Open desktop app →</a>' });
    return `<section class="tw-panel tw-opportunities"><div class="tw-panel-heading"><h2>${icon("optimize")}Opportunities</h2>${expanded ? '<span class="tw-label">Evidence, not estimated savings</span>' : '<button class="tw-text-button" data-tw-jump="optimize">View all →</button>'}</div>${items.slice(0, expanded ? items.length : 3).map(item => `<article class="tw-opportunity"><div class="tw-op-icon">${icon(item.icon)}</div><div><div class="tw-op-title"><h3>${esc(item.title)}</h3><span>${esc(item.type)}</span></div><p>${esc(item.text)}</p><div class="tw-evidence"><span>Evidence</span>${esc(item.evidence)}</div>${item.action}</div></article>`).join("")}${expanded ? '<div class="tw-method-note">No savings are assumed. Provider prices, task quality, and your subscription coverage affect the right choice.</div>' : ""}</section>`;
  }

  function modelsPanel(entry, state, expanded) {
    return `<section class="tw-panel tw-models"><div class="tw-panel-heading"><div><h2>Model activity</h2><span>All time · ${integer((entry.breakdown?.models || []).length)} published models</span></div>${!expanded ? '<button class="tw-text-button" data-tw-jump="models">View all →</button>' : '<a class="tw-text-button" href="?view=models" data-models-all>Model directory ↗</a>'}</div>${expanded ? `<div class="tw-table-controls"><label class="tw-search">${icon("search")}<input type="search" data-tw-search placeholder="Search your models or providers" aria-label="Search published models" value="${esc(state.search)}" /></label><label class="tw-sort">Sort by<select data-tw-sort aria-label="Sort published models"><option value="tokens"${state.sort === "tokens" ? " selected" : ""}>Token usage</option><option value="cost"${state.sort === "cost" ? " selected" : ""}>Estimated cost</option><option value="requests"${state.sort === "requests" ? " selected" : ""}>Requests</option><option value="name"${state.sort === "name" ? " selected" : ""}>Model name</option></select></label></div>` : ""}<div data-tw-model-table>${modelTable(entry, state, expanded)}</div></section>`;
  }

  function modelTable(entry, state, expanded) {
    const all = entry.breakdown?.models || [];
    const query = expanded ? state.search.toLowerCase().trim() : "";
    const filtered = all.filter(m => !query || `${m.model} ${provider(m.provider)}`.toLowerCase().includes(query));
    const sort = expanded ? state.sort : "tokens";
    filtered.sort((a, b) => sort === "name" ? String(a.model).localeCompare(String(b.model)) : sort === "cost" ? num(b.costAll) - num(a.costAll) : sort === "requests" ? num(b.requests) - num(a.requests) : num(b.tokensAll) - num(a.tokensAll));
    const limit = expanded ? state.modelLimit : 6;
    const rows = filtered.slice(0, limit);
    if (!rows.length) return empty(query ? "No matching models" : "No model breakdown published", query ? "Try another model or provider name." : "Publish model activity from the desktop app to see costs and token splits here.");
    return `<div class="tw-table-scroll"><table class="tw-table"><thead><tr><th scope="col">Model / provider</th>${expanded ? '<th scope="col" class="tw-numeric">Input tokens</th><th scope="col" class="tw-numeric">Output tokens</th>' : ""}<th scope="col" class="tw-numeric">Tokens</th><th scope="col" class="tw-numeric">Est. cost</th><th scope="col" class="tw-numeric">Requests</th></tr></thead><tbody>${rows.map(m => `<tr><td><div class="tw-model-name"><span class="tw-provider-mark" aria-hidden="true">${esc(provider(m.provider).slice(0, 1))}</span><div>${modelLink(m)}<small>${esc(provider(m.provider))}</small></div></div></td>${expanded ? `<td class="tw-numeric">${present(m.inputTokens) ? compact(m.inputTokens) : "—"}</td><td class="tw-numeric">${present(m.outputTokens) ? compact(m.outputTokens) : "—"}</td>` : ""}<td class="tw-numeric tw-emphasis">${compact(m.tokensAll)}</td><td class="tw-numeric ${num(m.costAll) ? "" : "tw-cell-unavailable"}">${money(m.costAll)}</td><td class="tw-numeric">${present(m.requests) ? integer(m.requests) : "—"}</td></tr>`).join("")}</tbody></table></div>${expanded ? `<div class="tw-table-foot"><span role="status">${integer(Math.min(limit, filtered.length))} of ${integer(filtered.length)} models${query ? " match your search" : ""}</span>${filtered.length > limit ? '<button class="tw-text-button" data-tw-more>Show more models</button>' : '<span>Costs in USD · published estimates</span>'}</div>` : ""}`;
  }

  function sessionsPanel(entry, expanded) {
    const sessions = [...(entry.breakdown?.sessions || [])].sort((a, b) => num(b.at) - num(a.at)).slice(0, expanded ? 100 : 5);
    return `<section class="tw-panel tw-sessions"><div class="tw-panel-heading"><div><h2>Recent sessions</h2><span>Published metadata · local time</span></div>${!expanded ? '<button class="tw-text-button" data-tw-jump="activity">View all →</button>' : `<span class="tw-label">${integer(sessions.length)} sessions</span>`}</div>${sessions.length ? `<div class="tw-table-scroll"><table class="tw-table"><thead><tr><th scope="col">Session / model</th><th scope="col" class="tw-numeric">Tokens</th><th scope="col" class="tw-numeric">Cost</th></tr></thead><tbody>${sessions.map(s => `<tr><td><div class="tw-session-title">${s.title ? esc(s.title) : icon("lock") + '<span>Private session</span>'}</div><div class="tw-session-meta">${sessionTime(s.at)}${s.model ? modelLink(s) : esc(provider(s.provider))}</div></td><td class="tw-numeric">${compact(s.tokens)}</td><td class="tw-numeric ${num(s.cost) ? "" : "tw-cell-unavailable"}">${money(s.cost)}</td></tr>`).join("")}</tbody></table></div>` : empty("No session metadata published", "Sessions appear after your desktop app publishes them. Private titles remain private.")}<div class="tw-method-note">${icon("lock")}Only published metadata is shown. Full prompts and traces remain on your device.</div></section>`;
  }

  function projectsPanel(entry) {
    const projects = [...(entry.breakdown?.projects || [])].sort((a, b) => num(b.tokens) - num(a.tokens)).slice(0, 20);
    const max = Math.max(1, ...projects.map(p => num(p.tokens)));
    return `<section class="tw-panel"><div class="tw-panel-heading"><h2>${icon("folder")}Projects</h2><span class="tw-label">Published totals</span></div>${projects.length ? `<div class="tw-projects">${projects.map(p => `<div class="tw-project"><div><strong>${esc(p.project || "Unnamed project")}</strong><span>${compact(p.tokens)} tokens · ${money(p.cost)}</span></div><div class="tw-meter"><i style="width:${num(p.tokens) / max * 100}%"></i></div><small>${present(p.sessions) ? integer(p.sessions) + " sessions" : "Session count not published"}</small></div>`).join("")}</div>` : empty("No project breakdown published", "Project totals appear when included in your desktop snapshot.")}</section>`;
  }

  function sourcesPanel(entry) {
    const tools = [...(entry.breakdown?.tools || [])].sort((a, b) => num(b.tokensAll) - num(a.tokensAll));
    return `<section class="tw-panel"><div class="tw-panel-heading"><h2>${icon("source")}Capture sources</h2><span class="tw-label">All time</span></div>${tools.length ? `<div class="tw-sources">${tools.map(tool => `<div><span class="tw-provider-mark" aria-hidden="true">${esc(String(tool.tool || "?").slice(0, 1).toUpperCase())}</span><strong>${esc(tool.tool || "Unknown source")}</strong><span>${compact(tool.tokensAll)} tokens</span></div>`).join("")}</div>` : empty("Source breakdown not published", "Your local app shows the tools and providers behind each usage record.")}</section>`;
  }

  function draw(view) {
    const { options, state } = view;
    const host = options.host;
    const response = options.entry || {};
    const rawEntry = response.entry || response.profile?.entry || response.profile || options.entry;
    // The profile API may supply exact totals accumulated from published model
    // rows when older publishers omitted the matching entry-level fields.
    const entry = rawEntry && { ...rawEntry,
      inputTokensAll: response.inputTokensAll ?? rawEntry.inputTokensAll,
      outputTokensAll: response.outputTokensAll ?? rawEntry.outputTokensAll,
      requestsAll: response.requestsAll ?? rawEntry.requestsAll
    };
    if (options.loading && !entry) host.innerHTML = skeleton(options);
    else if (!entry) host.innerHTML = onboarding(options);
    else {
      const tabs = [["overview", "Overview"], ["models", "Models & costs"], ["activity", "Activity"], ["optimize", "Optimize"]];
      const content = state.tab === "models" ? `${modelsPanel(entry, state, true)}<div class="tw-data-note">Input and output counts are published independently. Cache classifications are available locally and are not inferred from the difference.</div>` : state.tab === "activity" ? `${sessionsPanel(entry, true)}<div class="tw-overview-grid tw-lower-grid">${projectsPanel(entry)}${sourcesPanel(entry)}</div>` : state.tab === "optimize" ? `${opportunities(entry, true)}<div class="tw-visibility"><div>${icon("source")}<h2>Complete the picture locally</h2><p>Cache reuse, request latency, errors, and quota headroom require device data. Open your desktop workspace to inspect them alongside full traces.</p></div><a class="tw-button" href="tokenhorizon://dashboard">Open desktop app ${icon("external")}</a></div>` : `<div class="tw-overview-grid">${chart(entry, state)}${opportunities(entry, false)}</div><div class="tw-overview-grid tw-lower-grid">${modelsPanel(entry, state, false)}${sessionsPanel(entry, false)}</div>`;
      host.innerHTML = `<section class="th-workspace">${heading(options, entry)}${options.error ? `<div class="tw-alert" role="status">${esc(options.error)}<button class="tw-text-button" data-tw-retry>Retry update</button></div>` : ""}<div class="tw-toolbar"><nav class="tw-tabs" aria-label="Workspace sections">${tabs.map(([key, label]) => `<button data-tw-tab="${key}"${key === state.tab ? ' aria-current="page" class="active"' : ""}>${icon(key)}${label}</button>`).join("")}</nav><div class="tw-period" role="group" aria-label="Summary period">${[["today", "Today"], ["week", "7 days"], ["all", "All time"]].map(([key, label]) => `<button data-tw-period="${key}" aria-pressed="${key === state.period}">${label}</button>`).join("")}</div></div>${summary(entry, response, state)}${content}${localStrip()}<footer class="tw-footnote">Viewing @${esc(entry.handle || options.selectedHandle)} · Published snapshot${options.loading ? ' <span role="status">· Refreshing…</span>' : ""}<span>Private data stays local</span></footer></section>`;
    }
    wire(view, entry);
  }

  function wire(view, entry) {
    const { host } = view.options;
    host.querySelector("[data-tw-profile]")?.addEventListener("change", event => view.options.onSelect?.(event.target.value));
    host.querySelector("[data-tw-signin]")?.addEventListener("click", () => view.options.onSignIn?.());
    host.querySelector("[data-tw-retry]")?.addEventListener("click", () => view.options.onRetry?.());
    host.querySelector("[data-tw-open-profile]")?.addEventListener("submit", event => {
      event.preventDefault();
      const input = host.querySelector("[data-tw-handle]");
      const handle = input.value.trim().replace(/^@/, "");
      if (handle) view.options.onSelect?.(handle);
      else input.focus();
    });
    host.querySelectorAll("[data-tw-tab], [data-tw-jump]").forEach(button => button.addEventListener("click", () => {
      view.state.tab = button.dataset.twTab || button.dataset.twJump;
      draw(view);
      host.querySelector(`[data-tw-tab="${view.state.tab}"]`)?.focus({ preventScroll: true });
    }));
    host.querySelectorAll("[data-tw-period]").forEach(button => button.addEventListener("click", () => {
      view.state.period = button.dataset.twPeriod;
      draw(view);
      host.querySelector(`[data-tw-period="${view.state.period}"]`)?.focus({ preventScroll: true });
    }));
    const refreshTable = () => {
      const target = host.querySelector("[data-tw-model-table]");
      if (!target) return;
      target.innerHTML = modelTable(entry, view.state, true);
      target.querySelector("[data-tw-more]")?.addEventListener("click", () => { view.state.modelLimit += 50; refreshTable(); });
    };
    host.querySelector("[data-tw-search]")?.addEventListener("input", event => { view.state.search = event.target.value; view.state.modelLimit = 50; refreshTable(); });
    host.querySelector("[data-tw-sort]")?.addEventListener("change", event => { view.state.sort = event.target.value; refreshTable(); });
    host.querySelector("[data-tw-more]")?.addEventListener("click", () => { view.state.modelLimit += 50; refreshTable(); });
  }

  function render(options) {
    if (!options?.host) throw new Error("Workspace render requires a host element");
    let view = views.get(options.host);
    if (!view) { view = { options, state: { tab: "overview", period: "week", search: "", sort: "tokens", modelLimit: 50 } }; views.set(options.host, view); }
    if (view.options.selectedHandle !== options.selectedHandle) { view.state.search = ""; view.state.modelLimit = 50; }
    view.options = options;
    draw(view);
  }

  window.TokenHorizonWorkspace = { render };
})();
