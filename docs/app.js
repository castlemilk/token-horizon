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

// Scroll reveals: tagged sections rise in once as they enter view.
// Reduced-motion users get everything static via the CSS guard.
(function () {
  var els = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  els.forEach(function (el) { io.observe(el); });
})();

// Mobile nav: the link list collapses behind the toggle on narrow screens.
const nav = document.getElementById('site-nav');
const navToggle = document.getElementById('nav-toggle');
if (nav && navToggle) {
  navToggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.textContent = open ? '✕' : '☰';
  });
}
