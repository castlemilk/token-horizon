/**
 * Producer-side stamping of `GenerationResponse.usageSource`.
 *
 * The CLI side of the same contract lives in `cli.test.ts` (char fallback +
 * the codex parseTokens path); this file covers the API providers, where the
 * question is exactly "did the response carry a usage block".
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateMoonshot } from './moonshot'
import { generateOpenRouter } from './openrouter'
import { generateOpenAI } from './openai'
import { generateAnthropic } from './anthropic'
import { generateGoogle } from './google'
import type { BenchmarkModel, BenchmarkTask } from '../types'

const MODEL: BenchmarkModel = {
  id: 'test-model',
  name: 'Test',
  provider: 'Test',
  costPer1kInputUsd: 0,
  costPer1kOutputUsd: 0,
  contextWindow: 1000,
  capabilities: '',
}

const TASK: BenchmarkTask = {
  id: 't',
  category: 'ui-building',
  title: 'T',
  blurb: '',
  prompt: 'do it',
  runtimeHint: '',
  iterationsDefault: 1,
  methodNotes: '',
  demoComponentName: 'D',
  slug: 't',
}

/** A minimal chat-completions SSE body; `usage` omitted when null. */
function sseBody(usage: { prompt_tokens: number; completion_tokens: number } | null): Response {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"<h1>hello</h1>"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ...(usage ? [`data: {"choices":[],"usage":${JSON.stringify(usage)}}\n\n`] : []),
    'data: [DONE]\n\n',
  ]
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streaming API providers stamp usage provenance', () => {
  for (const [name, generate] of [
    ['moonshot', () => generateMoonshot({ apiKey: 'k' }, MODEL, TASK)],
    ['openrouter', () => generateOpenRouter({ apiKey: 'k' }, MODEL, TASK)],
  ] as const) {
    it(`${name}: 'reported' when the stream carried a usage block`, async () => {
      mockFetch(sseBody({ prompt_tokens: 111, completion_tokens: 222 }))
      const res = await generate()
      expect(res.tokensIn).toBe(111)
      expect(res.tokensOut).toBe(222)
      expect(res.usageSource).toBe('reported')
    })

    it(`${name}: 'estimated' when no usage block arrived (the zeros are ours)`, async () => {
      mockFetch(sseBody(null))
      const res = await generate()
      expect(res.tokensIn).toBe(0)
      expect(res.tokensOut).toBe(0)
      // The counts are a fallback we invented, so they must not claim the
      // provider's authority — even though nothing was "estimated" from chars.
      expect(res.usageSource).toBe('estimated')
    })
  }
})

/**
 * The Messages API streams, and the SDK throws on a stream with no usage, so the
 * Anthropic runner has no 'estimated' path: a response that carries no usage
 * is an error, not a zero. This is the stream shape it reads.
 */
function anthropicSse(usage: { input_tokens: number; output_tokens: number }): Response {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const body =
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_usage',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
      },
    }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
      usage: { output_tokens: usage.output_tokens },
    }) +
    event('message_stop', { type: 'message_stop' })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('streaming Anthropic stamps usage provenance', () => {
  it("anthropic: 'reported' from the usage the stream carries", async () => {
    mockFetch(anthropicSse({ input_tokens: 7, output_tokens: 9 }))
    const res = await generateAnthropic({ apiKey: 'sk-ant-api-usage-test-1' }, MODEL, TASK)
    expect([res.tokensIn, res.tokensOut]).toEqual([7, 9])
    expect(res.usageSource).toBe('reported')
  })
})

describe('non-streaming API providers stamp usage provenance', () => {
  const cases = [
    {
      name: 'openai',
      run: () => generateOpenAI({ apiKey: 'k' }, MODEL, TASK),
      reported: { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 9 } },
      bare: { choices: [{ message: { content: 'hi' } }] },
      tokens: [7, 9],
    },
    {
      name: 'google',
      run: () => generateGoogle({ apiKey: 'k' }, MODEL, TASK),
      reported: {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9 },
      },
      bare: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      tokens: [7, 9],
    },
  ] as const

  for (const c of cases) {
    it(`${c.name}: 'reported' when the response carried usage`, async () => {
      mockFetch(new Response(JSON.stringify(c.reported), { status: 200 }))
      const res = await c.run()
      expect([res.tokensIn, res.tokensOut]).toEqual([...c.tokens])
      expect(res.usageSource).toBe('reported')
    })

    it(`${c.name}: 'estimated' when the response carried none`, async () => {
      mockFetch(new Response(JSON.stringify(c.bare), { status: 200 }))
      const res = await c.run()
      expect([res.tokensIn, res.tokensOut]).toEqual([0, 0])
      expect(res.usageSource).toBe('estimated')
    })
  }
})
