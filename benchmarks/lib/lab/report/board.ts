/**
 * Data layer for the static benchmark report.
 *
 * `buildBoard()` turns raw `results.json` records, the registry and optional
 * per-cell signals into the one object the report page reads. It is pure: no
 * file access, no network, no model calls. `report/build-data.mjs` does the I/O.
 *
 * Every number on the board is either measured (from a live record) or null.
 * Insights are computed sentences; a sentence whose data is missing is omitted.
 */
import { createHash } from 'node:crypto'
import type {
  BenchmarkCategory,
  BenchmarkModel,
  BenchmarkResult,
  BenchmarkTask,
  IterationCheckResult,
} from '../llm-benchmark/types'
import { isFallbackCheck } from '../llm-benchmark/types'

export const SCHEMA_VERSION = 3
export const BOOTSTRAP_RESAMPLES = 2000
/** Fewer measured iteration values than this and the interval is null. */
export const MIN_INTERVAL_VALUES = 6
/** A model must cover at least this share of a scope's tasks to be ranked. */
export const COVERAGE_SHARE = 0.8
/** The cheapest-within-N-points insight uses this margin. */
export const VALUE_MARGIN_POINTS = 5
/** The spread insight lists tasks where every focus model reached this score. */
export const EVERY_MODEL_BAR = 95
/** Each call may produce up to this many output tokens (reasoning included). An iteration that reaches it is truncated. */
export const OUTPUT_CAP_TOKENS = 128000
/** The cap of the first pass. Every model and task pair that reached it was run again under OUTPUT_CAP_TOKENS. */
export const FIRST_PASS_CAP_TOKENS = 64000
/** An interval at least this many points wide is too variable to rank a configuration by. */
export const WIDE_INTERVAL_POINTS = 40
/** A task counts as trailing the top when the cheapest covered model scores this many points or more below the top on it. */
export const TRAIL_POINTS = 10
/** The score a model reaches on every iteration of a task at the ceiling. */
export const CEILING = 100

/** Effort levels from least to most. Unknown levels sort last. */
export const EFFORT_ORDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const API_PROVIDERS = new Set(['OpenAI', 'Anthropic', 'Google', 'Moonshot AI', 'OpenRouter'])
const LOCAL_PROVIDERS = new Set(['Ollama', 'Local'])

export type Suite = 'horizon' | 'classic' | 'smoke'
/**
 * headline, horizon and smoke hold only records scored by the current scorer (version 2 or later). horizon is the
 * seven Horizon tasks, a subset of headline. earlier holds the version 1 records, every task, and is labelled as not
 * comparable with the others.
 */
export type Scope = 'headline' | 'horizon' | 'smoke' | 'earlier'
export type Access = 'api' | 'cli' | 'local'
export type Group = 'claude' | 'other'
/** Model groups the page filters by. 'claude' is the Claude family; 'all' is every model. */
export type GroupKey = 'claude' | 'all'
export const GROUP_KEYS: readonly GroupKey[] = ['claude', 'all']
export const SCOPE_KEYS: readonly Scope[] = ['headline', 'horizon', 'smoke', 'earlier']
/** The scorer version the headline and smoke scopes use. Records below it are never averaged with it. */
export const CURRENT_SCORER_VERSION = 2
/** The exact definition of cost per attempt, shown wherever cost is shown. */
export const COST_PER_ATTEMPT_DEFINITION =
  'Cost per attempt: a cell’s billed cost divided by the iterations requested for that cell, with failed and truncated iterations counted in the division, because they are billed. A model’s cost per attempt is the mean of its cells’ values over the cells in scope. A cell in which every iteration failed still has a cost per attempt. Not measured for a model with no per-token price.'
export type Interval = [number, number]
/**
 * How a model's cost is known. Only 'priced' models have a cost per token in the registry.
 * 'no-per-token-price' covers free tiers, subscription command-line routes and local models.
 * 'price-under-review' is a positive price below one cent per million tokens, which is far
 * below every comparable entry and usually means a per-1k value was entered as a per-token one.
 */
export type PricingState = 'priced' | 'no-per-token-price' | 'price-under-review'
/** A positive registry price below this (USD per million tokens) puts the model under review. */
export const PRICE_REVIEW_BELOW_PER_M = 0.01

/**
 * Shape of report/data/signals.json (optional; a missing file means no captures). A cell's captures are
 * attached only when `outputSha256` is the SHA-256 of the record's output that is on the board now.
 */
export interface SignalsFile {
  cells?: Record<
    string,
    { outputSha256?: string; shots?: string[]; captures?: CaptureNote[] }
  >
}

/**
 * Whether a cell's captures belong to the artifact on the board. `none`: no capture was recorded.
 * `out-of-date`: a capture exists for an earlier output (the record was re-run); it is not shown.
 */
export type CaptureStatus = 'current' | 'out-of-date' | 'none'

export interface BoardSuite {
  id: Suite
  label: string
  note: string
}

export interface BoardCategory {
  slug: string
  label: string
}

export interface BoardTaskCheck {
  name: string
  maxPoints: number
}

export interface BoardTask {
  id: string
  title: string
  category: string
  suite: Suite
  scorer: string | null
  headline: boolean
  checks: BoardTaskCheck[]
}

export interface BoardModel {
  id: string
  name: string
  company: string | null
  family: string | null
  provider: string
  baseModelId: string
  effort: string | null
  released: string | null
  priceInPerM: number
  priceOutPerM: number
  pricing: PricingState
  access: Access
  group: Group
}

export interface CellCheck {
  name: string
  passRate: number
  meanPoints: number
  maxPoints: number
  runs: number
}

export interface BoardCell {
  modelId: string
  taskId: string
  suite: Suite
  score: number
  scoreAllTrials: number
  /**
   * The iterations this cell counts as requested. For a stopped cell (see `stopped`) these are the iterations that ran:
   * the iterations the stop prevented are not requested, failed or scored.
   */
  iterations: number
  /** Set when the record stopped before its planned iterations ran (see stopOf). Null for every other cell. */
  stopped: CellStop | null
  /** The stop label, built here once (see stopLabel). Null when the cell did not stop. */
  stopLabel: string | null
  /** The sentence the page prints about a stopped cell (see stopSentence). Null when the cell did not stop. */
  stopSentence: string | null
  succeeded: number | null
  /**
   * Failed iterations that were output-cap truncations (counted as zero, and billed). A recorded reason of "truncated"
   * counts them; so does a cell with no completed iteration whose output is exactly the cap on every iteration.
   */
  truncatedIterations: number
  iterationScores: number[]
  status: string
  failureReason: string | null
  costUsd: number | null
  costPerIteration: number | null
  /** Null when no iteration completed: the record's totals then describe nothing measured. */
  tokensIn: number | null
  tokensOut: number | null
  /** The record's output tokens for the cell, billed whether or not an iteration completed. */
  billedTokensOut: number | null
  /** Null when no iteration completed (the record's runtime is then 0 and not a measurement). */
  runtimeMs: number | null
  ttftMs: number | null
  tokensPerSec: number | null
  rateKind: string | null
  usageSource: string | null
  createdAt: string
  scorerVersion: number
  checks: CellCheck[]
  /** Check rows the harness could not run (detail "threw: ..."), dropped from the check statistics. */
  checkRowsThrew: number
  /** True when the cell was scored by the structural fallback, not by a program check. */
  fallbackScored: boolean
  /** Whether the captures below were taken from this record's output. */
  captureStatus: CaptureStatus
  /** Captured images, in the order of `captures`: the desktop capture, then the phone-width capture. */
  shots: string[]
  /** What each capture is: viewport, time after load, and whether the task's showcase pose was applied. */
  captures: CaptureNote[]
}

/**
 * A cell whose record stopped before its planned iterations ran: the account's API spend limit or the sweep's spend cap
 * (`budgetExceeded`) or a provider quota (`quotaNextResetAt`). The stop is operational, not a model failure.
 */
export interface CellStop {
  /** The iterations the record planned. */
  planned: number
  /** Iterations that did not run: planned minus the ones that ran. */
  notRun: number
  /** Which field marked the stop. */
  by: 'budget' | 'quota'
}

/**
 * A live record that stopped before any iteration ran. It has nothing to measure, so it is not a measured cell: its cell
 * is drawn as not run, and it is named as a stopped cell with its label.
 */
export interface NotRunStop {
  modelId: string
  taskId: string
  suite: Suite
  scorerVersion: number
  stopped: CellStop
  label: string
}

/** One capture, described so the page can label it. */
export interface CaptureNote {
  /** The viewport the capture was taken at, for example "1024 x 720". */
  viewport: string
  /** Milliseconds from load to the screenshot, rounded to 100 ms; null when not measured. */
  afterLoadMs: number | null
  /** True when the task's showcase pose was applied before the capture. */
  posed: boolean
}

export interface BoardSummary {
  modelId: string
  scope: Scope
  tasksCovered: number
  tasksTotal: number
  meanScoreAllTrials: number
  interval: Interval | null
  /**
   * Plain mean, over the model's cells that have at least one completed iteration, of each
   * cell's score (the mean over completed iterations). Null when no cell completed.
   */
  meanScore: number | null
  successRate: number | null
  /** Total spend over every iteration of every priced cell in scope (not per run). */
  totalCostUsd: number | null
  /**
   * Cost per attempt: the plain mean, over the priced cells in scope, of each cell's cost divided
   * by its iteration count. A mean over tasks, so models with different iteration counts compare fairly.
   */
  costPerAttempt: number | null
  /** Cells in scope whose cost is measured; costPerAttempt is the mean over these. */
  pricedCells: number
  medianRuntimeMs: number | null
  medianTtftMs: number | null
  medianTokensPerSec: number | null
  /** Output tokens per attempt (each cell's output token total divided by its iteration count, then a plain mean over tasks). */
  outputTokensPerTask: number | null
  onFrontier: boolean
}

export interface BoardInsight {
  id: string
  /** The number the finding is about, as text (for example "98.5" or "31.6"). Set here, never read from the sentence. */
  figure: string
  /** The unit that goes with figure (for example "pts" or "% passed"). */
  figureUnit: string
  title: string
  body: string
  anchor: string
}

export interface Board {
  schemaVersion: number
  generatedAt: string
  source: {
    resultsSha256: string
    records: number
    liveRecords: number
    seededExcluded: number
    /** Requested iterations over the live cells, and those that completed. */
    iterationsRequested: number
    iterationsCompleted: number
    /** Iterations that stopped cells did not run: not requested, not failed and not scored. */
    iterationsNotRun: number
    /** Live cells whose record stopped before its planned iterations ran (see CellStop). */
    stoppedCells: number
    /** Live cells scored by the structural fallback (no program could be extracted). */
    fallbackCells: number
    /** Live cells that carry at least one named check row. */
    cellsWithCheckRows: number
    /** Scorer versions present among the live cells, with cell counts. */
    scorerVersions: Record<string, number>
    /** True when the board was built from invented results for layout checks. Never a result. */
    synthetic: boolean
    /** Models whose registry price is positive but under the review threshold. */
    priceUnderReview: string[]
  }
  suites: BoardSuite[]
  categories: BoardCategory[]
  tasks: BoardTask[]
  models: BoardModel[]
  cells: BoardCell[]
  /**
   * The tasks each scope has data for, in registry order: a task is in a scope when at least one record of
   * that scope's scorer version covers it. Coverage is measured against these, so a scope never counts tasks
   * no record in it can reach (the earlier runs have no headline or smoke records of version 1 to speak of).
   */
  scopeTasks: Record<Scope, string[]>
  summaries: BoardSummary[]
  /** Findings for every scope and model group that has data: insights[scope][group]. */
  insights: Record<Scope, Record<GroupKey, BoardInsight[]>>
  /**
   * The reasoning-effort comparisons for every scope and model group: effort[scope][group]. Each base model with at
   * least two effort levels in view is compared only over the tasks every one of its levels ran in the scope.
   */
  effort: Record<Scope, Record<GroupKey, EffortComparison[]>>
  /**
   * The answer and the caveats at the top of each scope and model group: guides[scope][group]. Both are sentences
   * computed from the same numbers as the findings.
   */
  guides: Record<Scope, Record<GroupKey, ScopeGuide>>
  /** The at-a-glance table and its sentences for every scope and model group: glance[scope][group]. */
  glance: Record<Scope, Record<GroupKey, GlanceBlock>>
  /** Registered tasks with no record in any scope: they are held back. Their names are in the page. */
  heldBackTasks: string[]
  /** The held-back tasks with the sentence the page states about each: its id, title and the reason it has no results. */
  heldBack: { id: string; title: string; sentence: string }[]
  /** Live records that stopped before any iteration ran: their cells are not run, and are named as stopped. */
  stoppedNotRun: NotRunStop[]
  /** Exact definitions the page quotes. Set here so the page and the data never disagree. */
  definitions: {
    costPerAttempt: string
    outputCapTokens: number
    firstPassCapTokens: number
    stoppedRule: string
    /** The sentence after the stop rule: how many records stopped this way, or that none did. Built here. */
    stoppedCount: string
  }
}

/** The answer to "which model for what" and the caveats on it, for one scope and model group. */
export interface ScopeGuide {
  /** Sentences that answer the question for this scope and group, most important first. Empty when there is no data. */
  answer: string[]
  /** Sample size, ceiling and truncation sentences that limit how far the answer can be read. */
  caveats: string[]
  /**
   * The short callout under the scope line: the cell size, and the ceiling sentence naming the tasks on which every
   * configuration in view scored 100.0, and the configurations at 100.0 on every iteration. Empty when there is no data.
   */
  callout: string[]
}

/** One row of the at-a-glance table: one configuration in the scope and group. */
export interface GlanceRow {
  modelId: string
  name: string
  /** True when the configuration covers at least 80% of the scope's tasks. Only covering rows are compared in the sentences. */
  covering: boolean
  /** All-trials score (failed iterations counted as zero), over the tasks the configuration ran in the scope. */
  score: number
  interval: Interval | null
  /** Cost per attempt over every cell in scope with a measured cost, failed and truncated iterations included. */
  costPerAttempt: number | null
  /** Median over the cells of the runtime per completed iteration, in seconds; null when none is measured. */
  medianSecondsPerIteration: number | null
  /** Iterations requested and completed over the cells in scope. */
  requested: number
  completed: number
  /** Failed iterations, and of those the output-cap truncations. */
  failed: number
  truncated: number
  /** Iterations the stopped cells of this configuration did not run. They are not in requested, failed or the score. */
  notRun: number
  /** Iterations planned by the stopped cells of this configuration, so notRun reads as "notRun of stoppedPlanned". */
  stoppedPlanned: number
  /** Cells of this configuration whose record stopped at the account's API spend limit or a quota (see CellStop). */
  stoppedCells: number
  /** The stop label for the row ("stopped by ...: 1 of 3 iterations not run"), built here. Null when no cell stopped. */
  stopLabel: string | null
  /** The recorded reason for the other failed iterations, when there are any. */
  failureReason: string | null
  /** Tasks the configuration ran in scope, out of the tasks in scope. */
  tasksCovered: number
  tasksTotal: number
}

/** The at-a-glance block for one scope and model group: the table and at most three sentences above it. */
export interface GlanceBlock {
  rows: GlanceRow[]
  /** At most three computed sentences. Every one states its sample. */
  sentences: string[]
  /** The sub-heading for the rows that cover less than 80% of the scope's tasks; null when every row covers. */
  notCovering: string | null
}

export interface BuildInput {
  results: BenchmarkResult[]
  models: BenchmarkModel[]
  tasks: BenchmarkTask[]
  categories: BenchmarkCategory[]
  signals?: SignalsFile | null
  /** ISO timestamp. Defaults to the current time; pass one for deterministic output. */
  now?: string
  resultsSha256: string
  /** Set only by fixtures that invent results. The page then shows a synthetic banner. */
  synthetic?: boolean
}

// ── Small numeric helpers ────────────────────────────────────────────────

export function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/**
 * One decimal, rounded half up. The small epsilon stops binary noise from rounding a true half down (96.05 is stored as
 * 96.0499999..., and toFixed(1) would print 96.0). Every one-decimal score on the page is formatted here.
 */
export function fmt1(x: number): string {
  return (Math.round(x * 10 + 1e-9) / 10).toFixed(1)
}

/** Strips binary float noise (0.0000015 * 1000 is not exactly 0.0015). */
export function cleanFloat(x: number): number {
  return Number(x.toPrecision(12))
}

export function mean(xs: ReadonlyArray<number>): number | null {
  if (xs.length === 0) return null
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

export function sum(xs: ReadonlyArray<number>): number {
  let s = 0
  for (const x of xs) s += x
  return s
}

/** Median that ignores null, undefined and non-finite values. */
export function median(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = xs
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    .sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = v.length >> 1
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * The bootstrap seed of a model's interval: its id and the exact tasks its samples come from, in registry order. The same
 * model on the same cells therefore gets the same interval wherever it is shown (a summary, an effort level, a scope).
 */
export function intervalSeed(modelId: string, taskIds: ReadonlyArray<string>): number {
  return fnv1a(`${modelId}|${taskIds.join(',')}`)
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string hash, used to give each model and scope its own fixed seed. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ── Classification ───────────────────────────────────────────────────────

/**
 * 'smoke' for tasks with no pluginId (the seven built-ins), 'horizon' when the
 * pluginId starts with 'horizon', otherwise 'classic'.
 */
export function suiteOf(task: { pluginId?: string }): Suite {
  if (!task.pluginId) return 'smoke'
  if (task.pluginId.startsWith('horizon')) return 'horizon'
  return 'classic'
}

export function isHeadlineSuite(suite: Suite): boolean {
  return suite !== 'smoke'
}

export function inScope(suite: Suite, scope: Scope): boolean {
  if (scope === 'earlier') return true
  if (scope === 'headline') return isHeadlineSuite(suite)
  if (scope === 'horizon') return suite === 'horizon'
  return suite === 'smoke'
}

/**
 * A cell belongs to a scope when its task suite is in the scope and its scorer is the scope's own:
 * version 2 or later for headline and smoke, version 1 only for earlier.
 */
export function inScopeCell(cell: { suite: Suite; scorerVersion: number }, scope: Scope): boolean {
  if (scope === 'earlier') return cell.scorerVersion < CURRENT_SCORER_VERSION
  return cell.scorerVersion >= CURRENT_SCORER_VERSION && inScope(cell.suite, scope)
}

export function accessFor(provider: string): Access {
  if (API_PROVIDERS.has(provider)) return 'api'
  if (LOCAL_PROVIDERS.has(provider)) return 'local'
  return 'cli'
}

export function groupFor(company: string | undefined): Group {
  return company === 'Anthropic' ? 'claude' : 'other'
}

/** A variant resolves to its base model; a base model resolves to itself. */
export function baseModelIdOf(model: { id: string; baseModelId?: string }): string {
  return model.baseModelId ?? model.id
}

export function covers(tasksCovered: number, tasksTotal: number): boolean {
  return tasksTotal > 0 && tasksCovered >= COVERAGE_SHARE * tasksTotal
}

// ── Per-cell definitions ─────────────────────────────────────────────────

export interface AllTrialsInput {
  score: number
  scoreAllTrials?: number
  iterations: number
  iterationScores?: number[]
  iterationsSucceeded?: number
}

/**
 * The all-trials score of one cell, rounded to one decimal.
 *
 * 1. the record's scoreAllTrials when present;
 * 2. otherwise the sum of iterationScores over iterations (failed iterations count as zero);
 * 3. otherwise, with no iterationScores, score * iterationsSucceeded / iterations when both are known;
 * 4. otherwise score.
 */
export function allTrialsScore(r: AllTrialsInput): number {
  if (typeof r.scoreAllTrials === 'number') return round1(r.scoreAllTrials)
  if (Array.isArray(r.iterationScores) && r.iterations > 0) {
    return round1(sum(r.iterationScores) / r.iterations)
  }
  if (
    typeof r.iterationsSucceeded === 'number' &&
    r.iterations > 0
  ) {
    return round1((r.score * r.iterationsSucceeded) / r.iterations)
  }
  return round1(r.score)
}

/**
 * Per-iteration all-trials values: the iteration scores with one zero per
 * failed iteration. Null when the record carries no per-iteration scores.
 */
export function iterationValues(r: {
  iterations: number
  iterationScores?: number[]
}): number[] | null {
  if (!Array.isArray(r.iterationScores)) return null
  const values = [...r.iterationScores]
  while (values.length < r.iterations) values.push(0)
  return values
}

/**
 * The per-iteration all-trials values of a cell, with a zero for each failed iteration. Null when the cell carries no
 * per-iteration scores, so its one all-trials score is all there is to resample.
 */
export function cellValues(c: Pick<BoardCell, 'iterations' | 'iterationScores'>): number[] | null {
  if (!Array.isArray(c.iterationScores) || c.iterationScores.length === 0) return null
  const values = [...c.iterationScores]
  while (values.length < c.iterations) values.push(0)
  return values
}

/**
 * Failed iterations of a record that were output-cap truncations. A recorded reason of "truncated" marks them. A cell
 * with no reason, no completed iteration and output of exactly the cap on every iteration is truncated too: the
 * harness did not record a reason for those cells, so the cap is the evidence.
 */
export function truncatedIterationsOf(
  r: Pick<BenchmarkResult, 'iterations' | 'failureReason' | 'tokensOut'>,
  succeeded: number | null
): number {
  const failed = Math.max(0, r.iterations - (succeeded ?? 0))
  if (failed === 0) return 0
  if (r.failureReason === 'truncated') return failed
  const noReason = r.failureReason === null || r.failureReason === undefined
  if (noReason && succeeded === 0 && typeof r.tokensOut === 'number' && r.tokensOut === r.iterations * OUTPUT_CAP_TOKENS) {
    return failed
  }
  return 0
}

/**
 * The stop of a record that ended before its planned iterations ran, or null. A record stops when it carries
 * `budgetExceeded` (the sweep's spend cap) or `quotaNextResetAt` (a provider quota) and fewer iterations completed than
 * were planned. A stop is the run's, not the model's, so its unrun iterations are not counted (see stopRule).
 */
export function stopOf(
  r: Pick<BenchmarkResult, 'iterations' | 'iterationsSucceeded' | 'budgetExceeded' | 'quotaNextResetAt'>
): (CellStop & { ran: number }) | null {
  if (!r.budgetExceeded && !r.quotaNextResetAt) return null
  const ran = r.iterationsSucceeded
  if (typeof ran !== 'number' || ran >= r.iterations) return null
  return { planned: r.iterations, ran, notRun: r.iterations - ran, by: r.budgetExceeded ? 'budget' : 'quota' }
}

/**
 * The label the page and the findings give a stopped cell. The count is the iterations that did not run, out of the
 * iterations planned.
 */
export function stopLabel(notRun: number, planned: number): string {
  return `stopped by the account's API spend limit: ${notRun} of ${planned} iterations not run`
}

/** The sentence the page prints about a stopped cell: its label, and the iterations its score and counts use. */
export function stopSentence(label: string, ran: number): string {
  return `This cell was ${label}. Its score, cost and counts use the ${ran === 1 ? '1 iteration' : `${ran} iterations`} that ran.`
}

/**
 * The sentence after the stop rule in the method: how many records stopped this way, and how many iterations they did not
 * run. "No record in these results was stopped this way." when there are none.
 */
export function stoppedCountSentence(records: number, notRun: number): string {
  if (records === 0) return 'No record in these results was stopped this way.'
  const noun = records === 1 ? '1 record in these results was' : `${records} records in these results were`
  const not = notRun === 1 ? '1 iteration' : `${notRun} iterations`
  return `${noun} stopped this way, with ${not} not run; each is named under its scope and in the glance table.`
}

/**
 * The stop rule, as the method states it. Its limit is named: a model failure earlier in the same pair would also be
 * dropped, because the record cannot tell it from the stop. The build checks only that each stopped record has a score
 * for every iteration that ran (verifyStop), so it does not by itself rule that failure out.
 */
export const STOP_RULE =
  "A record that stopped before its planned iterations ran, at the account's API spend limit or a provider quota, is counted over the iterations that ran. The iterations that did not run are not requested, not failed and not in the all-trials score, the interval, the cost per attempt or the reliability, and the cell is labelled. The limit: the record cannot tell a model failure from the stop, so a failure earlier in the same pair would also be dropped. The build checks that each stopped record has a score for every iteration that ran."

/**
 * Throws unless a stopped record scores every iteration that ran. A stop with no iteration run is not measured at all: the
 * build routes it to a not-run cell (see NotRunStop) before this check.
 */
function verifyStop(r: BenchmarkResult, stop: CellStop & { ran: number }): void {
  const scores = r.iterationScores ?? []
  if (scores.length !== stop.ran) {
    throw new Error(
      `results.json: ${r.modelId} on ${r.taskId} stopped with ${stop.ran} iterations completed but ${scores.length} iteration scores; a stopped record must score every iteration that ran`
    )
  }
}

/** The name the findings and the page use for a model: its registry name, with its effort when the name does not say it. */
export function effortName(model: { name: string; effort?: string | null }): string {
  const paren = /\(([^)]+)\)\s*$/.exec(model.name)
  const said = !!(paren && /low|medium|high|max|ultra/i.test(paren[1]))
  return model.effort && !said ? `${model.name} (${effortWord(model.effort)} effort)` : model.name
}

/** Effort in words for a sentence: "extra high" for xhigh. */
export function effortWord(effort: string): string {
  return effort === 'xhigh' ? 'extra high' : effort
}

/** A cost is measured when it is positive, or when it is a reported zero. */
export function costIsMeasured(costUsd: number, usageSource: string | null): boolean {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return false
  return costUsd > 0 || usageSource === 'reported'
}

/** Cost per iteration, or null when the cost is not measured. */
export function costPerIterationOf(
  costUsd: number,
  iterations: number,
  usageSource: string | null
): number | null {
  if (!costIsMeasured(costUsd, usageSource) || iterations <= 0) return null
  return costUsd / iterations
}

/** TTFT and tokens/sec are measured only when telemetry says the rate is a decode rate. */
export function timingsOf(telemetry: BenchmarkResult['telemetry']): {
  rateKind: string | null
  ttftMs: number | null
  tokensPerSec: number | null
} {
  const rateKind = telemetry?.rateKind ?? null
  const decode = rateKind === 'decode'
  return {
    rateKind,
    ttftMs:
      decode && typeof telemetry?.meanTtftMs === 'number' ? telemetry.meanTtftMs : null,
    tokensPerSec:
      decode && typeof telemetry?.meanTokensPerSec === 'number'
        ? telemetry.meanTokensPerSec
        : null,
  }
}

export interface CheckStat {
  runs: number
  passed: number
  pointsSum: number
  maxPoints: number
}

/**
 * Counts each named check over the iterations it appears in. Fallback rows and
 * rows with maxPoints 0 are left out; they are not model evidence.
 */
export function checkStats(
  iterationCheckResults: ReadonlyArray<ReadonlyArray<IterationCheckResult> | null | undefined> | undefined
): Map<string, CheckStat> {
  const out = new Map<string, CheckStat>()
  for (const iteration of iterationCheckResults ?? []) {
    for (const row of iteration ?? []) {
      if (isFallbackCheck(row) || !(row.maxPoints > 0)) continue
      const stat = out.get(row.name) ?? { runs: 0, passed: 0, pointsSum: 0, maxPoints: 0 }
      stat.runs += 1
      if (row.passed) stat.passed += 1
      stat.pointsSum += row.points
      stat.maxPoints = Math.max(stat.maxPoints, row.maxPoints)
      out.set(row.name, stat)
    }
  }
  return out
}

/** Cell-level check rows: passRate = passed / runs, meanPoints = points / runs. */
export function cellChecks(stats: Map<string, CheckStat>): CellCheck[] {
  return [...stats].map(([name, s]) => ({
    name,
    passRate: s.passed / s.runs,
    meanPoints: s.pointsSum / s.runs,
    maxPoints: s.maxPoints,
    runs: s.runs,
  }))
}

// ── Bootstrap interval and frontier ──────────────────────────────────────

/**
 * 95% percentile bootstrap for a model's mean cell all-trials score.
 *
 * `samples` has one entry per cell in scope. An entry is either the cell's
 * per-iteration all-trials values (an array) or, when the record carries no
 * per-iteration scores, the cell's all-trials score (a number, which has
 * nothing to resample inside it).
 *
 * Each of the resamples draws cells with replacement. A drawn cell with values
 * contributes the mean of its values resampled with replacement; a drawn cell
 * without values contributes its number. The statistic is the mean over the
 * drawn cells. This keeps the spread between tasks, so a model whose single-
 * iteration cells differ widely gets a wide interval, not a zero-width one.
 * The interval is not clamped to the reported mean: the percentiles are
 * reported as they fall.
 *
 * Returns null with fewer than MIN_INTERVAL_VALUES measured iteration values.
 * The seed is fixed by the caller, so the output is reproducible.
 */
export function bootstrapInterval(
  samples: ReadonlyArray<number | ReadonlyArray<number>>,
  seed: number,
  options: { resamples?: number } = {}
): Interval | null {
  let values = 0
  for (const s of samples) if (typeof s !== 'number') values += s.length
  if (samples.length === 0 || values < MIN_INTERVAL_VALUES) return null

  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES
  const rand = mulberry32(seed)
  const n = samples.length
  const stats = new Float64Array(resamples)
  for (let b = 0; b < resamples; b++) {
    let total = 0
    for (let k = 0; k < n; k++) {
      const s = samples[Math.floor(rand() * n)]
      if (typeof s === 'number') {
        total += s
        continue
      }
      if (s.length === 0) continue
      let acc = 0
      for (let i = 0; i < s.length; i++) acc += s[Math.floor(rand() * s.length)]
      total += acc / s.length
    }
    stats[b] = total / n
  }
  stats.sort()
  return [percentile(stats, 0.025), percentile(stats, 0.975)]
}

function percentile(sorted: Float64Array, p: number): number {
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function intervalsOverlap(a: Interval | null, b: Interval | null): boolean {
  if (!a || !b) return false
  return a[0] <= b[1] && b[0] <= a[1]
}

/**
 * Models not dominated by another. A model is dominated when another has
 * lower-or-equal cost, higher-or-equal score, and is strictly better on one.
 * Exact ties on both axes do not dominate each other.
 */
export function paretoFrontier(
  points: ReadonlyArray<{ id: string; cost: number; score: number }>
): Set<string> {
  const front = new Set<string>()
  for (const p of points) {
    const dominated = points.some(
      (q) =>
        q !== p &&
        q.cost <= p.cost &&
        q.score >= p.score &&
        (q.cost < p.cost || q.score > p.score)
    )
    if (!dominated) front.add(p.id)
  }
  return front
}

// ── Reasoning effort ─────────────────────────────────────────────────────

/** One effort level of a base model, measured over the tasks every level of that base ran in the scope. */
export interface EffortLevel {
  modelId: string
  effort: string
  /** Mean all-trials score over the compared tasks; null when none of them has a cell. */
  score: number | null
  /** Mean cost per attempt over the compared tasks whose cost is measured; null when none is. */
  costPerAttempt: number | null
  /** Compared tasks whose cost is measured: the count behind costPerAttempt. */
  pricedTasks: number
  /** Median over the compared tasks of the runtime per completed iteration, in seconds; null when none is measured. */
  medianSeconds: number | null
  /** Compared tasks with a measured runtime: the count behind medianSeconds. */
  timedTasks: number
  /** 95% interval of the level's all-trials score over the compared cells; null when there are too few values. */
  interval: Interval | null
  /** Iterations requested over the compared tasks. */
  requested: number
  /** Of those, the iterations that hit the output cap (counted as zero). */
  truncated: number
  /**
   * Mean over the compared tasks of each task's mean over its completed iterations (failed and truncated ones excluded);
   * null when no task completed.
   */
  completedMean: number | null
  /** Compared tasks with a completed iteration: the count behind completedMean. */
  completedTasks: number
  /** Completed iterations over the compared tasks. */
  completed: number
  /** Compared cells whose record stopped before its planned iterations ran (see CellStop). */
  stoppedCells: number
  /** Iterations those stopped cells did not run, and the iterations they planned: notRun of stoppedPlanned. */
  notRun: number
  stoppedPlanned: number
  /** The chart's note for a level with stopped cells, "1 not run, stopped"; null when none stopped. Built here. */
  stopMark: string | null
  /** The chart's tooltip line for a level with stopped cells; null when none stopped. Built here. */
  stopTip: string | null
}

export interface EffortComparison {
  baseModelId: string
  /** The base model's name without any effort suffix. */
  name: string
  /** Task ids every effort level of the base ran in the scope, in registry order. Empty when no task is shared. */
  tasks: string[]
  /** One entry per effort level in view, from least to most effort. */
  levels: EffortLevel[]
  /** One sentence per level that had truncated iterations: the count, the cap, and what its completed iterations averaged. */
  truncationNotes: string[]
  /** One sentence per compared cell stopped at the account's spend limit or a quota: the task, the label and the iterations counted. */
  stopNotes: string[]
}

export interface EffortInput {
  modelId: string
  baseModelId: string
  effort: string
}

/** A model's effort suffix in its display name, for example " (low effort)". */
const EFFORT_SUFFIX = /\s*\((extra )?(low|medium|high|xhigh|max|ultra)( effort)?\)\s*$/i

export function stripEffortSuffix(name: string): string {
  return name.replace(EFFORT_SUFFIX, '')
}

function effortRank(effort: string): number {
  const i = EFFORT_ORDER.indexOf(effort)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

/**
 * The effort comparison of every base model with at least two effort levels among `models`. Each level is compared only
 * over the tasks that every level of its base ran (`cellsOf` gives a model's measured cells in the scope), so the levels
 * are never set against different task sets. A base whose levels share no task has no tasks and empty stats.
 * A second model at an effort already present for its base is not a further level and is left out.
 */
export function effortComparisons(
  models: ReadonlyArray<EffortInput>,
  cellsOf: (modelId: string) => ReadonlyArray<BoardCell>,
  taskRank: (taskId: string) => number,
  baseName: (baseModelId: string) => string,
  taskTitle: (taskId: string) => string = (taskId) => taskId
): EffortComparison[] {
  const byBase = new Map<string, EffortInput[]>()
  for (const m of models) byBase.set(m.baseModelId, [...(byBase.get(m.baseModelId) ?? []), m])
  const out: EffortComparison[] = []
  for (const [baseModelId, members] of byBase) {
    const seen = new Set<string>()
    const levels = members.filter((m) => {
      if (seen.has(m.effort)) return false
      seen.add(m.effort)
      return true
    })
    if (levels.length < 2) continue
    const ran = levels.map((m) => new Set(cellsOf(m.modelId).map((c) => c.taskId)))
    const tasks = [...ran[0]]
      .filter((t) => ran.every((s) => s.has(t)))
      .sort((a, b) => taskRank(a) - taskRank(b))
    const shared = new Set(tasks)
    const stats: EffortLevel[] = levels.map((m) => {
      const cs = cellsOf(m.modelId).filter((c) => shared.has(c.taskId))
      const priced = cs.filter((c) => c.costPerIteration !== null).map((c) => c.costPerIteration as number)
      const timed = cs.filter((c) => c.runtimeMs !== null).map((c) => (c.runtimeMs as number) / 1000)
      const completedPerTask = cs
        .filter((c) => c.iterationScores.length > 0)
        .map((c) => mean(c.iterationScores) as number)
      const levelStopped = cs.filter((c) => c.stopped).length
      const levelNotRun = sum(cs.map((c) => c.stopped?.notRun ?? 0))
      const levelPlanned = sum(cs.map((c) => c.stopped?.planned ?? 0))
      return {
        modelId: m.modelId,
        effort: m.effort,
        score: cs.length ? mean(cs.map((c) => c.scoreAllTrials)) : null,
        costPerAttempt: priced.length ? mean(priced) : null,
        pricedTasks: priced.length,
        medianSeconds: median(timed),
        timedTasks: timed.length,
        interval: bootstrapInterval(
          cs.map((c) => cellValues(c) ?? c.scoreAllTrials),
          intervalSeed(m.modelId, cs.map((c) => c.taskId))
        ),
        requested: sum(cs.map((c) => c.iterations)),
        truncated: sum(cs.map((c) => c.truncatedIterations)),
        completedMean: completedPerTask.length ? mean(completedPerTask) : null,
        completedTasks: completedPerTask.length,
        completed: sum(cs.map((c) => c.succeeded ?? 0)),
        stoppedCells: levelStopped,
        notRun: levelNotRun,
        stoppedPlanned: levelPlanned,
        stopMark: levelStopped ? `${levelNotRun} not run, stopped` : null,
        stopTip: levelStopped
          ? `S: ${stopLabel(levelNotRun, levelPlanned)}; this level is counted over the iterations that ran`
          : null,
      }
    })
    stats.sort((a, b) => effortRank(a.effort) - effortRank(b.effort) || a.modelId.localeCompare(b.modelId))
    const stopNotes: string[] = []
    for (const l of stats) {
      for (const c of cellsOf(l.modelId)) {
        if (!shared.has(c.taskId) || !c.stopped) continue
        stopNotes.push(
          `${cap(effortWord(l.effort))} effort on ${taskTitle(c.taskId)}, ${stopLabel(c.stopped.notRun, c.stopped.planned)}. Its score, interval and cost count the ${plural(c.iterations, 'iteration')} that ran.`
        )
      }
    }
    const truncationNotes = stats
      .filter((l) => l.truncated > 0)
      .map((l) => {
        const done = l.completedMean === null
          ? 'none of its iterations completed'
          : `its completed iterations averaged ${fmt1(l.completedMean)} per task, over the ${plural(l.completedTasks, 'task')} with a completed iteration`
        return `${cap(effortWord(l.effort))} effort: ${l.truncated} of ${plural(l.requested, 'requested iteration')} truncated at the ${OUTPUT_CAP_TOKENS.toLocaleString('en-US')}-token output cap, counted as zero; ${done}.`
      })
    out.push({ baseModelId, name: stripEffortSuffix(baseName(baseModelId)), tasks, levels: stats, truncationNotes, stopNotes })
  }
  return out.sort((a, b) => a.baseModelId.localeCompare(b.baseModelId))
}

// ── Build ────────────────────────────────────────────────────────────────

export interface Measured {
  cell: BoardCell
  /** Per-iteration all-trials values, or null when the record has none. */
  values: number[] | null
  checks: Map<string, CheckStat>
}

const SUITE_LABEL: Record<Suite, string> = {
  horizon: 'Horizon',
  classic: 'Classic',
  smoke: 'Smoke',
}

const SUITE_NOTE: Record<Suite, string> = {
  horizon:
    'Tasks whose plugin id starts with "horizon". Headline tasks. Included in the headline summaries.',
  classic:
    'Plugin tasks whose plugin id is not horizon, run by the maintainers. Headline tasks. Included in the headline summaries.',
  smoke:
    'The seven built-in tasks. Their checks only test that a page renders, animates or reacts to one input, so strong models cluster near the maximum. Excluded from headline summaries.',
}

/** Check rows the harness could not run: the scorer records them with detail "threw: ...". */
function threwRows(
  iterationCheckResults: ReadonlyArray<ReadonlyArray<IterationCheckResult> | null | undefined> | undefined
): number {
  let n = 0
  for (const iteration of iterationCheckResults ?? []) {
    for (const row of iteration ?? []) {
      if (typeof row.detail === 'string' && row.detail.startsWith('threw:')) n += 1
    }
  }
  return n
}

/**
 * Timings are kept only for API and local routes whose telemetry is a decode
 * rate. A command-line agent's first-output time is not a token time, and a
 * first token that arrives after 90% of the runtime is not a decode measurement.
 */
export const TIMING_TTFT_SHARE_LIMIT = 0.9

function timingsForRoute(
  telemetry: BenchmarkResult['telemetry'],
  access: Access,
  runtimeMs: number
): { rateKind: string | null; ttftMs: number | null; tokensPerSec: number | null } {
  const timings = timingsOf(telemetry)
  if (access === 'cli') return { rateKind: timings.rateKind, ttftMs: null, tokensPerSec: null }
  const implausible =
    timings.ttftMs !== null && runtimeMs > 0 && timings.ttftMs >= TIMING_TTFT_SHARE_LIMIT * runtimeMs
  if (implausible) return { rateKind: timings.rateKind, ttftMs: null, tokensPerSec: null }
  return timings
}

/**
 * How a model's cost is known, from its registry prices (per 1k tokens, as entered). A model is
 * priced when either price is positive; a positive price under the review threshold is under review.
 */
export function pricingOf(m: { costPer1kInputUsd: number; costPer1kOutputUsd: number }): PricingState {
  const positive = [m.costPer1kInputUsd, m.costPer1kOutputUsd]
    .map((v) => cleanFloat(v * 1000))
    .filter((v) => v > 0)
  if (positive.length === 0) return 'no-per-token-price'
  if (positive.some((v) => v < PRICE_REVIEW_BELOW_PER_M)) return 'price-under-review'
  return 'priced'
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The captures of one cell, attached only when they were taken from this record's output. A capture taken from
 * an earlier output (the record was re-run since) is not shown; the page says the capture is out of date.
 */
export function capturesFor(
  output: string | null | undefined,
  sig: { outputSha256?: string; shots?: string[]; captures?: CaptureNote[] } | undefined
): { status: CaptureStatus; shots: string[]; captures: CaptureNote[] } {
  if (!sig || !Array.isArray(sig.shots) || sig.shots.length === 0) return { status: 'none', shots: [], captures: [] }
  const current = typeof output === 'string' && typeof sig.outputSha256 === 'string' && sha256Hex(output) === sig.outputSha256
  if (!current) return { status: 'out-of-date', shots: [], captures: [] }
  return { status: 'current', shots: [...sig.shots], captures: [...(sig.captures ?? [])] }
}

function measureRecord(
  r: BenchmarkResult,
  task: BenchmarkTask,
  signals: SignalsFile | null | undefined,
  access: Access,
  pricing: PricingState
): Measured {
  const usageSource = r.usage?.source ?? null
  // Cost is measured only for a model with a positive per-token price, and only when it is above zero.
  // A free route's usage block, a subscription route's usage block and a local model's usage block are not a cost.
  const measuredCost = pricing === 'priced' && costIsMeasured(r.costUsd, usageSource) && r.costUsd > 0
  const succeeded =
    r.iterationsSucceeded ??
    (r.status === 'success'
      ? r.iterations
      : r.status === 'fail' || r.status === 'timeout'
        ? 0
        : null)
  // A cell with no completed iteration has no runtime or token measurement: the record holds 0.
  const nothingCompleted = succeeded === 0
  const runtimeMs = nothingCompleted ? null : r.runtimeMs
  const timings = timingsForRoute(r.telemetry, access, r.runtimeMs)
  const captures = capturesFor(r.output, signals?.cells?.[`${r.modelId}|${r.taskId}`])
  const stats = checkStats(r.iterationCheckResults)
  // A stopped record is measured over the iterations that ran. Its own all-trials score divides by the planned count, so
  // it is not used; its failure reason describes the iterations that did not run, so it is not used either.
  const stop = stopOf(r)
  if (stop) verifyStop(r, stop)
  const counted: BenchmarkResult = stop
    ? { ...r, iterations: stop.ran, scoreAllTrials: undefined, failureReason: undefined }
    : r
  const cell: BoardCell = {
    modelId: r.modelId,
    taskId: r.taskId,
    suite: suiteOf(task),
    score: r.score,
    scoreAllTrials: allTrialsScore(counted),
    iterations: counted.iterations,
    stopped: stop ? { planned: stop.planned, notRun: stop.notRun, by: stop.by } : null,
    stopLabel: stop ? stopLabel(stop.notRun, stop.planned) : null,
    stopSentence: stop ? stopSentence(stopLabel(stop.notRun, stop.planned), stop.ran) : null,
    succeeded,
    truncatedIterations: truncatedIterationsOf(counted, succeeded),
    iterationScores: [...(r.iterationScores ?? [])],
    status: r.status,
    failureReason: counted.failureReason ?? null,
    // A failed or truncated iteration is billed, so a cell in which every iteration failed keeps its cost.
    costUsd: measuredCost ? r.costUsd : null,
    costPerIteration: measuredCost && counted.iterations > 0 ? r.costUsd / counted.iterations : null,
    tokensIn: nothingCompleted ? null : r.tokensIn,
    tokensOut: nothingCompleted ? null : r.tokensOut,
    billedTokensOut: typeof r.tokensOut === 'number' ? r.tokensOut : null,
    runtimeMs,
    ttftMs: timings.ttftMs,
    tokensPerSec: timings.tokensPerSec,
    rateKind: timings.rateKind,
    usageSource,
    createdAt: r.createdAt,
    scorerVersion: r.scorerVersion ?? 1,
    checks: cellChecks(stats),
    checkRowsThrew: threwRows(r.iterationCheckResults),
    fallbackScored: (r.iterationCheckResults ?? []).some((it) =>
      (it ?? []).some((row) => isFallbackCheck(row))
    ),
    captureStatus: captures.status,
    shots: captures.shots,
    captures: captures.captures,
  }
  return { cell, values: iterationValues(counted), checks: stats }
}

function summarize(
  modelId: string,
  scope: Scope,
  group: Measured[],
  tasksTotal: number
): BoardSummary {
  const cells = group.map((g) => g.cell)
  const meanAll = mean(cells.map((c) => c.scoreAllTrials)) as number
  const interval = bootstrapInterval(
    group.map((g) => g.values ?? g.cell.scoreAllTrials),
    intervalSeed(modelId, group.map((g) => g.cell.taskId))
  )
  const withSucc = cells.filter((c) => c.succeeded !== null)
  const requested = sum(withSucc.map((c) => c.iterations))
  // Cells with at least one completed iteration. The plain mean of their scores is the mean when run;
  // like the all-trials score, it is a mean over tasks, so it can never sit below the all-trials mean.
  const completed = cells.filter((c) => (c.succeeded ?? 0) > 0)
  // The record's cost and token counts are totals over every iteration of the cell, so a cell that ran
  // more iterations is not comparable with one that ran fewer. Per-run figures divide each cell by its
  // own iteration count first; the summary then takes the mean over tasks.
  const priced = cells.filter((c) => c.costUsd !== null).map((c) => c.costUsd as number)
  const pricedPerRun = cells.filter((c) => c.costPerIteration !== null).map((c) => c.costPerIteration as number)
  const tokensOutPerRun = cells
    .filter((c) => c.billedTokensOut !== null && c.iterations > 0)
    .map((c) => (c.billedTokensOut as number) / c.iterations)
  return {
    modelId,
    scope,
    tasksCovered: cells.length,
    tasksTotal,
    meanScoreAllTrials: meanAll,
    interval,
    meanScore: completed.length > 0 ? mean(completed.map((c) => c.score)) : null,
    successRate:
      withSucc.length > 0 && requested > 0
        ? sum(withSucc.map((c) => c.succeeded as number)) / requested
        : null,
    totalCostUsd: priced.length ? sum(priced) : null,
    costPerAttempt: pricedPerRun.length ? mean(pricedPerRun) : null,
    pricedCells: pricedPerRun.length,
    medianRuntimeMs: median(cells.map((c) => c.runtimeMs)),
    medianTtftMs: median(cells.map((c) => c.ttftMs)),
    medianTokensPerSec: median(cells.map((c) => c.tokensPerSec)),
    outputTokensPerTask: tokensOutPerRun.length ? mean(tokensOutPerRun) : null,
    onFrontier: false,
  }
}

export function buildBoard(input: BuildInput): Board {
  const { results, models, tasks, categories, resultsSha256 } = input
  const signals = input.signals ?? null
  const generatedAt = input.now ?? new Date().toISOString()

  const live = results.filter((r) => r.source === 'live')
  const modelById = new Map(models.map((m) => [m.id, m]))
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  const seen = new Set<string>()
  const measured: Measured[] = []
  // A record that stopped before any iteration ran is not measured: its cell is not run, and it is named as stopped.
  const notRunRecords: NotRunStop[] = []
  const pricingById = new Map(models.map((m) => [m.id, pricingOf(m)]))
  for (const r of live) {
    const key = `${r.modelId}|${r.taskId}`
    if (!modelById.has(r.modelId)) {
      throw new Error(`results.json has a live record for unknown model "${r.modelId}"`)
    }
    const task = taskById.get(r.taskId)
    if (!task) {
      throw new Error(`results.json has a live record for unknown task "${r.taskId}"`)
    }
    if (seen.has(key)) throw new Error(`results.json has two live records for ${key}`)
    seen.add(key)
    const model = modelById.get(r.modelId) as BenchmarkModel
    const stop = stopOf(r)
    if (stop && stop.ran === 0) {
      notRunRecords.push({
        modelId: r.modelId,
        taskId: r.taskId,
        suite: suiteOf(task),
        scorerVersion: r.scorerVersion ?? 1,
        stopped: { planned: stop.planned, notRun: stop.notRun, by: stop.by },
        label: stopLabel(stop.notRun, stop.planned),
      })
      continue
    }
    measured.push(
      measureRecord(r, task, signals, accessFor(model.provider), pricingById.get(model.id) ?? 'no-per-token-price')
    )
  }

  // Board tasks: every registry task, in registry order.
  const boardTasks: BoardTask[] = tasks.map((t) => {
    const suite = suiteOf(t)
    const checks = new Map<string, number>()
    for (const m of measured) {
      if (m.cell.taskId !== t.id) continue
      for (const [name, s] of m.checks) {
        checks.set(name, Math.max(checks.get(name) ?? 0, s.maxPoints))
      }
    }
    return {
      id: t.id,
      title: t.title,
      category: t.category,
      suite,
      scorer: t.scorer ?? null,
      headline: isHeadlineSuite(suite),
      checks: [...checks].map(([name, maxPoints]) => ({ name, maxPoints })),
    }
  })
  const taskOrder = new Map(tasks.map((t, i) => [t.id, i]))
  const modelOrder = new Map(models.map((m, i) => [m.id, i]))

  const measuredModelIds = new Set(measured.map((m) => m.cell.modelId))
  const boardModels: BoardModel[] = models
    .filter((m) => measuredModelIds.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      company: m.company ?? null,
      family: m.family ?? null,
      provider: m.provider,
      baseModelId: baseModelIdOf(m),
      effort: m.reasoningEffort ?? null,
      released: m.released ?? null,
      priceInPerM: cleanFloat(m.costPer1kInputUsd * 1000),
      priceOutPerM: cleanFloat(m.costPer1kOutputUsd * 1000),
      pricing: pricingOf(m),
      access: accessFor(m.provider),
      group: groupFor(m.company),
    }))

  measured.sort(
    (a, b) =>
      (modelOrder.get(a.cell.modelId) ?? 0) - (modelOrder.get(b.cell.modelId) ?? 0) ||
      (taskOrder.get(a.cell.taskId) ?? 0) - (taskOrder.get(b.cell.taskId) ?? 0)
  )

  // The tasks each scope has data for: a task is in a scope when a measured cell of that scope's scorer version covers it.
  const scopeTasks = {} as Record<Scope, string[]>
  for (const scope of SCOPE_KEYS) {
    const covered = new Set(measured.filter((m) => inScopeCell(m.cell, scope)).map((m) => m.cell.taskId))
    scopeTasks[scope] = boardTasks.filter((t) => covered.has(t.id)).map((t) => t.id)
  }

  // Summaries per scope, then frontier flags per scope.
  const summaries: BoardSummary[] = []
  for (const scope of SCOPE_KEYS) {
    const tasksTotal = scopeTasks[scope].length
    for (const m of boardModels) {
      const group = measured.filter(
        (g) => g.cell.modelId === m.id && inScopeCell(g.cell, scope)
      )
      if (group.length === 0) continue
      summaries.push(summarize(m.id, scope, group, tasksTotal))
    }
    const scoped = summaries.filter((s) => s.scope === scope)
    const eligible = scoped.filter((s) => s.costPerAttempt !== null && covers(s.tasksCovered, s.tasksTotal))
    const front = paretoFrontier(
      eligible.map((s) => ({ id: s.modelId, cost: s.costPerAttempt as number, score: s.meanScoreAllTrials }))
    )
    for (const s of scoped) s.onFrontier = front.has(s.modelId) && eligible.includes(s)
  }

  const cells = measured.map((m) => m.cell)
  // A registered task with no record in any scorer is held back: it is named, and its absence is explained. A task whose
  // only record stopped before any iteration ran was run, so it is not held back.
  const ranTaskIds = new Set([...measured.map((m) => m.cell.taskId), ...notRunRecords.map((n) => n.taskId)])
  const heldBack = boardTasks.filter((t) => !ranTaskIds.has(t.id))
  const suites: BoardSuite[] = (['horizon', 'classic', 'smoke'] as Suite[]).map((id) => {
    const count = boardTasks.filter((t) => t.suite === id).length
    const held = heldBack.filter((t) => t.suite === id)
    let note = `${SUITE_NOTE[id]} ${count} task${count === 1 ? '' : 's'} registered`
    if (held.length) note += `, ${count - held.length} with runs`
    note += '.'
    if (held.length) {
      note += ` ${held.map((t) => heldBackSentence(t)).join(' ')}`
    }
    return { id, label: SUITE_LABEL[id], note }
  })

  const titleById = new Map(boardTasks.map((t) => [t.id, t.title]))
  const taskTitle = (id: string) => titleById.get(id) ?? id
  const taskRank = (id: string) => taskOrder.get(id) ?? 0
  const nameOf = (id: string) => {
    const m = modelById.get(id)
    return m ? effortName({ name: m.name, effort: m.reasoningEffort ?? null }) : id
  }
  const boardModelById = new Map(boardModels.map((m) => [m.id, m]))
  const modelEffort = (id: string) => boardModelById.get(id)?.effort ?? null
  const modelBase = (id: string) => boardModelById.get(id)?.baseModelId ?? id

  // Findings for every scope and model group that has data: insights[scope][group]. The effort comparisons are
  // computed here too, once per scope and group: effort[scope][group] over every level in view, and the findings
  // use the same comparison over the levels that cover 80% of the scope's tasks.
  const cellsByModel = new Map<string, BoardCell[]>()
  for (const m of measured) cellsByModel.set(m.cell.modelId, [...(cellsByModel.get(m.cell.modelId) ?? []), m.cell])
  const effortInputOf = (modelId: string): EffortInput | null => {
    const m = boardModelById.get(modelId)
    return m && m.effort ? { modelId, baseModelId: m.baseModelId, effort: m.effort } : null
  }
  const baseNameOf = (baseModelId: string) => modelById.get(baseModelId)?.name ?? baseModelId
  const effort = {} as Record<Scope, Record<GroupKey, EffortComparison[]>>
  const insights = {} as Record<Scope, Record<GroupKey, BoardInsight[]>>
  const guides = {} as Record<Scope, Record<GroupKey, ScopeGuide>>
  const glance = {} as Record<Scope, Record<GroupKey, GlanceBlock>>
  for (const scope of SCOPE_KEYS) {
    const tasksTotal = scopeTasks[scope].length
    const scopeSummaries = summaries.filter((s) => s.scope === scope)
    insights[scope] = { claude: [], all: [] }
    effort[scope] = { claude: [], all: [] }
    guides[scope] = { claude: emptyGuide(), all: emptyGuide() }
    glance[scope] = { claude: { rows: [], sentences: [], notCovering: null }, all: { rows: [], sentences: [], notCovering: null } }
    for (const group of GROUP_KEYS) {
      const inGroup = (id: string) => group === 'all' || boardModelById.get(id)?.group === 'claude'
      const focus = scopeSummaries.filter((s) => inGroup(s.modelId))
      const eligible = focus.filter((s) => s.costPerAttempt !== null && covers(s.tasksCovered, s.tasksTotal))
      const cells = measured.filter((m) => inScopeCell(m.cell, scope) && inGroup(m.cell.modelId))
      const notRun = notRunRecords.filter((n) => inScopeCell(n, scope) && inGroup(n.modelId))
      const cellsOf = (modelId: string) => (cellsByModel.get(modelId) ?? []).filter((c) => inScopeCell(c, scope))
      const effortOver = (ids: string[]) =>
        effortComparisons(
          ids.map(effortInputOf).filter((x): x is EffortInput => x !== null),
          cellsOf,
          taskRank,
          baseNameOf,
          taskTitle
        )
      effort[scope][group] = effortOver(focus.map((s) => s.modelId))
      const effortCovered = effortOver(
        focus.filter((s) => covers(s.tasksCovered, s.tasksTotal) && s.meanScoreAllTrials !== null).map((s) => s.modelId)
      )
      const ctx: FocusContext = {
        nameOf,
        scope,
        groupLabel: group === 'claude' ? 'the Claude family' : 'all models',
        focus,
        cells,
        notRun,
        allCells: cells,
        allCoveredIds: new Set(eligible.map((s) => s.modelId)),
        tasksTotal,
        eligibleAll: eligible.length,
        allEligible: scopeSummaries.filter((s) => s.costPerAttempt !== null && covers(s.tasksCovered, s.tasksTotal)),
        modelEffort,
        modelBase,
        taskTitle,
        taskOrder: taskRank,
        effortCovered,
      }
      insights[scope][group] = focus.length > 0 ? buildInsights(ctx) : []
      guides[scope][group] = focus.length > 0 ? buildGuide(ctx) : emptyGuide()
      glance[scope][group] = focus.length > 0 ? buildGlance(ctx) : { rows: [], sentences: [], notCovering: null }
    }
  }

  const stoppedRecords = cells.filter((c) => c.stopped).length + notRunRecords.length
  const iterationsNotRunAll = sum(cells.map((c) => c.stopped?.notRun ?? 0)) + sum(notRunRecords.map((n) => n.stopped.notRun))

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    source: {
      resultsSha256,
      records: results.length,
      liveRecords: live.length,
      seededExcluded: results.length - live.length,
      iterationsRequested: sum(cells.map((c) => c.iterations)),
      iterationsCompleted: sum(cells.map((c) => c.succeeded ?? 0)),
      iterationsNotRun: iterationsNotRunAll,
      stoppedCells: stoppedRecords,
      fallbackCells: cells.filter((c) => c.fallbackScored).length,
      cellsWithCheckRows: cells.filter((c) => c.checks.length > 0).length,
      scorerVersions: cells.reduce<Record<string, number>>((acc, c) => {
        const k = String(c.scorerVersion)
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {}),
      synthetic: input.synthetic ?? false,
      priceUnderReview: boardModels.filter((m) => m.pricing === 'price-under-review').map((m) => m.name),
    },
    suites,
    categories: categories.map((c) => ({ slug: c.slug, label: c.label })),
    tasks: boardTasks,
    models: boardModels,
    cells,
    scopeTasks,
    summaries,
    insights,
    effort,
    guides,
    glance,
    heldBackTasks: heldBack.map((t) => t.title),
    heldBack: heldBack.map((t) => ({ id: t.id, title: t.title, sentence: heldBackSentence(t) })),
    stoppedNotRun: notRunRecords,
    definitions: {
      costPerAttempt: COST_PER_ATTEMPT_DEFINITION,
      outputCapTokens: OUTPUT_CAP_TOKENS,
      firstPassCapTokens: FIRST_PASS_CAP_TOKENS,
      stoppedRule: STOP_RULE,
      stoppedCount: stoppedCountSentence(stoppedRecords, iterationsNotRunAll),
    },
  }
}

// ── Insights ─────────────────────────────────────────────────────────────

/**
 * What one (scope, group) pair of findings is computed from. `focus` and `cells` hold the group's
 * models in the scope. A finding that names a model names only models that cover at least 80% of
 * the scope's tasks, and its sample clause counts only those models.
 */
export interface FocusContext {
  /** Display name for a model id. */
  nameOf: (id: string) => string
  scope: Scope
  /** Group name for the sentence: "Claude family" or "all models". */
  groupLabel: string
  /** Summaries in this scope for the group's models. */
  focus: BoardSummary[]
  /** Measured cells in this scope for the group's models. */
  cells: Measured[]
  /** Records in this scope for the group's models that stopped before any iteration ran: their cells are not run. */
  notRun: NotRunStop[]
  /** Measured cells in this scope for every model, with the ids of the models that cover 80% of tasks. */
  allCells: Measured[]
  allCoveredIds: Set<string>
  /** Tasks in this scope. */
  tasksTotal: number
  /** Summaries in this scope over every model that has a measured cost and covers 80% of the tasks. */
  eligibleAll: number
  /** The same set as a list: the frontier is computed over it, so a dominating configuration may be outside the group. */
  allEligible: BoardSummary[]
  modelEffort: (id: string) => string | null
  modelBase: (id: string) => string
  taskTitle: (id: string) => string
  taskOrder: (id: string) => number
  /** Effort comparisons over the focus models that cover at least 80% of the scope's tasks (the ones a finding may name). */
  effortCovered: EffortComparison[]
}

const SCOPE_TASKS: Record<Scope, string> = {
  headline: 'headline tasks',
  horizon: 'horizon tasks',
  smoke: 'smoke tasks',
  earlier: 'all tasks',
}
/** The scope's own word for one task, for sentences such as "No headline task ...". */
const SCOPE_NOUN: Record<Scope, string> = { headline: 'headline task', horizon: 'horizon task', smoke: 'smoke task', earlier: 'task' }
/** A check needs this many runs in the group before it can be named as the lowest pass rate. */
export const MIN_CHECK_RUNS = 6

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The scope's tasks as a phrase: "the headline tasks", or "the 11 earlier tasks" for the earlier scope. */
function scopeTasks(ctx: FocusContext): string {
  return ctx.scope === 'earlier' ? `the ${plural(ctx.tasksTotal, 'earlier task')}` : `the ${SCOPE_TASKS[ctx.scope]}`
}

/**
 * The sample clause: the models (or configurations) the sentence is about, the coverage they had (when the sentence names
 * models), and the iterations behind the number. `basis` is 'requested' for a number that counts failed iterations as zero
 * (the all-trials score, cost per attempt and the findings built on them), and 'completed' for a number computed over
 * completed iterations only (speed). `lead` is printed before the count, for a glance sentence that reads "of N configurations".
 */
function sampleClause(
  ctx: FocusContext,
  cells: Measured[],
  covering: boolean,
  basis: 'requested' | 'completed' = 'requested',
  noun: 'model' | 'configuration' = 'configuration',
  lead = ''
): string {
  return `(${sampleInner(ctx, cells, covering, basis, noun, lead)})`
}

/** The sample clause without its parentheses, so a finding can put it inside a longer clause. */
function sampleInner(
  ctx: FocusContext,
  cells: Measured[],
  covering: boolean,
  basis: 'requested' | 'completed' = 'requested',
  noun: 'model' | 'configuration' = 'configuration',
  lead = ''
): string {
  const models = new Set(cells.map((c) => c.cell.modelId)).size
  const iterations = basis === 'requested'
    ? sum(cells.map((c) => c.cell.iterations))
    : sum(cells.map((c) => c.cell.succeeded ?? 0))
  const head = covering
    ? `${lead}${plural(models, noun)} covering at least 80% of ${scopeTasks(ctx)}`
    : `${lead}${plural(models, noun)}`
  return `${head}, ${plural(iterations, basis === 'requested' ? 'requested iteration' : 'completed iteration')}`
}

/**
 * A sentence with a parenthetical clause attached before its final full stop, so the clause never stands as a sentence of
 * its own: "... do not overlap (4 configurations, 120 requested iterations)." The sentence must end with a full stop.
 */
function withClause(sentence: string, clause: string): string {
  return `${sentence.replace(/\.\s*$/, '')} ${clause}.`
}

/** The sentences of a finding, with the clause attached to the last of them. */
function clauseLast(sentences: string[], clause: string): string {
  if (sentences.length === 0) return clause
  return [...sentences.slice(0, -1), withClause(sentences[sentences.length - 1], clause)].join(' ')
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * A dollar amount to three significant figures, trailing zeros kept ($1.60, $0.370): the same format as the page's
 * tables, so a finding and a table agree.
 */
export function formatUsd(x: number): string {
  if (x === 0) return '$0'
  if (Math.abs(x) < 1e-6) return `$${x.toFixed(8)}`
  return `$${x.toPrecision(3)}`
}

function signed(x: number, digits: number): string {
  const v = digits === 1 ? fmt1(Math.abs(x)) : Math.abs(x).toFixed(digits)
  if (x < 0) return `-${v}`
  return x > 0 ? `+${v}` : v
}

function signedUsd(x: number): string {
  return x >= 0 ? `+${formatUsd(x)}` : `-${formatUsd(-x)}`
}

/**
 * One finding. `figure` and `figureUnit` are set here, from the numbers the sentence is built from,
 * so the page never reads a number out of the text. `anchor` is the chart section it links to.
 */
function insight(
  id: string,
  figure: string,
  figureUnit: string,
  anchor: string,
  title: string,
  body: string
): BoardInsight {
  return { id, figure, figureUnit, title, body, anchor }
}

/** Focus models that cover at least 80% of the scope's tasks and have a mean. */
function coveredFocus(ctx: FocusContext): BoardSummary[] {
  return ctx.focus.filter(
    (s) => covers(s.tasksCovered, s.tasksTotal) && s.meanScoreAllTrials !== null
  )
}

function coveredCells(ctx: FocusContext, ids: Set<string>): Measured[] {
  return ctx.cells.filter((c) => ids.has(c.cell.modelId))
}

/** An interval's width in points. */
function intervalWidth(iv: Interval): number {
  return iv[1] - iv[0]
}

/** Whether every iteration of a model's cells in the group is exactly `value`. */
function allIterationsAt(ctx: FocusContext, modelId: string, value: number): boolean {
  const cs = ctx.cells.filter((m) => m.cell.modelId === modelId)
  return cs.length > 0 && cs.every((m) => (m.values ?? [m.cell.scoreAllTrials]).every((x) => Math.abs(x - value) < 1e-9))
}

/** The ranking of covered focus models, with the groups the top score cannot separate. Shared by the finding and the answer. */
function rankTop(ctx: FocusContext): {
  top: BoardSummary
  tied: BoardSummary[]
  close: BoardSummary[]
  wide: BoardSummary[]
  next: BoardSummary | null
  ranked: BoardSummary[]
} | null {
  const eligible = coveredFocus(ctx)
  if (eligible.length === 0) return null
  const ranked = [...eligible].sort(
    (a, b) =>
      b.meanScoreAllTrials - a.meanScoreAllTrials ||
      ctx.nameOf(a.modelId).localeCompare(ctx.nameOf(b.modelId))
  )
  const top = ranked[0]
  // Exact ties on the score are a tie: no interval can separate them. A score below the top is in the top's group only
  // when its interval reaches the top's interval; a wide interval says the configuration is too variable to rank.
  const tied = ranked.filter((s) => Math.abs(s.meanScoreAllTrials - top.meanScoreAllTrials) < 1e-6)
  const rest = ranked.filter((s) => !tied.includes(s))
  // "Reaches the top": the configuration's interval upper bound is at or above the top score. The overlap of two
  // intervals is not used, because a top at the ceiling has a zero-width interval and would reach nothing it should not.
  const reach = rest.filter((s) => s.interval !== null && s.interval[1] >= top.meanScoreAllTrials - 1e-6)
  const wide = reach.filter((s) => s.interval !== null && intervalWidth(s.interval) > WIDE_INTERVAL_POINTS)
  const close = reach.filter((s) => !wide.includes(s))
  return { top, tied, close, wide, next: rest[0] ?? null, ranked }
}

/** Highest all-trials score among focus models covering 80% of the scope's tasks. */
export function insightTop(ctx: FocusContext): BoardInsight | null {
  const r = rankTop(ctx)
  if (!r) return null
  const { top } = r
  const score = (s: BoardSummary) => fmt1(s.meanScoreAllTrials)
  const body = clauseLast(topSentences(ctx, r), sampleClause(ctx, coveredCells(ctx, new Set(coveredFocus(ctx).map((s) => s.modelId))), true))
  return insight('top', score(top), 'pts', 'leaderboard', `Top score, ${SCOPE_TASKS[ctx.scope]}`, body)
}

/** The sentences that say who leads, which configurations tie or cannot be separated from the top, and what is too variable. */
function topSentences(ctx: FocusContext, r: NonNullable<ReturnType<typeof rankTop>>): string[] {
  const { top, tied, close, wide, next } = r
  const score = (s: BoardSummary) => fmt1(s.meanScoreAllTrials)
  const name = (s: BoardSummary) => ctx.nameOf(s.modelId)
  const parts: string[] = []
  if (tied.length >= 2) {
    const every = tied.every((s) => allIterationsAt(ctx, s.modelId, top.meanScoreAllTrials))
    const both = tied.length === 2
    parts.push(`${listNames(tied.map(name))} ${both ? 'both' : 'all'} score ${score(top)}${every ? ' on every iteration' : ''}, so the top cannot be ranked among ${both ? 'them' : 'those configurations'}.`)
  } else {
    parts.push(`${name(top)} leads at ${score(top)} all-trials score.`)
  }
  if (close.length) {
    const subject = close.length === 1 ? 'its 95% interval reaches' : 'their 95% intervals reach'
    parts.push(`Not separable from the top: ${subject} ${score(top)}, so the difference is not established: ${listNames(close.map((s) => `${name(s)} (${score(s)}, interval ${intervalWords(s.interval)})`))}.`)
  }
  if (wide.length) {
    parts.push(`Too variable to rank: ${listNames(wide.map((s) => `${name(s)} (${score(s)}, interval ${intervalWords(s.interval)} wider than ${WIDE_INTERVAL_POINTS} points)`))}.`)
  }
  if (tied.length === 1 && close.length === 0 && wide.length === 0 && next) {
    const gap = top.meanScoreAllTrials - next.meanScoreAllTrials
    if (top.interval && next.interval) {
      parts.push(`It is ${fmt1(gap)} points ahead of ${name(next)}, and their intervals do not overlap.`)
    } else {
      parts.push(`It is ${fmt1(gap)} points ahead of ${name(next)}, but a configuration with fewer than six iteration values has no 95% interval, so the lead is not established.`)
    }
  }
  return parts
}

/** The 95% interval as text, for example "[91.8 to 100.0]", or "not measured". */
function intervalWords(iv: Interval | null): string {
  return iv ? `[${fmt1(iv[0])} to ${fmt1(iv[1])}]` : 'interval not measured'
}

/** The 95% interval without brackets, for example "91.8 to 100.0", for a clause that names it after a comma. */
function intervalPlain(iv: Interval | null): string {
  return iv ? `${fmt1(iv[0])} to ${fmt1(iv[1])}` : 'not measured'
}

/** Cheapest focus model within 5 points of the top covered model. */
export function insightValue(ctx: FocusContext): BoardInsight | null {
  const eligible = coveredFocus(ctx)
  // A value comparison needs at least two covered models; with one there is nothing to be cheaper than.
  if (eligible.length < 2) return null
  const top = [...eligible].sort((a, b) => b.meanScoreAllTrials - a.meanScoreAllTrials)[0]
  const pool = eligible.filter(
    (s) => s.costPerAttempt !== null && s.meanScoreAllTrials >= top.meanScoreAllTrials - VALUE_MARGIN_POINTS
  )
  if (pool.length === 0) return null
  const cheapest = [...pool].sort(
    (a, b) =>
      (a.costPerAttempt as number) - (b.costPerAttempt as number) ||
      b.meanScoreAllTrials - a.meanScoreAllTrials ||
      ctx.nameOf(a.modelId).localeCompare(ctx.nameOf(b.modelId))
  )[0]
  const ids = new Set(eligible.map((s) => s.modelId))
  const body = `${ctx.nameOf(cheapest.modelId)} is the cheapest configuration within ${VALUE_MARGIN_POINTS} points of the top, at ${formatUsd(cheapest.costPerAttempt as number)} per attempt, with an all-trials score of ${fmt1(cheapest.meanScoreAllTrials)} ${sampleClause(ctx, coveredCells(ctx, ids), true)}.`
  return insight('value', formatUsd(cheapest.costPerAttempt as number), 'per attempt', 'frontier', `Cheapest within ${VALUE_MARGIN_POINTS} points of the top`, body)
}

/**
 * Each covering configuration with a measured cost that is off the frontier, with the configuration that dominates it: the
 * one that costs no more and scores no less, and is strictly better on one of the two. Membership compares point scores.
 */
function dominatedSentence(ctx: FocusContext): string {
  const off = ctx.focus.filter((p) => !p.onFrontier && p.costPerAttempt !== null && covers(p.tasksCovered, p.tasksTotal) && p.meanScoreAllTrials !== null)
  const eligible = ctx.allEligible
  if (off.length === 0) return ''
  const cost = (s: BoardSummary) => s.costPerAttempt as number
  const parts = off.filter((p) => eligible.some((q) => q !== p && cost(q) <= cost(p) && q.meanScoreAllTrials >= p.meanScoreAllTrials && (cost(q) < cost(p) || q.meanScoreAllTrials > p.meanScoreAllTrials))).map((p) => {
    const dominators = eligible.filter((q) =>
      q !== p && cost(q) <= cost(p) && q.meanScoreAllTrials >= p.meanScoreAllTrials &&
      (cost(q) < cost(p) || q.meanScoreAllTrials > p.meanScoreAllTrials)
    )
    dominators.sort((a, b) => b.meanScoreAllTrials - a.meanScoreAllTrials || cost(a) - cost(b) || ctx.nameOf(a.modelId).localeCompare(ctx.nameOf(b.modelId)))
    const d = dominators[0]
    return `${ctx.nameOf(p.modelId)} (${fmt1(p.meanScoreAllTrials)}, interval ${intervalWords(p.interval)}) is dominated by ${ctx.nameOf(d.modelId)} (${fmt1(d.meanScoreAllTrials)}, interval ${intervalWords(d.interval)})`
  })
  return `Dominated, so off the frontier (another configuration costs no more and scores no less): ${parts.join('; ')}. Membership compares point scores: differences inside the intervals are not established.`
}

/** Models on the cost-accuracy frontier of the scope, the covering configurations dominated off it, and how many were eligible. */
export function insightFrontier(ctx: FocusContext): BoardInsight | null {
  const front = ctx.focus
    .filter((s) => s.onFrontier && s.costPerAttempt !== null)
    .sort((a, b) => (a.costPerAttempt as number) - (b.costPerAttempt as number))
  if (front.length === 0) return null
  const list = front
    .map((s) => `${ctx.nameOf(s.modelId)} (${formatUsd(s.costPerAttempt as number)} per attempt, ${fmt1(s.meanScoreAllTrials)} all-trials score)`)
    .join('; ')
  const eligibleCells = ctx.allCells.filter((c) => ctx.allCoveredIds.has(c.cell.modelId))
  const dominated = dominatedSentence(ctx)
  const head = `Of ${plural(ctx.eligibleAll, 'configuration')} in ${ctx.groupLabel} with a measured cost that cover at least 80% of ${scopeTasks(ctx)}, ${front.length === 1 ? 'one is' : `${front.length} are`} on the cost-accuracy frontier: ${list}.`
  const clause = sampleClause(ctx, eligibleCells, true)
  const body = dominated ? `${head} ${withClause(dominated, clause)}` : withClause(head, clause)
  return insight('frontier', `${front.length} of ${ctx.eligibleAll}`, 'on the frontier', 'frontier', 'Cost-accuracy frontier', body)
}


/**
 * One insight per base model whose covered effort levels share at least one task. The levels are compared over the
 * tasks every covered level ran, and the sentence says how many tasks that is.
 */
/** The sentence that says what the levels' non-overlapping pairs show, other than the lowest and highest level. */
function otherPairsSentence(levels: EffortLevel[]): string {
  const out: string[] = []
  const last = levels.length - 1
  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      if (i === 0 && j === last) continue
      const a = levels[i]
      const b = levels[j]
      if (!a.interval || !b.interval || intervalsOverlap(a.interval, b.interval)) continue
      // A zero-width interval at the ceiling is the only non-overlap there is: say so plainly, and do not treat it as a test.
      const ceiling = [a, b].find((l) => l.interval && Math.abs(l.interval[0] - CEILING) < 1e-9 && Math.abs(l.interval[1] - CEILING) < 1e-9)
      if (ceiling) {
        const other = ceiling === a ? b : a
        out.push(`${cap(effortWord(ceiling.effort))} effort scored ${fmt1(CEILING)} on all ${plural(ceiling.requested, 'requested iteration')}, and ${effortWord(other.effort)} effort's interval ${intervalWords(other.interval)} does not reach it, so under the page's top rule ${effortWord(other.effort)} effort is separable from ${effortWord(ceiling.effort)} effort. The gap cannot be measured against a zero-width interval at the ceiling.`)
      } else {
        out.push(`The ${effortWord(a.effort)} and ${effortWord(b.effort)} effort intervals do not overlap.`)
      }
    }
  }
  return out.join(' ')
}

export function insightsEffort(ctx: FocusContext): BoardInsight[] {
  const out: BoardInsight[] = []
  for (const comp of ctx.effortCovered) {
    if (comp.levels.length < 2 || comp.tasks.length === 0) continue
    const low = comp.levels[0]
    const high = comp.levels[comp.levels.length - 1]
    if (low.score === null || high.score === null) continue
    const scoreDelta = high.score - low.score
    const members = new Set(comp.levels.map((l) => l.modelId))
    const shared = new Set(comp.tasks)
    const cells = ctx.cells.filter((m) => members.has(m.cell.modelId) && shared.has(m.cell.taskId))
    // Every level is named, with its score and interval. The change from lowest to highest is established only when the
    // two intervals do not overlap; the other pairs of levels are read from their intervals too.
    const levelWords = comp.levels.map((l) =>
      `${effortWord(l.effort)} ${l.score === null ? 'not measured' : fmt1(l.score)} ${intervalWords(l.interval)}`
    )
    const established = !!low.interval && !!high.interval && !intervalsOverlap(low.interval, high.interval)
    // The iterations per task behind the intervals, counted from the compared cells: a stopped cell counts the iterations that
    // ran, so the sentence stays true when a cell is stopped. One count is named; two or more are a range.
    const perTaskCounts = cells.map((m) => m.cell.iterations)
    const perTaskLow = Math.min(...perTaskCounts)
    const perTaskHigh = Math.max(...perTaskCounts)
    const perTaskWords = perTaskLow === perTaskHigh
      ? `${plural(perTaskLow, 'iteration')} per task`
      : `${perTaskLow} to ${plural(perTaskHigh, 'iteration')} per task`
    const others = otherPairsSentence(comp.levels)
    // When another pair of levels does separate, the verdict speaks for the lowest-to-highest change only.
    const notEstablished = others
      ? `so this change is not established with ${perTaskWords}`
      : `so differences are not established with ${perTaskWords}`
    const verdict = established
      ? `The change from ${effortWord(low.effort)} to ${effortWord(high.effort)} effort, ${signed(scoreDelta, 1)} points, is established: the two 95% intervals do not overlap.`
      : intervalsOverlap(low.interval, high.interval)
        ? `The change from ${effortWord(low.effort)} to ${effortWord(high.effort)} effort, ${signed(scoreDelta, 1)} points, is not established: the 95% intervals overlap, ${notEstablished}.`
        : `The change from ${effortWord(low.effort)} to ${effortWord(high.effort)} effort, ${signed(scoreDelta, 1)} points, is not established: an interval is not measured.`
    // The sentences of the finding. The sample clause (the tasks every level ran, and the configurations and iterations
    // behind the scores) goes on the last of them, as it does in the other findings.
    const sentences: string[] = [`${comp.name} all-trials scores by effort, with 95% intervals: ${listNames(levelWords)}.`, verdict]
    if (others) sentences.push(others)
    // Truncations are named where they happened: the count, the cap, and what the completed iterations average.
    for (const l of comp.levels) {
      if (l.truncated === 0) continue
      const done = l.completedMean === null
        ? 'none completed'
        : `its completed iterations averaged ${fmt1(l.completedMean)} per task, over the ${plural(l.completedTasks, 'task')} with a completed iteration`
      // Only when every failed iteration was a truncation do the truncations account for the whole gap to that average.
      const accounts = l.completedMean !== null && l.truncated === l.requested - l.completed
        ? ', so the truncated iterations account for the whole gap between its score and that average'
        : ''
      sentences.push(`${cap(effortWord(l.effort))} effort: ${l.truncated} of ${plural(l.requested, 'requested iteration')} hit the ${OUTPUT_CAP_TOKENS.toLocaleString('en-US')}-token output cap and count as zero; ${done}${accounts}.`)
    }
    // Stopped cells are named where they are compared: the task, the label, and the iterations the score counts.
    for (const note of comp.stopNotes) sentences.push(note)
    if (low.costPerAttempt !== null && high.costPerAttempt !== null) {
      const costDelta = high.costPerAttempt - low.costPerAttempt
      sentences.push(`Cost per attempt changes by ${signedUsd(costDelta)} (${formatUsd(low.costPerAttempt)} to ${formatUsd(high.costPerAttempt)}).`)
    } else {
      sentences.push('Cost per attempt is not measured at one or both effort levels.')
    }
    const compared = `compared on ${plural(comp.tasks.length, 'task')} every effort level ran; ${sampleInner(ctx, cells, true)}`
    const body = clauseLast(sentences, `(${compared})`)
    // Not established: the figure is the range of the levels' scores, lowest to highest, so no level is left out of it.
    const levelScores = comp.levels.map((l) => l.score).filter((x): x is number => x !== null)
    const figureValue = established
      ? signed(scoreDelta, 1)
      : `${fmt1(Math.min(...levelScores))} to ${fmt1(Math.max(...levelScores))}`
    // Any separated pair of levels, not only the lowest and highest, makes the figure's unit a plain points range.
    const anySeparated = comp.levels.some((a, i) => comp.levels.some((b, j) => j > i && !!a.interval && !!b.interval && !intervalsOverlap(a.interval, b.interval)))
    const figureUnit = established || anySeparated ? 'pts' : 'pts, change not established'
    out.push(insight(`effort-${comp.baseModelId}`, figureValue, figureUnit, 'effort', `Effort trade-off: ${comp.name}`, body))
  }
  return out
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Widest headline spread among covered models, and tasks where every covered model that ran them reached the bar. */
export function insightSpread(ctx: FocusContext): BoardInsight | null {
  const ids = new Set(coveredFocus(ctx).map((s) => s.modelId))
  const cells = coveredCells(ctx, ids)
  const byTask = new Map<string, Measured[]>()
  for (const m of cells) byTask.set(m.cell.taskId, [...(byTask.get(m.cell.taskId) ?? []), m])
  const tasks = [...byTask.keys()].sort((a, b) => ctx.taskOrder(a) - ctx.taskOrder(b))
  // Every task that ties for the widest gap is named, not only the first one met.
  let widestGap = -1
  let widest: { task: string; best: Measured; worst: Measured }[] = []
  // Tasks on which every covered model that ran them reached the bar; those at the ceiling on every iteration are split out.
  const perfect: string[] = []
  const atCeiling = new Set<string>()
  let multi = false
  for (const task of tasks) {
    const cs = byTask.get(task) as Measured[]
    if (cs.length < 2) continue
    multi = true
    const sorted = [...cs].sort((a, b) => b.cell.scoreAllTrials - a.cell.scoreAllTrials)
    const best = sorted[0]
    const worst = sorted[sorted.length - 1]
    const gap = round1(best.cell.scoreAllTrials - worst.cell.scoreAllTrials)
    if (gap > widestGap + 1e-9) {
      widestGap = gap
      widest = [{ task, best, worst }]
    } else if (Math.abs(gap - widestGap) <= 1e-9) {
      widest.push({ task, best, worst })
    }
    if (cs.every((m) => m.cell.scoreAllTrials >= EVERY_MODEL_BAR)) perfect.push(task)
    if (cs.every((m) => m.cell.scoreAllTrials >= CEILING - 1e-9)) atCeiling.add(task)
  }
  if (widest.length === 0 || !multi) return null
  const first = widest[0]
  const worstCell = first.worst.cell
  const lowEnd = worstCell.succeeded === 0
    ? worstCell.truncatedIterations === worstCell.iterations
      ? `${ctx.nameOf(worstCell.modelId)} had all ${worstCell.iterations} iterations truncated at the ${OUTPUT_CAP_TOKENS.toLocaleString('en-US')}-token output cap (${fmt1(worstCell.scoreAllTrials)})`
      : `${ctx.nameOf(worstCell.modelId)} had no completed iteration (${fmt1(worstCell.scoreAllTrials)})`
    : `${ctx.nameOf(worstCell.modelId)} scored ${fmt1(worstCell.scoreAllTrials)}`
  const titles = widest.map((w) => ctx.taskTitle(w.task))
  const head = widest.length === 1
    ? `${titles[0]} has the widest spread among covered configurations: ${ctx.nameOf(first.best.cell.modelId)} scored ${fmt1(first.best.cell.scoreAllTrials)} and ${lowEnd}, a gap of ${fmt1(widestGap)} points.`
    : `${listNames(titles)} share the widest spread among covered configurations, a gap of ${fmt1(widestGap)} points. In ${titles[0]}, ${ctx.nameOf(first.best.cell.modelId)} scored ${fmt1(first.best.cell.scoreAllTrials)} and ${lowEnd}.`
  const sentences: string[] = [head]
  const at100 = perfect.filter((t) => atCeiling.has(t))
  const short = perfect.filter((t) => !atCeiling.has(t))
  if (at100.length) sentences.push(`Every covered configuration that ran ${listNames(at100.map(ctx.taskTitle))} scored ${fmt1(CEILING)}.`)
  if (short.length) sentences.push(`Every covered configuration that ran ${listNames(short.map(ctx.taskTitle))} scored ${EVERY_MODEL_BAR} or more.`)
  if (perfect.length === 0) sentences.push(`No ${SCOPE_NOUN[ctx.scope]} had every covered configuration that ran it at ${EVERY_MODEL_BAR} or more.`)
  const body = clauseLast(sentences, sampleClause(ctx, cells, true))
  return insight('spread', fmt1(widestGap), 'pts', 'heatmap', 'Task spread', body)
}


/**
 * Lowest pass rate over the check names pooled across the covering configurations in the scope. Only the configurations
 * that cover 80% of the scope's tasks are pooled, as the other findings are, so a variant that ran few tasks cannot name the check.
 */
export function insightCheck(ctx: FocusContext): BoardInsight | null {
  const covered = coveredFocus(ctx)
  const cells = coveredCells(ctx, new Set(covered.map((s) => s.modelId)))
  const pool = new Map<string, { runs: number; passed: number; tasks: Set<string> }>()
  for (const m of cells) {
    for (const [name, st] of m.checks) {
      const p = pool.get(name) ?? { runs: 0, passed: 0, tasks: new Set<string>() }
      p.runs += st.runs
      p.passed += st.passed
      p.tasks.add(m.cell.taskId)
      pool.set(name, p)
    }
  }
  // A check with fewer than MIN_CHECK_RUNS runs is too thin to name as the lowest.
  const candidates = [...pool].filter(([, p]) => p.runs >= MIN_CHECK_RUNS)
  if (candidates.length === 0) return null
  candidates.sort(
    ([an, a], [bn, b]) => a.passed / a.runs - b.passed / b.runs || b.runs - a.runs || an.localeCompare(bn)
  )
  const [name, p] = candidates[0]
  const pct = fmt1((100 * p.passed) / p.runs)
  // The sample is only the covering cells that carry this check, so the clause counts those configurations and iterations.
  const carrying = cells.filter((m) => m.checks.has(name))
  const withRows = cells.filter((m) => m.cell.checks.length > 0).length
  const missingRows = cells.filter((m) => m.cell.checks.length === 0)
  const coverage = withRows === cells.length
    ? `Named check rows were recorded for every one of the ${plural(cells.length, 'cell')} in that sample.`
    : `Named check rows were recorded for ${withRows} of ${plural(cells.length, 'cell')} in that sample; the others have none: ${listNames(missingRows.slice(0, 4).map((m) => `${ctx.nameOf(m.cell.modelId)} on ${ctx.taskTitle(m.cell.taskId)}${m.cell.truncatedIterations ? ' (truncated at the output cap)' : ''}`))}${missingRows.length > 4 ? ` and ${missingRows.length - 4} more` : ''}.`
  // The clause counts exactly the iterations behind the figure: the completed iterations of the covering cells that carry
  // the check, and of those, the iterations in which the check's row was recorded (the runs the pass rate divides by).
  const carryingModels = new Set(carrying.map((m) => m.cell.modelId)).size
  const carryingDone = sum(carrying.map((m) => m.cell.succeeded ?? 0))
  const clause = `(pooled over ${plural(carryingModels, 'configuration')} covering at least 80% of ${scopeTasks(ctx)}; ${p.runs} of ${plural(carryingDone, 'completed iteration')} in those cells recorded this check)`
  const body = `The lowest check pass rate is ${name} (${[...p.tasks].map((t) => ctx.taskTitle(t)).join(', ')}), passed in ${pct}% of ${plural(p.runs, 'run')}. ${withClause(coverage, clause)}`
  return insight('check', pct, '% passed', 'checks', 'Lowest check pass rate', body)
}

/**
 * Lowest median time to first visible token and highest median output speed among covered models
 * with timings. Command-line agent routes carry no timings, so they never appear here.
 */
export function insightSpeed(ctx: FocusContext): BoardInsight | null {
  const covered = new Set(coveredFocus(ctx).map((s) => s.modelId))
  const timed = ctx.focus.filter((s) => covered.has(s.modelId))
  const ttft = timed
    .filter((s) => s.medianTtftMs !== null)
    .sort((a, b) => (a.medianTtftMs as number) - (b.medianTtftMs as number))[0]
  const tps = timed
    .filter((s) => s.medianTokensPerSec !== null)
    .sort((a, b) => (b.medianTokensPerSec as number) - (a.medianTokensPerSec as number))[0]
  const parts: string[] = []
  if (ttft) parts.push(`the lowest median time to first visible token is ${ctx.nameOf(ttft.modelId)} at ${((ttft.medianTtftMs as number) / 1000).toFixed(2)} s`)
  if (tps) parts.push(`the highest median output speed is ${ctx.nameOf(tps.modelId)} at ${fmt1(tps.medianTokensPerSec as number)} tokens per second`)
  if (parts.length === 0) return null
  const figure = ttft
    ? { value: `${((ttft.medianTtftMs as number) / 1000).toFixed(2)}`, unit: 's to first visible token' }
    : { value: fmt1(tps?.medianTokensPerSec as number), unit: 'tokens per second' }
  const timedCells = coveredCells(ctx, covered).filter((c) => c.cell.ttftMs !== null || c.cell.tokensPerSec !== null)
  const body = `Among covered API and local routes with measured timings, ${parts.join(' and ')}. ${withClause('Command-line agent routes are left out.', sampleClause(ctx, timedCells, true, 'completed'))}`
  return insight('speed', figure.value, figure.unit, 'speed', 'Speed', body)
}

/**
 * Covering configurations with any failed iteration, their completion rates, and the recorded failure reasons. A finding names
 * only configurations that cover at least 80% of the scope's tasks, so the rest are read in the glance table and the limits.
 */
export function insightReliability(ctx: FocusContext): BoardInsight | null {
  const shown = coveredFocus(ctx).filter((s) => s.successRate !== null)
  if (shown.length === 0) return null
  const cells = coveredCells(ctx, new Set(shown.map((s) => s.modelId)))
  const reasonsFor = (modelId: string): string[] => {
    const reasons = new Set<string>()
    for (const m of cells) {
      if (m.cell.modelId !== modelId) continue
      if ((m.cell.succeeded ?? m.cell.iterations) >= m.cell.iterations) continue
      // A truncation is named as one, whatever the record says; any other failure keeps its recorded reason.
      if (m.cell.truncatedIterations > 0) reasons.add('truncated at the output cap')
      const other = m.cell.iterations - (m.cell.succeeded ?? 0) - m.cell.truncatedIterations
      if (m.cell.failureReason && other > 0) reasons.add(m.cell.failureReason)
    }
    return [...reasons].sort()
  }
  const failed = shown
    .filter((s) => (s.successRate as number) < 1)
    .sort((a, b) => (a.successRate as number) - (b.successRate as number) || a.modelId.localeCompare(b.modelId))
  const names = failed.map((s) => {
    const reasons = reasonsFor(s.modelId)
    const why = reasons.length ? `; recorded reason ${reasons.join(', ')}` : ''
    return `${ctx.nameOf(s.modelId)} (${fmt1(100 * (s.successRate as number))}% completed${why})`
  })
  const done = sum(cells.map((c) => c.cell.succeeded ?? 0))
  const requested = sum(cells.map((c) => c.cell.iterations))
  const covering = `${plural(shown.length, 'configuration')} covering at least 80% of ${scopeTasks(ctx)}`
  // A stopped cell's unrun iterations are not requested or failed: they are named here, so the outcome is not read as failures.
  // A record that stopped before any iteration ran is named the same way; its cell is not run.
  const stoppedNames = [
    ...cells
      .filter((m) => m.cell.stopped)
      .map((m) => `${ctx.nameOf(m.cell.modelId)} on ${ctx.taskTitle(m.cell.taskId)}, ${stopLabel(m.cell.stopped?.notRun ?? 0, m.cell.stopped?.planned ?? 0)}`),
    ...ctx.notRun
      .filter((n) => shown.some((s) => s.modelId === n.modelId))
      .map((n) => `${ctx.nameOf(n.modelId)} on ${ctx.taskTitle(n.taskId)}, ${n.label}`),
  ]
  const sentences: string[] = [
    failed.length > 0
      ? `${failed.length} of the ${covering} had failed iterations: ${listNames(names)}.`
      : `None of the ${covering} had a failed iteration.`,
  ]
  if (stoppedNames.length) sentences.push(`Not counted as requested or failed, because the run stopped: ${listNames(stoppedNames)}.`)
  // The outcome is the sample clause: it goes on the last sentence, as in the other findings.
  const body = clauseLast(sentences, `(${done} of ${plural(requested, 'requested iteration')} completed)`)
  const figure = failed.length > 0
    ? { value: fmt1(100 * (failed[0].successRate as number)), unit: '% completed' }
    : { value: '100', unit: '% completed' }
  return insight('reliability', figure.value, figure.unit, 'reliability', 'Reliability', body)
}

function emptyGuide(): ScopeGuide {
  return { answer: [], caveats: [], callout: [] }
}

/**
 * Where seat-pricing stands. 'held': it is registered but held back, because its contrast check did not pass review, so
 * it has no results. 'not-run': it passed review but has not been run, because the API key's spend limit was reached.
 * A task with records is never held back, so this sentence then disappears and the task is counted like any other.
 */
export type HeldBackState = 'held' | 'not-run'
export const SEAT_PRICING_STATE: HeldBackState = 'held'

/** The sentence the page states about each held-back task that has a state of its own. Only seat-pricing has one. */
const HELD_BACK_SENTENCE: Record<string, Record<HeldBackState, string>> = {
  'seat-pricing': {
    held: 'seat-pricing is registered but held back: its contrast check did not pass review, so it has no results.',
    'not-run': "seat-pricing passed review on 2026-11-11 but has not been run yet: the API key's spend limit was reached.",
  },
}

/** The sentence the page states about a held-back task, in the given seat-pricing state. */
export function heldBackSentenceIn(t: { id: string }, state: HeldBackState): string {
  const states = HELD_BACK_SENTENCE[t.id]
  if (states) return states[state]
  return `${t.id} is registered but held back: it has no runs.`
}

/** The sentence the page states about a held-back task, in the state the constant gives. */
function heldBackSentence(t: BoardTask): string {
  return heldBackSentenceIn(t, SEAT_PRICING_STATE)
}

/**
 * The callout under a scope line: the cell size, the ceiling sentence naming the tasks on which every configuration in view
 * scored 100.0 and the tasks on which every covering configuration did, and the configurations at 100.0 on every iteration.
 * Each sentence is computed from the group's cells.
 */
function calloutFor(ctx: FocusContext): string[] {
  const out: string[] = []
  const iters = [...new Set(ctx.cells.map((m) => m.cell.iterations))].sort((a, b) => a - b)
  if (iters.length === 0) return out
  const sample = iters.length === 1
    ? `Each cell is ${iters[0]} iteration${iters[0] === 1 ? '' : 's'}.`
    : `Cells run between ${iters[0]} and ${iters[iters.length - 1]} iterations.`
  out.push(`${sample} Differences inside the 95% intervals are not established.`)
  const models = [...new Set(ctx.cells.map((m) => m.cell.modelId))]
  if (models.length < 2) return out
  const taskIds = [...new Set(ctx.cells.map((m) => m.cell.taskId))].sort((a, b) => ctx.taskOrder(a) - ctx.taskOrder(b))
  const cellOf = (modelId: string, taskId: string) => ctx.cells.find((m) => m.cell.modelId === modelId && m.cell.taskId === taskId)?.cell
  const at100 = (c: BoardCell) => (cellValues(c) ?? [c.scoreAllTrials]).every((x) => Math.abs(x - CEILING) < 1e-9)
  // Tasks every configuration in view ran, and every one of them scored 100.0 on every iteration.
  const ceilingAll = taskIds.filter((t) => {
    const cs = ctx.cells.filter((m) => m.cell.taskId === t).map((m) => m.cell)
    return new Set(cs.map((c) => c.modelId)).size === models.length && cs.every((c) => Math.abs(c.scoreAllTrials - CEILING) < 1e-9)
  })
  // Tasks every covering configuration ran, and every one of them scored 100.0 on every iteration (not already named above).
  const covering = coveredFocus(ctx).map((s) => s.modelId)
  const ceilingCovering = covering.length === 0
    ? []
    : taskIds.filter((t) => !ceilingAll.includes(t) && covering.every((id) => {
        const c = cellOf(id, t)
        return c !== undefined && at100(c)
      }))
  const parts: string[] = []
  if (ceilingAll.length) parts.push(`${listNames(ceilingAll.map((t) => ctx.taskTitle(t)))}, where every configuration in view scored ${fmt1(CEILING)}`)
  if (ceilingCovering.length) parts.push(`${listNames(ceilingCovering.map((t) => ctx.taskTitle(t)))}, where every covering configuration scored ${fmt1(CEILING)}`)
  if (parts.length) {
    const n = ceilingAll.length + ceilingCovering.length
    out.push(`${n === 1 ? 'This task does not' : 'These tasks do not'} separate the configurations: ${parts.join(', and ')}.`)
  }
  const atCeiling = models.filter((id) => allIterationsAt(ctx, id, CEILING))
  if (atCeiling.length) {
    const described = atCeiling.map((id) => {
      const ran = new Set(ctx.cells.filter((m) => m.cell.modelId === id).map((m) => m.cell.taskId)).size
      return ran < ctx.tasksTotal ? `${ctx.nameOf(id)} (ran ${ran} of ${ctx.tasksTotal} tasks)` : ctx.nameOf(id)
    })
    out.push(`At ${fmt1(CEILING)} on every iteration: ${listNames(described)}.`)
  }
  return out
}


/** The at-a-glance rows for every configuration in view, sorted by all-trials score, and at most three sentences. */
export function buildGlance(ctx: FocusContext): GlanceBlock {
  const rows: GlanceRow[] = ctx.focus
    .filter((s) => s.meanScoreAllTrials !== null)
    .map((s) => {
      const cs = ctx.cells.filter((m) => m.cell.modelId === s.modelId).map((m) => m.cell)
      const requested = sum(cs.map((c) => c.iterations))
      const completed = sum(cs.map((c) => c.succeeded ?? 0))
      const failed = requested - completed
      const truncated = sum(cs.map((c) => c.truncatedIterations))
      const other = [...new Set(cs.filter((c) => c.failureReason && c.iterations - (c.succeeded ?? 0) - c.truncatedIterations > 0).map((c) => c.failureReason as string))].sort()
      // Records that stopped before any iteration ran are not measured, but their unrun iterations are named in the row.
      const notRunHere = ctx.notRun.filter((n) => n.modelId === s.modelId)
      const stoppedCells = cs.filter((c) => c.stopped).length + notRunHere.length
      const notRunTotal = sum(cs.map((c) => c.stopped?.notRun ?? 0)) + sum(notRunHere.map((n) => n.stopped.notRun))
      const plannedTotal = sum(cs.map((c) => c.stopped?.planned ?? 0)) + sum(notRunHere.map((n) => n.stopped.planned))
      return {
        modelId: s.modelId,
        name: ctx.nameOf(s.modelId),
        score: s.meanScoreAllTrials,
        interval: s.interval,
        costPerAttempt: s.costPerAttempt,
        medianSecondsPerIteration: s.medianRuntimeMs === null ? null : s.medianRuntimeMs / 1000,
        requested,
        completed,
        failed,
        truncated,
        notRun: notRunTotal,
        stoppedPlanned: plannedTotal,
        stoppedCells,
        stopLabel: stoppedCells ? stopLabel(notRunTotal, plannedTotal) : null,
        failureReason: other.length ? other.join(', ') : null,
        covering: covers(s.tasksCovered, s.tasksTotal),
        tasksCovered: s.tasksCovered,
        tasksTotal: s.tasksTotal,
      }
    })
    .sort((a, b) => Number(b.covering) - Number(a.covering) || b.score - a.score || a.name.localeCompare(b.name))

  const below = rows.filter((x) => !x.covering)
  const maxBelow = below.reduce((m, x) => Math.max(m, x.tasksCovered), 0)
  const notCovering = below.length
    ? `Ran fewer than 80% of the ${ctx.tasksTotal} ${ctx.scope === 'earlier' ? 'tasks' : SCOPE_TASKS[ctx.scope]}: ${plural(below.length, 'configuration')} ran at most ${maxBelow} of ${ctx.tasksTotal} tasks. ${below.length === rows.length ? 'No configuration covers 80% of the tasks, so nothing is compared.' : 'Not compared with the rows above.'}`
    : null
  const sentences: string[] = []
  const r = rankTop(ctx)
  if (!r) return { rows, sentences, notCovering }
  const { top, tied, close, wide } = r
  const name = (s: BoardSummary) => ctx.nameOf(s.modelId)
  const score = (s: BoardSummary) => fmt1(s.meanScoreAllTrials)
  // Sentences 1 and 2 compare every covering configuration, as insightTop does, so they state the same covering sample.
  const covering = coveredFocus(ctx)
  const coveringSample = sampleClause(ctx, coveredCells(ctx, new Set(covering.map((s) => s.modelId))), true, 'requested', 'configuration', 'of ')
  // The not-separable set: the top's group and the configurations whose interval reaches it, without the too-variable ones.
  const group = [...tied, ...close]
  // Configurations whose interval reaches the top but is wider than WIDE_INTERVAL_POINTS. They are named, never compared.
  const tooVariable = wide.length
    ? ` Too variable to rank: ${wide.map((s) => `${name(s)}, ${score(s)}, interval ${intervalPlain(s.interval)}`).join('; ')}.`
    : ''

  // 1. The configurations not separable from the top, then the too-variable ones.
  if (group.length >= 2) {
    sentences.push(`Not separable from the top, ${score(top)} (each 95% interval reaches ${score(top)}, or the configuration scores it): ${listNames(group.map((s) => `${name(s)} (${score(s)})`))} ${coveringSample}.${tooVariable}`)
  } else {
    // The top is alone in its group. A too-variable configuration is not separable either, so it is excluded by name.
    const apart = wide.length ? ', apart from the too-variable configurations named below' : ''
    sentences.push(`${name(top)} is the only covering configuration not separable from its score of ${score(top)}${apart} ${coveringSample}.${tooVariable}`)
  }

  // 2. The value pick: the cheapest configuration not separable from the top (never a too-variable one), against the most
  // expensive configuration at the top value (or, when none of those has a cost, the most expensive in the group).
  const priced = group.filter((s) => s.costPerAttempt !== null)
  if (priced.length) {
    const cheapest = [...priced].sort((a, b) => (a.costPerAttempt as number) - (b.costPerAttempt as number) || name(a).localeCompare(name(b)))[0]
    const atTop = tied.filter((s) => s.costPerAttempt !== null)
    const priciest = [...(atTop.length ? atTop : priced)].sort((a, b) => (b.costPerAttempt as number) - (a.costPerAttempt as number) || name(a).localeCompare(name(b)))[0]
    const comparator = atTop.length ? 'the most expensive configuration at the top value' : 'the most expensive configuration in that group'
    const ratio = (cheapest.costPerAttempt as number) / (priciest.costPerAttempt as number)
    const relative = cheapest.modelId === priciest.modelId
      ? `it is also ${comparator}`
      : `${ratio.toPrecision(2)} times the cost of ${name(priciest)} at ${formatUsd(priciest.costPerAttempt as number)}, ${comparator}`
    sentences.push(`Cheapest configuration not separable from the top: ${name(cheapest)}, ${formatUsd(cheapest.costPerAttempt as number)} per attempt, ${relative} ${coveringSample}.`)
  }

  // 3. The fastest configuration among those not separable from the top, with the sample of that group.
  const timed = group.filter((s) => s.medianRuntimeMs !== null)
  if (timed.length) {
    const fastest = [...timed].sort((a, b) => (a.medianRuntimeMs as number) - (b.medianRuntimeMs as number) || name(a).localeCompare(name(b)))[0]
    const groupCells = coveredCells(ctx, new Set(group.map((s) => s.modelId)))
    const groupSample = `among the ${plural(group.length, 'configuration')} not separable from the top (${plural(sum(groupCells.map((c) => c.cell.iterations)), 'requested iteration')})`
    sentences.push(`Fastest configuration not separable from the top: ${name(fastest)} at ${fmt1((fastest.medianRuntimeMs as number) / 1000)} seconds median per completed iteration, ${groupSample}.`)
  }
  return { rows, sentences: sentences.slice(0, 3), notCovering }
}

export function buildInsights(ctx: FocusContext): BoardInsight[] {
  const out: (BoardInsight | BoardInsight[] | null)[] = [
    insightTop(ctx),
    insightValue(ctx),
    insightFrontier(ctx),
    insightsEffort(ctx),
    insightSpread(ctx),
    insightCheck(ctx),
    insightSpeed(ctx),
    insightReliability(ctx),
  ]
  return out.flat().filter((x): x is BoardInsight => x !== null)
}

/**
 * The answer to "which model for what" and its caveats, for one scope and group. The answer names the top, the value
 * pick within the top's margin, and the cheapest covered configuration with the tasks where it trails the top. The
 * caveats give the sample, the ceiling and the output-cap truncations. Every number is computed here.
 */
export function buildGuide(ctx: FocusContext): ScopeGuide {
  const answer: string[] = []
  const caveats: string[] = []
  const r = rankTop(ctx)
  const covered = coveredFocus(ctx)
  const name = (s: BoardSummary) => ctx.nameOf(s.modelId)
  const cellOf = (modelId: string, taskId: string) =>
    ctx.cells.find((m) => m.cell.modelId === modelId && m.cell.taskId === taskId)?.cell

  // The answer needs a covered focus model. The caveats below do not: a truncation is a limit whatever the coverage.
  if (r) answerFor(ctx, r, covered, name, cellOf, answer)
  caveatsFor(ctx, covered, name, cellOf, caveats)
  return { answer, caveats, callout: calloutFor(ctx) }
}

function answerFor(
  ctx: FocusContext,
  r: NonNullable<ReturnType<typeof rankTop>>,
  covered: BoardSummary[],
  name: (s: BoardSummary) => string,
  cellOf: (modelId: string, taskId: string) => BoardCell | undefined,
  answer: string[]
): void {
  const { top } = r
  // The top, as the finding words it.
  const tiedNames = r.tied.map((s) => ctx.nameOf(s.modelId))
  answer.push(r.tied.length >= 2
    ? `${listNames(tiedNames)} share the top score, ${fmt1(top.meanScoreAllTrials)}. The Top score finding below gives the full statement.`
    : `${ctx.nameOf(top.modelId)} leads at ${fmt1(top.meanScoreAllTrials)}. The Top score finding below gives the full statement.`)

  // The value pick: the cheapest covered configuration within the top's margin.
  const pool = covered.filter((s) => s.costPerAttempt !== null && s.meanScoreAllTrials >= top.meanScoreAllTrials - VALUE_MARGIN_POINTS)
  const value = [...pool].sort((a, b) =>
    (a.costPerAttempt as number) - (b.costPerAttempt as number) || b.meanScoreAllTrials - a.meanScoreAllTrials ||
    name(a).localeCompare(name(b))
  )[0]
  if (value) {
    answer.push(`Cheapest within ${VALUE_MARGIN_POINTS} points of the top: ${name(value)} at ${formatUsd(value.costPerAttempt as number)} per attempt, scoring ${fmt1(value.meanScoreAllTrials)}.`)
  }

  // The cheapest covered configuration, and the tasks where it trails the top by TRAIL_POINTS or more.
  const priced = covered.filter((s) => s.costPerAttempt !== null)
  const cheapest = [...priced].sort((a, b) => (a.costPerAttempt as number) - (b.costPerAttempt as number) || name(a).localeCompare(name(b)))[0]
  if (cheapest && cheapest.modelId !== top.modelId) {
    const trails: string[] = []
    for (const taskId of ctx.allCells.map((m) => m.cell.taskId).filter((t, i, a) => a.indexOf(t) === i)) {
      const c = cellOf(cheapest.modelId, taskId)
      const t = cellOf(top.modelId, taskId)
      if (!c || !t) continue
      if (t.scoreAllTrials - c.scoreAllTrials >= TRAIL_POINTS - 1e-9) {
        trails.push(`${ctx.taskTitle(taskId)} (${fmt1(c.scoreAllTrials)} against ${fmt1(t.scoreAllTrials)})`)
      }
    }
    const where = trails.length ? `it trails the top by ${TRAIL_POINTS} points or more on ${listNames(trails)}` : `it does not trail the top by ${TRAIL_POINTS} points or more on any task both ran`
    answer.push(`Cheapest covered configuration: ${name(cheapest)} at ${formatUsd(cheapest.costPerAttempt as number)} per attempt, scoring ${fmt1(cheapest.meanScoreAllTrials)}; ${where}.`)
  } else if (cheapest) {
    answer.push(`The top configuration is also the cheapest covered one, at ${formatUsd(cheapest.costPerAttempt as number)} per attempt.`)
  }
}

/** The sample, the ceiling and the output-cap truncations: the limits a reader must hold the answer to. */
function caveatsFor(
  ctx: FocusContext,
  covered: BoardSummary[],
  name: (s: BoardSummary) => string,
  cellOf: (modelId: string, taskId: string) => BoardCell | undefined,
  caveats: string[]
): void {
  // Sample: iterations per cell, and how wide the intervals are, so a difference is read against them.
  const iters = ctx.cells.map((m) => m.cell.iterations)
  if (iters.length) {
    const lo = Math.min(...iters)
    const hi = Math.max(...iters)
    const per = lo === hi ? `Each cell ran ${lo} iteration${lo === 1 ? '' : 's'}` : `Cells ran between ${lo} and ${hi} iterations`
    const width = median(covered.map((s) => (s.interval ? intervalWidth(s.interval) : null)))
    const widthText = width === null ? '' : ` The median 95% interval among covered configurations is ${width.toFixed(0)} points wide.`
    caveats.push(`${per}. A difference smaller than the intervals is not established.${widthText}`)
  }

  // Truncations: every configuration in the group that hit the output cap in this scope, covered or not.
  const byModel = new Map<string, { truncated: number; requested: number; tasks: string[] }>()
  for (const m of ctx.cells) {
    const c = m.cell
    if (c.truncatedIterations === 0) continue
    const entry = byModel.get(c.modelId) ?? { truncated: 0, requested: 0, tasks: [] }
    entry.truncated += c.truncatedIterations
    entry.tasks.push(`${ctx.taskTitle(c.taskId)} ${c.truncatedIterations} of ${c.iterations}`)
    byModel.set(c.modelId, entry)
  }
  for (const m of ctx.cells) {
    const entry = byModel.get(m.cell.modelId)
    if (entry) entry.requested += m.cell.iterations
  }
  if (byModel.size) {
    const items = [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([id, e]) =>
      `${ctx.nameOf(id)} on ${e.truncated} of ${plural(e.requested, 'requested iteration')} (${listNames(e.tasks)})`
    )
    caveats.push(`Output-cap truncations, counted as zero and billed: ${items.join('; ')}.`)
  }

  // Stopped cells: every cell in the group whose record stopped at the account's spend limit or a quota, named with its label.
  // The run ended these cells, so the model is not charged with the iterations that did not run.
  // A record that stopped before any iteration ran is named here too: its cell is not run, so it is not in the cells above.
  const stopped = ctx.cells.filter((m) => m.cell.stopped)
  if (stopped.length || ctx.notRun.length) {
    const items = [
      ...stopped.map((m) =>
        `${ctx.nameOf(m.cell.modelId)} on ${ctx.taskTitle(m.cell.taskId)}, ${stopLabel(m.cell.stopped?.notRun ?? 0, m.cell.stopped?.planned ?? 0)}`
      ),
      ...ctx.notRun.map((n) => `${ctx.nameOf(n.modelId)} on ${ctx.taskTitle(n.taskId)}, ${n.label}`),
    ]
    caveats.push(`Stopped cells, not counted as requested, failed or scored for the iterations that did not run: ${items.join('; ')}.`)
  }
}
