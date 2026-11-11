/**
 * fixtureMatrix: proves that a task's checks DISCRIMINATE. Call it inside a
 * vitest file (plugins/horizon-suite/<task>/...test.ts). Behind
 * BENCH_BROWSER_TESTS=1 it runs every fixture through the real runChecks, with the
 * production budgets of behavioral.ts (6 s per check, 25 s per run), then checks the
 * per-check table against an expectation for each fixture:
 *
 *   'good'          every check passes and the score is the full total
 *   'static'        nothing passes: the score is 0 and the denominator is the full total
 *   ['name', ...]   exactly these checks fail (with points) and every other check passes
 *
 * The matrix also fails when there is no fixture with expectation 'good', when the
 * fixture list is empty, or when a fixture has no expectation. The denominator (the
 * sum of the rows' maxPoints) must equal totalPoints in every fixture, so a check that
 * cannot run still counts.
 *
 * Pass checksModule to also score the good fixture through the tsx loader in a child
 * process, the path the sweep CLI takes (postmortem 0008: a named function in
 * page.evaluate can pick up tsx's __name helper). The child must score 100 of 100.
 *
 * On failure the whole matrix is printed: one column per fixture (F1..Fn, named in
 * the legend under the table), and the detail of every cell marked '!'. Set
 * BENCH_MATRIX_OUT to a directory to save every matrix there, pass or fail.
 * Test-only: no check file may import this module.
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { CheckFn, CheckResult } from '../../../scorers/check-meta'
import { closeSandbox, runChecks } from '../../../scorers/sandbox'

export interface FixtureSpec {
  name: string
  html: string
}

/** 'good', 'static', or the exact names of the checks that must fail. */
export type Expectation = 'good' | 'static' | readonly string[]

export interface FixtureMatrixOptions {
  taskId: string
  checks: readonly CheckFn[]
  fixtures: readonly FixtureSpec[]
  expectations: Record<string, Expectation>
  /** Full score denominator. Default 100. */
  totalPoints?: number
  /**
   * The module file URL and the export name of the task's check list. When given,
   * the good fixture is also run through the tsx loader in a child process.
   */
  checksModule?: { url: string; exportName: string }
}

/** The production budgets, as behavioral.ts passes them to runChecks. */
const PER_CHECK_MS = 6000
const TOTAL_MS = 25000
const RUN_OPTIONS = { settleMs: 600, perCheckTimeoutMs: PER_CHECK_MS, totalTimeoutMs: TOTAL_MS }

interface Verdict {
  fixture: string
  rows: CheckResult[]
  points: number
  denominator: number
  problems: string[]
}

const RUNTIME_ROW = 'no-runtime-errors'
const SANDBOX_URL = new URL('../../../scorers/sandbox.ts', import.meta.url).href

function judge(
  fixture: string,
  expectation: Expectation | undefined,
  rows: CheckResult[],
  checkNames: readonly string[],
  totalPoints: number
): Verdict {
  const problems: string[] = []
  const points = rows.reduce((sum, r) => sum + r.points, 0)
  const denominator = rows.reduce((sum, r) => sum + r.maxPoints, 0)
  if (denominator !== totalPoints) {
    problems.push(`denominator ${denominator} is not ${totalPoints}`)
  }
  const scored = rows.filter((r) => r.maxPoints > 0)
  const failing = scored.filter((r) => !r.passed).map((r) => r.name)
  const runtime = rows.find((r) => r.name === RUNTIME_ROW)

  if (expectation === undefined) {
    problems.push('no expectation for this fixture')
  } else if (expectation === 'good') {
    if (failing.length > 0) problems.push(`good fixture fails ${failing.join(', ')}`)
    if (points !== totalPoints) problems.push(`good fixture scores ${points}, not ${totalPoints}`)
    if (runtime !== undefined && !runtime.passed) problems.push(`good fixture has page errors: ${runtime.detail ?? ''}`)
  } else if (expectation === 'static') {
    if (points !== 0) problems.push(`static fake scores ${points}, not 0`)
    if (failing.length !== scored.length) problems.push('static fake passes a check')
  } else {
    for (const name of expectation) {
      if (!checkNames.includes(name)) problems.push(`expectation names unknown check ${name}`)
    }
    const want = [...expectation].sort()
    const got = [...failing].sort()
    if (want.join('|') !== got.join('|')) {
      const missing = want.filter((n) => !got.includes(n))
      const unexpected = got.filter((n) => !want.includes(n))
      if (missing.length > 0) problems.push(`expected to fail but passed: ${missing.join(', ')}`)
      if (unexpected.length > 0) problems.push(`unexpectedly failed: ${unexpected.join(', ')}`)
    }
  }
  return { fixture, rows, points, denominator, problems }
}

/** Whether a cell disagrees with its fixture's expectation. */
function contrary(row: CheckResult, expectation: Expectation | undefined): boolean {
  if (expectation === 'good') return !row.passed
  if (expectation === 'static') return row.passed
  if (Array.isArray(expectation)) return expectation.includes(row.name) === row.passed
  return false
}

function cell(verdict: Verdict, name: string, expectation: Expectation | undefined): string {
  const row = verdict.rows.find((r) => r.name === name)
  if (row === undefined) return '-'
  if (row.maxPoints === 0) return row.passed ? 'ok' : 'err'
  const letter = row.passed ? 'P' : 'F'
  return contrary(row, expectation) ? `${letter}!` : letter
}

function matrixText(
  taskId: string,
  checks: readonly CheckFn[],
  verdicts: Verdict[],
  expectations: Record<string, Expectation>
): string {
  const names = checks.map((c) => c.checkName ?? '(unnamed)')
  const runtimeRows = verdicts.some((v) => v.rows.some((r) => r.name === RUNTIME_ROW)) ? [RUNTIME_ROW] : []
  const rowNames = [...names, ...runtimeRows]
  const nameWidth = Math.max(...rowNames.map((n) => n.length), 'check'.length)
  const columns = verdicts.map((v, i) => ({ label: `F${i + 1}`, verdict: v }))
  const header = 'check'.padEnd(nameWidth) + ' | ' + columns.map((c) => c.label.padEnd(4)).join(' ') + ' | max'
  const lines = [`fixture matrix: ${taskId}  (P pass, F fail, ! contrary to expectation, ok/err runtime row)`, header]
  rowNames.forEach((name, rowIndex) => {
    const max = checks[rowIndex]?.maxPoints ?? 0
    const cells = columns.map((c) => cell(c.verdict, name, expectations[c.verdict.fixture]).padEnd(4))
    lines.push(name.padEnd(nameWidth) + ' | ' + cells.join(' ') + (rowIndex < names.length ? ` | ${max}` : ' | -'))
  })
  lines.push('')
  verdicts.forEach((v, i) => {
    const expectation = expectations[v.fixture]
    const label =
      typeof expectation === 'string'
        ? expectation
        : expectation === undefined
          ? 'none given'
          : expectation.length === 0
            ? 'no check fails'
            : `exactly ${expectation.join(', ')} fail`
    lines.push(`F${i + 1} = ${v.fixture}: expect ${label}; scores ${v.points}/${v.denominator}`)
    for (const p of v.problems) lines.push(`    - ${p}`)
    for (const row of v.rows) {
      if (row.maxPoints > 0 && contrary(row, expectation)) {
        lines.push(`    ! ${row.name}: ${row.passed ? 'passed' : 'failed'} ${row.detail ?? ''}`.trimEnd())
      }
    }
  })
  return lines.join('\n')
}

/** Score the good fixture through the tsx loader in a child process, as the sweep CLI does. */
async function scoreThroughTsx(
  good: FixtureSpec,
  checksModule: { url: string; exportName: string }
): Promise<{ points: number; denominator: number; failing: string[] }> {
  const script = `import {runChecks,closeSandbox} from ${JSON.stringify(SANDBOX_URL)};
import * as module from ${JSON.stringify(checksModule.url)};
(async()=>{try{const rows=await runChecks(${JSON.stringify(good.html)},[...module[${JSON.stringify(checksModule.exportName)}]],${JSON.stringify(RUN_OPTIONS)});console.log('MATRIX_ROWS '+JSON.stringify(rows))}finally{await closeSandbox()}})();`
  const { stdout } = await promisify(execFile)(resolve('node_modules/.bin/tsx'), ['--eval', script], {
    timeout: TOTAL_MS + 30_000,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('MATRIX_ROWS '))
  if (line === undefined) throw new Error(`tsx run printed no rows:\n${stdout}`)
  const rows = JSON.parse(line.slice('MATRIX_ROWS '.length)) as CheckResult[]
  return {
    points: rows.reduce((sum, r) => sum + r.points, 0),
    denominator: rows.reduce((sum, r) => sum + r.maxPoints, 0),
    failing: rows.filter((r) => r.maxPoints > 0 && !r.passed).map((r) => r.name),
  }
}

/**
 * The structural problems of a matrix, before any fixture runs: duplicate check
 * names, a budget that does not sum to the total, an empty fixture list, no fixture
 * with expectation 'good', and an expectation for a fixture that does not exist.
 * Empty when the matrix is well formed. Exported for the kit's own tests.
 */
export function structureProblems(options: Omit<FixtureMatrixOptions, 'taskId'>): string[] {
  const { checks, fixtures, expectations } = options
  const totalPoints = options.totalPoints ?? 100
  const problems: string[] = []
  const checkNames = checks.map((c) => c.checkName ?? '')
  if (new Set(checkNames).size !== checkNames.length) problems.push('check names are not unique')
  const budget = checks.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0)
  if (budget !== totalPoints) problems.push(`declared check budgets sum to ${budget}, not ${totalPoints}`)
  if (fixtures.length === 0) problems.push('the matrix has no fixtures')
  if (!fixtures.some((f) => expectations[f.name] === 'good')) problems.push('no fixture has expectation good')
  const fixtureNames = fixtures.map((f) => f.name)
  for (const key of Object.keys(expectations)) {
    if (!fixtureNames.includes(key)) problems.push(`expectation ${key} has no fixture`)
  }
  return problems
}

/**
 * Register a vitest suite for one task. Every fixture runs through runChecks.
 * Requires BENCH_BROWSER_TESTS=1 (otherwise the suite is skipped).
 */
export function fixtureMatrix(options: FixtureMatrixOptions): void {
  const { taskId, checks, fixtures, expectations, checksModule } = options
  const totalPoints = options.totalPoints ?? 100

  describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')(`fixture matrix: ${taskId}`, () => {
    afterAll(closeSandbox)

    it(
      `every fixture earns exactly its expected checks`,
      async () => {
        expect(structureProblems(options), 'matrix structure').toEqual([])
        const checkNames = checks.map((c) => c.checkName ?? '')
        const good = fixtures.find((f) => expectations[f.name] === 'good')

        const verdicts: Verdict[] = []
        for (const fixture of fixtures) {
          const rows = await runChecks(fixture.html, [...checks], RUN_OPTIONS)
          verdicts.push(judge(fixture.name, expectations[fixture.name], rows, checkNames, totalPoints))
        }
        const failing = verdicts.filter((v) => v.problems.length > 0)
        const text = matrixText(taskId, checks, verdicts, expectations)
        if (failing.length > 0) console.log(text)
        // BENCH_MATRIX_OUT=<dir> writes every task's matrix to <dir>/<task>.txt, pass or fail.
        if (process.env.BENCH_MATRIX_OUT) writeFileSync(join(process.env.BENCH_MATRIX_OUT, `${taskId}.txt`), text + '\n')
        expect(failing.map((v) => ({ fixture: v.fixture, problems: v.problems })), text).toEqual([])

        if (checksModule !== undefined && good !== undefined) {
          const tsx = await scoreThroughTsx(good, checksModule)
          const detail = `tsx run of ${good.name}: ${tsx.points}/${tsx.denominator}, failing ${tsx.failing.join(', ') || 'none'}`
          expect(tsx.denominator, detail).toBe(totalPoints)
          expect(tsx.failing, detail).toEqual([])
          expect(tsx.points, detail).toBe(totalPoints)
        }
      },
      Math.max(120_000, fixtures.length * 75_000) + (checksModule ? TOTAL_MS + 30_000 : 0)
    )
  })
}
