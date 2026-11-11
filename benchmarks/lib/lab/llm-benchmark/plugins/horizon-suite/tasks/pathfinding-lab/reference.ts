/**
 * Independent reference solver for pathfinding-lab. Pure Node: no DOM, no clock, no
 * host state. Ported from the chief designer's path.cjs (neighbour corner rule,
 * all-distances Dijkstra, BFS distances, flood fill, validatePath, and the set-bound
 * assertions). The checks use these functions as the grader's own answers.
 */
import { mulberry32 } from '../../lib/math'
import type { SeededMapSpec } from './hidden'

export const SQRT2 = Math.SQRT2

/** Terrain cost of the cell being ENTERED. Walls are absent from this table. */
export const TERRAIN_COST: Readonly<Record<string, number>> = { '.': 1, '~': 5, '=': 0.5 }

const TERRAIN_NAME: Readonly<Record<string, string>> = { '#': 'wall', '.': 'open', '~': 'mud', '=': 'road' }

/** A map as the prompt's loadGrid receives it, with 0-based [row, col] cells. */
export interface PathMap {
  rows: string[]
  start: [number, number]
  goal: [number, number]
  diagonals: boolean
}

export type RC = [number, number]

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]
const DIAG: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
]

export function dims(map: PathMap): { R: number; C: number } {
  return { R: map.rows.length, C: map.rows[0]!.length }
}

export function terrainName(ch: string): string {
  const name = TERRAIN_NAME[ch]
  if (name === undefined) throw new Error(`unknown terrain character ${ch}`)
  return name
}

export function isWall(map: PathMap, r: number, c: number): boolean {
  return map.rows[r]![c] === '#'
}

export function indexOf(map: PathMap, rc: RC): number {
  return rc[0] * dims(map).C + rc[1]
}

export function rcOf(map: PathMap, i: number): RC {
  const { C } = dims(map)
  const r = Math.floor(i / C)
  return [r, i - r * C]
}

export function sameRC(a: readonly number[], b: readonly number[]): boolean {
  return a.length === 2 && b.length === 2 && a[0] === b[0] && a[1] === b[1]
}

/**
 * Legal moves out of (r, c). Orthogonal neighbours cost the entered cell's terrain.
 * Diagonal neighbours (when allowed) cost sqrt(2) times that and need BOTH orthogonal
 * cells they pass between to be non-wall, unless cut is true (the corner-cutting
 * variant, used only to show the gap the rule makes).
 */
export function neighbours(
  map: PathMap,
  r: number,
  c: number,
  diagonals: boolean = map.diagonals,
  cut = false
): Array<{ r: number; c: number; w: number }> {
  const { R, C } = dims(map)
  const out: Array<{ r: number; c: number; w: number }> = []
  for (const [dr, dc] of ORTHO) {
    const nr = r + dr
    const nc = c + dc
    if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue
    const ch = map.rows[nr]![nc]!
    if (ch === '#') continue
    out.push({ r: nr, c: nc, w: TERRAIN_COST[ch]! })
  }
  if (!diagonals) return out
  for (const [dr, dc] of DIAG) {
    const nr = r + dr
    const nc = c + dc
    if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue
    const ch = map.rows[nr]![nc]!
    if (ch === '#') continue
    if (!cut && (map.rows[r]![nc] === '#' || map.rows[nr]![c] === '#')) continue
    out.push({ r: nr, c: nc, w: TERRAIN_COST[ch]! * SQRT2 })
  }
  return out
}

/** Smallest terrain cost among the non-wall cells (the prompt's cmin). */
export function minOpenCost(map: PathMap): number {
  let best = Infinity
  for (const row of map.rows) {
    for (const ch of row) {
      if (ch !== '#' && TERRAIN_COST[ch]! < best) best = TERRAIN_COST[ch]!
    }
  }
  return best === Infinity ? 1 : best
}

/** Octile distance with unit step costs. */
export function octile(dr: number, dc: number): number {
  return Math.max(dr, dc) + (SQRT2 - 1) * Math.min(dr, dc)
}

/** The prompt's admissible heuristic for a cell: cmin times Manhattan (or octile) to the goal. */
export function heuristicValue(map: PathMap, r: number, c: number): number {
  const dr = Math.abs(r - map.goal[0])
  const dc = Math.abs(c - map.goal[1])
  const d = map.diagonals ? octile(dr, dc) : dr + dc
  return minOpenCost(map) * d
}

/** genMap: the chief's generator. Row-major draws from mulberry32(seed); start and goal forced open. */
export function genMap(spec: SeededMapSpec): PathMap {
  const rnd = mulberry32(spec.seed)
  const rows: string[] = []
  for (let r = 0; r < spec.rows; r++) {
    let s = ''
    for (let c = 0; c < spec.cols; c++) {
      const u = rnd()
      s +=
        u < spec.pWall
          ? '#'
          : u < spec.pWall + spec.pMud
            ? '~'
            : u < spec.pWall + spec.pMud + spec.pRoad
              ? '='
              : '.'
    }
    rows.push(s)
  }
  const start: RC = [1, 1]
  const goal: RC = [spec.rows - 2, spec.cols - 2]
  return openCells({ rows, start, goal, diagonals: false }, [start, goal])
}

/** A copy of map with the listed cells set to open terrain. */
function openCells(map: PathMap, cells: RC[]): PathMap {
  const rows = map.rows.slice()
  for (const [r, c] of cells) {
    rows[r] = rows[r]!.slice(0, c) + '.' + rows[r]!.slice(c + 1)
  }
  return { ...map, rows }
}

export function withGoal(map: PathMap, goal: RC): PathMap {
  return { ...map, goal: [goal[0], goal[1]] }
}

export function withDiagonals(map: PathMap, diagonals: boolean): PathMap {
  return { ...map, diagonals }
}

/** Replace one cell's terrain character. Returns a new map. */
export function withTerrain(map: PathMap, rc: RC, ch: string): PathMap {
  const rows = map.rows.slice()
  rows[rc[0]] = rows[rc[0]]!.slice(0, rc[1]) + ch + rows[rc[0]]!.slice(rc[1] + 1)
  return { ...map, rows }
}

/**
 * Exact all-distances Dijkstra from the start (g*), O(V^2) which is ample for 24 x 40.
 * Unreachable and wall cells are Infinity. Costs are summed in the order of the path.
 */
export function dijkstraDistances(map: PathMap): number[] {
  const { R, C } = dims(map)
  const N = R * C
  const dist = new Array<number>(N).fill(Infinity)
  const done = new Array<boolean>(N).fill(false)
  const s = indexOf(map, map.start)
  dist[s] = 0
  for (;;) {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < N; i++) {
      if (!done[i] && dist[i]! < bestDist) {
        bestDist = dist[i]!
        best = i
      }
    }
    if (best < 0) break
    done[best] = true
    for (const nb of neighbours(map, Math.floor(best / C), best % C)) {
      const j = nb.r * C + nb.c
      const nd = bestDist + nb.w
      if (nd < dist[j]!) dist[j] = nd
    }
  }
  return dist
}

/** Fewest-moves distances from the start (BFS): the move count, costs ignored. */
export function moveDistances(map: PathMap, diagonals: boolean = map.diagonals): number[] {
  const { R, C } = dims(map)
  const dist = new Array<number>(R * C).fill(Infinity)
  const s = indexOf(map, map.start)
  dist[s] = 0
  const queue: number[] = [s]
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!
    const r = Math.floor(u / C)
    const c = u % C
    for (const nb of neighbours(map, r, c, diagonals)) {
      const j = nb.r * C + nb.c
      if (dist[j] === Infinity) {
        dist[j] = dist[u]! + 1
        queue.push(j)
      }
    }
  }
  return dist
}

/**
 * FIFO breadth-first expansion order, stopping when the goal is dequeued. Used only by the
 * unit tests to confirm the BFS set bound on the seeded maps.
 */
export function bfsOrder(map: PathMap): number[] {
  const { C } = dims(map)
  const s = indexOf(map, map.start)
  const goal = indexOf(map, map.goal)
  const seen = new Set<number>([s])
  const queue: number[] = [s]
  const order: number[] = []
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!
    order.push(u)
    if (u === goal) break
    for (const nb of neighbours(map, Math.floor(u / C), u % C, false)) {
      const j = nb.r * C + nb.c
      if (!seen.has(j)) {
        seen.add(j)
        queue.push(j)
      }
    }
  }
  return order
}

/** Indices reachable from the start (the flood fill), ascending. */
export function floodFill(map: PathMap): number[] {
  const d = moveDistances(map)
  const out: number[] = []
  for (let i = 0; i < d.length; i++) if (Number.isFinite(d[i]!)) out.push(i)
  return out
}

/** The optimum cost C* (g* at the goal), or null when the goal is unreachable. */
export function optimalCost(map: PathMap): number | null {
  const v = dijkstraDistances(map)[indexOf(map, map.goal)]!
  return Number.isFinite(v) ? v : null
}

/** Fewest moves D* from the start to the goal, or null. */
export function fewestMoves(map: PathMap, diagonals: boolean = map.diagonals): number | null {
  const v = moveDistances(map, diagonals)[indexOf(map, map.goal)]!
  return Number.isFinite(v) ? v : null
}

/**
 * f(n) = g*(n) + h(n) for every cell (Infinity for walls and unreachable cells). With a
 * consistent heuristic, {f < C*} must be expanded and no cell with f > C* may be.
 */
export function astarKeys(map: PathMap): number[] {
  const { R, C } = dims(map)
  const g = dijkstraDistances(map)
  const out = new Array<number>(R * C).fill(Infinity)
  for (let i = 0; i < R * C; i++) {
    if (!Number.isFinite(g[i]!)) continue
    out[i] = g[i]! + heuristicValue(map, Math.floor(i / C), i % C)
  }
  return out
}

/** Manhattan distance from each cell to the goal (no scaling), for the h-equals-Manhattan map. */
export function manhattanTo(map: PathMap): number[] {
  const { R, C } = dims(map)
  const out = new Array<number>(R * C)
  for (let i = 0; i < R * C; i++) {
    const r = Math.floor(i / C)
    const c = i % C
    out[i] = Math.abs(r - map.goal[0]) + Math.abs(c - map.goal[1])
  }
  return out
}

export type PathCheck = { ok: true; cost: number } | { ok: false; reason: string }

/**
 * Re-walk and re-cost a path. It must start at start, end at goal, every cell must be a
 * legal, in-bounds, non-wall cell, and every move must be a legal neighbour move (a
 * diagonal only when diagonals are on and neither orthogonal cell is a wall). The cost is
 * the sum over moves of the entered cell's terrain cost, times sqrt(2) on diagonals.
 */
export function validatePath(map: PathMap, path: readonly RC[]): PathCheck {
  const { R, C } = dims(map)
  if (path.length === 0) return { ok: false, reason: 'empty path' }
  for (const cell of path) {
    if (!Array.isArray(cell) || cell.length !== 2) return { ok: false, reason: 'path entry is not [r, c]' }
    const [r, c] = cell
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= R || c >= C) {
      return { ok: false, reason: `cell [${String(r)}, ${String(c)}] is outside the grid` }
    }
  }
  if (!sameRC(path[0]!, map.start)) return { ok: false, reason: 'path does not start at the start cell' }
  if (!sameRC(path[path.length - 1]!, map.goal)) return { ok: false, reason: 'path does not end at the goal' }
  let cost = 0
  for (let k = 0; k < path.length; k++) {
    const [r, c] = path[k]!
    const ch = map.rows[r]![c]!
    if (ch === '#') return { ok: false, reason: `path enters a wall at [${r}, ${c}]` }
    if (k === 0) continue
    const [pr, pc] = path[k - 1]!
    const dr = Math.abs(r - pr)
    const dc = Math.abs(c - pc)
    if (dr + dc === 1) {
      cost += TERRAIN_COST[ch]!
    } else if (dr === 1 && dc === 1) {
      if (!map.diagonals) return { ok: false, reason: 'diagonal move with diagonals off' }
      if (map.rows[pr]![c] === '#' || map.rows[r]![pc] === '#') {
        return { ok: false, reason: `diagonal move [${pr}, ${pc}] to [${r}, ${c}] cuts a corner` }
      }
      cost += TERRAIN_COST[ch]! * SQRT2
    } else {
      return { ok: false, reason: `step ${k - 1} to ${k} is not a neighbour move` }
    }
  }
  return { ok: true, cost }
}

/** A repeated cell in an order is a failure. Returns the reason or null. */
export function duplicateReason(order: readonly number[]): string | null {
  const seen = new Set<number>()
  for (const i of order) {
    if (seen.has(i)) return `cell ${i} appears twice in the order`
    seen.add(i)
  }
  return null
}

/**
 * The set bound. For every non-wall cell with key k: k < bound (within eps) must be in the
 * order, and any cell in the order must have k <= bound (within eps). Cells with
 * k == bound are free. Returns the first violation or null.
 */
export function boundReason(
  map: PathMap,
  order: readonly number[],
  key: readonly number[],
  bound: number,
  eps = 1e-9
): string | null {
  const { R, C } = dims(map)
  const dup = duplicateReason(order)
  if (dup !== null) return dup
  const inOrder = new Set(order)
  for (const i of order) {
    if (map.rows[Math.floor(i / C)]![i % C] === '#') return `wall ${i} was expanded`
  }
  for (let i = 0; i < R * C; i++) {
    const r = Math.floor(i / C)
    const c = i % C
    if (map.rows[r]![c] === '#') continue
    const k = key[i]!
    if (k < bound - eps && !inOrder.has(i)) return `cell [${r}, ${c}] with key ${k} was never expanded (bound ${bound})`
    if (inOrder.has(i) && !(k <= bound + eps)) return `cell [${r}, ${c}] with key ${k} was expanded beyond bound ${bound}`
  }
  return null
}

/** The order (indices) must equal the set given, each exactly once. Returns the reason or null. */
export function setReason(order: readonly number[], expected: readonly number[]): string | null {
  const dup = duplicateReason(order)
  if (dup !== null) return dup
  const have = new Set(order)
  const want = new Set(expected)
  if (have.size !== want.size) return `order has ${have.size} cells, expected ${want.size}`
  for (const i of want) if (!have.has(i)) return `cell ${i} missing from the order`
  return null
}

export interface RefSearchOptions {
  /** Heuristic per index; default h = 0 (Dijkstra). */
  heuristic?: (i: number) => number
  /** Tie rule between equal keys. */
  tie?: 'fifo' | 'lifo' | 'hig' | 'lowg'
  /** Allow corner cutting on diagonals. */
  cut?: boolean
  /** Diagonals; defaults to the map's setting. */
  diagonals?: boolean
  /** Stop when the goal is expanded (default true). */
  stopAtGoal?: boolean
}

/**
 * Best-first search with an explicit tie rule, ported from path.cjs. Used by the unit
 * tests to show the set bounds hold for every tie rule (not by the checks, which only
 * need the bounds).
 */
export function referenceSearch(
  map: PathMap,
  options: RefSearchOptions = {}
): { cost: number | null; order: number[]; path: number[] } {
  const { C } = dims(map)
  const diag = options.diagonals ?? map.diagonals
  const hf = options.heuristic ?? ((): number => 0)
  const tie = options.tie ?? 'fifo'
  const cut = options.cut ?? false
  const stopAtGoal = options.stopAtGoal ?? true
  const startI = indexOf(map, map.start)
  const goalI = indexOf(map, map.goal)
  const g = new Map<number, number>()
  const parent = new Map<number, number>()
  const closed = new Set<number>()
  const open: Array<{ f: number; g: number; seq: number; i: number }> = []
  let seq = 0
  g.set(startI, 0)
  open.push({ f: hf(startI), g: 0, seq: seq++, i: startI })
  const order: number[] = []
  const before = (a: (typeof open)[number], b: (typeof open)[number]): boolean => {
    if (a.f !== b.f) return a.f < b.f
    if (tie === 'fifo') return a.seq < b.seq
    if (tie === 'lifo') return a.seq > b.seq
    if (tie === 'hig') return a.g > b.g || (a.g === b.g && a.seq < b.seq)
    return a.g < b.g || (a.g === b.g && a.seq > b.seq)
  }
  while (open.length > 0) {
    let bi = 0
    for (let k = 1; k < open.length; k++) if (before(open[k]!, open[bi]!)) bi = k
    const [entry] = open.splice(bi, 1)
    const cur = entry!.i
    const gg = entry!.g
    if (closed.has(cur) || gg > g.get(cur)!) continue
    closed.add(cur)
    order.push(cur)
    if (stopAtGoal && cur === goalI) {
      const path: number[] = []
      let p: number | undefined = cur
      while (p !== undefined) {
        path.push(p)
        p = parent.get(p)
      }
      return { cost: gg, order, path: path.reverse() }
    }
    const r = Math.floor(cur / C)
    const c = cur % C
    for (const nb of neighbours(map, r, c, diag, cut)) {
      const j = nb.r * C + nb.c
      const ng = gg + nb.w
      if (!g.has(j) || ng < g.get(j)!) {
        g.set(j, ng)
        parent.set(j, cur)
        open.push({ f: ng + hf(j), g: ng, seq: seq++, i: j })
      }
    }
  }
  return { cost: null, order, path: [] }
}
