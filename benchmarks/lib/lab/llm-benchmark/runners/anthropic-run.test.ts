/**
 * The Anthropic runner through the whole harness: `createProviderRunner.runTask`
 * against a local server speaking the real SDK's wire format. These tests cover
 * what the runner-level contract promises and the classifier-level tests cannot
 * see: how many requests a failure makes, what the record says it cost, and
 * whether the budget cap trips on a call that was billed but not usable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BenchmarkModel, BenchmarkTask, Scorer } from '../types'
import { cacheModelKey, createProviderRunner } from './provider'
import { costFromUsage, summarizeUsage } from '../billing'

// The cache is not what these tests exercise, and a replayed response would
// hide the request count. bustCache keeps every call live and writes nothing.
const TASK: BenchmarkTask = {
  id: 'equation-solver',
  category: 'advanced-mathematics',
  title: 'Equation Solver',
  blurb: '',
  prompt: 'Solve x^2 = 4.',
  runtimeHint: '',
  iterationsDefault: 2,
  methodNotes: '',
  demoComponentName: 'EquationSolver',
  slug: 'equation-solver',
} as BenchmarkTask

// Prices in $ per 1k tokens: a $0.002 input and a $0.01 output rate.
const MODEL: BenchmarkModel = {
  id: 'claude-run-test',
  name: 'Claude Run Test',
  provider: 'Anthropic',
  costPer1kInputUsd: 0.002,
  costPer1kOutputUsd: 0.01,
  contextWindow: 1_000_000,
  capabilities: '',
}

const TEST_KEY = 'sk-ant-api-test-run-5d1e7b'
const ANSWER = 'The roots are x = 2 and x = -2, because both squares equal four.'
const scorer: Scorer = { score: async () => 50 } as unknown as Scorer

const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function silence(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

async function startServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse, n: number) => void
): Promise<{ base: string; requests: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      count++
      handler(req, body, res, count)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, requests: () => count }
}

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A complete stream for ANSWER, with the given usage and stop reason. */
function completeStream(opts: { input: number; output: number; stopReason?: string; text?: string }): string {
  return (
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_run',
        type: 'message',
        role: 'assistant',
        model: 'claude-run-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts.input, output_tokens: 1 },
      },
    }) +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text ?? ANSWER } }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: opts.stopReason ?? 'end_turn', stop_sequence: null, stop_details: null },
      usage: { output_tokens: opts.output },
    }) +
    frame('message_stop', { type: 'message_stop' })
  )
}

describe('Anthropic runner through runTask', () => {
  it('retries a 500 and stops after 1 + maxRetries requests, recording the failure', async () => {
    silence()
    const server = await startServer((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }))
    })
    const runner = createProviderRunner({
      anthropic: { apiKey: TEST_KEY, baseUrl: server.base, timeoutMs: 5_000 },
      maxRetries: 1,
      bustCache: true,
      scorer,
    })
    const [result] = await runner.runTask(MODEL, TASK, 1)
    expect(server.requests()).toBe(2)
    expect(result.status).toBe('fail')
    expect(result.failureReason).toBe('model_error')
    expect(result.telemetry?.retries).toBe(1)
    // The recorded failure text names the status and never the key.
    expect(result.output).toMatch(/Anthropic error 500: boom/)
    expect(result.output).not.toContain(TEST_KEY)
  })

  it('records a refusal with its tokens and cost, and trips the budget cap on it', async () => {
    silence()
    const server = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeStream({ input: 1000, output: 64_000, stopReason: 'refusal', text: '' }))
    })
    const runner = createProviderRunner({
      anthropic: { apiKey: TEST_KEY, baseUrl: server.base, timeoutMs: 5_000 },
      maxRetries: 2,
      bustCache: true,
      budgetMaxUsd: 0.001,
      scorer,
    })
    const [result] = await runner.runTask(MODEL, TASK, 2)
    // A refusal is not retried, and the budget stops the second iteration.
    expect(server.requests()).toBe(1)
    expect(result.status).toBe('fail')
    expect(result.failureReason).toBe('model_error')
    expect(result.tokensIn).toBe(1000)
    expect(result.tokensOut).toBe(64_000)
    expect(result.usage?.source).toBe('reported')
    const expected = costFromUsage(summarizeUsage([{ tokensIn: 1000, tokensOut: 64_000, usageSource: 'reported' }]), MODEL)
    expect(result.costUsd).toBeCloseTo(expected, 10)
    expect(result.costUsd).toBeGreaterThan(0.001)
    expect(result.budgetExceeded).toBeDefined()
    expect(result.budgetExceeded?.capUsd).toBe(0.001)
  })

  it('records a stop at max_tokens as truncated, with its tokens and cost, and trips the budget on it', async () => {
    silence()
    const server = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeStream({ input: 500, output: 8_000, stopReason: 'max_tokens' }))
    })
    const runner = createProviderRunner({
      anthropic: { apiKey: TEST_KEY, baseUrl: server.base, timeoutMs: 5_000 },
      maxRetries: 2,
      bustCache: true,
      budgetMaxUsd: 0.001,
      scorer,
    })
    const [result] = await runner.runTask(MODEL, TASK, 2)
    expect(server.requests()).toBe(1)
    expect(result.failureReason).toBe('truncated')
    expect(result.tokensIn).toBe(500)
    expect(result.tokensOut).toBe(8_000)
    expect(result.costUsd).toBeGreaterThan(0.001)
    expect(result.budgetExceeded?.capUsd).toBe(0.001)
  })

  it('retries a stream dropped mid-answer and succeeds on the next attempt', async () => {
    silence()
    const server = await startServer((_req, _body, res, n) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (n === 1) {
        res.write(frame('message_start', { type: 'message_start', message: { id: 'msg_drop', type: 'message', role: 'assistant', model: 'claude-run-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }))
        res.write(frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
        res.write(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half of the' } }))
        setTimeout(() => res.socket?.destroy(), 20)
        return
      }
      res.end(completeStream({ input: 12, output: 30 }))
    })
    const runner = createProviderRunner({
      anthropic: { apiKey: TEST_KEY, baseUrl: server.base, timeoutMs: 5_000 },
      maxRetries: 1,
      bustCache: true,
      scorer,
    })
    const started = Date.now()
    const [result] = await runner.runTask(MODEL, TASK, 1)
    const elapsedMs = Date.now() - started
    expect(server.requests()).toBe(2)
    expect(result.status).toBe('success')
    expect(result.iterationsSucceeded).toBe(1)
    expect(result.telemetry?.retries).toBe(1)
    // The dropped attempt was billed, so the record carries it too: its input
    // (10, from message_start) is added to the answer's 12, and its output is an
    // estimate of the 'half of the' text (about 4 tokens) or the time it ran at
    // 150 tokens a second, whichever is larger. The time term is wall-clock, and a
    // loaded machine can stretch the 20 ms between the delta and the drop, so the
    // upper bound is the whole run's time at that rate, not a fixed count. The
    // totals are mixed: the answer's counts are reported, the dropped attempt's are
    // estimated.
    expect(result.tokensIn).toBe(22)
    const droppedOutput = result.tokensOut - 30
    expect(droppedOutput).toBeGreaterThanOrEqual(4)
    expect(droppedOutput).toBeLessThanOrEqual(Math.ceil((elapsedMs / 1000) * 150) + 1)
    expect(result.usage?.source).toBe('mixed')
  })

  it('records a live stream cut off at the cap with the usage it produced, and makes one request', async () => {
    silence()
    const server = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(frame('message_start', { type: 'message_start', message: { id: 'msg_cap', type: 'message', role: 'assistant', model: 'claude-run-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 77, output_tokens: 1 } } }))
      res.write(frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a'.repeat(300) } }))
      // The stream stays open and never finishes.
    })
    const runner = createProviderRunner({
      anthropic: { apiKey: TEST_KEY, baseUrl: server.base },
      timeoutMs: 250,
      maxRetries: 2,
      bustCache: true,
      scorer,
    })
    const [result] = await runner.runTask(MODEL, TASK, 2)
    // Not a transient timeout: the request is not retried, and the second iteration is skipped.
    expect(server.requests()).toBe(1)
    expect(result.status).toBe('fail')
    expect(result.failureReason).toBe('model_error')
    expect(result.failureReason).not.toBe('endpoint_hung')
    expect(result.tokensIn).toBe(77)
    expect(result.tokensOut).toBeGreaterThan(0)
    expect(result.usage?.source).toBe('estimated')
    expect(result.costUsd).toBeGreaterThan(0)
  })
})

describe('the response cache is keyed on the request an Anthropic entry sends', () => {
  it('keeps two effort variants of one base model apart', () => {
    const low = { ...MODEL, id: 'claude-x-low', apiModelId: 'claude-x', reasoningEffort: 'low' as const }
    const high = { ...MODEL, id: 'claude-x-high', apiModelId: 'claude-x', reasoningEffort: 'high' as const }
    expect(cacheModelKey(low)).not.toBe(cacheModelKey(high))
  })

  it('changes the key when a pinned effort or thinking mode changes under the same id', () => {
    const before = { ...MODEL, id: 'claude-x', apiModelId: 'claude-x', reasoningEffort: 'low' as const }
    const after = { ...before, reasoningEffort: 'high' as const }
    const thinking = { ...before, thinking: 'adaptive' as const }
    expect(cacheModelKey(before)).not.toBe(cacheModelKey(after))
    expect(cacheModelKey(before)).not.toBe(cacheModelKey(thinking))
  })

  it('leaves non-Anthropic keys as the bare registry id, so existing cache entries stay reachable', () => {
    expect(cacheModelKey({ ...MODEL, provider: 'Moonshot AI', id: 'kimi-x' })).toBe('kimi-x')
  })
})
