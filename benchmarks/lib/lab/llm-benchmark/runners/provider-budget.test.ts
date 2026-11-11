import { describe, it, expect, vi, beforeEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import type { BenchmarkModel, BenchmarkTask } from '../types'
import { BENCHMARK_MODELS, BENCHMARK_TASKS } from '../registry'
import { costFromUsage, summarizeUsage } from '../billing'
import { verifyResults } from '../verify-results'
import { generateAnthropic, type AnthropicClientLike, type AnthropicStreamLike } from './anthropic'
import { createProviderRunner } from './provider'

// Only the network call is replaced. The runner, its retry loop, its billing and
// its budget are the real ones. Where a test needs the real Anthropic runner's
// own cut-off logic, it runs that logic against a fake SDK client.
vi.mock('./anthropic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./anthropic')>()),
  generateAnthropic: vi.fn(),
}))

const MODEL = BENCHMARK_MODELS.find((m) => m.id === 'claude-fable-5-2') as BenchmarkModel
const TASK = BENCHMARK_TASKS.find((t) => t.id === 'equation-solver') as BenchmarkTask
const ANSWER = 'x^2 = 4, so x = 2 or x = -2. The two roots are both exact.'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  vi.mocked(generateAnthropic).mockReset()
})

describe('a retry waits the time the provider advised, through the runner', () => {
  it('waits at least the advised retry-after before the second attempt of a 429', async () => {
    // The harness's own rate-limit backoff is 4 s; the provider advises 4.5 s, so the
    // advice is what the wait must reflect.
    const limited = Object.assign(new Error('Anthropic error 429: slow down'), { retryAfterMs: 4_500 })
    const reply = { output: ANSWER, tokensIn: 100, tokensOut: 50, usageSource: 'reported' as const, runtimeMs: 10 }
    const starts: number[] = []
    vi.mocked(generateAnthropic).mockImplementation(async () => {
      starts.push(Date.now())
      if (starts.length === 1) throw limited
      return reply
    })

    const runner = createProviderRunner({ anthropic: { apiKey: 'test-key-not-real' }, maxRetries: 1, bustCache: true, timeoutMs: 60_000 })
    const [record] = await runner.runTask(MODEL, TASK, 1)

    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(4_500)
    expect(record!.status).toBe('success')
    expect(record!.telemetry?.retries).toBe(1)
  }, 30_000)
})

describe('a call cut off inside a thinking block stops the model budget', () => {
  it('bills the generated time through the real runner and trips the per-model cap', async () => {
    // The real Anthropic runner runs against a fake SDK client: a thinking block
    // opens, then the stream generates until the runner's own 300 ms cap cuts it.
    const realGenerate = (await vi.importActual<typeof import('./anthropic')>('./anthropic')).generateAnthropic
    vi.mocked(generateAnthropic).mockImplementation((config, model, task) =>
      realGenerate(config, model, task, { client: thinkingCutOffClient(1_000) })
    )
    const cap = 0.000001
    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real', timeoutMs: 300 },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 300,
      budgetMaxUsd: cap,
    })
    const [record] = await runner.runTask(MODEL, TASK, 3)

    expect(record!.costUsd).toBeGreaterThan(cap)
    expect(record!.budgetExceeded).toBeDefined()
    expect(record!.budgetExceeded!.capUsd).toBe(cap)
    expect(record!.budgetExceeded!.spentUsd).toBeCloseTo(record!.costUsd, 9)
    // The cut-off is billed, so the one call stops the sweep: no second call follows.
    expect(vi.mocked(generateAnthropic).mock.calls).toHaveLength(1)
  }, 20_000)
})

describe('a budget stamp is written only where the pair paid', () => {
  it('leaves the stamp off a pair stopped by another pair of its model when that pair billed nothing', async () => {
    const reply = { output: ANSWER, tokensIn: 1000, tokensOut: 1000, usageSource: 'reported' as const, runtimeMs: 100 }
    const perCallUsd = costFromUsage(summarizeUsage([reply]), MODEL)
    const cap = perCallUsd * 1.5
    // The second call of the two pairs fails before anything is billed; every other call answers.
    const unbilled = new Error('Anthropic error 529: overloaded')
    let calls = 0
    vi.mocked(generateAnthropic).mockImplementation(async () => {
      calls++
      if (calls === 2) {
        await sleep(100)
        throw unbilled
      }
      return reply
    })

    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real' },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 60_000,
      budgetMaxUsd: cap,
    })
    const [first, second] = await Promise.all([runner.runTask(MODEL, TASK, 2), runner.runTask(MODEL, TASK, 2)])
    const records = [first[0]!, second[0]!]

    // Exactly one pair paid for its iterations and carries the trip; the other paid
    // nothing and must not carry one. The verifier rejects a trip on a zero-cost record.
    const stamped = records.filter((r) => r.budgetExceeded !== undefined)
    const unstamped = records.filter((r) => r.budgetExceeded === undefined)
    expect(stamped).toHaveLength(1)
    expect(stamped[0]!.costUsd).toBeGreaterThan(0)
    expect(unstamped).toHaveLength(1)
    expect(unstamped[0]!.costUsd).toBe(0)
    const budgetFails = verifyResults(records).filter((v) => v.check === 'budget-sanity' && v.level === 'fail')
    expect(budgetFails).toEqual([])
  })
})

/**
 * A fake SDK client whose one stream opens a thinking block after 5 ms, then
 * generates until the caller aborts it. The usage it reports is what a provider
 * reads at message_start.
 */
function thinkingCutOffClient(inputTokens: number): AnthropicClientLike {
  return {
    messages: {
      stream(_params, options) {
        const listeners: Array<(event: Anthropic.RawMessageStreamEvent, snapshot: Anthropic.Message) => void> = []
        const snapshot = {
          id: 'msg_cut',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [] as Array<Record<string, unknown>>,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        }
        const stream: AnthropicStreamLike = {
          on(_event, listener) {
            listeners.push(listener)
            return stream
          },
          async finalMessage(): Promise<Anthropic.Message> {
            await sleep(5)
            snapshot.content.push({ type: 'thinking', thinking: '' })
            const event = { type: 'content_block_start', index: 0, content_block: snapshot.content[0] }
            for (const listener of listeners) {
              listener(event as unknown as Anthropic.RawMessageStreamEvent, snapshot as unknown as Anthropic.Message)
            }
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
            })
            throw new Error('unreachable: the stream is always aborted by the runner cap')
          },
        }
        return stream
      },
    },
  }
}

describe('a resumed sweep starts with the spend it carried in', () => {
  it('refuses a pair of a model already at its cap, so no zero-iteration record is written', async () => {
    const reply = { output: ANSWER, tokensIn: 100, tokensOut: 100, usageSource: 'reported' as const, runtimeMs: 10 }
    vi.mocked(generateAnthropic).mockResolvedValue(reply)
    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real' },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 60_000,
      budgetMaxUsd: 5,
      carriedSpendUsd: { [MODEL.id]: 5 },
    })
    await expect(runner.runTask(MODEL, TASK, 2)).rejects.toThrow(/stopped for the rest of this run by its budget cap/)
    expect(vi.mocked(generateAnthropic)).not.toHaveBeenCalled()
  })

  it('counts the carried spend against the cap, so the pair stops once the total reaches it', async () => {
    const reply = { output: ANSWER, tokensIn: 1000, tokensOut: 1000, usageSource: 'reported' as const, runtimeMs: 10 }
    const perCallUsd = costFromUsage(summarizeUsage([reply]), MODEL)
    vi.mocked(generateAnthropic).mockResolvedValue(reply)
    const runner = createProviderRunner({
      anthropic: { apiKey: 'test-key-not-real' },
      maxRetries: 0,
      bustCache: true,
      timeoutMs: 60_000,
      budgetMaxUsd: perCallUsd * 2.5,
      carriedSpendUsd: { [MODEL.id]: perCallUsd * 1.5 },
    })
    const [record] = await runner.runTask(MODEL, TASK, 5)
    // 1.5 calls carried plus one call reaches 2.5; the next boundary stops the pair.
    expect(vi.mocked(generateAnthropic).mock.calls.length).toBeLessThanOrEqual(2)
    expect(record!.budgetExceeded).toBeDefined()
    expect(record!.budgetExceeded!.spentUsd).toBeGreaterThanOrEqual(perCallUsd * 2.5)
  })
})
