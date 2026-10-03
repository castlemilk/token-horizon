(function () {
  'use strict';
  const section = document.getElementById('install');
  const api = window.TokenHorizonDownloads;
  if (!section || !api) return;
  const platforms = ['macos', 'windows', 'linux'];
  const params = new URL(location.href).searchParams;
  let platform = platforms.includes(params.get('platform')) ? params.get('platform') : api.detectPlatform(navigator.userAgent) || 'macos';
  let releases = null;
  let state = 'loading';
  let pending = false;
  const panels = [...section.querySelectorAll('[data-platform-panel]')];
  const arch = document.getElementById('linux-arch');
  const format = document.getElementById('linux-format');
  if (['x64', 'arm64'].includes(params.get('arch'))) arch.value = params.get('arch');
  else if (/aarch64|arm64/i.test(navigator.userAgent)) arch.value = 'arm64';
  if (['deb', 'AppImage'].includes(params.get('format'))) format.value = params.get('format');
  section.classList.add('download-enhanced');
  section.querySelector('[data-platform-picker]').hidden = false;

  function render() {
    section.querySelectorAll('[name="download-platform"]').forEach(input => { input.checked = input.value === platform; });
    panels.forEach(panel => { panel.hidden = panel.dataset.platformPanel !== platform; });
    const panel = panels.find(item => item.dataset.platformPanel === platform);
    const link = panel.querySelector('[data-installer-link]');
    const status = panel.querySelector('[data-release-status]');
    const metadata = panel.querySelector('[data-release-meta]');
    const notes = panel.querySelector('[data-release-notes]');
    const checksum = panel.querySelector('[data-checksum]');
    const retry = panel.querySelector('[data-release-retry]');
    const installer = state === 'ready' ? api.selectInstaller(releases, { platform, arch: platform === 'linux' ? arch.value : 'x64', format: format.value }) : null;
    status.className = installer ? 'download-status sr-only' : 'download-status';
    panel.querySelector('[data-unavailable]').hidden = Boolean(installer);
    retry.hidden = state === 'loading' || Boolean(installer);
    link.hidden = !installer;
    metadata.hidden = !installer;
    notes.hidden = !installer;
    checksum.hidden = !installer?.checksumURL;
    if (installer) {
      link.href = installer.url;
      link.querySelector('span').textContent = platform === 'macos' ? 'Download for macOS'
        : platform === 'windows' ? 'Download for Windows' : 'Download ' + (format.value === 'deb' ? '.deb' : 'AppImage');
      metadata.textContent = 'v' + installer.version + ' · ' + (installer.size / 1024 / 1024).toFixed(1) + ' MB · '
        + (platform === 'macos' ? 'Apple silicon · .dmg' : platform === 'windows' ? 'Intel / AMD 64-bit · .exe' : arch.value === 'x64' ? 'Intel / AMD 64-bit' : 'ARM64');
      notes.href = installer.notesURL;
      if (installer.checksumURL) checksum.href = installer.checksumURL;
      status.textContent = 'Download ready for ' + (platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux') + ', version ' + installer.version + '.';
    } else {
      // No inferred /latest/download URL: an absent package must never send a
      // Windows or Linux visitor to the Mac build, or to a fabricated filename.
      link.removeAttribute('href');
      const target = platform === 'linux' ? 'Linux ' + (arch.value === 'x64' ? 'x64' : 'ARM64') + ' ' + format.value : platform === 'windows' ? 'Windows' : 'macOS';
      panel.querySelector('[data-unavailable]').textContent = state === 'loading' ? 'Checking downloads…' : 'Download unavailable';
      status.textContent = state === 'loading' ? 'Finding the latest published installer.'
        : state === 'error' ? 'We couldn’t check the releases. Try again, or browse the files on GitHub.'
        : 'A ' + target + ' installer isn’t available in the recent releases yet. Check GitHub or try again after it is published.';
    }
    if (platform === 'linux') {
      panel.querySelector('[data-linux-package-help]').textContent = format.value === 'deb'
        ? 'Recommended for Debian and Ubuntu. Installs an application-menu shortcut.'
        : 'A portable app for other Linux distributions. Requires FUSE 2 and a working Chromium sandbox.';
      const command = api.installCommand(installer, format.value);
      const commandHost = document.getElementById('linux-command');
      commandHost.textContent = command || (format.value === 'deb'
        ? 'In Downloads, open a terminal and run sudo apt install ./ followed by the downloaded .deb filename.'
        : 'In file properties, allow the downloaded AppImage to run as a program. Then open it.');
      panel.querySelector('[data-linux-command-copy]').hidden = !command;
      panel.querySelector('[data-linux-launch]').textContent = format.value === 'deb'
        ? 'Open Token Horizon from your application menu.' : 'Open the AppImage whenever you want to use Token Horizon.';
    }
  }

  function saveChoice() {
    const url = new URL(location.href);
    url.searchParams.set('platform', platform);
    if (platform === 'linux') {
      url.searchParams.set('arch', arch.value);
      url.searchParams.set('format', format.value);
    } else {
      url.searchParams.delete('arch'); url.searchParams.delete('format');
    }
    history.replaceState(null, '', url);
  }
  section.querySelectorAll('[name="download-platform"]').forEach(input => input.addEventListener('change', () => {
    platform = input.value; saveChoice(); render();
  }));
  [arch, format].forEach(input => input.addEventListener('change', () => { saveChoice(); render(); }));
  section.querySelectorAll('[data-release-retry]').forEach(button => button.addEventListener('click', load));

  async function load() {
    if (pending) return;
    pending = true; state = 'loading'; render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(api.apiURL, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Release lookup failed');
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('Invalid releases');
      releases = payload; state = 'ready';
    } catch {
      state = 'error';
    } finally {
      clearTimeout(timeout); pending = false; render();
    }
  }
  render();
  load();
})();
