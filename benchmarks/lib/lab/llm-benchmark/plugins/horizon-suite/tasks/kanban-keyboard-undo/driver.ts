/**
 * Shared driving and comparison helpers for the kanban checks. Clicks and form submits
 * are never read after a settle: each one goes through act(), which performs the action
 * and reads the board, the add wiring and the add-error visibility in the same in-page
 * turn (the prompt promises that a click or submit handler leaves everything final when it
 * returns). Key presses are real input, so they are followed by the two-frame settle.
 * Playwright actions are capped at 1500 ms and always follow an in-page probe.
 */
import type { Page } from 'playwright'
import { bounded, probe, settle } from '../../lib/probe'
import { VISIBLE } from '../../lib/sources'
import { KanbanModel, COLS, type Board, type Col } from './reference'
import * as S from './in-page'

export const ACTION_MS = 1500
export const TOLERANCE_PX = 1

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

export interface BoardRead {
  titles: Record<Col, string[] | null>
  counts: Record<Col, string | null>
  cardBoxes: Record<Col, Box[]>
  colBoxes: Record<Col, Box | null>
  /** Per card: inside its column, or inside a scroll container's content between it and the column. */
  vContained: Record<Col, boolean[]>
  undoDisabled: boolean | null
  redoDisabled: boolean | null
  status: string | null
  statusChildren: number | null
  active: { kind: string; title?: string | null; id?: string; tag?: string }
}

export interface Wiring {
  ok: boolean
  describedBy?: boolean
  invalid?: string | null
  errorText?: string
  value?: string
  isActive?: boolean
}

export type ActOp =
  | { op: 'add'; title: string }
  | { op: 'add-many'; titles: string[] }
  | { op: 'action'; title: string; action: 'move-left' | 'move-right' | 'delete' }
  | { op: 'id'; id: 'undo' | 'redo' }
  | { op: 'undo-many'; count: number }

export interface Snapshot {
  act: { ok: boolean; disabled?: boolean; why?: string; n?: number }
  board: BoardRead
  wiring: Wiring
  addError: { visible: boolean; detail: string }
}

export function read(page: Page): Promise<BoardRead> {
  return probe<BoardRead>(page, S.READ_BOARD, undefined, ACTION_MS)
}

/** One in-page action and the board read in the same turn. */
export function act(page: Page, op: ActOp, timeoutMs: number = ACTION_MS): Promise<Snapshot> {
  return probe<Snapshot>(page, S.ACT_AND_READ, op, timeoutMs)
}

/** The titles of each column as a Board (a missing column reads as empty). */
export function titlesOf(r: BoardRead): Board {
  return { todo: r.titles.todo ?? [], doing: r.titles.doing ?? [], done: r.titles.done ?? [] }
}

/** One real key press with the action cap, then the two-frame settle. */
export async function pressKey(page: Page, key: string): Promise<void> {
  await bounded(page.keyboard.press(key), ACTION_MS, `key ${key}`)
  await settle(page)
}

/** Focus the card with exactly this title, in-page. */
export async function focusCardTitle(page: Page, title: string): Promise<boolean> {
  const r = await probe<{ ok: boolean }>(page, S.FOCUS_CARD, title, ACTION_MS)
  return r.ok
}

/** Focus the first card of a column, in-page (titles may repeat in the robust session). */
export async function focusFirstCard(page: Page, col: Col): Promise<boolean> {
  const r = await probe<{ ok: boolean }>(page, S.FOCUS_FIRST, col, ACTION_MS)
  return r.ok
}

/** Whether the first card of a column is visible to a user (kit VISIBLE: display, opacity, hit test). */
export function firstCardVisible(page: Page, col: Col): Promise<{ visible: boolean; detail: string }> {
  return probe<{ visible: boolean; detail: string }>(page, VISIBLE, `[data-column="${col}"] [data-list] > [data-card]:first-child`, ACTION_MS)
}

/**
 * Describe a board mismatch, or return null when the artifact matches the model. The
 * history buttons are compared only when withHistory is true; keyboard-moves passes false
 * so that a history-button defect is charged to the checks that own it.
 */
export function compareModel(r: BoardRead, m: KanbanModel, withHistory = true): string | null {
  for (const c of COLS) {
    const got = r.titles[c]
    if (got === null) return `column ${c} missing`
    const want = m.board[c]
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `${c} shows ${JSON.stringify(got).slice(0, 160)}, model ${JSON.stringify(want).slice(0, 160)}`
    }
    if (r.counts[c] !== String(want.length)) return `${c} count "${r.counts[c]}" is not ${want.length}`
  }
  if (!withHistory) return null
  if (r.undoDisabled !== !m.canUndo()) return `undo disabled ${r.undoDisabled}, model says ${!m.canUndo()}`
  if (r.redoDisabled !== !m.canRedo()) return `redo disabled ${r.redoDisabled}, model says ${!m.canRedo()}`
  return null
}

/**
 * Layout rules read from geometry: each card lies inside its column horizontally (1 px
 * tolerance), vertically either inside its column or inside a scroll container's content
 * (vContained, computed in-page), and card tops rise strictly down each column.
 */
export function layoutProblems(r: BoardRead): string | null {
  for (const c of COLS) {
    const col = r.colBoxes[c]
    if (col === null) return `column ${c} has no box`
    const boxes = r.cardBoxes[c]
    const contained = r.vContained[c]
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!
      if (b.left < col.left - TOLERANCE_PX || b.right > col.right + TOLERANCE_PX) {
        return `card ${i} of ${c} sticks out of its column horizontally`
      }
      if (contained[i] !== true) return `card ${i} of ${c} sticks out of its column vertically`
      if (i > 0 && !(b.top > boxes[i - 1]!.top)) return `card tops in ${c} are not strictly increasing at ${i}`
    }
  }
  return null
}

export function statusHas(r: BoardRead, text: string): boolean {
  return (r.status ?? '').toLowerCase().includes(text.toLowerCase())
}

export function clip(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max - 3) + '...'
}

/** Key name for the robust-session step (Playwright names the space bar 'Space'; the key is the character). */
export function robustKeyName(key: string): string {
  return key === 'Space' ? ' ' : key
}
