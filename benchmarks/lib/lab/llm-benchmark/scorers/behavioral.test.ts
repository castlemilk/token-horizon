import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'

import { BENCHMARK_TASKS } from '../registry'
import { isFallbackCheck } from '../types'
import { BEHAVIOURAL_RUN_CHECK, behavioralScorer, scoreWithBreakdown, scoreWithChecksForTesting } from './behavioral'
import { closeSandbox, defineCheck, type CheckFn } from './sandbox'
import { BROWSER_RUN_FAILED_PREFIX, scoreBreakdownsOrStop } from './browser-fallback'
import { resetSandboxRuntime, setSandboxBackend, type SandboxBackend } from './sandbox-backend'

const task = BENCHMARK_TASKS.find((t) => t.id === 'mini-platformer')!

const ARTIFACT = '<!doctype html><html><body><canvas id="c" width="300" height="200"></canvas></body></html>'

afterEach(() => resetSandboxRuntime())
afterAll(closeSandbox)

/** A backend whose page accepts any content and whose checks never need it. */
function stubBackend(): SandboxBackend {
  const page = {
    on: () => {},
    setContent: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => null,
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

function structuralOnly(): SandboxBackend {
  return {
    name: 'structural',
    enforcement: 'partial',
    launch: async () => {
      throw new Error('sandbox backend "structural": no browser available')
    },
    close: async () => {},
  }
}

/** The composite a fixed set of checks produces, through the real scorer. */
async function scoreWith(checks: CheckFn[]) {
  return scoreWithChecksForTesting(ARTIFACT, task, checks)
}

const companion = defineCheck('companion', 70, async () => ({
  name: 'companion',
  passed: true,
  points: 70,
  maxPoints: 70,
}))

describe('behavioural run fallback', () => {
  it('records a behavioural-run fallback row when the browser cannot run, and scores structurally', async () => {
    setSandboxBackend(structuralOnly())
    const result = await scoreWithBreakdown(ARTIFACT, task)
    expect(result.checks).toEqual([
      {
        name: BEHAVIOURAL_RUN_CHECK,
        passed: false,
        points: 0,
        maxPoints: 0,
        kind: 'fallback',
        detail: expect.stringContaining('behavioural run failed'),
      },
    ])
    expect(result.fallbackReason).toMatch(/^behavioural run failed: /)
    expect(result.behavioralMax).toBe(0)
    expect(result.score).toBe(result.structural)
  })

  it('persists the fallback row as a fallback, never as a failed model check', async () => {
    setSandboxBackend(structuralOnly())
    const breakdown = await behavioralScorer.scoreWithBreakdown!(ARTIFACT, task)
    expect(breakdown.checks).toHaveLength(1)
    expect(breakdown.checks[0]).toMatchObject({ name: BEHAVIOURAL_RUN_CHECK, kind: 'fallback', maxPoints: 0 })
    expect(breakdown.checks.every((c) => isFallbackCheck(c))).toBe(true)
  })
})

describe('a task with no checks defined', () => {
  it('leaves a visible fallback row and scores structurally, with no browser run', async () => {
    setSandboxBackend(stubBackend())
    const bare = { ...task, id: 'no-such-task-has-no-checks', checks: undefined } as unknown as typeof task
    const result = await scoreWithBreakdown(ARTIFACT, bare)
    expect(result.checks).toEqual([
      {
        name: BEHAVIOURAL_RUN_CHECK,
        passed: false,
        points: 0,
        maxPoints: 0,
        kind: 'fallback',
        detail: 'no behavioural checks defined for task',
      },
    ])
    expect(result.fallbackReason).toBe('no behavioural checks defined for task')
    expect(result.score).toBe(result.structural)
  })
})

describe('a check that throws is scored as a failure with its budget', () => {
  // Unit form: the checks do not touch the page, so the composite arithmetic
  // is the only thing under test. The browser form below uses a real canvas.
  it('scores a throwing check exactly as a clean failure of the same budget', async () => {
    setSandboxBackend(stubBackend())
    const passing = defineCheck('space-moves', 30, async () => ({ name: 'space-moves', passed: true, points: 30, maxPoints: 30 }))
    const throwing = defineCheck('space-moves', 30, async () => {
      throw new Error('check bug')
    })
    const failing = defineCheck('space-moves', 30, async () => ({ name: 'space-moves', passed: false, points: 0, maxPoints: 30 }))

    const pass = await scoreWith([companion, passing])
    const threw = await scoreWith([companion, throwing])
    const failed = await scoreWith([companion, failing])

    expect(threw.behavioralMax).toBe(100)
    expect(threw.score).toBeLessThan(pass.score)
    expect(threw.score).toBeLessThanOrEqual(failed.score)
    expect(threw.score).toBe(failed.score)
    expect(threw.checks.find((c) => c.name === 'space-moves')).toMatchObject({ points: 0, maxPoints: 30 })
  })
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('a throwing check on a real page', () => {
  // A canvas that moves its square on Space and stays still otherwise. The
  // check below presses Space and compares two captures; it is the same check
  // in all three runs, and only its outcome differs.
  const GAME = `<!doctype html><html><body style="margin:0"><canvas id="c" width="300" height="200"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');let y=140;
function draw(){g.fillStyle='#123';g.fillRect(0,0,300,200);g.fillStyle='#fd6';g.fillRect(40,y,30,30)}
draw();
addEventListener('keydown',e=>{if(e.code==='Space'){y=40;draw()}});
</script></body></html>`

  const realSpaceCheck = defineCheck('space-moves', 30, async (ctx) => {
    const before = await ctx.captureCanvas()
    await ctx.page.keyboard.press('Space')
    await ctx.page.waitForTimeout(150)
    const after = await ctx.captureCanvas()
    const passed = Boolean(before && after && !before.data.equals(after.data))
    return { name: 'space-moves', passed, points: passed ? 30 : 0, maxPoints: 30 }
  })

  it('scores a check that throws below the same artifact when the check passes, and no higher than when it fails cleanly', async () => {
    const throwing = defineCheck('space-moves', 30, async () => {
      throw new Error('check bug')
    })
    const failing = defineCheck('space-moves', 30, async () => ({ name: 'space-moves', passed: false, points: 0, maxPoints: 30 }))

    const pass = await scoreWithChecksForTesting(GAME, task, [companion, realSpaceCheck])
    const threw = await scoreWithChecksForTesting(GAME, task, [companion, throwing])
    const failed = await scoreWithChecksForTesting(GAME, task, [companion, failing])

    expect(pass.checks.find((c) => c.name === 'space-moves')?.passed, 'the real check passes on this artifact').toBe(true)
    expect(threw.score).toBeLessThan(pass.score)
    expect(threw.score).toBeLessThanOrEqual(failed.score)
    expect(threw.behavioralMax).toBe(100)
  }, 60_000)
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('a browser that dies while the checks run', () => {
  // The same canvas as above. The first check closes the browser under the run,
  // the way a crash or the OS killing it would, and the check after it touches
  // the page. Before the fix the closed-page errors were recorded as failed
  // checks and the artifact published a score of 68 with exit 0.
  const GAME = `<!doctype html><html><body style="margin:0"><canvas id="c" width="300" height="200"></canvas></body></html>`

  const killer = defineCheck('kill-browser', 30, async (ctx) => {
    await ctx.page.context().browser()?.close()
    await ctx.page.waitForTimeout(50)
    return { name: 'kill-browser', passed: true, points: 30, maxPoints: 30 }
  })
  const followUp = defineCheck('follow-up', 30, async (ctx) => {
    await ctx.page.waitForTimeout(10)
    return { name: 'follow-up', passed: true, points: 30, maxPoints: 30 }
  })

  it('is a failed browser run with a fallback row, never a scored artifact', async () => {
    try {
      const result = await scoreWithChecksForTesting(GAME, task, [companion, killer, followUp])
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]).toMatchObject({ name: BEHAVIOURAL_RUN_CHECK, kind: 'fallback', maxPoints: 0 })
      expect(result.checks[0]!.detail).toMatch(new RegExp(`^${BROWSER_RUN_FAILED_PREFIX}the browser closed while the checks ran`))
    } finally {
      await closeSandbox()
    }
  }, 60_000)

  it('on the sweep path, relaunches the browser once and publishes the rescored artifact', async () => {
    let first = true
    try {
      const out = await scoreBreakdownsOrStop(
        async (output, t) => {
          const checks = first ? [companion, killer, followUp] : [companion, followUp]
          first = false
          const result = await scoreWithChecksForTesting(output, t, checks)
          return { score: result.score, checks: result.checks }
        },
        [GAME],
        task
      )
      expect(out[0]!.checks.some((c) => c.kind === 'fallback')).toBe(false)
      expect(out[0]!.checks.map((c) => c.name)).toEqual(['companion', 'follow-up'])
    } finally {
      await closeSandbox()
    }
  }, 120_000)
})
