// Every mutation of the shared profile document must compare the version it
// read. R2 consistency alone does not make a read/modify/write atomic.
export class ProfileStorageError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 503; }
}

export async function updateProfileEntries(env, reduce, maxAttempts = 5) {
  const bucket = env.LEADERBOARD_BUCKET;
  if (!bucket) throw new ProfileStorageError('storage_unavailable', 'Profile storage is unavailable. Try again.');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let object, entries;
    try {
      object = await bucket.get('leaderboard.json');
      entries = object ? JSON.parse(await object.text()) : [];
      if (!Array.isArray(entries) || (object && !object.etag)) throw new Error('Invalid profile document');
    } catch (_) {
      throw new ProfileStorageError('auth_unavailable', 'Could not load current profiles. Try again.');
    }

    // The reducer rechecks current ownership on every attempt. Returning a
    // Response directly aborts without writing (e.g. a new owner rejects it).
    const result = await reduce(entries);
    if (result instanceof Response) return result;
    if (!result || !Array.isArray(result.entries) || !(result.response instanceof Response)) throw new Error('Invalid profile update');
    let written;
    try {
      written = await bucket.put('leaderboard.json', JSON.stringify(result.entries, null, 2), {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache' }
      });
    } catch (_) {
      throw new ProfileStorageError('storage_unavailable', 'Could not save profiles. Try again.');
    }
    if (written === null) continue;
    if (written && typeof written === 'object') return result.response;
    throw new ProfileStorageError('storage_unavailable', 'Could not confirm saved profiles. Try again.');
  }
  throw new ProfileStorageError('sync_conflict', 'Another sync is updating profiles. Try again.');
}
