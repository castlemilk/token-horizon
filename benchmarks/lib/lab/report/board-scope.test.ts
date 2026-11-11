import { describe, it, expect } from 'vitest'

import {
  COST_PER_ATTEMPT_DEFINITION,
  CURRENT_SCORER_VERSION,
  SCOPE_KEYS,
  inScopeCell,
  type BoardCell,
} from './board'
// The synthetic board is built through the real buildBoard, from the real registry.
import { buildSyntheticBoard } from '../../../report/fixtures/synthetic-board.mjs'

/**
 * Scope and cost rules of the report: scorer versions are never mixed, the three scopes are headline, smoke and
 * earlier runs (scorer v1), and cost is per attempt. The synthetic board carries every scope, so the rules are
 * checked on data with all three.
 */
const board = buildSyntheticBoard() as ReturnType<typeof import('./board').buildBoard>

describe('scopes: scorer versions are never mixed', () => {
  it('the scopes are headline, horizon, smoke and earlier, and no mixed "all" scope exists', () => {
    expect([...SCOPE_KEYS]).toEqual(['headline', 'horizon', 'smoke', 'earlier'])
    expect(board.summaries.some((s) => (s.scope as string) === 'all')).toBe(false)
  })

  it('the horizon scope holds only the horizon suite, and only version 2 cells', () => {
    expect(inScopeCell({ suite: 'horizon', scorerVersion: 2 }, 'horizon')).toBe(true)
    expect(inScopeCell({ suite: 'horizon', scorerVersion: 1 }, 'horizon')).toBe(false)
    expect(inScopeCell({ suite: 'classic', scorerVersion: 2 }, 'horizon')).toBe(false)
    expect(inScopeCell({ suite: 'smoke', scorerVersion: 2 }, 'horizon')).toBe(false)
    expect(inScopeCell({ suite: 'horizon', scorerVersion: 2 }, 'headline')).toBe(true)
  })

  it('a version 1 cell belongs to the earlier scope only; a version 2 cell to headline or smoke only', () => {
    const v1: Pick<BoardCell, 'suite' | 'scorerVersion'> = { suite: 'classic', scorerVersion: 1 }
    const v2: Pick<BoardCell, 'suite' | 'scorerVersion'> = { suite: 'classic', scorerVersion: CURRENT_SCORER_VERSION }
    expect(inScopeCell(v1, 'earlier')).toBe(true)
    expect(inScopeCell(v1, 'headline')).toBe(false)
    expect(inScopeCell(v1, 'smoke')).toBe(false)
    expect(inScopeCell(v2, 'earlier')).toBe(false)
    expect(inScopeCell(v2, 'headline')).toBe(true)
    expect(inScopeCell({ suite: 'smoke', scorerVersion: 2 }, 'headline')).toBe(false)
    expect(inScopeCell({ suite: 'smoke', scorerVersion: 2 }, 'smoke')).toBe(true)
  })

  it('a record with no scorerVersion is version 1 and never reaches headline or smoke', () => {
    for (const c of board.cells) {
      if (c.scorerVersion >= CURRENT_SCORER_VERSION) continue
      expect(inScopeCell(c, 'headline')).toBe(false)
      expect(inScopeCell(c, 'smoke')).toBe(false)
    }
  })

  it('the earlier-runs scope holds the version 1 Claude models, and the headline scope holds the version 2 tiers', () => {
    const earlier = board.summaries.filter((s) => s.scope === 'earlier').map((s) => s.modelId)
    const headline = board.summaries.filter((s) => s.scope === 'headline').map((s) => s.modelId)
    expect(earlier).toEqual(expect.arrayContaining(['claude-opus-4-8', 'claude-sonnet-4-6']))
    expect(headline).not.toContain('claude-opus-4-8')
    expect(headline).toEqual(expect.arrayContaining(['claude-opus-5-5-low', 'claude-sonnet-5-5-xhigh']))
  })

  it('each scope has its own findings, and the earlier scope says its records are not comparable', () => {
    expect(Object.keys(board.insights).sort()).toEqual([...SCOPE_KEYS].sort())
    for (const scope of SCOPE_KEYS) {
      expect(Object.keys(board.insights[scope]).sort()).toEqual(['all', 'claude'])
    }
  })
})

describe('cost is per attempt', () => {
  it('the board carries the exact definition the page quotes', () => {
    expect(board.definitions.costPerAttempt).toBe(COST_PER_ATTEMPT_DEFINITION)
    expect(COST_PER_ATTEMPT_DEFINITION).toContain('billed cost divided by the iterations requested')
    expect(COST_PER_ATTEMPT_DEFINITION).toContain('failed and truncated iterations counted in the division')
    expect(COST_PER_ATTEMPT_DEFINITION).toContain('A cell in which every iteration failed still has a cost per attempt')
    expect(COST_PER_ATTEMPT_DEFINITION).not.toContain('has no cost per attempt')
  })

  it('a model cost per attempt is the mean of its cells, each cell being its billed cost over its iterations requested', () => {
    const summary = board.summaries.find((s) => s.modelId === 'claude-opus-5-5-low' && s.scope === 'headline')!
    // The headline scope: current-scorer cells on headline suites only.
    const cells = board.cells.filter((c) => c.modelId === 'claude-opus-5-5-low' && c.suite !== 'smoke' && c.costPerIteration !== null)
    const perCell = cells.map((c) => (c.costUsd as number) / c.iterations)
    const mean = perCell.reduce((a, b) => a + b, 0) / perCell.length
    expect(summary.costPerAttempt).toBeCloseTo(mean, 12)
    for (const c of cells) expect(c.costPerIteration).toBeCloseTo((c.costUsd as number) / c.iterations, 12)
  })

  it('a cell in which every iteration failed keeps its billed cost per attempt, because the iterations were billed', () => {
    const failed = board.cells.find((c) => c.modelId === 'claude-fable-5' && c.succeeded === 0)!
    expect(failed).toBeDefined()
    expect(failed.costUsd).not.toBeNull()
    expect(failed.costPerIteration).toBeCloseTo((failed.costUsd as number) / failed.iterations, 12)
  })
})
