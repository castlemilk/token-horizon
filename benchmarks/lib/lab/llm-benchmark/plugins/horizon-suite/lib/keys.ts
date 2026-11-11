/**
 * Keyboard helpers. tabWalk drives real Tab key events (page.keyboard.press), so
 * it measures what a keyboard user reaches, not what the DOM claims is focusable.
 *
 * Sequential focus starts from the top of the document: a focusable sentinel
 * is inserted before the first element and focused, so the first Tab lands on the
 * first real tab stop. The sentinel is removed afterwards, in finally.
 */
import type { Page } from 'playwright'
import { bounded, finishAnimations, freezeMotion, probe } from './probe'
import { TAB_BLUR_AND_CLEAN, TAB_SNAPSHOT, TAB_START, TAB_STATE } from './sources'

const ACTION_MS = 1500

export interface FocusStyle {
  outlineStyle: string
  outlineWidth: string
  outlineColor: string
  boxShadow: string
  borderColor: string
  backgroundColor: string
  color: string
}

/**
 * One tab stop: its position in the tab-order list, its identity and computed focus
 * styles. identity is data-plan, else id, else data-action, data-testid, aria-label,
 * then tag:text. A task that needs its own contract identity reads id, tag, type and
 * dataset (every data-* attribute, keyed without the prefix) and derives it.
 */
export interface TabEntry {
  index: number
  identity: string
  style: FocusStyle
  id: string
  tag: string
  type: string
  dataset: Record<string, string>
}

export interface TabWalkResult {
  /** Tab stops reached by pressing Tab, in order, each with its FOCUSED styles. */
  visits: TabEntry[]
  /** Every tab stop's styles before any focus (sentinel focused, nothing else). */
  unfocusedBefore: TabEntry[]
  /** Every tab stop's styles after the walk, with focus moved off the page. */
  unfocusedAfter: TabEntry[]
  /** Why the walk stopped: focus left the page, it returned to the first stop, or the press limit was reached. */
  ended: 'left-page' | 'cycled' | 'limit'
}

interface TabStateReply extends Partial<TabEntry> {
  active: boolean
}

/**
 * Press Tab up to maxPresses times from the top of the document, recording each
 * stop's identity and focused styles, then compare with the unfocused styles. The
 * walk stops when focus leaves the page or returns to the first stop.
 *
 * Motion is frozen first (freezeMotion), and every animation is finished after each
 * key press and after the blur (finishAnimations), so a stop's styles are read at
 * the end of any transition, never at its first frame. Motion stays frozen in this
 * document afterwards: a check that measures a transition must load the page again
 * (freshLoad or loadOpaque) before it runs.
 */
export async function tabWalk(page: Page, maxPresses: number): Promise<TabWalkResult> {
  if (!Number.isInteger(maxPresses) || maxPresses < 1) {
    throw new RangeError(`tabWalk needs a positive integer maxPresses, got ${maxPresses}`)
  }
  await freezeMotion(page)
  await probe(page, TAB_START, undefined, ACTION_MS)
  try {
    await finishAnimations(page)
    const unfocusedBefore = await probe<TabEntry[]>(page, TAB_SNAPSHOT, undefined, ACTION_MS)
    const visits: TabEntry[] = []
    let ended: TabWalkResult['ended'] = 'limit'
    for (let press = 0; press < maxPresses; press++) {
      await bounded(page.keyboard.press('Tab'), ACTION_MS, 'Tab press')
      await finishAnimations(page)
      const state = await probe<TabStateReply>(page, TAB_STATE, undefined, ACTION_MS)
      if (!state.active) {
        ended = 'left-page'
        break
      }
      const index = state.index ?? -1
      if (visits.length > 0 && index === visits[0]!.index) {
        ended = 'cycled'
        break
      }
      visits.push({
        index,
        identity: state.identity ?? '',
        style: state.style!,
        id: state.id ?? '',
        tag: state.tag ?? '',
        type: state.type ?? '',
        dataset: state.dataset ?? {},
      })
    }
    await probe(page, TAB_BLUR_AND_CLEAN, undefined, ACTION_MS).catch(() => undefined)
    await finishAnimations(page)
    const unfocusedAfter = await probe<TabEntry[]>(page, TAB_SNAPSHOT, undefined, ACTION_MS)
    return { visits, unfocusedBefore, unfocusedAfter, ended }
  } finally {
    await probe(page, TAB_BLUR_AND_CLEAN, undefined, ACTION_MS).catch(() => undefined)
  }
}
