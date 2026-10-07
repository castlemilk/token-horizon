/* Progressive exploration navigation. Ordinary links remain the routing fallback. */
(() => {
  "use strict";
  const script = document.currentScript || [...document.scripts].find(node => /(?:^|\/)explore-nav\.js(?:\?|$)/.test(node.src));
  const siteBase = new URL(".", script?.src || document.baseURI).href;
  const instances = [];
  const iconPaths = {
    explorer: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 4.8 4.8M7.5 10.5h6M10.5 7.5v6"/>',
    cheapest: '<path d="M4 4h8l8 8-8 8-8-8V4Z"/><circle cx="8.5" cy="8.5" r="1"/><path d="m11 15 4-4"/>',
    providers: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><rect x="14.5" y="14.5" width="6" height="6" rx="1"/><path d="M9.5 6.5h5M6.5 9.5v5M17.5 9.5v5M9.5 17.5h5"/>',
    plans: '<path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Zm-9 9 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
    rankings: '<circle cx="12" cy="7" r="3.5"/><path d="M5 20v-2a7 7 0 0 1 14 0v2H5Z"/>',
    "team-standings": '<circle cx="12" cy="7.5" r="3"/><path d="M6 20v-1a6 6 0 0 1 12 0v1H6ZM5 5a3 3 0 0 0 0 6m14-6a3 3 0 0 1 0 6M2 18v-1a5 5 0 0 1 3-4.6M22 18v-1a5 5 0 0 0-3-4.6"/>',
    "team-analytics": '<path d="M4 20V12M12 20V4M20 20V8M2 20h20"/>',
    leagues: '<path d="M7 3h10v6a5 5 0 0 1-10 0V3ZM7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4M12 14v6M8 21h8"/>'
  };
  const groups = {
    models: {
      label: "Models", title: "Find the model that fits.",
      description: "Compare capabilities, provider listings and pricing in one catalog.",
      links: [
        ["explorer", "Explorer", "Search models and capabilities.", "models/", "models", "explorer"],
        ["cheapest", "Cheapest", "Compare the lowest published prices.", "models/?tab=cheapest", "models", "cheapest"],
        ["providers", "Providers", "Explore providers and their listings.", "models/?tab=providers", "models", "providers"],
        ["plans", "Plans", "See subscription tiers and model coverage.", "models/?tab=plans", "models", "plans"]
      ]
    },
    community: {
      label: "Community", title: "Build in good company.",
      description: "Explore the activity builders and teams choose to publish.",
      links: [
        ["rankings", "Individual rankings", "Follow published individual usage.", "leaderboard.html", "leaderboard"],
        ["team-standings", "Team standings", "Compare teams and their shared usage.", "teams#tm-rankings-title", "teams"],
        ["team-analytics", "Team analytics", "Inspect daily activity and provider mix.", "teams?teamChart=history&teamDays=30#tm-analytics", "teams"],
        ["leagues", "Leagues", "Explore divisions and season progress.", "leaderboard.html?view=leagues", "leagues"]
      ]
    }
  };
  const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const chevron = svg('<path d="m7 10 5 5 5-5"/>');
  const arrow = svg('<path d="M4 12h16m-6-6 6 6-6 6"/>');

  // Relative to the document's effective base, including Worker-injected <base>.
  function relativeHref(path) {
    const target = new URL(path, siteBase);
    const base = new URL(".", document.baseURI);
    if (target.origin !== base.origin) return target.href;
    const from = base.pathname.split("/").filter(Boolean);
    const to = target.pathname.split("/").filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;
    let result = "../".repeat(from.length - common) + to.slice(common).join("/");
    if (target.pathname.endsWith("/") && result && !result.endsWith("/")) result += "/";
    if (!result.startsWith("../")) result = "./" + result;
    return result + target.search + target.hash;
  }
  function historyDays() {
    const params = new URL(location.href).searchParams;
    const days = Number(params.get("teamDays"));
    return params.get("teamChart") === "history" && [7, 30, 119].includes(days) ? days : 30;
  }
  function createLink(entry) {
    const [key, label, description, path, view, modelsTab] = entry;
    const link = document.createElement("a");
    link.className = "explore-link";
    link.dataset.exploreLink = key;
    link.dataset.exploreView = view;
    if (modelsTab) link.dataset.exploreModelsTab = modelsTab;
    link.href = relativeHref(path);
    link.innerHTML = `<span class="explore-icon">${svg(iconPaths[key])}</span><span class="explore-link-copy"><strong>${label}</strong><small>${description}</small></span><span class="explore-arrow">${arrow}</span>`;
    return link;
  }
  function createDirect(label, path, key, view) {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = relativeHref(path);
    link.dataset.exploreDirect = key;
    if (view) link.dataset.exploreView = view;
    return link;
  }
  function routeLink(event) {
    const link = event.target.closest("a[data-explore-view]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href);
    const detail = {
      url: url.href, view: link.dataset.exploreView,
      modelsTab: link.dataset.exploreModelsTab || null,
      teamChart: url.searchParams.get("teamChart"),
      teamDays: url.searchParams.has("teamDays") ? Number(url.searchParams.get("teamDays")) : null,
      anchor: url.hash
    };
    if (!document.dispatchEvent(new CustomEvent("tokenhorizon:explore-navigate", { cancelable: true, detail }))) event.preventDefault();
  }
  function enhance(nav) {
    if (!nav || nav.dataset.exploreEnhanced) return;
    const landing = nav.id === "main-nav";
    const header = nav.closest("header");
    if (!header) return;
    const media = matchMedia("(max-width: 1200px)");
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const id = nav.id + "-explore";
    const triggers = {}, mobile = {}, sections = {};
    const fragment = document.createDocumentFragment();
    const panel = document.createElement("div");
    panel.className = "explore-panel";
    panel.dataset.explorePanel = "";
    panel.id = id + "-panel";
    panel.hidden = true;
    panel.inert = true;
    panel.setAttribute("role", "group");
    Object.entries(groups).forEach(([key, group]) => {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "explore-trigger";
      trigger.dataset.exploreTrigger = key;
      trigger.id = id + "-" + key + "-trigger";
      trigger.setAttribute("aria-expanded", "false");
      trigger.innerHTML = `<span>${group.label}</span>${chevron}`;
      triggers[key] = trigger;
      fragment.append(trigger);
      const inline = document.createElement("div");
      inline.className = "explore-mobile";
      inline.dataset.exploreMobile = key;
      inline.id = id + "-" + key + "-mobile";
      inline.hidden = true;
      inline.setAttribute("role", "group");
      inline.setAttribute("aria-labelledby", trigger.id);
      group.links.forEach(entry => inline.append(createLink(entry)));
      mobile[key] = inline;
      fragment.append(inline);
      const section = document.createElement("div");
      section.className = "explore-section";
      section.dataset.exploreGroup = key;
      section.hidden = true;
      section.innerHTML = `<div class="explore-intro"><h2 id="${id}-${key}-title">${group.title}</h2><p>${group.description}</p><svg class="explore-horizon" viewBox="0 0 260 340" fill="none" aria-hidden="true" focusable="false"><path d="M-30 268H300M130-100C295 80 282 257 109 407M-32 383C15 227 160 174 315 160" stroke="currentColor" stroke-width="1"/><circle cx="195" cy="268" r="3" fill="currentColor"/></svg></div>`;
      const directory = document.createElement("div");
      directory.className = "explore-directory";
      group.links.forEach(entry => directory.append(createLink(entry)));
      section.append(directory);
      panel.append(section);
      sections[key] = section;
    });
    fragment.append(createDirect("Teams", "teams#tm-rankings-title", "teams", "teams"));
    // Move existing controls, retaining their styling and incumbent listeners.
    const originals = [...nav.querySelectorAll(":scope > a")];
    const retained = label => originals.find(link => link.textContent.trim().replace(/[↗→]/g, "").trim().toLowerCase() === label);
    const docs = retained("docs");
    fragment.append(docs || createDirect("Docs", "docs/", "docs"));
    const workspace = retained("workspace") || createDirect("Workspace", "leaderboard.html?view=dashboard", "workspace", "dashboard");
    workspace.removeAttribute("data-public-view");
    workspace.onclick = null;
    workspace.dataset.exploreDirect = "workspace";
    workspace.dataset.exploreView = "dashboard";
    workspace.href = relativeHref("leaderboard.html?view=dashboard");
    fragment.append(workspace);
    if (!landing) for (const [label, view] of [["Model costs", "billing"], ["Report sharing", "settings"]]) {
      const link = createDirect(label, "leaderboard.html?view=" + view, view, view);
      link.className = "workspace-nav-link";
      fragment.append(link);
    }
    if (landing && retained("connect")) fragment.append(retained("connect"));
    const github = originals.find(link => /^https:\/\/github\.com\//.test(link.href));
    if (github) fragment.append(github);
    const install = originals.find(link => link.classList.contains("nav-install") || link.classList.contains("discovery-install"));
    if (install) fragment.append(install);
    nav.replaceChildren(fragment);
    nav.dataset.exploreEnhanced = "true";
    header.classList.add("explore-header");
    header.append(panel);
    let active = null, closeTimer = 0, hideTimer = 0, layoutFrame = 0, suppressFocus = false;
    let input = "keyboard", openedBy = "";
    const links = () => active ? [...(media.matches ? mobile[active] : sections[active]).querySelectorAll("a")] : [];
    function cancelClose() { clearTimeout(closeTimer); closeTimer = 0; }
    function layout() {
      if (!active || media.matches || panel.hidden) return;
      const headerRect = header.getBoundingClientRect(), triggerRect = triggers[active].getBoundingClientRect();
      const width = Math.min(active === "models" ? 720 : 760, innerWidth - 32);
      const left = Math.max(16 - headerRect.left, Math.min(triggerRect.left - headerRect.left - width * .36, innerWidth - 16 - width - headerRect.left));
      panel.style.width = width + "px";
      panel.style.left = left + "px";
      panel.style.top = headerRect.height + 8 + "px";
      panel.style.setProperty("--explore-arrow-x", triggerRect.left + triggerRect.width / 2 - headerRect.left - left + "px");
      panel.style.height = sections[active].offsetHeight + 2 + "px";
    }
    function close({ restoreFocus = false, immediate = false } = {}) {
      cancelClose();
      clearTimeout(hideTimer);
      const previous = active;
      active = null;
      Object.keys(groups).forEach(key => {
        triggers[key].setAttribute("aria-expanded", "false");
        mobile[key].hidden = true;
      });
      panel.classList.remove("is-open");
      panel.inert = true;
      if (immediate || motion.matches || media.matches) panel.hidden = true;
      else hideTimer = setTimeout(() => { panel.hidden = true; }, 180);
      if (restoreFocus && previous) {
        suppressFocus = true;
        const visible = !nav.hidden && getComputedStyle(nav).display !== "none";
        (visible ? triggers[previous] : header.querySelector(".discovery-menu-toggle, .menu-toggle"))?.focus();
        queueMicrotask(() => { suppressFocus = false; });
      }
    }
    function open(key, focus = null, source = "keyboard") {
      if (!groups[key]) return;
      sync();
      cancelClose();
      clearTimeout(hideTimer);
      const wasHidden = panel.hidden;
      active = key;
      openedBy = source;
      Object.keys(groups).forEach(name => {
        triggers[name].setAttribute("aria-expanded", String(name === key));
        mobile[name].hidden = !media.matches || name !== key;
        sections[name].hidden = media.matches || name !== key;
      });
      if (media.matches) { panel.hidden = true; panel.inert = true; }
      else {
        panel.hidden = false;
        panel.inert = false;
        panel.dataset.activeGroup = key;
        panel.setAttribute("aria-labelledby", id + "-" + key + "-title");
        if (wasHidden) panel.classList.add("is-positioning");
        layout();
        if (wasHidden) { void panel.offsetWidth; panel.classList.remove("is-positioning"); }
        panel.classList.add("is-open");
      }
      if (focus) links()[focus === "last" ? links().length - 1 : 0]?.focus();
    }
    function scheduleClose() {
      cancelClose();
      closeTimer = setTimeout(() => {
        if (input === "keyboard" && (panel.contains(document.activeElement) || document.activeElement === triggers[active])) return;
        if (!panel.matches(":hover") && !Object.values(triggers).some(trigger => trigger.matches(":hover"))) close();
      }, 240);
    }
    function focusNext(key, direction) {
      const buttons = Object.keys(groups), next = buttons[(buttons.indexOf(key) + direction + buttons.length) % buttons.length];
      triggers[next].focus();
      open(next);
    }
    Object.entries(triggers).forEach(([key, trigger]) => {
      trigger.addEventListener("pointerenter", () => {
        if (!media.matches && finePointer.matches) { input = "pointer"; open(key, null, "hover"); }
      });
      trigger.addEventListener("pointerleave", () => { if (!media.matches && finePointer.matches) scheduleClose(); });
      trigger.addEventListener("focus", () => { if (!media.matches && input === "keyboard" && !suppressFocus) open(key, null, "focus"); });
      trigger.addEventListener("click", () => {
        if (active === key && openedBy !== "hover" && openedBy !== "focus") close();
        else open(key, null, "click");
      });
      trigger.addEventListener("keydown", event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault(); open(key, event.key === "ArrowUp" ? "last" : "first");
        } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault(); focusNext(key, event.key === "ArrowRight" ? 1 : -1);
        } else if (event.key === "Tab" && !event.shiftKey && active === key && !media.matches) {
          event.preventDefault(); links()[0]?.focus();
        }
      });
    });
    function linkKeys(event) {
      if (!active || !event.target.closest("a")) return;
      const list = links(), index = list.indexOf(event.target.closest("a"));
      if (index < 0) return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
      } else if (!media.matches && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const next = active === "models" ? "community" : "models";
        open(next, "first");
      } else if (!media.matches && event.key === "Tab" && ((event.shiftKey && index === 0) || (!event.shiftKey && index === list.length - 1))) {
        event.preventDefault();
        const previous = active;
        close();
        suppressFocus = true;
        const next = event.shiftKey ? triggers[previous] : previous === "models" ? triggers.community : nav.querySelector('[data-explore-direct="teams"]');
        next?.focus();
        queueMicrotask(() => { suppressFocus = false; });
      }
    }
    panel.addEventListener("keydown", linkKeys);
    nav.addEventListener("keydown", linkKeys);
    panel.addEventListener("pointerenter", cancelClose);
    panel.addEventListener("pointerleave", () => { if (finePointer.matches) scheduleClose(); });
    [nav, panel].forEach(surface => surface.addEventListener("click", event => {
      routeLink(event);
      if (event.target.closest("a")) {
        close({ immediate: true });
        if (landing && media.matches) {
          nav.classList.remove("open");
          header.querySelector(".menu-toggle")?.setAttribute("aria-expanded", "false");
        }
      }
    }));
    document.addEventListener("pointerdown", event => {
      input = "pointer";
      const insideInline = Object.values(mobile).some(group => group.contains(event.target));
      if (!insideInline && !panel.contains(event.target) && !event.target.closest("[data-explore-trigger]")) close({ restoreFocus: panel.contains(document.activeElement) });
    }, true);
    // Capture Escape so the first press collapses a mobile group before its parent disclosure.
    document.addEventListener("keydown", event => {
      input = "keyboard";
      if (event.key === "Escape" && active) {
        event.preventDefault(); event.stopImmediatePropagation(); close({ restoreFocus: true });
      }
    }, true);
    document.addEventListener("focusin", event => {
      if (active && !panel.contains(event.target) && !Object.values(triggers).includes(event.target) && !Object.values(mobile).some(group => group.contains(event.target))) close();
    });
    window.addEventListener("resize", () => {
      cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layout);
    });
    window.addEventListener("blur", () => close({ immediate: true }));
    function mode() {
      close({ immediate: true });
      Object.keys(groups).forEach(key => triggers[key].setAttribute("aria-controls", media.matches ? mobile[key].id : panel.id));
    }
    media.addEventListener("change", mode);
    const observer = new MutationObserver(() => {
      if (media.matches && (nav.hidden || getComputedStyle(nav).display === "none")) close({ immediate: true });
    });
    observer.observe(nav, { attributes: true, attributeFilter: ["hidden", "class"] });
    function sync() {
      const params = new URL(location.href).searchParams;
      const normalized = path => path.replace(/\/index\.html$/, "").replace(/\/$/, "");
      const path = normalized(location.pathname);
      const isRoute = name => path === normalized(new URL(name, siteBase).pathname);
      const relativePath = location.pathname.startsWith(new URL(siteBase).pathname) ? location.pathname.slice(new URL(siteBase).pathname.length) : "";
      const view = isRoute("teams") ? "teams" : isRoute("models") ? "models" : /^u\/[^/]+\/?$/.test(relativePath) || params.has("user") ? "player" : /^t\/[^/]+\/?$/.test(relativePath) ? "team" : params.get("view") || "leaderboard";
      const tab = params.get("tab") || "explorer";
      const analytics = "teams?teamChart=history&teamDays=" + historyDays() + "#tm-analytics";
      header.querySelectorAll('[data-explore-link="team-analytics"]').forEach(link => { link.href = relativeHref(analytics); });
      header.querySelectorAll("a[data-explore-view]").forEach(link => {
        let current = view === link.dataset.exploreView;
        if (current && view === "models") current = tab === link.dataset.exploreModelsTab;
        if (current && link.dataset.exploreLink === "team-analytics") current = params.get("teamChart") === "history";
        if (current && link.dataset.exploreLink === "team-standings") current = params.get("teamChart") !== "history";
        if (current && (!landing || params.has("view"))) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      triggers.models.classList.toggle("is-current", view === "models" && !landing);
      triggers.community.classList.toggle("is-current", ["leaderboard", "teams", "leagues", "team", "player", "players"].includes(view) && !landing);
    }
    mode(); sync();
    instances.push({ close, sync });
  }
  function init() { ["discovery-navigation", "main-nav"].forEach(id => enhance(document.getElementById(id))); }
  window.TokenHorizonExploreNav = {
    siteBase, init,
    close: options => instances.forEach(instance => instance.close(options)),
    sync: () => instances.forEach(instance => instance.sync())
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
  window.addEventListener("popstate", () => window.TokenHorizonExploreNav.sync());
})();
