import { inflateSync } from 'node:zlib'

/**
 * Decoded pixels for the behavioural checks.
 *
 * The checks used to compare the PNG FILE BYTES of two canvas captures. A PNG's
 * data is a deflate stream over filtered scanlines, so a one-pixel change moves
 * compressed bytes all over the file, and an unchanged picture can move them
 * too. Comparing decoded pixels measures what the check is about: how much of
 * the picture changed.
 *
 * Scope is deliberately narrow, because every format outside it would be an
 * untested path: non-interlaced PNGs with 8-bit RGB or RGBA samples, which is
 * what a canvas screenshot produces. Anything else throws, with the reason,
 * rather than decoding to something plausible.
 */

export interface DecodedImage {
  width: number
  height: number
  /** RGBA, 8 bits per channel, row-major from the top row. Length = width × height × 4. */
  data: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG colour types this decoder accepts, with their channel counts. */
const CHANNELS_BY_COLOUR_TYPE: Record<number, number> = { 2: 3, 6: 4 }

/**
 * Decode a non-interlaced 8-bit RGB or RGBA PNG to RGBA pixels. Uses only
 * `node:zlib` for the deflate stream. Handles all five scanline filters (None,
 * Sub, Up, Average, Paeth). Throws on any other format.
 */
export function decodePng(input: Uint8Array): DecodedImage {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('decodePng: not a PNG (bad signature)')
  }

  let header: { width: number; height: number; bitDepth: number; colorType: number; compression: number; filter: number; interlace: number } | undefined
  const idat: Buffer[] = []
  let sawEnd = false
  let pos = PNG_SIGNATURE.length
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new Error(`decodePng: truncated ${type} chunk`)
    const body = buf.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`decodePng: IHDR is ${length} bytes, expected 13`)
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8]!,
        colorType: body[9]!,
        compression: body[10]!,
        filter: body[11]!,
        interlace: body[12]!,
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }
    pos = dataEnd + 4 // skip the CRC
  }

  if (!header) throw new Error('decodePng: no IHDR chunk')
  if (!sawEnd) throw new Error('decodePng: no IEND chunk (truncated file)')
  if (header.width === 0 || header.height === 0) throw new Error(`decodePng: empty image ${header.width}x${header.height}`)
  if (header.bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${header.bitDepth} (only 8)`)
  const channels = CHANNELS_BY_COLOUR_TYPE[header.colorType]
  if (channels === undefined) {
    throw new Error(`decodePng: unsupported colour type ${header.colorType} (only RGB=2 and RGBA=6)`)
  }
  if (header.compression !== 0 || header.filter !== 0) {
    throw new Error('decodePng: unknown compression or filter method in IHDR')
  }
  if (header.interlace !== 0) throw new Error('decodePng: interlaced PNG is not supported')

  const { width, height } = header
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const expected = height * (stride + 1)
  if (raw.length !== expected) {
    throw new Error(`decodePng: image data is ${raw.length} bytes, expected ${expected} for ${width}x${height}`)
  }

  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filterType = raw[rowStart]!
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    unfilterRow(filterType, src, prev, cur, channels)
    const outRow = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = outRow + x * 4
      out[d] = cur[s]!
      out[d + 1] = cur[s + 1]!
      out[d + 2] = cur[s + 2]!
      out[d + 3] = channels === 4 ? cur[s + 3]! : 255
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return { width, height, data: out }
}

/** Reverse one scanline's filter. `bpp` is bytes per pixel (8-bit samples). */
function unfilterRow(filterType: number, src: Uint8Array, prev: Uint8Array, cur: Uint8Array, bpp: number): void {
  switch (filterType) {
    case 0:
      for (let i = 0; i < src.length; i++) cur[i] = src[i]!
      return
    case 1:
      for (let i = 0; i < src.length; i++) cur[i] = src[i]! + (i >= bpp ? cur[i - bpp]! : 0)
      return
    case 2:
      for (let i = 0; i < src.length; i++) cur[i] = src[i]! + prev[i]!
      return
    case 3:
      for (let i = 0; i < src.length; i++) {
        const left = i >= bpp ? cur[i - bpp]! : 0
        cur[i] = src[i]! + ((left + prev[i]!) >> 1)
      }
      return
    case 4:
      for (let i = 0; i < src.length; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0
        const b = prev[i]!
        const c = i >= bpp ? prev[i - bpp]! : 0
        cur[i] = src[i]! + paeth(a, b, c)
      }
      return
    default:
      throw new Error(`decodePng: unknown PNG filter type ${filterType}`)
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * The largest absolute difference across the four RGBA channels of pixel `i`
 * (an index into pixels, not bytes).
 */
export function maxChannelDifference(a: Uint8Array, b: Uint8Array, pixel: number): number {
  const o = pixel * 4
  let max = 0
  for (let c = 0; c < 4; c++) {
    const d = Math.abs(a[o + c]! - b[o + c]!)
    if (d > max) max = d
  }
  return max
}

/**
 * The fraction of pixels whose largest channel difference exceeds `tolerance`
 * (0..255). Returns 1 when the two images differ in size: the picture changed
 * shape, which is the strongest change there is.
 */
export function pixelDiffRatio(a: DecodedImage, b: DecodedImage, tolerance: number): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  const pixels = a.width * a.height
  if (pixels === 0) return 0
  let changed = 0
  for (let i = 0; i < pixels; i++) {
    if (maxChannelDifference(a.data, b.data, i) > tolerance) changed++
  }
  return changed / pixels
}

/** Pixels sampled to find the background colour. The mode of a sample is the mode of the image. */
const HISTOGRAM_SAMPLE_TARGET = 262_144

/**
 * The fraction of pixels that are NOT the image's most common colour, within
 * `tolerance`. A blank or single-colour canvas reads 0; a canvas with drawn
 * content reads the share of the picture that departs from its background.
 *
 * The background is the most frequent exact RGBA value (ties resolve to the
 * first colour seen). A pixel counts as background when every channel is within
 * `tolerance` of it, so anti-aliased edges of a shape do not each count as a
 * distinct colour.
 */
export function fractionOffBackground(image: DecodedImage, tolerance: number): number {
  const pixels = image.width * image.height
  if (pixels === 0) return 0
  const data = image.data
  // The background is a mode, so a sample of at most HISTOGRAM_SAMPLE_TARGET
  // pixels finds it. Counting every pixel of a large capture (a 6000x4000 canvas
  // is 24 million) took seconds and hundreds of megabytes of map entries.
  const stride = Math.max(1, Math.ceil(pixels / HISTOGRAM_SAMPLE_TARGET))
  const counts = new Map<number, number>()
  for (let i = 0; i < pixels; i += stride) {
    const o = i * 4
    const key = ((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let background = 0
  let most = -1
  for (const [key, count] of counts) {
    if (count > most) {
      most = count
      background = key
    }
  }
  const bgR = (background >>> 24) & 0xff
  const bgG = (background >>> 16) & 0xff
  const bgB = (background >>> 8) & 0xff
  const bgA = background & 0xff
  let off = 0
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(data[o]! - bgR),
      Math.abs(data[o + 1]! - bgG),
      Math.abs(data[o + 2]! - bgB),
      Math.abs(data[o + 3]! - bgA)
    )
    if (d > tolerance) off++
  }
  return off / pixels
}
