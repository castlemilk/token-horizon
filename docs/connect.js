import { createBlackHole } from './black-hole.js?v=1';
const body = document.body, status = document.querySelector('#status');
const desktopForm = document.querySelector('#desktop-form');
const desktop = Boolean(desktopForm), desktopId = body.dataset.desktopId || '';
const form = document.querySelector('#consent-form') || desktopForm;
const webSessions = body.dataset.webSessions === 'true';
const githubAvailable = body.dataset.githubAuth === 'true';
const hole = createBlackHole({ width: 100, height: 44, ramp: ' .:-=+*#%@', frameMs: 33 });
const target = document.querySelector('#black-hole');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let paused = reduced.matches;
const motion = document.querySelector('#motion-toggle');
function syncMotion() {
  if (!motion) return;
  motion.textContent = paused ? 'Play animation' : 'Pause animation';
  motion.setAttribute('aria-pressed', String(paused));
  if (paused || document.hidden || reduced.matches) hole.pause(); else hole.resume();
}
if (target) hole.start(target, { animate: !paused });
motion?.addEventListener('click', () => { paused = !paused; syncMotion(); });
reduced.addEventListener('change', () => { paused = reduced.matches; syncMotion(); });
document.addEventListener('visibilitychange', syncMotion);
window.addEventListener('pagehide', () => hole.stop());
window.addEventListener('pageshow', event => { if (event.persisted && target) { hole.start(target, { animate: !paused }); refreshSession(); if (desktop && !desktopDone) void loadDesktopRequest(); } });
syncMotion();

let credential = '', identity = null, expiresAt = 0, busy = false, cursor = null;
let authGeneration = 0, identityRevision = 0, sessionReadRevision = 0, refreshPending = false;
let googleScript = null, googleReady = false, googleInitKey = '';
let googleRenderHost = null, googleRenderKey = '', googleAttemptPending = false, googleAttemptTimer = null, googleResizePending = false;
let desktopReady = false, desktopDone = false, desktopExpiry = 0, desktopExpiryTimer;
const say = text => { if (status) status.textContent = text; };
const principal = value => value ? `${value.provider}:${value.sub}` : '';
const signedIn = () => Boolean(credential || (identity && expiresAt > Date.now() + 30000));
function finishGoogleAttempt() {
  clearTimeout(googleAttemptTimer); googleAttemptTimer = null; googleAttemptPending = false;
}
function startGoogleAttempt() {
  if (busy || signedIn()) return;
  finishGoogleAttempt(); googleAttemptPending = true;
  say('Opening Google sign-in… Complete sign-in in the Google window.');
  googleAttemptTimer = setTimeout(() => {
    googleAttemptTimer = null;
    if (busy || signedIn()) return;
    // Keep the official button and its iframe intact. A blocked or cancelled
    // popup must leave a clear recovery path without interrupting a slow login.
    say('Google sign-in has not finished. Check for the Google window or allow pop-ups, then choose Continue with Google again.');
  }, 15000);
}
window.addEventListener('pagehide', finishGoogleAttempt);
function storage(key, value, session = false) {
  try { const store = session ? sessionStorage : localStorage; if (value === undefined) return JSON.parse(store.getItem(key) || 'null'); if (value === null) store.removeItem(key); else store.setItem(key, JSON.stringify(value)); } catch { /* Browser storage is optional; cookies still authenticate. */ }
  return null;
}
function identityHint(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (field, limit = 200) => String(field || '').slice(0, limit);
  return { provider: value.provider === 'github' ? 'github' : 'google', sub: text(value.sub), email: text(value.email, 254), name: text(value.name), picture: /^https:\/\//.test(String(value.picture || '')) ? text(value.picture, 2048) : '', login: text(value.login, 80) };
}
async function request(path, { method = 'GET', fields, json } = {}) {
  const abort = new AbortController();
  let timer;
  const operation = (async () => {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: json ? JSON.stringify(json) : new URLSearchParams(fields) } : {}) });
    const data = JSON.parse(await response.text());
    if (!response.ok) { const error = new Error(data.error || 'Connection failed. Please try again.'); error.code = data.code; error.status = response.status; throw error; }
    return data;
  })();
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('This request took too long. Check your connection and try again.')); abort.abort(); }, 8000); })]); }
  finally { clearTimeout(timer); }
}
function accepted(data) {
  return data?.authenticated && ['google', 'github'].includes(data.user?.provider) && typeof data.user.sub === 'string' && data.user.sub && Number(data.expiresAt) > Date.now() + 30000 ? data.user : null;
}
function renderIdentity() {
  const host = document.querySelector('#identity'), options = document.querySelector('#auth-options');
  if (!host) return;
  const navigationLabel = document.querySelector('[data-nav-signin-label]');
  if (navigationLabel) navigationLabel.textContent = signedIn() ? 'Your account' : 'Sign in';
  host.replaceChildren(); host.hidden = !signedIn();
  if (options) options.hidden = signedIn();
  const allow = document.querySelector('#allow'); if (allow) allow.disabled = busy || !signedIn() || (desktop && (!desktopReady || desktopDone));
  if (desktop) {
    const handle = document.querySelector('#desktop-handle'); if (handle) handle.disabled = busy || !desktopReady || desktopDone;
    desktopForm.querySelector('[value="deny"]').disabled = busy || !desktopReady || desktopDone;
  }
  const github = document.querySelector('#github-signin'); if (github) github.disabled = busy || !githubAvailable;
  const googleHost = document.querySelector('#google-signin'); if (googleHost) { googleHost.inert = busy; googleHost.setAttribute('aria-busy', String(busy)); }
  if (!signedIn()) return;
  const photo = document.createElement('span'); photo.className = 'connector-avatar'; photo.textContent = identity?.name?.[0] || identity?.login?.[0] || '✓';
  if (/^https:\/\//.test(identity?.picture || '')) { const img = document.createElement('img'); img.src = identity.picture; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.onerror = () => img.remove(); photo.append(img); }
  const details = document.createElement('div'), name = document.createElement('strong'), description = document.createElement('small');
  name.textContent = identity?.name || identity?.login || identity?.email || 'Google account ready';
  description.textContent = identity ? `${identity.provider === 'github' ? 'GitHub' : 'Google'} · ${identity.email || '@' + identity.login}` : 'Review your permissions, then connect.';
  details.append(name, description); host.append(photo, details);
  if (webSessions) { const change = document.createElement('button'); change.type = 'button'; change.className = 'change-account'; change.textContent = 'Use another account'; change.disabled = busy || desktopDone; change.onclick = signOut; host.append(change); }
}
function desktopMessage() { return signedIn() ? 'Choose your profile, then connect to continue syncing.' : 'Sign in to connect your Mac.'; }
function finishDesktop(state, handle = '') {
  desktopReady = false; desktopDone = true; clearTimeout(desktopExpiryTimer); finishGoogleAttempt();
  body.classList.toggle('connected', state !== 'denied' && state !== 'expired');
  desktopForm.hidden = true;
  document.querySelector('#desktop-intro').hidden = true;
  const title = document.querySelector('#connection-title');
  title.textContent = state === 'denied' ? 'Connection cancelled.' : state === 'expired' ? 'Connection expired.' : "You're connected.";
  const result = document.querySelector('#desktop-result'); result.replaceChildren(); result.hidden = false;
  const message = document.createElement('p'); message.className = 'lede';
  message.textContent = state === 'denied' ? 'Return to Token Horizon. Choose Sync now whenever you’re ready to connect.' : state === 'expired' ? 'Return to Token Horizon and choose Sync now to start a new connection.' : 'Return to Token Horizon. Your sync continues automatically.';
  result.append(message);
  if (handle && !['denied', 'expired'].includes(state)) {
    const profile = document.createElement('a'); profile.className = 'desktop-profile-link'; profile.href = '/u/' + encodeURIComponent(handle); profile.textContent = 'View @' + handle; result.append(profile);
  }
  renderIdentity(); say(''); result.focus({ preventScroll: true });
}
async function loadDesktopRequest() {
  if (!desktop || desktopDone) return;
  desktopReady = false; renderIdentity(); say('Checking your app connection…');
  try {
    const data = await request('/api/desktop/request?id=' + encodeURIComponent(desktopId));
    if (['approved', 'exchanged', 'denied'].includes(data.status)) return finishDesktop(data.status, data.handle);
    if (data.status !== 'pending' || !Number.isFinite(Number(data.expiresAt))) throw new Error('This connection could not be verified. Return to the app and choose Sync now again.');
    desktopExpiry = Number(data.expiresAt);
    if (desktopExpiry <= Date.now()) return finishDesktop('expired');
    const input = document.querySelector('#desktop-handle'); input.value = String(data.handle || '').replace(/^@/, '').slice(0, 64);
    desktopReady = true; renderIdentity(); say(desktopMessage());
    clearTimeout(desktopExpiryTimer); desktopExpiryTimer = setTimeout(() => { if (!busy && !desktopDone) finishDesktop('expired'); }, desktopExpiry - Date.now());
  } catch (error) {
    if (error.status === 410 || error.code === 'connection_expired') return finishDesktop('expired');
    say(error.message); renderIdentity();
    const host = document.querySelector('#desktop-result'); host.hidden = false; host.replaceChildren();
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = 'Try connection again'; retry.onclick = () => { host.hidden = true; void loadDesktopRequest(); }; host.append(retry);
  }
}
desktopForm?.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !desktopReady || desktopDone) return;
  if (desktopExpiry <= Date.now()) return finishDesktop('expired');
  const decision = event.submitter?.value || 'allow';
  if (decision === 'allow' && !signedIn()) return say('Sign in to connect your Mac.');
  finishGoogleAttempt(); busy = true; renderIdentity();
  say(decision === 'allow' ? 'Connecting your Mac…' : 'Cancelling this connection…');
  try {
    const handle = document.querySelector('#desktop-handle').value.trim().replace(/^@/, '');
    const data = await request('/api/desktop/approve', { method: 'POST', json: { id: desktopId, handle, decision } });
    if (!['approved', 'denied'].includes(data.status)) throw new Error('The connection could not finish. Try again.');
    finishDesktop(data.status, data.handle);
  } catch (error) {
    if (error.status === 410 || error.code === 'connection_expired') finishDesktop('expired');
    else {
      say(error.message);
      if (error.status === 401) { ++authGeneration; credential = ''; setIdentity(null); ensureGoogle(); }
      if (['profile_owned', 'claim_required'].includes(error.code)) setTimeout(() => document.querySelector('#desktop-handle').focus(), 0);
    }
  } finally { busy = false; renderIdentity(); if (!signedIn() && !desktopDone) ensureGoogle(); if (!desktopDone && desktopExpiry <= Date.now()) finishDesktop('expired'); flushPendingRefresh(); }
});
window.addEventListener('pagehide', () => clearTimeout(desktopExpiryTimer));
function setIdentity(next, expiry = 0) {
  if (principal(identity) !== principal(next)) { finishGoogleAttempt(); ++identityRevision; document.querySelector('#connections')?.replaceChildren(); }
  identity = next; expiresAt = expiry;
  if (next) {
    const hint = identityHint(next);
    // Both surfaces share this hint. Equivalent names must not trigger another
    // tab's verification read just because object order or empty fields differ.
    if (JSON.stringify(identityHint(storage('th_auth_hint'))) !== JSON.stringify(hint)) storage('th_auth_hint', hint);
  }
  renderIdentity();
}
function grantRow(grant) {
  const row = document.createElement('div'); row.className = 'grant';
  const details = document.createElement('div'), title = document.createElement('strong'), info = document.createElement('p');
  title.textContent = grant.name;
  info.textContent = `${grant.destination || 'MCP client'} · ${grant.scope.includes('account:manage') ? 'Read & manage reports' : 'Read only'}`;
  details.append(title, info);
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Disconnect';
  button.addEventListener('click', async () => {
    if (!confirm(`Disconnect ${grant.name}? This revokes its Token Horizon access.`)) return;
    button.disabled = true;
    try { await loadConnections({ action: 'revoke', id: grant.id }); say('Disconnected. Access revocation may take a moment to propagate.'); }
    catch (error) { say(error.message); button.disabled = false; }
  });
  row.append(details, button); return row;
}
async function loadConnections(extra = {}) {
  const revision = identityRevision;
  const data = await request('/oauth/connections', { method: 'POST', fields: { credential, handle: body.dataset.handle, action: 'list', ...extra } });
  if (revision !== identityRevision) return;
  const host = document.querySelector('#connections'); if (!host) return;
  if (!extra.cursor) host.replaceChildren(); host.querySelector('[data-more]')?.remove();
  if (!data.connections.length && !extra.cursor) { const empty = document.createElement('p'); empty.className = 'help'; empty.textContent = 'No connected applications yet. Add the MCP endpoint in your client to get started.'; host.append(empty); }
  data.connections.forEach(grant => host.append(grantRow(grant))); cursor = data.cursor;
  if (cursor) { const more = document.createElement('button'); more.type = 'button'; more.dataset.more = ''; more.className = 'secondary'; more.textContent = 'Load more'; more.onclick = () => loadConnections({ cursor }).catch(error => say(error.message)); host.append(more); }
}
async function refreshSession() {
  if (!webSessions) return false;
  if (busy || googleAttemptPending) { refreshPending = true; return false; }
  const generation = authGeneration, revision = ++sessionReadRevision;
  const current = () => generation === authGeneration && revision === sessionReadRevision;
  try {
    const data = await request('/api/auth/session');
    if (!current()) return false;
    setIdentity(accepted(data), Number(data.expiresAt));
    if (identity && !form) await loadConnections();
    if (!current()) return false;
    if (!identity) ensureGoogle();
    return true;
  } catch (error) { if (current()) { setIdentity(null); ensureGoogle(); say(error.message); } return false; }
}
function flushPendingRefresh() { if (refreshPending && !busy && !googleAttemptPending) { refreshPending = false; void refreshSession(); } }
async function signOut() {
  if (busy) return;
  finishGoogleAttempt();
  busy = true; ++authGeneration; renderIdentity();
  try {
    await request('/api/auth/logout', { method: 'POST', json: {} });
    credential = ''; setIdentity(null); storage('th_auth_hint', null); storage('th_google_session', null); storage('th_auth_signed_out', true, true);
    try { google.accounts.id.cancel(); google.accounts.id.disableAutoSelect(); } catch { /* Google can be blocked without affecting cookie logout. */ }
    say('Choose the account you want to connect.');
  } catch (error) { say(error.message); }
  finally { busy = false; renderIdentity(); ensureGoogle(); flushPendingRefresh(); }
}
async function receiveGoogle(result) {
  finishGoogleAttempt();
  if (busy) return;
  if (!result?.credential) { if (googleResizePending) renderGoogle(); flushPendingRefresh(); return; }
  if (!webSessions) {
    credential = result.credential; document.querySelector('#credential')?.setAttribute('value', credential); renderIdentity();
    if (!form) { try { await loadConnections(); } catch (error) { say(error.message); } } else say('Review permissions, then connect.');
    return;
  }
  busy = true; const generation = ++authGeneration; renderIdentity(); say('Verifying your account…');
  try {
    const data = await request('/api/auth/google', { method: 'POST', json: { credential: result.credential } });
    if (generation !== authGeneration) return;
    const verified = accepted(data); if (!verified) throw new Error('Your sign-in could not be verified. Try again.');
    credential = ''; setIdentity(verified, Number(data.expiresAt)); storage('th_auth_signed_out', null, true);
    if (!form) await loadConnections(); say(desktop ? desktopMessage() : form ? 'Review permissions, then connect.' : 'Your connections are up to date.');
  } catch (error) { if (generation === authGeneration) say(error.message); }
  finally { if (generation === authGeneration) { busy = false; renderIdentity(); if (googleResizePending && !signedIn()) renderGoogle(); flushPendingRefresh(); } }
}
function initializeGoogle() {
  if (googleAttemptPending || busy) return;
  const hint = storage('th_auth_hint'), signedOut = Boolean(storage('th_auth_signed_out', undefined, true));
  const loginHint = !signedOut && hint?.provider === 'google' && typeof hint.email === 'string' ? hint.email.slice(0, 254) : '';
  const key = JSON.stringify([body.dataset.clientId, body.dataset.handle, 'popup', loginHint]);
  if (key !== googleInitKey) {
    // The browser's FedCM token request can fail before the credential callback.
    // Use the supported Google popup flow, retaining the personalized account
    // hint while keeping the client transaction nonce and consent explicit.
    google.accounts.id.initialize({ client_id: body.dataset.clientId, nonce: body.dataset.handle, ux_mode: 'popup', auto_select: false, use_fedcm_for_button: false, button_auto_select: false, ...(loginHint ? { login_hint: loginHint } : {}), callback: receiveGoogle });
    googleInitKey = key;
  }
  renderGoogle();
}
function ensureGoogle() {
  const host = document.querySelector('#google-signin'); if (!host || !body.dataset.clientId || signedIn()) return;
  if (googleReady) { initializeGoogle(); return; }
  if (googleScript) return;
  googleScript = document.createElement('script'); googleScript.src = 'https://accounts.google.com/gsi/client'; googleScript.async = true;
  googleScript.onerror = () => { googleScript.remove(); googleScript = null; host.replaceChildren(); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = 'Retry Google sign-in'; retry.onclick = ensureGoogle; host.append(retry); say('Google sign-in could not load. Try again or use another available provider.'); };
  googleScript.onload = () => {
    try {
      googleReady = true; initializeGoogle();
    } catch { say('Google sign-in could not start. Reload and try again.'); }
  };
  document.head.append(googleScript);
}
function renderGoogle() {
  const host = document.querySelector('#google-signin'); if (!host || signedIn() || busy || googleAttemptPending) return;
  const width = Math.floor(Math.max(200, Math.min(360, host.clientWidth || 320)));
  const key = googleInitKey + '|' + width;
  googleResizePending = false;
  if (host === googleRenderHost && key === googleRenderKey && host.firstElementChild) return;
  host.replaceChildren();
  try {
    google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', width, click_listener: startGoogleAttempt });
    googleRenderHost = host; googleRenderKey = key;
  }
  catch { say('Google sign-in could not render. Reload and try again.'); }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (googleReady && !signedIn()) { if (googleAttemptPending || busy) googleResizePending = true; else renderGoogle(); } }, 100); });
window.addEventListener('pagehide', () => clearTimeout(resizeTimer));
if (!desktop) form?.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const decision = event.submitter?.value || 'allow';
  if (decision === 'allow' && !signedIn()) return say('Sign in to continue.');
  finishGoogleAttempt();
  busy = true; renderIdentity();
  const fields = new URLSearchParams(new FormData(form)); fields.set('decision', decision); fields.set('credential', credential);
  form.querySelectorAll('button').forEach(button => button.disabled = true);
  say(decision === 'allow' ? 'Connecting your account…' : 'Returning to your application…');
  try {
    const data = await request('/oauth/authorize', { method: 'POST', fields });
    body.classList.add('connected'); say(decision === 'allow' ? 'Connected. Returning to your application…' : 'Connection cancelled. Returning…');
    setTimeout(() => location.assign(data.redirect), reduced.matches ? 0 : 650);
  } catch (error) { say(error.message); busy = false; form.querySelectorAll('button').forEach(button => button.disabled = false); renderIdentity(); ensureGoogle(); }
});
document.querySelector('#github-signin')?.addEventListener('click', () => {
  if (!githubAvailable || busy) return;
  finishGoogleAttempt();
  busy = true; ++authGeneration; renderIdentity();
  try { google.accounts.id.cancel(); } catch { /* Google need not be loaded for GitHub. */ }
  const current = new URL(location.href); current.searchParams.delete('auth'); current.searchParams.delete('auth_error');
  const target = new URL('/api/auth/github', location.origin); target.searchParams.set('returnTo', current.pathname + current.search); location.assign(target.href);
});
document.querySelector('#copy-endpoint')?.addEventListener('click', async event => {
  try { await navigator.clipboard.writeText('https://token-horizon.dev/mcp'); event.target.textContent = 'Copied'; say('MCP endpoint copied. Paste it into your client’s remote server settings.'); }
  catch { say('Copy this address: https://token-horizon.dev/mcp'); }
});
window.addEventListener('storage', event => {
  if (!webSessions || !['th_auth_hint', 'th_google_session'].includes(event.key)) return;
  // A cached name is only a hint. Drop the former account and its grants
  // immediately, then prove the new browser identity with a fresh server read.
  if (event.key === 'th_auth_hint' && event.newValue === null) storage('th_auth_signed_out', true, true);
  finishGoogleAttempt();
  ++sessionReadRevision; credential = ''; setIdentity(null); say('Checking your remembered account…');
  void refreshSession();
});
const initial = new URL(location.href);
if (!body.dataset.clientId) document.querySelector('#google-signin')?.setAttribute('hidden', '');
if (initial.searchParams.has('auth_error')) say('GitHub sign-in did not finish. Try again or use Google.');
if (initial.searchParams.has('auth') || initial.searchParams.has('auth_error')) { initial.searchParams.delete('auth'); initial.searchParams.delete('auth_error'); history.replaceState(history.state, '', initial); }
if (desktop) void loadDesktopRequest();
if (webSessions) { say(status?.textContent || 'Checking your remembered account…'); refreshSession().then(current => { if (!current || desktopDone || desktop && !desktopReady) return; if (signedIn()) say(desktop ? desktopMessage() : form ? 'Review permissions, then connect.' : 'Your connections are up to date.'); else if (status?.textContent === 'Checking your remembered account…' || desktop && desktopReady) say(desktop ? desktopMessage() : 'Choose an account to continue.'); }); }
else { ensureGoogle(); if (!body.dataset.clientId) say('Account sign-in is unavailable on this deployment.'); }
