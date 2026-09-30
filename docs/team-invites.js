/* Team invitations / Quiet Precision.
   Controllers own authentication and persistence. This module only paints data
   supplied by the controller and responds to deliberate user actions. */
(function () {
  "use strict";

  const pageViews = new WeakMap();
  let currentManager = null;
  let sequence = 0;
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const paths = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    share: '<path d="M12 15V3m-4 4 4-4 4 4M5 11v10h14V11"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-4a6 6 0 0 1 12 0v4m2-17a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v3"/>',
    link: '<path d="m9 15 6-6m-6-3 2-2a5 5 0 0 1 7 7l-2 2M8 11l-2 2a5 5 0 0 0 7 7l2-2"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    retry: '<path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.people}</svg>`;
  const getState = options => options.state || options;
  const members = team => Math.max(0, Math.floor(Number(team?.memberCount) || 0));
  const memberLabel = team => `${members(team)} ${members(team) === 1 ? "member" : "members"}`;
  const dateOf = value => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = typeof value === "number" || /^\d+$/.test(String(value));
    const date = new Date(numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const expiry = value => {
    const date = dateOf(value);
    if (!date) return "Expiry unavailable";
    return `${date.getTime() <= Date.now() ? "Expired" : "Expires"} ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
  };
  const safeLink = value => {
    try {
      const url = new URL(String(value || ""), location.origin);
      return /^https?:$/.test(url.protocol) && value ? url.href : "";
    } catch (_) { return ""; }
  };

  function orbitArt(joined, small) {
    const stars = [[16, 22], [73, 16], [90, 43], [25, 81], [83, 84], [10, 57]];
    return `<div class="ti-orbit-art${joined ? " ti-orbit-joined" : ""}${small ? " ti-orbit-small" : ""}" aria-hidden="true"><span class="ti-orbit-line ti-orbit-one"></span><span class="ti-orbit-line ti-orbit-two"></span><span class="ti-orbit-line ti-orbit-three"></span><span class="ti-horizon"><span></span></span><span class="ti-orbit-friend ti-friend-one">${icon("people")}</span><span class="ti-orbit-friend ti-friend-two">${icon("plus")}</span><span class="ti-orbit-friend ti-friend-three">${icon(joined ? "check" : "people")}</span>${stars.map(([x, y], i) => `<i class="ti-star ti-star-${i}" style="--ti-x:${x}%;--ti-y:${y}%;--ti-delay:${i * 80}ms"></i>`).join("")}${joined ? `<span class="ti-joined-mark">${icon("check")}</span>` : ""}</div>`;
  }

  function alertMarkup(state, localError, retry) {
    const error = state.error || localError;
    if (!error) return "";
    return `<div class="ti-error" role="alert"><span>${esc(typeof error === "string" ? error : error.message || "That didn’t work. Try again.")}</span>${retry ? `<button type="button" class="ti-text-button" data-ti-retry>${icon("retry")}Try again</button>` : ""}</div>`;
  }

  function skeleton() {
    return '<div class="ti-skeleton" aria-hidden="true"><span></span><b></b><span></span><i></i></div><p class="ti-loading" role="status"><span class="ti-loading-dot"></span>Getting the crew together…</p>';
  }

  function managerMarkup(view) {
    const state = getState(view.options);
    const team = state.team;
    const owner = team?.role === "owner";
    const busy = !!state.loading || view.busy;
    const disabled = busy ? " disabled" : "";
    const heading = team ? owner ? "Invite your people." : "Your crew." : "Build your crew.";
    const visibleInvites = (state.invites || []).filter(invite => invite && !invite.revoked);
    const hasActiveInvite = visibleInvites.some(invite => !dateOf(invite.expiresAt) || dateOf(invite.expiresAt).getTime() > Date.now());
    const rows = visibleInvites.map((invite, i) => {
      const url = safeLink(invite.url);
      const expired = dateOf(invite.expiresAt)?.getTime() <= Date.now();
      return `<div class="ti-invite-row${expired ? " ti-invite-expired" : ""}"><div class="ti-invite-meta"><span>${icon("link")}${expired ? "Expired invite" : "Anyone with this link can join"}</span><time${dateOf(invite.expiresAt) ? ` datetime="${esc(dateOf(invite.expiresAt).toISOString())}"` : ""}>${esc(expiry(invite.expiresAt))}</time></div><div class="ti-link-control"><input id="ti-link-${view.id}-${i}" aria-label="Team invitation link" value="${esc(url)}" readonly spellcheck="false"/><button type="button" class="ti-button ti-primary ti-copy-button" data-ti-copy="${i}"${disabled}${!url || expired ? " disabled" : ""}>${icon("copy")}Copy link</button></div><div class="ti-link-footer">${typeof navigator.share === "function" && !expired && url ? `<button type="button" class="ti-text-button" data-ti-share="${i}"${disabled}>${icon("share")}Share with friends</button>` : '<span>Friends sign in and join automatically.</span>'}${owner ? `<button type="button" class="ti-text-button ti-revoke" data-ti-revoke="${i}"${disabled}>Revoke link</button>` : ""}</div></div>`;
    }).join("");

    let content;
    if (state.loading && !team) content = skeleton();
    else if (!state.signedIn) content = `<h3>Your crew starts with you.</h3><p>Sign in to create a team and invite your friends with one link.</p><button type="button" class="ti-button ti-primary ti-wide" data-ti-signin>${icon("people")}Sign in to invite friends</button>`;
    else if (!team) content = `<form data-ti-create><label for="ti-team-name-${view.id}">What’s your team called?</label><div class="ti-name-control"><input id="ti-team-name-${view.id}" name="teamName" type="text" placeholder="The orbital crew" maxlength="64" minlength="2" autocomplete="off" required value="${esc(view.draft)}"${disabled}/></div><p class="ti-field-help">Pick a name your friends will recognize. You can invite them as soon as it’s created.</p><button type="submit" class="ti-button ti-primary ti-wide"${disabled}>${busy ? '<span class="ti-button-spinner" aria-hidden="true"></span>Creating your crew…' : icon("plus") + "Create team & invite friends"}</button></form>`;
    else content = `<div class="ti-team-details"><div class="ti-team-badge">${icon("people")}</div><div><h3>${esc(team.name || "Your team")}</h3><p>${esc(memberLabel(team))} <span>${owner ? "You’re the team owner" : "You’re on the team"}</span></p></div></div>${owner ? `<div class="ti-invite-list">${rows || '<div class="ti-no-links"><p>Make room for your friends.</p><span>Create a link, send it to your people, and watch the crew grow.</span></div>'}</div>${hasActiveInvite ? '' : `<button type="button" class="ti-button${rows ? "" : " ti-primary"} ti-wide" data-ti-new-link${disabled}>${busy ? '<span class="ti-button-spinner" aria-hidden="true"></span>Getting your link ready…' : icon("plus") + (rows ? "Create fresh invite link" : "Create invite link")}</button>`}` : '<div class="ti-member-note">' + icon("shield") + '<p>You’re part of the crew. Ask the team owner for an invite link to bring your friends along.</p></div>'}`;

    return `<div class="ti-manager-shell"><button type="button" class="ti-close" data-ti-close aria-label="Close team invitations">${icon("close")}</button><aside class="ti-manager-art"><div class="ti-art-brand"><span class="ti-brand-mark"></span>Token Horizon</div>${orbitArt(false, true)}<div class="ti-art-copy"><span>Good company.<br/>Greater horizons.</span><p>One link brings your crew into the same orbit.</p></div><div class="ti-art-foot"><span></span>Better together</div></aside><section class="ti-manager-content"><header><h2 id="ti-manager-title-${view.id}">${heading}</h2><p>${team ? owner ? "Bring friends into your Token Horizon team." : "Good company for your next horizon." : "A little friendly competition starts here."}</p></header>${alertMarkup(state, view.localError, !!view.options.onRetry)}<div class="ti-manager-body"${busy ? ' aria-busy="true"' : ""}>${content}</div><p class="ti-status" role="status" aria-live="polite">${esc(view.status)}</p><footer class="ti-privacy-note">${icon("shield")}Joining a team doesn’t share private prompts or local traces.</footer></section></div>`;
  }

  function runAction(view, callback, args) {
    if (view.busy || getState(view.options).loading || typeof callback !== "function") return;
    view.busy = true;
    view.localError = "";
    view.paint();
    let result;
    try { result = callback(...(args || [])); }
    catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).catch(error => {
      view.localError = error?.message || "That didn’t work. Try again.";
    }).finally(() => {
      view.busy = false;
      if (view.live) view.paint();
    });
  }

  function bindManager(view) {
    const host = view.dialog;
    host.querySelector("[data-ti-close]")?.addEventListener("click", view.close);
    host.querySelector("[data-ti-signin]")?.addEventListener("click", () => {
      const callback = view.options.onSignIn;
      view.close();
      callback?.();
    });
    host.querySelector("[data-ti-retry]")?.addEventListener("click", () => runAction(view, view.options.onRetry));
    host.querySelector("[data-ti-create]")?.addEventListener("submit", event => {
      event.preventDefault();
      const input = host.querySelector('[name="teamName"]');
      const value = input?.value.trim() || "";
      if (value.length < 2) {
        input?.setCustomValidity("Use at least two characters for your team name.");
        input?.reportValidity();
        return;
      }
      view.draft = value;
      runAction(view, view.options.onCreate, [value]);
    });
    host.querySelector('[name="teamName"]')?.addEventListener("input", event => {
      view.draft = event.target.value;
      event.target.setCustomValidity("");
    });
    host.querySelector("[data-ti-new-link]")?.addEventListener("click", () => runAction(view, view.options.onCreate, [getState(view.options).team?.name || ""]));
    const invites = (getState(view.options).invites || []).filter(invite => invite && !invite.revoked);
    host.querySelectorAll("[data-ti-copy]").forEach(button => button.addEventListener("click", async () => {
      const index = Number(button.dataset.tiCopy);
      const input = host.querySelector(`#ti-link-${view.id}-${index}`);
      const value = safeLink(invites[index]?.url);
      if (!value) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(value);
        if (!view.live) return;
        view.status = "Link copied. Your friends are one sign-in away.";
        button.innerHTML = icon("check") + "Copied!";
        host.querySelector(".ti-status").textContent = view.status;
      } catch (_) {
        input?.focus();
        input?.select();
        view.status = "Select and copy this link to invite your friends.";
        host.querySelector(".ti-status").textContent = view.status;
      }
    }));
    host.querySelectorAll("[data-ti-share]").forEach(button => button.addEventListener("click", async () => {
      const state = getState(view.options);
      const url = safeLink(invites[Number(button.dataset.tiShare)]?.url);
      if (!url) return;
      try { await navigator.share({ title: `Join ${state.team?.name || "my team"} on Token Horizon`, text: "Come join our crew on Token Horizon.", url }); }
      catch (error) {
        if (error?.name === "AbortError" || !view.live) return;
        view.status = "Sharing didn’t open. Copy the invite link instead.";
        host.querySelector(".ti-status").textContent = view.status;
      }
    }));
    host.querySelectorAll("[data-ti-revoke]").forEach(button => button.addEventListener("click", () => {
      const invite = invites[Number(button.dataset.tiRevoke)];
      if (invite?.token) runAction(view, view.options.onRevoke, [invite.token]);
    }));
  }

  function openManager(options) {
    currentManager?.close();
    const opener = document.activeElement;
    const dialog = document.createElement("dialog");
    const view = { options: options || {}, dialog, id: ++sequence, draft: "", localError: "", status: "", busy: false, live: true };
    dialog.className = "th-team-invites ti-manager";
    dialog.setAttribute("aria-labelledby", `ti-manager-title-${view.id}`);
    view.paint = () => {
      if (!view.live) return;
      const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
      const focusedName = focused?.getAttribute("name");
      const focusedAction = focused ? Array.from(focused.attributes).find(attribute => attribute.name.startsWith("data-ti-")) : null;
      dialog.innerHTML = managerMarkup(view);
      bindManager(view);
      const replacement = focusedName ? dialog.querySelector(`[name="${focusedName}"]`) : focusedAction ? Array.from(dialog.querySelectorAll(`[${focusedAction.name}]`)).find(node => node.getAttribute(focusedAction.name) === focusedAction.value) : null;
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    };
    view.close = () => {
      if (!view.live) return;
      view.live = false;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (currentManager === api) currentManager = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      view.options.onClose?.();
    };
    const api = {
      update(nextOptions) {
        view.options = { ...view.options, ...nextOptions };
        view.localError = "";
        view.paint();
      },
      close: view.close
    };
    dialog.addEventListener("cancel", event => { event.preventDefault(); view.close(); });
    dialog.addEventListener("close", () => { if (view.live) view.close(); });
    dialog.addEventListener("click", event => { if (event.target === dialog) view.close(); });
    document.body.append(dialog);
    view.paint();
    dialog.showModal();
    dialog.querySelector('[name="teamName"], [data-ti-copy], [data-ti-signin], [data-ti-close]')?.focus({ preventScroll: true });
    currentManager = api;
    return api;
  }

  function inviteMarkup(view) {
    const state = getState(view.options);
    const invite = state.invite;
    const team = state.joined && state.team ? state.team : invite?.team || state.team;
    const joined = !!state.joined;
    const loading = !!state.loading || view.busy;
    const valid = !!team && !state.invalid && !invite?.revoked;
    const expired = !joined && dateOf(invite?.expiresAt)?.getTime() <= Date.now();
    let content;
    if (loading && !team) content = skeleton();
    else if (!valid || expired) content = `<h1>${expired ? "This invite has expired." : "This invite couldn’t be opened."}</h1><p>Ask your friend for a fresh invite link. There’s always room for one more in the crew.</p>${alertMarkup(state, view.localError, false)}${!expired && view.options.onRetry ? `<button class="ti-button" type="button" data-ti-retry>${icon("retry")}Try this invite again</button>` : ""}<a class="ti-home-link" href="/leaderboard?view=teams">Explore teams ${icon("arrow")}</a>`;
    else if (joined) content = `<span class="ti-success-label">${icon("check")}You’re on the team</span><h1>Welcome to<br/>${esc(team.name || "the crew")}.</h1><p>Your place in the crew is saved. Your published profiles follow this team automatically.</p><div class="ti-crew-line">${icon("people")}<span>${esc(memberLabel(team))} and counting</span></div><button type="button" class="ti-button ti-primary ti-wide" data-ti-continue>Meet your team ${icon("arrow")}</button><a class="ti-home-link" href="/leaderboard?view=dashboard">Open your workspace</a>`;
    else content = `<span class="ti-invite-label">You’ve been invited to join</span><h1>${esc(team.name || "the crew")}.</h1><p>A friend saved you a seat. Compare your model usage, share a little friendly competition, and see what you can build together.</p><div class="ti-crew-line">${icon("people")}<span>${esc(memberLabel(team))}</span><time${dateOf(invite?.expiresAt) ? ` datetime="${esc(dateOf(invite.expiresAt).toISOString())}"` : ""}>${esc(expiry(invite?.expiresAt))}</time></div>${state.needsSwitch ? `<div class="ti-switch-note"><strong>You’re joining a new team.</strong><p>${state.currentTeam?.name ? `Joining will move your account from ${esc(state.currentTeam.name)} to ${esc(team.name)}.` : "Joining will move your account and its owned profiles to this team."}</p></div>` : ""}${alertMarkup(state, view.localError, false)}<button type="button" class="ti-button ti-primary ti-wide" data-ti-join${loading ? " disabled" : ""}>${loading ? '<span class="ti-button-spinner" aria-hidden="true"></span>Joining your crew…' : icon(state.signedIn ? "people" : "arrow") + (state.needsSwitch ? "Switch team & join" : state.signedIn ? "Join the team" : "Sign in & join the team")}</button><p class="ti-join-help">${state.signedIn ? "Your team membership is saved to your account." : "Sign in with Google and you’ll automatically join. No published profile needed."}</p>`;
    return `<section class="th-team-invites ti-invite-page${joined ? " ti-page-joined" : ""}"${loading ? ' aria-busy="true"' : ""}><a href="/" class="ti-page-brand"><span class="ti-brand-mark"></span>Token Horizon</a><div class="ti-invite-card"><aside class="ti-invite-art">${orbitArt(joined, false)}<div class="ti-orbit-caption"><span>${joined ? "Crew expanded." : "Your orbit is about to grow."}</span><p>${joined ? "Good things happen in good company." : "Bring your curiosity. We saved you a seat."}</p></div><span class="ti-coordinate" aria-hidden="true">TH / ${joined ? "Connected" : "Invitation"}</span></aside><div class="ti-invite-content">${content}<footer class="ti-privacy-note">${icon("shield")}Team membership appears on your published profiles. Private prompts and local traces stay private.</footer></div></div><p class="ti-page-footer">Better models. Shared horizons.</p></section>`;
  }

  function renderInvite(options) {
    const host = options?.host;
    if (!host) throw new Error("TokenHorizonInvites.renderInvite needs a host element");
    let view = pageViews.get(host);
    if (view) {
      view.options = { ...view.options, ...options };
      view.localError = "";
      view.paint();
      return view.api;
    }
    view = { host, options, busy: false, live: true, localError: "" };
    view.paint = () => {
      if (!view.live) return;
      const focusAction = host.contains(document.activeElement) ? Array.from(document.activeElement.attributes).find(attribute => attribute.name.startsWith("data-ti-"))?.name : null;
      host.innerHTML = inviteMarkup(view);
      host.querySelectorAll("[data-ti-retry]").forEach(button => button.addEventListener("click", () => runAction(view, view.options.onRetry)));
      host.querySelector("[data-ti-join]")?.addEventListener("click", () => runAction(view, view.options.onJoin, [!!getState(view.options).needsSwitch]));
      host.querySelector("[data-ti-continue]")?.addEventListener("click", () => view.options.onContinue?.());
      if (focusAction) {
        const replacement = host.querySelector(`[${focusAction}]`);
        if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
        else if (getState(view.options).joined) {
          const heading = host.querySelector("h1");
          heading?.setAttribute("tabindex", "-1");
          heading?.focus({ preventScroll: true });
        }
      }
    };
    view.api = {
      update(nextOptions) {
        view.options = { ...view.options, ...nextOptions };
        view.localError = "";
        view.paint();
      },
      destroy() {
        view.live = false;
        pageViews.delete(host);
        host.replaceChildren();
      }
    };
    pageViews.set(host, view);
    view.paint();
    return view.api;
  }

  window.TokenHorizonInvites = Object.freeze({ openManager, renderInvite });
})();
