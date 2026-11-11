import { describe, expect, it } from 'vitest'
import {
  KanbanModel,
  FIRST_LOAD,
  LIMIT,
  applyCardKey,
  boardsEqual,
  cloneBoard,
  countsOf,
  coversRobustCases,
  generateCoveringRobustSteps,
  generateKeyScript,
  generateRobustSteps,
  isValidTitle,
  normalise,
  coversKeyCases,
  type Board,
} from './reference'
import {
  HISTORY_SCRIPT,
  INPUT_DRAFT,
  KEY_SEED,
  KEY_STEP_COUNT,
  KEY_TITLES,
  OPAQUE_STEPS,
  ROBUST_SEED,
  ROBUST_STEP_COUNT,
  ROBUST_TITLES,
} from './hidden'

/** The board the keyboard check works on: first load plus the five hidden titles. */
function keyStart(): KanbanModel {
  const m = new KanbanModel(FIRST_LOAD)
  for (const t of KEY_TITLES) expect(m.add(t).ok).toBe(true)
  return m
}

describe('normalise and validity', () => {
  it('trims and collapses whitespace runs to one space', () => {
    expect(normalise('  Ship   the\tQ3  report ')).toBe('Ship the Q3 report')
  })

  it('accepts 1 to 80 characters and rejects empty or 81 characters', () => {
    expect(isValidTitle('')).toBe(false)
    expect(isValidTitle('a')).toBe(true)
    expect(isValidTitle('a'.repeat(80))).toBe(true)
    expect(isValidTitle('a'.repeat(81))).toBe(false)
  })

  it('treats three spaces as empty after normalisation', () => {
    expect(isValidTitle(normalise('   '))).toBe(false)
  })
})

describe('KanbanModel history rules', () => {
  it('reverts a move exactly and redo reapplies it', () => {
    const m = new KanbanModel(FIRST_LOAD)
    expect(m.move('Fix login redirect', 1).ok).toBe(true)
    expect(m.board.doing).toEqual(['Migrate billing cron', 'Fix login redirect'])
    expect(m.undo()).toBe(true)
    expect(boardsEqual(m.board, FIRST_LOAD)).toBe(true)
    expect(m.redo()).toBe(true)
    expect(m.board.doing).toEqual(['Migrate billing cron', 'Fix login redirect'])
  })

  it('a new action empties the redo history', () => {
    const m = new KanbanModel(FIRST_LOAD)
    m.add('One')
    m.undo()
    expect(m.canRedo()).toBe(true)
    m.add('Two')
    expect(m.canRedo()).toBe(false)
  })

  it('edge no-ops and the full-Doing refusal never enter history', () => {
    const m = new KanbanModel(FIRST_LOAD)
    expect(m.move('Draft release notes', -1).ok).toBe(false)
    expect(m.swap('Draft release notes', -1).ok).toBe(false)
    expect(m.move('Rotate API keys', 1).ok).toBe(false)
    expect(m.undoStack.length).toBe(0)
    // Fill Doing to its limit, then refuse a fourth card.
    expect(m.move('Draft release notes', 1).ok).toBe(true)
    expect(m.move('Update pricing copy', 1).ok).toBe(true)
    expect(m.board.doing.length).toBe(LIMIT)
    const before = m.undoStack.length
    const refused = m.move('Fix login redirect', 1)
    expect(refused).toEqual({ ok: false, reason: 'limit' })
    expect(m.undoStack.length).toBe(before)
  })

  it('undo reports false on an empty history and never throws', () => {
    const m = new KanbanModel(FIRST_LOAD)
    expect(m.undo()).toBe(false)
    expect(m.redo()).toBe(false)
  })

  it('delete focus rule: next card, else previous, else null (evaluated after the removal)', () => {
    const m = new KanbanModel(FIRST_LOAD)
    m.remove('Draft release notes')
    expect(m.focusAfterDelete('todo', 0)).toBe('Fix login redirect')
    const n = new KanbanModel(FIRST_LOAD)
    n.remove('Update pricing copy')
    expect(n.focusAfterDelete('todo', 2)).toBe('Fix login redirect')
    const o = new KanbanModel(FIRST_LOAD)
    o.remove('Migrate billing cron')
    expect(o.focusAfterDelete('doing', 0)).toBe(null)
  })
})

describe('history script (35 steps)', () => {
  it('has the specified composition: 35 steps, 7 keys, 28 non-key', () => {
    expect(HISTORY_SCRIPT.length).toBe(35)
    const keys = HISTORY_SCRIPT.filter((s) => s.k === 'key')
    expect(keys.length).toBe(7)
    expect(HISTORY_SCRIPT.length - keys.length).toBe(28)
  })

  it('applies cleanly: every undo, redo and click lands, and the designated edge no-ops are the only refusals', () => {
    const m = new KanbanModel(FIRST_LOAD)
    const refusals: string[] = []
    for (const step of HISTORY_SCRIPT) {
      switch (step.k) {
        case 'add': {
          const r = m.add(step.title)
          if (!r.ok) refusals.push(`add ${step.title}: ${r.reason}`)
          break
        }
        case 'click': {
          const dir = step.action === 'move-left' ? -1 : step.action === 'move-right' ? 1 : 0
          const r = step.action === 'delete' ? m.remove(step.title) : m.move(step.title, dir as -1 | 1)
          if (!r.ok) refusals.push(`${step.action} ${step.title}: ${r.reason}`)
          break
        }
        case 'undo':
          if (!m.undo()) refusals.push('undo empty')
          break
        case 'redo':
          if (!m.redo()) refusals.push('redo empty')
          break
        case 'undoAll':
          while (m.undo()) {
            // run until empty
          }
          break
        case 'redoAll':
          while (m.redo()) {
            // run until empty
          }
          break
        case 'key': {
          if ('inputText' in step) {
            // Focus is in #new-title: Control+z is ignored by the page, so the model is untouched.
            expect(step.inputText).toBe(INPUT_DRAFT)
            break
          }
          const r = applyCardKey(m, step.title, step.key === 'Control+z' ? 'Control+z' : step.key)
          if (step.key === 'Control+z') {
            if (!m.undo()) refusals.push('ctrl+z empty')
          } else if (step.key === 'Control+y') {
            if (!m.redo()) refusals.push('ctrl+y empty')
          } else if (!r.ok) {
            // Edge no-ops are expected here; anything else is a script error.
            expect(r.reason).toBe('edge')
          }
          break
        }
      }
    }
    expect(refusals).toEqual([])
  })

  it('the two edge no-ops are followed by an undo that reverts the previous real action', () => {
    const m = new KanbanModel(FIRST_LOAD)
    m.add('Ship the Q3 report')
    m.add('Draft press kit')
    m.move('Draft press kit', 1)
    const before = cloneBoard(m.board)
    expect(m.swap('Draft release notes', -1).ok).toBe(false)
    expect(m.undo()).toBe(true)
    expect(boardsEqual(m.board, cloneBoard(before))).toBe(false) // the undo reverted the move, not the no-op
  })
})

describe('opaque-origin script (15 steps)', () => {
  it('has the specified length and applies in the model with no refusals', () => {
    expect(OPAQUE_STEPS.length).toBe(15)
    const m = new KanbanModel(FIRST_LOAD)
    for (const step of OPAQUE_STEPS) {
      if (step.k === 'add') expect(m.add(step.title).ok).toBe(true)
      else if (step.k === 'move') expect(m.move(step.title, step.dir).ok).toBe(true)
      else if (step.k === 'delete') expect(m.remove(step.title).ok).toBe(true)
      else expect(m.undo()).toBe(true)
    }
  })
})

describe('keyboard-moves script (generated)', () => {
  it('is generated from the seed, has 18 operations and covers every required case', () => {
    const script = generateKeyScript(keyStart(), KEY_SEED)
    expect(script.ops.length).toBe(KEY_STEP_COUNT)
    expect(coversKeyCases(script.ops)).toBe(true)
  })

  it('is deterministic for the same start board and seed', () => {
    const a = generateKeyScript(keyStart(), KEY_SEED)
    const b = generateKeyScript(keyStart(), KEY_SEED)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('never moves a card into a full Doing (it would be a limit refusal)', () => {
    const script = generateKeyScript(keyStart(), KEY_SEED)
    const m = keyStart()
    for (const op of script.ops) {
      const out = applyCardKey(m, op.title, op.key)
      if (out.ok === false) expect(out.reason).not.toBe('limit')
    }
  })
})

describe('robust-session generator', () => {
  it('produces the same sixty steps for the same seed', () => {
    const a = generateRobustSteps(ROBUST_SEED, ROBUST_STEP_COUNT, ROBUST_TITLES.length)
    const b = generateRobustSteps(ROBUST_SEED, ROBUST_STEP_COUNT, ROBUST_TITLES.length)
    expect(a.length).toBe(ROBUST_STEP_COUNT)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the covering search returns a seeded list that covers every robust case, deterministically', () => {
    const a = generateCoveringRobustSteps(ROBUST_SEED, ROBUST_STEP_COUNT - 20, ROBUST_TITLES.length)
    const b = generateCoveringRobustSteps(ROBUST_SEED, ROBUST_STEP_COUNT - 20, ROBUST_TITLES.length)
    expect(a.seed).toBeGreaterThanOrEqual(ROBUST_SEED)
    expect(a.steps.length).toBe(ROBUST_STEP_COUNT - 20)
    expect(coversRobustCases(a.steps)).toBe(true)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('a list without an Enter submit or a shortcut on a card does not cover the robust cases', () => {
    const none = generateRobustSteps(ROBUST_SEED, 3, ROBUST_TITLES.length)
    expect(coversRobustCases(none)).toBe(false)
  })
})

describe('keyboard-moves coverage of Done', () => {
  it('the generated script moves a card into a non-empty Done and out of Done into Doing', () => {
    const script = generateKeyScript(keyStart(), KEY_SEED)
    expect(script.ops.some((o) => o.key === 'Shift+ArrowRight' && o.col === 'doing' && !o.noop && o.destLen > 0)).toBe(true)
    expect(script.ops.some((o) => o.key === 'Shift+ArrowLeft' && o.col === 'done' && !o.noop && o.destLen > 0)).toBe(true)
  })
})

describe('model helpers', () => {
  it('countsOf reports each column length', () => {
    expect(countsOf(FIRST_LOAD)).toEqual({ todo: 3, doing: 1, done: 1 })
  })

  it('cloneBoard does not share arrays', () => {
    const b: Board = cloneBoard(FIRST_LOAD)
    b.todo.push('x')
    expect(FIRST_LOAD.todo.length).toBe(3)
  })
})
