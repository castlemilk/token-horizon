import { describe, it, expect, afterEach } from 'vitest'
import { PROBE_CHECKS, PROBE_HTML, probeKnownGoodBrowser } from './browser-probe'
import { closeSandbox } from './sandbox'
import { resetSandboxRuntime } from './sandbox-backend'

describe('the known-good probe page', () => {
  it('has the elements its checks read, so a check can only fail for the browser', () => {
    expect(PROBE_HTML).toContain('id="probe-scene"')
    expect(PROBE_HTML).toContain('id="probe-button"')
    expect(PROBE_CHECKS.map((c) => c.checkName)).toEqual(['probe-animates', 'probe-responds'])
    expect(PROBE_CHECKS.every((c) => (c.maxPoints ?? 0) > 0)).toBe(true)
  })
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('the known-good probe on a real browser', () => {
  afterEach(async () => {
    await closeSandbox()
    resetSandboxRuntime()
  })

  it('passes on a healthy browser, with its artifact budgets', async () => {
    const outcome = await probeKnownGoodBrowser()
    expect(outcome).toEqual({ ok: true, failing: [] })
  }, 60_000)
})
