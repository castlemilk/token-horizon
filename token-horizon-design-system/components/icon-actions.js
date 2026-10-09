/* Shared icon actions. Native links/buttons own activation; help adds context. */
(() => {
  "use strict";
  const paths = {
    rankings: '<path d="M3 20V11h6v9m0 0V4h6v16m0 0v-6h6v6M2 20h20"/>',
    analytics: '<path d="M3 20h18M6 16v-4m6 4V5m6 11V8"/>',
    crew: '<circle cx="8" cy="8" r="3"/><path d="M2 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 5 5v1"/>',
    invite: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m3-14v6m-3-3h6"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    share: '<path d="M12 16V3m-4 4 4-4 4 4M4 13v7h16v-7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let sequence = 0;
  function icon(name) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.about}</svg>`;
  }
  function render({ icon: name, label, description, href, tag, attributes = {}, className = "" }) {
    const element = tag === "summary" ? "summary" : href != null ? "a" : "button";
    const id = "th-action-tip-" + ++sequence;
    const extra = Object.entries(attributes).filter(([key]) => /^(data-|aria-)[\w-]+$/.test(key)).map(([key, value]) => ` ${key}="${escape(value)}"`).join("");
    return `<${element}${element === "button" ? ' type="button"' : element === "a" ? ` href="${escape(href)}"` : ""} class="th-icon-action ${escape(className)}" data-icon-action="${escape(name)}" aria-label="${escape(label)}" aria-describedby="${id}-description"${extra}>${icon(name)}<span class="th-action-name">${escape(label)}</span><span class="th-action-tooltip" id="${id}" role="tooltip" hidden><strong data-icon-action-title aria-hidden="true">${escape(label)}</strong><span id="${id}-description" data-icon-action-description>${escape(description)}</span></span></${element}>`;
  }
  function update(element, { icon: name, label, description }) {
    if (!element?.matches("[data-icon-action]")) return;
    if (name) { element.querySelector("svg").outerHTML = icon(name); element.dataset.iconAction = name; }
    const tip = document.getElementById(element.getAttribute("aria-describedby"))?.closest("[role=tooltip]");
    if (label != null) {
      element.setAttribute("aria-label", label);
      element.querySelector(".th-action-name").textContent = label;
      if (tip) tip.querySelector("[data-icon-action-title]").textContent = label;
    }
    if (description != null && tip) tip.querySelector("[data-icon-action-description]").textContent = description;
    if (active?.trigger === element) position();
  }
  let active = null, dismissed = null, leaveTimer = null, hold = null, suppress = null;
  const observer = new MutationObserver(() => { if (active && !active.trigger.isConnected) hide(); });
  const action = node => node instanceof Element ? node.closest("[data-icon-action]") : null;
  const stopLeave = () => { clearTimeout(leaveTimer); leaveTimer = null; };
  function position() {
    if (!active) return;
    const { trigger, tip } = active, rect = trigger.getBoundingClientRect(), bounds = tip.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = window.innerHeight, edge = 12;
    const below = rect.bottom + 8, candidate = below + bounds.height <= height - edge ? below : rect.top - bounds.height - 8;
    const top = Math.max(edge, Math.min(height - bounds.height - edge, candidate));
    tip.style.left = Math.max(edge, Math.min(width - bounds.width - edge, rect.left + rect.width / 2 - bounds.width / 2)) + "px";
    tip.style.top = top + "px";
  }
  function hide({ dismiss = false } = {}) {
    stopLeave(); observer.disconnect();
    if (!active) return;
    const { trigger, tip } = active;
    active = null;
    if (dismiss) dismissed = trigger;
    tip.hidden = true; tip.removeAttribute("data-open");
    if (trigger.isConnected) trigger.append(tip); else tip.remove();
  }
  function show(trigger) {
    if (!trigger || trigger === dismissed || trigger.matches(":disabled,[aria-disabled=true]") || !trigger.isConnected) return;
    stopLeave();
    if (active?.trigger === trigger) return;
    hide();
    const tip = document.getElementById(trigger.getAttribute("aria-describedby"))?.closest("[role=tooltip]");
    if (!tip) return;
    active = { trigger, tip };
    tip.hidden = false; tip.setAttribute("data-open", ""); document.body.append(tip);
    position(); observer.observe(document.body, { childList: true, subtree: true });
  }
  const leave = () => { stopLeave(); leaveTimer = setTimeout(() => { if (active && document.activeElement !== active.trigger) hide(); }, 140); };
  document.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;
    if (active?.tip.contains(event.target)) { stopLeave(); return; }
    const trigger = action(event.target);
    if (trigger && !trigger.contains(event.relatedTarget)) show(trigger);
  });
  document.addEventListener("pointerout", event => {
    if (event.pointerType === "touch") return;
    const trigger = action(event.target);
    if (trigger && !trigger.contains(event.relatedTarget)) {
      if (dismissed === trigger) dismissed = null;
      if (active?.trigger === trigger && !active.tip.contains(event.relatedTarget)) leave();
    } else if (active?.tip.contains(event.target) && !active.tip.contains(event.relatedTarget) && !active.trigger.contains(event.relatedTarget)) leave();
  });
  document.addEventListener("focusin", event => { const trigger = action(event.target); if (trigger) show(trigger); else hide(); });
  document.addEventListener("focusout", event => {
    const trigger = action(event.target);
    if (dismissed === trigger) dismissed = null;
    if (active?.trigger === trigger) leave();
  });
  function cancelHold() { if (hold) clearTimeout(hold.timer); hold = null; }
  document.addEventListener("pointerdown", event => {
    cancelHold(); suppress = null;
    const trigger = action(event.target);
    if (active && !active.tip.contains(event.target) && active.trigger !== trigger) hide();
    if (event.pointerType !== "touch" || !trigger) return;
    dismissed = null;
    hold = { trigger, x: event.clientX, y: event.clientY, pointerId: event.pointerId, held: false };
    hold.timer = setTimeout(() => {
      if (!hold || !hold.trigger.isConnected) return;
      hold.held = true; show(hold.trigger);
      suppress = { trigger: hold.trigger, until: Date.now() + 1500 };
    }, 450);
  });
  document.addEventListener("pointermove", event => {
    if (!hold || event.pointerId !== hold.pointerId || Math.hypot(event.clientX - hold.x, event.clientY - hold.y) <= 10) return;
    if (hold.held) hide();
    suppress = null; cancelHold();
  });
  document.addEventListener("pointerup", event => {
    if (hold?.pointerId !== event.pointerId) return;
    if (hold.held) suppress = { trigger: hold.trigger, until: Date.now() + 800 };
    cancelHold();
  });
  document.addEventListener("pointercancel", () => { suppress = null; cancelHold(); hide(); });
  document.addEventListener("contextmenu", event => { if (hold?.held && action(event.target) === hold.trigger) event.preventDefault(); });
  document.addEventListener("click", event => {
    const trigger = action(event.target);
    if (suppress && suppress.trigger === trigger && Date.now() < suppress.until && event.detail !== 0) {
      suppress = null; event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    suppress = null;
    if (!active?.tip.contains(event.target)) hide({ dismiss: true });
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && active) { event.preventDefault(); event.stopImmediatePropagation(); cancelHold(); hide({ dismiss: true }); }
  }, true);
  document.addEventListener("scroll", () => { cancelHold(); hide({ dismiss: true }); }, true);
  window.addEventListener("resize", () => { cancelHold(); hide({ dismiss: true }); });
  window.addEventListener("pagehide", () => { cancelHold(); hide(); });
  window.TokenHorizonActions = Object.freeze({ render, update, icon, hide });
})();
