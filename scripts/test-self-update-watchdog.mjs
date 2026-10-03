import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the exact production shell control flow, with launch/process/HTTP
// outcomes and sleeps simulated. Real plutil parses fixture health responses;
// real mv/rm operate behind guards that restrict them to owned temporary files.
// This does not launch an app, contact :8765, signal a process, or use launchd.
const source = readFileSync(new URL('../clients/macos/Sources/TokenHorizon/App/SelfUpdatePlan.swift', import.meta.url), 'utf8');
const literal = source.match(/    static let script = #"""\n([\s\S]*?)\n    """#/);
assert.ok(literal, 'The exact SelfUpdateRelaunch raw shell literal must remain testable');
// Swift removes the closing delimiter's four-space indentation from each line.
const original = literal[1].split('\n').map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n');
const skip = process.platform !== 'darwin' || !existsSync('/usr/bin/plutil') ? 'Requires macOS plutil for real health parsing' : false;
const version = '1.2.3', commit = 'abcdef1';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

const stub = `#!/bin/sh
command="\${0##*/}"
{
  printf '%s' "$command"
  for value in "$@"; do printf '\\t%s' "$value"; done
  printf '\\n'
} >> "$TH_WATCHDOG_LOG"
unexpected() {
  printf 'Unexpected %s boundary\\n' "$command" >> "$TH_WATCHDOG_ERRORS"
  exit 99
}
case "$command" in
  kill)
    [ "$#" = 2 ] && [ "$1" = -0 ] && [ "$2" = 12345 ] || unexpected
    [ "$TH_WATCHDOG_PARENT_LIVE" = 1 ]
    ;;
  curl)
    [ "$#" = 4 ] && [ "$1" = -fsS ] && [ "$2" = --max-time ] && [ "$3" = 1 ] &&
      [ "$4" = http://127.0.0.1:8765/health ] || unexpected
    /bin/cat "$TH_WATCHDOG_HEALTH"
    ;;
  open)
    [ "$#" = 2 ] && [ "$1" = -n ] && [ "$2" = "$TH_WATCHDOG_APP" ] || unexpected
    exit 0
    ;;
  launchctl)
    [ "$#" = 3 ] && [ "$1" = kickstart ] && [ "$2" = -k ] && [ "$3" = "$TH_WATCHDOG_SERVICE" ] || unexpected
    [ "$TH_WATCHDOG_LAUNCH_FAIL" != 1 ]
    ;;
  sleep)
    [ "$#" = 1 ] && { [ "$1" = 0.2 ] || [ "$1" = 1 ]; } || unexpected
    exit 0
    ;;
  mv)
    [ "$#" = 2 ] || unexpected
    case "$1" in "$TH_WATCHDOG_DIRECTORY"/*) ;; *) unexpected ;; esac
    case "$2" in "$TH_WATCHDOG_DIRECTORY"/*) ;; *) unexpected ;; esac
    if [ "$TH_WATCHDOG_RESTORE_FAIL" = 1 ] && [ "$1" = "$TH_WATCHDOG_BACKUP" ] && [ "$2" = "$TH_WATCHDOG_APP" ]; then exit 75; fi
    /bin/mv "$@"
    ;;
  rm)
    [ "$#" = 2 ] && [ "$1" = -f ] && [ "$2" = "$TH_WATCHDOG_REPORT" ] || unexpected
    /bin/rm "$@"
    ;;
  *) unexpected ;;
esac
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'th-self-update-watchdog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'bin'), directory = join(root, "Apps ' $HOME `literal` with spaces");
  mkdirSync(binary, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  const app = join(directory, "Token ' $HOME `candidate`.app");
  const backup = join(directory, "Token ' $backup `previous`.backup.app");
  const failed = join(directory, "Token ' $failed `recovery`.failed.app");
  const report = join(directory, "report ' $status `literal`.txt");
  const log = join(directory, 'boundaries.tsv'), health = join(directory, 'health.json'), errors = join(directory, 'errors.txt');
  for (const [path, payload] of [[app, 'candidate'], [backup, 'previous']]) {
    mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, 'bundle.txt'), payload, { mode: 0o600 });
  }
  writeFileSync(report, 'existing report\n', { mode: 0o600 });
  writeFileSync(log, '', { mode: 0o600 }); writeFileSync(errors, '', { mode: 0o600 });
  let script = original;
  // These are the only substitutions. mv/rm retain real filesystem behavior,
  // with ownership guards and an optional injected backup-restore failure.
  for (const path of ['/bin/kill', '/usr/bin/curl', '/usr/bin/open', '/bin/launchctl', '/bin/sleep', '/bin/mv', '/bin/rm']) {
    const command = path.split('/').at(-1), executable = join(binary, command);
    assert.ok(script.includes(path), `Missing production command boundary ${path}`);
    writeFileSync(executable, stub, { mode: 0o700 });
    script = script.replaceAll(path, quote(executable));
  }
  const contents = path => existsSync(path) ? readFileSync(join(path, 'bundle.txt'), 'utf8') : null;
  const events = command => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('\t'))
    .filter(event => command === undefined || event[0] === command);
  const run = ({ actualVersion = version, actualCommit = commit, live = false, restoreFailure = false,
    service = 'gui/1234/local.benebsworth.token-horizon', launchFailure = false } = {}) => {
    writeFileSync(health, JSON.stringify({ ok: true, build: { version: actualVersion, commit: actualCommit } }), { mode: 0o600 });
    const result = spawnSync('/bin/sh', ['-c', script, 'token-horizon-update', '12345', app, backup, failed, service, version, commit, report], {
      env: { ...process.env, TH_WATCHDOG_LOG: log, TH_WATCHDOG_HEALTH: health, TH_WATCHDOG_PARENT_LIVE: live ? '1' : '0',
        TH_WATCHDOG_APP: app, TH_WATCHDOG_BACKUP: backup, TH_WATCHDOG_SERVICE: service, TH_WATCHDOG_DIRECTORY: directory,
        TH_WATCHDOG_REPORT: report, TH_WATCHDOG_ERRORS: errors, TH_WATCHDOG_RESTORE_FAIL: restoreFailure ? '1' : '0',
        TH_WATCHDOG_LAUNCH_FAIL: launchFailure ? '1' : '0' },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(errors, 'utf8'), '', 'A stub must never accept an unexpected external command');
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    return result;
  };
  return { root, directory, app, backup, failed, report, contents, events, run };
}

test('matching version and commit succeeds through the matching LaunchAgent and clears the report', { skip }, t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0);
  assert.equal(f.contents(f.app), 'candidate'); assert.equal(f.contents(f.backup), 'previous'); assert.equal(f.contents(f.failed), null);
  assert.equal(existsSync(f.report), false);
  assert.equal(f.events('curl').length, 1);
  assert.deepEqual(f.events('launchctl'), [['launchctl', 'kickstart', '-k', 'gui/1234/local.benebsworth.token-horizon']]);
  assert.deepEqual(f.events('open'), []);
});

for (const [name, health] of [['wrong version', { actualVersion: '1.2.2' }], ['wrong commit', { actualCommit: '1234567' }]]) {
  test(`${name} exhausts bounded health checks and restores the backup with automatic retry paused`, { skip }, t => {
    const f = fixture(t), result = f.run(health);
    assert.equal(result.status, 1);
    assert.equal(f.contents(f.app), 'previous'); assert.equal(f.contents(f.backup), null); assert.equal(f.contents(f.failed), 'candidate');
    assert.equal(readFileSync(f.report, 'utf8'), version + '\nThe new version did not start correctly. Your previous version was restored; automatic retry is paused for this release.\n');
    assert.equal(f.events('curl').length, 30);
    assert.equal(f.events('launchctl').length, 2);
    assert.equal(f.events('sleep').length, 30);
  });
}

test('a parent that never exits leaves all bundles unchanged and reports the incomplete restart', { skip }, t => {
  const f = fixture(t), result = f.run({ live: true });
  assert.equal(result.status, 1);
  assert.equal(f.contents(f.app), 'candidate'); assert.equal(f.contents(f.backup), 'previous'); assert.equal(f.contents(f.failed), null);
  assert.equal(readFileSync(f.report, 'utf8'), version + '\nThe update is installed, but Token Horizon did not exit. Restart the app to finish.\n');
  assert.equal(f.events('sleep').length, 150);
  assert.equal(f.events('kill').length, 152);
  assert.equal(f.events().some(([command]) => ['curl', 'open', 'launchctl', 'mv', 'rm'].includes(command)), false);
});

test('a failed restore rename reinstates the candidate and preserves the recovery backup', { skip }, t => {
  const f = fixture(t), result = f.run({ actualCommit: 'wrong', restoreFailure: true });
  assert.equal(result.status, 1);
  assert.equal(f.contents(f.app), 'candidate'); assert.equal(f.contents(f.backup), 'previous'); assert.equal(f.contents(f.failed), null);
  assert.equal(readFileSync(f.report, 'utf8'), version + '\nUpdate recovery failed. Restore the backup app beside this installation before retrying.\n');
  assert.deepEqual(f.events('mv'), [['mv', f.app, f.failed], ['mv', f.backup, f.app], ['mv', f.failed, f.app]]);
  assert.equal(f.events('launchctl').length, 1);
});

test('a missing agent uses open with the exact punctuation-containing app path', { skip }, t => {
  const f = fixture(t), result = f.run({ service: '' });
  assert.equal(result.status, 0);
  assert.deepEqual(f.events('open'), [['open', '-n', f.app]]);
  assert.deepEqual(f.events('launchctl'), []);
  assert.equal(existsSync(f.report), false);
});

test('an unavailable matching agent falls back to open and still validates health', { skip }, t => {
  const f = fixture(t), result = f.run({ launchFailure: true });
  assert.equal(result.status, 0);
  assert.deepEqual(f.events().filter(([command]) => ['launchctl', 'open'].includes(command)), [
    ['launchctl', 'kickstart', '-k', 'gui/1234/local.benebsworth.token-horizon'], ['open', '-n', f.app]
  ]);
  assert.equal(f.events('curl').length, 1);
  assert.equal(existsSync(f.report), false);
});

test('app paths remain literal data without creating shell expansion artifacts', { skip }, t => {
  const f = fixture(t), result = f.run({ service: '' });
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(f.root).sort(), ["Apps ' $HOME `literal` with spaces", 'bin'].sort());
  assert.deepEqual(readdirSync(f.directory).sort(), [
    "Token ' $HOME `candidate`.app", "Token ' $backup `previous`.backup.app", 'boundaries.tsv', 'health.json', 'errors.txt'
  ].sort());
  assert.deepEqual(f.events('open'), [['open', '-n', f.app]]);
});
