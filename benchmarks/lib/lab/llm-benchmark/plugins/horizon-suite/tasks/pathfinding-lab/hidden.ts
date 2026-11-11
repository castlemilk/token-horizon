/**
 * Hidden inputs for pathfinding-lab. Every constant a check or a fixture uses lives
 * here, and only here (plus the reference computations derived from them). The prompt
 * never contains these values; checks.test.ts enforces that.
 *
 * Maps are generated from seeds with genMap (reference.ts), so a grader needs no
 * stored map data beyond these few numbers. Rotating the seeds rotates the test.
 */

// v2: the kit's freezeMotion finishes entrance animations (it no longer sets animation:none); no hidden value changed.
export const HIDDEN_VERSION = 'pathfinding-lab/v2'

/** A seeded random map: genMap(spec) in reference.ts. */
export interface SeededMapSpec {
  seed: number
  rows: number
  cols: number
  pWall: number
  pMud: number
  pRoad: number
}

/** The seeded maps the checks use. Each has a property asserted in reference.test.ts. */
export const SEEDED = {
  /** path-grid-render: the 24 x 40 map. 204 walls, 117 mud, 87 road, 552 open. */
  grid800: { seed: 800, rows: 24, cols: 40, pWall: 0.22, pMud: 0.12, pRoad: 0.1 },
  /** path-dijkstra: optimum 39.5. */
  dijkstra8: { seed: 8, rows: 18, cols: 30, pWall: 0.2, pMud: 0.15, pRoad: 0.15 },
  /** path-dijkstra: optimum 41.5. */
  dijkstra42: { seed: 42, rows: 18, cols: 30, pWall: 0.2, pMud: 0.15, pRoad: 0.15 },
  /** path-astar-optimal: optimum 34; the unscaled heuristic returns 35.5 to 38. */
  astarOptimal103: { seed: 103, rows: 18, cols: 30, pWall: 0.18, pMud: 0.1, pRoad: 0.2 },
  /** path-astar-expansion: no roads, C* = 46. */
  astarExpansion203: { seed: 203, rows: 18, cols: 30, pWall: 0.22, pMud: 0.15, pRoad: 0 },
  /** path-bfs: D* = 36, cheapest fewest-moves path 52, optimum 50 needing 38 moves. */
  bfs300: { seed: 300, rows: 16, cols: 26, pWall: 0.15, pMud: 0.25, pRoad: 0 },
  /** path-diagonal-rules: octile optimum 36.485281374238575. */
  diagonal400: { seed: 400, rows: 16, cols: 24, pWall: 0.28, pMud: 0.12, pRoad: 0 },
  /** path-no-path-trivial (start equals goal) and path-stats-dom: optimum 15.5. */
  stats501: { seed: 501, rows: 10, cols: 14, pWall: 0.15, pMud: 0.1, pRoad: 0.25 },
  /** path-visual-sync: 12 x 18, roads present (cmin 0.5). */
  sync600: { seed: 600, rows: 12, cols: 18, pWall: 0.2, pMud: 0.12, pRoad: 0.12 },
  /** path-edit-resolve: a middle path cell is clicked. */
  edit702: { seed: 702, rows: 10, cols: 14, pWall: 0.18, pMud: 0.12, pRoad: 0.12 },
} as const satisfies Record<string, SeededMapSpec>

/** path-astar-optimal: the hand-built trap. The road detour costs 8.5; Manhattan x 1 returns 10. */
export const TRAP_ROWS: readonly string[] = [
  '...............',
  '...............',
  '...............',
  '.===========...',
  '...............',
]
export const TRAP_START: readonly [number, number] = [1, 1]
export const TRAP_GOAL: readonly [number, number] = [1, 11]

/**
 * path-no-path-trivial, map A: 9 x 13. The goal [3, 10] sits inside a ring of 8 walls and
 * two further walls sit in the open floor, so the flood fill from the start is 106 cells.
 */
export const MAP_A_ROWS: readonly string[] = [
  '.............',
  '.............',
  '.........###.',
  '.........#.#.',
  '.........###.',
  '.............',
  '....##.......',
  '.............',
  '.............',
]
export const MAP_A_START: readonly [number, number] = [1, 1]
export const MAP_A_GOAL: readonly [number, number] = [3, 10]

/** Tolerances. Each is derived in the spec notes; none is loosened to rescue a check. */
export const TOL = {
  /** Costs: sums of at most about 60 terms of magnitude <= 5 * sqrt(2); error below 1e-13. */
  cost: 1e-9,
  /** The displayed cost: four decimals round by at most 5e-5. */
  displayCost: 1e-4,
  /** Layout: sub-pixel cell sizes and positions. */
  layoutPx: 1,
  /** Viewport containment: exact bounds with floating-point slack only (getBoundingClientRect is not rounded). */
  floatPx: 0.01,
  /** Colour distinctness: well above an indistinct palette, below any deliberate pair. */
  colourChannel: 24,
  /** Minimum cell side, from the prompt. */
  minCellPx: 8,
  /** The grid must sit inside this viewport. */
  viewport: { width: 1024, height: 720 },
} as const

/** The seeded maps' full cell count for path-grid-render (24 x 40). */
export const GRID_CELL_COUNT = 24 * 40

/** Every name a check or fixture may use for a hidden answer, for the prompt-leak test. */
export const HIDDEN_ANSWER_TOKENS: readonly string[] = [
  '8.5',
  '39.5',
  '41.5',
  '35.5',
  '36.4852',
  '27.8',
  '15.5',
  '1.4142',
]
