import { afterAll, describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'

import { closeSandbox } from './sandbox'
import { getSandboxBackend } from './sandbox-backend'
import { decodePng, fractionOffBackground, pixelDiffRatio, type DecodedImage } from './pixels'

afterAll(closeSandbox)

// ── a minimal PNG encoder, for building fixtures that use every filter ──────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(body)])), 0)
  return Buffer.concat([head, Buffer.from(body), crc])
}

/**
 * Encode RGBA pixels as a non-interlaced 8-bit PNG. `colourType` 6 keeps alpha,
 * 2 drops it. `filterFor(y)` picks the filter type for each scanline, so one
 * image can exercise all five.
 */
function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
  colourType: 2 | 6,
  filterFor: (y: number) => number
): Buffer {
  const channels = colourType === 6 ? 4 : 3
  const stride = width * channels
  const raw = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) raw[y * stride + x * channels + c] = rgba[(y * width + x) * 4 + c]!
    }
  }
  const filtered = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const type = filterFor(y)
    filtered[y * (stride + 1)] = type
    for (let i = 0; i < stride; i++) {
      const x = raw[y * stride + i]!
      const left = i >= channels ? raw[y * stride + i - channels]! : 0
      const up = y > 0 ? raw[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= channels ? raw[(y - 1) * stride + i - channels]! : 0
      let predictor = 0
      if (type === 1) predictor = left
      else if (type === 2) predictor = up
      else if (type === 3) predictor = (left + up) >> 1
      else if (type === 4) predictor = paethRef(left, up, upLeft)
      filtered[y * (stride + 1) + 1 + i] = (x - predictor) & 0xff
    }
  }
  return pngFile(ihdrBody(width, height, colourType), deflateSync(filtered))
}

/** IHDR for an 8-bit, non-interlaced image. */
function ihdrBody(width: number, height: number, colourType: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colourType
  return ihdr
}

/** Assemble signature, IHDR, one IDAT and IEND around a zlib stream. */
function pngFile(ihdr: Uint8Array, zlibStream: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStream),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function paethRef(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Deterministic pixels with varied, non-repeating content in every channel. */
function sampleRgba(width: number, height: number, seed: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  let state = seed >>> 0
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = state >>> 24
  }
  return out
}

function rgbaAt(image: DecodedImage, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4
  return Array.from(image.data.subarray(o, o + 4))
}

// ── decodePng ───────────────────────────────────────────────────────────────

describe('decodePng', () => {
  it('round-trips RGBA pixels through every scanline filter type', () => {
    const width = 9
    const height = 10
    const pixels = sampleRgba(width, height, 7)
    const png = encodePng(width, height, pixels, 6, (y) => y % 5)
    const decoded = decodePng(png)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(Buffer.from(decoded.data).equals(Buffer.from(pixels))).toBe(true)
  })

  it('decodes RGB as RGBA with opaque alpha', () => {
    const width = 6
    const height = 4
    const pixels = sampleRgba(width, height, 99)
    const png = encodePng(width, height, pixels, 2, (y) => (y + 2) % 5)
    const decoded = decodePng(png)
    for (let i = 0; i < width * height; i++) {
      expect(decoded.data[i * 4]).toBe(pixels[i * 4])
      expect(decoded.data[i * 4 + 1]).toBe(pixels[i * 4 + 1])
      expect(decoded.data[i * 4 + 2]).toBe(pixels[i * 4 + 2])
      expect(decoded.data[i * 4 + 3]).toBe(255)
    }
  })

  it('applies each filter to a row whose neighbours it depends on', () => {
    // Filter 4 (Paeth) and 3 (Average) read the row above and the byte to the
    // left; a 1-pixel-wide image checks the edge where the left byte is absent.
    for (const type of [0, 1, 2, 3, 4]) {
      const pixels = sampleRgba(1, 6, 1000 + type)
      const decoded = decodePng(encodePng(1, 6, pixels, 6, () => type))
      expect(Buffer.from(decoded.data).equals(Buffer.from(pixels)), `filter ${type}`).toBe(true)
    }
  })

  it('rejects anything it does not decode, with the reason', () => {
    const pixels = sampleRgba(2, 2, 3)
    const good = encodePng(2, 2, pixels, 6, () => 0)
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/bad signature/)

    // A palette image (colour type 3) is refused, not guessed at.
    const palette = Buffer.from(good)
    palette[25] = 3 // IHDR colour type byte: signature(8) + length(4) + type(4) + 9
    expect(() => decodePng(palette)).toThrow(/unsupported colour type 3/)

    const sixteen = Buffer.from(good)
    sixteen[24] = 16
    expect(() => decodePng(sixteen)).toThrow(/unsupported bit depth 16/)

    const interlaced = Buffer.from(good)
    interlaced[28] = 1
    expect(() => decodePng(interlaced)).toThrow(/interlaced/)
  })

  it('rejects a scanline whose filter type is unknown', () => {
    // Two RGBA rows of width 2; row 0 declares filter type 5, which PNG does not define.
    const raw = new Uint8Array(2 * (2 * 4 + 1))
    raw[0] = 5
    expect(() => decodePng(pngFile(ihdrBody(2, 2, 6), deflateSync(raw)))).toThrow(/unknown PNG filter type 5/)
  })
})

// ── pixelDiffRatio ──────────────────────────────────────────────────────────

describe('pixelDiffRatio', () => {
  const image = (width: number, height: number, fill: number[]): DecodedImage => {
    const data = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) data.set(fill, i * 4)
    return { width, height, data }
  }

  it('is zero for identical pixels and counts exactly the pixels that changed', () => {
    const a = image(2, 2, [10, 20, 30, 255])
    const b = image(2, 2, [10, 20, 30, 255])
    expect(pixelDiffRatio(a, b, 0)).toBe(0)
    b.data.set([10, 20, 31, 255], 0) // one pixel, one channel, by one level
    expect(pixelDiffRatio(a, b, 0)).toBe(0.25)
    expect(pixelDiffRatio(a, b, 1)).toBe(0) // exactly the tolerance is not over it
  })

  it('uses the largest channel difference, so a change in any single channel counts', () => {
    const a = image(1, 1, [0, 0, 0, 255])
    const b = image(1, 1, [0, 0, 0, 255])
    b.data.set([0, 0, 9, 255])
    expect(pixelDiffRatio(a, b, 8)).toBe(1)
    expect(pixelDiffRatio(a, b, 9)).toBe(0)
  })

  it('returns 1 when the dimensions differ', () => {
    expect(pixelDiffRatio(image(2, 2, [0, 0, 0, 255]), image(4, 1, [0, 0, 0, 255]), 0)).toBe(1)
  })
})

// ── fractionOffBackground ───────────────────────────────────────────────────

describe('fractionOffBackground', () => {
  it('is zero for a single-colour image', () => {
    const data = new Uint8Array(4 * 4 * 4).fill(200)
    expect(fractionOffBackground({ width: 4, height: 4, data }, 0)).toBe(0)
  })

  it('counts the pixels that depart from the most common colour', () => {
    const data = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) data.set(i < 12 ? [5, 5, 5, 255] : [250, 0, 0, 255], i * 4)
    expect(fractionOffBackground({ width: 4, height: 4, data }, 8)).toBe(0.25)
  })

  it('does not count near-background anti-aliasing as content', () => {
    const data = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) data.set(i < 12 ? [5, 5, 5, 255] : [9, 5, 5, 255], i * 4)
    expect(fractionOffBackground({ width: 4, height: 4, data }, 8)).toBe(0)
    expect(fractionOffBackground({ width: 4, height: 4, data }, 3)).toBe(0.25)
  })
})

describe('decodePng refuses what it does not decode', () => {
  it('throws for a palette PNG rather than decoding it to plausible pixels', () => {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(2, 0)
    ihdr.writeUInt32BE(2, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 3 // colour type 3: palette, not RGB or RGBA
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(2 * (2 * 1 + 1)))),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(() => decodePng(png)).toThrow(/unsupported colour type 3/)
  })
})

describe('fractionOffBackground on a large capture', () => {
  it('finds the background and reads the exact fraction of a large canvas, quickly', () => {
    const width = 2000
    const height = 1500
    const data = new Uint8Array(width * height * 4).fill(255)
    // A 100x100 black box: exactly 10,000 of 3,000,000 pixels depart from white.
    for (let y = 700; y < 800; y++) {
      for (let x = 900; x < 1000; x++) data.set([0, 0, 0, 255], (y * width + x) * 4)
    }
    const started = Date.now()
    const fraction = fractionOffBackground({ width, height, data }, 8)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(fraction).toBeCloseTo(10_000 / 3_000_000, 10)
  })
})

// ── real canvas pixels, browser-gated ───────────────────────────────────────

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('decodePng on a real Playwright canvas screenshot', () => {
  it('decodes to exactly the pixels the page reads with getImageData', async () => {
    const session = await getSandboxBackend().launch()
    const context = await session.newContext({ viewport: { width: 240, height: 160 } })
    const page = await context.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><body style="margin:0"><canvas id="c" width="240" height="160" style="display:block"></canvas><script>
const g=document.getElementById('c').getContext('2d');
g.fillStyle='#102030';g.fillRect(0,0,240,160);
for(let i=0;i<40;i++){g.fillStyle='rgb('+(i*37%256)+','+(i*91%256)+','+(i*53%256)+')';g.fillRect((i*29)%230,(i*17)%150,13+(i%7),9+(i%5));}
g.beginPath();g.arc(120,80,50,0,Math.PI*2);g.fillStyle='#fd6';g.fill();
</script></body></html>`,
        { waitUntil: 'load' }
      )
      const png = await page.locator('canvas#c').screenshot()
      const decoded = decodePng(png)
      const fromPage = await page.evaluate(() => {
        const canvas = document.getElementById('c') as HTMLCanvasElement
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        return { width: canvas.width, height: canvas.height, data: Array.from(data) }
      })
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: fromPage.width, height: fromPage.height })
      let differing = 0
      for (let i = 0; i < decoded.data.length; i++) {
        if (decoded.data[i] !== fromPage.data[i]) differing++
      }
      expect(differing, 'channel values that differ from getImageData').toBe(0)
    } finally {
      await page.close().catch(() => {})
      await context.close().catch(() => {})
    }
  }, 30_000)
})
