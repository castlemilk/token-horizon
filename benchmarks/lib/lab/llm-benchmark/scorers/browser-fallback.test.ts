import { afterEach, describe, expect, it } from 'vitest'
import { BEHAVIOURAL_RUN_CHECK, type BenchmarkTask, type IterationCheckResult } from '../types'
import {
  BrowserFallbackError,
  RESCORE_DELAY_MS,
  scoreBreakdownsOrStop,
  scoreConcurrency,
  withScoringLock,
  type ProbeOutcome,
  type ScoredBreakdown,
  type ScoringEvent,
} from './browser-fallback'
import { closeSandbox } from './sandbox'
import { isTimeoutDetail, isTimeoutRow } from './browser-gone'
import {
  discardSandboxBrowser,
  getSandboxBackend,
  resetSandboxRuntime,
  setSandboxBackend,
  type SandboxBackend,
  type SandboxPolicy,
} from './sandbox-backend'

const TASK = { id: 'n-body-field' } as unknown as BenchmarkTask

const FALLBACK: IterationCheckResult = {
  name: BEHAVIOURAL_RUN_CHECK,
  passed: false,
  points: 0,
  maxPoints: 0,
  kind: 'fallback',
  detail: 'behavioural run failed: browser has been closed',
}

const CHROMIUM: SandboxPolicy = { backend: 'chromium', enforcement: 'partial', preludeParity: false }
const STRUCTURAL: SandboxPolicy = { backend: 'structural', enforcement: 'partial', preludeParity: false }

/** A breakdown that the browser ran: one real check that passed. */
const ran = (score: number) => ({
  score,
  checks: [{ name: 'nbody-renders', passed: true, points: 35, maxPoints: 35 } as IterationCheckResult],
})
/** A breakdown the browser could not run: the structural score and the fallback row. */
const fellBack = () => ({ score: 30, checks: [FALLBACK] })

/** A backend whose only observable is how often the shared browser was dropped. */
function countingBackend(closeError?: Error): { backend: SandboxBackend; closes: () => number } {
  let closes = 0
  const backend: SandboxBackend = {
    name: 'chromium',
    enforcement: 'partial',
    launch: async () => {
      throw new Error('the scoring fns in these tests never launch a browser')
    },
    close: async () => {
      closes++
      if (closeError) throw closeError
    },
  }
  return { backend, closes: () => closes }
}

afterEach(() => resetSandboxRuntime())

describe('browser fallback on the chromium backend', () => {
  it('rescores once on a fresh browser and publishes the browser score, not the structural one', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return calls === 1 ? fellBack() : ran(100)
      },
      ['artifact'],
      TASK
    )
    expect(out).toEqual([ran(100)])
    expect(calls).toBe(2)
    expect(closes()).toBe(1)
  })

  it('stops the sweep with BrowserFallbackError when the fresh browser falls back as well', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const attempt = scoreBreakdownsOrStop(() => fellBack(), ['artifact'], TASK)
    await expect(attempt).rejects.toThrow(BrowserFallbackError)
    await expect(attempt).rejects.toThrow(/fell back to structure on a fresh browser as well/)
    await expect(attempt).rejects.toThrow(/wrote no record/)
    expect(closes()).toBe(1)
  })

  it('rescores only the artifacts that fell back, and keeps the others as they were', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const seen: string[] = []
    const out = await scoreBreakdownsOrStop(
      (output) => {
        seen.push(output)
        if (output === 'b' && seen.filter((s) => s === 'b').length === 1) return fellBack()
        return ran(output === 'a' ? 90 : 95)
      },
      ['a', 'b'],
      TASK
    )
    expect(out).toEqual([ran(90), ran(95)])
    expect(seen).toEqual(['a', 'b', 'b'])
  })

  it('returns a fallback that is not a browser failure (no checks defined) without retrying', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const noChecks = {
      score: 40,
      checks: [{ name: BEHAVIOURAL_RUN_CHECK, passed: false, points: 0, maxPoints: 0, kind: 'fallback', detail: 'no behavioural checks defined for task' } as IterationCheckResult],
    }
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return noChecks
      },
      ['artifact'],
      TASK
    )
    expect(out).toEqual([noChecks])
    expect(calls).toBe(1)
    expect(closes()).toBe(0)
  })

  it('makes one call per artifact and drops no browser when every artifact runs', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return ran(80)
      },
      ['a', 'b', 'c'],
      TASK
    )
    expect(out).toHaveLength(3)
    expect(calls).toBe(3)
    expect(closes()).toBe(0)
  })
})

describe('the structural backend keeps its fallback by design', () => {
  it('returns the fallback row without a retry, a browser drop or an error', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, STRUCTURAL)
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return fellBack()
      },
      ['artifact'],
      TASK
    )
    expect(out).toEqual([fellBack()])
    expect(calls).toBe(1)
    expect(closes()).toBe(0)
  })
})

describe('discardSandboxBrowser', () => {
  it('closes the shared browser and keeps the backend installed for the next launch', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    await discardSandboxBrowser()
    expect(closes()).toBe(1)
    expect(getSandboxBackend()).toBe(backend)
  })

  it('does nothing when no browser was ever launched', async () => {
    await expect(discardSandboxBrowser()).resolves.toBeUndefined()
  })

  it('never throws when the close itself fails, because the browser may already be dead', async () => {
    const { backend, closes } = countingBackend(new Error('browser has been closed'))
    setSandboxBackend(backend, CHROMIUM)
    await expect(discardSandboxBrowser()).resolves.toBeUndefined()
    expect(closes()).toBe(1)
  })
})

describe('artifacts are scored one page at a time', () => {
  it('never runs two breakdowns at once, even when two pairs score concurrently', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    let inFlight = 0
    let maxInFlight = 0
    const slow = async (output: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return ran(output === 'x' ? 70 : 80)
    }
    const [first, second] = await Promise.all([
      scoreBreakdownsOrStop(slow, ['x', 'x', 'x'], TASK),
      scoreBreakdownsOrStop(slow, ['y', 'y', 'y'], TASK),
    ])
    expect(maxInFlight).toBe(1)
    expect(first.map((b) => b.score)).toEqual([70, 70, 70])
    expect(second.map((b) => b.score)).toEqual([80, 80, 80])
  })

  it('a failed scoring call does not wedge the queue for later calls', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    await expect(
      withScoringLock(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(withScoringLock(async () => 'next')).resolves.toBe('next')
  })

  it('rescores an artifact whose check timed out, once, on the idle browser', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const timedOut = {
      score: 30,
      checks: [{ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35, detail: 'threw: check timeout after 6000ms' } as IterationCheckResult],
    }
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return calls === 1 ? timedOut : ran(100)
      },
      ['artifact'],
      TASK
    )
    expect(out).toEqual([ran(100)])
    expect(calls).toBe(2)
    expect(closes()).toBe(0)
  })

  it('a timeout that persists on the rescore stops the sweep with no record, not a 30 published as a score', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const timedOut = {
      score: 30,
      checks: [{ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35, detail: 'threw: check timeout after 6000ms' } as IterationCheckResult],
    }
    let calls = 0
    const waits: number[] = []
    const attempt = scoreBreakdownsOrStop(
      () => {
        calls++
        return timedOut
      },
      ['artifact'],
      TASK,
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
      }
    )
    await expect(attempt).rejects.toThrow(BrowserFallbackError)
    await expect(attempt).rejects.toThrow(/did not finish after two rescores/)
    // First attempt, rescore, then one more rescore after the first probe backoff.
    expect(calls).toBe(3)
    expect(waits).toEqual([2_000, 15_000])
    expect(closes()).toBe(1)
  })
})

describe('a timeout that survives the rescore is a machine fault, not the artifact', () => {
  const TIMED_OUT = {
    score: 30,
    checks: [{ name: 'lighthouse-rotation', passed: false, points: 0, maxPoints: 35, detail: 'check timeout after 6000ms' } as IterationCheckResult],
  }
  const PASS: ProbeOutcome = { ok: true, failing: [] }

  it('probes the browser, rescores once more, and publishes the third attempt when that one finishes', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const events: ScoringEvent[] = []
    const waits: number[] = []
    let calls = 0
    let probes = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return calls <= 2 ? TIMED_OUT : ran(100)
      },
      ['artifact'],
      TASK,
      {
        iterationIndexes: [7],
        probe: async () => {
          probes++
          return PASS
        },
        sleep: async (ms) => {
          waits.push(ms)
        },
        log: (e) => events.push(e),
      }
    )
    expect(out).toEqual([ran(100)])
    expect(calls).toBe(3)
    expect(waits).toEqual([2_000, 15_000])
    expect(closes()).toBe(1)
    expect(probes).toBe(2)
    const rescores = events.filter((e): e is Extract<ScoringEvent, { type: 'rescore' }> => e.type === 'rescore')
    expect(rescores.map((e) => [e.iterationIndex, e.reason, e.waitMs])).toEqual([
      [7, 'timeout', 2_000],
      [7, 'timeout', 15_000],
    ])
    expect(events.some((e) => e.type === 'scoringProbe' && e.phase === 'rescore')).toBe(true)
  })

  it('a timeout that persists after the probe stops the sweep, and the probe runs before the last attempt', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const events: ScoringEvent[] = []
    let calls = 0
    const attempt = scoreBreakdownsOrStop(
      () => {
        calls++
        return TIMED_OUT
      },
      ['artifact'],
      TASK,
      {
        probe: async () => PASS,
        sleep: async () => {},
        log: (e) => events.push(e),
      }
    )
    await expect(attempt).rejects.toThrow(BrowserFallbackError)
    expect(calls).toBe(3)
    expect(events.filter((e) => e.type === 'scoringProbe').map((e) => (e.type === 'scoringProbe' ? e.phase : ''))).toEqual([
      'before',
      'rescore',
    ])
  })

  it('a zero-budget runtime-error row that says TimeoutError never triggers a rescore', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const events: ScoringEvent[] = []
    let calls = 0
    await scoreBreakdownsOrStop(
      () => {
        calls++
        return {
          score: 90,
          checks: [
            { name: 'no-runtime-errors', passed: false, points: 0, maxPoints: 0, detail: 'page errors: TimeoutError: signal timed out' } as IterationCheckResult,
            { name: 'nbody-renders', passed: true, points: 35, maxPoints: 35 } as IterationCheckResult,
          ],
        }
      },
      ['artifact'],
      TASK,
      { log: (e) => events.push(e), sleep: async () => {} }
    )
    expect(calls).toBe(1)
    expect(events.some((e) => e.type === 'rescore')).toBe(false)
  })
})

describe('timeout detail patterns', () => {
  it('recognises the rows a check or a batch leaves when it ran out of time', () => {
    expect(isTimeoutDetail('threw: check timeout after 6000ms')).toBe(true)
    expect(isTimeoutDetail('skipped: batch timeout')).toBe(true)
  })

  it('recognises a Playwright TimeoutError a check caught and returned as its detail', () => {
    expect(isTimeoutDetail('TimeoutError: locator.click: Timeout 5000ms exceeded.')).toBe(true)
    expect(isTimeoutDetail('page load failed: page.setContent: Timeout 10000ms exceeded.')).toBe(true)
  })

  it('recognises the horizon kit deadline and page-budget rows', () => {
    expect(isTimeoutDetail('deadline: no result within 4500 ms; page unresponsive')).toBe(true)
    expect(isTimeoutDetail('skipped: page budget of 20000 ms already spent')).toBe(true)
  })

  it('does not treat an ordinary failed check as a timeout', () => {
    expect(isTimeoutDetail('pixel diff after Space: 0.0%')).toBe(false)
    expect(isTimeoutDetail('canvas content: 3.0% (threshold 15%)')).toBe(false)
    expect(isTimeoutDetail('check bug')).toBe(false)
  })

  it('recognises the horizon kit bounded() and probe timeouts, which name the action that ran out of time', () => {
    expect(isTimeoutDetail('threw: reload timed out after 3000 ms')).toBe(true)
    expect(isTimeoutDetail('threw: key ArrowRight timed out after 1500 ms')).toBe(true)
    expect(isTimeoutDetail('threw: page.route timed out after 1500 ms')).toBe(true)
    expect(isTimeoutDetail('threw: probe timed out after 4000 ms')).toBe(true)
  })

  it('recognises the kit page-unresponsive row that follows a poisoned page', () => {
    expect(isTimeoutDetail('skipped: page unresponsive after energy (deadline, no response to a 1500 ms probe)')).toBe(true)
  })

  it('recognises the RLC check that stopped at its own deadline', () => {
    expect(isTimeoutDetail('stopped at the deadline')).toBe(true)
    expect(isTimeoutDetail('stopped at the deadline, sweep 3 of 5')).toBe(false)
  })

  it('an artifact own page error that names a timeout is not a check timeout', () => {
    expect(isTimeoutDetail('page errors: TimeoutError: signal timed out')).toBe(false)
    expect(isTimeoutDetail('page errors: Error: fetch timed out after 5 seconds')).toBe(false)
  })
})

describe('isTimeoutRow: only a scored check that ran out of time is rescored', () => {
  it('counts a scored check whose detail is a timeout', () => {
    expect(isTimeoutRow({ name: 'orbit-energy', maxPoints: 10, passed: false, detail: 'deadline: no result within 4500 ms' } as IterationCheckResult)).toBe(true)
  })

  it('ignores the fallback row and the zero-budget no-runtime-errors row, whatever their text', () => {
    expect(isTimeoutRow({ name: BEHAVIOURAL_RUN_CHECK, maxPoints: 0, passed: false, kind: 'fallback', detail: 'behavioural run failed: check timeout after 6000ms' } as IterationCheckResult)).toBe(false)
    expect(isTimeoutRow({ name: 'no-runtime-errors', maxPoints: 0, passed: false, detail: 'page errors: TimeoutError: boom' } as IterationCheckResult)).toBe(false)
  })
})

describe('the scoring semaphore and its log', () => {
  afterEach(() => {
    delete process.env.BENCH_SCORE_CONCURRENCY
  })

  it('reads BENCH_SCORE_CONCURRENCY, defaulting to 1, and refuses a value that is not a whole number of at least 1', () => {
    expect(scoreConcurrency({})).toBe(1)
    expect(scoreConcurrency({ BENCH_SCORE_CONCURRENCY: '' })).toBe(1)
    expect(scoreConcurrency({ BENCH_SCORE_CONCURRENCY: '3' })).toBe(3)
    expect(() => scoreConcurrency({ BENCH_SCORE_CONCURRENCY: '0' })).toThrow(/BENCH_SCORE_CONCURRENCY/)
    expect(() => scoreConcurrency({ BENCH_SCORE_CONCURRENCY: 'two' })).toThrow(/BENCH_SCORE_CONCURRENCY/)
    expect(() => scoreConcurrency({ BENCH_SCORE_CONCURRENCY: '1.5' })).toThrow(/BENCH_SCORE_CONCURRENCY/)
  })

  it('lets at most BENCH_SCORE_CONCURRENCY artifacts be scored at once across pairs, and no more by default', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const run = async (limit: string | undefined) => {
      if (limit === undefined) delete process.env.BENCH_SCORE_CONCURRENCY
      else process.env.BENCH_SCORE_CONCURRENCY = limit
      let inFlight = 0
      let maxInFlight = 0
      const slow = async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight--
        return ran(80)
      }
      await Promise.all([
        scoreBreakdownsOrStop(slow, ['x', 'x'], TASK),
        scoreBreakdownsOrStop(slow, ['y', 'y'], TASK),
        scoreBreakdownsOrStop(slow, ['z', 'z'], TASK),
      ])
      return maxInFlight
    }
    expect(await run(undefined)).toBe(1)
    expect(await run('2')).toBe(2)
  })

  it('logs the wait a scoring call spent queued behind another artifact', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const events: ScoringEvent[] = []
    const slow = () => new Promise<ScoredBreakdown>((resolve) => setTimeout(() => resolve(ran(80)), 60))
    await Promise.all([
      scoreBreakdownsOrStop(slow, ['a'], TASK, { log: (e) => events.push(e) }),
      scoreBreakdownsOrStop(slow, ['b'], TASK, { log: (e) => events.push(e) }),
    ])
    const waits = events.filter((e): e is Extract<ScoringEvent, { type: 'scoringWait' }> => e.type === 'scoringWait')
    expect(waits).toHaveLength(2)
    expect(waits.map((w) => w.artifacts)).toEqual([1, 1])
    expect(Math.max(...waits.map((w) => w.waitMs))).toBeGreaterThanOrEqual(40)
    expect(waits.every((w) => w.concurrency === 1)).toBe(true)
  })
})

describe('a timeout rescore is logged with both attempts', () => {
  it('waits the rescore delay, rescores once, and logs the reason with the first and second attempts', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const timedOut = {
      score: 30,
      checks: [{ name: 'lighthouse-rotation', passed: false, points: 0, maxPoints: 35, detail: 'TimeoutError: locator.click: Timeout 5000ms exceeded.' } as IterationCheckResult],
    }
    const events: ScoringEvent[] = []
    const waits: number[] = []
    let calls = 0
    const out = await scoreBreakdownsOrStop(
      () => {
        calls++
        return calls === 1 ? timedOut : ran(100)
      },
      ['artifact'],
      TASK,
      {
        iterationIndexes: [4],
        rescoreDelayMs: 2_000,
        sleep: async (ms) => {
          waits.push(ms)
        },
        log: (e) => events.push(e),
      }
    )
    expect(out).toEqual([ran(100)])
    expect(waits).toEqual([2_000])
    const rescores = events.filter((e) => e.type === 'rescore')
    expect(rescores).toEqual([
      {
        type: 'rescore',
        iterationIndex: 4,
        reason: 'timeout',
        waitMs: 2_000,
        first: { score: 30, failing: ['lighthouse-rotation: TimeoutError: locator.click: Timeout 5000ms exceeded.'] },
        second: { score: 100, failing: [] },
      },
    ])
  })

  it('waits RESCORE_DELAY_MS (2 s) before a rescore when no delay is given', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const waits: number[] = []
    let calls = 0
    await scoreBreakdownsOrStop(
      () => {
        calls++
        return calls === 1
          ? { score: 30, checks: [{ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35, detail: 'check timeout after 6000ms' } as IterationCheckResult] }
          : ran(100)
      },
      ['artifact'],
      TASK,
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
      }
    )
    expect(RESCORE_DELAY_MS).toBe(2_000)
    expect(waits).toEqual([RESCORE_DELAY_MS])
    expect(calls).toBe(2)
  })

  it('never rescores an ordinary failed check', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const failed = {
      score: 40,
      checks: [{ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35, detail: 'canvas content: 3.0% (threshold 15%)' } as IterationCheckResult],
    }
    const events: ScoringEvent[] = []
    let calls = 0
    await scoreBreakdownsOrStop(
      () => {
        calls++
        return failed
      },
      ['artifact'],
      TASK,
      { log: (e) => events.push(e), sleep: async () => {} }
    )
    expect(calls).toBe(1)
    expect(events.some((e) => e.type === 'rescore')).toBe(false)
  })
})

describe('the known-good probe guards a pair of browser renders', () => {
  const PASS: ProbeOutcome = { ok: true, failing: [] }
  const FAIL: ProbeOutcome = { ok: false, failing: ['probe-animates: no change'] }

  it('runs the probe before the artifacts and again after a failed row, and then passes', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const events: ScoringEvent[] = []
    let probes = 0
    const failingRow = { score: 60, checks: [{ name: 'nbody-renders', passed: false, points: 0, maxPoints: 35, detail: 'canvas content: 3.0%' } as IterationCheckResult] }
    await scoreBreakdownsOrStop(() => failingRow, ['artifact'], TASK, {
      probe: async () => {
        probes++
        return PASS
      },
      log: (e) => events.push(e),
    })
    expect(probes).toBe(2)
    expect(events.filter((e) => e.type === 'scoringProbe').map((e) => (e.type === 'scoringProbe' ? e.phase : ''))).toEqual(['before', 'after'])
  })

  it('waits with growing delays and stops the sweep when the probe keeps failing', async () => {
    const { backend, closes } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const waits: number[] = []
    const attempt = scoreBreakdownsOrStop(() => ran(90), ['artifact'], TASK, {
      probe: async () => FAIL,
      probeBackoffMs: [15, 45],
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await expect(attempt).rejects.toThrow(BrowserFallbackError)
    await expect(attempt).rejects.toThrow(/wrote no record/)
    expect(waits).toEqual([15, 45])
    expect(closes()).toBe(2)
  })

  it('stops at once when the probe cannot start a browser, because waiting cannot fix an installation', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    let probes = 0
    const waits: number[] = []
    const attempt = scoreBreakdownsOrStop(() => ran(90), ['artifact'], TASK, {
      probe: async () => {
        probes++
        return { ok: false, failing: ['probe threw: browserType.launch: Executable doesn\'t exist'], fatal: true }
      },
      probeBackoffMs: [15, 45],
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await expect(attempt).rejects.toThrow(/could not start a browser/)
    expect(probes).toBe(1)
    expect(waits).toEqual([])
  })

  it('does not probe at all when no probe is given (structural scoring, and unit tests)', async () => {
    const { backend } = countingBackend()
    setSandboxBackend(backend, CHROMIUM)
    const out = await scoreBreakdownsOrStop(() => ran(90), ['artifact'], TASK)
    expect(out).toEqual([ran(90)])
  })
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('three copies of a browser artifact score the same one at a time as alone', () => {
  // A canvas that repaints several thousand shapes every frame. This fixture is
  // NOT known to miss a per-check timer under load: the lock's ordering is pinned
  // by the unit tests above, and this test pins only that three copies scored
  // through the lock give the same outcomes as one copy scored alone.
  const HEAVY = `<!doctype html><html><body style="margin:0"><canvas id="c" width="1024" height="720"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');let t=0;
function frame(){t++;g.fillStyle='#001';g.fillRect(0,0,1024,720);
for(let i=0;i<4000;i++){g.fillStyle='hsl('+((i*37+t)%360)+',80%,55%)';g.fillRect((i*73+t*3)%1024,(i*41+t*2)%720,6,6)}
requestAnimationFrame(frame)}
frame();
</script></body></html>`

  it('gives every copy the same check outcomes whether scored three at once through the lock or alone', async () => {
    const { scoreWithBreakdown } = await import('./behavioral')
    const nbody = (await import('../registry')).BENCHMARK_TASKS.find((t) => t.id === 'n-body-field')!
    const breakdown = (output: string, t: BenchmarkTask) => scoreWithBreakdown(output, t)
    const outcomes = (scored: ScoredBreakdown[]) =>
      scored.map((b) => ({ score: b.score, checks: b.checks.map((c) => [c.name, c.passed]) }))
    try {
      const alone: ScoredBreakdown[] = []
      for (let i = 0; i < 3; i++) alone.push(...(await scoreBreakdownsOrStop(breakdown, [HEAVY], nbody)))
      const together = await Promise.all(
        [0, 1, 2].map(() => scoreBreakdownsOrStop(breakdown, [HEAVY], nbody))
      )
      for (const one of together) {
        expect(outcomes(one)).toEqual(outcomes(alone.slice(0, 1)))
      }
    } finally {
      await closeSandbox()
    }
  }, 240_000)
})
