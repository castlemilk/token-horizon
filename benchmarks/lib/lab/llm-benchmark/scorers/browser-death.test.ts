import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'

import { defineCheck, runChecks } from './sandbox'
import { resetSandboxRuntime, setSandboxBackend, type SandboxBackend } from './sandbox-backend'

/**
 * Browser death is decided from the Browser object (`isConnected`), never from the
 * text of an error. These tests drive `runChecks` through a fake session whose
 * connection the test controls, so each case is exact.
 */

interface FakeRun {
  backend: SandboxBackend
  page: { listeners: Array<(e: Error) => void>; loadError?: Error }
  setConnected(value: boolean): void
}

function fakeRun(options: { loadError?: Error } = {}): FakeRun {
  let connected = true
  const page = {
    listeners: [] as Array<(e: Error) => void>,
    loadError: options.loadError,
    on(event: string, listener: (e: Error) => void) {
      if (event === 'pageerror') page.listeners.push(listener)
    },
    setContent: async () => {
      if (page.loadError) throw page.loadError
    },
    waitForTimeout: async () => {},
    evaluate: async () => null,
    close: async () => {},
  }
  const context = { newPage: async () => page as unknown as Page, close: async () => {} } as unknown as BrowserContext
  const backend: SandboxBackend = {
    name: 'chromium',
    enforcement: 'partial',
    launch: async () => ({ newContext: async () => context, isConnected: () => connected }),
    close: async () => {},
  }
  return {
    backend,
    page,
    setConnected(value: boolean) {
      connected = value
    },
  }
}

const OPTIONS = { settleMs: 0, perCheckTimeoutMs: 2_000, totalTimeoutMs: 10_000 }
const PASS = (name: string) => defineCheck(name, 10, async () => ({ name, passed: true, points: 10, maxPoints: 10 }))

afterEach(() => resetSandboxRuntime())

describe('a browser that is gone is read from the Browser object', () => {
  it('a page that fails to load while the browser is gone is a browser death, not failed rows', async () => {
    const run = fakeRun({ loadError: new Error('page.setContent: Target closed') })
    run.setConnected(false)
    setSandboxBackend(run.backend)
    await expect(runChecks('<canvas></canvas>', [PASS('a')], OPTIONS)).rejects.toThrow(/the browser closed while the checks ran/)
  })

  it('a page that fails to load while the browser is connected is an artifact row, even when its text names a closed page', async () => {
    const run = fakeRun({ loadError: new Error('page.setContent: Target page, context or browser has been closed') })
    setSandboxBackend(run.backend)
    const rows = await runChecks('<canvas></canvas>', [PASS('a'), PASS('b')], OPTIONS)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.passed && r.points === 0)).toBe(true)
    expect(rows[0]!.detail).toMatch(/^page load failed: .*has been closed/)
  })

  it('a check that throws a closed-page message while the browser is connected is a failed row, and the run finishes', async () => {
    const run = fakeRun()
    setSandboxBackend(run.backend)
    const closedPage = defineCheck('closes-itself', 25, async () => {
      throw new Error('page.waitForTimeout: Target page, context or browser has been closed')
    })
    const rows = await runChecks('<canvas></canvas>', [closedPage, PASS('after')], OPTIONS)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'closes-itself', passed: false, points: 0, maxPoints: 25 })
    expect(rows[0]!.detail).toMatch(/^threw: /)
    expect(rows[1]).toMatchObject({ name: 'after', passed: true })
  })

  it('an uncaught page error that says the socket dropped is a runtime-error row, not a dead browser', async () => {
    const run = fakeRun()
    setSandboxBackend(run.backend)
    const noisy = defineCheck('noisy', 10, async () => {
      for (const listener of run.page.listeners) listener(new Error('socket: browser disconnected'))
      return { name: 'noisy', passed: true, points: 10, maxPoints: 10 }
    })
    const rows = await runChecks('<canvas></canvas>', [noisy], OPTIONS)
    expect(rows[0]).toMatchObject({ name: 'noisy', passed: true })
    expect(rows[1]).toMatchObject({ name: 'no-runtime-errors', passed: false, maxPoints: 0 })
    expect(rows[1]!.detail).toMatch(/socket: browser disconnected/)
  })

  it('a browser that disconnects during the checks is a browser death, even when every later check passes', async () => {
    const run = fakeRun()
    setSandboxBackend(run.backend)
    const dies = defineCheck('dies', 10, async () => {
      run.setConnected(false)
      return { name: 'dies', passed: true, points: 10, maxPoints: 10 }
    })
    await expect(runChecks('<canvas></canvas>', [dies, PASS('later')], OPTIONS)).rejects.toThrow(
      /the browser closed while the checks ran/
    )
  })
})

/**
 * Browser-gated: a real Chromium page. An artifact that ends its own page, or that
 * names a dropped socket in an error, is the artifact's behaviour. The run must
 * finish with rows, never throw as if the browser had died.
 */
describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('a real page that ends itself is not a dead browser', () => {
  afterEach(async () => {
    const { closeSandbox } = await import('./sandbox')
    await closeSandbox()
  })

  const pass = defineCheck('still-there', 10, async () => ({ name: 'still-there', passed: true, points: 10, maxPoints: 10 }))
  const waits = defineCheck('after-the-end', 20, async (ctx) => {
    await ctx.page.waitForTimeout(900)
    return { name: 'after-the-end', passed: true, points: 20, maxPoints: 20 }
  })

  it('an artifact that calls window.close() finishes with rows, not a browser-death error', async () => {
    const html = `<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas><script>setTimeout(function(){window.close()},300)</script></body></html>`
    const rows = await runChecks(html, [pass, waits], { settleMs: 100, perCheckTimeoutMs: 4_000, totalTimeoutMs: 30_000 })
    expect(rows.map((r) => r.name)).toEqual(['still-there', 'after-the-end'])
    expect(rows.find((r) => r.name === 'after-the-end')).toBeDefined()
  }, 60_000)

  it('an artifact that navigates its page away finishes with rows, not a browser-death error', async () => {
    const html = `<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas><script>setTimeout(function(){location.replace('about:blank')},300)</script></body></html>`
    const rows = await runChecks(html, [pass, waits], { settleMs: 100, perCheckTimeoutMs: 4_000, totalTimeoutMs: 30_000 })
    expect(rows.map((r) => r.name)).toEqual(['still-there', 'after-the-end'])
  }, 60_000)

  it('an uncaught error that says the socket dropped is a runtime-error row beside passing checks', async () => {
    const html = `<!doctype html><html><body><canvas id="c"></canvas><script>setTimeout(function(){throw new Error('socket: browser disconnected')},50)</script></body></html>`
    const rows = await runChecks(html, [pass], { settleMs: 300, perCheckTimeoutMs: 4_000, totalTimeoutMs: 30_000 })
    expect(rows[0]).toMatchObject({ name: 'still-there', passed: true })
    expect(rows.find((r) => r.name === 'no-runtime-errors')?.detail).toMatch(/socket: browser disconnected/)
  }, 60_000)
})
