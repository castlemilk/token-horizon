// Copy-to-clipboard for the one-line installer. No dependencies.
document.getElementById('copy-btn').addEventListener('click', async (event) => {
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
