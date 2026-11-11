import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { BenchmarkModel, BenchmarkTask, GenerationResponse } from '../types'
import { isHeaderSafeApiKey } from '../key-file'
import { BilledGenerationError, type BilledUsage } from './billed'

/**
 * The Anthropic Messages API runner.
 *
 * Calls go through the official SDK, streamed. The runner stamps the first
 * content block (`ttftMs`), counts usage from the provider, and bounds the whole
 * stream with its own clock. Load-bearing rules:
 *
 *  - No sampling parameters (no temperature, top_p or top_k). Current models
 *    reject them, and a benchmark must not depend on a parameter the model
 *    ignores or refuses.
 *  - No `fallbacks` parameter and no beta that lets another model answer. A
 *    benchmark result must never be silently served by a different model.
 *  - The HARNESS owns retries. The SDK's own retries are off (`maxRetries: 0`),
 *    because a retry the SDK makes invisibly is a paid call the run log never
 *    records.
 *  - Every paid call is billed, including a refused or truncated one. Such a
 *    failure throws a `BilledGenerationError` that carries the usage, so the
 *    cost reaches the record and the budget cap.
 *  - The API key never appears in a message this module throws.
 */

export interface AnthropicConfig {
  apiKey: string
  /** Optional proxy or gateway. A trailing `/v1` is stripped (the SDK adds it). */
  baseUrl?: string
  /** Per-request cap in milliseconds, enforced by an AbortController. Default 10 minutes. */
  timeoutMs?: number
}

/** The subset of the SDK's streaming surface this runner uses. A test seam. */
export interface AnthropicStreamLike {
  on(
    event: 'streamEvent',
    listener: (event: Anthropic.RawMessageStreamEvent, snapshot: Anthropic.Message) => void
  ): unknown
  finalMessage(): Promise<Anthropic.Message>
}

export interface AnthropicClientLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): AnthropicStreamLike
  }
}

export interface AnthropicDeps {
  /** Replaces the SDK client. Used by unit tests; production never sets it. */
  client?: AnthropicClientLike
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
// The API maximum for every current model (a registry entry with a lower
// ceiling, such as claude-haiku-4-5, sets maxOutputTokens). Raised from 64,000
// on 2026-11-10: at high effort Fable 5.2 and Sonnet 5.5 spent all 64,000
// tokens reasoning on two open-ended tasks and wrote nothing, so the cap was
// measuring this harness's setting, not the model. Output tokens include
// reasoning; the per-model budget cap bounds the cost of a runaway call.
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000
/** The runner's own cap when no timeout is configured. Exported so the provider's outer clock can sit above it. */
export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
/**
 * The output rate a cut-off stream is billed at, as a floor. A stream that ran
 * for N seconds after its first content block generated at least N x 150 tokens,
 * whatever the usage it reported so far says. The count is an estimate and is
 * marked as one.
 */
export const CUT_OFF_TOKENS_PER_SECOND = 150
/** Status codes whose response may say how long to wait. */
const RETRY_AFTER_HEADER = 'retry-after'
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 529])
const SYSTEM_PROMPT =
  'Respond with only the requested artifact (code, derivation, etc.) and minimal commentary.'
/** The efforts the Messages API accepts. 'ultra' belongs to another provider. */
const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * The stop reasons that mean the answer is complete. Anything else (refusal,
 * the output cap, the context window, a pause, or a reason a future API adds)
 * is not an answer, so it is refused rather than scored.
 */
const COMPLETE_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence'])
/**
 * Environment variables the SDK reads into every request. A benchmark call must
 * carry only the headers and credential this module sets, so these are removed
 * while the client is constructed.
 */
const SDK_ENV_TO_IGNORE = ['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_AUTH_TOKEN'] as const
/**
 * Status for an error the API sends inside a 200 stream (no HTTP status), keyed
 * by the body's error type. The mapping is what lets the classifier treat a
 * mid-stream overload the same way as an HTTP 529.
 */
const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  api_error: 500,
  timeout_error: 504,
  rate_limit_error: 429,
}

/**
 * The SDK's base URL for a configured endpoint. The SDK appends `/v1/...` itself,
 * so a configured `.../v1` would otherwise produce `.../v1/v1/messages`.
 */
export function anthropicBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/v1\/?$/, '')
}

/**
 * The request body for one call. PURE: no network, no clock, no env.
 *
 *  - `thinking` is sent only as adaptive, and only when the registry says so.
 *    On models where adaptive thinking is already the default, omitting the
 *    parameter is the request that does it.
 *  - `output_config.effort` is sent only when the registry pins an effort.
 *    claude-haiku-4-5 accepts neither key, so its entries pin neither.
 */
export function buildAnthropicRequest(
  model: BenchmarkModel,
  task: BenchmarkTask
): Anthropic.MessageStreamParams {
  const effort = model.reasoningEffort
  if (effort === 'ultra') {
    // Classified as invalid_request by classifyFailureReason ("invalid request"),
    // so the harness records it once and does not retry it.
    throw new Error(
      `Invalid request: reasoningEffort 'ultra' is not an Anthropic effort level ` +
        `(${ANTHROPIC_EFFORTS.join(', ')}) for ${model.id}`
    )
  }
  return {
    model: model.apiModelId ?? model.id,
    max_tokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: task.prompt }],
    ...(model.thinking === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(effort !== undefined ? { output_config: { effort } } : {}),
  }
}

/** The first string `code` on the cause chain, or a generic label. */
function connectionDetail(err: Error): string {
  let cur: unknown = err.cause
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return 'connection error'
}

/** The provider's own message from an error body, falling back to the SDK's text. */
function apiErrorDetail(err: APIError): string {
  const body = err.error as { error?: { message?: unknown } } | undefined
  const inner = body?.error?.message
  return typeof inner === 'string' && inner.length > 0 ? inner : err.message
}

/** The error type the API put in the body (e.g. `overloaded_error`), if any. */
function apiErrorType(err: APIError): string | undefined {
  const body = err.error as { error?: { type?: unknown } } | undefined
  const type = body?.error?.type
  return typeof type === 'string' ? type : undefined
}

function timeoutError(timeoutMs: number): Error {
  // name 'TimeoutError' and the "timed out" wording both make isTimeoutError
  // true, and the message has no "Timeout after Nms:" prefix, so
  // classifyFailureReason files it as endpoint_hung rather than cli_timeout.
  const err = new Error(`Anthropic request timed out after ${timeoutMs}ms`)
  err.name = 'TimeoutError'
  return err
}

/**
 * The stream was still producing output when the runner's cap fired. This is
 * NOT a timeout in the transient sense: the endpoint was answering, the answer
 * was just too long for the cap. The wording avoids "timeout" and "timed out"
 * so it is neither retried nor filed as endpoint_hung.
 */
function cutOffMessage(timeoutMs: number): string {
  return `Anthropic stream stopped at the ${timeoutMs}ms cap while still generating; the answer is incomplete`
}

/**
 * Map an SDK failure onto the message shapes the harness classifies. Every
 * branch keeps the text classifyFailureReason and isTransientError look for:
 * "Anthropic error <status>:" for HTTP, "fetch failed" for network, "timed out"
 * for the timeout. The key is removed from any text that is passed through.
 */
function toHarnessError(err: unknown, apiKey: string): Error {
  const mapped = mapFailure(err)
  const message = redactKey(mapped.message, apiKey)
  const error = message === mapped.message ? mapped : new Error(message)
  const retryAfterMs = retryAfterMsOf(err)
  if (retryAfterMs !== undefined) Object.assign(error, { retryAfterMs })
  return error
}

/**
 * The wait a 429 or 529 response asks for, in milliseconds, from its
 * `retry-after` header (seconds, or an HTTP date). Undefined for any other
 * status, or when the header is absent or unreadable. The harness applies the
 * cap (provider.ts), so this returns the value as the provider sent it.
 */
export function retryAfterMsOf(err: unknown): number | undefined {
  if (!(err instanceof APIError) || typeof err.status !== 'number' || !RETRY_AFTER_STATUSES.has(err.status)) {
    return undefined
  }
  const raw = headerValue(err.headers, RETRY_AFTER_HEADER)
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const get = (headers as { get?: unknown }).get
  if (typeof get === 'function') {
    const value: unknown = get.call(headers, name)
    return typeof value === 'string' ? value : undefined
  }
  // A plain record, from a test or a fake: the SDK's Headers answers `get`.
  const record = headers as Record<string, unknown>
  const value = record[name] ?? record[name === RETRY_AFTER_HEADER ? 'Retry-After' : name]
  return typeof value === 'string' ? value : undefined
}

function mapFailure(err: unknown): Error {
  if (err instanceof APIConnectionError) {
    return new Error(`Anthropic request failed: fetch failed (${connectionDetail(err)})`)
  }
  if (err instanceof APIUserAbortError) return new Error('Anthropic request aborted')
  if (err instanceof APIError) {
    if (typeof err.status === 'number') {
      return new Error(`Anthropic error ${err.status}: ${apiErrorDetail(err)}`)
    }
    // An error the API sent inside the stream: no HTTP status, but a typed body.
    const type = apiErrorType(err)
    const status = type !== undefined ? STREAM_ERROR_STATUS[type] : undefined
    if (status !== undefined) return new Error(`Anthropic error ${status}: ${apiErrorDetail(err)}`)
    return err
  }
  if (err instanceof AnthropicError && err.message.length > 0) {
    // The SDK wraps a failure while reading the body (a dropped socket) or a
    // stream that ended before message_stop. Both are network failures.
    const cause = (err as { cause?: unknown }).cause
    const detail =
      cause instanceof Error && cause.message.length > 0
        ? connectionDetailOrMessage(cause)
        : err.message
    return new Error(`Anthropic request failed: fetch failed (stream interrupted: ${detail})`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function connectionDetailOrMessage(cause: Error): string {
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : cause.message
}

function redactKey(message: string, apiKey: string): string {
  return apiKey.length > 0 && message.includes(apiKey) ? message.split(apiKey).join('***') : message
}

/**
 * Output tokens to bill for a call cut off after its stream started. PURE:
 *
 *   min(maxTokens, max(reported so far, ceil(visible characters / 3),
 *                      ceil(seconds since the first content block x 150)))
 *
 * The time term is what keeps thinking visible to the budget: a thinking block
 * arrives as empty text, so the characters and the reported counts can both sit
 * at zero while the model generates for minutes. `secondsSinceFirstBlock` is
 * undefined when no content block has started, and then the time term is zero.
 */
export function cutOffOutputTokens(input: {
  reported: number
  visibleChars: number
  secondsSinceFirstBlock: number | undefined
  maxTokens: number
}): number {
  const timeFloor =
    input.secondsSinceFirstBlock === undefined
      ? 0
      : Math.ceil(Math.max(0, input.secondsSinceFirstBlock) * CUT_OFF_TOKENS_PER_SECOND)
  return Math.min(input.maxTokens, Math.max(input.reported, Math.ceil(input.visibleChars / 3), timeFloor))
}

/**
 * The usage of a call that produced some of its stream and then failed. The
 * provider's own totals arrive only at the end, so the counts are ours: input
 * from message_start, and output from cutOffOutputTokens.
 */
function cutOffUsage(
  snapshot: Anthropic.Message | undefined,
  maxTokens: number,
  firstBlockAt: number | undefined,
  now: number,
  start: number
): BilledUsage {
  let visible = ''
  for (const block of snapshot?.content ?? []) {
    if (block.type === 'text') visible += block.text
  }
  return {
    tokensIn: snapshot?.usage?.input_tokens ?? 0,
    tokensOut: cutOffOutputTokens({
      reported: snapshot?.usage?.output_tokens ?? 0,
      visibleChars: visible.length,
      secondsSinceFirstBlock: firstBlockAt === undefined ? undefined : (now - firstBlockAt) / 1000,
      maxTokens,
    }),
    usageSource: 'estimated',
    runtimeMs: now - start,
    partialOutput: visible,
  }
}

/**
 * Build the SDK client with the ambient SDK env removed, then restore it. The
 * SDK reads ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_AUTH_TOKEN in its constructor,
 * so a shell that sets them would change every benchmark request (a session
 * token sent to the API, or an extra beta header). The constructor is
 * synchronous, so the removal is confined to it. Only the names of the ignored
 * headers are printed, once per process.
 */
let warnedIgnoredSdkEnv = false

function constructClient(apiKey: string, baseURL: string, timeoutMs: number): Anthropic {
  const saved = new Map<string, string>()
  for (const name of SDK_ENV_TO_IGNORE) {
    const value = process.env[name]
    if (value !== undefined) {
      saved.set(name, value)
      delete process.env[name]
    }
  }
  if (saved.size > 0 && !warnedIgnoredSdkEnv) {
    warnedIgnoredSdkEnv = true
    const headerNames = (saved.get('ANTHROPIC_CUSTOM_HEADERS') ?? '')
      .split('\n')
      .map((line) => line.slice(0, Math.max(0, line.indexOf(':'))).trim())
      .filter((name) => name.length > 0)
    const parts = [
      ...(headerNames.length > 0 ? [`headers ${headerNames.join(', ')} from ANTHROPIC_CUSTOM_HEADERS`] : []),
      ...(saved.has('ANTHROPIC_AUTH_TOKEN') ? ['ANTHROPIC_AUTH_TOKEN'] : []),
    ]
    console.log(`[harness] ignoring ${parts.join(' and ')} for benchmark calls (names only)`)
  }
  try {
    return new Anthropic({
      apiKey,
      // Explicit, so a stray ANTHROPIC_BASE_URL in the environment cannot
      // redirect a benchmark call.
      baseURL,
      maxRetries: 0,
      timeout: timeoutMs,
      // Explicit null: no ambient token may ride along with the key.
      authToken: null,
    })
  } finally {
    for (const [name, value] of saved) process.env[name] = value
  }
}

export async function generateAnthropic(
  config: AnthropicConfig,
  model: BenchmarkModel,
  task: BenchmarkTask,
  deps: AnthropicDeps = {}
): Promise<GenerationResponse> {
  // Built before any network, so an invalid registry entry costs nothing.
  const params = buildAnthropicRequest(model, task)
  // Checked before any network too: a key with a newline or a control character
  // is rejected by the header layer, and the error that layer raises prints it.
  if (config.apiKey.length === 0) throw new Error('Invalid request: Anthropic API key is empty')
  if (!isHeaderSafeApiKey(config.apiKey)) {
    throw new Error('Invalid request: Anthropic API key contains characters that cannot be sent in a header')
  }
  const apiKey = config.apiKey
  const timeoutMs = config.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS
  const client: AnthropicClientLike =
    deps.client ?? constructClient(apiKey, anthropicBaseUrl(config.baseUrl), timeoutMs)

  // The runner's own clock, not only the SDK's: the SDK timeout bounds time to
  // headers, while this controller bounds the whole stream and really stops
  // generation (and billing) when it fires.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const start = Date.now()
  let ttftMs: number | undefined
  // When the first content block started (thinking included). A cap that fires
  // after that is a live answer still generating: it is cut off and billed for
  // what it generated. A cap that fires before any content block is the
  // transient timeout it always was, because nothing has been generated yet.
  let firstBlockAt: number | undefined
  // Whether any stream event arrived. A non-cap failure after events still
  // bills what the stream produced.
  let sawEvent = false
  let latest: Anthropic.Message | undefined
  let message: Anthropic.Message
  try {
    const stream = client.messages.stream(params, { signal: controller.signal })
    stream.on('streamEvent', (event, snapshot) => {
      sawEvent = true
      latest = snapshot
      if (event.type === 'content_block_start') {
        // The first content block of any kind (thinking included) is the first
        // token boundary. Stamping the first VISIBLE text instead would leave the
        // thinking tokens in tokensOut but out of the clock, and inflate the rate.
        const now = Date.now()
        if (ttftMs === undefined) ttftMs = now - start
        if (firstBlockAt === undefined) firstBlockAt = now
      }
    })
    message = await stream.finalMessage()
  } catch (err) {
    const now = Date.now()
    const cut = timedOut || err instanceof APIConnectionTimeoutError
    if (cut) {
      if (firstBlockAt !== undefined) {
        throw new BilledGenerationError(
          cutOffMessage(timeoutMs),
          cutOffUsage(latest, params.max_tokens, firstBlockAt, now, start)
        )
      }
      // No content block started, so nothing is known to be generated and this is
      // the transient timeout it always was: retried, not a budget event. The input
      // the provider had already read at message_start is billed, though, so it
      // rides on the error for the budget and the record.
      const timeout = timeoutError(timeoutMs)
      const tokensIn = latest?.usage?.input_tokens ?? 0
      if (tokensIn > 0) {
        const billed = new BilledGenerationError(timeout.message, {
          tokensIn,
          tokensOut: latest?.usage?.output_tokens ?? 0,
          usageSource: 'estimated',
          runtimeMs: now - start,
        })
        billed.name = timeout.name
        throw billed
      }
      throw timeout
    }
    const harness = toHarnessError(err, apiKey)
    if (sawEvent) {
      throw new BilledGenerationError(
        harness.message,
        cutOffUsage(latest, params.max_tokens, firstBlockAt, now, start)
      )
    }
    throw harness
  } finally {
    clearTimeout(timer)
  }
  const runtimeMs = Date.now() - start

  // The visible answer is every text block, in order. Thinking blocks are the
  // model's reasoning and are not part of the artifact.
  const output = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  const reported: BilledUsage = {
    tokensIn: message.usage.input_tokens,
    // output_tokens includes thinking tokens, which is what the provider bills.
    tokensOut: message.usage.output_tokens,
    usageSource: 'reported',
    runtimeMs,
    partialOutput: output,
  }

  // HTTP 200 does not mean an answer. Each stop below is paid for, so each throws
  // carrying its usage, and each is a non-transient failure: the same cap or the
  // same refusal would repeat on retry.
  const stopReason = message.stop_reason
  if (stopReason === 'refusal') {
    const category = message.stop_details?.category ?? 'unspecified'
    throw new BilledGenerationError(
      `Anthropic refused the request (stop_reason refusal, category ${category})`,
      reported
    )
  }
  if (stopReason === 'max_tokens') {
    throw new BilledGenerationError(
      'Anthropic stop_reason max_tokens: response truncated at max_tokens before the answer finished',
      reported
    )
  }
  if (stopReason === 'model_context_window_exceeded') {
    throw new BilledGenerationError(
      'Anthropic stop_reason model_context_window_exceeded: response truncated at the context window before the answer finished',
      reported
    )
  }
  if (stopReason === null || stopReason === undefined || !COMPLETE_STOP_REASONS.has(stopReason)) {
    throw new BilledGenerationError(
      `Anthropic stop_reason ${String(stopReason)}: the response did not finish; ` +
        'this runner accepts only end_turn and stop_sequence',
      reported
    )
  }

  return {
    output,
    tokensIn: reported.tokensIn,
    tokensOut: reported.tokensOut,
    usageSource: 'reported',
    runtimeMs,
    ...(ttftMs !== undefined ? { ttftMs } : {}),
  }
}
