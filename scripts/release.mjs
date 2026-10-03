#!/usr/bin/env node
// Shared native release policy. No dependencies and no shell interpolation.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'castlemilk/token-horizon';
const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PINS = [
  { path: 'scripts/make-app.sh', pattern: /^(VERSION="\$\{MARKETING_VERSION:-)([^}\r\n]+)(\}")$/m },
  { path: 'clients/macos/Sources/TokenHorizon/App/BuildInfo.swift', pattern: /^(\s*static var version: String \{ value\("CFBundleShortVersionString", fallback: ")([^"\r\n]+)("\) \})$/m },
  { path: 'packaging/homebrew/token-horizon.rb', pattern: /^(  version ")([^"\r\n]+)(")$/m }
];

export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !STABLE.test(value)) throw new Error(`Invalid stable version '${value}': use canonical X.Y.Z without a v prefix, leading zeros or prerelease suffix.`);
  return value.split('.').map(BigInt);
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
export function stableTags(tags) {
  return tags.filter(tag => /^v/.test(tag) && STABLE.test(tag.slice(1))).sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
}
function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === 'major') return `${major + 1n}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}
export function resolveVersion({ tags = [], version = '', tag = '', message = '', selection = '' } = {}) {
  const latest = stableTags(tags).at(-1) || 'v0.0.0';
  if (tag) {
    if (version || selection) throw new Error('Choose one release tag or version.');
    if (!/^v/.test(tag)) throw new Error('A release tag must be vX.Y.Z.');
    parseVersion(tag.slice(1));
    if (!tags.includes(tag)) throw new Error(`Tag ${tag} does not exist in fetched history.`);
    return { version: tag.slice(1), tag, latest, bump: 'tag' };
  }
  if (version && selection) throw new Error('Choose one explicit release version or bump.');
  let requested = version || selection;
  if (!requested) {
    const tokens = [...message.matchAll(/\[release(?: ([^\]\r\n]+))?\]/g)];
    if (tokens.length > 1) throw new Error('Multiple release tokens are ambiguous; use one release request.');
    requested = tokens.length ? tokens[0][1] || 'patch' : 'patch';
  }
  const bump = ['patch', 'minor', 'major'].includes(requested) ? requested : 'explicit';
  const next = bump === 'explicit' ? requested : bumpVersion(latest.slice(1), bump);
  parseVersion(next);
  if (compareVersions(next, latest.slice(1)) <= 0) throw new Error(`Version ${next} must be greater than the latest stable tag ${latest}.`);
  return { version: next, tag: `v${next}`, latest, bump };
}

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`); }
}
export function fetchHistory(root = DEFAULT_ROOT) {
  // Failure is fatal: choosing a version from stale local tags is unsafe.
  git(root, ['fetch', '--prune', '--tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  return git(root, ['tag', '--list']).split('\n').filter(Boolean);
}
export function readPins(root = DEFAULT_ROOT) {
  return PINS.map(pin => {
    const content = readFileSync(resolve(root, pin.path), 'utf8');
    const matches = [...content.matchAll(new RegExp(pin.pattern.source, 'gm'))];
    if (matches.length !== 1) throw new Error(`Expected exactly one version pin in ${pin.path}.`);
    const version = matches[0][2]; parseVersion(version);
    return { ...pin, content, version };
  });
}
export function checkPins(version, root = DEFAULT_ROOT) {
  parseVersion(version);
  for (const pin of readPins(root)) if (pin.version !== version) throw new Error(`Version pin mismatch: ${pin.path} has ${pin.version}, expected ${version}.`);
  return version;
}
export function setPins(version, root = DEFAULT_ROOT) {
  parseVersion(version);
  // Parse every file before writing any of them; malformed pins fail early.
  const changes = readPins(root).map(pin => ({ ...pin, updated: pin.content.replace(pin.pattern, (_match, prefix, _old, suffix) => prefix + version + suffix) }));
  for (const pin of changes) if (pin.updated !== pin.content) writeFileSync(resolve(root, pin.path), pin.updated);
  checkPins(version, root);
}
function ensureClean(root) {
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Release requires a clean committed working tree, including untracked files. Commit the intended native changes first; a release must not tag an older HEAD while app edits remain dirty.');
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (spawnSync('git', ['rev-parse', '-q', '--verify', state], { cwd: root, stdio: 'ignore' }).status === 0) throw new Error(`Finish the pending ${state.replace('_HEAD', '').toLowerCase()} before releasing.`);
  }
  // A rebase can have a clean intermediate tree without producing a final ref.
  for (const state of ['rebase-merge', 'rebase-apply']) if (existsSync(resolve(root, git(root, ['rev-parse', '--git-path', state])))) throw new Error('Finish the pending rebase before releasing.');
}
function ancestor(root, older, newer) {
  return spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root, stdio: 'ignore' }).status === 0;
}
function verifyOrigin(root) {
  const url = git(root, ['config', '--get', 'remote.origin.url']);
  if (![`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}`, `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}`, `ssh://git@github.com/${REPOSITORY}.git`].includes(url)) throw new Error(`Release origin must point to github.com/${REPOSITORY}; refusing to publish to another repository.`);
  const pushUrls = git(root, ['remote', 'get-url', '--push', '--all', 'origin']).split('\n');
  // Git can intentionally rewrite HTTPS to SSH. An explicit pushurl, however,
  // must not send the branch/tag to another repository.
  const configured = spawnSync('git', ['config', '--get-all', 'remote.origin.pushurl'], { cwd: root, encoding: 'utf8' });
  if (configured.status === 0 && configured.stdout.trim().split('\n').some(push => ![`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}`, `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}`, `ssh://git@github.com/${REPOSITORY}.git`].includes(push))) throw new Error('Release origin has an unexpected push URL.');
  if (pushUrls.length !== 1) throw new Error('Release origin must have exactly one push destination.');
}
export function ensureNoRelease(tag) {
  const result = spawnSync('gh', ['api', '--include', `repos/${REPOSITORY}/releases/tags/${tag}`], { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (result.error) throw new Error('GitHub CLI is required to verify that the release does not already exist.');
  if (result.status === 0) throw new Error(`GitHub release ${tag} already exists; published releases are immutable and will not be overwritten.`);
  if (/^HTTP\/[0-9.]+ 404\b/m.test(result.stdout || '')) return;
  throw new Error('Could not verify GitHub release absence. Check gh authentication and connectivity; no release changes were made.');
}
export function preflight(version, { root = DEFAULT_ROOT, tagMode = false, allowBackfill = false, ci = false, tags } = {}) {
  parseVersion(version);
  ensureClean(root);
  verifyOrigin(root);
  const fetched = tags || fetchHistory(root), target = `v${version}`, head = git(root, ['rev-parse', 'HEAD']);
  const latest = stableTags(fetched).at(-1) || 'v0.0.0';
  if (tagMode) {
    if (!fetched.includes(target)) throw new Error(`Release tag ${target} does not exist.`);
    if (git(root, ['rev-parse', `${target}^{commit}`]) !== head) throw new Error(`HEAD must be the exact source commit of ${target}.`);
    if (!allowBackfill && compareVersions(version, latest.slice(1)) < 0) throw new Error(`Tag ${target} is older than ${latest}; use --allow-backfill only to build an unpublished historical tag.`);
    checkPins(version, root);
  } else {
    const branch = git(root, ['branch', '--show-current']);
    if (branch !== 'main' && !(ci && !branch && git(root, ['rev-parse', 'origin/main']) === head)) throw new Error('Release requires the main branch, or --ci at the exact refreshed origin/main commit.');
    if (!ancestor(root, 'origin/main', 'HEAD')) throw new Error('main is behind or diverged from origin/main. Fast-forward or reconcile it before releasing.');
    if (compareVersions(version, latest.slice(1)) <= 0 || fetched.includes(target)) throw new Error(`Version ${version} must be greater than the latest stable tag ${latest}.`);
    if (latest !== 'v0.0.0' && !ancestor(root, latest, 'HEAD')) throw new Error(`HEAD does not contain the latest release ${latest}.`);
    const pins = readPins(root);
    if (pins.some(pin => pin.version !== pins[0].version)) throw new Error('Native version pins disagree; resolve the drift before releasing.');
    if (compareVersions(version, pins[0].version) < 0) throw new Error(`Version ${version} would downgrade the committed native pins ${pins[0].version}.`);
  }
  ensureNoRelease(target);
  return { version, tag: target, latest, head };
}
export function release(selection = 'patch', { root = DEFAULT_ROOT, dryRun = false, ci = false } = {}) {
  ensureClean(root);
  verifyOrigin(root);
  const tags = fetchHistory(root), resolved = resolveVersion({ tags, selection });
  preflight(resolved.version, { root, ci, tags });
  console.error(`Release plan: ${resolved.latest} → ${resolved.tag}; native pins, annotated tag, atomic main + tag push.`);
  if (dryRun) return { ...resolved, dryRun: true };
  setPins(resolved.version, root);
  const paths = PINS.map(pin => pin.path);
  git(root, ['add', '--', ...paths]);
  // Even when pins were deliberately prepared in an earlier commit, annotate
  // the reviewed HEAD rather than failing to commit an empty version change.
  if (git(root, ['diff', '--cached', '--name-only'])) git(root, ['commit', '-m', `release ${resolved.tag}`]);
  checkPins(resolved.version, root);
  ensureClean(root);
  git(root, ['tag', '-a', resolved.tag, '-m', `Token Horizon ${resolved.version}`]);
  try { git(root, ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${resolved.tag}:refs/tags/${resolved.tag}`]); }
  catch (error) { throw new Error(`${error.message}\nThe local release commit/tag remain available for inspection. The atomic push did not update only one ref; fetch and inspect before retrying.`); }
  return resolved;
}

function parseArguments(args, flags, values = []) {
  const options = {}, positional = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    if (flags.includes(argument)) options[argument.slice(2)] = true;
    else if (values.includes(argument)) {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      options[argument.slice(2)] = args[++index];
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}.`);
    else positional.push(argument);
  }
  return { options, positional };
}
function outputResolved(result, format = 'json') {
  if (format === 'json') console.log(JSON.stringify(result));
  else if (format === 'github') for (const key of ['version', 'tag', 'latest', 'bump']) console.log(`${key}=${result[key]}`);
  else throw new Error('Output format must be json or github.');
}
export function main(args = process.argv.slice(2)) {
  const command = args.shift();
  if (command === 'resolve') {
    const { options, positional } = parseArguments(args, [], ['--version', '--tag', '--message', '--format']);
    if (positional.length) throw new Error('Resolve accepts named --version, --tag or --message options.');
    const tags = fetchHistory();
    outputResolved(resolveVersion({ tags, version: options.version || '', tag: options.tag || '', message: options.message || '' }), options.format);
  } else if (['check', 'set'].includes(command)) {
    if (args.length !== 1) throw new Error(`${command} requires one canonical X.Y.Z version.`);
    if (command === 'check') checkPins(args[0]); else setPins(args[0]);
  } else if (command === 'compare') {
    if (args.length !== 2) throw new Error('Compare requires two canonical X.Y.Z versions.');
    console.log(compareVersions(args[0], args[1]));
  } else if (command === 'preflight') {
    const { options, positional } = parseArguments(args, ['--tag', '--allow-backfill', '--ci']);
    if (positional.length !== 1) throw new Error('Preflight requires one canonical X.Y.Z version.');
    const result = preflight(positional[0], { tagMode: options.tag, allowBackfill: options['allow-backfill'], ci: options.ci });
    console.log(JSON.stringify(result));
  } else if (command === 'release') {
    if (args.includes('--args-env')) {
      if (args.length !== 1) throw new Error('--args-env reads the entire release argument list from TH_RELEASE_ARGS.');
      args = (process.env.TH_RELEASE_ARGS || 'patch').trim().split(/\s+/).filter(Boolean);
    }
    const { options, positional } = parseArguments(args, ['--dry-run', '--ci']);
    if (positional.length > 1) throw new Error('Release requires at most one patch, minor, major or X.Y.Z selection.');
    console.log(JSON.stringify(release(positional[0] || 'patch', { dryRun: options['dry-run'], ci: options.ci })));
  } else throw new Error('Usage: release.mjs resolve|check|set|compare|preflight|release [options].');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
