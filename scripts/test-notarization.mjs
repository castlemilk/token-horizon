import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Execute the actual submission policy without building, signing, accessing
// the Keychain, or contacting Apple. Every notarytool response is a fixture.
const packagerPath = fileURLToPath(new URL('./package-notarized.sh', import.meta.url));
const packager = readFileSync(packagerPath, 'utf8');
const policy = packager.match(/# BEGIN notarization submission policy[^\n]*\n([\s\S]+?)# END notarization submission policy/);
assert.ok(policy, 'The production notarization submission policy must remain testable');
const script = `set -euo pipefail
die() { printf 'error: %s\\n' "$1" >&2; exit 1; }
${policy[1]}
WORK="$1"
NOTARY_ARGS=(--apple-id fixture@example.invalid --team-id FIXTURETEAM --password "$TH_NOTARY_TEST_PASSWORD")
submit "$2"
`;
const password = "fixture-password ' $ ` private";
const accepted = { stdout: { status: 'Accepted', id: 'd8328500-95a2-438b-a373-216926eced7e' } };

const mock = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
if (command !== 'xcrun') {
  fs.appendFileSync(process.env.TH_NOTARY_TEST_LOG,JSON.stringify({command})+'\\n');
  console.error('Unexpected command before notarization option validation'); process.exit(99);
}
const previous = fs.readFileSync(process.env.TH_NOTARY_TEST_LOG,'utf8').trim().split('\\n').filter(Boolean);
const responses = JSON.parse(fs.readFileSync(process.env.TH_NOTARY_TEST_RESPONSES,'utf8'));
const standard = args.includes('--no-s3-acceleration'), accelerated = args.includes('--s3-acceleration');
const passwordIndex = args.indexOf('--password');
const credentialsPreserved = passwordIndex >= 0 && args[passwordIndex+1] === process.env.TH_NOTARY_TEST_PASSWORD &&
  args.includes('fixture@example.invalid') && args.includes('FIXTURETEAM');
fs.appendFileSync(process.env.TH_NOTARY_TEST_LOG,JSON.stringify({command,artifact:args[2],standard,accelerated,credentialsPreserved})+'\\n');
if (args[0] !== 'notarytool' || args[1] !== 'submit' || !args.includes('--wait') ||
    args[args.indexOf('--output-format')+1] !== 'json' || standard === accelerated || !credentialsPreserved) {
  console.error('Unexpected submission arguments'); process.exit(99);
}
const response = responses[previous.length];
if (!response) { console.error('Unexpected extra submission'); process.exit(99); }
if (response.stdout !== undefined) console.log(typeof response.stdout === 'string' ? response.stdout : JSON.stringify(response.stdout));
if (response.stderr) console.error(response.stderr);
process.exit(response.exit || 0);
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'th-notarization-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'bin'), work = join(root, 'work');
  const artifact = join(root, "Token Horizon ' $ ` signed.zip");
  const log = join(root, 'commands.jsonl'), responses = join(root, 'responses.json');
  mkdirSync(binary); mkdirSync(work); writeFileSync(artifact, 'fixture archive');
  for (const command of ['xcrun', 'mktemp', 'security', 'git', 'env']) writeFileSync(join(binary, command), mock, { mode: 0o755 });
  const operations = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const run = (results, { mode, fullScript = false } = {}) => {
    writeFileSync(log, ''); writeFileSync(responses, JSON.stringify(results));
    const env = { ...process.env, PATH: binary + delimiter + process.env.PATH,
      TH_NOTARY_TEST_LOG: log, TH_NOTARY_TEST_RESPONSES: responses, TH_NOTARY_TEST_PASSWORD: password };
    delete env.NOTARY_S3_ACCELERATION;
    if (mode !== undefined) env.NOTARY_S3_ACCELERATION = mode;
    const result = spawnSync('/bin/bash', fullScript ? [packagerPath] : ['-c', script, 'test-notarization', work, artifact], {
      env, encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.error, undefined);
    assert.equal((result.stdout + result.stderr).includes(password), false, 'Submit diagnostics must not expose credentials');
    for (const operation of operations()) {
      assert.equal(operation.artifact, artifact);
      assert.equal(operation.credentialsPreserved, true);
    }
    return result;
  };
  return { run, operations };
}

test('default accelerated submission succeeds only after Apple accepts it', t => {
  const f = fixture(t), result = f.run([accepted]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Notarization accepted: d8328500/);
  assert.equal(f.operations().length, 1);
  assert.equal(f.operations()[0].accelerated, true);
  assert.equal(f.operations()[0].standard, false);
});

for (const transport of ['abortedUpload', 'HTTPClientError.deadlineExceeded']) {
  test(`${transport} retries exactly once through the standard endpoint`, t => {
    const f = fixture(t), result = f.run([{ exit: 1, stderr: transport + ': ' + password }, accepted]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /retrying once with S3 acceleration disabled/);
    assert.deepEqual(f.operations().map(operation => operation.standard), [false, true]);
    assert.match(result.stdout, /Notarization accepted:/);
  });
}

test('explicit standard mode disables acceleration from the first submission', t => {
  const f = fixture(t), result = f.run([accepted], { mode: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.operations().map(operation => operation.standard), [true]);
});

test('standard mode does not retry an upload failure', t => {
  const f = fixture(t), result = f.run([{ exit: 1, stderr: 'abortedUpload: ' + password }, accepted], { mode: '0' });
  assert.notEqual(result.status, 0);
  assert.equal(f.operations().length, 1);
  assert.match(result.stderr, /no transport retry was attempted/);
});

test('invalid acceleration options fail in the complete packager before external commands', t => {
  const f = fixture(t);
  for (const mode of ['', '2', 'true', '01', '$(false)']) {
    const result = f.run([], { mode, fullScript: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NOTARY_S3_ACCELERATION must be 0 or 1/);
    assert.deepEqual(f.operations(), []);
  }
});

for (const status of ['Invalid', 'Rejected', 'In Progress']) {
  test(`Apple's ${status} result fails without retry`, t => {
    const f = fixture(t), result = f.run([{ stdout: { status, id: 'decision' }, stderr: 'abortedUpload' }, accepted]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Apple did not accept notarization:/);
    assert.equal(f.operations().length, 1);
  });
}

test('a reported submission never retries a failure during the processing wait', t => {
  const f = fixture(t), result = f.run([{ exit: 1, stdout: { id: 'existing-submission', status: 'Invalid' }, stderr: 'HTTPClientError.deadlineExceeded' }, accepted]);
  assert.notEqual(result.status, 0);
  assert.equal(f.operations().length, 1);
});

test('credential failures never retry or print credential diagnostics', t => {
  const f = fixture(t);
  for (const stderr of ['HTTP status code: 401. Invalid credentials', 'Invalid credentials: abortedUpload', 'HTTP status code: 403. HTTPClientError.deadlineExceeded']) {
    const result = f.run([{ exit: 1, stderr: stderr + ': ' + password }, accepted]);
    assert.notEqual(result.status, 0);
    assert.equal(f.operations().length, 1);
    assert.match(result.stderr, /no transport retry was attempted/);
  }
});

test('an unrecognized submit failure does not retry', t => {
  const f = fixture(t), result = f.run([{ exit: 1, stderr: 'Service unavailable: ' + password }, accepted]);
  assert.notEqual(result.status, 0);
  assert.equal(f.operations().length, 1);
});

test('missing or malformed Apple results cannot count as acceptance', t => {
  const f = fixture(t);
  for (const stdout of ['', 'not JSON', {}, []]) {
    const result = f.run([{ stdout }, accepted]);
    assert.notEqual(result.status, 0);
    assert.equal(f.operations().length, 1);
  }
});

test('a rejected standard retry still prevents artifact acceptance', t => {
  const f = fixture(t), result = f.run([{ exit: 1, stderr: 'abortedUpload' }, { stdout: { status: 'Invalid' } }, accepted]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Apple did not accept notarization: Invalid/);
  assert.equal(f.operations().length, 2);
  assert.doesNotMatch(result.stdout, /Notarization accepted:/);
});

test('a second transport failure stops after the one standard retry', t => {
  const f = fixture(t), result = f.run([{ exit: 1, stderr: 'abortedUpload' }, { exit: 1, stderr: 'HTTPClientError.deadlineExceeded: ' + password }, accepted]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed after the standard-endpoint retry/);
  assert.equal(f.operations().length, 2);
  assert.doesNotMatch(result.stdout, /Notarization accepted:/);
});
