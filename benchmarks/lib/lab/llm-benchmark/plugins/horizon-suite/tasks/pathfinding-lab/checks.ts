/**
 * Checks for pathfinding-lab: one defineCheck per entry in the specification, in its order.
 * Points sum to 100. Every check asks the page through window.__bench and the drawn DOM, and
 * compares the answer with the independent reference in reference.ts. A check that cannot run
 * fails with its full budget (defineCheck guarantees that).
 *
 * Trust rule: nothing the page reports is believed on its own. A found result must be a real walk
 * on the grader's map (walkProblem): its path is re-walked and re-costed, its order is checked
 * against the path, and the displayed numbers are compared with the grader's own figures. Costs are
 * compared with sameCost, which is false for NaN, so a NaN cost never passes.
 */
import type { CheckContext, CheckFn } from '../../../../scorers/check-meta'
import type { Page } from 'playwright'
import { defineCheck } from '../../lib/check'
import { bounded, freezeMotion, hookPresent, probe, settle } from '../../lib/probe'
import { chan, deepEqual, parseCssColour, type RGBA } from '../../lib/math'
import {
  astarKeys,
  boundReason,
  dijkstraDistances,
  dims,
  duplicateReason,
  floodFill,
  fewestMoves,
  genMap,
  indexOf,
  isWall,
  moveDistances,
  optimalCost,
  sameRC,
  setReason,
  validatePath,
  withDiagonals,
  withGoal,
  withTerrain,
  type PathMap,
  type RC,
} from './reference'
import {
  GRID_CELL_COUNT,
  MAP_A_GOAL,
  MAP_A_ROWS,
  MAP_A_START,
  SEEDED,
  TOL,
  TRAP_GOAL,
  TRAP_ROWS,
  TRAP_START,
} from './hidden'
import {
  GRID_SRC,
  HIT_SRC,
  LOAD_GRID_SRC,
  LOAD_SOLVE_MANY_SRC,
  LOAD_SOLVE_SRC,
  LOAD_SOLVE_STATS_SRC,
  LOAD_SOLVE_STATUS_SRC,
  LOAD_SOLVE_SYNC_SRC,
  LOAD_SOLVE_TWICE_SRC,
} from './api'

const PROBE_MS = 3000
const ACTION_MS = 1500
const CONTRACT = ['__bench.loadGrid', '__bench.solve', '__bench.last']
const TERRAIN_NAME: Readonly<Record<string, string>> = { '#': 'wall', '.': 'open', '~': 'mud', '=': 'road' }

/** The result shape of __bench.solve. */
interface SolveResult {
  found: boolean
  path: RC[]
  cost: number | null
  order: RC[]
}

/** The result fields a determinism check compares. Anything else a page adds is ignored. */
function resultFields(r: SolveResult): SolveResult {
  return { found: r.found, path: r.path, cost: r.cost, order: r.order }
}

interface GridCell {
  r: string | null
  c: string | null
  terrain: string | null
  role: string | null
  visited: string | null
  path: string | null
  left: number
  top: number
  width: number
  height: number
  bg: string
  /** sRGB bytes of bg read back through a canvas, or null when the canvas could not read it. */
  px: number[] | null
  /** Drawn and hit-testable at its centre inside the window (checkVisibility and elementFromPoint). */
  visible: boolean
}

interface GridSnapshot {
  cells: GridCell[]
  last: (SolveResult & { algorithm?: string }) | null
  status: string | null
}

interface StatsProbe {
  result: SolveResult
  cost: string | null
  moves: string | null
  expanded: string | null
  max: string | null
  value: string | null
  state: string | null
  visible: Record<string, boolean>
}

interface SyncCell {
  r: string
  c: string
  visible: boolean
  visited: string
  path: string
  bg: string
}

interface SyncProbe {
  result: SolveResult
  values: number[]
  snaps: Array<{ value: string; max: string; cells: SyncCell[] }>
}

type Verdict = { passed: boolean; detail?: string }

const pass = (detail?: string): Verdict => (detail === undefined ? { passed: true } : { passed: true, detail })
const fail = (detail: string): Verdict => ({ passed: false, detail })

async function hasContract(page: Page): Promise<boolean> {
  for (const path of CONTRACT) {
    if (!(await hookPresent(page, path))) return false
  }
  return true
}

const NO_CONTRACT = fail('no window.__bench contract (loadGrid, solve, last)')

function specOf(map: PathMap): PathMap {
  return { rows: map.rows, start: map.start, goal: map.goal, diagonals: map.diagonals }
}

/** Both costs are finite and within tol. NaN agrees with nothing, not even NaN. */
function sameCost(reported: unknown, expected: number, tol: number): boolean {
  return typeof reported === 'number' && Number.isFinite(reported) && Number.isFinite(expected) && Math.abs(reported - expected) <= tol
}

/** Map a list of [r, c] pairs to cell indices, or describe what is malformed. */
function indicesOf(map: PathMap, cells: unknown, label: string): number[] | string {
  if (!Array.isArray(cells)) return `${label} is not an array`
  const { R, C } = dims(map)
  const out: number[] = []
  for (const cell of cells as unknown[]) {
    if (!Array.isArray(cell) || cell.length !== 2) return `${label} has an entry that is not [r, c]`
    const [r, c] = cell as unknown[]
    if (!Number.isInteger(r) || !Number.isInteger(c)) return `${label} has a non-integer cell`
    if ((r as number) < 0 || (c as number) < 0 || (r as number) >= R || (c as number) >= C) {
      return `${label} has a cell [${String(r)}, ${String(c)}] outside the grid`
    }
    out.push((r as number) * C + (c as number))
  }
  return out
}

function isWallIndex(map: PathMap, i: number): boolean {
  const { C } = dims(map)
  return isWall(map, Math.floor(i / C), i % C)
}

/**
 * A found result is a real walk on this map: found is true, the path is a legal walk from start to
 * goal with a cost equal to the re-walked cost, and the order starts at the start cell, repeats no
 * cell, expands no wall and contains every path cell. Optimality and the set bound are not tested
 * here (foundProblem and orderProblem do that). Returns the first problem, or null.
 */
function walkProblem(map: PathMap, res: SolveResult): string | null {
  if (res.found !== true) return `found is ${String(res.found)}, but the goal is reachable`
  if (!Array.isArray(res.path)) return 'path is not an array'
  const v = validatePath(map, res.path)
  if (!v.ok) return `path is invalid: ${v.reason}`
  if (!sameCost(res.cost, v.cost, TOL.cost)) return `cost ${String(res.cost)} differs from the path's terrain cost ${v.cost}`
  const order = indicesOf(map, res.order, 'order')
  if (typeof order === 'string') return order
  if (order.length === 0) return 'order is empty'
  if (order[0] !== indexOf(map, map.start)) return 'order does not start at the start cell'
  const dup = duplicateReason(order)
  if (dup !== null) return dup
  for (const i of order) {
    if (isWallIndex(map, i)) return `order expands a wall at cell ${i}`
  }
  const inOrder = new Set(order)
  for (const cell of res.path) {
    if (!inOrder.has(indexOf(map, cell))) return `path cell [${cell[0]}, ${cell[1]}] is missing from the order`
  }
  return null
}

/** A found result: a walk on the map (walkProblem), and the optimum with the reported cost equal to it. */
function foundProblem(map: PathMap, res: SolveResult, optimum: number): string | null {
  const walk = walkProblem(map, res)
  if (walk !== null) return walk
  if (!sameCost(res.cost, optimum, TOL.cost)) return `cost ${String(res.cost)} differs from the optimum ${optimum}`
  return null
}

/** The order must start at the start cell, end at the goal, and satisfy the set bound. */
function orderProblem(map: PathMap, res: SolveResult, key: readonly number[], bound: number): string | null {
  const order = indicesOf(map, res.order, 'order')
  if (typeof order === 'string') return order
  if (order.length === 0) return 'order is empty'
  if (order[0] !== indexOf(map, map.start)) return 'order does not start at the start cell'
  if (order[order.length - 1] !== indexOf(map, map.goal)) return 'order does not end at the goal'
  return boundReason(map, order, key, bound)
}

/** The colour of a drawn cell: the computed colour as the Node parser reads it, else the canvas bytes. */
function cellColour(cell: GridCell): RGBA {
  try {
    return parseCssColour(cell.bg)
  } catch (error) {
    if (cell.px === null) throw error
    return [cell.px[0]!, cell.px[1]!, cell.px[2]!, cell.px[3]! / 255]
  }
}

// ---------------------------------------------------------------------------
// path-grid-render (8)
// ---------------------------------------------------------------------------

/** Every grid problem as a string, or null. The snapshot is the page's drawn grid. */
function gridProblem(map: PathMap, snap: GridSnapshot): string | null {
  const { R, C } = dims(map)
  if (snap.cells.length !== GRID_CELL_COUNT || R * C !== GRID_CELL_COUNT) {
    return `found ${snap.cells.length} cells, expected ${GRID_CELL_COUNT}`
  }
  const byIndex = new Map<number, GridCell>()
  for (const cell of snap.cells) {
    if (cell.r === null || cell.c === null || !/^\d+$/.test(cell.r) || !/^\d+$/.test(cell.c)) {
      return `a cell lacks integer data-r or data-c (${String(cell.r)}, ${String(cell.c)})`
    }
    const r = Number(cell.r)
    const c = Number(cell.c)
    if (r >= R || c >= C) return `cell ${r},${c} is outside the ${R} x ${C} grid`
    const key = r * C + c
    if (byIndex.has(key)) return `cell ${r},${c} appears twice`
    byIndex.set(key, cell)
  }
  const startI = indexOf(map, map.start)
  const goalI = indexOf(map, map.goal)
  for (let i = 0; i < R * C; i++) {
    const cell = byIndex.get(i)
    const r = Math.floor(i / C)
    const c = i % C
    if (cell === undefined) return `cell ${r},${c} is missing`
    const want = TERRAIN_NAME[map.rows[r]!.charAt(c)]
    if (cell.terrain !== want) return `cell ${r},${c} has terrain ${String(cell.terrain)}, expected ${String(want)}`
    const role = i === startI ? 'start' : i === goalI ? 'goal' : null
    if (cell.role !== role) return `cell ${r},${c} has data-role ${String(cell.role)}, expected ${String(role)}`
    if (cell.visited !== 'false' || cell.path !== 'false') return `cell ${r},${c} is marked visited or on the path before any search`
  }

  // Drawn: every cell is shown, not covered and not clipped by a scrolling or hidden ancestor.
  for (const cell of snap.cells) {
    if (!cell.visible) return `cell ${String(cell.r)},${String(cell.c)} is hidden, covered or clipped`
  }

  // Sizes: square, equal, at least 8 px.
  const widths = snap.cells.map((cell) => cell.width)
  const heights = snap.cells.map((cell) => cell.height)
  for (const cell of snap.cells) {
    if (cell.width < TOL.minCellPx || cell.height < TOL.minCellPx) {
      return `cell ${String(cell.r)},${String(cell.c)} is ${cell.width.toFixed(1)} x ${cell.height.toFixed(1)} px, under ${TOL.minCellPx}`
    }
    if (Math.abs(cell.width - cell.height) > TOL.layoutPx) return `cell ${String(cell.r)},${String(cell.c)} is not square`
  }
  if (Math.max(...widths) - Math.min(...widths) > TOL.layoutPx || Math.max(...heights) - Math.min(...heights) > TOL.layoutPx) {
    return 'cell sizes differ by more than 1 px'
  }

  // Regular grid: a column shares one left edge and the lefts increase with c; likewise rows.
  const colLeft: number[] = []
  const rowTop: number[] = []
  for (let c = 0; c < C; c++) {
    const lefts = [] as number[]
    for (let r = 0; r < R; r++) lefts.push(byIndex.get(r * C + c)!.left)
    if (Math.max(...lefts) - Math.min(...lefts) > TOL.layoutPx) return `column ${c} is not aligned (lefts differ by more than 1 px)`
    colLeft.push(lefts.reduce((s, v) => s + v, 0) / R)
  }
  for (let r = 0; r < R; r++) {
    const tops = [] as number[]
    for (let c = 0; c < C; c++) tops.push(byIndex.get(r * C + c)!.top)
    if (Math.max(...tops) - Math.min(...tops) > TOL.layoutPx) return `row ${r} is not aligned (tops differ by more than 1 px)`
    rowTop.push(tops.reduce((s, v) => s + v, 0) / C)
  }
  for (let c = 1; c < C; c++) {
    if (!(colLeft[c]! - colLeft[c - 1]! > 0.5)) return `columns ${c - 1} and ${c} are not in increasing order`
  }
  for (let r = 1; r < R; r++) {
    if (!(rowTop[r]! - rowTop[r - 1]! > 0.5)) return `rows ${r - 1} and ${r} are not in increasing order`
  }

  // Inside the viewport: exact bounds, with floating-point slack only.
  const { width, height } = TOL.viewport
  for (const cell of snap.cells) {
    if (cell.left < -TOL.floatPx || cell.top < -TOL.floatPx) return `cell ${String(cell.r)},${String(cell.c)} starts outside the window`
    if (cell.left + cell.width > width + TOL.floatPx || cell.top + cell.height > height + TOL.floatPx) {
      return `cell ${String(cell.r)},${String(cell.c)} ends outside the ${width} x ${height} window`
    }
  }

  // Terrain colours: one colour per terrain (start and goal excluded), four distinct colours.
  const colourOf = new Map<string, RGBA>()
  for (const cell of snap.cells) {
    const i = Number(cell.r) * C + Number(cell.c)
    if (i === startI || i === goalI) continue
    const terrain = cell.terrain ?? ''
    let parsed: RGBA
    try {
      parsed = cellColour(cell)
    } catch (error) {
      return `cell ${String(cell.r)},${String(cell.c)} has a colour that cannot be read: ${error instanceof Error ? error.message : String(error)}`
    }
    const seen = colourOf.get(terrain)
    if (seen === undefined) colourOf.set(terrain, parsed)
    else if (chan(seen, parsed) !== 0) return `terrain ${terrain} uses more than one colour`
  }
  const terrains = [...colourOf.keys()]
  for (let a = 0; a < terrains.length; a++) {
    for (let b = a + 1; b < terrains.length; b++) {
      const d = chan(colourOf.get(terrains[a]!)!, colourOf.get(terrains[b]!)!)
      if (d < TOL.colourChannel) return `${terrains[a]} and ${terrains[b]} differ by only ${d}`
    }
  }
  if (terrains.length !== 4) return `only ${terrains.length} terrain colours are drawn`

  if (snap.last !== null) return 'last() is not null after loadGrid'
  return null
}

export const pathGridRender = defineCheck(
  'path-grid-render',
  8,
  'The 24 x 40 grid is drawn square, regular, inside the window, with correct terrain attributes, distinct colours and no leftover result.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    await freezeMotion(ctx.page)
    const map = genMap(SEEDED.grid800)
    const snap = await probe<GridSnapshot>(ctx.page, LOAD_GRID_SRC, specOf(map), PROBE_MS)
    const problem = gridProblem(map, snap)
    return problem === null ? pass('960 cells, regular, inside the window') : fail(problem)
  }
)

// ---------------------------------------------------------------------------
// path-dijkstra (12)
// ---------------------------------------------------------------------------

export const pathDijkstra = defineCheck(
  'path-dijkstra',
  12,
  'Dijkstra returns a valid minimum-cost path, expands exactly the cells the set bound requires, stops at the goal, and is deterministic.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    for (const spec of [SEEDED.dijkstra8, SEEDED.dijkstra42]) {
      const map = genMap(spec)
      const out = await probe<{ first: SolveResult; second: SolveResult; randomCalls: number }>(
        ctx.page,
        LOAD_SOLVE_TWICE_SRC,
        { spec: specOf(map), algorithm: 'dijkstra' },
        PROBE_MS
      )
      const optimum = optimalCost(map)
      if (optimum === null) return fail(`seed ${spec.seed}: the reference finds no path`)
      const problem =
        foundProblem(map, out.first, optimum) ??
        orderProblem(map, out.first, dijkstraDistances(map), optimum)
      if (problem !== null) return fail(`seed ${spec.seed}: ${problem}`)
      if (out.randomCalls !== 0) return fail(`seed ${spec.seed}: Math.random was called ${out.randomCalls} times`)
      if (!deepEqual(resultFields(out.first), resultFields(out.second))) {
        return fail(`seed ${spec.seed}: two solves gave different paths, costs or orders`)
      }
    }
    return pass('two maps: optimal, bounded expansion, deterministic')
  }
)

// ---------------------------------------------------------------------------
// path-astar-optimal (12)
// ---------------------------------------------------------------------------

export const pathAstarOptimal = defineCheck(
  'path-astar-optimal',
  12,
  'A* returns a minimum-cost path on the road-detour trap and on a seeded map where an unscaled heuristic is suboptimal.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const trap: PathMap = {
      rows: [...TRAP_ROWS],
      start: [TRAP_START[0], TRAP_START[1]],
      goal: [TRAP_GOAL[0], TRAP_GOAL[1]],
      diagonals: false,
    }
    const optima: string[] = []
    for (const [label, map] of [
      ['trap', trap],
      ['seed 103', genMap(SEEDED.astarOptimal103)],
    ] as const) {
      const optimum = optimalCost(map)
      if (optimum === null) return fail(`${label}: the reference finds no path`)
      const res = await probe<SolveResult>(ctx.page, LOAD_SOLVE_SRC, { spec: specOf(map), algorithm: 'astar' }, PROBE_MS)
      const problem = foundProblem(map, res, optimum)
      if (problem !== null) return fail(`${label}: ${problem}`)
      optima.push(`${label} C* ${optimum}`)
    }
    return pass(`optimal on both: ${optima.join(' and ')}`)
  }
)

// ---------------------------------------------------------------------------
// path-astar-expansion (10)
// ---------------------------------------------------------------------------

export const pathAstarExpansion = defineCheck(
  'path-astar-expansion',
  10,
  'A* expands every cell with f < C* and no cell with f > C*, where f uses the prescribed heuristic.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const map = genMap(SEEDED.astarExpansion203)
    const res = await probe<SolveResult>(ctx.page, LOAD_SOLVE_SRC, { spec: specOf(map), algorithm: 'astar' }, PROBE_MS)
    const walk = walkProblem(map, res)
    if (walk !== null) return fail(walk)
    const optimum = optimalCost(map)
    if (optimum === null) return fail('the reference finds no path')
    const problem = orderProblem(map, res, astarKeys(map), optimum)
    return problem === null ? pass(`bounds hold: C* ${optimum}`) : fail(problem)
  }
)

// ---------------------------------------------------------------------------
// path-bfs (8)
// ---------------------------------------------------------------------------

export const pathBfs = defineCheck(
  'path-bfs',
  8,
  'BFS returns a fewest-moves path, reports its true terrain cost, and expands the cells the move-count bound requires.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const map = genMap(SEEDED.bfs300)
    const res = await probe<SolveResult>(ctx.page, LOAD_SOLVE_SRC, { spec: specOf(map), algorithm: 'bfs' }, PROBE_MS)
    const dStar = fewestMoves(map)
    if (dStar === null) return fail('the reference finds no path')
    const walk = walkProblem(map, res)
    if (walk !== null) return fail(walk)
    const v = validatePath(map, res.path)
    if (!v.ok) return fail(`path is invalid: ${v.reason}`)
    if (res.path.length - 1 !== dStar) return fail(`path has ${res.path.length - 1} moves, the fewest is ${dStar}`)
    if (!sameCost(res.cost, v.cost, TOL.cost)) {
      return fail(`cost ${String(res.cost)} differs from the path's terrain cost ${v.cost}`)
    }
    const problem = orderProblem(map, res, moveDistances(map), dStar)
    return problem === null ? pass(`${dStar} moves, cost ${v.cost}`) : fail(problem)
  }
)

// ---------------------------------------------------------------------------
// path-no-path-trivial (10)
// ---------------------------------------------------------------------------

export const pathNoPathTrivial = defineCheck(
  'path-no-path-trivial',
  10,
  'An unreachable goal gives found false, cost null and the flood fill, with a no-path status; start equal to goal gives the one-cell path.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT

    // Map A: the goal sits inside a ring of walls.
    const mapA: PathMap = {
      rows: [...MAP_A_ROWS],
      start: [MAP_A_START[0], MAP_A_START[1]],
      goal: [MAP_A_GOAL[0], MAP_A_GOAL[1]],
      diagonals: false,
    }
    const a = await probe<{ result: SolveResult; state: string | null; text: string | null }>(
      ctx.page,
      LOAD_SOLVE_STATUS_SRC,
      { spec: specOf(mapA), algorithm: 'bfs' },
      PROBE_MS
    )
    if (a.result.found !== false) return fail(`map A: found is ${String(a.result.found)}, expected false`)
    if (!Array.isArray(a.result.path) || a.result.path.length !== 0) return fail('map A: path is not []')
    if (a.result.cost !== null) return fail(`map A: cost is ${String(a.result.cost)}, expected null`)
    const order = indicesOf(mapA, a.result.order, 'order')
    if (typeof order === 'string') return fail(`map A: ${order}`)
    const setProblem = setReason(order, floodFill(mapA))
    if (setProblem !== null) return fail(`map A: ${setProblem}`)
    if (a.state !== 'no-path') return fail(`map A: status is ${String(a.state)}, expected no-path`)
    if (a.text === null || !a.text.toLowerCase().includes('no path')) return fail('map A: status text does not say "no path"')

    // Map B: the seeded map with the goal set to the start.
    const base = genMap(SEEDED.stats501)
    const mapB = withGoal(base, base.start)
    const b = await probe<{ result: SolveResult; state: string | null; text: string | null }>(
      ctx.page,
      LOAD_SOLVE_STATUS_SRC,
      { spec: specOf(mapB), algorithm: 'astar' },
      PROBE_MS
    )
    const startCell: RC = [base.start[0], base.start[1]]
    if (b.result.found !== true) return fail('map B: found is not true')
    if (!deepEqual(b.result.path, [startCell])) return fail('map B: path is not [start]')
    if (b.result.cost !== 0) return fail(`map B: cost is ${String(b.result.cost)}, expected 0`)
    if (!deepEqual(b.result.order, [startCell])) return fail('map B: order is not [start]')
    if (b.state !== 'found') return fail(`map B: status is ${String(b.state)}, expected found`)
    return pass('unreachable goal and start-equals-goal both handled')
  }
)

// ---------------------------------------------------------------------------
// path-diagonal-rules (12)
// ---------------------------------------------------------------------------

export const pathDiagonalRules = defineCheck(
  'path-diagonal-rules',
  12,
  'With diagonals, Dijkstra and A* (octile) take sqrt(2) diagonal steps, never cut a corner, and return the optimum.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const map = withDiagonals(genMap(SEEDED.diagonal400), true)
    const optimum = optimalCost(map)
    if (optimum === null) return fail('the reference finds no path')
    const algorithms = ['dijkstra', 'astar']
    const results = await probe<SolveResult[]>(ctx.page, LOAD_SOLVE_MANY_SRC, { spec: specOf(map), algorithms }, PROBE_MS)
    for (let i = 0; i < algorithms.length; i++) {
      const problem = foundProblem(map, results[i]!, optimum)
      if (problem !== null) return fail(`${algorithms[i]}: ${problem}`)
    }
    return pass(`optimum ${optimum.toFixed(4)} for both`)
  }
)

// ---------------------------------------------------------------------------
// path-visual-sync (12)
// ---------------------------------------------------------------------------

export const pathVisualSync = defineCheck(
  'path-visual-sync',
  12,
  'The drawn grid mirrors the returned order and path at hidden scrubber positions, by data attribute and by computed colour.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    await freezeMotion(ctx.page)
    const map = genMap(SEEDED.sync600)
    const { R, C } = dims(map)
    const out = await probe<SyncProbe>(ctx.page, LOAD_SOLVE_SYNC_SRC, { spec: specOf(map), algorithm: 'astar' }, PROBE_MS * 2)

    const walk = walkProblem(map, out.result)
    if (walk !== null) return fail(walk)
    const order = indicesOf(map, out.result.order, 'order')
    if (typeof order === 'string') return fail(order)
    const path = indicesOf(map, out.result.path, 'path')
    if (typeof path === 'string') return fail(path)
    const N = order.length
    const values = [0, Math.floor(N / 3), N - 1, N]
    if (!deepEqual(out.values, values)) return fail('the page scrubbed to other positions than the order length implies')
    if (out.snaps.length !== values.length) return fail('the page returned the wrong number of snapshots')

    const base = new Map<number, string>()
    for (const cell of out.snaps[0]!.cells) base.set(Number(cell.r) * C + Number(cell.c), cell.bg)

    for (let j = 0; j < out.snaps.length; j++) {
      const snap = out.snaps[j]!
      const k = values[j]!
      if (snap.value !== String(k)) return fail(`scrubber reads ${snap.value} after setting ${k}`)
      if (snap.max !== String(N)) return fail(`scrubber max is ${snap.max}, expected ${N}`)
      if (snap.cells.length !== R * C) return fail(`k=${k}: ${snap.cells.length} cells are drawn, expected ${R * C}`)
      const seenCells = new Set<number>()
      for (const cell of snap.cells) {
        const i = Number(cell.r) * C + Number(cell.c)
        if (!Number.isInteger(i) || i < 0 || i >= R * C || seenCells.has(i)) return fail(`k=${k}: cell ${cell.r},${cell.c} is missing, repeated or out of the grid`)
        seenCells.add(i)
      }
      const expectedVisited = new Set(order.slice(0, k))
      const pathSeen: number[] = []
      const bgOnPath = new Set<string>()
      const bgOff = new Set<string>()
      for (const cell of snap.cells) {
        const i = Number(cell.r) * C + Number(cell.c)
        const visited = cell.visited === 'true'
        const onPath = cell.path === 'true'
        if (!cell.visible) return fail(`k=${k}: cell ${cell.r},${cell.c} is hidden, covered or clipped`)
        if (visited !== expectedVisited.has(i)) return fail(`k=${k}: cell ${cell.r},${cell.c} visited=${cell.visited}, expected ${expectedVisited.has(i)}`)
        if (onPath && k < N) return fail(`k=${k}: cell ${cell.r},${cell.c} is on the path before the end`)
        if (onPath) {
          pathSeen.push(i)
          bgOnPath.add(cell.bg)
        } else {
          bgOff.add(cell.bg)
        }
        if (!visited && cell.bg !== base.get(i)) return fail(`k=${k}: unvisited cell ${cell.r},${cell.c} changed colour`)
        if (visited && k > 0 && cell.bg === base.get(i)) return fail(`k=${k}: visited cell ${cell.r},${cell.c} kept its unvisited colour`)
      }
      if (k === N) {
        const want = new Set(path)
        const got = new Set(pathSeen)
        if (got.size !== want.size || [...want].some((i) => !got.has(i))) return fail('at the end the path cells differ from the returned path')
        if (bgOnPath.size !== 1) return fail('path cells do not share one colour')
        const pathColour = [...bgOnPath][0]!
        if (bgOff.has(pathColour)) return fail('another cell uses the path colour')
      }
    }
    return pass(`k in {0, ${values.slice(1).join(', ')}}: drawn state mirrors the order`)
  }
)

// ---------------------------------------------------------------------------
// path-edit-resolve (8)
// ---------------------------------------------------------------------------

export const pathEditResolve = defineCheck(
  'path-edit-resolve',
  8,
  'A real click on a path cell turns it into a wall, re-solves with the displayed algorithm and redraws the new result.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const map = genMap(SEEDED.edit702)
    const first = await probe<SolveResult>(ctx.page, LOAD_SOLVE_SRC, { spec: specOf(map), algorithm: 'dijkstra' }, PROBE_MS)
    if (first.found !== true || !Array.isArray(first.path) || first.path.length < 9) return fail('the first path is missing or too short')
    const firstWalk = walkProblem(map, first)
    if (firstWalk !== null) return fail(`the first path is invalid: ${firstWalk}`)
    const middle = first.path[Math.floor(first.path.length / 2)]!
    if (sameRC(middle, map.start) || sameRC(middle, map.goal)) return fail('the middle path cell is the start or the goal')

    await settle(ctx.page)
    const selector = '#grid [data-r="' + String(middle[0]) + '"][data-c="' + String(middle[1]) + '"]'
    const hit = await probe<{ ok: boolean; x?: number; y?: number; detail: string }>(ctx.page, HIT_SRC, selector, PROBE_MS)
    if (!hit.ok || hit.x === undefined || hit.y === undefined) return fail(`the middle cell cannot be clicked: ${hit.detail}`)
    try {
      await bounded(ctx.page.mouse.click(hit.x, hit.y), ACTION_MS, 'click')
    } catch (error) {
      return fail(`the click failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await settle(ctx.page)

    const snap = await probe<GridSnapshot>(ctx.page, GRID_SRC, undefined, PROBE_MS)
    const { C } = dims(map)
    const cell = snap.cells.find((x) => x.r === String(middle[0]) && x.c === String(middle[1]))
    if (cell === undefined) return fail('the clicked cell disappeared')
    if (cell.terrain !== 'wall') return fail(`the clicked cell has terrain ${String(cell.terrain)}, expected wall`)
    const last = snap.last
    if (last === null) return fail('last() is null after the click')
    if (last.algorithm !== 'dijkstra') return fail(`last() algorithm is ${String(last.algorithm)}, expected dijkstra`)

    const edited = withTerrain(map, [middle[0], middle[1]], '#')
    const newOptimum = optimalCost(edited)
    if (newOptimum === null) {
      if (last.found !== false) return fail('a path was reported but the edited map has none')
      if (snap.status !== 'no-path') return fail(`status is ${String(snap.status)}, expected no-path`)
      return pass('the edit closed the only route, and the page says so')
    }
    if (last.found !== true) return fail('found is not true after the edit, but a path exists')
    const problem = foundProblem(edited, last, newOptimum)
    if (problem !== null) return fail(`after the edit: ${problem}`)
    const drawn = snap.cells.filter((x) => x.path === 'true').map((x) => Number(x.r) * C + Number(x.c))
    const want = indicesOf(edited, last.path, 'path')
    if (typeof want === 'string') return fail(want)
    const drawnSet = new Set(drawn)
    if (drawnSet.size !== new Set(want).size || want.some((i) => !drawnSet.has(i))) {
      return fail('the drawn path differs from the returned path after the edit')
    }
    return pass(`re-solved to ${newOptimum}`)
  }
)

// ---------------------------------------------------------------------------
// path-stats-dom (8)
// ---------------------------------------------------------------------------

export const pathStatsDom = defineCheck(
  'path-stats-dom',
  8,
  'The stats and the scrubber show the displayed result: cost, moves, expanded count, and the scrubber range.',
  async (ctx: CheckContext): Promise<Verdict> => {
    if (!(await hasContract(ctx.page))) return NO_CONTRACT
    const map = genMap(SEEDED.stats501)
    const out = await probe<StatsProbe>(ctx.page, LOAD_SOLVE_STATS_SRC, { spec: specOf(map), algorithm: 'dijkstra' }, PROBE_MS)
    const { result } = out
    const walk = walkProblem(map, result)
    if (walk !== null) return fail(walk)
    const walked = validatePath(map, result.path)
    if (!walked.ok) return fail(`path is invalid: ${walked.reason}`)
    if (out.state !== 'found') return fail(`status is ${String(out.state)}, expected found`)
    for (const id of ['stat-cost', 'stat-moves', 'stat-expanded', 'status', 'scrub']) {
      if (out.visible[id] !== true) return fail(`#${id} is hidden, covered or clipped`)
    }
    const costText = (out.cost ?? '').trim()
    if (!/^\d+(\.\d+)?$/.test(costText)) return fail(`stat-cost reads "${costText}"`)
    if (!sameCost(Number(costText), walked.cost, TOL.displayCost)) {
      return fail(`stat-cost ${costText} differs from the path's cost ${walked.cost}`)
    }
    const movesText = (out.moves ?? '').trim()
    if (movesText !== String(result.path.length - 1)) return fail(`stat-moves reads "${movesText}", expected ${result.path.length - 1}`)
    const expandedText = (out.expanded ?? '').trim()
    if (expandedText !== String(result.order.length)) return fail(`stat-expanded reads "${expandedText}", expected ${result.order.length}`)
    if (out.max !== String(result.order.length)) return fail(`scrubber max is ${String(out.max)}, expected ${result.order.length}`)
    if (out.value !== String(result.order.length)) return fail(`scrubber value is ${String(out.value)}, expected ${result.order.length}`)
    return pass(`cost ${costText}, ${movesText} moves, ${expandedText} expanded`)
  }
)

/** Every check, keyed by name, in the order the specification gives. */
export const checks: Record<string, CheckFn> = {
  'path-grid-render': pathGridRender,
  'path-dijkstra': pathDijkstra,
  'path-astar-optimal': pathAstarOptimal,
  'path-astar-expansion': pathAstarExpansion,
  'path-bfs': pathBfs,
  'path-no-path-trivial': pathNoPathTrivial,
  'path-diagonal-rules': pathDiagonalRules,
  'path-visual-sync': pathVisualSync,
  'path-edit-resolve': pathEditResolve,
  'path-stats-dom': pathStatsDom,
}

/** The checks as an array, in order, for runChecks. */
export const checkList: CheckFn[] = Object.values(checks)
