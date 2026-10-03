/* Published installers only. Shared by the site and the release contract tests. */
(function (root) {
  'use strict';
  const repository = 'https://github.com/castlemilk/token-horizon';
  const releasesURL = repository + '/releases';
  const apiURL = 'https://api.github.com/repos/castlemilk/token-horizon/releases?per_page=20';

  function detectPlatform(userAgent) {
    if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
    if (/Windows/i.test(userAgent)) return 'windows';
    if (/Linux|X11/i.test(userAgent)) return 'linux';
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
    return null;
  }

  function assetURL(asset, tag) {
    if (!asset || asset.state !== 'uploaded' || !(asset.size > 0)) return null;
    const expected = repository + '/releases/download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(asset.name);
    return asset.browser_download_url === expected ? expected : null;
  }

  function selectInstaller(releases, { platform, arch = 'x64', format = 'deb' }) {
    if (!Array.isArray(releases) || !['macos', 'windows', 'linux'].includes(platform)) return null;
    if (!['x64', 'arm64'].includes(arch) || (platform === 'windows' && arch !== 'x64')) return null;
    if (platform === 'linux' && !['deb', 'AppImage'].includes(format)) return null;
    const stable = releases.filter(release => release && !release.draft && !release.prerelease
      && /^v?\d+\.\d+\.\d+$/.test(release.tag_name) && Array.isArray(release.assets))
      .sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
    for (const release of stable) {
      const version = release.tag_name.replace(/^v/, '');
      const prefix = 'TokenHorizon-' + version;
      const names = platform === 'macos' ? [prefix + '.dmg']
        : platform === 'windows' ? [prefix + '-windows-x64-setup.exe']
        : format === 'deb' ? [prefix + '-linux-' + (arch === 'x64' ? 'amd64' : 'arm64') + '.deb']
        : [prefix + '-linux-' + (arch === 'x64' ? 'x86_64' : 'arm64') + '.AppImage',
          prefix + '-linux-' + (arch === 'x64' ? 'x64' : 'aarch64') + '.AppImage'];
      const asset = release.assets.find(item => item && names.includes(item.name) && assetURL(item, release.tag_name));
      if (!asset) continue;
      const checksumNames = platform === 'macos' ? [prefix + '.sha256']
        : [prefix + '-' + (platform === 'windows' ? 'windows-x64' : 'linux-' + (arch === 'x64' ? 'x86_64' : 'arm64')) + '.sha256',
          'SHA256SUMS-' + (platform === 'windows' ? 'win32' : 'linux') + '-' + arch + '.txt'];
      const checksum = checksumNames.map(name => release.assets.find(item => item && item.name === name && assetURL(item, release.tag_name))).find(Boolean);
      return { version, name: asset.name, size: asset.size, url: assetURL(asset, release.tag_name),
        notesURL: repository + '/releases/tag/' + encodeURIComponent(release.tag_name),
        checksumURL: checksum ? assetURL(checksum, release.tag_name) : null };
    }
    return null;
  }

  function installCommand(installer, format) {
    if (!installer || !/^TokenHorizon-[A-Za-z0-9._-]+$/.test(installer.name)) return null;
    if (format === 'deb' && installer.name.endsWith('.deb')) return 'cd ~/Downloads\nsudo apt install ./' + installer.name;
    if (format === 'AppImage' && installer.name.endsWith('.AppImage')) {
      return 'cd ~/Downloads\nchmod +x ' + installer.name + '\n./' + installer.name;
    }
    return null;
  }

  const api = { releasesURL, apiURL, detectPlatform, selectInstaller, installCommand };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenHorizonDownloads = api;
})(typeof window === 'object' ? window : {});
