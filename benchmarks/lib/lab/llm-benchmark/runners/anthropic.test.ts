import { describe, it, expect, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import type { BenchmarkModel, BenchmarkTask } from '../types'
import {
  anthropicBaseUrl,
  buildAnthropicRequest,
  cutOffOutputTokens,
  generateAnthropic,
  type AnthropicClientLike,
  type AnthropicStreamLike,
} from './anthropic'
// The harness's own classifiers, so the assertions read the same text the
// sweep reads when it records a failure.
import { classifyFailureReason, isTransientError, retryDelayMs } from './provider'
import { BilledGenerationError, billedUsageOf } from './billed'
import { costFromUsage, summarizeUsage } from '../billing'

// A key shaped like a real one. Redaction replaces it in any message, so a
// one-letter key would also mangle ordinary message text.
const TEST_KEY = 'sk-ant-api-test-7f3a9c2e'

const TASK: BenchmarkTask = {
  id: 'equation-solver',
  category: 'advanced-mathematics',
  title: 'Equation Solver',
  blurb: '',
  prompt: 'Solve x^2 = 4.',
} as BenchmarkTask

function model(over: Partial<BenchmarkModel> & Pick<BenchmarkModel, 'id'>): BenchmarkModel {
  return {
    name: over.id,
    provider: 'Anthropic',
    costPer1kInputUsd: 0.002,
    costPer1kOutputUsd: 0.01,
    contextWindow: 1_000_000,
    capabilities: '',
    ...over,
  }
}

const DEFAULT_MODEL = model({ id: 'claude-test-default' })
const SONNET_LOW = model({
  id: 'claude-sonnet-5-5-low',
  apiModelId: 'claude-sonnet-5-5',
  baseModelId: 'claude-sonnet-5-5',
  reasoningEffort: 'low',
})
const ADAPTIVE = model({ id: 'claude-opus-4-8', thinking: 'adaptive', reasoningEffort: 'high' })
const HAIKU_4_5 = model({ id: 'claude-haiku-4-5', maxOutputTokens: 32000, contextWindow: 200_000 })

// ---------------------------------------------------------------------------
// Request shape (pure)
// ---------------------------------------------------------------------------

describe('buildAnthropicRequest', () => {
  it('builds the default request: no effort, no thinking, the 128k default cap', () => {
    expect(buildAnthropicRequest(DEFAULT_MODEL, TASK)).toEqual({
      model: 'claude-test-default',
      max_tokens: 128_000,
      system: 'Respond with only the requested artifact (code, derivation, etc.) and minimal commentary.',
      messages: [{ role: 'user', content: 'Solve x^2 = 4.' }],
    })
  })

  it('sends the base API id and output_config.effort for an effort variant, with no thinking key', () => {
    const req = buildAnthropicRequest(SONNET_LOW, TASK)
    expect(req.model).toBe('claude-sonnet-5-5')
    expect(req.output_config).toEqual({ effort: 'low' })
    expect(req).not.toHaveProperty('thinking')
  })

  it('sends thinking as adaptive, and effort inside output_config, when the registry asks', () => {
    const req = buildAnthropicRequest(ADAPTIVE, TASK)
    expect(req.thinking).toEqual({ type: 'adaptive' })
    expect(req.output_config).toEqual({ effort: 'high' })
    // Never a disabled block or a budget: those are not the adaptive contract.
    expect(JSON.stringify(req)).not.toMatch(/budget_tokens|"disabled"/)
  })

  it('sends neither effort nor thinking to claude-haiku-4-5, which accepts neither', () => {
    const req = buildAnthropicRequest(HAIKU_4_5, TASK)
    expect(req).not.toHaveProperty('output_config')
    expect(req).not.toHaveProperty('thinking')
    expect(req.model).toBe('claude-haiku-4-5')
    expect(req.max_tokens).toBe(32_000)
  })

  it('never carries a sampling parameter or a fallbacks list', () => {
    for (const m of [DEFAULT_MODEL, SONNET_LOW, ADAPTIVE, HAIKU_4_5]) {
      const json = JSON.stringify(buildAnthropicRequest(m, TASK))
      expect(json).not.toMatch(/"temperature"|"top_p"|"top_k"|"fallbacks"/)
    }
  })

  it("rejects effort 'ultra' as an invalid request, classified without a retry", () => {
    const ultra = model({ id: 'x-ultra', reasoningEffort: 'ultra' })
    let thrown: unknown
    try {
      buildAnthropicRequest(ultra, TASK)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(classifyFailureReason(thrown)).toBe('invalid_request')
    expect(isTransientError(thrown)).toBe(false)
  })
})

describe('anthropicBaseUrl', () => {
  it('strips a trailing /v1, because the SDK adds the path itself', () => {
    expect(anthropicBaseUrl('https://gateway.example.com/v1')).toBe('https://gateway.example.com')
  })

  it('strips a trailing /v1/ too', () => {
    expect(anthropicBaseUrl('https://gateway.example.com/v1/')).toBe('https://gateway.example.com')
  })

  it('leaves a base URL without /v1 alone, and defaults to the public API', () => {
    expect(anthropicBaseUrl('https://gateway.example.com')).toBe('https://gateway.example.com')
    expect(anthropicBaseUrl(undefined)).toBe('https://api.anthropic.com')
  })
})

// ---------------------------------------------------------------------------
// Fake client: streaming, usage, stop reasons and error classes
// ---------------------------------------------------------------------------

interface FakeEvent {
  /** A content_block_start for a block of this kind, emitted before the delta. */
  block?: 'text' | 'thinking'
  /** Text appended to the current block as a delta. */
  delta?: string
  afterMs?: number
}

interface FakeScript {
  events?: FakeEvent[]
  /** The final message the stream resolves with. */
  message?: Record<string, unknown>
  /** If set, finalMessage() rejects with this, after the events. */
  fail?: unknown
  /** If true, finalMessage() waits until the request signal aborts, before any event. */
  hang?: boolean
  /** If true, after the events the stream stalls until the request signal aborts. */
  hangAfterEvents?: boolean
  /** input_tokens in the message_start snapshot. */
  inputTokens?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function finalMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'x^2 = 4, so x = 2 or x = -2.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 42, output_tokens: 17 },
    ...over,
  }
}

/**
 * A stand-in for the SDK's MessageStream. It emits `streamEvent`s with an
 * accumulating snapshot, as the real stream does, so the runner's clock and
 * usage logic see the same shapes.
 */
function fakeClient(script: FakeScript) {
  const calls: Array<{ params: Record<string, unknown>; signal?: AbortSignal }> = []
  const client: AnthropicClientLike = {
    messages: {
      stream(params, options) {
        calls.push({ params: params as unknown as Record<string, unknown>, signal: options?.signal })
        type Listener = (event: Anthropic.RawMessageStreamEvent, snapshot: Anthropic.Message) => void
        const listeners: Listener[] = []
        const snapshot = {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [] as Array<Record<string, unknown>>,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: script.inputTokens ?? 42, output_tokens: 1 },
        }
        const emit = (event: Record<string, unknown>) => {
          for (const listener of listeners) {
            listener(event as unknown as Anthropic.RawMessageStreamEvent, snapshot as unknown as Anthropic.Message)
          }
        }
        const aborted = () =>
          new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
          })
        const stream: AnthropicStreamLike = {
          on(_event, listener) {
            listeners.push(listener)
            return stream
          },
          async finalMessage() {
            if (script.hang) await aborted()
            if (script.events || script.hangAfterEvents) {
              emit({ type: 'message_start', message: snapshot })
            }
            for (const event of script.events ?? []) {
              if (event.afterMs) await sleep(event.afterMs)
              if (event.block) {
                snapshot.content.push(event.block === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' })
                emit({ type: 'content_block_start', index: snapshot.content.length - 1, content_block: snapshot.content.at(-1) })
              }
              if (event.delta !== undefined) {
                if (snapshot.content.length === 0) {
                  snapshot.content.push({ type: 'text', text: '' })
                  emit({ type: 'content_block_start', index: 0, content_block: snapshot.content[0] })
                }
                const last = snapshot.content.at(-1) as Record<string, unknown>
                if (last.type === 'thinking') last.thinking = `${String(last.thinking)}${event.delta}`
                else last.text = `${String(last.text)}${event.delta}`
                emit({ type: 'content_block_delta', index: snapshot.content.length - 1, delta: { type: 'text_delta', text: event.delta } })
              }
            }
            if (script.hangAfterEvents) await aborted()
            if (script.fail !== undefined) throw script.fail
            return (script.message ?? finalMessage()) as unknown as Anthropic.Message
          },
        }
        return stream
      },
    },
  }
  return { client, calls }
}

describe('generateAnthropic with a fake client', () => {
  it('joins every text block in order and ignores thinking blocks', async () => {
    const { client } = fakeClient({
      message: finalMessage({
        content: [
          { type: 'thinking', thinking: 'let me work this out', signature: 'sig' },
          { type: 'text', text: 'Part A. ' },
          { type: 'text', text: 'Part B.' },
        ],
      }),
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res.output).toBe('Part A. Part B.')
  })

  it('stamps ttftMs at the first content block, before any visible text', async () => {
    const { client } = fakeClient({
      events: [
        { block: 'text', afterMs: 40 },
        { delta: 'Hello', afterMs: 60 },
        { delta: ' world', afterMs: 10 },
      ],
      message: finalMessage({ content: [{ type: 'text', text: 'Hello world' }] }),
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res.ttftMs).toBeGreaterThanOrEqual(40)
    // The first block arrived at ~40ms, well before the first visible delta at ~100ms.
    expect(res.ttftMs).toBeLessThan(90)
    expect(res.ttftMs).toBeLessThanOrEqual(res.runtimeMs)
  })

  it('stamps ttftMs at a leading thinking block, so thinking tokens stay on the same clock', async () => {
    const { client } = fakeClient({
      events: [
        { block: 'thinking', afterMs: 30 },
        { delta: 'reasoning', afterMs: 400 },
        { block: 'text', afterMs: 5 },
        { delta: 'Answer', afterMs: 5 },
      ],
      message: finalMessage({
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 's' },
          { type: 'text', text: 'Answer' },
        ],
      }),
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res.output).toBe('Answer')
    expect(res.ttftMs).toBeLessThan(200)
    expect(res.runtimeMs).toBeGreaterThanOrEqual(400)
  })

  it('leaves ttftMs absent when the stream produced no event at all', async () => {
    const { client } = fakeClient({
      events: [],
      message: finalMessage({ content: [{ type: 'thinking', thinking: 'only thinking', signature: 's' }] }),
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res).not.toHaveProperty('ttftMs')
    expect(res.output).toBe('')
  })

  it('maps usage straight from the provider and marks it reported', async () => {
    const { client } = fakeClient({ message: finalMessage({ usage: { input_tokens: 1234, output_tokens: 567 } }) })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res.tokensIn).toBe(1234)
    expect(res.tokensOut).toBe(567)
    expect(res.usageSource).toBe('reported')
  })

  it('passes the request params and an AbortSignal to the stream', async () => {
    const { client, calls } = fakeClient({})
    await generateAnthropic({ apiKey: TEST_KEY }, SONNET_LOW, TASK, { client })
    expect(calls).toHaveLength(1)
    expect(calls[0].params.output_config).toEqual({ effort: 'low' })
    expect(calls[0].params).not.toHaveProperty('temperature')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('throws a refusal that names the category, as a model failure that is not retried', async () => {
    const { client } = fakeClient({
      message: finalMessage({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        usage: { input_tokens: 9, output_tokens: 0 },
      }),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/refused/)
    expect((err as Error).message).toMatch(/cyber/)
    expect(classifyFailureReason(err)).toBe('model_error')
    expect(isTransientError(err)).toBe(false)
    // The refused call was billed: its usage travels on the error, not into the void.
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 9, tokensOut: 0, usageSource: 'reported' })
  })

  it('names the refusal category as unspecified when the provider states none', async () => {
    const { client } = fakeClient({ message: finalMessage({ content: [], stop_reason: 'refusal', stop_details: null }) })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/category unspecified/)
  })

  it('throws a max_tokens stop as truncated, and does not retry it', async () => {
    const { client } = fakeClient({
      message: finalMessage({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect(classifyFailureReason(err)).toBe('truncated')
    // A response that hit the cap will hit it again; each retry is paid.
    expect(isTransientError(err)).toBe(false)
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 42, tokensOut: 17, usageSource: 'reported' })
  })

  it('classifies an HTTP 429 as rate_limited, transient, in the "Anthropic error <status>" form', async () => {
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down.' } }
    const { client } = fakeClient({
      fail: new Anthropic.RateLimitError(429, body, 'Slow down.', new Headers()),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 429: Slow down.')
    expect(classifyFailureReason(err)).toBe('rate_limited')
    expect(isTransientError(err)).toBe(true)
  })

  it('classifies an HTTP 400 as invalid_request, not transient', async () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large.' } }
    const { client } = fakeClient({
      fail: new Anthropic.BadRequestError(400, body, 'max_tokens too large.', new Headers()),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 400: max_tokens too large.')
    expect(classifyFailureReason(err)).toBe('invalid_request')
    expect(isTransientError(err)).toBe(false)
  })

  it('classifies a connection failure as a network failure (endpoint_hung), transient', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const { client } = fakeClient({ fail: new Anthropic.APIConnectionError({ cause }) })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic request failed: fetch failed (ENOTFOUND)')
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
    expect(isTransientError(err)).toBe(true)
  })

  it('treats an SDK connection timeout as a timeout', async () => {
    const { client } = fakeClient({ fail: new Anthropic.APIConnectionTimeoutError() })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/timed out/)
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
    expect(isTransientError(err)).toBe(true)
  })

  it("enforces its own timeout by aborting the request, and classifies it as a timeout", async () => {
    const { client, calls } = fakeClient({ hang: true })
    const started = Date.now()
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 40 }, DEFAULT_MODEL, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((err as Error).message).toBe('Anthropic request timed out after 40ms')
    expect((err as Error).name).toBe('TimeoutError')
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
    expect(isTransientError(err)).toBe(true)
    // The abort reached the request: generation stops rather than running on.
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it("rejects effort 'ultra' before any request is made", async () => {
    const { client, calls } = fakeClient({})
    const ultra = model({ id: 'x-ultra', reasoningEffort: 'ultra' })
    await expect(generateAnthropic({ apiKey: TEST_KEY }, ultra, TASK, { client })).rejects.toThrow(/ultra/)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The real SDK against a local HTTP server: the wire, not just the seam
// ---------------------------------------------------------------------------

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function startServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void
): Promise<string> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handler(req, body, res))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

/** A Messages stream, as the API sends it, for the given text. */
function sseBody(text: string): string {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return (
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_wire',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 21, output_tokens: 1 },
      },
    }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
      usage: { output_tokens: 9 },
    }) +
    event('message_stop', { type: 'message_stop' })
  )
}

describe('generateAnthropic against a local server (real SDK)', () => {
  it('posts a streamed, sampling-free request to /v1/messages and reads the answer', async () => {
    let seen: { url?: string; headers: IncomingMessage['headers']; body?: Record<string, unknown> } = { headers: {} }
    const base = await startServer((req, body, res) => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(body) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseBody('The answer is 2.'))
    })
    // A configured /v1 must not double into /v1/v1/messages.
    const res = await generateAnthropic({ apiKey: 'test-key', baseUrl: `${base}/v1` }, SONNET_LOW, TASK)

    expect(seen.url).toBe('/v1/messages')
    // The SDK decides how the key is carried (1.7.0 sends it as a Bearer token);
    // the contract here is only that the key arrives and no beta header rides along.
    const keySent = seen.headers['x-api-key'] === 'test-key' || seen.headers.authorization === 'Bearer test-key'
    expect(keySent).toBe(true)
    expect(seen.headers['anthropic-beta']).toBeUndefined()
    expect(seen.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      stream: true,
      output_config: { effort: 'low' },
      max_tokens: 128_000,
    })
    expect(seen.body).not.toHaveProperty('temperature')
    expect(seen.body).not.toHaveProperty('top_p')
    expect(seen.body).not.toHaveProperty('top_k')
    expect(seen.body).not.toHaveProperty('fallbacks')

    expect(res.output).toBe('The answer is 2.')
    expect(res.tokensIn).toBe(21)
    expect(res.tokensOut).toBe(9)
    expect(res.usageSource).toBe('reported')
    expect(res.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('classifies an HTTP 429 from the wire as rate_limited (also proves the /v1 strip)', async () => {
    const base = await startServer((req, _body, res) => {
      // Any other path would answer 404, so a 429 here proves the path was right.
      if (req.url !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'wrong path' } }))
        return
      }
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests.' } }))
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: `${base}/v1` }, DEFAULT_MODEL, TASK).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 429: Too many requests.')
    expect(classifyFailureReason(err)).toBe('rate_limited')
    expect(isTransientError(err)).toBe(true)
  })

  it('classifies an HTTP 400 from the wire as invalid_request, not transient', async () => {
    const base = await startServer((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad effort' } }))
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, DEFAULT_MODEL, TASK).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 400: bad effort')
    expect(classifyFailureReason(err)).toBe('invalid_request')
    expect(isTransientError(err)).toBe(false)
  })

  it('times out a server that never answers, and stops the request', async () => {
    // The message alone would not prove the request was stopped: the SDK's own
    // timeout words it the same way. So the server records whether the
    // connection was closed on its side, and whether it ever ended the response.
    let closed = false
    let endedWhenClosed: boolean | undefined
    const base = await startServer((_req, _body, res) => {
      res.on('close', () => {
        closed = true
        endedWhenClosed = res.writableEnded
      })
      // Hold the request open: the runner's own clock must end it.
    })
    const started = Date.now()
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base, timeoutMs: 250 }, DEFAULT_MODEL, TASK).catch(
      (e: unknown) => e
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((err as Error).message).toBe('Anthropic request timed out after 250ms')
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
    expect(isTransientError(err)).toBe(true)
    await waitUntil(() => closed, 1_000)
    expect(closed).toBe(true)
    expect(endedWhenClosed).toBe(false)
  })

  it('classifies a refused connection as a network failure', async () => {
    // Bind a port, then release it: nothing is listening there any more.
    const probe = createNetServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const err = await generateAnthropic(
      { apiKey: TEST_KEY, baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 5_000 },
      DEFAULT_MODEL,
      TASK
    ).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/^Anthropic request failed: fetch failed/)
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
    expect(isTransientError(err)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Key safety: a malformed key never reaches a message, and a stray token never
// rides along
// ---------------------------------------------------------------------------

describe('API key safety', () => {
  it('refuses a key that cannot be sent as a header, without printing it, before any request', async () => {
    const { client, calls } = fakeClient({})
    for (const bad of [`${TEST_KEY}\nlabel line`, `${TEST_KEY}\u0000`, `${TEST_KEY} `]) {
      const err = await generateAnthropic({ apiKey: bad }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
      expect((err as Error).message).toBe(
        'Invalid request: Anthropic API key contains characters that cannot be sent in a header'
      )
      expect((err as Error).message).not.toContain('sk-ant')
      expect(classifyFailureReason(err)).toBe('invalid_request')
      expect(isTransientError(err)).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })

  it('removes the key from a provider message that echoes it', async () => {
    const body = { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${TEST_KEY}` } }
    const { client } = fakeClient({
      fail: new Anthropic.AuthenticationError(401, body, 'invalid', new Headers()),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 401: invalid x-api-key: ***')
    expect((err as Error).message).not.toContain(TEST_KEY)
    expect(classifyFailureReason(err)).toBe('auth_error')
  })

  it('keeps ambient SDK headers and the ambient token out of the request, then restores the environment', async () => {
    const saved = {
      headers: process.env.ANTHROPIC_CUSTOM_HEADERS,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
    }
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Session-Token: leaked-session-value\nanthropic-beta: some-beta-2026-01-01'
    process.env.ANTHROPIC_AUTH_TOKEN = 'leaked-auth-token'
    try {
      let seen: IncomingMessage['headers'] = {}
      const base = await startServer((req, _body, res) => {
        seen = req.headers
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sseBody('The answer is 2.'))
      })
      const res = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, DEFAULT_MODEL, TASK)
      expect(res.output).toBe('The answer is 2.')
      expect(seen['x-session-token']).toBeUndefined()
      expect(seen['anthropic-beta']).toBeUndefined()
      expect(seen.authorization === undefined || seen.authorization === `Bearer ${TEST_KEY}`).toBe(true)
      expect(seen['x-api-key'] ?? seen.authorization).toBeDefined()
      expect(JSON.stringify(seen)).not.toContain('leaked')
      // The variables are the caller's again, untouched by the benchmark call.
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        'X-Session-Token: leaked-session-value\nanthropic-beta: some-beta-2026-01-01'
      )
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('leaked-auth-token')
    } finally {
      if (saved.headers === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
      else process.env.ANTHROPIC_CUSTOM_HEADERS = saved.headers
      if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = saved.token
    }
  })
})

// ---------------------------------------------------------------------------
// Stop reasons, live-stream cut-offs and billing (fake client)
// ---------------------------------------------------------------------------

describe('stop reasons and billing', () => {
  it('accepts stop_sequence as a complete answer', async () => {
    const { client } = fakeClient({
      message: finalMessage({ stop_reason: 'stop_sequence', stop_sequence: '```' }),
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client })
    expect(res.output).toBe('x^2 = 4, so x = 2 or x = -2.')
  })

  it('refuses a pause_turn stop as a non-transient failure that carries its usage', async () => {
    const { client } = fakeClient({
      message: finalMessage({
        content: [{ type: 'text', text: 'half' }],
        stop_reason: 'pause_turn',
        usage: { input_tokens: 30, output_tokens: 12 },
      }),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/pause_turn/)
    expect(err).toBeInstanceOf(BilledGenerationError)
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 30, tokensOut: 12, usageSource: 'reported' })
    expect(isTransientError(err)).toBe(false)
  })

  it('classifies a context-window stop as truncated, not as a complete answer', async () => {
    const { client } = fakeClient({
      message: finalMessage({ stop_reason: 'model_context_window_exceeded' }),
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client }).catch((e: unknown) => e)
    expect(classifyFailureReason(err)).toBe('truncated')
    expect(isTransientError(err)).toBe(false)
    expect(billedUsageOf(err)).toBeDefined()
  })

  it('stops a live stream at the cap: bills the estimated usage and is not retried as a timeout', async () => {
    const { client } = fakeClient({
      events: [
        { block: 'text', afterMs: 5 },
        { delta: 'partial', afterMs: 5 },
      ],
      hangAfterEvents: true,
      inputTokens: 42,
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 80 }, DEFAULT_MODEL, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect((err as Error).message).toBe(
      'Anthropic stream stopped at the 80ms cap while still generating; the answer is incomplete'
    )
    expect(err).toBeInstanceOf(BilledGenerationError)
    // 'partial' is 7 characters: one token per three characters gives 3. The
    // time floor (150 tokens a second since the first block) is larger over the
    // 75 ms after the block opened, so the exact count is timing-bound; the
    // characters are a floor, and the formula is pinned by cutOffOutputTokens below.
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 42, usageSource: 'estimated' })
    expect(billedUsageOf(err)!.tokensOut).toBeGreaterThanOrEqual(3)
    expect(isTransientError(err)).toBe(false)
    expect(classifyFailureReason(err)).toBe('model_error')
  })
})

// ---------------------------------------------------------------------------
// The real SDK on the wire: streams that stall, drop or error mid-answer
// ---------------------------------------------------------------------------

function sseFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    id: 'msg_wire',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 21, output_tokens: 1 },
  },
}

async function waitUntil(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(10)
}

describe('generateAnthropic mid-stream behaviour (real SDK)', () => {
  it('stops a stream that stalls after its first tokens, at the cap, and closes the connection', async () => {
    let closed = false
    let endedWhenClosed: boolean | undefined
    const base = await startServer((_req, _body, res) => {
      res.on('close', () => {
        closed = true
        endedWhenClosed = res.writableEnded
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseFrame('message_start', MESSAGE_START))
      res.write(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer text' } }))
      // Then nothing: the stream is alive and generation never finishes.
    })
    const started = Date.now()
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base, timeoutMs: 300 }, SONNET_LOW, TASK).catch(
      (e: unknown) => e
    )
    expect(Date.now() - started).toBeLessThan(3_000)
    expect((err as Error).message).toBe(
      'Anthropic stream stopped at the 300ms cap while still generating; the answer is incomplete'
    )
    expect(err).toBeInstanceOf(BilledGenerationError)
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 21, usageSource: 'estimated' })
    expect(billedUsageOf(err)!.tokensOut).toBeGreaterThan(0)
    expect(isTransientError(err)).toBe(false)
    // Generation really stopped: the server saw the connection close, and did
    // not end the response itself.
    await waitUntil(() => closed, 1_000)
    expect(closed).toBe(true)
    expect(endedWhenClosed).toBe(false)
  })

  it('maps an error event sent inside the stream to its 5xx class, transient', async () => {
    const base = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseFrame('message_start', MESSAGE_START))
      res.end(sseFrame('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded, try again.' } }))
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, DEFAULT_MODEL, TASK).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Anthropic error 529: Overloaded, try again.')
    expect(isTransientError(err)).toBe(true)
    expect(classifyFailureReason(err)).toBe('rate_limited')
  })

  it('reports a socket dropped mid-stream as a network failure, transient', async () => {
    const base = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseFrame('message_start', MESSAGE_START))
      res.write(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, DEFAULT_MODEL, TASK).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/^Anthropic request failed: fetch failed \(stream interrupted: /)
    expect(isTransientError(err)).toBe(true)
    expect(classifyFailureReason(err)).toBe('endpoint_hung')
  })

  it('reports a stream that ends before message_stop as a network failure, transient', async () => {
    const base = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseFrame('message_start', MESSAGE_START))
      res.end(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, DEFAULT_MODEL, TASK).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/^Anthropic request failed: fetch failed \(stream interrupted: stream ended/)
    expect(isTransientError(err)).toBe(true)
  })

  it('takes the first-token clock from a thinking block that opens before any visible text', async () => {
    const base = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseFrame('message_start', MESSAGE_START))
      res.write(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }))
      res.write(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'working' } }))
      setTimeout(() => {
        res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }))
        res.write(sseFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
        res.write(sseFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }))
        res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }))
        res.write(sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 40 } }))
        res.end(sseFrame('message_stop', { type: 'message_stop' }))
      }, 400)
    })
    const res = await generateAnthropic({ apiKey: TEST_KEY, baseUrl: base }, ADAPTIVE, TASK)
    expect(res.output).toBe('Answer')
    expect(res.ttftMs).toBeDefined()
    // The clock stopped at the thinking block, not at the visible text 400ms later.
    expect(res.ttftMs!).toBeLessThan(250)
    expect(res.runtimeMs).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// Billing of a cut-off answer, and the wait a rate limit asks for
// ---------------------------------------------------------------------------

const EXPENSIVE = model({
  id: 'claude-fable-test',
  costPer1kInputUsd: 0.008,
  costPer1kOutputUsd: 0.04,
})

describe('cut-off billing: the output estimate has a time floor', () => {
  it('takes the largest of the reported count, the characters and the time floor, capped at max_tokens', () => {
    expect(cutOffOutputTokens({ reported: 1, visibleChars: 0, secondsSinceFirstBlock: 10, maxTokens: 64_000 })).toBe(1500)
    expect(cutOffOutputTokens({ reported: 1, visibleChars: 300, secondsSinceFirstBlock: 0.5, maxTokens: 64_000 })).toBe(100)
    expect(cutOffOutputTokens({ reported: 5000, visibleChars: 0, secondsSinceFirstBlock: undefined, maxTokens: 64_000 })).toBe(5000)
    expect(cutOffOutputTokens({ reported: 1000, visibleChars: 0, secondsSinceFirstBlock: 1000, maxTokens: 64_000 })).toBe(64_000)
    // No content block has started: the time term is absent, so nothing is generated yet.
    expect(cutOffOutputTokens({ reported: 1, visibleChars: 0, secondsSinceFirstBlock: undefined, maxTokens: 64_000 })).toBe(1)
  })

  it('bills a call cut off inside an empty thinking block for the time it generated, at more than a $0.004 call cost', async () => {
    // The stream opens a thinking block, which arrives empty, and then generates
    // until the runner's cap. Before the time floor this was billed as 1 token.
    const { client } = fakeClient({
      events: [{ block: 'thinking', afterMs: 5 }],
      hangAfterEvents: true,
      inputTokens: 1_000,
    })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 1_000 }, EXPENSIVE, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(BilledGenerationError)
    const usage = billedUsageOf(err)!
    expect(usage).toMatchObject({ tokensIn: 1_000, usageSource: 'estimated' })
    // About a second after the block opened, at 150 tokens a second.
    expect(usage.tokensOut).toBeGreaterThanOrEqual(120)
    expect(usage.tokensOut).toBeLessThanOrEqual(EXPENSIVE.maxOutputTokens ?? 64_000)
    // This one call costs more than a $0.004 cap. The trip itself is pinned through the
    // real runner in provider-budget.test.ts, which runs this cut-off and asserts budgetExceeded.
    const capUsd = 0.004
    expect(costFromUsage(summarizeUsage([usage]), EXPENSIVE)).toBeGreaterThan(capUsd)
  })

  it('a cut-off after message_start but before any content block is a transient timeout that bills the input read', async () => {
    // The stream sends message_start (the provider has read 1,500 input tokens) and
    // then stalls before any content block. Nothing is known to be generated, so the
    // attempt is a retryable timeout, not a "still generating" cut-off. It used to
    // carry no usage at all, so the call was retried and recorded at $0.
    const { client } = fakeClient({ events: [], hangAfterEvents: true, inputTokens: 1_500 })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 200 }, EXPENSIVE, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(BilledGenerationError)
    expect(err).toMatchObject({ name: 'TimeoutError' })
    expect(isTransientError(err)).toBe(true)
    expect(String((err as Error).message)).toMatch(/timed out/)
    expect(billedUsageOf(err)).toMatchObject({ tokensIn: 1_500, usageSource: 'estimated' })
    expect(costFromUsage(summarizeUsage([billedUsageOf(err)!]), EXPENSIVE)).toBeGreaterThan(0)
  })

  it('a stream that stalls with no event at all is an unbilled transient timeout, as before', async () => {
    const { client } = fakeClient({ hang: true })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 200 }, EXPENSIVE, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect(err).toMatchObject({ name: 'TimeoutError' })
    expect(billedUsageOf(err)).toBeUndefined()
    expect(isTransientError(err)).toBe(true)
  })
})

describe('rate limits: retry-after', () => {
  it('reads retry-after from a 429 response, in seconds, and carries it on the error', async () => {
    const response = new Anthropic.APIError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers({ 'retry-after': '42' }) as never
    )
    const { client } = fakeClient({ fail: response })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 5_000 }, DEFAULT_MODEL, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect((err as Error).message).toMatch(/^Anthropic error 429: slow down/)
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(42_000)
    expect(isTransientError(err)).toBe(true)
  })

  it('reads retry-after from a 529 response, through a Headers object', async () => {
    const response = new Anthropic.APIError(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
      'busy',
      new Headers({ 'retry-after': '7' }) as never
    )
    const { client } = fakeClient({ fail: response })
    const err = await generateAnthropic({ apiKey: TEST_KEY, timeoutMs: 5_000 }, DEFAULT_MODEL, TASK, { client }).catch(
      (e: unknown) => e
    )
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(7_000)
  })

  it('carries no retry-after for a status that does not take one, or a 429 without the header', async () => {
    const bad = new Anthropic.APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'no' } },
      'no',
      new Headers({ 'retry-after': '42' }) as never
    )
    const { client: c1 } = fakeClient({ fail: bad })
    const e1 = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client: c1 }).catch((e: unknown) => e)
    expect((e1 as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()

    const bare = new Anthropic.APIError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
      'slow',
      new Headers() as never
    )
    const { client: c2 } = fakeClient({ fail: bare })
    const e2 = await generateAnthropic({ apiKey: TEST_KEY }, DEFAULT_MODEL, TASK, { client: c2 }).catch((e: unknown) => e)
    expect((e2 as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
  })

  it('computes the retry wait as the advised time, never less than the backoff, and never more than 180 seconds (the runner wait is pinned in provider-budget.test.ts)', () => {
    const advised = (ms: number) => Object.assign(new Error('Anthropic error 429: slow down'), { retryAfterMs: ms })
    expect(retryDelayMs(advised(42_000), 4_000)).toBe(42_000)
    // A shorter advice does not shorten the harness's own backoff.
    expect(retryDelayMs(advised(1_000), 4_000)).toBe(4_000)
    expect(retryDelayMs(advised(3_600_000), 4_000)).toBe(180_000)
    expect(retryDelayMs(new Error('Anthropic error 429: slow down'), 4_000)).toBe(4_000)
  })
})
