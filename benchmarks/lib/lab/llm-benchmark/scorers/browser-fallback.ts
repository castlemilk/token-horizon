/**
 * A sweep never publishes a structure-only score for a browser-scored artifact
 * just because the browser stopped answering, and it does not render artifacts
 * in parallel by default.
 *
 * The behavioural scorer turns a browser failure into a `behavioural-run`
 * fallback row and scores the artifact structurally (scorers/behavioral.ts).
 * That is the right answer for a machine with no browser (BENCH_SANDBOX=structural),
 * where the fallback is the stated policy. On the chromium backend it is not:
 * the browser was supposed to run, so a fallback means it died, and a
 * structural score would sit on the board as if the artifact had been tested.
 *
 * The rules, in the order a scoring call applies them:
 *
 *  1. SEMAPHORE. At most BENCH_SCORE_CONCURRENCY artifacts (default 1) are being
 *     scored in the browser at once, across every (model, task) pair in the
 *     process. Generation is not limited; only the browser is. The time a call
 *     waited for a slot is written to the run log as a `scoringWait` event.
 *  2. SERIAL. A pair's iterations are scored one after another, never together.
 *  3. PROBE (chromium only, when the caller supplies a probe). A known-good
 *     animated page is scored with the same budgets before the pair's artifacts
 *     and again after them when a row failed. If the probe fails, the sweep waits
 *     with a growing delay and tries again; after the last retry it stops.
 *  4. TIMEOUT RESCORE. An artifact with a check that could not finish (see
 *     isTimeoutRow in browser-gone.ts) is rescored once on a fresh page after a
 *     2-second wait. Both attempts go to the run log as a `rescore` event. An
 *     ordinary failed check is never rescored. A rescore that also times out is
 *     a machine fault: the browser is dropped, the sweep waits the first probe
 *     backoff, probes, and rescores once more. A timeout that survives that
 *     throws BrowserFallbackError, so no record is written for the pair.
 *  5. BROWSER DISCONNECT. An artifact whose run fell back because the browser
 *     disconnected is rescored once on a relaunched browser. A second fallback
 *     stops the sweep: the error is thrown, and aggregateRuns publishes nothing
 *     for the pair.
 */
import type { BenchmarkTask, IterationCheckResult } from '../types'
import { BEHAVIOURAL_RUN_CHECK } from '../types'
import type { RunLogEventInput } from '../runlog-format'
import { discardSandboxBrowser, resolveSandboxPolicy } from './sandbox-backend'
import { isTimeoutRow } from './browser-gone'

/** The detail prefix `scoreBehavioral` gives a browser-run failure (not a missing-checks fallback). */
export const BROWSER_RUN_FAILED_PREFIX = 'behavioural run failed: '

/** Wait before a timeout rescore, so the rescore does not start on the same busy moment. */
export const RESCORE_DELAY_MS = 2_000

/** Waits between probe retries. A probe that fails after the last wait stops the sweep. */
export const PROBE_BACKOFF_MS: readonly number[] = [15_000, 45_000, 90_000]

/** Thrown when the browser cannot run an artifact even after one relaunch, or the machine cannot keep time. Stops the sweep. */
export class BrowserFallbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserFallbackError'
  }
}

/** The run-log events a scoring call writes. */
export type ScoringEvent = Extract<RunLogEventInput, { type: 'scoringWait' | 'rescore' | 'scoringProbe' }>

/**
 * What a known-good probe reports: whether every probe check passed, and the rows
 * that did not. `fatal` marks a probe that could not start a browser at all: that
 * is an installation fault, not load, so waiting cannot fix it and the sweep stops.
 */
export interface ProbeOutcome {
  ok: boolean
  failing: string[]
  fatal?: boolean
}

/** The reason a breakdown records when the browser could not run its checks, or undefined. */
export function browserRunFallbackReason(checks: readonly IterationCheckResult[]): string | undefined {
  const row = checks.find(
    (c) => c.name === BEHAVIOURAL_RUN_CHECK && c.kind === 'fallback' && (c.detail ?? '').startsWith(BROWSER_RUN_FAILED_PREFIX)
  )
  return row?.detail
}

/** True when a breakdown has a check that ran out of time, so an idle-browser rescore is worth one try. */
export function hasTimeoutRow(checks: readonly IterationCheckResult[]): boolean {
  return checks.some((c) => isTimeoutRow(c))
}

/** True when a breakdown has a scored check that did not pass (a fallback row is not a check). */
export function hasFailingCheck(checks: readonly IterationCheckResult[]): boolean {
  return checks.some((c) => c.kind !== 'fallback' && c.maxPoints > 0 && !c.passed)
}

export interface ScoredBreakdown {
  score: number
  checks: IterationCheckResult[]
}

type BreakdownFn = (output: string, task: BenchmarkTask) => Promise<ScoredBreakdown> | ScoredBreakdown

/** Options for one scoring call. Every field is optional; the defaults are production's. */
export interface ScoringOptions {
  /** Receives the scoring events, in order. Absent = no run log. */
  log?: (event: ScoringEvent) => void
  /** Iteration index of each output, for the events. Absent = the output's position. */
  iterationIndexes?: readonly number[]
  /** Known-good probe. Given only by a caller that scores in the browser (aggregateRuns). */
  probe?: () => Promise<ProbeOutcome>
  /** Waits between probe retries. Default PROBE_BACKOFF_MS. */
  probeBackoffMs?: readonly number[]
  /** Wait before a timeout rescore. Default RESCORE_DELAY_MS. */
  rescoreDelayMs?: number
  /** Timer seam for tests. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The scoring semaphore
// ---------------------------------------------------------------------------

/**
 * BENCH_SCORE_CONCURRENCY: how many artifacts may be rendered at once in this
 * process. Unset or empty = 1. A value that is not a whole number of at least 1
 * is an error, so a typo cannot quietly turn parallel rendering back on.
 */
export function scoreConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BENCH_SCORE_CONCURRENCY?.trim()
  if (raw === undefined || raw === '') return 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`BENCH_SCORE_CONCURRENCY="${raw}" must be a whole number of at least 1`)
  }
  return n
}

class Semaphore {
  private free: number
  private readonly waiting: Array<() => void> = []

  constructor(readonly limit: number) {
    this.free = limit
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free++
  }
}

let semaphore: Semaphore | undefined

function scoringSemaphore(): Semaphore {
  const limit = scoreConcurrency()
  if (!semaphore || semaphore.limit !== limit) semaphore = new Semaphore(limit)
  return semaphore
}

/**
 * Run `fn` once a scoring slot is free, and report how long the call waited.
 * One semaphore for the whole process, so two (model, task) pairs scored at the
 * same time share the limit. A call that throws releases its slot.
 */
export async function withScoringSlot<T>(fn: (waitMs: number, concurrency: number) => Promise<T>): Promise<T> {
  const sem = scoringSemaphore()
  const requestedAt = Date.now()
  await sem.acquire()
  try {
    return await fn(Date.now() - requestedAt, sem.limit)
  } finally {
    sem.release()
  }
}

/** Run `fn` in a scoring slot. See withScoringSlot. */
export function withScoringLock<T>(fn: () => Promise<T>): Promise<T> {
  return withScoringSlot(() => fn())
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** The rows a failing attempt left, for the run log: name and detail, capped. */
function failingRows(checks: readonly IterationCheckResult[]): string[] {
  return checks
    .filter((c) => c.kind === 'fallback' || !c.passed)
    .slice(0, 12)
    .map((c) => `${c.name}: ${c.detail ?? 'failed'}`)
}

function attemptOf(result: ScoredBreakdown): { score: number; failing: string[] } {
  return { score: result.score, failing: failingRows(result.checks) }
}

/**
 * Probe the browser until the known-good page passes. A failed probe discards
 * the browser, waits the next backoff, and tries again. After the last retry the
 * sweep stops: a record scored on a machine that cannot keep time is not written.
 */
async function probeOrStop(
  phase: ScoringProbePhase,
  probe: () => Promise<ProbeOutcome>,
  backoffMs: readonly number[],
  emit: (event: ScoringEvent) => void,
  sleep: (ms: number) => Promise<void>,
  task: BenchmarkTask
): Promise<void> {
  const when = PROBE_PHASE_TEXT[phase]
  for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
    const outcome = await probe()
    emit({ type: 'scoringProbe', phase, attempt, ok: outcome.ok, failing: outcome.failing.slice(0, 12) })
    if (outcome.ok) return
    if (outcome.fatal) {
      throw new BrowserFallbackError(
        `the known-good browser probe could not start a browser while scoring task ${task.id} (${outcome.failing.join('; ')}). ` +
          'The sweep stopped and wrote no record for this model and task. Install the browser (see the preflight message) and rerun with --resume.'
      )
    }
    if (attempt > backoffMs.length) break
    const waitMs = backoffMs[attempt - 1]!
    console.warn(
      `[harness] known-good browser probe failed (${when} ${task.id}, attempt ${attempt}): ` +
        `${outcome.failing.join('; ') || 'no detail'}. Waiting ${waitMs} ms before trying again.`
    )
    await discardSandboxBrowser()
    await sleep(waitMs)
  }
  throw new BrowserFallbackError(
    `the known-good browser probe failed ${backoffMs.length + 1} times while scoring task ${task.id} (${when}). ` +
      'The machine could not keep time for a browser score, so the sweep stopped and wrote no record for this model and task. ' +
      'Rerun with --resume when the machine is idle.'
  )
}

/** The probe phases, and how each reads in a message. */
type ScoringProbePhase = 'before' | 'after' | 'rescore'
const PROBE_PHASE_TEXT: Record<ScoringProbePhase, string> = {
  before: 'before the artifacts',
  after: 'after the artifacts',
  rescore: 'before a timeout rescore',
}

/**
 * Score every output with `breakdown`, one at a time, enforcing the rules above.
 * Returns the breakdowns in input order. Throws BrowserFallbackError when the
 * chromium backend cannot run an artifact on a fresh browser, or the probe cannot
 * pass on a machine that is given time to recover.
 */
export async function scoreBreakdownsOrStop(
  breakdown: BreakdownFn,
  outputs: readonly string[],
  task: BenchmarkTask,
  options: ScoringOptions = {}
): Promise<ScoredBreakdown[]> {
  const emit = options.log ?? (() => {})
  const sleep = options.sleep ?? defaultSleep
  const rescoreDelayMs = options.rescoreDelayMs ?? RESCORE_DELAY_MS
  const iterationOf = (i: number) => options.iterationIndexes?.[i] ?? i
  const chromium = resolveSandboxPolicy().backend === 'chromium'

  return withScoringSlot(async (waitMs, concurrency) => {
    emit({ type: 'scoringWait', artifacts: outputs.length, waitMs, concurrency })

    const probing = chromium && options.probe !== undefined
    if (probing) {
      await probeOrStop('before', options.probe!, options.probeBackoffMs ?? PROBE_BACKOFF_MS, emit, sleep, task)
    }

    // Serial: one artifact's checks finish before the next artifact's page opens.
    const results: ScoredBreakdown[] = []
    for (const output of outputs) results.push(await breakdown(output, task))

    // A check that could not finish is rescored once on a fresh page, after a
    // short wait. Both attempts are logged; the rescore's result stands.
    //
    // A rescore that ALSO ran out of time is a machine fault, not the artifact's
    // result: a browser under load times out on a page that works on an idle
    // machine (the 30 that a busy machine used to publish for a working WebGL
    // artifact). So the browser is dropped, the sweep waits the first probe
    // backoff and probes the machine, and the artifact is rescored once more. A
    // timeout that survives that stops the sweep: no record is written.
    const backoffMs = options.probeBackoffMs ?? PROBE_BACKOFF_MS
    for (const [i, first] of results.entries()) {
      if (!hasTimeoutRow(first.checks) || browserRunFallbackReason(first.checks) !== undefined) continue
      await sleep(rescoreDelayMs)
      const second = await breakdown(outputs[i]!, task)
      emit({
        type: 'rescore',
        iterationIndex: iterationOf(i),
        reason: 'timeout',
        waitMs: rescoreDelayMs,
        first: attemptOf(first),
        second: attemptOf(second),
      })
      results[i] = second
      if (!hasTimeoutRow(second.checks) || browserRunFallbackReason(second.checks) !== undefined) continue

      const waitMs = backoffMs[0] ?? 0
      console.warn(
        `[harness] artifact ${iterationOf(i)} of ${task.id} timed out again on the rescore: ` +
          `the machine is not keeping time. Waiting ${waitMs} ms, probing the browser, and rescoring once more.`
      )
      await discardSandboxBrowser()
      await sleep(waitMs)
      if (probing) {
        await probeOrStop('rescore', options.probe!, backoffMs, emit, sleep, task)
      }
      const third = await breakdown(outputs[i]!, task)
      emit({
        type: 'rescore',
        iterationIndex: iterationOf(i),
        reason: 'timeout',
        waitMs,
        first: attemptOf(second),
        second: attemptOf(third),
      })
      results[i] = third
      if (hasTimeoutRow(third.checks) && browserRunFallbackReason(third.checks) === undefined) {
        throw new BrowserFallbackError(
          `task ${task.id}, artifact ${iterationOf(i)}: a check still did not finish after two rescores, a ${waitMs} ms wait ` +
            'and a probe on a fresh browser. The machine could not keep time for a browser score, so the sweep stopped and ' +
            'wrote no record for this model and task. Rerun with --resume when the machine is idle.'
        )
      }
    }

    // The browser disconnected while an artifact ran. Relaunch and rescore that
    // artifact once; a second fallback stops the sweep.
    const failing = results.flatMap((r, i) => (browserRunFallbackReason(r.checks) !== undefined ? [i] : []))
    if (failing.length > 0 && chromium) {
      await discardSandboxBrowser()
      console.warn(
        `[harness] browser discarded and relaunched for ${task.id}: ${failing.length} artifact(s) fell back to structure`
      )
      for (const i of failing) {
        const first = results[i]!
        results[i] = await breakdown(outputs[i]!, task)
        emit({
          type: 'rescore',
          iterationIndex: iterationOf(i),
          reason: 'browser-disconnected',
          waitMs: 0,
          first: attemptOf(first),
          second: attemptOf(results[i]!),
        })
      }

      const stillFailing = failing.find((i) => browserRunFallbackReason(results[i]!.checks) !== undefined)
      if (stillFailing !== undefined) {
        const reason = browserRunFallbackReason(results[stillFailing]!.checks)
        throw new BrowserFallbackError(
          `behavioural scoring of task ${task.id} fell back to structure on a fresh browser as well ` +
            `(${reason}). The sweep stopped and wrote no record for this model and task. ` +
            'Fix the browser (see the preflight message) and rerun with --resume.'
        )
      }
    }

    // The artifacts were rendered in the browser: a failed row may be the machine
    // rather than the artifact, so the probe runs again before the record is written.
    if (probing && results.some((r) => hasFailingCheck(r.checks))) {
      await probeOrStop('after', options.probe!, options.probeBackoffMs ?? PROBE_BACKOFF_MS, emit, sleep, task)
    }

    return results
  })
}
