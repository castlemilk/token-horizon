/**
 * Pure reference model for the kanban task. Node only: no DOM, no clock, no host
 * time zone. Ported from the chief designer's kanban.cjs (board, snapshot undo
 * and redo stacks, edge and limit no-ops that never enter history).
 *
 * The model is the independent expectation the in-page checks compare with. It
 * is deliberately written as whole-board snapshots, while the artifact is free to
 * use commands; the two must agree on every observable state.
 */
import { mulberry32 } from '../../lib/math'
import { KEY_STEP_COUNT } from './hidden'

export const COLS = ['todo', 'doing', 'done'] as const
export type Col = (typeof COLS)[number]
export type Board = Record<Col, string[]>

export const NAMES: Record<Col, string> = { todo: 'To do', doing: 'Doing', done: 'Done' }
export const LIMIT = 3
export const MAX_TITLE = 80

/** The first-load board from the prompt. */
export const FIRST_LOAD: Board = {
  todo: ['Draft release notes', 'Fix login redirect', 'Update pricing copy'],
  doing: ['Migrate billing cron'],
  done: ['Rotate API keys'],
}

/** Trim, then collapse every run of whitespace into one space. */
export function normalise(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** A normalised title is valid when it has 1 to 80 characters. */
export function isValidTitle(title: string): boolean {
  return title.length >= 1 && title.length <= MAX_TITLE
}

export function cloneBoard(board: Board): Board {
  return { todo: [...board.todo], doing: [...board.doing], done: [...board.done] }
}

export function boardsEqual(a: Board, b: Board): boolean {
  return COLS.every((c) => a[c].length === b[c].length && a[c].every((t, i) => t === b[c][i]))
}

export function countsOf(board: Board): Record<Col, number> {
  return { todo: board.todo.length, doing: board.doing.length, done: board.done.length }
}

export interface Loc {
  col: Col
  index: number
}

export type Outcome = { ok: true } | { ok: false; reason: 'edge' | 'limit' | 'invalid' | 'missing' }

export class KanbanModel {
  board: Board
  undoStack: Board[] = []
  redoStack: Board[] = []

  constructor(initial: Board = FIRST_LOAD) {
    this.board = cloneBoard(initial)
  }

  find(title: string): Loc | null {
    for (const col of COLS) {
      const index = this.board[col].indexOf(title)
      if (index >= 0) return { col, index }
    }
    return null
  }

  /** Record the current board, then replace it. Clears redo, as the prompt requires. */
  private commit(next: Board): void {
    this.undoStack.push(cloneBoard(this.board))
    this.board = next
    this.redoStack = []
  }

  add(raw: string): Outcome {
    const title = normalise(raw)
    if (!isValidTitle(title)) return { ok: false, reason: 'invalid' }
    const next = cloneBoard(this.board)
    next.todo.push(title)
    this.commit(next)
    return { ok: true }
  }

  /** Shift+ArrowUp (dir -1) or Shift+ArrowDown (dir +1): swap with a neighbour in the same column. */
  swap(title: string, dir: -1 | 1): Outcome {
    const loc = this.find(title)
    if (!loc) return { ok: false, reason: 'missing' }
    const j = loc.index + dir
    if (j < 0 || j >= this.board[loc.col].length) return { ok: false, reason: 'edge' }
    const next = cloneBoard(this.board)
    const list = next[loc.col]
    ;[list[loc.index], list[j]] = [list[j]!, list[loc.index]!]
    this.commit(next)
    return { ok: true }
  }

  /** Move to the END of the neighbouring column. Entering Doing needs room (limit 3). */
  move(title: string, dir: -1 | 1, enforceLimit = true): Outcome {
    const loc = this.find(title)
    if (!loc) return { ok: false, reason: 'missing' }
    const ti = COLS.indexOf(loc.col) + dir
    if (ti < 0 || ti >= COLS.length) return { ok: false, reason: 'edge' }
    const to = COLS[ti]!
    if (enforceLimit && to === 'doing' && this.board.doing.length >= LIMIT) return { ok: false, reason: 'limit' }
    const next = cloneBoard(this.board)
    next[loc.col].splice(loc.index, 1)
    next[to].push(title)
    this.commit(next)
    return { ok: true }
  }

  remove(title: string): Outcome {
    const loc = this.find(title)
    if (!loc) return { ok: false, reason: 'missing' }
    const next = cloneBoard(this.board)
    next[loc.col].splice(loc.index, 1)
    this.commit(next)
    return { ok: true }
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (previous === undefined) return false
    this.redoStack.push(cloneBoard(this.board))
    this.board = previous
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (next === undefined) return false
    this.undoStack.push(cloneBoard(this.board))
    this.board = next
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Where focus must land after the card at (col, index) has been removed: next, else previous, else null. */
  focusAfterDelete(col: Col, index: number): string | null {
    const list = this.board[col]
    return list[index] ?? list[index - 1] ?? null
  }
}

/** Keys the keyboard checks use, mapped to the model action they request. */
export type KeyAction =
  | { kind: 'swap'; dir: -1 | 1 }
  | { kind: 'move'; dir: -1 | 1 }
  | { kind: 'remove' }
  | { kind: 'none' }

export function keyAction(key: string): KeyAction {
  switch (key) {
    case 'Shift+ArrowUp':
      return { kind: 'swap', dir: -1 }
    case 'Shift+ArrowDown':
      return { kind: 'swap', dir: 1 }
    case 'Shift+ArrowLeft':
      return { kind: 'move', dir: -1 }
    case 'Shift+ArrowRight':
      return { kind: 'move', dir: 1 }
    case 'Delete':
      return { kind: 'remove' }
    default:
      return { kind: 'none' }
  }
}

/** Apply a card key to the model. Plain arrows and anything else change nothing. */
export function applyCardKey(model: KanbanModel, title: string, key: string): Outcome {
  const action = keyAction(key)
  if (action.kind === 'swap') return model.swap(title, action.dir)
  if (action.kind === 'move') return model.move(title, action.dir)
  if (action.kind === 'remove') return model.remove(title)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Robust-session step generator (seeded, the same list for every artifact)
// ---------------------------------------------------------------------------

export const ROBUST_KEYS = [
  'Shift+ArrowUp',
  'Shift+ArrowDown',
  'Shift+ArrowLeft',
  'Shift+ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Delete',
  'Control+z',
  'Control+y',
  'Enter',
  'Space',
] as const

export type RobustStep =
  | { kind: 'key'; target: 'body' | 'button' | 'card'; pick: number; key: (typeof ROBUST_KEYS)[number] }
  | { kind: 'add'; title: number; via: 'enter' | 'click' }
  | { kind: 'emptySubmit' }

/**
 * Sixty steps from one seed. `pick` is a fraction in [0, 1) that the check turns into
 * an index over whatever cards the artifact currently shows, so the list itself is
 * identical for every artifact while the targets follow each artifact's own DOM.
 * `title` indexes the hostile and edge-case title bank in hidden.ts.
 */
export function generateRobustSteps(seed: number, count: number, titleBankSize: number): RobustStep[] {
  const rnd = mulberry32(seed)
  const steps: RobustStep[] = []
  for (let i = 0; i < count; i++) {
    const roll = rnd()
    if (roll < 0.1) {
      steps.push({ kind: 'emptySubmit' })
    } else if (roll < 0.22) {
      steps.push({
        kind: 'add',
        title: Math.floor(rnd() * titleBankSize),
        via: rnd() < 0.5 ? 'enter' : 'click',
      })
    } else {
      const targetRoll = rnd()
      const target: 'body' | 'button' | 'card' = targetRoll < 0.2 ? 'body' : targetRoll < 0.5 ? 'button' : 'card'
      const key = ROBUST_KEYS[Math.floor(rnd() * ROBUST_KEYS.length)]!
      steps.push({ kind: 'key', target, pick: rnd(), key })
    }
  }
  return steps
}

// ---------------------------------------------------------------------------
// Keyboard-moves script: 18 operations generated from a seed against the model.
// None may move a card into a full Doing. Coverage is required, not hoped for:
// the generator tries successive seeds until the script covers every case the
// specification names, then the caller gets that seed back for the record.
// ---------------------------------------------------------------------------

export type KeyOpName = 'Shift+ArrowUp' | 'Shift+ArrowDown' | 'Shift+ArrowLeft' | 'Shift+ArrowRight' | 'Delete'

export interface GeneratedKeyOp {
  key: KeyOpName
  title: string
  /** The model's column and index of the card just before the key is pressed. */
  col: Col
  index: number
  /** Length of the card's column before the key is pressed. */
  len: number
  /** Length of the destination column before a move key is pressed, or -1 for a swap, delete or no-op edge. */
  destLen: number
  /** True for the four edge no-ops and the full-Doing refusal, which must change nothing. */
  noop: boolean
}

export interface KeyScript {
  seed: number
  ops: GeneratedKeyOp[]
}

const KEY_NAMES: KeyOpName[] = [
  'Shift+ArrowUp',
  'Shift+ArrowDown',
  'Shift+ArrowLeft',
  'Shift+ArrowRight',
  'Delete',
]

/** Titles on the board, in model order (todo, doing, done). */
function allTitles(model: KanbanModel): string[] {
  return COLS.flatMap((c) => model.board[c])
}

/**
 * Coverage the specification names: top and bottom edge swaps, left from To do,
 * right from Done, moves both ways (including a successful move into a non-empty Done and
 * out of Done into Doing, so the end-of-column rule is exercised in both directions), two
 * Deletes, and no full-Doing move attempted.
 */
export function coversKeyCases(ops: GeneratedKeyOp[]): boolean {
  const has = (p: (o: GeneratedKeyOp) => boolean): boolean => ops.some(p)
  return (
    has((o) => o.key === 'Shift+ArrowUp' && o.index === 0 && o.noop) &&
    has((o) => o.key === 'Shift+ArrowDown' && o.noop && o.index === o.len - 1) &&
    has((o) => o.key === 'Shift+ArrowDown' && !o.noop && o.index === o.len - 2) &&
    has((o) => o.key === 'Shift+ArrowLeft' && o.col === 'todo' && o.noop) &&
    has((o) => o.key === 'Shift+ArrowRight' && o.col === 'done' && o.noop) &&
    has((o) => o.key === 'Shift+ArrowRight' && o.col === 'todo' && !o.noop) &&
    has((o) => o.key === 'Shift+ArrowLeft' && o.col === 'doing' && !o.noop) &&
    has((o) => o.key === 'Shift+ArrowRight' && o.col === 'doing' && !o.noop && o.destLen > 0) &&
    has((o) => o.key === 'Shift+ArrowLeft' && o.col === 'done' && !o.noop && o.destLen > 0) &&
    ops.filter((o) => o.key === 'Delete' && !o.noop).length >= 2 &&
    has((o) => o.key === 'Shift+ArrowDown' && !o.noop) &&
    has((o) => o.key === 'Shift+ArrowUp' && !o.noop)
  )
}

/** One attempt at a seed. Returns null when the sequence cannot be applied cleanly. */
function attemptKeyScript(seed: number, start: KanbanModel): KeyScript | null {
  const rnd = mulberry32(seed)
  const model = new KanbanModel(start.board)
  const ops: GeneratedKeyOp[] = []
  for (let i = 0; i < KEY_STEP_COUNT; i++) {
    const titles = allTitles(model)
    if (titles.length === 0) return null
    const title = titles[Math.floor(rnd() * titles.length)]!
    const deletes = ops.filter((o) => o.key === 'Delete').length
    // A Delete is spent sparingly (two per script) so the board never empties under it.
    const pool = deletes >= 2 ? KEY_NAMES.filter((k) => k !== 'Delete') : KEY_NAMES
    const key = pool[Math.floor(rnd() * pool.length)]!
    const loc = model.find(title)!
    if (!loc) return null
    const lenBefore = model.board[loc.col].length
    let destLen = -1
    if (key === 'Shift+ArrowLeft' || key === 'Shift+ArrowRight') {
      const ti = COLS.indexOf(loc.col) + (key === 'Shift+ArrowLeft' ? -1 : 1)
      if (ti >= 0 && ti < COLS.length) destLen = model.board[COLS[ti]!]!.length
    }
    let outcome
    if (key === 'Delete') outcome = model.remove(title)
    else if (key === 'Shift+ArrowUp' || key === 'Shift+ArrowDown') {
      outcome = model.swap(title, key === 'Shift+ArrowUp' ? -1 : 1)
    } else {
      outcome = model.move(title, key === 'Shift+ArrowLeft' ? -1 : 1)
    }
    if (outcome.ok === false && outcome.reason === 'limit') return null
    ops.push({ key, title, col: loc.col, index: loc.index, len: lenBefore, destLen, noop: outcome.ok === false })
  }
  return coversKeyCases(ops) ? { seed, ops } : null
}

/**
 * The fixed keyboard script. Starts at `base` and steps the seed until a sequence covers
 * every required case. Throws when no seed in the window works, so a broken model
 * cannot silently produce an empty script.
 */
export function generateKeyScript(start: KanbanModel, base: number, window = 4000): KeyScript {
  for (let s = base; s < base + window; s++) {
    const script = attemptKeyScript(s, start)
    if (script !== null) return script
  }
  throw new Error(`generateKeyScript: no covering seed in ${base}..${base + window - 1}`)
}

/**
 * Robust-session coverage: each of Control+z and Control+y pressed with focus on a button
 * and on a card (the body is covered by the fixed past-both-ends loops), and at least one
 * title added through Enter. Every artifact gets the same steps, so coverage is a property
 * of the seed, not of the artifact.
 */
export function coversRobustCases(steps: RobustStep[]): boolean {
  const has = (p: (s: RobustStep) => boolean): boolean => steps.some(p)
  const keys = ['Control+z', 'Control+y'] as const
  const targets = ['button', 'card'] as const
  for (const key of keys) {
    for (const target of targets) {
      if (!has((s) => s.kind === 'key' && s.key === key && s.target === target)) return false
    }
  }
  return has((s) => s.kind === 'add' && s.via === 'enter')
}

/**
 * The robust steps for the first seed at or after base whose sixty-step list covers the
 * robust cases. Returns the seed used, so the run log can record it. Throws when no seed in
 * the window covers, so a broken generator cannot silently produce an uncovered list.
 */
export function generateCoveringRobustSteps(
  base: number,
  count: number,
  titleBankSize: number,
  window = 4000
): { seed: number; steps: RobustStep[] } {
  for (let s = base; s < base + window; s++) {
    const steps = generateRobustSteps(s, count, titleBankSize)
    if (coversRobustCases(steps)) return { seed: s, steps }
  }
  throw new Error(`generateCoveringRobustSteps: no covering seed in ${base}..${base + window - 1}`)
}
