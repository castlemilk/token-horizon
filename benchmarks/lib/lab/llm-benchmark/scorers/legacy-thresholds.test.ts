import { describe, it, expect } from 'vitest'
import type { Page } from 'playwright'
import { BENCHMARK_TASKS } from '../registry'
import { getChecksForTask } from './checks'
import type { CheckContext, CheckFn } from './check-meta'

/**
 * Each legacy check is pinned to its threshold by two fixtures, one just below and
 * one just above it. A threshold changed by a single step fails one of them.
 *
 * The fixtures are synthetic PNG files, because the legacy checks read the PNG
 * file's bytes: `canvasContentScore` sums the IDAT chunk lengths over 50,000
 * bytes, and `pixelDiffScore` samples every 13th byte.
 */

/** A PNG file with one IDAT chunk of `idatBytes` bytes and an IEND chunk. CRCs are not read by the scorer. */
function pngWithIdat(idatBytes: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([signature, chunk('IDAT', Buffer.alloc(idatBytes, 1)), chunk('IEND', Buffer.alloc(0))])
}

/** A buffer of `length` bytes, with the sampled bytes (every 13th) changed at `changed` of the `length / 13` sample points. */
function withSampledChanges(length: number, changed: number): [Buffer, Buffer] {
  const before = Buffer.alloc(length, 0)
  const after = Buffer.from(before)
  const samples = Math.floor(length / 13)
  for (let i = 0; i < changed; i++) after[i * 13] = 1
  expect(changed).toBeLessThanOrEqual(samples)
  return [before, after]
}

/** A check context whose canvas captures come from `captures`, in order. */
function ctxWithCaptures(captures: Buffer[]): CheckContext {
  let next = 0
  const page = { waitForTimeout: async () => {} } as unknown as Page
  return {
    page,
    html: '',
    captureCanvas: async () => {
      const data = captures[Math.min(next++, captures.length - 1)]!
      return { width: 1024, height: 720, data }
    },
  }
}

function legacyCheck(taskId: string, checkName: string): CheckFn {
  const task = BENCHMARK_TASKS.find((t) => t.id === taskId)
  const check = getChecksForTask(task!).find((c) => c.checkName === checkName)
  if (!check) throw new Error(`no check ${checkName} on ${taskId}`)
  return check
}

describe('nbody-renders: canvas content threshold is 15%', () => {
  const check = () => legacyCheck('n-body-field', 'nbody-renders')

  it('fails a canvas whose compressed content reads 14.8%, just below the threshold', async () => {
    const row = await check()(ctxWithCaptures([pngWithIdat(7_400)]))
    expect(row).toMatchObject({ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35 })
    expect(row.detail).toMatch(/threshold 15%/)
  })

  it('fails a canvas at exactly 15%, because the threshold is strict', async () => {
    const row = await check()(ctxWithCaptures([pngWithIdat(7_500)]))
    expect(row.passed).toBe(false)
  })

  it('passes a canvas whose compressed content reads 15.2%, just above the threshold', async () => {
    const row = await check()(ctxWithCaptures([pngWithIdat(7_600)]))
    expect(row).toMatchObject({ name: 'nbody-renders', passed: true, points: 35, maxPoints: 35 })
  })
})

describe('nbody-animates: pixel diff threshold is 1% over 1.2 s', () => {
  const check = () => legacyCheck('n-body-field', 'nbody-animates')

  it('fails a page whose sampled bytes change at exactly 1%, because the threshold is strict', async () => {
    const [before, after] = withSampledChanges(1_300, 1)
    const row = await check()(ctxWithCaptures([before, after]))
    expect(row).toMatchObject({ name: 'nbody-animates', passed: false, points: 0, maxPoints: 30 })
  })

  it('passes a page whose sampled bytes change at 2%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(1_300, 2)
    const row = await check()(ctxWithCaptures([before, after]))
    expect(row).toMatchObject({ name: 'nbody-animates', passed: true, points: 30, maxPoints: 30 })
  })
})

/**
 * A page for the key and DOM checks. `evaluate` answers from `values` in call
 * order, so each check's DOM reads are fixed by the test; the keyboard is a no-op.
 */
function fakePage(values: unknown[] = []): Page {
  let next = 0
  return {
    waitForTimeout: async () => {},
    keyboard: { down: async () => {}, up: async () => {} },
    evaluate: async () => values[Math.min(next++, values.length - 1)],
  } as unknown as Page
}

/** A check context with a page and canvas captures, for the key and DOM checks. */
function ctxWith(captures: Buffer[], values: unknown[] = []): CheckContext {
  let next = 0
  return {
    page: fakePage(values),
    html: '',
    captureCanvas: async () => {
      const data = captures[Math.min(next++, captures.length - 1)]!
      return { width: 1024, height: 720, data }
    },
  }
}

// A 2,600-byte capture samples 200 points, so each changed sample is half a percent.
const SAMPLES_200 = 2_600

describe('platformer-jump: pixel diff threshold is 2% after Space', () => {
  const check = () => legacyCheck('mini-platformer', 'platformer-jump')

  it('fails a canvas whose sampled bytes change at 1.5%, just below the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 3)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'platformer-jump', passed: false, points: 0, maxPoints: 30 })
  })

  it('fails a canvas that changes at exactly 2%, because the threshold is strict', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 4)
    const row = await check()(ctxWith([before, after]))
    expect(row.passed).toBe(false)
  })

  it('passes a canvas whose sampled bytes change at 2.5%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 5)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'platformer-jump', passed: true, points: 30, maxPoints: 30 })
  })
})

describe('platformer-move: pixel diff threshold is 2% after ArrowRight', () => {
  const check = () => legacyCheck('mini-platformer', 'platformer-move')

  it('fails at 1.5%, just below the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 3)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'platformer-move', passed: false, points: 0, maxPoints: 25 })
  })

  it('passes at 2.5%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 5)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'platformer-move', passed: true, points: 25, maxPoints: 25 })
  })
})

describe('pendulum-renders: canvas content threshold is 15%', () => {
  const check = () => legacyCheck('physics-pendulum-wave', 'pendulum-renders')

  it('fails a canvas whose compressed content reads 14.8%, just below the threshold', async () => {
    const row = await check()(ctxWith([pngWithIdat(7_400)]))
    expect(row).toMatchObject({ name: 'pendulum-renders', passed: false, points: 0, maxPoints: 35 })
  })

  it('passes a canvas whose compressed content reads 15.2%, just above the threshold', async () => {
    const row = await check()(ctxWith([pngWithIdat(7_600)]))
    expect(row).toMatchObject({ name: 'pendulum-renders', passed: true, points: 35, maxPoints: 35 })
  })
})

describe('pendulum-animates: pixel diff threshold is 1% over 0.8 s', () => {
  const check = () => legacyCheck('physics-pendulum-wave', 'pendulum-animates')

  it('fails a page whose sampled bytes change at exactly 1%, because the threshold is strict', async () => {
    const [before, after] = withSampledChanges(1_300, 1)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'pendulum-animates', passed: false, points: 0, maxPoints: 30 })
  })

  it('passes a page whose sampled bytes change at 2%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(1_300, 2)
    const row = await check()(ctxWith([before, after]))
    expect(row).toMatchObject({ name: 'pendulum-animates', passed: true, points: 30, maxPoints: 30 })
  })
})

describe('circuit-interact: pixel diff threshold is 0.5% after an input change', () => {
  const check = () => legacyCheck('circuit-builder-teaser', 'circuit-interact')

  it('fails a canvas that changes at exactly 0.5%, because the threshold is strict', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 1)
    const row = await check()(ctxWith([before, after], [true]))
    expect(row).toMatchObject({ name: 'circuit-interact', passed: false, points: 0, maxPoints: 35 })
  })

  it('passes a canvas that changes at 1%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 2)
    const row = await check()(ctxWith([before, after], [true]))
    expect(row).toMatchObject({ name: 'circuit-interact', passed: true, points: 35, maxPoints: 35 })
  })
})

describe('landing-animates: the canvas diff leg is 0.5%, with no DOM motion and no text change', () => {
  // evaluate() calls in order: body text before, motion, body text after. Nothing
  // moves in the DOM, so only the canvas leg can pass the check.
  const STILL = [100, { running: 0, declared: 0, keyframes: 0 }, 100]
  const check = () => legacyCheck('landing-page-morph', 'landing-animates')

  it('fails a canvas that changes at exactly 0.5%, because the threshold is strict', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 1)
    const row = await check()(ctxWith([before, after], STILL))
    expect(row).toMatchObject({ name: 'landing-animates', passed: false, points: 0, maxPoints: 35 })
  })

  it('passes a canvas that changes at 1%, just above the threshold', async () => {
    const [before, after] = withSampledChanges(SAMPLES_200, 2)
    const row = await check()(ctxWith([before, after], STILL))
    expect(row).toMatchObject({ name: 'landing-animates', passed: true, points: 35, maxPoints: 35 })
  })
})
