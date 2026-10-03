import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { selectInstaller, detectPlatform, installCommand, apiURL, releasesURL } = require('../docs/desktop-releases.js');
const repository = 'https://github.com/castlemilk/token-horizon';
const tag = 'v0.3.12';
const version = '0.3.12';

function asset(name, releaseTag = tag, overrides = {}) {
  return {
    name,
    state: 'uploaded',
    size: 1024,
    browser_download_url: `${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(name)}`,
    ...overrides,
  };
}

function release(names, overrides = {}) {
  const releaseTag = overrides.tag_name ?? tag;
  return {
    tag_name: releaseTag,
    published_at: '2026-09-26T23:59:08Z',
    draft: false,
    prerelease: false,
    assets: names.map(name => asset(name, releaseTag)),
    ...overrides,
  };
}

const targets = [
  { platform: 'macos', arch: 'arm64', name: `TokenHorizon-${version}.dmg`, checksum: `TokenHorizon-${version}.sha256` },
  { platform: 'windows', arch: 'x64', name: `TokenHorizon-${version}-windows-x64-setup.exe`, checksum: `TokenHorizon-${version}-windows-x64.sha256`, legacyChecksum: 'SHA256SUMS-win32-x64.txt' },
  { platform: 'linux', arch: 'x64', format: 'deb', name: `TokenHorizon-${version}-linux-amd64.deb`, checksum: `TokenHorizon-${version}-linux-x86_64.sha256`, legacyChecksum: 'SHA256SUMS-linux-x64.txt' },
  { platform: 'linux', arch: 'arm64', format: 'deb', name: `TokenHorizon-${version}-linux-arm64.deb`, checksum: `TokenHorizon-${version}-linux-arm64.sha256`, legacyChecksum: 'SHA256SUMS-linux-arm64.txt' },
  { platform: 'linux', arch: 'x64', format: 'AppImage', name: `TokenHorizon-${version}-linux-x86_64.AppImage`, checksum: `TokenHorizon-${version}-linux-x86_64.sha256`, legacyChecksum: 'SHA256SUMS-linux-x64.txt' },
  { platform: 'linux', arch: 'arm64', format: 'AppImage', name: `TokenHorizon-${version}-linux-arm64.AppImage`, checksum: `TokenHorizon-${version}-linux-arm64.sha256`, legacyChecksum: 'SHA256SUMS-linux-arm64.txt' },
];

test('every supported target selects its exact installer and same-release checksum', () => {
  const published = release(targets.flatMap(target => [target.name, target.checksum]));
  for (const target of targets) {
    const installer = selectInstaller([published], target);
    assert.equal(installer?.name, target.name);
    assert.equal(installer?.version, version);
    assert.equal(installer?.url, asset(target.name).browser_download_url);
    assert.equal(installer?.notesURL, `${repository}/releases/tag/${tag}`);
    assert.equal(installer?.checksumURL, asset(target.checksum).browser_download_url);
  }
});

test('versioned checksums take priority regardless of asset order, with legacy fallback', () => {
  for (const target of targets.filter(target => target.legacyChecksum)) {
    const both = release([target.name, target.legacyChecksum, target.checksum]);
    assert.equal(selectInstaller([both], target)?.checksumURL, asset(target.checksum).browser_download_url);
    const legacyOnly = release([target.name, target.legacyChecksum]);
    assert.equal(selectInstaller([legacyOnly], target)?.checksumURL, asset(target.legacyChecksum).browser_download_url);
  }
});

test('invalid versioned checksums can fall back only to a valid same-release legacy checksum', () => {
  for (const target of targets.filter(target => target.legacyChecksum)) {
    const published = release([], { assets: [
      asset(target.name), asset(target.checksum, tag, { state: 'uploading' }), asset(target.legacyChecksum),
    ] });
    assert.equal(selectInstaller([published], target)?.checksumURL, asset(target.legacyChecksum).browser_download_url);
  }
});

test('AppImage accepts the actual x64 and aarch64 filename aliases', () => {
  for (const [arch, fileArch] of [['x64', 'x64'], ['arm64', 'aarch64']]) {
    const name = `TokenHorizon-${version}-linux-${fileArch}.AppImage`;
    assert.equal(selectInstaller([release([name])], { platform: 'linux', arch, format: 'AppImage' })?.name, name);
  }
});

test('Linux and Windows can use an older matching stable release when the latest is Mac-only', () => {
  const olderTag = 'v0.3.11';
  const olderNames = ['TokenHorizon-0.3.11-linux-amd64.deb', 'TokenHorizon-0.3.11-windows-x64-setup.exe'];
  const older = release(olderNames, { tag_name: olderTag, published_at: '2026-09-24T03:00:59Z' });
  const latest = release([`TokenHorizon-${version}.dmg`]);
  const input = [older, latest];
  for (const platform of ['windows', 'linux']) {
    const installer = selectInstaller(input, { platform, arch: 'x64', format: 'deb' });
    assert.equal(installer?.version, '0.3.11');
    assert.equal(installer?.notesURL, `${repository}/releases/tag/${olderTag}`);
  }
  assert.equal(selectInstaller(input, { platform: 'macos' })?.version, version);
  assert.equal(input[0], older, 'Selection must not reorder the fetched payload');
});

test('selection uses publication dates rather than API array order', () => {
  const old = release(['TokenHorizon-0.3.10-windows-x64-setup.exe'], { tag_name: 'v0.3.10', published_at: '2026-09-24T02:22:49Z' });
  const current = release([`TokenHorizon-${version}-windows-x64-setup.exe`]);
  assert.equal(selectInstaller([old, current], { platform: 'windows' })?.version, version);
});

test('a stable tag without the v prefix still uses its real download path', () => {
  const name = `TokenHorizon-${version}-windows-x64-setup.exe`;
  assert.equal(selectInstaller([release([name], { tag_name: version })], { platform: 'windows' })?.url, asset(name, version).browser_download_url);
});

test('drafts, prereleases, and nonstable tags never offer installers', () => {
  const name = `TokenHorizon-${version}-windows-x64-setup.exe`;
  for (const overrides of [
    { draft: true },
    { prerelease: true },
    { tag_name: 'v0.3.12-beta.1' },
    { tag_name: 'v0.3.12+build' },
    { tag_name: 'v0.3' },
    { tag_name: 'main' },
    { tag_name: '../v0.3.12' },
  ]) {
    assert.equal(selectInstaller([release([name], overrides)], { platform: 'windows' }), null);
  }
});

test('incorrect version, platform, architecture, and package filenames are unavailable', () => {
  const wrongNames = [
    'TokenHorizon-0.3.11-windows-x64-setup.exe',
    `TokenHorizon-${version}-windows-arm64-setup.exe`,
    `TokenHorizon-${version}-win32-x64-setup.exe`,
    `TokenHorizon-${version}-windows-x64.exe`,
    `TokenHorizon-${version}-windows-x64-setup.EXE`,
    `TokenHorizon-${version}-windows-x64-setup.exe.blockmap`,
    `TokenHorizon-${version}-linux-x64.deb`,
    `TokenHorizon-${version}-linux-arm64.deb`,
    `TokenHorizon-${version}.dmg`,
  ];
  assert.equal(selectInstaller([release(wrongNames)], { platform: 'windows' }), null);
  assert.equal(selectInstaller([release(wrongNames)], { platform: 'linux', arch: 'x64', format: 'deb' }), null);
});

test('an existing Mac release never becomes a Linux or Windows fallback', () => {
  const onlyMac = [release([`TokenHorizon-${version}.dmg`, `TokenHorizon-${version}.zip`])];
  for (const target of targets.filter(target => target.platform !== 'macos')) {
    assert.equal(selectInstaller(onlyMac, target), null);
  }
});

test('unknown platforms, architectures, and Linux formats cannot select a download', () => {
  const published = [release(targets.map(target => target.name))];
  for (const target of [
    { platform: null },
    { platform: 'android' },
    { platform: 'win32' },
    { platform: 'windows', arch: 'arm64' },
    { platform: 'windows', arch: 'ia32' },
    { platform: 'linux', arch: 'armv7l' },
    { platform: 'linux', format: 'rpm' },
    { platform: 'linux', format: 'appimage' },
  ]) assert.equal(selectInstaller(published, target), null);
});

test('pending uploads, missing states, and empty assets are never downloadable', () => {
  const name = `TokenHorizon-${version}-windows-x64-setup.exe`;
  for (const override of [
    { state: 'new' },
    { state: 'uploading' },
    { state: 'starter' },
    { state: null },
    { state: undefined },
    { size: 0 },
    { size: -1 },
    { size: undefined },
    { size: 'not a byte count' },
  ]) {
    assert.equal(selectInstaller([release([], { assets: [asset(name, tag, override)] })], { platform: 'windows' }), null);
  }
});

test('download URLs must belong to the exact repository, release tag, and filename', () => {
  const name = `TokenHorizon-${version}-windows-x64-setup.exe`;
  const expected = asset(name).browser_download_url;
  for (const url of [
    expected.replace('https:', 'http:'),
    expected.replace('github.com', 'github.com.evil.example'),
    expected.replace('castlemilk/token-horizon', 'other/token-horizon'),
    expected.replace(tag, 'v0.3.11'),
    expected.replace(name, `TokenHorizon-${version}.dmg`),
    `${expected}?download=1`,
    `${expected}#setup`,
    `https://evil.example/${name}`,
    `javascript:alert(1)`,
    null,
  ]) {
    assert.equal(selectInstaller([release([], { assets: [asset(name, tag, { browser_download_url: url })] })], { platform: 'windows' }), null);
  }
});

test('checksums cannot come from another version, architecture, or upload', () => {
  const name = `TokenHorizon-${version}-linux-amd64.deb`;
  const checksum = `TokenHorizon-${version}-linux-x86_64.sha256`;
  const previous = release(['TokenHorizon-0.3.11-linux-x86_64.sha256', 'SHA256SUMS-linux-x64.txt'], { tag_name: 'v0.3.11', published_at: '2026-09-24T03:00:59Z' });
  for (const extra of [
    asset('TokenHorizon-0.3.11-linux-x86_64.sha256'),
    asset(`TokenHorizon-${version}-linux-arm64.sha256`),
    asset(`TokenHorizon-${version}-windows-x64.sha256`),
    asset('SHA256SUMS-linux-arm64.txt'),
    asset('SHA256SUMS-win32-x64.txt'),
    asset(checksum, 'v0.3.11'),
    asset('SHA256SUMS-linux-x64.txt', 'v0.3.11'),
    asset(checksum, tag, { state: 'uploading' }),
    asset(checksum, tag, { size: 0 }),
  ]) {
    const selected = selectInstaller([release([], { assets: [asset(name), extra] }), previous], { platform: 'linux', arch: 'x64', format: 'deb' });
    assert.equal(selected?.name, name);
    assert.equal(selected?.checksumURL, null);
  }
});

test('malformed release payloads are unavailable without throwing', () => {
  for (const payload of [null, undefined, {}, 'releases', { message: 'API rate limit exceeded' }, [null, undefined, 1, {}], [release([], { assets: null })]]) {
    assert.equal(selectInstaller(payload, { platform: 'windows' }), null);
  }
});

test('malformed asset records cannot prevent later valid installers from loading', () => {
  const name = `TokenHorizon-${version}-windows-x64-setup.exe`;
  const checksum = 'SHA256SUMS-win32-x64.txt';
  const mixed = release([], { assets: [null, undefined, {}, asset(name), null, asset(checksum)] });
  const selected = selectInstaller([mixed], { platform: 'windows' });
  assert.equal(selected?.name, name);
  assert.equal(selected?.checksumURL, asset(checksum).browser_download_url);
});

test('platform detection selects desktop OSes but never mobile browsers', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux aarch64)'), 'linux');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos');
  for (const userAgent of [
    'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)',
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 18_0 like Mac OS X)',
    '',
    'Unknown desktop',
  ]) assert.equal(detectPlatform(userAgent), null);
});

test('Linux commands use the exact selected installer filename', () => {
  for (const target of targets.filter(target => target.platform === 'linux')) {
    const selected = selectInstaller([release([target.name])], target);
    const expected = target.format === 'deb'
      ? `cd ~/Downloads\nsudo apt install ./${target.name}`
      : `cd ~/Downloads\nchmod +x ${target.name}\n./${target.name}`;
    assert.equal(installCommand(selected, target.format), expected);
  }
});

test('shell command generation rejects shell syntax, paths, and mismatched formats', () => {
  for (const name of [
    'TokenHorizon-a b.deb',
    'TokenHorizon-$(touch marker).deb',
    'TokenHorizon-`touch-marker`.deb',
    'TokenHorizon-a;touch-marker.deb',
    'TokenHorizon-a|command.deb',
    'TokenHorizon-a&&command.deb',
    'TokenHorizon-a\ncommand.deb',
    'TokenHorizon-a\rcommand.deb',
    'TokenHorizon-a\".deb',
    "TokenHorizon-a'.deb",
    'TokenHorizon-../escape.deb',
    'TokenHorizon-..\\escape.deb',
    '/tmp/TokenHorizon-a.deb',
    '-TokenHorizon-a.deb',
    'unrelated.deb',
    null,
    123,
  ]) {
    assert.equal(installCommand({ name }, 'deb'), null);
    assert.equal(installCommand({ name }, 'AppImage'), null);
  }
  assert.equal(installCommand(null, 'deb'), null);
  assert.equal(installCommand({ name: `TokenHorizon-${version}-linux-amd64.deb` }, 'AppImage'), null);
  assert.equal(installCommand({ name: `TokenHorizon-${version}-linux-x86_64.AppImage` }, 'deb'), null);
  assert.equal(installCommand({ name: `TokenHorizon-${version}-windows-x64-setup.exe` }, 'deb'), null);
});

// Execute the real download controller with only its DOM/HTTP boundary stubbed. This verifies
// choices and unavailable/error states without a browser dependency or a real release request.
async function controllerFixture(payload, href = 'https://token-horizon.dev/?platform=linux&arch=arm64&format=AppImage#install') {
  function element(value = '') {
    const listeners = new Map();
    const span = { textContent: '' };
    return {
      value, hidden: false, checked: false, textContent: '',
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeAttribute(name) { delete this[name]; },
      querySelector(selector) {
        assert.equal(selector, 'span');
        return span;
      },
      emit(type) { return listeners.get(type)?.(); },
    };
  }
  const radios = ['macos', 'windows', 'linux'].map(platform => element(platform));
  const controls = new Map([
    ['linux-arch', element('x64')], ['linux-format', element('deb')], ['linux-command', element()],
  ]);
  const panels = ['macos', 'windows', 'linux'].map(platform => {
    const fields = new Map([
      'data-installer-link', 'data-release-status', 'data-release-meta', 'data-release-notes',
      'data-checksum', 'data-release-retry', 'data-unavailable', 'data-linux-package-help',
      'data-linux-command-copy', 'data-linux-launch',
    ].map(name => [`[${name}]`, element()]));
    return {
      hidden: false,
      dataset: { platformPanel: platform },
      querySelector(selector) {
        assert.ok(fields.has(selector), `Unexpected controller field: ${selector}`);
        return fields.get(selector);
      },
    };
  });
  const picker = element();
  const section = {
    classList: { add() {} },
    querySelector(selector) {
      assert.equal(selector, '[data-platform-picker]');
      return picker;
    },
    querySelectorAll(selector) {
      if (selector === '[data-platform-panel]') return panels;
      if (selector === '[name="download-platform"]') return radios;
      assert.equal(selector, '[data-release-retry]');
      return panels.map(panel => panel.querySelector(selector));
    },
  };
  let lastURL = new URL(href);
  const source = readFileSync(new URL('../docs/downloads.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    document: { getElementById: id => id === 'install' ? section : controls.get(id) },
    window: { TokenHorizonDownloads: { selectInstaller, detectPlatform, installCommand, apiURL } },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
    location: { href },
    history: { replaceState(_state, _unused, url) { lastURL = new URL(url); } },
    URL, AbortController,
    setTimeout() { return 1; }, clearTimeout() {},
    async fetch() { return { ok: true, async json() { return payload; } }; },
  }, { filename: 'downloads.js' });
  await new Promise(resolve => setImmediate(resolve));
  return {
    panels: Object.fromEntries(panels.map(panel => [panel.dataset.platformPanel, panel])),
    controls,
    get url() { return lastURL; },
    choose(platform) { return radios.find(radio => radio.value === platform).emit('change'); },
  };
}

test('remembered Linux ARM64 choice does not hide the Windows x64 installer', async () => {
  const windows = `TokenHorizon-${version}-windows-x64-setup.exe`;
  const linux = `TokenHorizon-${version}-linux-arm64.AppImage`;
  const fixture = await controllerFixture([release([windows, linux])]);
  const link = platform => fixture.panels[platform].querySelector('[data-installer-link]');
  assert.equal(link('linux').href, asset(linux).browser_download_url);
  fixture.choose('windows');
  assert.equal(link('windows').hidden, false);
  assert.equal(link('windows').href, asset(windows).browser_download_url);
  assert.equal(fixture.panels.windows.querySelector('[data-release-status]').textContent, `Download ready for Windows, version ${version}.`);
  assert.equal(fixture.url.searchParams.get('platform'), 'windows');
  assert.equal(fixture.url.searchParams.has('arch'), false);
  assert.equal(fixture.url.searchParams.has('format'), false);
  assert.equal(fixture.panels.linux.hidden, true);
  fixture.choose('linux');
  assert.equal(fixture.controls.get('linux-arch').value, 'arm64');
  assert.equal(link('linux').href, asset(linux).browser_download_url);
  assert.equal(fixture.url.searchParams.get('arch'), 'arm64');
  assert.equal(fixture.url.searchParams.get('format'), 'AppImage');
});

test('controller unavailable state removes the download URL and offers no Linux copy command', async () => {
  const fixture = await controllerFixture([release([`TokenHorizon-${version}.dmg`])]);
  const panel = fixture.panels.linux;
  const link = panel.querySelector('[data-installer-link]');
  assert.equal(link.hidden, true);
  assert.equal('href' in link, false);
  assert.match(panel.querySelector('[data-release-status]').textContent, /Linux ARM64 AppImage installer isn’t available/);
  assert.equal(panel.querySelector('[data-unavailable]').hidden, false);
  assert.equal(panel.querySelector('[data-release-retry]').hidden, false);
  assert.equal(panel.querySelector('[data-linux-command-copy]').hidden, true);
});

test('controller explains malformed API responses instead of inventing a download', async () => {
  const fixture = await controllerFixture({ message: 'API rate limit exceeded' }, 'https://token-horizon.dev/?platform=windows#install');
  const panel = fixture.panels.windows;
  assert.equal(panel.querySelector('[data-installer-link]').hidden, true);
  assert.equal('href' in panel.querySelector('[data-installer-link]'), false);
  assert.match(panel.querySelector('[data-release-status]').textContent, /couldn’t check the releases/);
  assert.equal(panel.querySelector('[data-release-retry]').hidden, false);
});

test('the landing page loads the release contract before its download controller', () => {
  const index = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const releaseScript = index.indexOf('src="./desktop-releases.js');
  const controllerScript = index.indexOf('src="./downloads.js');
  assert.ok(releaseScript !== -1 && controllerScript > releaseScript);
  assert.match(index, /src="\.\/desktop-releases\.js[^" ]*" defer/);
  assert.match(index, /src="\.\/downloads\.js[^" ]*" defer/);
  assert.match(index, /href="\.\/downloads\.css/);
  for (const filename of ['desktop-releases.js', 'downloads.js', 'downloads.css']) {
    assert.ok(readFileSync(new URL(`../docs/${filename}`, import.meta.url)).length > 0);
  }
  assert.match(index, /id="install"/);
  for (const platform of ['macos', 'windows', 'linux']) {
    assert.match(index, new RegExp(`data-platform-panel="${platform}"`));
    assert.match(index, new RegExp(`name="download-platform" value="${platform}"`));
  }
});

test('desktop tracking links resolve and download buttons do not fabricate latest URLs', () => {
  const index = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const docs = readFileSync(new URL('../docs/docs/index.html', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('../docs/downloads.js', import.meta.url), 'utf8');
  assert.match(index, /href="\.\/docs\/#desktop-capture"/);
  assert.match(docs, /id="desktop-capture"/);
  assert.match(docs, /id="install-windows"/);
  assert.match(docs, /id="install-linux"/);
  assert.doesNotMatch(index, /href=["'][^"']*\/releases\/latest\/download\//);
  assert.doesNotMatch(controller, /https:\/\/github\.com\/castlemilk\/token-horizon\/releases\/latest\/download\//);
  assert.match(controller, /api\.selectInstaller\(/);
  assert.match(controller, /link\.href = installer\.url/);
  assert.match(controller, /link\.removeAttribute\('href'\)/);
  assert.equal(releasesURL, `${repository}/releases`);
  assert.equal(apiURL, 'https://api.github.com/repos/castlemilk/token-horizon/releases?per_page=20');
});
