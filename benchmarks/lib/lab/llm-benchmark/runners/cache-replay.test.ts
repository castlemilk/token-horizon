import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BenchmarkModel, BenchmarkTask } from '../types'
import { BENCHMARK_MODELS, BENCHMARK_TASKS } from '../registry'
import { verifyResults } from '../verify-results'
import { generateAnthropic } from './anthropic'
import { createProviderRunner } from './provider'

// The network call is replaced; the cache is an in-memory stand-in, so this test
// never writes the real .cache/llm-benchmark-responses.json.
vi.mock('./anthropic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./anthropic')>()),
  generateAnthropic: vi.fn(),
}))

const store = new Map<string, unknown>()
vi.mock('../cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cache')>()
  return {
    ...actual,
    getCachedResponse: (modelId: string, taskId: string, prompt: string, iterationIndex: number) =>
      store.get(actual.buildCacheKey(modelId, taskId, prompt, iterationIndex)) as ReturnType<typeof actual.getCachedResponse>,
    setCachedResponse: (
      modelId: string,
      taskId: string,
      prompt: string,
      iterationIndex: number,
      response: Parameters<typeof actual.setCachedResponse>[4]
    ) => {
      store.set(actual.buildCacheKey(modelId, taskId, prompt, iterationIndex), response)
    },
    setBustCache: () => {},
    saveQueue: Promise.resolve(),
  }
})

const MODEL = BENCHMARK_MODELS.find((m) => m.id === 'claude-fable-5-2') as BenchmarkModel
const TASK = BENCHMARK_TASKS.find((t) => t.id === 'equation-solver') as BenchmarkTask
const ANSWER = 'x^2 = 4, so x = 2 or x = -2. The two roots are both exact.'

beforeEach(() => {
  store.clear()
  vi.mocked(generateAnthropic).mockReset()
})

describe('a cache replay carries the original call, and telemetry marks it as a replay', () => {
  it('keeps the original tokens, usage source and cost; counts the hit; carries no timing', async () => {
    // The first pilot call is a real one: the provider reports its usage, and the
    // response is written to the cache.
    vi.mocked(generateAnthropic).mockResolvedValue({
      output: ANSWER,
      tokensIn: 1_200,
      tokensOut: 800,
      usageSource: 'reported',
      runtimeMs: 6_000,
      ttftMs: 900,
    })
    const config = { anthropic: { apiKey: 'test-key-not-real' }, maxRetries: 0, timeoutMs: 60_000 }

    const [pilot] = await createProviderRunner(config).runTask(MODEL, TASK, 1)
    expect(pilot!.telemetry?.cacheHits).toBe(0)
    expect(pilot!.telemetry?.meanTtftMs).toBe(900)

    // A later three-iteration run reuses iteration 0 from the cache and calls the
    // provider for the other two.
    const [run] = await createProviderRunner(config).runTask(MODEL, TASK, 3)
    expect(vi.mocked(generateAnthropic).mock.calls).toHaveLength(3)

    // The replayed iteration is priced like the call that produced it: the record's
    // tokens and cost are the original call's, plus two live calls of the same size.
    const live = vi.mocked(generateAnthropic).mock.results.length
    expect(live).toBe(3)
    expect(run!.status).toBe('success')
    expect(run!.iterationsSucceeded).toBe(3)
    expect(run!.tokensIn).toBe(3 * 1_200)
    expect(run!.tokensOut).toBe(3 * 800)
    expect(run!.costUsd).toBeCloseTo(3 * pilot!.costUsd, 9)
    expect(run!.usage?.source).toBe('reported')

    // The telemetry marks exactly one iteration as a replay, and carries timing only
    // from the iterations that were generated (the two live calls, which report the
    // same TTFT as the original).
    expect(run!.telemetry?.cacheHits).toBe(1)
    expect(run!.telemetry?.meanTtftMs).toBe(900)
    expect(run!.telemetry?.rateKind).toBe('decode')

    expect(verifyResults([pilot!, run!]).filter((v) => v.level === 'fail')).toEqual([])
  }, 30_000)

  it('a replay-only run counts every iteration as a hit and reports no measured timing', async () => {
    vi.mocked(generateAnthropic).mockResolvedValue({
      output: ANSWER,
      tokensIn: 500,
      tokensOut: 300,
      usageSource: 'reported',
      runtimeMs: 2_000,
      ttftMs: 400,
    })
    const config = { anthropic: { apiKey: 'test-key-not-real' }, maxRetries: 0, timeoutMs: 60_000 }
    await createProviderRunner(config).runTask(MODEL, TASK, 2)
    vi.mocked(generateAnthropic).mockClear()

    const [replay] = await createProviderRunner(config).runTask(MODEL, TASK, 2)
    expect(vi.mocked(generateAnthropic)).not.toHaveBeenCalled()
    expect(replay!.telemetry?.cacheHits).toBe(2)
    expect(replay!.telemetry?.meanTtftMs).toBeUndefined()
    expect(replay!.telemetry?.meanTokensPerSec).toBeUndefined()
    expect(replay!.telemetry?.rateKind).toBeUndefined()
    expect(replay!.costUsd).toBeGreaterThan(0)
    expect(replay!.tokensOut).toBe(2 * 300)
  })
})
