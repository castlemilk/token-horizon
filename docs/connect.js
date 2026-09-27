import { createBlackHole } from './black-hole.js?v=1';
const body = document.body, status = document.querySelector('#status');
const hole = createBlackHole({ width: 100, height: 44, ramp: ' .:-=+*#%@', frameMs: 33 });
const target = document.querySelector('#black-hole');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let paused = reduced.matches;
const motion = document.querySelector('#motion-toggle');
function syncMotion() {
  motion.textContent = paused ? 'Play animation' : 'Pause animation';
  motion.setAttribute('aria-pressed', String(paused));
  if (paused || document.hidden || reduced.matches) hole.pause(); else hole.resume();
}
hole.start(target, { animate: !paused });
motion.addEventListener('click', () => { paused = !paused; syncMotion(); });
reduced.addEventListener('change', () => { paused = reduced.matches; syncMotion(); });
document.addEventListener('visibilitychange', syncMotion);
window.addEventListener('pagehide', () => hole.stop());
window.addEventListener('pageshow', event => { if (event.persisted) hole.start(target, { animate: !paused }); });
syncMotion();
let credential = '', busy = false, cursor = null;
async function post(path, fields) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Connection failed. Please try again.');
  return data;
}
const say = text => { status.textContent = text; };
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
  const data = await post('/oauth/connections', { credential, handle: body.dataset.handle, action: 'list', ...extra });
  const host = document.querySelector('#connections');
  if (!extra.cursor) host.replaceChildren();
  host.querySelector('[data-more]')?.remove();
  if (!data.connections.length && !extra.cursor) { const empty = document.createElement('p'); empty.className = 'help'; empty.textContent = 'No connected applications yet. Add the MCP endpoint in your client to get started.'; host.append(empty); }
  data.connections.forEach(grant => host.append(grantRow(grant)));
  cursor = data.cursor;
  if (cursor) { const more = document.createElement('button'); more.type = 'button'; more.dataset.more = ''; more.className = 'secondary'; more.textContent = 'Load more'; more.onclick = () => loadConnections({ cursor }).catch(error => say(error.message)); host.append(more); }
  const identity = document.querySelector('#identity'); identity.hidden = false; identity.textContent = `Signed in as ${data.name}`;
}
const form = document.querySelector('#consent-form');
form?.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const decision = event.submitter?.value || 'allow';
  if (decision === 'allow' && !credential) return say('Sign in with Google to continue.');
  busy = true;
  const fields = new URLSearchParams(new FormData(form)); fields.set('decision', decision); fields.set('credential', credential);
  form.querySelectorAll('button').forEach(button => button.disabled = true);
  say(decision === 'allow' ? 'Connecting your account…' : 'Returning to your application…');
  try {
    const data = await post('/oauth/authorize', fields);
    body.classList.add('connected');
    say(decision === 'allow' ? 'Connected. Returning to your application…' : 'Connection cancelled. Returning…');
    setTimeout(() => location.assign(data.redirect), reduced.matches ? 0 : 650);
  } catch (error) { say(error.message); busy = false; form.querySelectorAll('button').forEach(button => button.disabled = false); }
});
document.querySelector('#copy-endpoint')?.addEventListener('click', async event => {
  try { await navigator.clipboard.writeText('https://token-horizon.dev/mcp'); event.target.textContent = 'Copied'; say('MCP endpoint copied. Paste it into your client’s remote server settings.'); }
  catch { say('Copy this address: https://token-horizon.dev/mcp'); }
});
if (body.dataset.clientId && document.querySelector('#google-signin')) {
  const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
  script.onerror = () => say('Google sign-in could not load. Check your connection, then reload.');
  script.onload = () => {
    google.accounts.id.initialize({ client_id: body.dataset.clientId, nonce: body.dataset.handle, auto_select: false, callback: async result => {
      credential = result.credential;
      if (form) {
        document.querySelector('#credential').value = credential;
        document.querySelector('#allow').disabled = false;
        const identity = document.querySelector('#identity'); identity.hidden = false; identity.textContent = 'Google sign-in received. Review permissions, then connect.';
        say('Ready when you are.');
      } else {
        try { await loadConnections(); say('Your connections are up to date.'); }
        catch (error) { say(error.message); }
      }
    } });
    google.accounts.id.renderButton(document.querySelector('#google-signin'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: Math.min(330, document.querySelector('#google-signin').clientWidth) });
  };
  document.head.append(script);
} else if (!body.dataset.clientId) say('Account sign-in is unavailable on this deployment.');
