import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVersion, compareVersions, resolveVersion, checkPins, readPins, setPins } from './release.mjs';

const tool = fileURLToPath(new URL('./release.mjs', import.meta.url));
const nativePins = version => [
  ['scripts/make-app.sh', `#!/bin/bash\nVERSION="\${MARKETING_VERSION:-${version}}"\n`],
  ['clients/macos/Sources/TokenHorizon/App/BuildInfo.swift', `enum BuildInfo {\n    static var version: String { value("CFBundleShortVersionString", fallback: "${version}") }\n}\n`],
  ['packaging/homebrew/token-horizon.rb', `cask "token-horizon" do\n  version "${version}"\n  sha256 "keep-this-checksum"\nend\n`]
];
function command(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function normalizeCheckoutTag({ root, env }, tag) {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const snippet = workflow.match(/^( +)if \[ "\$GITHUB_REF_TYPE" = tag \]; then\n[\s\S]*?^\1fi$/m);
  assert.ok(snippet, 'The workflow must validate and normalize its checked-out event tag');
  const script = 'set -euo pipefail\n' + snippet[0].split('\n').map(line => line.slice(snippet[1].length)).join('\n');
  return spawnSync('/bin/bash', ['-c', script], { cwd: root, env: { ...env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag }, encoding: 'utf8', timeout: 10000 });
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'th-native-release-')), root = join(directory, 'repo'), remote = join(directory, 'origin.git'), binary = join(directory, 'bin');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(binary);
  command(directory, ['init', '--bare', remote]); command(root, ['init', '-b', 'main']);
  command(root, ['config', 'user.name', 'Release Tests']); command(root, ['config', 'user.email', 'release-tests@example.invalid']);
  command(root, ['remote', 'add', 'origin', 'https://github.com/castlemilk/token-horizon']);
  // Preserve the production origin identity while Git resolves every network
  // operation to this disposable local bare repository.
  command(root, ['config', `url.${remote}.insteadOf`, 'https://github.com/castlemilk/token-horizon']);
  for (const [path, content] of nativePins('0.3.14')) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  copyFileSync(tool, join(root, 'scripts/release.mjs'));
  mkdirSync(join(root, 'clients/app'), { recursive: true }); writeFileSync(join(root, 'clients/app/package.json'), '{"version":"99.0.0"}\n');
  command(root, ['add', '.']); command(root, ['commit', '-m', 'native source snapshot']); command(root, ['tag', '-a', 'v0.3.14', '-m', 'test release']); command(root, ['push', 'origin', 'main', '--tags']);
  const state = join(directory, 'release-state.json'), log = join(directory, 'release-api.log');
  writeFileSync(state, JSON.stringify({ status: 404 }));
  writeFileSync(join(binary, 'gh'), `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst state=JSON.parse(fs.readFileSync(process.env.TH_TEST_RELEASE_STATE,'utf8'));\nfs.appendFileSync(process.env.TH_TEST_RELEASE_LOG,process.argv.slice(2).join(' ')+'\\n');\nconsole.log('HTTP/2.0 '+state.status+' Test');\nconsole.log('{}');\nprocess.exit(state.status===200?0:1);\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: binary + delimiter + process.env.PATH, TH_TEST_RELEASE_STATE: state, TH_TEST_RELEASE_LOG: log };
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), ...args], { cwd: root, env, encoding: 'utf8' });
  return { directory, root, remote, run, state, log, env };
}

test('canonical stable semver rejects ambiguous spellings and compares components numerically', () => {
  for (const version of ['', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3.4', '1.2.3-beta', '1.2.3+build', ' 1.2.3', '1.2.3\n', '1.2.3$(false)']) assert.throws(() => parseVersion(version));
  assert.equal(compareVersions('0.3.9', '0.3.14'), -1); assert.equal(compareVersions('1.0.0', '0.99.99'), 1); assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('999999999999999999999999.0.0', '999999999999999999999998.0.0'), 1);
});

test('resolution ignores prerelease/malformed tags and requires monotonically increasing new versions', () => {
  const tags = ['v0.3.9', 'v0.3.14', 'v8.0.0-preview', 'v09.0.0', 'other'];
  assert.equal(resolveVersion({ tags }).version, '0.3.15');
  assert.equal(resolveVersion({ tags, message: 'Sync auth [release minor]' }).version, '0.4.0');
  assert.equal(resolveVersion({ tags, message: '[release major]' }).version, '1.0.0');
  assert.equal(resolveVersion({ tags, message: '[release 2.0.0]' }).version, '2.0.0');
  assert.equal(resolveVersion({ tags, tag: 'v0.3.9' }).version, '0.3.9');
  for (const version of ['0.3.14', '0.3.13', '0.2.99']) assert.throws(() => resolveVersion({ tags, version }), /must be greater/);
  assert.throws(() => resolveVersion({ tags, message: '[release] [release minor]' }), /ambiguous/);
  assert.throws(() => resolveVersion({ tags, message: '[release beta]' }), /Invalid stable version/);
  assert.throws(() => resolveVersion({ tags, tag: 'v1.0.0' }), /does not exist/);
});

test('native pin setter is exact, preserves unrelated values and excludes Electron version pins', t => {
  const { root } = fixture(t);
  setPins('0.3.15', root); assert.equal(checkPins('0.3.15', root), '0.3.15');
  assert.equal(readPins(root).length, 3);
  assert.ok(readFileSync(join(root, 'packaging/homebrew/token-horizon.rb'), 'utf8').includes('keep-this-checksum'));
  assert.equal(JSON.parse(readFileSync(join(root, 'clients/app/package.json'), 'utf8')).version, '99.0.0');
  assert.throws(() => checkPins('0.3.14', root), /Version pin mismatch/);
  writeFileSync(join(root, 'scripts/make-app.sh'), 'VERSION="broken"\n');
  assert.throws(() => setPins('0.3.16', root), /Expected exactly one/);
  assert.equal(readFileSync(join(root, 'packaging/homebrew/token-horizon.rb'), 'utf8').match(/version "([^"]+)"/)[1], '0.3.15');
});

test('resolver fetches remote tags before picking a version and emits safe GitHub outputs', t => {
  const { root, remote, run } = fixture(t);
  const source = command(root, ['rev-parse', 'HEAD']); command(remote, ['update-ref', 'refs/tags/v0.3.15', source]);
  const result = run('resolve', '--version', '', '--tag', '', '--message', '', '--format', 'github');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'version=0.3.16\ntag=v0.3.16\nlatest=v0.3.15\nbump=patch\n');
  assert.equal(command(root, ['rev-parse', 'v0.3.15']), source);
});

test('workflow restores an annotated remote tag over a lightweight checkout ref for the same source', t => {
  const f = fixture(t), { root, remote, run } = f;
  command(root, ['checkout', '--detach', 'v0.3.14']);
  const source = command(root, ['rev-parse', 'HEAD']), tagObject = command(remote, ['rev-parse', 'refs/tags/v0.3.14']);
  command(root, ['update-ref', 'refs/tags/v0.3.14', source]);
  assert.equal(command(root, ['cat-file', '-t', 'v0.3.14']), 'commit', 'Reproduce the Actions lightweight checkout ref');
  const blocked = run('resolve', '--tag', 'v0.3.14');
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /would clobber existing tag/);
  const normalized = normalizeCheckoutTag(f, 'v0.3.14');
  assert.equal(normalized.status, 0, normalized.stderr);
  assert.equal(command(root, ['rev-parse', 'HEAD']), source, 'Normalization never changes checked-out source');
  assert.equal(command(root, ['cat-file', '-t', 'v0.3.14']), 'tag');
  assert.equal(command(root, ['rev-parse', 'refs/tags/v0.3.14']), tagObject);
  const result = run('resolve', '--tag', 'v0.3.14');
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).tag, 'v0.3.14');
});

test('workflow rejects a remote tag moved to a different commit after source checkout', t => {
  const f = fixture(t), { root, remote } = f, source = command(root, ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'different-source.txt'), 'different release source');
  command(root, ['add', '.']); command(root, ['commit', '-m', 'different fixture source']);
  const moved = command(root, ['rev-parse', 'HEAD']);
  command(root, ['tag', '-f', '-a', 'v0.3.14', '-m', 'moved fixture tag']);
  command(root, ['push', 'origin', 'main', '+refs/tags/v0.3.14:refs/tags/v0.3.14']);
  command(root, ['checkout', '--detach', source]); command(root, ['update-ref', 'refs/tags/v0.3.14', source]);
  assert.equal(command(remote, ['rev-parse', 'v0.3.14^{commit}']), moved);
  const result = normalizeCheckoutTag(f, 'v0.3.14');
  assert.notEqual(result.status, 0); assert.match(result.stdout, /remote release tag differs from the checked-out source commit/);
  assert.equal(command(root, ['rev-parse', 'HEAD']), source, 'Refusing the moved tag retains the original checkout');
});

test('remote fetch failure stops resolution instead of using stale local tags', t => {
  const { root, run, remote } = fixture(t);
  command(root, ['config', 'url./does/not/exist.insteadOf', 'https://github.com/castlemilk/token-horizon']);
  // Remove the successful rewrite so all calls remain hermetic and fail.
  command(root, ['config', '--unset', `url.${remote}.insteadOf`]);
  const result = run('resolve'); assert.notEqual(result.status, 0); assert.match(result.stderr, /git fetch failed/);
});

test('dirty tracked, staged and untracked native changes cannot release even during dry run', t => {
  const { root, run, remote } = fixture(t), before = command(remote, ['show-ref']);
  writeFileSync(join(root, 'native-change.swift'), 'let needsShipping = true\n');
  let result = run('release', 'patch', '--dry-run'); assert.notEqual(result.status, 0); assert.match(result.stderr, /clean committed working tree/);
  command(root, ['add', 'native-change.swift']); result = run('release', 'patch'); assert.notEqual(result.status, 0); assert.match(result.stderr, /clean committed working tree/);
  assert.equal(command(remote, ['show-ref']), before); assert.equal(command(root, ['tag', '--list']), 'v0.3.14');
});

test('existing GitHub release and API authentication failures fail closed without pin changes', t => {
  const { root, run, state } = fixture(t);
  for (const status of [200, 401, 429, 500]) {
    writeFileSync(state, JSON.stringify({ status }));
    const result = run('release', 'patch', '--dry-run'); assert.notEqual(result.status, 0);
    assert.match(result.stderr, status === 200 ? /already exists/ : /Could not verify GitHub release absence/);
    assert.equal(checkPins('0.3.14', root), '0.3.14');
  }
});

test('release refuses another branch, a behind main, an unrelated origin and duplicate release version', t => {
  const { root, remote, run } = fixture(t);
  command(root, ['checkout', '-b', 'codex/not-release']); let result = run('release', 'patch', '--dry-run'); assert.match(result.stderr, /requires the main branch/);
  command(root, ['checkout', 'main']);
  writeFileSync(join(root, 'later.txt'), 'later'); command(root, ['add', '.']); command(root, ['commit', '-m', 'remote newer source']); command(root, ['push', 'origin', 'main']); command(root, ['reset', '--hard', 'HEAD~1']);
  result = run('release', 'patch', '--dry-run'); assert.match(result.stderr, /behind or diverged/);
  command(root, ['reset', '--hard', command(remote, ['rev-parse', 'refs/heads/main'])]);
  result = run('release', '0.3.14', '--dry-run'); assert.match(result.stderr, /must be greater/);
  command(root, ['remote', 'set-url', 'origin', '/unexpected/repository']); result = run('release', 'patch', '--dry-run'); assert.match(result.stderr, /Release origin must point/);
});

test('dry run checks the same remote/GitHub policy while preserving source, refs and pins', t => {
  const { root, remote, run, log } = fixture(t), head = command(root, ['rev-parse', 'HEAD']), refs = command(remote, ['show-ref']);
  const result = run('release', 'patch', '--dry-run'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, '0.3.15'); assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(command(root, ['rev-parse', 'HEAD']), head); assert.equal(command(remote, ['show-ref']), refs); assert.equal(checkPins('0.3.14', root), '0.3.14');
  assert.match(readFileSync(log, 'utf8'), /releases\/tags\/v0\.3\.15/);
});

test('guarded native release includes committed source, bumps three pins and atomically pushes main plus tag', t => {
  const { root, remote, run } = fixture(t);
  writeFileSync(join(root, 'sync-auth.swift'), 'let browserLoginWorks = true\n'); command(root, ['add', '.']); command(root, ['commit', '-m', 'fix native sync']);
  const result = run('release', 'patch'); assert.equal(result.status, 0, result.stderr);
  const tagCommit = command(remote, ['rev-parse', 'v0.3.15^{commit}']);
  assert.equal(command(remote, ['rev-parse', 'refs/heads/main']), tagCommit);
  assert.equal(command(remote, ['show', `${tagCommit}:sync-auth.swift`]), 'let browserLoginWorks = true');
  assert.equal(command(root, ['cat-file', '-t', 'v0.3.15']), 'tag'); assert.equal(checkPins('0.3.15', root), '0.3.15');
  assert.equal(command(root, ['status', '--porcelain']), '');
  assert.equal(JSON.parse(readFileSync(join(root, 'clients/app/package.json'), 'utf8')).version, '99.0.0');
});

test('an atomic tag rejection cannot push only the release main commit', t => {
  const { root, remote, run } = fixture(t), before = command(remote, ['rev-parse', 'refs/heads/main']);
  writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nwhile read previous next ref; do\n  if [ "$ref" = refs/tags/v0.3.15 ]; then exit 1; fi\ndone\n', { mode: 0o755 });
  const result = run('release', 'patch'); assert.notEqual(result.status, 0); assert.match(result.stderr, /atomic push/);
  assert.equal(command(remote, ['rev-parse', 'refs/heads/main']), before);
  assert.equal(command(remote, ['tag', '--list']), 'v0.3.14');
  assert.equal(command(root, ['cat-file', '-t', 'v0.3.15']), 'tag', 'Failed local refs remain reviewable');
});

test('release cannot downgrade version pins already prepared in a committed native snapshot', t => {
  const { root, run } = fixture(t);
  setPins('0.4.0', root); command(root, ['add', '.']); command(root, ['commit', '-m', 'prepare native minor version']);
  const result = run('release', 'patch', '--dry-run'); assert.notEqual(result.status, 0); assert.match(result.stderr, /would downgrade the committed native pins/);
});

test('tag preflight checks exact source/pins and allows only an explicit unpublished backfill', t => {
  const { root, run, remote, state } = fixture(t);
  let result = run('preflight', '0.3.14', '--tag'); assert.equal(result.status, 0, result.stderr);
  const source = command(root, ['rev-parse', 'HEAD']); command(remote, ['update-ref', 'refs/tags/v0.3.15', source]);
  result = run('preflight', '0.3.14', '--tag'); assert.match(result.stderr, /older than/);
  result = run('preflight', '0.3.14', '--tag', '--allow-backfill'); assert.equal(result.status, 0, result.stderr);
  writeFileSync(state, JSON.stringify({ status: 200 })); result = run('preflight', '0.3.14', '--tag', '--allow-backfill'); assert.match(result.stderr, /already exists/);
});

test('CI allows only a clean detached checkout exactly at the refreshed main ref', t => {
  const { root, run } = fixture(t);
  command(root, ['checkout', '--detach', 'HEAD']);
  let result = run('release', 'patch', '--dry-run'); assert.match(result.stderr, /requires the main branch/);
  result = run('release', 'patch', '--ci', '--dry-run'); assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, 'not-main.txt'), 'detached change'); command(root, ['add', '.']); command(root, ['commit', '-m', 'detached draft']);
  result = run('release', 'patch', '--ci', '--dry-run'); assert.match(result.stderr, /requires the main branch/);
});

test('Task argument transport does not execute shell syntax', t => {
  const { root, env } = fixture(t), target = join(root, 'unexpected-shell-write');
  let result = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), 'release', '--args-env'], { cwd: root, env: { ...env, TH_RELEASE_ARGS: 'patch --dry-run' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), 'release', '--args-env'], { cwd: root, env: { ...env, TH_RELEASE_ARGS: `patch; touch ${target}` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /at most one/);
  assert.equal(command(root, ['status', '--porcelain']), '');
});
