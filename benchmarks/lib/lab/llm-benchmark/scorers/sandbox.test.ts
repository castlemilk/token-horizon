import { describe, it, expect, afterEach, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright'

import { FRAME_PRELUDE } from '../frame-prelude'
import { BENCHMARK_TASKS } from '../registry'
import { scoreWithBreakdown } from './behavioral'
import { defineCheck, runChecks, type CheckFn } from './sandbox'
import { resetSandboxRuntime, setSandboxBackend, type SandboxBackend } from './sandbox-backend'

const ARTIFACT = '<html><head></head><body><canvas id="c"></canvas></body></html>'

/**
 * A backend that records what reached `setContent` and nothing else — the seam
 * the parity flag acts on. Spying here (rather than launching a browser) keeps
 * the assertion about the BYTES THE PAGE RECEIVED, which is the whole question.
 */
function recordingBackend(): { backend: SandboxBackend; contents: string[] } {
  const contents: string[] = []
  const page = {
    on: () => {},
    setContent: async (html: string) => {
      contents.push(html)
    },
    waitForTimeout: async () => {},
    evaluate: async () => null,
    close: async () => {},
  } as unknown as Page
  const context = {
    newPage: async () => page,
    close: async () => {},
  } as unknown as BrowserContext
  const backend: SandboxBackend = {
    name: 'chromium',
    enforcement: 'partial',
    launch: async () => ({ newContext: async () => context }),
    close: async () => {},
  }
  return { backend, contents }
}

/** A backend whose page never loads: the `page load failed` branch. */
function failingLoadBackend(): SandboxBackend {
  const page = {
    on: () => {},
    setContent: async () => {
      throw new Error('net::ERR_FAILED')
    },
    close: async () => {},
  } as unknown as Page
  const context = { newPage: async () => page, close: async () => {} } as unknown as BrowserContext
  return {
    name: 'chromium',
    enforcement: 'partial',
    launch: async () => ({ newContext: async () => context }),
    close: async () => {},
  }
}

afterEach(() => {
  resetSandboxRuntime()
  vi.useRealTimers()
})

it('clears completed check deadlines so offline rescoring can exit promptly', async () => {
  vi.useFakeTimers()
  setSandboxBackend(recordingBackend().backend)
  await runChecks(ARTIFACT, [async () => ({ name: 'done', passed: true, points: 1, maxPoints: 1 })])
  expect(vi.getTimerCount()).toBe(0)
})

describe('declared budgets survive a check that cannot finish', () => {
  it('records a throwing check with its declared name and point budget', async () => {
    setSandboxBackend(recordingBackend().backend)
    const boom = defineCheck('boom-check', 30, async () => {
      throw new Error('kaboom')
    })
    const [row] = await runChecks(ARTIFACT, [boom], { settleMs: 0 })
    expect(row).toEqual({ name: 'boom-check', passed: false, points: 0, maxPoints: 30, detail: 'threw: kaboom' })
  })

  it('records a check that never resolves with its declared name and point budget', async () => {
    setSandboxBackend(recordingBackend().backend)
    const hangs = defineCheck('hung-check', 35, () => new Promise<never>(() => {}))
    const [row] = await runChecks(ARTIFACT, [hangs], { settleMs: 0, perCheckTimeoutMs: 50 })
    expect(row).toMatchObject({ name: 'hung-check', passed: false, points: 0, maxPoints: 35 })
    expect(row!.detail).toMatch(/check timeout after 50ms/)
  })

  it('records a check skipped by the batch timeout with its declared budget', async () => {
    setSandboxBackend(recordingBackend().backend)
    const skipped = defineCheck('skipped-check', 20, async () => ({ name: 'skipped-check', passed: true, points: 20, maxPoints: 20 }))
    const [row] = await runChecks(ARTIFACT, [skipped], { settleMs: 0, totalTimeoutMs: -1 })
    expect(row).toEqual({ name: 'skipped-check', passed: false, points: 0, maxPoints: 20, detail: 'skipped: batch timeout' })
  })

  it('records every check with its declared budget when the page fails to load', async () => {
    setSandboxBackend(failingLoadBackend())
    const a = defineCheck('load-a', 30, async () => ({ name: 'load-a', passed: true, points: 30, maxPoints: 30 }))
    const b = defineCheck('load-b', 70, async () => ({ name: 'load-b', passed: true, points: 70, maxPoints: 70 }))
    const rows = await runChecks(ARTIFACT, [a, b], { settleMs: 0 })
    expect(rows.map((r) => [r.name, r.points, r.maxPoints])).toEqual([
      ['load-a', 0, 30],
      ['load-b', 0, 70],
    ])
    expect(rows.every((r) => r.detail?.startsWith('page load failed'))).toBe(true)
  })

  it('names an undeclared, unnamed check unnamed-check with a zero budget', async () => {
    setSandboxBackend(recordingBackend().backend)
    const anonymous: CheckFn = async () => {
      throw new Error('anon')
    }
    Object.defineProperty(anonymous, 'name', { value: '' })
    const [row] = await runChecks(ARTIFACT, [anonymous], { settleMs: 0 })
    expect(row).toMatchObject({ name: 'unnamed-check', points: 0, maxPoints: 0 })
  })

  it('refuses a budget that is not a positive number', () => {
    const fn = async () => ({ name: 'x', passed: true, points: 0, maxPoints: 1 })
    expect(() => defineCheck('x', 0, fn)).toThrow(/maxPoints must be a positive number/)
    expect(() => defineCheck('', 1, fn)).toThrow(/non-empty name/)
  })
})

describe('prelude parity', () => {
  it('loads the raw artifact by default', () => {
    const { backend, contents } = recordingBackend()
    setSandboxBackend(backend)
    return runChecks(ARTIFACT, []).then(() => {
      expect(contents).toEqual([ARTIFACT])
    })
  })

  it('wraps the artifact with the display prelude when parity is on', async () => {
    const { backend, contents } = recordingBackend()
    setSandboxBackend(backend, { backend: 'chromium', enforcement: 'partial', preludeParity: true })
    await runChecks(ARTIFACT, [])
    expect(contents).toHaveLength(1)
    expect(contents[0]).toContain(FRAME_PRELUDE)
    expect(contents[0]).toContain('<canvas id="c">')
    // The wrap is the DISPLAY path's, byte for byte — not a second prelude.
    expect(contents[0]).not.toBe(ARTIFACT)
  })
})

describe('structural backend end to end', () => {
  it('falls back to the structural score with a reason naming the backend', async () => {
    const task = BENCHMARK_TASKS.find((t) => t.id === 'mini-platformer')!
    setSandboxBackend(
      {
        name: 'structural',
        enforcement: 'partial',
        launch: async () => {
          throw new Error('sandbox backend "structural": no browser available (BENCH_SANDBOX=structural)')
        },
        close: async () => {},
      },
      { backend: 'structural', enforcement: 'partial', preludeParity: false }
    )
    const result = await scoreWithBreakdown(ARTIFACT, task)
    // The documented behaviouralFallback shape — one path, not a second one
    // invented for the no-browser backend. The breakdown records the reason as
    // one `behavioural-run` fallback row (zero points, zero budget), not `[]`.
    expect(result.checks).toEqual([
      {
        name: 'behavioural-run',
        passed: false,
        points: 0,
        maxPoints: 0,
        kind: 'fallback',
        detail: expect.stringMatching(/structural/),
      },
    ])
    expect(result.behavioralMax).toBe(0)
    expect(result.fallbackReason).toMatch(/structural/)
    expect(result.score).toBe(result.structural)
  })
})
