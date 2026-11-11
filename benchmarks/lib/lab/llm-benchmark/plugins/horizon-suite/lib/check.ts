/**
 * defineCheck: the one way a horizon-suite check is declared.
 *
 * The wrapper gives every check the same guarantees, whatever the check does:
 *  - a check that throws, or misses its own 4.5 s deadline, FAILS and keeps its
 *    full maxPoints (never maxPoints 0), so an artifact cannot shrink the
 *    denominator by breaking a check;
 *  - on a deadline it sets an aborted flag the run can poll (tools.aborted()),
 *    then probes the page with a 500 ms evaluate; if the probe fails the page is
 *    marked poisoned (WeakMap keyed by Page) and every later check on that page
 *    fails fast with its full budget;
 *  - a timeout-shaped error (a probe or a bounded action that ran out of time)
 *    gets the same 500 ms probe, so a wedged page is poisoned after one check, not
 *    after every remaining check has waited out its own timer;
 *  - a check whose predecessor on the same page is still running (it gave up at
 *    its deadline but its code has not returned) waits up to 1 s for that run to
 *    settle; if it does not, this check fails with its full budget and the page
 *    is poisoned, so an abandoned run never acts on the page during a later check;
 *  - once 20 s have passed since the first check on a page, later checks fail fast
 *    with their full budget, before the harness's own batch budget skips them.
 *
 * A run returns { passed, detail? } or a plain boolean. Keep details short and
 * state the measured value and the bound, e.g. "energy drift 3.1e-5 > 2e-6".
 */
import type { Page } from 'playwright'
import { defineCheck as defineHarnessCheck, type CheckContext, type CheckFn, type CheckResult } from '../../../scorers/check-meta'
import { probe } from './probe'

export type { CheckContext, CheckFn, CheckResult } from '../../../scorers/check-meta'

export const CHECK_DEADLINE_MS = 4_500
export const POISON_PROBE_MS = 500
export const PAGE_BUDGET_MS = 20_000
/** How long a check waits for an abandoned predecessor on the same page to return. */
export const ABANDON_WAIT_MS = 1_000
const MAX_DETAIL_CHARS = 240
const TIMEOUT_SHAPE = /timed out|Timeout\b.*exceeded/i

/** What a running check can see about its own deadline. */
export interface CheckTools {
  /** True once the wrapper has given up on this run. Poll it between steps. */
  aborted(): boolean
  /** Milliseconds left before the 4.5 s deadline (never negative). */
  remainingMs(): number
}

export type CheckOutcome = boolean | { passed: boolean; detail?: string }

export type CheckRun = (ctx: CheckContext, tools: CheckTools) => Promise<CheckOutcome> | CheckOutcome

interface PageState {
  firstAt: number
  poisoned: string | undefined
  /** The most recent run on this page. Its promise never rejects. */
  active: { name: string; settled: Promise<unknown> } | undefined
}

const pageStates = new WeakMap<Page, PageState>()

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function clip(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : text.slice(0, MAX_DETAIL_CHARS - 3) + '...'
}

function normalise(value: unknown): { passed: boolean; detail?: string } {
  if (typeof value === 'boolean') return { passed: value }
  if (typeof value === 'object' && value !== null && typeof (value as { passed?: unknown }).passed === 'boolean') {
    const v = value as { passed: boolean; detail?: unknown }
    return v.detail === undefined ? { passed: v.passed } : { passed: v.passed, detail: String(v.detail) }
  }
  return { passed: false, detail: 'check returned neither a boolean nor { passed }' }
}

/** Resolves true when the promise settles within ms, false otherwise. Never rejects. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms))
  })
  return Promise.race([promise.then(() => true), late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function responds(page: Page): Promise<boolean> {
  return probe(page, '() => 1', undefined, POISON_PROBE_MS).then(
    () => true,
    () => false
  )
}

/**
 * Run one check under the wrapper's guarantees. Exported for the kit's own tests;
 * checks reach it through defineCheck.
 */
export async function runGuarded(
  name: string,
  maxPoints: number,
  ctx: CheckContext,
  run: CheckRun
): Promise<CheckResult> {
  const row = (passed: boolean, detail?: string): CheckResult => ({
    name,
    passed,
    points: passed ? maxPoints : 0,
    maxPoints,
    ...(detail === undefined ? {} : { detail: clip(detail) }),
  })
  const page = ctx.page
  const now = Date.now()
  let state = pageStates.get(page)
  if (state === undefined) {
    state = { firstAt: now, poisoned: undefined, active: undefined }
    pageStates.set(page, state)
  }
  if (state.poisoned !== undefined) {
    return row(false, `skipped: page unresponsive after ${state.poisoned}`)
  }
  if (now - state.firstAt > PAGE_BUDGET_MS) {
    return row(false, `skipped: page budget of ${PAGE_BUDGET_MS} ms already spent`)
  }

  let aborted = false
  const deadline = now + CHECK_DEADLINE_MS
  const tools: CheckTools = {
    aborted: () => aborted,
    remainingMs: () => Math.max(0, deadline - Date.now()),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  // The deadline starts now, so waiting for an abandoned predecessor uses the same window.
  const timedOut = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), CHECK_DEADLINE_MS)
  })

  try {
    const previous = state.active
    if (previous !== undefined) {
      const quiet = await Promise.race([
        settlesWithin(previous.settled, Math.min(ABANDON_WAIT_MS, tools.remainingMs())),
        timedOut.then(() => false),
      ])
      if (!quiet) {
        aborted = true
        state.poisoned = `${previous.name} (still acting on the page after its deadline)`
        return row(false, `previous check ${previous.name} still acting on the page`)
      }
    }

    // Captures a synchronous throw as well as a rejection, so nothing escapes unhandled.
    const running = Promise.resolve()
      .then(() => run(ctx, tools))
      .then(
        (value) => ({ kind: 'value' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error })
      )
    state.active = { name, settled: running }

    const outcome = await Promise.race([running, timedOut])
    if (outcome === 'deadline') {
      aborted = true
      if (!(await responds(page))) state.poisoned = `${name} (deadline, no response to a ${POISON_PROBE_MS} ms probe)`
      return row(
        false,
        `deadline: no result within ${CHECK_DEADLINE_MS} ms` + (state.poisoned === undefined ? '' : '; page unresponsive')
      )
    }
    if (outcome.kind === 'error') {
      const text = message(outcome.error)
      if (TIMEOUT_SHAPE.test(text) && !(await responds(page))) {
        state.poisoned = `${name} (${clip(text)}; no response to a ${POISON_PROBE_MS} ms probe)`
      }
      return row(false, `threw: ${text}`)
    }
    const result = normalise(outcome.value)
    return row(result.passed, result.detail)
  } catch (error) {
    return row(false, `threw: ${message(error)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Declare a horizon-suite check: a name, the points it is worth, the reason it
 * exists, and its run function. Returns a CheckFn carrying checkName and
 * maxPoints, plus the rationale, for the harness and the fixture matrix.
 */
export function defineCheck(
  name: string,
  maxPoints: number,
  rationale: string,
  run: CheckRun
): CheckFn & { rationale: string } {
  if (!rationale) throw new Error(`defineCheck('${name}'): a rationale is required`)
  const check = defineHarnessCheck(name, maxPoints, (ctx) => runGuarded(name, maxPoints, ctx, run))
  return Object.assign(check, { rationale })
}

/** Test seam: the page state recorded for a page, if any check has run on it. */
export function pageStateFor(page: Page): { poisoned: string | undefined; firstAt: number } | undefined {
  return pageStates.get(page)
}
