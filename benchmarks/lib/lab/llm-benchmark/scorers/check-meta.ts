/**
 * The check vocabulary: what a behavioural check is, and how it declares its
 * name and point budget.
 *
 * This module is dependency-free at run time (the only import is a type), so
 * plugin check files can import `defineCheck` from here without reaching the
 * Playwright backend that `sandbox.ts` carries. Plugin registration and the
 * client bundle depend on that: see `plugins/registry.ts`.
 */
import type { Page } from 'playwright'

/**
 * Capture options. `canvasOnly` is WITHDRAWN: the canvas-only capture (hide
 * every other element, then screenshot) was reverted in scorer version 2, and
 * `captureCanvas` throws when it is set. The field stays in the type only so
 * the `CheckContext` signature does not change under the plugins that import
 * it. Every capture is the element's region (`canvas.screenshot`). Version 1
 * records dated 2026-09-22 and later (the capture is in commit 30f76c4, dated
 * 2026-10-16) were measured with the element capture; earlier ones with
 * `canvas.toDataURL`. scorer-changelog.md states which records were made under which.
 */
export interface CanvasCaptureOptions {
  canvasOnly?: boolean
}

export interface CheckContext {
  /** The loaded page. */
  page: Page
  /**
   * The artifact HTML, in case checks need to re-inject or inspect it. Always
   * the RAW model output — under `BENCH_PRELUDE_PARITY=1` the page is loaded
   * with the display prelude wrapped around it, but a check that greps this
   * field is asking about what the MODEL wrote, and would otherwise start
   * matching the harness's own injected `<style>`/`<script>`.
   */
  html: string
  /** Helper to capture canvas pixels as a binary buffer + dimensions. */
  captureCanvas(
    canvasSelector?: string,
    options?: CanvasCaptureOptions
  ): Promise<{ width: number; height: number; data: Buffer } | undefined>
}

export interface CheckResult {
  /** Short, stable name (used in reports and the composite score). */
  name: string
  /** True if the check passed. */
  passed: boolean
  /** Points awarded for this check (0 if failed). */
  points: number
  /** Max points this check is worth. */
  maxPoints: number
  /** Free-text detail for the report. */
  detail?: string
  /**
   * `'fallback'` marks a row about the HARNESS, not the artifact: nothing was
   * judged (e.g. the behavioural run never started). Such a row always carries
   * `maxPoints: 0`. See `isFallbackCheck` in `../types.ts`.
   */
  kind?: 'fallback'
}

/**
 * Static metadata a check carries so that a run which cannot execute it still
 * records what it was worth. Without it, a check that throws, times out or is
 * skipped would be recorded with `maxPoints: 0`, drop out of the composite
 * denominator, and let the artifact score HIGHER than when the check failed
 * cleanly.
 */
export interface CheckMeta {
  /** Stable check name; copied into every result row for this check. */
  checkName?: string
  /** The point budget this check is worth; copied into failure rows. */
  maxPoints?: number
}

export type CheckFn = CheckMeta & ((ctx: CheckContext) => Promise<CheckResult>)

/**
 * Attach a name and a point budget to a check function. The function is
 * returned as the same object (metadata is stamped onto it), so a registry or
 * a task list that holds the return value holds the stamped check.
 */
export function defineCheck(
  name: string,
  maxPoints: number,
  fn: (ctx: CheckContext) => Promise<CheckResult>
): CheckFn {
  if (!name) throw new Error('defineCheck: a check needs a non-empty name')
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
    throw new Error(`defineCheck('${name}'): maxPoints must be a positive number, got ${String(maxPoints)}`)
  }
  const existing = (fn as CheckMeta).checkName
  if (existing !== undefined && existing !== name) {
    throw new Error(`defineCheck('${name}'): function is already named '${existing}'`)
  }
  return Object.assign(fn, { checkName: name, maxPoints })
}
