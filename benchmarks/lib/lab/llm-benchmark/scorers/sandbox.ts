import type { Page } from 'playwright'

import { withPrelude } from '../frame-prelude'
import { closeSandboxBackend, getSandboxBackend, resolveSandboxPolicy } from './sandbox-backend'
import {
  defineCheck,
  type CanvasCaptureOptions,
  type CheckContext,
  type CheckFn,
  type CheckMeta,
  type CheckResult,
} from './check-meta'

// The check vocabulary lives in check-meta.ts; re-exported here so existing
// callers keep their imports.
export { defineCheck }
export type { CanvasCaptureOptions, CheckContext, CheckFn, CheckMeta, CheckResult }

/**
 * Behavioral scoring sandbox: load an artifact, drive it, report what it did.
 *
 * Loads artifact HTML into a real browser page (sandboxed, no same-origin
 * access to the benchmark host) and runs a set of check functions that
 * interact with the page — dispatching keys, reading pixels, and asserting
 * that the page responds. This catches the class of failure that a
 * structural HTML scorer misses: a page that parses cleanly but whose
 * JavaScript is broken (e.g. mini-platformer where Space doesn't jump).
 *
 * WHICH browser (or none at all) is the backend's business, not this module's
 * — see `sandbox-backend.ts` for the seam, the `BENCH_SANDBOX` vocabulary and
 * the enforcement report. The browser is shared across all checks within a
 * single process for speed (cold start ~1s; subsequent page loads ~50ms), so
 * callers MUST call `closeSandbox()` when done (typically from a top-level CLI
 * script or after the rescore batch finishes).
 *
 * Why a real browser (and not jsdom): real canvas rendering, real keyboard
 * events that hit the game's listeners, real RAF, and pixel diffs that
 * actually reflect what a user sees. When no browser is available, the honest
 * answer is "the behavioural checks did not run" (the structural backend +
 * `behaviouralFallback`), not a DOM emulation whose verdicts nobody should
 * trust.
 */

/** Close whatever browser the backend launched. Idempotent. */
export async function closeSandbox(): Promise<void> {
  await closeSandboxBackend()
}

/**
 * The row recorded when a check could not run to completion. It carries the
 * check's declared name and budget with zero points, so the composite keeps
 * the weight the check was given.
 */
function failedCheckRow(check: CheckFn, detail: string): CheckResult {
  return {
    name: check.checkName || check.name || 'unnamed-check',
    passed: false,
    points: 0,
    maxPoints: check.maxPoints ?? 0,
    detail,
  }
}

/**
 * A row a check returned, held to the check's own declaration. A check declared
 * with a name and budget must report that name and that budget: a row that
 * disagrees is recorded as a failure of the check (the artifact is not blamed
 * for a harness mismatch, but nor can a disagreeing row move the composite).
 * Points are clamped to 0..budget, so an over-award cannot exceed the budget.
 */
function reconcileRow(check: CheckFn, row: CheckResult): CheckResult {
  if (check.checkName === undefined && check.maxPoints === undefined) return row
  const budget = check.maxPoints
  if (row.name !== check.checkName || (budget !== undefined && row.maxPoints !== budget)) {
    return failedCheckRow(
      check,
      `returned row disagrees with declaration: reported ${row.name} worth ${row.maxPoints}, ` +
        `declared ${check.checkName ?? '(unnamed)'} worth ${String(budget)}`
    )
  }
  const points = Math.min(Math.max(row.points, 0), row.maxPoints)
  return points === row.points ? row : { ...row, points }
}

export interface RunChecksOptions {
  /** Time to wait after page load for init/RAF before any check runs (ms). */
  settleMs?: number
  /** Per-check timeout (ms). */
  perCheckTimeoutMs?: number
  /** Total timeout for the whole run (ms). */
  totalTimeoutMs?: number
}

/**
 * Load the artifact in a fresh page and run the provided checks. Returns
 * one result per check. A thrown check (timeout, page error, assertion
 * failure) is converted to a failed CheckResult rather than aborting the
 * whole batch — so one broken check doesn't hide the others.
 */
export async function runChecks(
  html: string,
  checks: CheckFn[],
  options: RunChecksOptions = {}
): Promise<CheckResult[]> {
  const { settleMs = 800, perCheckTimeoutMs = 20_000, totalTimeoutMs = 90_000 } = options
  const session = await getSandboxBackend().launch()
  // Whether the BROWSER is still there. Read from the Browser object only: a page
  // that closed itself, or an error that mentions a closed page, is the artifact's
  // behaviour and is scored as failed checks, never as a dead browser.
  const alive = () => session.isConnected?.() !== false
  const context = await session.newContext({
    // The check page is a TOP-LEVEL document in a fresh browser context. It is
    // NOT the site's sandboxed iframe (sandbox="allow-scripts"): what the
    // backend actually enforces is reported by sandbox-backend.ts, not here.
    bypassCSP: false,
    viewport: { width: 1024, height: 720 },
  })
  const page = await context.newPage()

  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(e.message))

  // Scorer/display parity, OFF by default (#12). The live frame and the
  // published .html load `withPrelude(html)`; the scorer historically loaded
  // the RAW artifact, so checks ran in a different environment from the one
  // readers see. `BENCH_PRELUDE_PARITY=1` closes that gap — deliberately opt-in,
  // because flipping it silently would shift every stored behavioural score.
  // Which mode scored a record is recorded in its run log's `sandboxPolicy`
  // event; the measured per-case effect is in
  // docs/lab/llm-benchmark/prelude-parity-measurement.md.
  const loaded = resolveSandboxPolicy().preludeParity ? withPrelude(html) : html

  try {
    await page.setContent(loaded, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    // Give the page a beat to run init / first RAF tick.
    await page.waitForTimeout(settleMs)
  } catch (e) {
    await page.close().catch(() => {})
    await context.close().catch(() => {})
    const message = e instanceof Error ? e.message : String(e)
    // A browser that went away while the page loaded did not fail the artifact.
    if (!alive()) throw browserGoneError(message)
    return checks.map((c) => failedCheckRow(c, `page load failed: ${message}`))
  }

  const captureCanvas: CheckContext['captureCanvas'] = async (selector = 'canvas', options = {}) => {
    // The canvas-only capture (hide every other element, then screenshot) was
    // withdrawn in scorer version 2. Refuse it rather than quietly take a
    // page-region capture in its place, so no check can believe it measured
    // the canvas alone when it did not.
    if (options.canvasOnly) {
      throw new Error('captureCanvas: canvasOnly was withdrawn; capture the element with captureCanvas(selector)')
    }
    const canvas = page.locator(selector).first()
    if (await canvas.count() === 0) return undefined
    // Read the displayed frame. WebGL commonly clears its drawing buffer
    // after presentation, making toDataURL() return a blank PNG even while
    // the user sees continuous animation (preserveDrawingBuffer defaults off).
    const buf = await canvas.screenshot({ timeout: 5000 })
    // Decode PNG header for width/height rather than pulling in a full parser:
    // the harness only needs width/height for diff reporting; pixel data is
    // already in the buffer for downstream consumers.
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return { width, height, data: buf }
  }

  const ctx: CheckContext = { page, html, captureCanvas }

  const results: CheckResult[] = []
  const batchStart = Date.now()
  for (const check of checks) {
    if (Date.now() - batchStart > totalTimeoutMs) {
      results.push(failedCheckRow(check, 'skipped: batch timeout'))
      continue
    }
    let checkTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = await Promise.race([
        check(ctx),
        new Promise<CheckResult>((_, reject) => {
          checkTimer = setTimeout(() => reject(new Error(`check timeout after ${perCheckTimeoutMs}ms`)), perCheckTimeoutMs)
        }),
      ])
      results.push(reconcileRow(check, res))
    } catch (e) {
      results.push(failedCheckRow(check, `threw: ${e instanceof Error ? e.message : String(e)}`))
    } finally {
      if (checkTimer !== undefined) clearTimeout(checkTimer)
    }
  }

  if (consoleErrors.length > 0) {
    // Attach (don't overwrite) a synthetic check capturing runtime errors —
    // these often explain why behavioral checks fail.
    results.push({
      name: 'no-runtime-errors',
      passed: false,
      points: 0,
      maxPoints: 0,
      detail: `page errors: ${consoleErrors.slice(0, 3).join(' | ')}`,
    })
  }

  await page.close().catch(() => {})
  await context.close().catch(() => {})
  // A check that threw because the browser died under it is not an artifact
  // failure. The run fails as a whole, so the caller falls back to a visible
  // `behavioural-run` row and the sweep can relaunch and rescore it. Decided from
  // the browser's connection only, so a page that closed itself stays a row.
  if (!alive()) throw browserGoneError('the browser disconnected')
  return results
}

/**
 * The error a run throws when the browser closed while it ran. The text starts
 * with the word the scorer's fallback row uses for a failed run, so the record
 * says what happened.
 */
function browserGoneError(detail: string): Error {
  return new Error(`the browser closed while the checks ran (${detail})`)
}
