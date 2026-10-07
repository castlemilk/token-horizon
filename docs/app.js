// Copy-to-clipboard for the one-line installer. No dependencies.
const copyBtn = document.getElementById('copy-btn');
if (copyBtn) {
  copyBtn.addEventListener('click', async (event) => {
    const cmd = document.getElementById('install-cmd').textContent.trim();
    const btn = event.currentTarget;
    try {
      await navigator.clipboard.writeText(cmd);
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('install-cmd'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    const original = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1400);
  });
}

// Mobile nav: the link list collapses behind the toggle on narrow screens.
const nav = document.getElementById('site-nav');
const navToggle = document.getElementById('nav-toggle');
if (nav && navToggle) {
  const setNavigation = (open, restoreFocus = false) => {
    nav.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (restoreFocus) navToggle.focus();
  };
  navToggle.addEventListener('click', () => setNavigation(!nav.classList.contains('open')));
  nav.addEventListener('click', event => {
    if (event.target.closest('.nav-links a')) setNavigation(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      event.preventDefault(); setNavigation(false, nav.contains(document.activeElement));
    }
  });
  document.addEventListener('click', event => {
    if (!nav.contains(event.target) && nav.classList.contains('open')) setNavigation(false, nav.contains(document.activeElement));
  });
  matchMedia('(min-width: 1081px)').addEventListener('change', () => setNavigation(false));
}
