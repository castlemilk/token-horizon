import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the production shell, replacing every Apple/build command with an
// owned fixture. No signing identity, Keychain, app, disk mount or network is used.
const packager = readFileSync(new URL('./package-notarized.sh', import.meta.url), 'utf8');
const signing = packager.match(/# BEGIN disk image signing policy[^\n]*\n([\s\S]+?)# END disk image signing policy/);
const submission = packager.match(/# BEGIN notarization submission policy[^\n]*\n([\s\S]+?)# END notarization submission policy/);
const tailStart = packager.indexOf('# Never erase OUTPUT_DIR or overwrite an existing version\'s artifacts.');
assert.ok(signing && submission && tailStart >= 0, 'Production signing and packaging policies must remain testable');
const prelude = `set -euo pipefail
die() { printf 'error: %s\\n' "$1" >&2; exit 1; }
${signing[1]}`;
const helperScript = `${prelude}\nsign_disk_image "$1" "$2" "$3"\n`;
const packagingScript = `${prelude}
${submission[1]}
WORK="$1"
OUTPUT_DIR="$2"
SIGN_IDENTITY="$3"
SIGNED_TEAM="$4"
APP_NAME=TokenHorizon
APP="\${APP_NAME}.app"
VERSION=1.2.3
CAN_NOTARIZE=1
NOTARY_ARGS=(--keychain-profile fixture-profile)
${packager.slice(tailStart)}`;
const team = 'ABC12345DE';
const identifier = 'local.benebsworth.token-horizon.dmg';
const identity = "Developer ID Application: Fixture's $ ` Team (ABC12345DE)";
const metadata = [
  `Identifier=${identifier}`,
  `Authority=Developer ID Application: Fixture Team (${team})`,
  'Authority=Developer ID Certification Authority',
  'Timestamp=Oct 3, 2026 at 12:00:00',
  `TeamIdentifier=${team}`
].join('\n');

// All writes, simulated mounts and moves are restricted to this test's private
// directory. Logs preserve argument boundaries, including shell punctuation.
const mock = String.raw`const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.env.TH_DMG_TEST_CONFIG, 'utf8'));
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(config.log, JSON.stringify({command, args}) + '\n');
function fail(message, code = 91) { console.error(message); process.exit(code); }
function owned(value) {
  const result = path.resolve(value);
  if (!result.startsWith(config.root + path.sep)) fail('Fixture path escaped its owned directory');
  return result;
}
function content(value) { return fs.readFileSync(owned(value), 'utf8'); }
function signed(value) { if (!content(value).includes(':SIGNED')) fail('Unsigned container reached a later gate'); }
function copyApp(destination) { fs.cpSync(config.app, owned(destination), {recursive: true}); }
function digest(value) { return crypto.createHash('sha256').update(fs.readFileSync(owned(value))).digest('hex'); }
const artifact = args.at(-1);
switch (command) {
  case 'codesign':
    owned(artifact);
    if (args[0] === '--force') {
      if (config.signFailure) fail('Fixture signing failure', 21);
      if (JSON.stringify(args) !== JSON.stringify(['--force', '--sign', config.identity,
          '--timestamp', '--identifier', config.identifier, artifact])) fail('Signing arguments changed');
      fs.appendFileSync(artifact, ':SIGNED');
    } else if (args[0] === '--verify') {
      if (config.verifyFailure) fail('Fixture verification failure', 22);
      if (artifact.endsWith('.dmg')) {
        signed(artifact);
        if (config.postStapleVerifyFailure && content(artifact).includes(':STAPLED')) fail('Fixture post-staple verification failure', 24);
      }
    } else if (args[0] === '-dv') {
      if (config.metadataFailure) fail('Fixture metadata failure', 23);
      console.error(config.metadata);
    } else fail('Unexpected codesign command');
    break;
  case 'ditto':
    if (args[0] === '-c') {
      owned(args.at(-2)); fs.writeFileSync(owned(artifact), 'fixture zip');
    } else if (args[0] === '-x') {
      owned(args.at(-2)); copyApp(path.join(owned(artifact), 'TokenHorizon.app'));
    } else { owned(args[0]); copyApp(args[1]); }
    break;
  case 'ln':
    if (args[0] !== '-s' || args[1] !== '/Applications') fail('Unexpected install shortcut');
    owned(artifact); // No actual link to the user's Applications directory is made.
    break;
  case 'hdiutil':
    if (args[0] === 'create') fs.writeFileSync(owned(artifact), 'fixture dmg');
    else if (args[0] === 'attach') {
      owned(artifact); copyApp(path.join(owned(args[args.indexOf('-mountpoint') + 1]), 'TokenHorizon.app'));
    } else if (args[0] === 'detach') owned(artifact);
    else fail('Unexpected disk image command');
    break;
  case 'xcrun':
    if (args[0] === 'notarytool' && args[1] === 'submit') {
      signed(args[2]);
      if (!args.includes('--wait') || !args.includes('--s3-acceleration')) fail('Unexpected submission');
      console.log(JSON.stringify({status: 'Accepted', id: 'fixture-accepted'}));
    } else if (args[0] === 'stapler' && args[1] === 'staple') {
      signed(artifact); fs.appendFileSync(artifact, ':STAPLED');
    } else if (args[0] === 'stapler' && args[1] === 'validate') {
      if (artifact.endsWith('.dmg') && !content(artifact).includes(':STAPLED')) fail('Unstapled container');
    } else fail('Unexpected Apple command');
    break;
  case 'spctl':
    owned(artifact);
    if (args[args.indexOf('--type') + 1] === 'open') {
      signed(artifact);
      if (!content(artifact).includes(':STAPLED') || args[args.indexOf('--context') + 1] !== 'context:primary-signature') fail('Container assessment arguments changed');
      console.error(artifact + ': ' + (config.assessmentFailure ? 'rejected' : 'accepted'));
      console.error('source=' + config.assessmentSource);
      if (config.assessmentFailure) process.exit(25);
      if (config.assessmentSource === 'Notarized Developer ID') fs.writeFileSync(config.assessed, 'accepted');
    } else if (args[args.indexOf('--type') + 1] !== 'execute') fail('Unexpected Gatekeeper command');
    break;
  case 'plutil': {
    const value = JSON.parse(content(artifact))[args[1]];
    if (args[0] !== '-extract' || args[2] !== 'raw' || value === undefined) fail('Unexpected metadata request');
    console.log(value); break;
  }
  case 'shasum':
    if (args[0] !== '-a' || args[1] !== '256') fail('Unexpected checksum options');
    if (args[2] === '-c') {
      for (const line of content(args[3]).trim().split('\n')) {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        if (!match || digest(match[2]) !== match[1]) fail('Fixture checksum mismatch');
        console.log(match[2] + ': OK');
      }
    } else for (const value of args.slice(2)) console.log(digest(value) + '  ' + value);
    break;
  case 'mv':
    if (!fs.existsSync(config.assessed)) fail('Output exposed before notarized container assessment');
    fs.renameSync(owned(args[0]), path.join(owned(args[1]), path.basename(args[0])));
    break;
  default: fail('Unexpected fixture command');
}
`;

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'th-dmg-signing-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const binary = join(root, 'bin'), work = join(root, "work ' $ `"), output = join(root, "output ' $ `");
  const app = join(root, 'TokenHorizon.app'), artifact = join(root, "Disk image ' $ `.dmg");
  const log = join(root, 'commands.jsonl'), configPath = join(root, 'config.json');
  for (const directory of [binary, work, output, join(app, 'Contents')]) mkdirSync(directory, {recursive: true});
  writeFileSync(artifact, 'fixture dmg'); writeFileSync(log, '');
  writeFileSync(join(app, 'Contents/Info.plist'), JSON.stringify({
    CFBundleShortVersionString: '1.2.3', CFBundleVersion: '9', THGitSHA: 'abcdef1', THBuiltAt: '2026-10-03T00:00:00Z'
  }));
  const config = {root, log, app, identity, identifier, metadata, assessed: join(root, 'container-assessed'),
    assessmentSource: 'Notarized Developer ID', ...options};
  writeFileSync(configPath, JSON.stringify(config));
  for (const command of ['codesign', 'ditto', 'ln', 'hdiutil', 'xcrun', 'spctl', 'plutil', 'shasum', 'mv']) {
    writeFileSync(join(binary, command), `#!${process.execPath}\n${mock}`, {mode: 0o755});
  }
  const run = ({packaging = false, expectedTeam = team} = {}) => {
    const args = packaging ? [work, output, identity, expectedTeam] : [artifact, identity, expectedTeam];
    const result = spawnSync('/bin/bash', ['-c', packaging ? packagingScript : helperScript, 'test-dmg-signing', ...args], {
      cwd: root, encoding: 'utf8', timeout: 20000,
      env: {...process.env, PATH: binary + delimiter + process.env.PATH, NOTARY_S3_ACCELERATION: '1', TH_DMG_TEST_CONFIG: configPath}
    });
    assert.equal(result.error, undefined);
    return result;
  };
  const operations = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {run, operations, artifact, output};
}

test('DMG signing preserves punctuation arguments and verifies the stable Developer ID identity', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.operations(), [
    {command: 'codesign', args: ['--force', '--sign', identity, '--timestamp', '--identifier', identifier, f.artifact]},
    {command: 'codesign', args: ['--verify', '--strict', '--verbose=2', f.artifact]},
    {command: 'codesign', args: ['-dv', '--verbose=4', f.artifact]}
  ]);
});

for (const [name, option, count] of [['signing', 'signFailure', 1], ['strict verification', 'verifyFailure', 2], ['metadata extraction', 'metadataFailure', 3]]) {
  test(`DMG ${name} failure stops at that gate`, t => {
    const f = fixture(t, {[option]: true}), result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(f.operations().length, count);
  });
}

const invalidMetadata = [
  ['missing Developer ID leaf', metadata.replace(/^Authority=Developer ID Application: .*\n/m, ''), /not Developer ID signed/],
  ['missing secure timestamp', metadata.replace(/^Timestamp=.*\n/m, ''), /lacks a secure timestamp/],
  ['empty secure timestamp', metadata.replace(/^Timestamp=.+$/m, 'Timestamp='), /lacks a secure timestamp/],
  ['missing stable identifier', metadata.replace(/^Identifier=.*\n/m, ''), /lacks its stable signing identifier/],
  ['wrong stable identifier', metadata.replace(identifier, 'local.benebsworth.token-horizon'), /lacks its stable signing identifier/],
  ['wrong team', metadata.replace(`TeamIdentifier=${team}`, 'TeamIdentifier=OTHER12345'), /team differs from the app/],
  ['empty team', metadata.replace(`TeamIdentifier=${team}`, 'TeamIdentifier='), /team differs from the app/],
  ['missing team', metadata.replace(/^TeamIdentifier=.*$/m, ''), /team differs from the app/]
];
for (const [name, value, error] of invalidMetadata) {
  test(`DMG metadata rejects ${name}`, t => {
    const f = fixture(t, {metadata: value}), result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(f.operations().length, 3);
  });
}

test('an empty expected app team cannot authorize a signed DMG', t => {
  const f = fixture(t), result = f.run({expectedTeam: ''});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /team differs from the app/);
});

test('actual packaging signs before submission and assesses the stapled container before exposing artifacts', t => {
  const f = fixture(t), result = f.run({packaging: true});
  assert.equal(result.status, 0, result.stderr);
  const operations = f.operations();
  const index = predicate => operations.findIndex(predicate);
  const create = index(o => o.command === 'hdiutil' && o.args[0] === 'create');
  const sign = index(o => o.command === 'codesign' && o.args[0] === '--force');
  const submit = index(o => o.command === 'xcrun' && o.args[0] === 'notarytool');
  const staple = index(o => o.command === 'xcrun' && o.args[1] === 'staple');
  const assess = index(o => o.command === 'spctl' && o.args.includes('open'));
  const expose = index(o => o.command === 'mv');
  assert.ok(create >= 0 && create < sign && sign < submit && submit < staple && staple < assess && assess < expose);
  assert.deepEqual(operations[assess].args.slice(0, -1), ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2']);
  assert.ok(operations.slice(staple + 1, assess).some(o => o.command === 'codesign' && o.args.includes('--strict')));
  assert.equal(operations.filter(o => o.command === 'mv').length, 3);
  assert.deepEqual(readdirSync(f.output).sort(), ['TokenHorizon-1.2.3.dmg', 'TokenHorizon-1.2.3.sha256', 'TokenHorizon-1.2.3.zip']);
});

for (const [name, options, error] of [
  ['container signing failure', {signFailure: true}, /Fixture signing failure/],
  ['post-staple signature failure', {postStapleVerifyFailure: true}, /post-staple verification failure/],
  ['Gatekeeper rejection despite notarized source text', {assessmentFailure: true}, /failed Gatekeeper assessment/],
  ['accepted but unnotarized Gatekeeper source', {assessmentSource: 'Developer ID'}, /lacks a notarized Gatekeeper assessment/],
  ['similar but nonmatching Gatekeeper source', {assessmentSource: 'Notarized Developer ID extra'}, /lacks a notarized Gatekeeper assessment/]
]) {
  test(`actual packaging blocks exposure after ${name}`, t => {
    const f = fixture(t, options), result = f.run({packaging: true});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(f.operations().filter(o => o.command === 'mv').length, 0);
    assert.deepEqual(readdirSync(f.output), []);
    if (options.signFailure) assert.equal(f.operations().filter(o => o.command === 'xcrun').length, 0);
  });
}
