import { afterAll, describe, expect, it } from 'vitest'
import type { BenchmarkTask } from '../types'
import { BENCHMARK_TASKS } from '../registry'
import { pluginChecks } from '../plugins'
import { getChecksForTask } from './checks'
import { closeSandbox, defineCheck, runChecks, type CheckFn } from './sandbox'

afterAll(closeSandbox)

/**
 * The point budget each task's checks are pinned to. A task's total is what
 * its `methodNotes` document where it states one (the visual games and the
 * gateway console do, as explicit point figures); the built-in five and the
 * tic-tac-toe example state no point figures, so their totals are pinned here
 * as shipped. Changing a budget is a scoring change and has to edit this table.
 */
const PINNED_BUDGETS: Record<string, Record<string, number>> = {
  'n-body-field': { 'nbody-renders': 35, 'nbody-animates': 30 },
  'mini-platformer': { 'platformer-jump': 30, 'platformer-move': 25 },
  'landing-page-morph': { 'landing-structure': 30, 'landing-animates': 35 },
  'physics-pendulum-wave': { 'pendulum-renders': 35, 'pendulum-animates': 30 },
  'circuit-builder-teaser': { 'circuit-structure': 30, 'circuit-interact': 35 },
  'tic-tac-toe': { 'ttt-grid-interacts': 35, 'ttt-win-detected': 30 },
  'voxel-lighthouse': { 'lighthouse-rotation': 35, 'lighthouse-orbit': 35, 'lighthouse-reset': 30 },
  'car-racer': { 'racer-acceleration': 35, 'racer-steering': 25, 'racer-braking': 20, 'racer-restart': 20 },
  'gateway-console': { 'gateway-fail-closed': 30, 'gateway-rate-backoff': 35, 'gateway-no-fabrication': 35 },
  // The horizon suite (plugins/horizon-suite, mounted in plugins/index.ts): seven
  // tasks, 76 checks. Its owner changes a budget here, in the same change.
  'orbit-lab': {
    'orbit-contract-paused': 8,
    'orbit-kepler-period': 10,
    'orbit-energy-fourth-order': 12,
    'orbit-symplectic-reversible': 12,
    'orbit-momentum-com': 6,
    'orbit-softening-reference': 8,
    'orbit-diagnostics': 10,
    'orbit-hud-numbers': 6,
    'orbit-view-fit': 8,
    'orbit-bodies-drawn': 12,
    'orbit-trails-history': 8,
  },
  'pathfinding-lab': {
    'path-grid-render': 8,
    'path-dijkstra': 12,
    'path-astar-optimal': 12,
    'path-astar-expansion': 10,
    'path-bfs': 8,
    'path-no-path-trivial': 10,
    'path-diagonal-rules': 12,
    'path-visual-sync': 12,
    'path-edit-resolve': 8,
    'path-stats-dom': 8,
  },
  'rlc-response-lab': {
    'rlc-metrics': 10,
    'rlc-peak-overshoot': 8,
    'rlc-response': 14,
    'rlc-step-underdamped': 10,
    'rlc-step-critical-overdamped': 12,
    'rlc-bode-curve': 14,
    'rlc-bode-autorange': 8,
    'rlc-peak-resolved': 8,
    'rlc-step-plot': 8,
    'rlc-readouts': 8,
  },
  'bicycle-blueprint': {
    'bike-wheels-ground': 8,
    'bike-frame-joints': 14,
    'bike-drivetrain-circles': 6,
    'bike-chain-tangent': 14,
    'bike-crank-pedals': 8,
    'bike-spokes': 8,
    'bike-wheel-rotation': 10,
    'bike-readouts': 12,
    'bike-saddle-bars': 4,
    'bike-fits-view': 6,
    'bike-validation': 5,
    'bike-painted': 5,
  },
  'sector-clock': {
    'clock-structure': 6,
    'clock-ticks-numerals': 7,
    'clock-minute-second': 8,
    'clock-hour-hand': 11,
    'clock-offset-time': 11,
    'clock-date-window': 7,
    'clock-iso-week': 7,
    'clock-subdial-24h': 6,
    'clock-sector-band': 6,
    'clock-sector-arcs': 12,
    'clock-edge-instants': 6,
    'clock-host-timezone': 6,
    'clock-sync-validation': 7,
  },
  'kanban-keyboard-undo': {
    'kanban-structure-names': 7,
    'kanban-add-validation': 8,
    'kanban-keyboard-moves': 13,
    'kanban-focus-management': 11,
    'kanban-wip-limit': 8,
    'kanban-undo-redo': 16,
    'kanban-safe-rendering': 9,
    'kanban-persistence-recovery': 9,
    'kanban-update-budget': 10,
    'kanban-robust-session': 9,
  },
  'seat-pricing': {
    'pricing-graduated-tiers': 10,
    'pricing-discount-order': 12,
    'pricing-exact-rounding': 14,
    'pricing-display-format': 7,
    'pricing-seats-validation': 11,
    'pricing-keyboard': 10,
    'pricing-accessible-names': 8,
    'pricing-contrast': 8,
    'pricing-responsive': 10,
    'pricing-breakdown-geometry': 10,
  },
}

/** Totals the task itself documents. Only these are asserted as documented. */
const DOCUMENTED_TOTALS: Record<string, number> = {
  'voxel-lighthouse': 100, // methodNotes: 35 + 35 + 30
  'car-racer': 100, // methodNotes: 35 + 25 + 20 + 20
  'gateway-console': 100, // methodNotes and prompt comments: 30 / 35 / 35
}

const BLANK_PAGE = '<!doctype html><html><body><p>nothing here</p></body></html>'

function taskById(id: string): BenchmarkTask {
  const task = BENCHMARK_TASKS.find((t) => t.id === id)
  if (!task) throw new Error(`no task ${id}`)
  return task
}

function budgetsOf(checks: CheckFn[]): Record<string, number> {
  return Object.fromEntries(checks.map((c) => [c.checkName ?? '', c.maxPoints ?? -1]))
}

describe('check metadata', () => {
  it('every check every task runs has a non-empty name and a positive budget', () => {
    for (const task of BENCHMARK_TASKS) {
      for (const check of getChecksForTask(task)) {
        expect(check.checkName, `task ${task.id}`).toBeTruthy()
        expect(check.maxPoints ?? 0, `task ${task.id} check ${check.checkName}`).toBeGreaterThan(0)
      }
    }
  })

  it('pins the checks and budgets of every task that runs checks, so a new task cannot skip the table', () => {
    for (const task of BENCHMARK_TASKS) {
      const checks = getChecksForTask(task)
      if (checks.length === 0) continue
      expect(PINNED_BUDGETS, `task ${task.id} has checks but no pinned budgets`).toHaveProperty([task.id])
      expect(budgetsOf(checks), `task ${task.id}`).toEqual(PINNED_BUDGETS[task.id])
    }
  })

  it('sums each task budget to the total the task documents', () => {
    for (const [taskId, total] of Object.entries(DOCUMENTED_TOTALS)) {
      const sum = Object.values(PINNED_BUDGETS[taskId] ?? {}).reduce((a, b) => a + b, 0)
      expect(sum, `task ${taskId}`).toBe(total)
      const runtimeSum = getChecksForTask(taskById(taskId)).reduce((a, c) => a + (c.maxPoints ?? 0), 0)
      expect(runtimeSum, `task ${taskId} as registered`).toBe(total)
    }
  })

  it('hands out the same stamped object the plugin registry holds', () => {
    const registry = pluginChecks()
    const ttt = taskById('tic-tac-toe')
    const [grid] = getChecksForTask(ttt)
    expect(registry['ttt-grid-interacts']).toBe(grid)
    const racer = taskById('car-racer')
    const [acceleration] = getChecksForTask(racer)
    expect(registry['racer-acceleration']).toBe(acceleration)
  })

  it('gives a built-in check the same object through a task list and a named reference', () => {
    const nbody = getChecksForTask(taskById('n-body-field'))[0]
    const named = getChecksForTask({ ...taskById('n-body-field'), checks: ['nbody-renders'] })[0]
    expect(named).toBe(nbody)
  })
})

// Browser-gated: each check, run on a page where it cannot succeed, reports the
// name and budget it declares. This is the one place the budget literal inside
// a check's own return value is compared against the declared metadata.
describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('declared budgets match what checks report', () => {
  it('every registered check reports its declared name and budget on a blank page', async () => {
    for (const task of BENCHMARK_TASKS) {
      const checks = getChecksForTask(task)
      if (checks.length === 0) continue
      const results = await runChecks(BLANK_PAGE, checks, { perCheckTimeoutMs: 8000, totalTimeoutMs: 120_000 })
      expect(results.length, `task ${task.id}`).toBe(checks.length)
      results.forEach((result, i) => {
        expect(result.name, `task ${task.id} check ${i}`).toBe(checks[i]!.checkName)
        expect(result.maxPoints, `task ${task.id} ${result.name}`).toBe(checks[i]!.maxPoints)
      })
    }
  }, 300_000)
})

// Browser-gated: a row a check returns is held to the check's own declaration.
describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('returned rows are held to their declaration', () => {
  it('a declared check that reports another name is recorded as a failure, with its own name and budget', async () => {
    const liar = defineCheck('declared-name', 30, async () => ({
      name: 'other-name',
      passed: true,
      points: 30,
      maxPoints: 30,
    }))
    const [row] = await runChecks(BLANK_PAGE, [liar], { perCheckTimeoutMs: 8000 })
    expect(row).toMatchObject({ name: 'declared-name', passed: false, points: 0, maxPoints: 30 })
    expect(row!.detail).toMatch(/disagrees with declaration/)
  })

  it('a declared check that awards more than its budget is clamped to the budget', async () => {
    const over = defineCheck('over-award', 30, async () => ({
      name: 'over-award',
      passed: true,
      points: 500,
      maxPoints: 30,
    }))
    const [row] = await runChecks(BLANK_PAGE, [over], { perCheckTimeoutMs: 8000 })
    expect(row).toMatchObject({ name: 'over-award', passed: true, points: 30, maxPoints: 30 })
  })

  it('a declared check that throws keeps its declared budget, so it stays in the denominator', async () => {
    const throws = defineCheck('throws-here', 25, async () => {
      throw new Error('artifact-induced failure')
    })
    const [row] = await runChecks(BLANK_PAGE, [throws], { perCheckTimeoutMs: 8000 })
    expect(row).toMatchObject({ name: 'throws-here', passed: false, points: 0, maxPoints: 25 })
    expect(row!.detail).toMatch(/threw: artifact-induced failure/)
  })
})
