import { BEHAVIOURAL_RUN_CHECK, type BenchmarkTask, type IterationCheckResult, type Scorer } from '../types'
import { htmlScorer } from './html'
import { getChecksForTask } from './checks'
import { runChecks, type CheckFn, type CheckResult } from './sandbox'

/**
 * Composite behavioral scorer.
 *
 * Replaces the pure-structural `htmlScorer` for the interactive benchmark
 * tasks. The structural score is kept as a 30% floor (it still catches
 * malformed markup) but the headline number comes from real Playwright
 * behavioral checks (70%) — does Space actually jump the player, does the
 * canvas re-render after an input change, etc.
 *
 * The composite is 0..100 with this weighting:
 *   - 70% from behavioural checks (Playwright runs the artifact and asserts)
 *   - 30% from structural HTML heuristics (existing `htmlScorer`)
 *
 * If Playwright is unavailable (e.g. browser binary missing in CI), the
 * scorer falls back to the structural score and tags the result with a
 * `fallbackReason`. The breakdown then carries one `behavioural-run` row with
 * `kind: 'fallback'`, so the stored record says that no behavioural check ran
 * (the same shape the executable scorer uses for `code-fallback`).
 *
 * Caching: `result.cached` is set true on the BenchmarkResult when this
 * scorer is used with `useCache`, so a re-rescore batch doesn't relaunch
 * the browser for unchanged artifacts. The cache key is a sha256 of the
 * artifact HTML + the task id + a content-version stamp; bumps force a
 * recompute.
 */

const STRUCTURAL_WEIGHT = 0.3
const BEHAVIORAL_WEIGHT = 0.7

/**
 * The one row a fallback leaves in the breakdown. A harness row, not an
 * artifact check: `kind: 'fallback'`, `maxPoints: 0`, so it cannot move the
 * composite and `isFallbackCheck` (types.ts) keeps it out of failure evidence.
 */
export { BEHAVIOURAL_RUN_CHECK }

interface BehavioralScoreOptions {
  /** Per-task check timeout in ms (forwarded to runChecks). */
  perCheckTimeoutMs?: number
  /**
   * TEST SEAM (not exported). Score with these checks instead of the task's own.
   * See `scoreWithChecksForTesting`.
   */
  checks?: CheckFn[]
}

/** The fallback row a behavioural run leaves, with the reason it is a fallback. */
function fallbackRow(detail: string): CheckResult {
  return { name: BEHAVIOURAL_RUN_CHECK, passed: false, points: 0, maxPoints: 0, kind: 'fallback', detail }
}

interface BehavioralScoreResult {
  score: number
  structural: number
  behavioral: number
  behavioralMax: number
  checks: CheckResult[]
  fallbackReason?: string
}

async function scoreBehavioral(
  html: string,
  task: BenchmarkTask,
  options: BehavioralScoreOptions = {}
): Promise<BehavioralScoreResult> {
  const checks = options.checks ?? getChecksForTask(task)
  const structural = htmlScorer.score(html, task) as number

  if (checks.length === 0) {
    // No behavioural spec for this task yet — fall back to structural.
    // The same harness row a browser failure leaves, so a no-checks record and a
    // no-browser record read the same way in the stored breakdown.
    const fallbackReason = 'no behavioural checks defined for task'
    return {
      score: structural,
      structural,
      behavioral: 0,
      behavioralMax: 0,
      checks: [fallbackRow(fallbackReason)],
      fallbackReason,
    }
  }

  try {
    const results = await runChecks(html, checks, {
      settleMs: 600,
      perCheckTimeoutMs: options.perCheckTimeoutMs ?? 6000,
      totalTimeoutMs: 25_000,
    })
    const behavioralMax = results.reduce((s, r) => s + r.maxPoints, 0)
    const behavioral = results.reduce((s, r) => s + r.points, 0)
    const behaviouralScore = behavioralMax > 0 ? (behavioral / behavioralMax) * 100 : 0
    const score = Math.round(
      behaviouralScore * BEHAVIORAL_WEIGHT + structural * STRUCTURAL_WEIGHT
    )
    return { score, structural, behavioral, behavioralMax, checks: results }
  } catch (e) {
    // Playwright failed (no browser, timeout, etc.) — fall back to structural
    // but flag it so the report can call out which records lack behavioural
    // coverage. The breakdown keeps the reason as a row, not only as a field
    // the caller may drop.
    const fallbackReason = `behavioural run failed: ${e instanceof Error ? e.message : String(e)}`
    return {
      score: structural,
      structural,
      behavioral: 0,
      behavioralMax: 0,
      checks: [fallbackRow(fallbackReason)],
      fallbackReason,
    }
  }
}

export const behavioralScorer: Scorer = {
  score: async (output: string, task: BenchmarkTask): Promise<number> => {
    const result = await scoreBehavioral(output, task)
    return result.score
  },
  scoreWithBreakdown: async (
    output: string,
    task: BenchmarkTask
  ): Promise<{ score: number; checks: IterationCheckResult[] }> => {
    const result = await scoreBehavioral(output, task)
    return { score: result.score, checks: toIterationCheckResults(result.checks) }
  },
}

/**
 * Map sandbox CheckResults to the persisted IterationCheckResult shape (the
 * fields are identical; this keeps the persisted record free of Playwright
 * types).
 */
function toIterationCheckResults(checks: CheckResult[]): IterationCheckResult[] {
  return checks.map((c) => ({
    name: c.name,
    passed: c.passed,
    points: c.points,
    maxPoints: c.maxPoints,
    detail: c.detail,
    ...(c.kind === undefined ? {} : { kind: c.kind }),
  }))
}

/**
 * Standalone helper: score one artifact and return the full breakdown (used
 * by the rescore CLI and the reporting layer). Returns the composite score
 * alongside the structural and behavioural components so the caller can
 * surface *why* a record scored the way it did.
 */
export async function scoreWithBreakdown(
  html: string,
  task: BenchmarkTask,
  options: { perCheckTimeoutMs?: number } = {}
): Promise<BehavioralScoreResult> {
  return scoreBehavioral(html, task, options)
}

/**
 * TEST SEAM. Score with `checks` in place of the task's own, so a test can inject
 * a check that throws or fails and see the composite react, against a real page.
 * Nothing in production calls it: the rescore, backfill and sweep paths use
 * `scoreWithBreakdown` and the task's registered checks.
 */
export async function scoreWithChecksForTesting(
  html: string,
  task: BenchmarkTask,
  checks: CheckFn[]
): Promise<BehavioralScoreResult> {
  return scoreBehavioral(html, task, { checks })
}

export type { BehavioralScoreResult }
