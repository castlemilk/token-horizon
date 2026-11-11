import { describe, expect, it } from 'vitest'
import {
  astarKeys,
  bfsOrder,
  boundReason,
  dijkstraDistances,
  dims,
  fewestMoves,
  floodFill,
  genMap,
  heuristicValue,
  indexOf,
  manhattanTo,
  minOpenCost,
  moveDistances,
  optimalCost,
  referenceSearch,
  setReason,
  validatePath,
  withDiagonals,
  withGoal,
  withTerrain,
  type PathMap,
  type RC,
} from './reference'
import { MAP_A_GOAL, MAP_A_ROWS, MAP_A_START, SEEDED, TRAP_GOAL, TRAP_ROWS, TRAP_START } from './hidden'

const TIES = ['fifo', 'lifo', 'hig', 'lowg'] as const

function counts(map: PathMap): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of map.rows) for (const ch of row) out[ch] = (out[ch] ?? 0) + 1
  return out
}

function trap(): PathMap {
  return { rows: [...TRAP_ROWS], start: [...TRAP_START] as RC, goal: [...TRAP_GOAL] as RC, diagonals: false }
}

function mapA(): PathMap {
  return { rows: [...MAP_A_ROWS], start: [...MAP_A_START] as RC, goal: [...MAP_A_GOAL] as RC, diagonals: false }
}

/** The map 501 with its goal set to the start: the start-equals-goal case. */
function mapB(): PathMap {
  const base = genMap(SEEDED.stats501)
  return withGoal(base, base.start)
}

describe('genMap and the seeded maps', () => {
  it('is deterministic, and forces start and goal open', () => {
    const a = genMap(SEEDED.grid800)
    const b = genMap(SEEDED.grid800)
    expect(a.rows).toEqual(b.rows)
    expect(a.start).toEqual([1, 1])
    expect(a.goal).toEqual([22, 38])
    expect(a.rows[1]![1]).toBe('.')
    expect(a.rows[22]![38]).toBe('.')
  })

  it('gives the 24 x 40 map 204 walls, 117 mud, 87 road and 552 open cells', () => {
    const c = counts(genMap(SEEDED.grid800))
    expect(c['#']).toBe(204)
    expect(c['~']).toBe(117)
    expect(c['=']).toBe(87)
    expect(c['.']).toBe(552)
    expect(dims(genMap(SEEDED.grid800))).toEqual({ R: 24, C: 40 })
  })

  it('gives the optima the spec states', () => {
    expect(optimalCost(genMap(SEEDED.dijkstra8))).toBe(39.5)
    expect(optimalCost(genMap(SEEDED.dijkstra42))).toBe(41.5)
    expect(optimalCost(genMap(SEEDED.astarOptimal103))).toBe(34)
    expect(optimalCost(genMap(SEEDED.astarExpansion203))).toBe(46)
    expect(optimalCost(genMap(SEEDED.stats501))).toBe(15.5)
    expect(optimalCost(genMap(SEEDED.bfs300))).toBe(50)
  })

  it('keeps the BFS, A* and diagonal properties the checks depend on', () => {
    const bfs = genMap(SEEDED.bfs300)
    expect(fewestMoves(bfs)).toBe(36)
    expect(optimalCost(bfs)).toBe(50)

    const lo = genMap(SEEDED.astarExpansion203)
    expect(minOpenCost(lo)).toBe(1)
    const keys = astarKeys(lo)
    const cStar = optimalCost(lo)!
    let below = 0
    let atOrBelow = 0
    let reachable = 0
    let highF = 0
    const g = dijkstraDistances(lo)
    for (let i = 0; i < keys.length; i++) {
      if (!Number.isFinite(g[i]!)) continue
      reachable++
      if (keys[i]! < cStar) below++
      if (keys[i]! <= cStar) atOrBelow++
      if (g[i]! <= cStar && keys[i]! > cStar) highF++
    }
    expect(below).toBe(120)
    expect(atOrBelow).toBe(175)
    expect(highF).toBe(232)
    expect(reachable).toBe(412)

    const diag = withDiagonals(genMap(SEEDED.diagonal400), true)
    expect(optimalCost(diag)).toBeCloseTo(36.485281374238575, 12)
    expect(optimalCost(withDiagonals(genMap(SEEDED.diagonal400), false))).toBe(40)
    const cut = referenceSearch(diag, { cut: true })
    expect(cut.cost).toBeCloseTo(27.798989873223338, 9)
  })

  it('gives the sync and stats maps the sizes the checks need', () => {
    const sync = genMap(SEEDED.sync600)
    expect(minOpenCost(sync)).toBe(0.5)
    const keys = astarKeys(sync)
    expect(keys.length).toBe(12 * 18)
    const run = referenceSearch(sync, { heuristic: (i) => heuristicValue(sync, Math.floor(i / 18), i % 18) })
    expect(run.order.length).toBeGreaterThanOrEqual(60)
    expect(run.path.length).toBeGreaterThanOrEqual(20)

    const stats = genMap(SEEDED.stats501)
    expect(referenceSearch(stats).path.length).toBeGreaterThanOrEqual(12)

    const edit = genMap(SEEDED.edit702)
    expect(referenceSearch(edit).path.length).toBeGreaterThanOrEqual(9)
  })
})

describe('hand-built maps', () => {
  it('the trap: the road detour costs 8.5, and Manhattan x 1 would return 10', () => {
    expect(optimalCost(trap())).toBe(8.5)
    const m = trap()
    const unscaled = referenceSearch(m, {
      heuristic: (i) => {
        const { C } = dims(m)
        return Math.abs(Math.floor(i / C) - m.goal[0]) + Math.abs((i % C) - m.goal[1])
      },
    })
    expect(unscaled.cost).toBe(10)
  })

  it('map A: the goal is unreachable and the flood fill from the start is 106 cells', () => {
    const m = mapA()
    expect(optimalCost(m)).toBeNull()
    expect(fewestMoves(m)).toBeNull()
    expect(floodFill(m).length).toBe(106)
    expect(referenceSearch(m).path).toEqual([])
    expect(referenceSearch(m).cost).toBeNull()
    expect(MAP_A_ROWS.every((r) => r.length === 13)).toBe(true)
  })

  it('map B: start equals goal, so the optimum is 0 and the path is the start', () => {
    const m = mapB()
    expect(m.start).toEqual(m.goal)
    expect(optimalCost(m)).toBe(0)
    expect(referenceSearch(m).path).toEqual([indexOf(m, m.start)])
  })

  it('the BFS map: the cheapest fewest-moves path costs 52, and the optimum needs 38 moves', () => {
    const m = genMap(SEEDED.bfs300)
    const { R, C } = dims(m)
    const du = moveDistances(m)
    const Ds = du[indexOf(m, m.goal)]!
    expect(Ds).toBe(36)
    // Minimum cost among fewest-move paths, by layered DP over BFS distances.
    const cost = new Array<number>(R * C).fill(Infinity)
    cost[indexOf(m, m.start)] = 0
    const byMoves = [...Array(R * C).keys()].filter((i) => Number.isFinite(du[i]!)).sort((a, b) => du[a]! - du[b]!)
    for (const u of byMoves) {
      if (!Number.isFinite(cost[u]!)) continue
      const r = Math.floor(u / C)
      const c = u % C
      for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
        if (Math.abs(dr) + Math.abs(dc) !== 1) continue
        const nr = r + dr
        const nc = c + dc
        if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue
        const v = nr * C + nc
        const ch = m.rows[nr]![nc]!
        if (ch === '#' || du[v] !== du[u]! + 1) continue
        const w = ch === '.' ? 1 : ch === '~' ? 5 : 0.5
        cost[v] = Math.min(cost[v]!, cost[u]! + w)
      }
    }
    expect(cost[indexOf(m, m.goal)]).toBe(52)
    // The true optimum and the fewest moves among the optimal paths.
    expect(optimalCost(m)).toBe(50)
    const g = dijkstraDistances(m)
    const moves = new Array<number>(R * C).fill(Infinity)
    moves[indexOf(m, m.start)] = 0
    const byCost = [...Array(R * C).keys()].filter((i) => Number.isFinite(g[i]!)).sort((a, b) => g[a]! - g[b]!)
    for (const u of byCost) {
      if (!Number.isFinite(moves[u]!)) continue
      const r = Math.floor(u / C)
      const c = u % C
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = r + dr
        const nc = c + dc
        if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue
        const v = nr * C + nc
        const ch = m.rows[nr]![nc]!
        if (ch === '#') continue
        const w = ch === '.' ? 1 : ch === '~' ? 5 : 0.5
        if (Math.abs(g[v]! - (g[u]! + w)) < 1e-9) moves[v] = Math.min(moves[v]!, moves[u]! + 1)
      }
    }
    expect(moves[indexOf(m, m.goal)]).toBe(38)
  })
})

describe('validatePath', () => {
  it('re-walks and re-costs an optimal path', () => {
    const m = trap()
    const r = referenceSearch(m)
    const path = r.path.map((i) => [Math.floor(i / 15), i % 15] as RC)
    const v = validatePath(m, path)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.cost).toBeCloseTo(8.5, 12)
  })

  it('rejects walls, teleports, bad endpoints and corner cutting', () => {
    const m: PathMap = { rows: ['.#.', '...', '...'], start: [0, 0], goal: [0, 2], diagonals: true }
    expect(validatePath(m, [[0, 0], [0, 1], [0, 2]]).ok).toBe(false)
    expect(validatePath(m, [[0, 0], [0, 2]]).ok).toBe(false)
    expect(validatePath(m, [[0, 0], [1, 0], [2, 2], [1, 2], [0, 2]]).ok).toBe(false)
    // Corner cutting from (0,0) to (1,1) is blocked only when both orthogonals are walls.
    const blocked: PathMap = { rows: ['.#', '#.'], start: [0, 0], goal: [1, 1], diagonals: true }
    expect(validatePath(blocked, [[0, 0], [1, 1]]).ok).toBe(false)
    const open: PathMap = { rows: ['..', '..'], start: [0, 0], goal: [1, 1], diagonals: true }
    const v = validatePath(open, [[0, 0], [1, 1]])
    expect(v.ok && v.cost).toBeCloseTo(Math.SQRT2, 12)
    expect(validatePath(withDiagonals(open, false), [[0, 0], [1, 1]]).ok).toBe(false)
  })

  it('accepts the start cell alone when start equals goal', () => {
    const m = mapB()
    const v = validatePath(m, [m.start])
    expect(v).toEqual({ ok: true, cost: 0 })
  })
})

describe('set bounds (tie-break independent)', () => {
  const cases: Array<{ name: string; map: PathMap; algo: 'dijkstra' | 'astar' }> = [
    { name: 'dijkstra 8', map: genMap(SEEDED.dijkstra8), algo: 'dijkstra' },
    { name: 'dijkstra 42', map: genMap(SEEDED.dijkstra42), algo: 'dijkstra' },
    { name: 'astar 103', map: genMap(SEEDED.astarOptimal103), algo: 'astar' },
    { name: 'astar 203', map: genMap(SEEDED.astarExpansion203), algo: 'astar' },
  ]

  for (const { name, map, algo } of cases) {
    it(`holds for every tie rule on ${name}`, () => {
      const cStar = optimalCost(map)!
      const { C } = dims(map)
      const key =
        algo === 'dijkstra' ? dijkstraDistances(map) : astarKeys(map)
      for (const tie of TIES) {
        const run = referenceSearch(map, {
          tie,
          heuristic: algo === 'astar' ? (i) => heuristicValue(map, Math.floor(i / C), i % C) : undefined,
        })
        expect(run.cost, `${name} ${tie} cost`).toBeCloseTo(cStar, 9)
        expect(run.order[0], `${name} ${tie} first`).toBe(indexOf(map, map.start))
        expect(run.order[run.order.length - 1], `${name} ${tie} last`).toBe(indexOf(map, map.goal))
        expect(boundReason(map, run.order, key, cStar), `${name} ${tie}`).toBeNull()
      }
    })
  }

  it('the BFS order satisfies the move-count bound on the BFS map', () => {
    const m = genMap(SEEDED.bfs300)
    const moves = moveDistances(m)
    const order = bfsOrder(m)
    expect(order[0]).toBe(indexOf(m, m.start))
    expect(order[order.length - 1]).toBe(indexOf(m, m.goal))
    expect(boundReason(m, order, moves, fewestMoves(m)!)).toBeNull()
  })

  it('a zero heuristic or a half-weight heuristic breaks the A* upper bound on map 203', () => {
    const m = genMap(SEEDED.astarExpansion203)
    const { C } = dims(m)
    const cStar = optimalCost(m)!
    const keys = astarKeys(m)
    const zero = referenceSearch(m, { heuristic: () => 0 })
    expect(boundReason(m, zero.order, keys, cStar)).not.toBeNull()
    const man = manhattanTo(m)
    const half = referenceSearch(m, { heuristic: (i) => 0.5 * man[i]! })
    expect(boundReason(m, half.order, keys, cStar)).not.toBeNull()
    expect(C).toBe(30)
  })

  it('the unscaled heuristic on the trap expands the wrong cells', () => {
    const m = trap()
    const { C } = dims(m)
    const man = manhattanTo(m)
    const run = referenceSearch(m, { heuristic: (i) => man[i]! })
    expect(run.cost).toBe(10)
    const cStar = optimalCost(m)!
    const keys = astarKeys(m)
    expect(boundReason(m, run.order, keys, cStar)).not.toBeNull()
    expect(C).toBe(15)
  })
})

describe('boundReason and setReason', () => {
  it('reports duplicates, walls, missing and extra cells', () => {
    const m: PathMap = { rows: ['..', '#.'], start: [0, 0], goal: [1, 1], diagonals: false }
    const key = [0, 1, 2, Infinity]
    expect(boundReason(m, [0, 0], key, 2)).toMatch(/twice/)
    expect(boundReason(m, [0, 3], key, 2)).toMatch(/wall|expanded/)
    expect(boundReason(m, [0], key, 2)).toMatch(/never expanded/)
    expect(boundReason(m, [0, 1, 3], key, 1)).toMatch(/beyond bound/)
    expect(boundReason(m, [0, 1, 2], key, 2)).toMatch(/wall/)
    expect(boundReason(m, [0, 1], key, 2)).toBeNull()
    expect(boundReason(m, [0, 1, 3], key, 2)).toMatch(/beyond bound/)
    expect(setReason([0, 1, 2], [2, 1, 0])).toBeNull()
    expect(setReason([0, 1], [0, 1, 2])).toMatch(/expected 3/)
  })

  it('moveDistances respects the diagonal flag and BFS reachability matches the flood fill', () => {
    const m = trap()
    const orth = moveDistances(m, false)
    const diag = moveDistances(m, true)
    expect(diag[indexOf(m, m.goal)]).toBeLessThanOrEqual(orth[indexOf(m, m.goal)]!)
    expect(floodFill(mapA()).length).toBe(106)
  })
})

describe('terrain helpers', () => {
  it('withTerrain changes exactly one cell', () => {
    const m = trap()
    const next = withTerrain(m, [1, 1], '#')
    let diffs = 0
    for (let r = 0; r < m.rows.length; r++) {
      for (let c = 0; c < m.rows[r]!.length; c++) if (m.rows[r]![c] !== next.rows[r]![c]) diffs++
    }
    expect(diffs).toBe(1)
    expect(next.rows[1]![1]).toBe('#')
  })
})
