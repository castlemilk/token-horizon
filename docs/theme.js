/* Shared theme control. Runs before paint on the connector's CSP-protected page,
   or after the tiny inline bootstrap on static pages. No data or chart rerender. */
(() => {
  "use strict";
  if (window.TokenHorizonTheme) { window.TokenHorizonTheme.mount(); return; }

  const storageKey = "th-theme";
  const root = document.documentElement;
  const valid = value => value === "light" || value === "dark";
  let preference = null;
  try { const saved = localStorage.getItem(storageKey); if (valid(saved)) preference = saved; } catch (_) {}
  let media;
  try { media = matchMedia("(prefers-color-scheme: dark)"); } catch (_) { media = { matches: false }; }
  const systemTheme = () => media.matches ? "dark" : "light";
  let theme = preference || systemTheme();

  function updateControls() {
    document.querySelectorAll(".th-theme-toggle").forEach(button => {
      const dark = theme === "dark";
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("title", label);
      button.dataset.theme = theme;
    });
  }

  function apply(next, announce = true) {
    const changed = root.dataset.theme !== next;
    theme = next;
    root.dataset.theme = next;
    root.style.colorScheme = next;
    updateControls();
    if (changed && announce) window.dispatchEvent(new CustomEvent("th:themechange", {
      detail: { theme, preference: preference || "system" }
    }));
  }

  function setTheme(next) {
    if (next !== "system" && !valid(next)) return;
    preference = next === "system" ? null : next;
    // Storage can be disabled in embedded or private contexts. The control must
    // still work for this document, including after the OS preference changes.
    try {
      if (preference) localStorage.setItem(storageKey, preference);
      else localStorage.removeItem(storageKey);
    } catch (_) {}
    apply(preference || systemTheme());
  }

  function mount(scope = document) {
    const slots = [...scope.querySelectorAll("[data-theme-control]")];
    if (scope.nodeType === 1 && scope.matches("[data-theme-control]")) slots.unshift(scope);
    slots.forEach(slot => {
      if (slot.querySelector(".th-theme-toggle")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "th-theme-toggle";
      button.innerHTML = '<svg class="th-theme-orbit" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g class="th-theme-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></g><g class="th-theme-moon"><path d="M20.4 14.4A8.5 8.5 0 0 1 9.6 3.6a8.5 8.5 0 1 0 10.8 10.8Z"/><path class="th-theme-star" d="M17 3v4m-2-2h4"/></g></svg><span class="th-theme-satellite" aria-hidden="true"></span>';
      button.addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
      slot.append(button);
    });
    updateControls();
  }

  window.TokenHorizonTheme = Object.freeze({
    mount,
    set: setTheme,
    get: () => ({ theme, preference: preference || "system" })
  });
  apply(theme, false);
  window.addEventListener("storage", event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : null;
    apply(preference || systemTheme());
  });
  const onSystemChange = () => { if (!preference) apply(systemTheme()); };
  if (media.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount(), { once: true });
  else mount();
})();
