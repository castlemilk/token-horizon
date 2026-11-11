/**
 * Pixel sampling by screenshot. Checks ask what is DRAWN, not what the DOM says.
 *
 * A clip is captured with page.screenshot({ clip, animations: 'disabled',
 * caret: 'hide', scale: 'css' }). The PNG is decoded in a blank helper page of the
 * same browser context (createImageBitmap with colorSpaceConversion 'none', an
 * OffscreenCanvas, getImageData), and only the requested values come back. The
 * helper page is created once per context and closed with it. Nothing here
 * imports a Node PNG decoder.
 *
 * Coordinates are CSS pixels in the page's viewport. The clip is widened outwards
 * to whole pixels and then cut to the viewport (Playwright does the same), and a
 * point's pixel is floor(x) - origin.x, floor(y) - origin.y for the cut origin.
 * A point outside the cut clip, or a non-finite point, throws.
 */
import type { BrowserContext, Page } from 'playwright'
import type { RGBA } from './math'
import { probe, settle } from './probe'

export interface Clip {
  x: number
  y: number
  width: number
  height: number
}

export interface PixelPoint {
  x: number
  y: number
}

/** Screenshot and decode budgets: every Playwright action is capped at 1500 ms. */
const ACTION_MS = 1500

const helperPages = new WeakMap<BrowserContext, Promise<Page>>()

async function helperFor(page: Page): Promise<Page> {
  const context = page.context()
  const cached = helperPages.get(context)
  if (cached !== undefined) {
    const existing = await cached
    if (!existing.isClosed()) return existing
  }
  const created = context.newPage().then(async (helper) => {
    await helper.goto('about:blank', { timeout: ACTION_MS })
    return helper
  })
  helperPages.set(context, created)
  created.catch(() => helperPages.delete(context))
  return created
}

/** Whole-pixel clip that contains the requested one. Throws for a non-finite or empty clip. */
export function integerClip(clip: Clip): Clip {
  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0) {
    throw new RangeError(`pixel clip needs finite x, y and a positive size, got ${JSON.stringify(clip)}`)
  }
  const x = Math.floor(clip.x)
  const y = Math.floor(clip.y)
  return { x, y, width: Math.ceil(clip.x + clip.width) - x, height: Math.ceil(clip.y + clip.height) - y }
}

function localPoints(points: readonly PixelPoint[], clip: Clip): Array<{ x: number; y: number }> {
  return points.map((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new RangeError(`pixel point needs finite coordinates, got (${String(p.x)}, ${String(p.y)})`)
    }
    const x = Math.floor(p.x) - clip.x
    const y = Math.floor(p.y) - clip.y
    if (x < 0 || y < 0 || x >= clip.width || y >= clip.height) {
      throw new RangeError(`pixel point (${p.x}, ${p.y}) lies outside the captured clip ${JSON.stringify(clip)}`)
    }
    return { x, y }
  })
}

/**
 * The part of the clip inside the viewport. Playwright trims a screenshot clip to
 * the viewport, so the image origin is the clamped origin, not the requested one.
 * Capturing the clamped clip makes the image origin known. Throws when nothing of
 * the clip is inside the viewport.
 */
async function visibleClip(page: Page, clip: Clip): Promise<Clip> {
  const c = integerClip(clip)
  const size = page.viewportSize() ?? (await probe<{ width: number; height: number }>(page, VIEWPORT_SOURCE, undefined, ACTION_MS))
  const x0 = Math.max(c.x, 0)
  const y0 = Math.max(c.y, 0)
  const x1 = Math.min(c.x + c.width, size.width)
  const y1 = Math.min(c.y + c.height, size.height)
  if (x1 <= x0 || y1 <= y0) {
    throw new RangeError(`pixel clip ${JSON.stringify(c)} lies outside the ${size.width} x ${size.height} viewport`)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

const VIEWPORT_SOURCE = '() => ({ width: window.innerWidth, height: window.innerHeight })'

async function captureClip(page: Page, clip: Clip): Promise<string> {
  const buffer = await page.screenshot({
    clip,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    timeout: ACTION_MS,
  })
  return buffer.toString('base64')
}

/**
 * The in-helper decoder. arg.mode is 'point' (RGBA at each point), 'blockMax'
 * (per-channel maximum over a (2r+1)^2 block at each point) or 'paintDiff' (the
 * largest RGB channel difference between two images in the 3x3 neighbourhood of
 * each point). Points are in image pixels. Returns plain numbers only.
 */
const DECODE_SOURCE = String.raw`async (arg) => {
  async function load(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
    // Read the size before close(): close() sets an ImageBitmap's width and height to 0.
    var w = bitmap.width, h = bitmap.height;
    var canvas = new OffscreenCanvas(w, h);
    var g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    var data = g.getImageData(0, 0, w, h).data;
    if (bitmap.close) bitmap.close();
    return { width: w, height: h, data: data };
  }
  function at(img, x, y) {
    var k = (y * img.width + x) * 4;
    return [img.data[k], img.data[k + 1], img.data[k + 2], img.data[k + 3]];
  }
  function inside(img, p) {
    if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) {
      throw new Error('pixel (' + p.x + ', ' + p.y + ') is outside the ' + img.width + ' x ' + img.height + ' image');
    }
  }
  var first = await load(arg.images[0]);
  if (arg.mode === 'point') {
    return arg.points.map(function (p) { inside(first, p); return at(first, p.x, p.y); });
  }
  if (arg.mode === 'blockMax') {
    var r = arg.radius;
    return arg.points.map(function (p) {
      inside(first, p);
      var m = [0, 0, 0, 0];
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        var x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0 || x >= first.width || y >= first.height) continue;
        var c = at(first, x, y);
        for (var k = 0; k < 4; k++) if (c[k] > m[k]) m[k] = c[k];
      }
      return m;
    });
  }
  if (arg.mode === 'paintDiff') {
    var second = await load(arg.images[1]);
    return arg.points.map(function (p) {
      inside(first, p);
      var best = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0 || x >= first.width || y >= first.height) continue;
        var a = at(first, x, y), b = at(second, x, y);
        var d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
        if (d > best) best = d;
      }
      return best;
    });
  }
  throw new Error('unknown decode mode ' + arg.mode);
}`

async function decode<T>(page: Page, arg: Record<string, unknown>): Promise<T> {
  const helper = await helperFor(page)
  return probe<T>(helper, DECODE_SOURCE, arg, ACTION_MS)
}

/**
 * RGBA at each point, exactly as drawn. Alpha is 0..1. The result has one entry
 * per point, in order. Use it for flat fills, where the colour is exact.
 */
export async function samplePixels(page: Page, clip: Clip, points: readonly PixelPoint[]): Promise<RGBA[]> {
  const c = await visibleClip(page, clip)
  const local = localPoints(points, c)
  const image = await captureClip(page, c)
  const raw = await decode<number[][]>(page, { mode: 'point', images: [image], points: local })
  return raw.map((v) => [v[0]!, v[1]!, v[2]!, v[3]! / 255] as RGBA)
}

/**
 * Per-channel maximum over the (2r+1) x (2r+1) block centred on each point,
 * clipped to the clip. Alpha is 0..1. Use it to find a thin stroke near a point
 * without caring about its exact pixel.
 */
export async function sampleBlockMax(
  page: Page,
  clip: Clip,
  points: readonly PixelPoint[],
  radius = 1
): Promise<RGBA[]> {
  if (!Number.isInteger(radius) || radius < 0) throw new RangeError('sampleBlockMax radius must be a non-negative integer')
  const c = await visibleClip(page, clip)
  const local = localPoints(points, c)
  const image = await captureClip(page, c)
  const raw = await decode<number[][]>(page, { mode: 'blockMax', images: [image], points: local, radius })
  return raw.map((v) => [v[0]!, v[1]!, v[2]!, v[3]! / 255] as RGBA)
}

const HIDE_STYLE_ID = '__bench_paint_diff'

const ADD_HIDE_SOURCE = `(selector) => {
  const style = document.createElement('style');
  style.id = '${HIDE_STYLE_ID}';
  style.textContent = selector + '{visibility:hidden !important}';
  (document.head || document.documentElement).appendChild(style);
  return true;
}`

/** Hides the index-th element matching a selector, by marking it (the style rule is shared). */
const ADD_HIDE_ONE_SOURCE = `(arg) => {
  const el = document.querySelectorAll(arg.selector)[arg.index];
  if (!el) return false;
  el.setAttribute('data-bench-paint-hide', '');
  const style = document.createElement('style');
  style.id = '${HIDE_STYLE_ID}';
  style.textContent = '[data-bench-paint-hide]{visibility:hidden !important}';
  (document.head || document.documentElement).appendChild(style);
  return true;
}`

const REMOVE_HIDE_SOURCE = `() => {
  const style = document.getElementById('${HIDE_STYLE_ID}');
  if (style) style.remove();
  document.querySelectorAll('[data-bench-paint-hide]').forEach((el) => el.removeAttribute('data-bench-paint-hide'));
  return true;
}`

/**
 * For each point, the largest per-channel RGB difference within its 3x3
 * neighbourhood between the clip drawn normally and the clip with hideSelector
 * set to visibility:hidden (layout is unchanged). About zero means the element
 * paints nothing there; a large value means it paints there. Use it to prove that
 * an element's pixels are where its geometry says, independent of any background.
 */
export async function paintDiff(
  page: Page,
  clip: Clip,
  hideSelector: string,
  points: readonly PixelPoint[]
): Promise<number[]> {
  const c = await visibleClip(page, clip)
  const local = localPoints(points, c)
  const drawn = await captureClip(page, c)
  let hidden: string
  try {
    await probe(page, ADD_HIDE_SOURCE, hideSelector, ACTION_MS)
    await settle(page)
    hidden = await captureClip(page, c)
  } finally {
    await probe(page, REMOVE_HIDE_SOURCE, undefined, ACTION_MS).catch(() => undefined)
    await settle(page)
  }
  return decode<number[]>(page, { mode: 'paintDiff', images: [drawn, hidden], points: local })
}

/**
 * One element group to judge: the selector that hides only that group, and the points
 * it must paint. With index, only the index-th element matching hide is hidden (for
 * a set of similar elements that must be judged one at a time).
 */
export interface PaintGroup {
  hide: string
  index?: number
  points: readonly PixelPoint[]
}

/**
 * paintDiff for several groups at once: the clip is captured once drawn normally,
 * then once per group with ONLY that group's selector set to visibility:hidden.
 * Each group is therefore judged against the picture that lies behind it, so a
 * dark element over a bright one, or a dash in a dashed line, is measured on its
 * own. Returns one array per group, in order (empty for a group with no points).
 */
export async function paintDiffGroups(page: Page, clip: Clip, groups: readonly PaintGroup[]): Promise<number[][]> {
  const c = await visibleClip(page, clip)
  const needed = groups.some((g) => g.points.length > 0)
  const drawn = needed ? await captureClip(page, c) : ''
  const out: number[][] = []
  for (const group of groups) {
    if (group.points.length === 0) {
      out.push([])
      continue
    }
    const local = localPoints(group.points, c)
    let hidden: string
    try {
      if (group.index === undefined) {
        await probe(page, ADD_HIDE_SOURCE, group.hide, ACTION_MS)
      } else {
        const hid = await probe<boolean>(page, ADD_HIDE_ONE_SOURCE, { selector: group.hide, index: group.index }, ACTION_MS)
        if (hid !== true) throw new Error(`paintDiffGroups: nothing matches ${group.hide} at index ${group.index}`)
      }
      await settle(page)
      hidden = await captureClip(page, c)
    } finally {
      await probe(page, REMOVE_HIDE_SOURCE, undefined, ACTION_MS).catch(() => undefined)
      await settle(page)
    }
    out.push(await decode<number[]>(page, { mode: 'paintDiff', images: [drawn, hidden], points: local }))
  }
  return out
}
