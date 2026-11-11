import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BenchmarkModel, BenchmarkTask } from '../types'
import { BENCHMARK_MODELS, BENCHMARK_TASKS } from '../registry'
import { costFromUsage, summarizeUsage } from '../billing'
import { verifyResults } from '../verify-results'
import { generateAnthropic } from './anthropic'
import { BilledGenerationError } from './billed'
import { createProviderRunner } from './provider'

// Only the network call is replaced. The runner, its retry loop, its billing
// and its clocks are the real ones.
vi.mock('./anthropic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./anthropic')>()),
  generateAnthropic: vi.fn(),
}))

const MODEL = BENCHMARK_MODELS.find((m) => m.id === 'claude-fable-5-2') as BenchmarkModel
const TASK = BENCHMARK_TASKS.find((t) => t.id === 'equation-solver') as BenchmarkTask
const ANSWER = 'x^2 = 4, so x = 2 or x = -2. The two roots are both exact.'

beforeEach(() => {
  vi.mocked(generateAnthropic).mockReset()
})

describe('a retried billed attempt is part of the record', () => {
  it('records the cost the budget counted, for the two-attempt scenario from the gate', async () => {
    // Attempt 1 drops mid-stream after billed output; attempt 2 is refused.
    const dropped = new BilledGenerationError(
      'Anthropic request failed: fetch failed (stream interrupted: ECONNRESET)',
      { tokensIn: 1200, tokensOut: 3000, usageSource: 'estimated', runtimeMs: 900 }
    )
    const refused = new BilledGenerationError('Anthropic refused the request (stop_reason refusal, category unspecified)', {
      tokensIn: 1200,
      tokensOut: 40,
      usageSource: 'reported',
      runtimeMs: 300,
    })
    vi.mocked(generateAnthropic).mockRejectedValueOnce(dropped).mockRejectedValueOnce(refused)

    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real' },
      maxRetries: 1,
      bustCache: true,
      timeoutMs: 60_000,
      budgetMaxUsd: 0.01,
    })
    const [record] = await runner.runTask(MODEL, TASK, 1)

    const billed = [dropped.billed, refused.billed]
    const expectedUsd = costFromUsage(summarizeUsage(billed), MODEL)
    expect(expectedUsd).toBeGreaterThan(0.01)
    // Before the fix this was 0, and the verifier rejected the record.
    expect(record.costUsd).toBeCloseTo(expectedUsd, 9)
    expect(record.tokensIn).toBe(2400)
    expect(record.tokensOut).toBe(3040)
    // The budget stamp reads the same money the record carries.
    expect(record.budgetExceeded).toBeDefined()
    expect(record.budgetExceeded!.spentUsd).toBeCloseTo(record.costUsd, 9)
    expect(record.usage?.source).toBe('mixed')
    const budgetFails = verifyResults([record]).filter((v) => v.check === 'budget-sanity' && v.level === 'fail')
    expect(budgetFails).toEqual([])
  })

  it('adds a retried attempt to a successful answer, marked with its own provenance', async () => {
    const dropped = new BilledGenerationError('Anthropic request failed: fetch failed (stream interrupted: ECONNRESET)', {
      tokensIn: 500,
      tokensOut: 3000,
      usageSource: 'estimated',
      runtimeMs: 900,
    })
    vi.mocked(generateAnthropic).mockRejectedValueOnce(dropped).mockResolvedValueOnce({
      output: ANSWER,
      tokensIn: 500,
      tokensOut: 200,
      usageSource: 'reported',
      runtimeMs: 400,
    })

    const runner = createProviderRunner({ anthropic: { apiKey: 'test-key-not-real' }, maxRetries: 1, bustCache: true, timeoutMs: 60_000 })
    const [record] = await runner.runTask(MODEL, TASK, 1)

    expect(record.status).toBe('success')
    expect(record.tokensIn).toBe(1000)
    expect(record.tokensOut).toBe(3200)
    expect(record.costUsd).toBeCloseTo(costFromUsage(summarizeUsage([dropped.billed, { tokensIn: 500, tokensOut: 200, usageSource: 'reported' }]), MODEL), 9)
    expect(record.usage?.source).toBe('mixed')
  })
})

describe('the outer clock around an Anthropic call sits above the runner’s own cap', () => {
  it('lets the runner decide the cut-off: the outer clock fires 5 s after the runner cap, not at it', async () => {
    // A call the runner never sees finish: the runner's own cap is 200 ms, so the
    // outer clock, set 5 s above it, is the one that would fire in the old code.
    vi.mocked(generateAnthropic).mockReturnValue(new Promise(() => {}))
    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real', timeoutMs: 200 },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 200,
    })
    const [record] = await runner.runTask(MODEL, TASK, 1)
    expect(record.status).toBe('timeout')
    expect(record.output).toMatch(/Timeout after 5200ms/)
  }, 15_000)
})

describe('the per-model budget cap stops every running pair of that model', () => {
  it('stops two concurrent pairs of one model, not only the pair that crossed the cap', async () => {
    const reply = {
      output: ANSWER,
      tokensIn: 1000,
      tokensOut: 1000,
      usageSource: 'reported' as const,
      runtimeMs: 100,
    }
    const perCallUsd = costFromUsage(summarizeUsage([reply]), MODEL)
    const cap = perCallUsd * 1.5
    vi.mocked(generateAnthropic).mockResolvedValue(reply)

    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real' },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 60_000,
      budgetMaxUsd: cap,
    })
    // Two pairs of one model on the same text task: no browser, and no run log to collide on.
    const [first, second] = await Promise.all([runner.runTask(MODEL, TASK, 5), runner.runTask(MODEL, TASK, 5)])

    // Before the fix only the pair that crossed the cap stopped, and the other ran
    // all five iterations. Each pair now stops at its own boundary: at most one
    // iteration more than the cap allows per pair in flight.
    expect(vi.mocked(generateAnthropic).mock.calls.length).toBeLessThanOrEqual(4)
    expect(first[0]!.budgetExceeded).toBeDefined()
    expect(second[0]!.budgetExceeded).toBeDefined()
    expect(first[0]!.iterationsSucceeded).toBeLessThan(5)
    expect(second[0]!.iterationsSucceeded).toBeLessThan(5)
  })
})

describe("the runner's own cut-off decides, not the outer clock", () => {
  it('keeps the billed cut-off when the runner fires just after its cap, because the outer clock sits 5 s above it', async () => {
    const cutOff = new BilledGenerationError('Anthropic stream stopped at the 200ms cap while still generating; the answer is incomplete', {
      tokensIn: 1000,
      tokensOut: 4000,
      usageSource: 'estimated',
      runtimeMs: 300,
    })
    // The runner's cap is 200 ms; its cut-off arrives at 300 ms, after the cap.
    vi.mocked(generateAnthropic).mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(cutOff), 300))
    )
    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real', timeoutMs: 200 },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 200,
    })
    const [record] = await runner.runTask(MODEL, TASK, 1)
    // Had the outer clock been the same 200 ms, it would have won as a transient
    // timeout with no usage, and the record would cost $0.
    expect(record.costUsd).toBeGreaterThan(0)
    expect(record.tokensOut).toBe(4000)
  }, 20_000)
})
