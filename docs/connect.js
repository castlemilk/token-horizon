import { createBlackHole } from './black-hole.js?v=1';
const body = document.body, status = document.querySelector('#status');
const form = document.querySelector('#consent-form');
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
window.addEventListener('pageshow', event => { if (event.persisted && target) { hole.start(target, { animate: !paused }); refreshSession(); } });
syncMotion();

let credential = '', identity = null, expiresAt = 0, busy = false, cursor = null;
let authGeneration = 0, identityRevision = 0, sessionReadRevision = 0, refreshPending = false;
let googleScript = null, googleReady = false, googleInitKey = '';
const say = text => { if (status) status.textContent = text; };
const principal = value => value ? `${value.provider}:${value.sub}` : '';
const signedIn = () => Boolean(credential || (identity && expiresAt > Date.now() + 30000));
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
    if (!response.ok) throw new Error(data.error || 'Connection failed. Please try again.');
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
  host.replaceChildren(); host.hidden = !signedIn();
  if (options) options.hidden = signedIn();
  const allow = document.querySelector('#allow'); if (allow) allow.disabled = busy || !signedIn();
  const github = document.querySelector('#github-signin'); if (github) github.disabled = busy || !githubAvailable;
  if (!signedIn()) return;
  const photo = document.createElement('span'); photo.className = 'connector-avatar'; photo.textContent = identity?.name?.[0] || identity?.login?.[0] || '✓';
  if (/^https:\/\//.test(identity?.picture || '')) { const img = document.createElement('img'); img.src = identity.picture; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.onerror = () => img.remove(); photo.append(img); }
  const details = document.createElement('div'), name = document.createElement('strong'), description = document.createElement('small');
  name.textContent = identity?.name || identity?.login || identity?.email || 'Google account ready';
  description.textContent = identity ? `${identity.provider === 'github' ? 'GitHub' : 'Google'} · ${identity.email || '@' + identity.login}` : 'Review your permissions, then connect.';
  details.append(name, description); host.append(photo, details);
  if (webSessions) { const change = document.createElement('button'); change.type = 'button'; change.className = 'change-account'; change.textContent = 'Use another account'; change.disabled = busy; change.onclick = signOut; host.append(change); }
}
function setIdentity(next, expiry = 0) {
  if (principal(identity) !== principal(next)) { ++identityRevision; document.querySelector('#connections')?.replaceChildren(); }
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
  if (busy) { refreshPending = true; return false; }
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
function flushPendingRefresh() { if (refreshPending && !busy) { refreshPending = false; void refreshSession(); } }
async function signOut() {
  if (busy) return;
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
  if (busy || !result?.credential) return;
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
    if (!form) await loadConnections(); say(form ? 'Review permissions, then connect.' : 'Your connections are up to date.');
  } catch (error) { if (generation === authGeneration) say(error.message); }
  finally { if (generation === authGeneration) { busy = false; renderIdentity(); flushPendingRefresh(); } }
}
function initializeGoogle() {
  const hint = storage('th_auth_hint'), signedOut = Boolean(storage('th_auth_signed_out', undefined, true));
  const preferGithub = hint?.provider === 'github';
  const autoSelect = !signedOut && !preferGithub;
  const loginHint = !signedOut && hint?.provider === 'google' && typeof hint.email === 'string' ? hint.email.slice(0, 254) : '';
  const key = JSON.stringify([body.dataset.clientId, body.dataset.handle, autoSelect, loginHint]);
  if (key !== googleInitKey) {
    google.accounts.id.initialize({ client_id: body.dataset.clientId, nonce: body.dataset.handle, auto_select: autoSelect, use_fedcm_for_button: true, button_auto_select: autoSelect, ...(loginHint ? { login_hint: loginHint } : {}), callback: receiveGoogle });
    googleInitKey = key;
  }
  renderGoogle();
  if (autoSelect && !signedIn()) google.accounts.id.prompt();
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
  const host = document.querySelector('#google-signin'); if (!host || signedIn()) return;
  host.replaceChildren();
  try { google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', width: Math.max(200, Math.min(360, host.clientWidth || 320)) }); }
  catch { say('Google sign-in could not render. Reload and try again.'); }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (googleReady && !signedIn()) renderGoogle(); }, 100); });
form?.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const decision = event.submitter?.value || 'allow';
  if (decision === 'allow' && !signedIn()) return say('Sign in to continue.');
  busy = true; renderIdentity();
  const fields = new URLSearchParams(new FormData(form)); fields.set('decision', decision); fields.set('credential', credential);
  form.querySelectorAll('button').forEach(button => button.disabled = true);
  say(decision === 'allow' ? 'Connecting your account…' : 'Returning to your application…');
  try {
    const data = await request('/oauth/authorize', { method: 'POST', fields });
    body.classList.add('connected'); say(decision === 'allow' ? 'Connected. Returning to your application…' : 'Connection cancelled. Returning…');
    setTimeout(() => location.assign(data.redirect), reduced.matches ? 0 : 650);
  } catch (error) { say(error.message); busy = false; form.querySelectorAll('button').forEach(button => button.disabled = false); renderIdentity(); }
});
document.querySelector('#github-signin')?.addEventListener('click', () => {
  if (!githubAvailable || busy) return;
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
  ++sessionReadRevision; credential = ''; setIdentity(null); say('Checking your remembered account…');
  void refreshSession();
});
const initial = new URL(location.href);
if (!body.dataset.clientId) document.querySelector('#google-signin')?.setAttribute('hidden', '');
if (initial.searchParams.has('auth_error')) say('GitHub sign-in did not finish. Try again or use Google.');
if (initial.searchParams.has('auth') || initial.searchParams.has('auth_error')) { initial.searchParams.delete('auth'); initial.searchParams.delete('auth_error'); history.replaceState(history.state, '', initial); }
if (webSessions) { say(status?.textContent || 'Checking your remembered account…'); refreshSession().then(current => { if (!current) return; if (signedIn()) say(form ? 'Review permissions, then connect.' : 'Your connections are up to date.'); else if (status?.textContent === 'Checking your remembered account…') say('Choose an account to continue.'); }); }
else { ensureGoogle(); if (!body.dataset.clientId) say('Account sign-in is unavailable on this deployment.'); }
