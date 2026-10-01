import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadOgAvatar } from "./src/og-avatar.js";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCbkAAAAASUVORK5CYII=", "base64"));
const gif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=", "base64"));
const photo = (avatarUrl = "https://images.example.com/avatar.png") => ({ handle: "Orbit_Builder", avatarUrl });
const response = (bytes = png, type = "image/png", extra = {}) => new Response(bytes, { headers: { "Content-Type": type, ...extra } });
const bucketFor = (bytes = png, contentType = "image/png") => ({
  reads: 0,
  async get(key) {
    this.reads++;
    this.lastKey = key;
    return { body: response(bytes).body, size: bytes.byteLength, httpMetadata: { contentType } };
  }
});

describe("optional OG public profile photos", () => {
  it("does no photo I/O for anonymous, missing, or non-string avatar data", async () => {
    const bucket = bucketFor();
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return response(); };
    for (const entry of [{}, { avatarUrl: null }, { avatarUrl: {} }, { avatarUrl: "" }]) {
      assert.equal(await loadOgAvatar(entry, { LEADERBOARD_BUCKET: bucket }, { fetchImpl }), "");
    }
    assert.equal(await loadOgAvatar(photo(), { LEADERBOARD_BUCKET: bucket }, { anonymize: true, fetchImpl }), "");
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder"), { LEADERBOARD_BUCKET: bucket }, { anonymize: true, fetchImpl }), "");
    assert.equal(bucket.reads, 0);
    assert.equal(fetches, 0);
  });

  it("reads same-handle owner uploads directly from R2 and isolates avatar versions", async () => {
    const bucket = bucketFor();
    const env = { LEADERBOARD_BUCKET: bucket };
    const first = await loadOgAvatar(photo("/api/avatar/ORBIT_BUILDER?v=1"), env);
    assert.equal(first, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    assert.equal(bucket.lastKey, "avatars/orbit_builder");
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder?v=1"), env), first);
    assert.equal(bucket.reads, 1);
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder?v=2"), env), first);
    assert.equal(bucket.reads, 2);
    const otherBucket = bucketFor();
    await loadOgAvatar(photo("/api/avatar/orbit_builder?v=2"), { LEADERBOARD_BUCKET: otherBucket });
    assert.equal(otherBucket.reads, 1, "independent bindings do not reuse another bucket's image");
  });

  it("does not read a different handle, malformed path, or missing R2 binding", async () => {
    const bucket = bucketFor();
    for (const url of ["/api/avatar/other", "/api/avatar/%2e%2e%2fsecret", "/api/avatar/%zz", "/api/avatar/orbit_builder#fragment", "/api/avatar/orbit_builder\\secret"]) {
      assert.equal(await loadOgAvatar(photo(url), { LEADERBOARD_BUCKET: bucket }), "", url);
    }
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder"), {}), "");
    assert.equal(bucket.reads, 0);
  });

  it("rejects non-public URLs before fetch including obfuscated IPs", async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return response(); };
    for (const url of [
      "http://images.example.com/photo.png", "https://localhost/photo.png", "https://a.localhost/photo.png",
      "https://internal/photo.png", "https://images.home/photo.png", "https://images.local/photo.png",
      "https://images.internal/photo.png", "https://127.0.0.1/photo.png", "https://10.0.0.1/photo.png",
      "https://192.168.1.1/photo.png", "https://169.254.169.254/latest", "https://2130706433/photo.png",
      "https://0x7f000001/photo.png", "https://[::1]/photo.png", "https://[2606:4700:4700::1111]/photo.png",
      "https://name:secret@images.example.com/photo.png", "https://images.example.com:8443/photo.png",
      "https://images.example.com/photo.png#fragment", "https://images.example.com/\nphoto.png",
      "https://images.example.com\\@localhost/photo.png", "data:image/png;base64,aA==", "/elsewhere/photo.png",
      "not a URL", "https://images.example.com/" + "x".repeat(2100)
    ]) assert.equal(await loadOgAvatar(photo(url), {}, { fetchImpl }), "", url);
    assert.equal(fetches, 0);
  });

  it("fetches Google/public HTTPS images with no credentials or redirects", async () => {
    let request;
    const fetchImpl = async (url, options) => { request = { url, options }; return response(png, "image/png; charset=binary"); };
    const uri = await loadOgAvatar(photo("https://lh3.googleusercontent.com/a/public-photo=s96-c"), {}, { fetchImpl });
    assert.match(uri, /^data:image\/png;base64,/);
    assert.equal(request.url, "https://lh3.googleusercontent.com/a/public-photo=s96-c");
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.deepEqual(Object.keys(request.options.headers), ["Accept"]);
    assert.equal(request.options.headers.Accept, "image/png, image/jpeg, image/gif");
    assert.ok(request.options.signal instanceof AbortSignal);
  });

  it("caches and deduplicates concurrent requests without copying profile credentials", async () => {
    let fetches = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fetchImpl = async () => { fetches++; await gate; return response(); };
    const entry = { ...photo(), googleEmail: "private@example.com", claimToken: "private-claim", googleAuth: "private-token" };
    const calls = Array.from({ length: 8 }, () => loadOgAvatar(entry, {}, { fetchImpl }));
    release();
    const result = await Promise.all(calls);
    assert.equal(new Set(result).size, 1);
    assert.match(result[0], /^data:image\/png;base64,/);
    assert.equal(fetches, 1);
    assert.equal(await loadOgAvatar(entry, {}, { fetchImpl }), result[0]);
    assert.equal(fetches, 1);
  });

  it("refreshes external photo bytes when the card's cache revision changes", async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return response(); };
    const options = { fetchImpl, cacheRevision: "first" };
    const first = await loadOgAvatar(photo(), {}, options);
    assert.equal(await loadOgAvatar(photo(), {}, options), first);
    assert.equal(fetches, 1);
    assert.equal(await loadOgAvatar(photo(), {}, { ...options, cacheRevision: "next" }), first);
    assert.equal(fetches, 2, "A refreshed card cannot reuse stale photo bytes from the same URL");
  });

  it("short-caches missing/error responses and never follows a redirect", async () => {
    for (const makeResponse of [
      () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 302, headers: { Location: "https://localhost/" } }),
      () => { throw new Error("network failure"); },
      () => ({ ok: true, redirected: true, headers: new Headers({ "Content-Type": "image/png" }), body: response().body })
    ]) {
      let fetches = 0;
      const fetchImpl = async () => { fetches++; return makeResponse(); };
      assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl }), "");
      assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl }), "");
      assert.equal(fetches, 1);
    }
  });

  it("rejects unsupported types, wrong magic, truncated PNGs, and bad header CRCs", async () => {
    const badCrc = png.slice();
    badCrc[29] ^= 1;
    for (const [bytes, contentType] of [
      [png, "image/svg+xml"], [png, "image/gif"], [png, "text/html"], [png, "constructor"],
      [new TextEncoder().encode("<svg/>"), "image/png"], [png, "image/jpeg"],
      [png.subarray(0, 32), "image/png"], [png.subarray(0, -1), "image/png"], [badCrc, "image/png"]
    ]) {
      assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(bytes, contentType) }), "");
      const bucket = bucketFor(bytes, contentType);
      assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder"), { LEADERBOARD_BUCKET: bucket }), "");
    }
  });

  it("accepts real JPEG/GIF container headers and rejects truncated frames", async () => {
    const jpeg = new Uint8Array(await readFile(new URL("./fixtures/og-avatar.jpg", import.meta.url)));
    for (const [bytes, type] of [[jpeg, "image/jpeg"], [gif, "image/gif"]]) {
      assert.match(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(bytes, type) }), new RegExp(`^data:${type};base64,`));
      assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(bytes.subarray(0, -1), type) }), "");
    }
    const oversizedJpeg = jpeg.slice();
    const frameOffset = oversizedJpeg.findIndex((value, index) => value === 255 && [192, 193, 194].includes(oversizedJpeg[index + 1]));
    assert.ok(frameOffset >= 0);
    oversizedJpeg[frameOffset + 5] = 32;
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(oversizedJpeg, "image/jpeg") }), "");
  });

  it("rejects unsupported WebP before it can produce an empty raster photo", async () => {
    const webp = new Uint8Array(await readFile(new URL("../docs/assets/landing/horizon-art.webp", import.meta.url)));
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(webp, "image/webp") }), "");
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder"), { LEADERBOARD_BUCKET: bucketFor(webp, "image/webp") }), "");
  });

  it("accepts a real first-frame GIF and rejects malformed/truncated/oversized GIFs", async () => {
    const valid = await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(gif, "image/gif") });
    assert.equal(valid, `data:image/gif;base64,${Buffer.from(gif).toString("base64")}`);
    const badMagic = gif.slice();
    badMagic[0] = 0;
    const oversized = gif.slice();
    oversized[7] = 32;
    const badFrame = gif.slice();
    badFrame[26] = 2; // First frame extends beyond the logical 1x1 screen.
    const badSubblock = gif.slice();
    badSubblock[30] = 255;
    for (const bytes of [badMagic, oversized, badFrame, badSubblock, gif.subarray(0, 13), gif.subarray(0, -1)]) {
      assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => response(bytes, "image/gif") }), "");
    }
  });

  it("rejects oversized Content-Length/R2 size before reading bytes", async () => {
    let cancelled = 0;
    const body = new ReadableStream({ cancel() { cancelled++; } });
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => new Response(body, {
      headers: { "Content-Type": "image/png", "Content-Length": "400001" }
    }) }), "");
    assert.equal(cancelled, 1);
    let bodyReads = 0;
    const bucket = { async get() { return { size: 400001, async arrayBuffer() { bodyReads++; return png.buffer; } }; } };
    assert.equal(await loadOgAvatar(photo("/api/avatar/orbit_builder"), { LEADERBOARD_BUCKET: bucket }), "");
    assert.equal(bodyReads, 0);
  });

  it("bounds streamed bytes even when a host omits Content-Length", async () => {
    let cancelled = 0;
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(400001)); }
      },
      cancel() { cancelled++; }
    });
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => new Response(body, { headers: { "Content-Type": "image/png" } }) }), "");
    assert.equal(cancelled, 1);
  });

  it("enforces its photo deadline even when a fetch ignores cancellation", async () => {
    let signal;
    let fetches = 0;
    const fetchImpl = async (_url, options) => { fetches++; signal = options.signal; return new Promise(() => {}); };
    const start = performance.now();
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl }), "");
    assert.ok(performance.now() - start < 1100, "unavailable photos do not block card generation indefinitely");
    assert.equal(signal.aborted, true);
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl }), "");
    assert.equal(fetches, 1);
  });

  it("cancels a stalled response body at the photo deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    assert.equal(await loadOgAvatar(photo(), {}, { fetchImpl: async () => new Response(body, { headers: { "Content-Type": "image/png" } }) }), "");
    assert.equal(cancelled, true);
  });

  it("caps the combined avatar LRU at 32 entries", async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return response(); };
    for (let i = 0; i < 33; i++) await loadOgAvatar(photo(`https://images.example.com/${i}.png`), {}, { fetchImpl });
    assert.equal(fetches, 33);
    await loadOgAvatar(photo("https://images.example.com/32.png"), {}, { fetchImpl });
    assert.equal(fetches, 33);
    await loadOgAvatar(photo("https://images.example.com/0.png"), {}, { fetchImpl });
    assert.equal(fetches, 34, "old photos leave the bounded cache");
  });

  it("limits distinct pending photo requests to 32 without delaying other cards", async () => {
    let fetches = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fetchImpl = async () => { fetches++; await gate; return response(); };
    const pending = Array.from({ length: 32 }, (_, index) => loadOgAvatar(photo(`https://images.example.com/pending-${index}.png`), {}, { fetchImpl }));
    assert.equal(await loadOgAvatar(photo("https://images.example.com/overflow.png"), {}, { fetchImpl }), "");
    assert.equal(fetches, 32);
    release();
    assert.equal((await Promise.all(pending)).filter(Boolean).length, 32);
  });
});
