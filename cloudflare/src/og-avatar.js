// Optional profile photos must never hold up a share card or become a second
// server-side URL fetcher with access to private networks. The Worker also uses
// global_fetch_strictly_public to enforce the public DNS boundary at fetch time.
const MAX_BYTES = 400_000; // Matches the owner avatar upload endpoint.
const MAX_DIMENSION = 2048;
const TIMEOUT_MS = 700;
const CACHE_SIZE = 32;
const CACHE_TTL_MS = 300_000;
const FAILURE_TTL_MS = 30_000;
const cache = new Map();
const inFlight = new Map();
const scopeIds = new WeakMap();
let nextScopeId = 1;

function scopeId(scope) {
  if (!scopeIds.has(scope)) scopeIds.set(scope, nextScopeId++);
  return scopeIds.get(scope);
}

function validDimensions(width, height) {
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
}

function typeAt(bytes, offset, expected) {
  return [...expected].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes) {
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !typeAt(bytes, 12, "IHDR") || !validDimensions(view.getUint32(16), view.getUint32(20))) return false;
  const bitDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!bitDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return false;
  if (crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) return false;
  let sawImage = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    const next = offset + size + 12;
    if (next > bytes.length) return false;
    if (typeAt(bytes, offset + 4, "IDAT") && size > 0) sawImage = true;
    if (typeAt(bytes, offset + 4, "IEND")) return size === 0 && next === bytes.length && sawImage;
    offset = next;
  }
  return false;
}

function validJpeg(bytes) {
  if (bytes.length < 24 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  let dimensions = false;
  for (let offset = 2; offset < bytes.length - 2;) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > bytes.length) return false;
    const size = (bytes[offset] << 8) | bytes[offset + 1];
    if (size < 2 || offset + size > bytes.length - 2) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (size < 8 || !validDimensions((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4])) return false;
      dimensions = true;
    }
    if (marker === 218) return dimensions;
    offset += size;
  }
  return false;
}

function validGif(bytes) {
  if (bytes.length < 29 || (!typeAt(bytes, 0, "GIF87a") && !typeAt(bytes, 0, "GIF89a"))) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (!validDimensions(width, height)) return false;
  const globalPalette = (bytes[10] & 128) !== 0;
  let offset = 13 + (globalPalette ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let sawImage = false;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 59) return sawImage && offset === bytes.length;
    if (block === 33) {
      const label = bytes[offset++];
      if (![1, 249, 254, 255].includes(label)) return false;
      if ((label === 249 && bytes[offset] !== 4) || (label === 1 && bytes[offset] !== 12) || (label === 255 && bytes[offset] !== 11)) return false;
    } else if (block === 44) {
      if (offset + 9 > bytes.length) return false;
      const left = view.getUint16(offset, true);
      const top = view.getUint16(offset + 2, true);
      const imageWidth = view.getUint16(offset + 4, true);
      const imageHeight = view.getUint16(offset + 6, true);
      if (!validDimensions(imageWidth, imageHeight) || left + imageWidth > width || top + imageHeight > height) return false;
      const packed = bytes[offset + 8];
      const localPalette = (packed & 128) !== 0;
      if (!globalPalette && !localPalette) return false;
      offset += 9 + (localPalette ? 3 * (1 << ((packed & 7) + 1)) : 0);
      const codeSize = bytes[offset++];
      if (codeSize < 2 || codeSize > 8) return false;
      if (!bytes[offset]) return false; // An image needs compressed pixel data.
      sawImage = true;
    } else {
      return false;
    }
    // Extension and image payloads are bounded, terminated sub-block chains.
    while (offset < bytes.length && bytes[offset]) offset += 1 + bytes[offset];
    if (offset >= bytes.length) return false;
    offset++;
  }
  return false;
}

function dataUri(bytes, contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  const check = type === "image/png" ? validPng : type === "image/jpeg" ? validJpeg : type === "image/gif" ? validGif : null;
  if (!bytes || bytes.length > MAX_BYTES || !check || !check(bytes)) return "";
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${type};base64,${btoa(binary)}`;
}

// Reuse the photo boundary for owner-uploaded team artwork. Only formats the
// OG rasterizer can decode are accepted; a browser can normalize WebP to PNG.
export function validatedRasterDataUri(bytes, contentType, { allowGif = false } = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', ...(allowGif ? ['image/gif'] : [])].includes(type)) return '';
  return dataUri(bytes, type);
}

function remoteUrl(value) {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname.toLowerCase();
    // Require a DNS name, excluding every IP literal, single-label/local host
    // and reserved private suffix. URL parsing also canonicalizes obfuscated IPs.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return null;
    if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion|invalid|test)$/.test(host)) return null;
    return url;
  } catch { return null; }
}

async function readBody(body, signal) {
  if (!body || signal.aborted) return null;
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    if (signal.aborted) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function withDeadline(load) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(""); }, TIMEOUT_MS);
  });
  try { return await Promise.race([load(controller.signal), deadline]); }
  catch { return ""; }
  finally { clearTimeout(timer); }
}

function cached(key, load) {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, existing);
    return Promise.resolve(existing.value);
  }
  cache.delete(key);
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= CACHE_SIZE) return Promise.resolve("");
  const pending = withDeadline(load).then(value => {
    cache.set(key, { value, expires: Date.now() + (value ? CACHE_TTL_MS : FAILURE_TTL_MS) });
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => { inFlight.delete(key); });
  inFlight.set(key, pending);
  return pending;
}

/** Return an embedded, bounded public profile photo, or an empty fallback. */
export async function loadOgAvatar(entry, env, { anonymize = false, fetchImpl = globalThis.fetch, cacheRevision = "" } = {}) {
  if (anonymize || typeof entry?.avatarUrl !== "string" || !entry.avatarUrl) return "";
  const source = entry.avatarUrl;
  if (source.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(source)) return "";
  if (source.startsWith("/api/avatar/")) {
    try {
      const url = new URL(source, "https://token-horizon.dev");
      const handle = String(entry.handle || "").replace(/^@/, "").trim().toLowerCase();
      const imageHandle = decodeURIComponent(url.pathname.slice("/api/avatar/".length)).toLowerCase();
      const bucket = env?.LEADERBOARD_BUCKET;
      if (!handle || !/^[a-z0-9_.-]{1,100}$/.test(handle) || imageHandle !== handle || url.hash || !bucket?.get) return "";
      const key = `avatars/${handle}`;
      const version = url.searchParams.get("v") || "";
      return cached(`r2:${scopeId(bucket)}:${key}:${version}`, async signal => {
        const object = await bucket.get(key);
        if (!object || signal.aborted || Number(object.size) > MAX_BYTES) return "";
        const bytes = object.body ? await readBody(object.body, signal) : new Uint8Array(await object.arrayBuffer());
        if (signal.aborted) return "";
        return dataUri(bytes, object.httpMetadata?.contentType || "image/png");
      });
    } catch { return ""; }
  }
  const url = remoteUrl(source);
  if (!url || typeof fetchImpl !== "function") return "";
  return cached(`url:${scopeId(fetchImpl)}:${url.href}:${cacheRevision}`, async signal => {
    // A fresh header set forwards no cookies or auth. Workers supports manual
    // redirects; the status check below rejects them without following them.
    const response = await fetchImpl.call(globalThis, url.href, {
      signal, redirect: "manual",
      headers: { Accept: "image/png, image/jpeg, image/gif" }
    });
    const contentType = response.headers.get("Content-Type") || "";
    const length = response.headers.get("Content-Length");
    if (!response.ok || response.redirected || !/^image\/(png|jpe?g|gif)(?:\s*;|$)/i.test(contentType) || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
      void response.body?.cancel().catch(() => {});
      return "";
    }
    return dataUri(await readBody(response.body, signal), contentType);
  });
}
