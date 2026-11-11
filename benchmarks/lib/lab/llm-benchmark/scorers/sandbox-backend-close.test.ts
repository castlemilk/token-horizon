import { describe, expect, it, vi } from 'vitest'

// The launched "browsers" are plain objects whose close() takes a while, so a
// launch can start while an earlier close is still in flight. No real browser.
const launched: Array<{ id: number; close: ReturnType<typeof vi.fn>; newContext: ReturnType<typeof vi.fn> }> = []

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => {
      const id = launched.length + 1
      const browser = {
        id,
        close: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }),
        newContext: vi.fn(async () => ({})),
      }
      launched.push(browser)
      return browser
    }),
  },
}))

import { createBackend, type SandboxPolicy } from './sandbox-backend'

const CHROMIUM: SandboxPolicy = { backend: 'chromium', enforcement: 'partial', preludeParity: false }

describe('closing the shared browser while another launch runs', () => {
  it('keeps track of a browser launched during a close, so the next close still closes it', async () => {
    launched.length = 0
    const backend = createBackend(CHROMIUM)

    await backend.launch()
    expect(launched).toHaveLength(1)
    const first = launched[0]!

    // A close is in flight (the first browser takes 20 ms to shut), and a second
    // caller launches meanwhile. The second browser must not be forgotten.
    const closing = backend.close()
    const session = await backend.launch()
    await closing
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(launched).toHaveLength(2)
    const second = launched[1]!
    expect(second.close).not.toHaveBeenCalled()
    expect(session).toBeDefined()

    await backend.close()
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('does not close a browser twice when close is called twice', async () => {
    launched.length = 0
    const backend = createBackend(CHROMIUM)
    await backend.launch()
    const only = launched[0]!
    await Promise.all([backend.close(), backend.close()])
    expect(only.close).toHaveBeenCalledTimes(1)
  })
})
