import { boundedText } from './request-body.js';
import { identityOwnerId, identityOwns } from './browser-auth.js';
import { validatedRasterDataUri } from './og-avatar.js';
import { updateProfileEntries } from './leaderboard-storage.js';

// Membership belongs to an immutable provider subject, never to a public label or email.
// Independent account keys make simultaneous friends joining a team additive.
const PREFIX = 'team-membership/';
const NO_STORE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const INVITE_LIFETIME = 30 * 86400000;
const validToken = token => typeof token === 'string' && /^[a-f0-9]{48}$/.test(token);
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const publicCaches = new WeakMap();
const teamRecordCaches = new WeakMap();
const teamSummaryCaches = new WeakMap();
const LOGO_MAX_BYTES = 400_000;
const LOGO_BODY_LIMIT = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 8192;
const TEAM_ORIGIN = 'https://token-horizon.dev';

function invalidateTeams(env) {
  for (const caches of [publicCaches, teamRecordCaches, teamSummaryCaches]) caches.get(env.LEADERBOARD_BUCKET)?.clear();
}

async function cachedTeamValue(caches, env, id, load) {
  let cache = caches.get(env.LEADERBOARD_BUCKET);
  if (!cache) { cache = new Map(); caches.set(env.LEADERBOARD_BUCKET, cache); }
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return await hit.pending;
  const pending = load();
  cache.set(id, { until: Date.now() + 5000, pending });
  if (cache.size > 512) cache.delete(cache.keys().next().value);
  try { return await pending; } catch (error) { cache.delete(id); throw error; }
}
async function mapConcurrent(values, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await mapper(values[index]); }
  }));
  return results;
}
async function cachedPublicTeam(env, owner, load) {
  let cache = publicCaches.get(env.LEADERBOARD_BUCKET);
  if (!cache) { cache = new Map(); publicCaches.set(env.LEADERBOARD_BUCKET, cache); }
  const hit = cache.get(owner);
  if (hit && hit.until > Date.now()) return await hit.pending;
  const pending = load();
  cache.set(owner, { until: Date.now() + 5000, pending });
  if (cache.size > 512) cache.delete(cache.keys().next().value);
  try { return await pending; } catch (error) { cache.delete(owner); throw error; }
}

class TeamError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
async function accountKey(owner) { return await hash(owner); }
async function record(env, key) {
  const object = await env.LEADERBOARD_BUCKET.get(key);
  if (!object) return null;
  return { value: JSON.parse(await object.text()), etag: object.etag };
}
async function put(env, key, value, onlyIf) {
  return await env.LEADERBOARD_BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    ...(onlyIf ? { onlyIf } : {})
  });
}
async function keys(env, prefix) {
  const found = [];
  let cursor;
  do {
    const result = await env.LEADERBOARD_BUCKET.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    found.push(...result.objects.map(object => object.key));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return found;
}
function membershipIds(current) {
  const value = current?.value;
  return [...new Set((Array.isArray(value?.teamIds) ? value.teamIds : [value?.teamId]).filter(validId))];
}
async function membership(env, key) {
  return await record(env, `${PREFIX}accounts/${key}.json`);
}

// Public profile membership is always resolved from account records. The
// singular fields remain the first team for clients predating multi-team support.
export function entryTeams(entry) {
  const teams = Array.isArray(entry?.teams) ? entry.teams : entry?.teamId ? [{ id: entry.teamId, name: entry.team }] : [];
  return [...new Map(teams.filter(team => validId(team?.id)).map(team => [team.id, team])).values()];
}
export function entryInTeam(entry, id) { return entryTeams(entry).some(team => team.id === id); }
async function teamRecord(env, id) {
  if (!validId(id)) return null;
  const result = await record(env, `${PREFIX}teams/${id}.json`);
  return result?.value?.id === id && typeof result.value.name === 'string' ? result.value : null;
}
async function cachedTeamRecord(env, id) {
  return await cachedTeamValue(teamRecordCaches, env, id, () => teamRecord(env, id));
}
async function memberCount(env, teamId) {
  const memberKeys = await keys(env, `${PREFIX}members/${teamId}/`);
  // The account mapping is authoritative. This also excludes stale secondary
  // records when membership changes race in separate tabs.
  const active = await mapConcurrent(memberKeys, async key => {
    const member = await record(env, key);
    const account = member?.value?.account;
    if (typeof account !== 'string' || !/^[a-f0-9]{64}$/.test(account)) return false;
    return membershipIds(await membership(env, account)).includes(teamId);
  });
  return active.filter(Boolean).length;
}
async function publicTeam(env, team) {
  const revision = /^[a-f0-9]{32}$/.test(team.logoRevision || '') ? team.logoRevision : '';
  return {
    id: team.id, name: team.name, memberCount: await memberCount(env, team.id),
    logoUrl: revision ? `/api/team/${team.id}/logo?v=${revision}` : '',
    logoUpdatedAt: revision ? Number(team.logoUpdatedAt) || 0 : 0,
    url: `${TEAM_ORIGIN}/t/${team.id}`,
    ogImage: `${TEAM_ORIGIN}/api/og/team/${team.id}.png`
  };
}

export async function getPublicTeam(env, id, { fresh = false } = {}) {
  if (!env.LEADERBOARD_BUCKET || !validId(id)) return null;
  const load = async () => {
    const team = fresh ? await teamRecord(env, id) : await cachedTeamRecord(env, id);
    return team ? await publicTeam(env, team) : null;
  };
  return fresh ? await load() : await cachedTeamValue(teamSummaryCaches, env, id, load);
}

export async function getInviteTeam(env, token) {
  const { team, invite } = await lookupInvite(env, token);
  return { team: await publicTeam(env, team), expiresAt: invite.expiresAt };
}

export async function enrichTeamAggregates(env, rows) {
  return await mapConcurrent(rows, async row => {
    const publishedProfiles = row.members;
    if (!validId(row.teamId)) return { ...row, publishedProfiles };
    try {
      const team = await getPublicTeam(env, row.teamId);
      return { ...row, publishedProfiles, ...(team ? {
        memberCount: team.memberCount, logoUrl: team.logoUrl, logoUpdatedAt: team.logoUpdatedAt,
        url: team.url, ogImage: team.ogImage
      } : {}) };
    } catch {
      // Keep real published usage visible if optional roster/artwork metadata
      // is unavailable. An unknown roster total must never be guessed.
      return { ...row, publishedProfiles };
    }
  });
}

function teamLogoKey(id, revision) {
  return `team-logos/${id}/${revision}`;
}

export async function loadTeamLogoDataUri(team, env) {
  const match = String(team?.logoUrl || '').match(/^\/api\/team\/([a-f0-9]{32})\/logo\?v=([a-f0-9]{32})$/);
  if (!match || match[1] !== team.id || !env.LEADERBOARD_BUCKET) return '';
  try {
    const object = await env.LEADERBOARD_BUCKET.get(teamLogoKey(match[1], match[2]));
    if (!object || Number(object.size) > LOGO_MAX_BYTES) return '';
    return validatedRasterDataUri(new Uint8Array(await object.arrayBuffer()), object.httpMetadata?.contentType);
  } catch { return ''; }
}

function uploadedLogo(image) {
  if (typeof image !== 'string') throw new TeamError(400, 'invalid_logo', 'Choose a PNG or JPEG team icon.');
  const match = image.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new TeamError(400, 'invalid_logo', 'Choose a PNG or JPEG team icon. Convert WebP to PNG before uploading.');
  if (match[2].length > Math.ceil(LOGO_MAX_BYTES / 3) * 4) throw new TeamError(413, 'logo_too_large', 'Keep your team icon under 400 KB.');
  let bytes;
  try { bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)); }
  catch { throw new TeamError(400, 'invalid_logo', 'Your team icon could not be read. Choose another PNG or JPEG.'); }
  if (bytes.length > LOGO_MAX_BYTES) throw new TeamError(413, 'logo_too_large', 'Keep your team icon under 400 KB.');
  if (!validatedRasterDataUri(bytes, match[1])) throw new TeamError(400, 'invalid_logo', 'Choose a valid PNG or JPEG no larger than 2048 pixels per side.');
  return { bytes, contentType: match[1] };
}
async function accountTeam(env, key, selectedId, strict = true) {
  const current = await membership(env, key);
  const teams = (await mapConcurrent(membershipIds(current), id => teamRecord(env, id))).filter(Boolean);
  if (strict && selectedId && !teams.some(team => team.id === selectedId)) {
    throw new TeamError(404, 'team_not_found', 'You are not a member of this team. Refresh your teams and try again.');
  }
  return { current, teams, team: teams.find(team => team.id === selectedId) || teams[0] || null };
}
async function invitesFor(env, team) {
  const found = await keys(env, `${PREFIX}invites/${team.id}/`);
  const rows = await mapConcurrent(found, async key => (await record(env, key))?.value);
  return rows.filter(row => validToken(row?.token)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(row => ({
    token: row.token, url: `https://token-horizon.dev/invite/${row.token}`,
    createdAt: row.createdAt, expiresAt: row.expiresAt, revoked: Boolean(row.revoked)
  }));
}
async function summary(env, key, selected) {
  const { teams } = await accountTeam(env, key);
  // Repair secondary indexes after partial storage failures. Account records
  // remain authoritative for counts and access, including after leaving.
  for (const team of teams) {
    const memberKey = `${PREFIX}members/${team.id}/${key}.json`;
    if (!(await record(env, memberKey))) { await put(env, memberKey, { account: key }); invalidateTeams(env); }
  }
  const rows = await mapConcurrent(teams, async team => ({
    ...(await publicTeam(env, team)), role: team.owner === key ? 'owner' : 'member', createdAt: team.createdAt
  }));
  const team = rows.find(team => team.id === selected?.id) || rows[0] || null;
  return {
    ok: true, teams: rows, team,
    invites: team?.role === 'owner' ? await invitesFor(env, teams.find(row => row.id === team.id)) : []
  };
}
async function lookupInvite(env, token) {
  if (!validToken(token)) throw new TeamError(404, 'invite_not_found', 'This invite link could not be found. Ask your friend for a fresh link.');
  const digest = await hash(token);
  const pointer = (await record(env, `${PREFIX}invite-links/${digest}.json`))?.value;
  if (!validId(pointer?.teamId)) throw new TeamError(404, 'invite_not_found', 'This invite link could not be found. Ask your friend for a fresh link.');
  const invite = (await record(env, `${PREFIX}invites/${pointer.teamId}/${digest}.json`))?.value;
  if (!invite || invite.token !== token) throw new TeamError(404, 'invite_not_found', 'This invite link could not be found. Ask your friend for a fresh link.');
  if (invite.revoked) throw new TeamError(410, 'invite_revoked', 'This invite has been retired. Ask your friend for a fresh link.');
  if (invite.expiresAt <= Date.now()) throw new TeamError(410, 'invite_expired', 'This invite has expired. Ask your friend for a fresh link.');
  const team = await teamRecord(env, pointer.teamId);
  if (!team) throw new TeamError(404, 'invite_not_found', 'This team could not be found.');
  return { invite, team, digest };
}
async function changeMembership(env, key, teamId, join) {
  // Retry the read/merge/CAS so simultaneous joins keep both teams. An empty
  // v2 record is a tombstone: never fall back to a removed legacy membership.
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await membership(env, key);
    const ids = membershipIds(current);
    const next = join ? [...new Set([...ids, teamId])] : ids.filter(id => id !== teamId);
    const result = await put(env, `${PREFIX}accounts/${key}.json`, {
      version: 2, teamIds: next, teamId: next[0] || '', updatedAt: Date.now()
    }, current?.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' });
    if (result === null) continue;
    invalidateTeams(env);
    if (join) await put(env, `${PREFIX}members/${teamId}/${key}.json`, { account: key });
    // Retain stale indexes after leave: a concurrent rejoin may already have
    // written one. Counts verify the account record and never trust the index.
    invalidateTeams(env);
    return;
  }
  throw new TeamError(409, 'membership_changed', 'Your teams changed in another tab. Refresh and try again.');
}

export async function handleTeamRequest(request, env, { parseGoogleAuth, jsonResponse, getTeamStats }) {
  const { pathname } = new URL(request.url);
  const isTeamRoute = pathname === '/api/account/team' || pathname.startsWith('/api/team/');
  if (!isTeamRoute) return null;
  try {
    if (!env.LEADERBOARD_BUCKET) throw new TeamError(503, 'storage_unavailable', 'Team invites are temporarily unavailable.');
    const publicDetails = pathname.match(/^\/api\/team\/([a-f0-9]{32})$/);
    if (request.method === 'GET' && publicDetails) {
      const team = await getPublicTeam(env, publicDetails[1]);
      if (!team) throw new TeamError(404, 'team_not_found', 'This team could not be found.');
      const stats = await getTeamStats(team);
      return jsonResponse({ ok: true, team, stats }, 200, { 'Cache-Control': 'public, max-age=15, s-maxage=30', 'Referrer-Policy': 'no-referrer' });
    }
    const publicLogo = pathname.match(/^\/api\/team\/([a-f0-9]{32})\/logo$/);
    if (['GET', 'HEAD'].includes(request.method) && publicLogo) {
      const team = await cachedTeamRecord(env, publicLogo[1]);
      const revision = team?.logoRevision;
      if (!/^[a-f0-9]{32}$/.test(revision || '')) throw new TeamError(404, 'logo_not_found', 'This team has no custom icon.');
      const requestedRevision = new URL(request.url).searchParams.get('v');
      if (requestedRevision && requestedRevision !== revision) throw new TeamError(404, 'logo_not_found', 'This team icon has been replaced.');
      const object = await env.LEADERBOARD_BUCKET.get(teamLogoKey(team.id, revision));
      if (!object) throw new TeamError(404, 'logo_not_found', 'This team icon could not be found.');
      const headers = {
        'Content-Type': object.httpMetadata?.contentType || 'image/png',
        'Cache-Control': requestedRevision ? 'public, max-age=300, s-maxage=300' : 'public, max-age=15, s-maxage=15',
        'ETag': `"team-logo-${revision}"`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      };
      if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : object.body || await object.arrayBuffer(), { headers });
    }
    const publicLookup = pathname.match(/^\/api\/team\/invites\/([^/]+)$/);
    if (request.method === 'GET' && publicLookup) {
      const { invite, team } = await lookupInvite(env, publicLookup[1]);
      return jsonResponse({ ok: true, team: await publicTeam(env, team), expiresAt: invite.expiresAt }, 200, NO_STORE);
    }
    let body = {};
    if (request.method === 'POST') {
      try { body = JSON.parse(await boundedText(request, pathname === '/api/team/logo' ? LOGO_BODY_LIMIT : 8192)); }
      catch (error) { throw new TeamError(error instanceof RangeError ? 413 : 400, 'invalid_request', error instanceof RangeError ? 'Team request is too large.' : 'Send a valid JSON team request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamError(400, 'invalid_request', 'Send a valid JSON invite request.');
    }
    const auth = await parseGoogleAuth(request, body, env);
    if (!auth) throw new TeamError(401, 'auth_required', 'Sign in to join or manage your team.');
    // Link placeholder-owned profiles (seeded with `google:<handle>`) before
    // looking up membership — it is keyed by the verified subject, not the label.
    await linkVerifiedOwners(env, auth);
    const key = await accountKey(identityOwnerId(auth));
    const selectedId = body.teamId || new URL(request.url).searchParams.get('teamId');
    const { teams, team } = await accountTeam(env, key, selectedId, pathname !== '/api/team/logo');
    if (request.method === 'GET' && pathname === '/api/account/team') {
      return jsonResponse(await summary(env, key, team), 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/logo') {
      if (!team || team.owner !== key) throw new TeamError(403, 'team_owner_required', 'Only your team owner can change its icon.');
      // Shared browser cookies can switch accounts in another tab before the
      // current tab revalidates. Bind the upload to the team the user actually
      // selected, rather than silently applying it to the new account's team.
      if (!validId(body.teamId) || body.teamId !== team.id) throw new TeamError(409, 'team_changed', 'Your team or account changed. Refresh and try again.');
      const teamKey = `${PREFIX}teams/${team.id}.json`;
      const currentTeam = await record(env, teamKey);
      if (!currentTeam || currentTeam.value.owner !== key) throw new TeamError(403, 'team_owner_required', 'Only your team owner can change its icon.');
      const previousRevision = currentTeam.value.logoRevision;
      const next = { ...currentTeam.value };
      let newLogoKey = '';
      if (body.clear === true) {
        delete next.logoRevision; delete next.logoUpdatedAt;
      } else {
        const { bytes, contentType } = uploadedLogo(body.image);
        next.logoRevision = randomHex(16); next.logoUpdatedAt = Date.now();
        newLogoKey = teamLogoKey(team.id, next.logoRevision);
        await env.LEADERBOARD_BUCKET.put(newLogoKey, bytes, {
          httpMetadata: { contentType, cacheControl: 'public, max-age=300' }
        });
      }
      try {
        const updated = await put(env, teamKey, next, currentTeam.etag ? { etagMatches: currentTeam.etag } : undefined);
        if (updated === null) throw new TeamError(409, 'team_changed', 'Your team changed in another tab. Refresh and try again.');
      } catch (error) {
        if (newLogoKey) await env.LEADERBOARD_BUCKET.delete?.(newLogoKey);
        throw error;
      }
      invalidateTeams(env);
      if (/^[a-f0-9]{32}$/.test(previousRevision || '')) {
        try { await env.LEADERBOARD_BUCKET.delete?.(teamLogoKey(team.id, previousRevision)); } catch { /* Old artwork cleanup is best effort. */ }
      }
      return jsonResponse(await summary(env, key, next), 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/invites') {
      let target = body.create === true ? null : team;
      if (teams.length > 1 && !body.teamId && body.create !== true) throw new TeamError(400, 'team_required', 'Choose the team whose invite links you want to manage.');
      if (target && target.owner !== key) throw new TeamError(403, 'team_owner_required', 'Only your team owner can create invite links.');
      if (!target) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new TeamError(400, 'invalid_team_name', 'Give your team a name between 1 and 64 characters.');
        if (body.creationId !== undefined && !validId(body.creationId)) throw new TeamError(400, 'invalid_request', 'Refresh the team form and try again.');
        const id = body.creationId ? (await hash(`${key}:${body.creationId}`)).slice(0, 32) : randomHex(16);
        target = await teamRecord(env, id);
        if (target && target.owner !== key) throw new TeamError(409, 'team_changed', 'Refresh the team form and try again.');
        if (!target) {
          target = { id, name, owner: key, createdAt: Date.now() };
          await put(env, `${PREFIX}teams/${target.id}.json`, target, { etagDoesNotMatch: '*' });
          target = await teamRecord(env, id);
          if (!target || target.owner !== key) throw new TeamError(409, 'team_changed', 'Refresh the team form and try again.');
        }
        await changeMembership(env, key, target.id, true);
      }
      const existing = await invitesFor(env, target);
      const active = existing.find(invite => !invite.revoked && invite.expiresAt > Date.now());
      if (!active) {
        const token = randomHex(24), digest = await hash(token), createdAt = Date.now();
        await put(env, `${PREFIX}invites/${target.id}/${digest}.json`, { token, teamId: target.id, createdAt, expiresAt: createdAt + INVITE_LIFETIME, revoked: false });
        await put(env, `${PREFIX}invite-links/${digest}.json`, { teamId: target.id });
      } else {
        // Recover a link whose invite record committed before its lookup index.
        // Retrying creation must return a usable link after a storage interruption.
        const pointerKey = `${PREFIX}invite-links/${await hash(active.token)}.json`;
        if (!(await record(env, pointerKey))) await put(env, pointerKey, { teamId: target.id });
      }
      return jsonResponse(await summary(env, key, target), 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/invites/revoke') {
      if (teams.length > 1 && !body.teamId) throw new TeamError(400, 'team_required', 'Choose the team whose invite link you want to retire.');
      if (!team || team.owner !== key) throw new TeamError(403, 'team_owner_required', 'Only your team owner can retire invite links.');
      if (!validToken(body.token)) throw new TeamError(404, 'invite_not_found', 'This invite could not be found.');
      const digest = await hash(body.token), inviteKey = `${PREFIX}invites/${team.id}/${digest}.json`;
      const found = await record(env, inviteKey);
      if (!found || found.value.token !== body.token) throw new TeamError(404, 'invite_not_found', 'This invite could not be found.');
      await put(env, inviteKey, { ...found.value, revoked: true, revokedAt: Date.now() });
      return jsonResponse(await summary(env, key, team), 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/join') {
      const target = await lookupInvite(env, body.token);
      if (teams.some(team => team.id === target.team.id)) return jsonResponse({ ...(await summary(env, key, target.team)), alreadyMember: true }, 200, NO_STORE);
      await changeMembership(env, key, target.team.id, true);
      return jsonResponse({ ...(await summary(env, key, target.team)), alreadyMember: false }, 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/leave') {
      if (!validId(body.teamId) || !team || team.id !== body.teamId) throw new TeamError(400, 'team_required', 'Choose the team you want to leave.');
      if (team.owner === key) throw new TeamError(409, 'team_owner', 'Team owners must stay in their team. You can still create or join other teams.');
      await changeMembership(env, key, team.id, false);
      return jsonResponse(await summary(env, key, null), 200, NO_STORE);
    }
    throw new TeamError(404, 'not_found', 'Team endpoint not found.');
  } catch (error) {
    return jsonResponse({ ok: false, code: error.code || 'team_unavailable', error: error.status ? error.message : 'Could not load your team. Try again.' }, error.status || 503, NO_STORE);
  }
}

/// A seeded/legacy profile can carry an owner id (`google:<handle>`) that no
/// real subject will ever equal, so membership — keyed by
/// `accountKey(identityOwnerId(subject))` — can never attach. `ownerId` stays
/// put: it namespaces private records (`groups/`, `activity/`, `share.ownerKey`)
/// and must not move. Instead the verified subject is recorded alongside it and
/// used *only* to key membership. Returns true when the profile was linked; the
/// caller is responsible for persisting it.
export async function linkVerifiedOwner(env, entry, identity) {
  if (!env.LEADERBOARD_BUCKET || !entry?.claimed || !identity?.sub) return false;
  const next = identityOwnerId(identity);
  if (!/^(google|github):[^:]+$/.test(next) || entry.identityId === next) return false;
  // An owner id that already *is* the subject needs no link — and claiming it
  // must stay a byte-idempotent no-op.
  if (entry.ownerId === next) return false;
  const owned = identityOwns(entry, identity, { legacyEmail: true })
    || (!entry.ownerId && Boolean(entry.googleEmail) && entry.googleEmail === identity.email);
  if (!owned) return false;
  entry.identityId = next;
  return true;
}

/// Self-heal every profile this identity owns on an authenticated request, so
/// one dashboard sign-in attaches team membership. Best effort: a repair
/// failure must never take a team action offline.
export async function linkVerifiedOwners(env, identity) {
  if (!env.LEADERBOARD_BUCKET || !identity?.sub) return;
  try {
    await updateProfileEntries(env, async entries => {
      let changed = false;
      for (const entry of entries) {
        if (await linkVerifiedOwner(env, entry, identity)) changed = true;
      }
      // Returning a bare Response aborts the write; the wrapper persists it.
      if (!changed) return new Response(null, { status: 204 });
      return { entries, response: new Response(null, { status: 204 }) };
    });
  } catch {
    // Profile storage is contended or unavailable — leave the link for the
    // next authenticated request rather than failing this one.
  }
}

/// Membership is keyed by the verified subject when one has been recorded
/// (see `linkVerifiedOwner`), falling back to the owner id — which for legacy
/// profiles is a placeholder no identity will ever match.
function membershipOwnerId(entry) {
  if (entry?.claimed !== true) return null;
  const subject = typeof entry.identityId === 'string' ? entry.identityId : entry.ownerId;
  return typeof subject === 'string' && /^(google|github):/.test(subject) ? subject : null;
}

export async function applyTeamMemberships(env, entries, { fresh = false } = {}) {
  if (!env.LEADERBOARD_BUCKET) return entries;
  const owners = [...new Set(entries.map(membershipOwnerId).filter(owner => owner))];
  const byOwner = new Map();
  const teams = new Map();
  const unavailable = new Set();
  await mapConcurrent(owners, async owner => {
    const load = async () => {
      const key = await accountKey(owner);
      const current = await membership(env, key);
      if (!current) return null;
      return (await mapConcurrent(membershipIds(current), async id => {
        if (!teams.has(id)) teams.set(id, fresh ? teamRecord(env, id) : cachedTeamRecord(env, id));
        return await teams.get(id);
      })).filter(Boolean);
    };
    try {
      const team = fresh ? await load() : await cachedPublicTeam(env, owner, load);
      byOwner.set(owner, team);
    } catch (error) {
      // Team enrichment must not take published usage offline. Ownership and
      // writes always use fresh, fail-closed reads; public rows keep totals but
      // cannot claim canonical membership when its metadata is unavailable.
      if (fresh) throw error;
      unavailable.add(owner);
    }
  });
  for (const entry of entries) {
    const owner = membershipOwnerId(entry);
    const memberships = owner && entry.claimed === true ? byOwner.get(owner) || [] : [];
    if (memberships.length) {
      entry.teams = memberships.map(team => ({ id: team.id, name: team.name }));
      entry.team = memberships[0].name; entry.teamId = memberships[0].id;
    } else {
      if (entry.teamId || entry.teams?.length || owner && (unavailable.has(owner) || byOwner.get(owner)?.length === 0)) entry.team = '';
      entry.teams = [];
      delete entry.teamId; // Never trust client-supplied canonical membership.
    }
  }
  return entries;
}
