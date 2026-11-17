/* Homepage-only, opt-in measurement. No persisted consent and no app telemetry. */
(() => {
  'use strict';
  const config = Object.freeze({ enabled: false, measurementId: '' });
  // Enable only after a dedicated GA4 stream, privacy review and enhanced-
  // measurement disablement have been verified. Never share another site's ID.
  const root = document.getElementById('marketing-analytics');
  if (!root) return;
  const eligible = () => config.enabled && /^G-[A-Z0-9]+$/.test(config.measurementId)
    && location.origin === 'https://token-horizon.dev' && location.pathname === '/'
    && !location.search && !location.hash && navigator.doNotTrack !== '1'
    && navigator.globalPrivacyControl !== true;
  if (!eligible()) return;
  root.hidden = false;
  const allow = root.querySelector('[data-allow]');
  const revoke = root.querySelector('[data-revoke]');
  const status = root.querySelector('[role=status]');
  let phase = 'off';
  const id = config.measurementId;
  const disable = () => {
    window['ga-disable-' + id] = true;
    if (phase !== 'on' && phase !== 'loading') return;
    phase = 'stopped';
    if (Array.isArray(window.dataLayer)) window.dataLayer.length = 0;
    status.textContent = 'Analytics stopped. Reload to reset this page; consent is not saved.';
    allow.disabled = true;
    revoke.disabled = true;
    // In-flight requests cannot be recalled. No restart in the current document.
  };
  allow.addEventListener('click', () => {
    if (phase !== 'off' || !eligible()) return;
    phase = 'loading'; allow.disabled = true; revoke.disabled = false;
    window['ga-disable-' + id] = false;
    window.dataLayer = window.dataLayer || [];
    const gtag = function () { window.dataLayer.push(arguments); };
    gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gtag('js', new Date());
    gtag('config', id, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, page_location: 'https://token-horizon.dev/', page_referrer: '', page_title: 'Token Horizon' });
    const script = document.createElement('script');
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    script.onload = () => {
      if (phase !== 'loading' || !eligible()) { disable(); return; }
      phase = 'on';
      gtag('event', 'page_view', { send_to: id, page_location: 'https://token-horizon.dev/', page_referrer: '', page_title: 'Token Horizon' });
      status.textContent = 'Optional homepage analytics enabled for this page only.';
    };
    script.onerror = () => { disable(); status.textContent = 'Analytics could not load and remains off.'; };
    document.head.append(script);
    status.textContent = 'Loading optional analytics…';
  });
  revoke.addEventListener('click', disable);
  window.addEventListener('pagehide', disable);
  // Anchor navigation may carry user input. Fail closed rather than measure it.
  window.addEventListener('hashchange', disable);
  window.addEventListener('popstate', disable);
})();
