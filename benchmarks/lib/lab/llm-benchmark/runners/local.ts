import type { BenchmarkModel, BenchmarkTask, UsageProvenance } from '../types'

export interface LocalConfig {
  /**
   * OpenAI-compatible base URL, e.g. `http://127.0.0.1:11500/v1`. Comes from the
   * registry entry's `baseUrl` — two local engines can serve the same weights on
   * different ports, so this is per-model rather than a global env var.
   */
  baseUrl: string
  /** Bearer token. Omitted when env `LOCAL_API_KEY` is unset (llama.cpp needs none). */
  apiKey?: string
  /** Completion-token cap. Defaults to env `LOCAL_MAX_TOKENS`, else 16384. */
  maxTokens?: number
}

export interface GenerationResponse {
  output: string
  tokensIn: number
  tokensOut: number
  runtimeMs: number
  /** See the canonical contract on `GenerationResponse` in ../types. */
  usageSource?: UsageProvenance
  /** See the canonical contract on `GenerationResponse` in ../types. */
  ttftMs?: number
}

/** A local server has nobody in front of it, so cap the generation ourselves. */
const DEFAULT_MAX_TOKENS = 16384

/**
 * Read a chat-completions SSE stream, accumulating ONLY the final-answer
 * `content` deltas. Local reasoning models (Flint, Qwen3, …) put the thinking
 * trace in `reasoning_content`; scoring the trace instead of the artifact would
 * measure the wrong thing. Usage arrives in the terminal chunk when
 * `stream_options.include_usage` is set (llama.cpp and rec both honour it).
 */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (bytes: number) => void
): Promise<{
  content: string
  tokensIn: number
  tokensOut: number
  /** True iff the stream carried a `usage` block — i.e. the counts are the provider's own. */
  sawUsage: boolean
  firstTokenAt?: number
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let tokensIn = 0
  let tokensOut = 0
  let sawUsage = false
  let received = 0
  let finishReason: string | undefined
  // Wall-clock of the first generated token of ANY kind — reasoning included.
  //
  // It must be the first token, not the first CONTENT token: the harness folds
  // this into a decode rate as `tokensOut / (runtimeMs - ttftMs)`, and for a
  // reasoning model `tokensOut` (completion_tokens) counts the thinking trace.
  // Stamping TTFT at the first content token would divide ~24k reasoning tokens
  // by the few seconds of visible output and report 400–800 tok/s for a 100
  // tok/s model. One timestamp, one token set, one honest rate.
  let firstTokenAt: number | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    onProgress?.(received)
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const choice = json.choices?.[0]
        const contentDelta = choice?.delta?.content
        // llama.cpp / vLLM / rec stream the thinking trace separately; some
        // OpenAI-compatible servers call it `reasoning`. Either counts for the
        // first-token boundary; neither is ever appended to the artifact.
        const reasoningDelta =
          (typeof choice?.delta?.reasoning_content === 'string' && choice.delta.reasoning_content) ||
          (typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning) ||
          ''
        if (
          firstTokenAt === undefined &&
          (reasoningDelta.length > 0 ||
            (typeof contentDelta === 'string' && contentDelta.length > 0))
        ) {
          firstTokenAt = Date.now()
        }
        if (typeof contentDelta === 'string' && contentDelta.length > 0) {
          content += contentDelta
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
        if (json.usage) {
          sawUsage = true
          tokensIn = json.usage.prompt_tokens ?? tokensIn
          tokensOut = json.usage.completion_tokens ?? tokensOut
        }
      } catch {
        // A split SSE payload or keep-alive comment — the next chunk completes it.
      }
    }
  }

  // Truncated generations are diagnosable failures, not empty successes. This
  // is the profile of a reasoning model that spent the whole budget thinking.
  if (!content.trim() && finishReason === 'length') {
    throw new Error(
      `generation truncated at the completion-token limit before any content was emitted (${tokensOut} tokens, all reasoning)`
    )
  }

  return { content, tokensIn, tokensOut, sawUsage, firstTokenAt }
}

/**
 * A model served by a local OpenAI-compatible endpoint: `rec` (MLX/Metal) or
 * `llama-server` (GGUF/Metal) on Apple Silicon.
 *
 * Local servers are free, fast to first token, and subject to
 * memory-bandwidth-bound decoding — so they are measured with the same runner,
 * prompt bundle, scorer and sandbox as every paid model, and their tok/s is
 * recorded in the site's separate local-LLM notes rather than inferred here.
 */
export async function generateLocal(
  config: LocalConfig,
  model: BenchmarkModel,
  task: BenchmarkTask
): Promise<GenerationResponse> {
  const start = Date.now()
  const apiModelId = model.apiModelId ?? model.id
  const apiKey = config.apiKey ?? process.env.LOCAL_API_KEY
  const maxTokens =
    config.maxTokens ?? (Number(process.env.LOCAL_MAX_TOKENS) || DEFAULT_MAX_TOKENS)

  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: apiModelId,
      messages: [
        {
          role: 'system',
          content:
            'Respond with only the requested artifact (code, derivation, etc.) and minimal commentary.',
        },
        { role: 'user', content: task.prompt },
      ],
      // Vendor-recommended sampling for Flint, and the harness default elsewhere.
      temperature: 1,
      max_tokens: maxTokens,
      // Streaming keeps the connection alive while a slow local decode works
      // through a long reasoning trace, and gives a real TTFT boundary.
      stream: true,
      stream_options: { include_usage: true },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Local endpoint error ${res.status}: ${body}`)
  }
  if (!res.body) throw new Error('Local endpoint response had no body')

  let lastLog = 0
  const { content, tokensIn, tokensOut, sawUsage, firstTokenAt } = await readChatStream(
    res.body,
    (bytes) => {
      if (bytes - lastLog >= 64 * 1024) {
        lastLog = bytes
        console.log(`[harness]   … ${model.name} streaming, ${Math.round(bytes / 1024)}KB so far`)
      }
    }
  )

  return {
    output: content,
    tokensIn,
    tokensOut,
    runtimeMs: Date.now() - start,
    usageSource: sawUsage ? 'reported' : 'estimated',
    ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - start } : {}),
  }
}
