// Long-lived tabs keep their loaded JavaScript after a deployment. Check the
// public shell independently of data/auth, and let the user choose when to reload.
(() => {
  const shell = document.getElementById('token-horizon-shell');
  const styles = document.getElementById('token-horizon-shell-styles');
  if (!shell || !styles || !location.protocol.startsWith('http') || !globalThis.crypto?.subtle) return;
  const endpoint = new URL('leaderboard.html', document.baseURI);
  if (endpoint.origin !== location.origin) return;
  const INTERVAL = 300000, MAX_BYTES = 1048576;
  let flight = null, etag = '', checkedAt = 0, available = '', dismissed = '', notice;
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
  const baseline = hash(JSON.stringify([shell.textContent, styles.textContent, [...document.querySelectorAll('link[data-ui-style]')].map(link => link.getAttribute('href'))])).catch(() => null);
  function source(html) {
    const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].find(match => /\bid=["']token-horizon-shell["']/i.test(match[1]));
    const style = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)].find(match => /\bid=["']token-horizon-shell-styles["']/i.test(match[1]));
    if (!script || !style) return null;
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].filter(match => /\bdata-ui-style(?:\s|=|\/?>)/i.test(match[0])).map(match => match[0].match(/\bhref=["']([^"']*)["']/i)?.[1] || '');
    return JSON.stringify([script[2], style[2], links]);
  }
  function mount() {
    if (!available || available === dismissed) { removeNotice(); return; }
    if (!notice) {
      notice = document.createElement('aside');
      notice.className = 'ui-update-notice'; notice.dataset.uiUpdate = '';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      notice.innerHTML = '<div><strong>New version ready</strong><span>Reload to use the latest interface.</span></div><button type="button" data-ui-reload>Reload page</button><button type="button" class="ui-update-dismiss" aria-label="Dismiss update notice">×</button>';
      notice.querySelector('[data-ui-reload]').onclick = () => location.reload();
      notice.querySelector('.ui-update-dismiss').onclick = () => { dismissed = available; removeNotice(); };
    }
    const parent = document.querySelector('#modal-backdrop.open .modal') || document.body;
    if (notice.parentNode !== parent) parent.append(notice);
  }
  function removeNotice() {
    const focused = notice?.contains(document.activeElement);
    notice?.remove();
    if (!focused) return;
    const modal = document.querySelector('#modal-backdrop.open .modal');
    const target = modal?.querySelector('.x') || (modal && [...modal.querySelectorAll('button, input, select, [tabindex], a[href]')].find(node => !node.disabled && node.offsetParent !== null));
    target?.focus({ preventScroll: true });
  }
  async function readHtml(response, signal) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Invalid UI shell');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    let bytes = 0, text = '';
    try {
      if (signal.aborted) throw new Error('UI check cancelled');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('UI shell too large');
        text += decoder.decode(value, { stream: true });
      }
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
  }
  function check({ force = false } = {}) {
    if (flight) return flight;
    if (document.hidden || (!force && checkedAt && Date.now() - checkedAt < INTERVAL)) return Promise.resolve();
    checkedAt = Date.now();
    const abort = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-cache', redirect: 'error', priority: 'low', signal: abort.signal, headers: { Accept: 'text/html', ...(etag ? { 'If-None-Match': etag } : {}) } });
      if (response.status === 304) return;
      if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) return;
      const parsed = source(await readHtml(response, abort.signal));
      if (abort.signal.aborted || !parsed) return;
      const fingerprint = await hash(parsed);
      const original = await baseline;
      if (abort.signal.aborted || !original) return;
      etag = (response.headers.get('etag') || '').slice(0, 200);
      available = fingerprint === original ? '' : fingerprint;
      mount();
    })();
    flight = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('UI check timed out')); }, 5000); })])
      .catch(() => {}) // Offline/slow update checks never interrupt the application.
      .finally(() => { clearTimeout(timer); abort.abort(); flight = null; });
    return flight;
  }
  window.TokenHorizonUIUpdates = Object.freeze({ check, mount });
  let interval;
  const startPolling = () => { clearInterval(interval); interval = setInterval(() => check(), INTERVAL); };
  startPolling();
  const initial = setTimeout(() => check(), 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { startPolling(); check(); } });
  window.addEventListener('pagehide', () => { clearTimeout(initial); clearInterval(interval); });
})();
