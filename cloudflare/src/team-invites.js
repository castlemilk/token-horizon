import { boundedText } from './request-body.js';

// Membership belongs to a Google subject, never to a public team label or email.
// Independent account keys make simultaneous friends joining a team additive.
const PREFIX = 'team-membership/';
const NO_STORE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const INVITE_LIFETIME = 30 * 86400000;
const validToken = token => typeof token === 'string' && /^[a-f0-9]{48}$/.test(token);
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const publicCaches = new WeakMap();
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
async function accountKey(subject) { return await hash(`google:${subject}`); }
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
async function membership(env, key) {
  const result = await record(env, `${PREFIX}accounts/${key}.json`);
  return validId(result?.value?.teamId) ? result : null;
}
async function teamRecord(env, id) {
  if (!validId(id)) return null;
  const result = await record(env, `${PREFIX}teams/${id}.json`);
  return result?.value?.id === id && typeof result.value.name === 'string' ? result.value : null;
}
async function memberCount(env, teamId) {
  const memberKeys = await keys(env, `${PREFIX}members/${teamId}/`);
  // The account mapping is authoritative. This also excludes stale secondary
  // records when two tabs switch the same account in quick succession.
  const active = await mapConcurrent(memberKeys, async key => {
    const member = await record(env, key);
    const account = member?.value?.account;
    if (typeof account !== 'string' || !/^[a-f0-9]{64}$/.test(account)) return false;
    return (await membership(env, account))?.value?.teamId === teamId;
  });
  return active.filter(Boolean).length;
}
async function publicTeam(env, team) {
  return { id: team.id, name: team.name, memberCount: await memberCount(env, team.id) };
}
async function accountTeam(env, key) {
  const current = await membership(env, key);
  const team = current ? await teamRecord(env, current.value.teamId) : null;
  if (!team) return { current, team: null };
  return { current, team };
}
async function invitesFor(env, team) {
  const found = await keys(env, `${PREFIX}invites/${team.id}/`);
  const rows = await mapConcurrent(found, async key => (await record(env, key))?.value);
  return rows.filter(row => validToken(row?.token)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(row => ({
    token: row.token, url: `https://token-horizon.dev/invite/${row.token}`,
    createdAt: row.createdAt, expiresAt: row.expiresAt, revoked: Boolean(row.revoked)
  }));
}
async function summary(env, key, team) {
  if (!team) return { ok: true, team: null, invites: [] };
  // Recover if the account commit succeeded but its secondary index write
  // failed. A retry must not leave a real member missing from the team count.
  const memberKey = `${PREFIX}members/${team.id}/${key}.json`;
  if (!(await record(env, memberKey))) await put(env, memberKey, { account: key });
  const owner = team.owner === key;
  return {
    ok: true,
    team: { ...(await publicTeam(env, team)), role: owner ? 'owner' : 'member', createdAt: team.createdAt },
    invites: owner ? await invitesFor(env, team) : []
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
async function setMembership(env, key, teamId, current) {
  const result = await put(env, `${PREFIX}accounts/${key}.json`, { teamId, joinedAt: Date.now() },
    current?.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' });
  if (result === null) throw new TeamError(409, 'membership_changed', 'Your team changed in another tab. Refresh and try again.');
  publicCaches.get(env.LEADERBOARD_BUCKET)?.clear();
  await put(env, `${PREFIX}members/${teamId}/${key}.json`, { account: key });
  // This is only an index cleanup; authoritative membership remains per account.
  if (current?.value?.teamId && current.value.teamId !== teamId && env.LEADERBOARD_BUCKET.delete) {
    await env.LEADERBOARD_BUCKET.delete(`${PREFIX}members/${current.value.teamId}/${key}.json`);
  }
}

export async function handleTeamRequest(request, env, { parseGoogleAuth, jsonResponse }) {
  const { pathname } = new URL(request.url);
  const isTeamRoute = pathname === '/api/account/team' || pathname.startsWith('/api/team/');
  if (!isTeamRoute) return null;
  try {
    if (!env.LEADERBOARD_BUCKET) throw new TeamError(503, 'storage_unavailable', 'Team invites are temporarily unavailable.');
    const publicLookup = pathname.match(/^\/api\/team\/invites\/([^/]+)$/);
    if (request.method === 'GET' && publicLookup) {
      const { invite, team } = await lookupInvite(env, publicLookup[1]);
      return jsonResponse({ ok: true, team: await publicTeam(env, team), expiresAt: invite.expiresAt }, 200, NO_STORE);
    }
    let body = {};
    if (request.method === 'POST') {
      try { body = JSON.parse(await boundedText(request, 8192)); }
      catch (error) { throw new TeamError(error instanceof RangeError ? 413 : 400, 'invalid_request', error instanceof RangeError ? 'Invite request is too large.' : 'Send a valid JSON invite request.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamError(400, 'invalid_request', 'Send a valid JSON invite request.');
    }
    const auth = await parseGoogleAuth(request, body, env);
    if (!auth) throw new TeamError(401, 'auth_required', 'Sign in with Google to join or manage your team.');
    const key = await accountKey(auth.sub);
    const { current, team } = await accountTeam(env, key);
    if (request.method === 'GET' && pathname === '/api/account/team') {
      return jsonResponse(await summary(env, key, team), 200, NO_STORE);
    }
    if (request.method === 'POST' && pathname === '/api/team/invites') {
      let target = team;
      if (target && target.owner !== key) throw new TeamError(403, 'team_owner_required', 'Only your team owner can create invite links.');
      if (!target) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new TeamError(400, 'invalid_team_name', 'Give your team a name between 1 and 64 characters.');
        target = { id: randomHex(16), name, owner: key, createdAt: Date.now() };
        await put(env, `${PREFIX}teams/${target.id}.json`, target);
        await setMembership(env, key, target.id, current);
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
      if (team?.id === target.team.id) return jsonResponse({ ...(await summary(env, key, team)), alreadyMember: true }, 200, NO_STORE);
      if (team?.owner === key) throw new TeamError(409, 'team_owner', 'You own your current team. Keep that team or join with another account.');
      if (team && body.confirmSwitch !== true) throw new TeamError(409, 'team_switch_required', `Joining ${target.team.name} will move you from ${team.name}.`);
      await setMembership(env, key, target.team.id, current);
      return jsonResponse({ ...(await summary(env, key, target.team)), alreadyMember: false }, 200, NO_STORE);
    }
    throw new TeamError(404, 'not_found', 'Team endpoint not found.');
  } catch (error) {
    return jsonResponse({ ok: false, code: error.code || 'team_unavailable', error: error.status ? error.message : 'Could not load your team. Try again.' }, error.status || 503, NO_STORE);
  }
}

export async function applyTeamMemberships(env, entries, { fresh = false } = {}) {
  if (!env.LEADERBOARD_BUCKET) return entries;
  const owners = [...new Set(entries.filter(entry => entry.claimed === true && typeof entry.ownerId === 'string' && entry.ownerId.startsWith('google:')).map(entry => entry.ownerId))];
  const byOwner = new Map();
  const teams = new Map();
  const unavailable = new Set();
  await mapConcurrent(owners, async owner => {
    const load = async () => {
      const key = await accountKey(owner.slice(7));
      const current = await membership(env, key);
      if (!current) return null;
      const id = current.value.teamId;
      if (!teams.has(id)) teams.set(id, teamRecord(env, id));
      return await teams.get(id);
    };
    try {
      const team = fresh ? await load() : await cachedPublicTeam(env, owner, load);
      if (team) byOwner.set(owner, team);
    } catch (error) {
      // Team enrichment must not take published usage offline. Ownership and
      // writes always use fresh, fail-closed reads; public rows keep totals but
      // cannot claim canonical membership when its metadata is unavailable.
      if (fresh) throw error;
      unavailable.add(owner);
    }
  });
  for (const entry of entries) {
    const team = entry.claimed === true ? byOwner.get(entry.ownerId) : null;
    if (team) { entry.team = team.name; entry.teamId = team.id; }
    else {
      if (entry.teamId && unavailable.has(entry.ownerId)) entry.team = '';
      delete entry.teamId; // Never trust an unconfirmed canonical team ID.
    }
  }
  return entries;
}
