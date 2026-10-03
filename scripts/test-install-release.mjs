import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the production transaction without sourcing the build/launcher or
// touching /Applications. Platform commands are hermetic fixture executables.
const launcher = readFileSync(new URL('./make-app.sh', import.meta.url), 'utf8');
const transaction = launcher.match(/# BEGIN verified release installation[^\n]*\n([\s\S]+?)# END verified release installation/);
assert.ok(transaction, 'The verified installation transaction must remain testable');
const script = 'set -euo pipefail\n' + transaction[1] + '\ninstall_release_app "$1" "$2"\n';

const mock = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.TH_INSTALL_LOG, JSON.stringify({command,args})+'\\n');
function digest(root) {
  const hash = crypto.createHash('sha256');
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === '.fixture-seal') continue;
      const file = path.join(directory,name);
      if (fs.statSync(file).isDirectory()) visit(file);
      else { hash.update(path.relative(root,file)); hash.update(fs.readFileSync(file)); }
    }
  }
  visit(root); return hash.digest('hex');
}
try {
  const failure = process.env.TH_INSTALL_FAILURE;
  if (command === 'ditto') {
    if (failure === 'copy') throw Error('Injected copy failure');
    fs.cpSync(args[0],args[1],{recursive:true});
    if (failure === 'copied-signature') fs.writeFileSync(path.join(args[1],'unexpected-file'),'corrupt copy');
  } else if (command === 'codesign') {
    const app = args.at(-1);
    if (fs.readFileSync(path.join(app,'.fixture-seal'),'utf8') !== digest(app)) throw Error('Fixture resource seal is invalid');
  } else if (command === 'mv') {
    const [source,destination] = args;
    const prepared = source.includes('/.TokenHorizon-install.') && source.endsWith('/TokenHorizon.app');
    const current = source === process.env.TH_INSTALL_DESTINATION;
    const backup = source === process.env.TH_INSTALL_DESTINATION.replace(/\\.app$/,'')+'.backup.app';
    if ((prepared && ['prepared','partial','prepared-and-restore'].includes(failure)) ||
        (current && failure === 'current') || (backup && failure === 'backup') ||
        (backup && destination === process.env.TH_INSTALL_DESTINATION && failure === 'prepared-and-restore')) {
      if (prepared && failure === 'partial') { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination,'partial'),'failed move'); }
      throw Error('Injected rename failure');
    }
    fs.renameSync(source,destination);
  } else if (command === 'pgrep') {
    process.exit(1);
  } else if (command === 'pkill') {
    throw Error('Fixture must never terminate an app');
  } else if (command === 'xcrun') {
    if (args[0] !== 'stapler' || args[1] !== 'validate') throw Error('Unexpected xcrun command');
    if (failure === 'stapler') throw Error('Injected notarization verification failure');
  } else if (command === 'spctl') {
    if (failure === 'gatekeeper') throw Error('Injected Gatekeeper verification failure');
  } else if (command !== 'spctl') throw Error('Unexpected fixture command');
} catch (error) { console.error(error.message); process.exit(1); }
`;

function fixture(t, { current = true, backup = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'th-install-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root,'bin'), parent = join(root,"Apps ' $ ` safe"), source = join(root,'Downloaded.app');
  const destination = join(parent,'TokenHorizon.app'), recovery = join(parent,'TokenHorizon.backup.app'), log = join(root,'commands.jsonl');
  mkdirSync(binary); mkdirSync(parent); writeFileSync(log,'');
  for (const command of ['ditto','codesign','spctl','xcrun','mv','pgrep','pkill']) writeFileSync(join(binary,command),mock,{mode:0o755});
  function app(directory, kind) {
    mkdirSync(join(directory,'Contents','Resources'),{recursive:true});
    const resource = kind === 'new' ? 'new-resource' : kind === 'current' ? 'removed-resource' : 'old-backup-resource';
    const relative = join('Contents','Resources',resource), content = kind+' bundle';
    writeFileSync(join(directory,relative),content);
    writeFileSync(join(directory,'.fixture-seal'),createHash('sha256').update(relative).update(content).digest('hex'));
  }
  app(source,'new'); if (current) app(destination,'current'); if (backup) app(recovery,'older');
  const run = failure => spawnSync('/bin/bash',['-c',script,'test-install-release',source,destination],{
    env:{...process.env,PATH:binary+delimiter+process.env.PATH,TH_INSTALL_LOG:log,TH_INSTALL_DESTINATION:destination,TH_INSTALL_FAILURE:failure||''},
    encoding:'utf8',timeout:15000
  });
  const resource = (directory,name) => existsSync(join(directory,'Contents','Resources',name));
  const operations = () => readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const stages = () => readdirSync(parent).filter(name=>name.startsWith('.TokenHorizon-install.')).map(name=>join(parent,name));
  return {root,parent,source,destination,recovery,run,resource,operations,stages};
}

test('fresh release replacement removes obsolete resources and keeps the previous app as backup', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status,0,result.stderr);
  assert.ok(f.resource(f.destination,'new-resource'));
  assert.equal(f.resource(f.destination,'removed-resource'),false);
  assert.ok(f.resource(f.recovery,'removed-resource'));
  assert.equal(f.resource(f.recovery,'old-backup-resource'),false);
  assert.equal(readFileSync(join(f.destination,'.fixture-seal'),'utf8'),readFileSync(join(f.source,'.fixture-seal'),'utf8'));
  assert.deepEqual(f.stages(),[]);
  const operations = f.operations();
  assert.deepEqual(operations.slice(0,4).map(operation=>operation.command),['ditto','codesign','spctl','xcrun']);
  assert.ok(operations.findIndex(operation=>operation.command==='mv') > operations.findIndex(operation=>operation.command==='xcrun'));
  assert.equal(operations.some(operation=>operation.command==='pkill'),false);
});

for (const failure of ['copy','copied-signature','gatekeeper','stapler','backup','current','prepared','partial']) {
  test(`failed ${failure} preserves the installed app and its previous backup`, t => {
    const f = fixture(t), result = f.run(failure);
    assert.notEqual(result.status,0);
    assert.ok(f.resource(f.destination,'removed-resource'),result.stderr);
    assert.ok(f.resource(f.recovery,'old-backup-resource'),result.stderr);
    assert.equal(f.resource(f.destination,'new-resource'),false);
    assert.deepEqual(f.stages(),[]);
    if (['copy','copied-signature','gatekeeper','stapler'].includes(failure)) assert.equal(f.operations().some(operation=>operation.command==='mv'||operation.command==='pgrep'),false);
  });
}

test('failed restoration preserves every recovery copy and reports its location', t => {
  const f = fixture(t), result = f.run('prepared-and-restore');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Preserved copies:/);
  assert.equal(existsSync(f.destination),false);
  assert.ok(f.resource(f.recovery,'removed-resource'));
  assert.equal(f.stages().length,1);
  assert.ok(f.resource(join(f.stages()[0],'previous.app'),'old-backup-resource'));
});

test('a first installation keeps an existing recovery copy', t => {
  const f = fixture(t,{current:false}), result = f.run();
  assert.equal(result.status,0,result.stderr);
  assert.ok(f.resource(f.destination,'new-resource'));
  assert.ok(f.resource(f.recovery,'old-backup-resource'));
  assert.deepEqual(f.stages(),[]);
});

test('replacement without an older backup still restores the installed app on failure', t => {
  const f = fixture(t,{backup:false}), result = f.run('prepared');
  assert.notEqual(result.status,0);
  assert.ok(f.resource(f.destination,'removed-resource'));
  assert.equal(existsSync(f.recovery),false);
  assert.deepEqual(f.stages(),[]);
});

for (const target of ['destination','recovery']) {
  test(`symlink ${target} is rejected before copying or modifying any bundle`, t => {
    const f = fixture(t), external = join(f.root,'external.app');
    mkdirSync(external); writeFileSync(join(external,'untouched'),'original');
    rmSync(f[target],{recursive:true}); symlinkSync(external,f[target]);
    const result = f.run();
    assert.notEqual(result.status,0); assert.match(result.stderr,/not symlinks/);
    assert.equal(readFileSync(join(external,'untouched'),'utf8'),'original');
    assert.deepEqual(f.operations(),[]);
    assert.deepEqual(f.stages(),[]);
  });
}
