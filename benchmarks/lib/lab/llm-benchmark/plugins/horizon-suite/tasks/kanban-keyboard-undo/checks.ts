/**
 * The ten kanban-keyboard-undo checks, in the order the specification gives them.
 * Points sum to 100. Each check loads the artifact on its own routed origin unless
 * its method needs one origin across reloads (persistence, safe rendering).
 *
 * Clicks and form submits are read in the same in-page turn as the action (act() in
 * driver.ts), because the prompt makes every handler synchronous. Key presses are real
 * input and are followed by the two-frame settle.
 */
import type { Locator, Page } from 'playwright'
import { defineCheck } from '../../lib/check'
import { freshLoad, loadOpaque } from '../../lib/load'
import { bounded, errorWatch, hookPresent, probe } from '../../lib/probe'
import {
  COLS,
  FIRST_LOAD,
  KanbanModel,
  NAMES,
  applyCardKey,
  generateCoveringRobustSteps,
  generateKeyScript,
  type Board,
  type RobustStep,
} from './reference'
import * as H from './hidden'
import * as S from './in-page'
import {
  ACTION_MS,
  type BoardRead,
  type Wiring,
  act,
  clip,
  compareModel,
  firstCardVisible,
  focusCardTitle,
  focusFirstCard,
  layoutProblems,
  pressKey,
  read,
  robustKeyName,
  statusHas,
  titlesOf,
} from './driver'

type Verdict = { passed: boolean; detail?: string }
const ok = (detail?: string): Verdict => ({ passed: true, detail })
const bad = (detail: string): Verdict => ({ passed: false, detail: clip(detail) })

/** The five engine-error shapes the specification names, for the alert scan. */
const ENGINE_SHAPE = /TypeError|ReferenceError|is not defined|is not (a )?function|Cannot read/

/** The first mismatch between a board and the expected titles, or null. */
function boardDiff(got: Board, want: Board): string | null {
  for (const c of COLS) {
    if (JSON.stringify(got[c]) !== JSON.stringify(want[c])) {
      return `${NAMES[c]} shows ${clip(JSON.stringify(got[c]), 140)}, want ${clip(JSON.stringify(want[c]), 140)}`
    }
  }
  return null
}

function countsMatch(r: BoardRead): string | null {
  for (const c of COLS) {
    const n = r.titles[c]?.length
    if (n === undefined) return `column ${c} missing`
    if (r.counts[c] !== String(n)) return `${c} count "${r.counts[c]}" is not ${n}`
  }
  return null
}

function activeTitle(r: BoardRead): string | null {
  return r.active.kind === 'card' ? (r.active.title ?? null) : null
}

/**
 * The named button belongs to the card titled `title` with data-action `action`. The card is
 * found through the button itself, so the button's accessible name may come from any source
 * (text, aria-label or visually hidden text).
 */
async function ownedBy(page: Page, named: Locator, title: string, action: string): Promise<boolean> {
  const card = page.locator('[data-card]').filter({ has: named })
  if ((await bounded(card.count(), ACTION_MS, 'owner card count')) !== 1) return false
  const cardTitle = await card.locator('[data-card-title]').first().textContent({ timeout: ACTION_MS })
  if (cardTitle !== title) return false
  return (await named.getAttribute('data-action', { timeout: ACTION_MS })) === action
}

/** One button by its exact accessible name, with the button's own card checked by owner. */
async function seedButton(
  page: Page,
  label: string,
  title: string,
  action: 'move-left' | 'move-right' | 'delete'
): Promise<{ count: number; disabled: boolean | null; owned: boolean }> {
  const loc = page.getByRole('button', { name: label, exact: true })
  const count = await bounded(loc.count(), ACTION_MS, 'count button').catch(() => -1)
  if (count !== 1) return { count, disabled: null, owned: false }
  const disabled = await bounded(loc.isDisabled({ timeout: ACTION_MS }), ACTION_MS + 200, 'disabled').catch(() => null)
  const owned = await bounded(ownedBy(page, loc, title, action), ACTION_MS * 2 + 200, 'owner').catch(() => false)
  return { count, disabled, owned: owned === true }
}

/** The number of matches for a role query, and the id of the one match. */
async function uniqueId(loc: Locator): Promise<{ count: number; id: string | null }> {
  const count = await bounded(loc.count(), ACTION_MS, 'count').catch(() => -1)
  if (count !== 1) return { count, id: null }
  const id = await bounded(loc.getAttribute('id', { timeout: ACTION_MS }), ACTION_MS + 200, 'id').catch(() => null)
  return { count, id }
}

async function reloadPage(page: Page): Promise<void> {
  await bounded(page.reload({ waitUntil: 'domcontentloaded', timeout: 3000 }), 3000, 'reload')
}

/** The history button a step presses, read in the same turn; a missing or disabled button is an error. */
async function historyAct(page: Page, id: 'undo' | 'redo', label: string): Promise<{ board: BoardRead } | { error: string }> {
  const s = await act(page, { op: 'id', id })
  if (!s.act.ok) return { error: `${label}: #${id} missing` }
  if (s.act.disabled) return { error: `${label}: #${id} is disabled but the model has history to ${id}` }
  return { board: s.board }
}

// ---------------------------------------------------------------------------
// 1. Structure, names, counts and the first-load board
// ---------------------------------------------------------------------------

const structure = defineCheck(
  'kanban-structure-names',
  7,
  'The first-load board, column and list semantics, counts and accessible names of every control.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const r = await read(page)
    const first = boardDiff(titlesOf(r), FIRST_LOAD)
    if (first !== null) return bad(`first load: ${first}`)
    for (const c of COLS) {
      const name = NAMES[c]
      const region = await bounded(
        page.getByRole('region', { name, exact: true }).and(page.locator(`[data-column="${c}"]`)).count(),
        ACTION_MS,
        'region'
      ).catch(() => -1)
      if (region !== 1) return bad(`region "${name}" resolves to ${region} columns`)
      const items = await bounded(page.locator(`[data-column="${c}"]`).getByRole('listitem').count(), ACTION_MS, 'items').catch(() => -1)
      if (items !== FIRST_LOAD[c].length) return bad(`${name} has ${items} listitems, not ${FIRST_LOAD[c].length}`)
      if (r.counts[c] !== String(FIRST_LOAD[c].length)) return bad(`${name} count text is "${r.counts[c]}"`)
      const shown = await firstCardVisible(page, c)
      if (!shown.visible) return bad(`the first card of ${name} is not visible: ${shown.detail}`)
    }
    // Two seed cards, three buttons each: the specification's six named buttons.
    const seeds: Array<[string, 'move-left' | 'move-right' | 'delete', boolean | null]> = [
      ['Draft release notes', 'move-left', true],
      ['Draft release notes', 'move-right', false],
      ['Draft release notes', 'delete', false],
      ['Rotate API keys', 'move-left', false],
      ['Rotate API keys', 'move-right', true],
      ['Rotate API keys', 'delete', false],
    ]
    for (const [title, action, disabledWanted] of seeds) {
      const label = action === 'delete' ? `Delete "${title}"` : action === 'move-left' ? `Move "${title}" left` : `Move "${title}" right`
      const b = await seedButton(page, label, title, action)
      if (b.count !== 1) return bad(`button "${label}" matches ${b.count}`)
      if (!b.owned) return bad(`"${label}" is not the ${action} button of the card titled "${title}"`)
      if (disabledWanted !== null && b.disabled !== disabledWanted) return bad(`"${label}" disabled ${b.disabled}, want ${disabledWanted}`)
    }
    if (!(r.undoDisabled === true && r.redoDisabled === true)) {
      return bad(`undo/redo disabled ${r.undoDisabled}/${r.redoDisabled} on first load`)
    }
    const input = await uniqueId(page.getByRole('textbox', { name: 'New card title' }))
    if (input.count !== 1 || input.id !== 'new-title') return bad(`textbox "New card title" is ${input.id ?? `missing (${input.count} matches)`}`)
    const add = await uniqueId(page.getByRole('button', { name: 'Add card' }))
    if (add.count !== 1 || add.id !== 'add-btn') return bad(`button "Add card" is ${add.id ?? `missing (${add.count} matches)`}`)
    const status = await uniqueId(page.locator('#status').and(page.getByRole('status')))
    if (status.count !== 1 || status.id !== 'status') return bad(`#status does not have role status (${status.count} matches)`)
    const facts = await probe<{ h1: number; main: number; lang: string | null; cardCount: number; cardTabindex: (string | null)[] }>(
      page,
      S.STRUCTURE_FACTS,
      undefined,
      ACTION_MS
    )
    if (facts.h1 !== 1) return bad(`${facts.h1} h1 elements`)
    if (facts.main !== 1) return bad(`${facts.main} main elements`)
    if (!(facts.lang ?? '').startsWith('en')) return bad(`html lang is "${facts.lang}"`)
    if (facts.cardTabindex.some((t) => t !== '0')) return bad(`card tabindex values ${JSON.stringify(facts.cardTabindex)}`)
    return ok('first-load board, regions, buttons, counts and landmarks match')
  }
)

// ---------------------------------------------------------------------------
// 2. Add validation, normalisation and wrapping
// ---------------------------------------------------------------------------

const addValidation = defineCheck(
  'kanban-add-validation',
  8,
  'Title normalisation, the 1 to 80 character rule, error wiring, focus staying in the input after an add and wrapping of an unbroken long title.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    if (!(await hookPresent(page, '#new-title'))) return bad('#new-title missing')
    await page.locator('#new-title').fill(H.ADD_TITLES.messy, { timeout: ACTION_MS })
    await pressKey(page, 'Enter')
    const r = await read(page)
    const todo = r.titles.todo ?? []
    if (todo[todo.length - 1] !== H.ADD_TITLES.messyNormalised) return bad(`last card is "${todo[todo.length - 1]}"`)
    if (r.counts.todo !== String(FIRST_LOAD.todo.length + 1)) return bad(`To do count is ${r.counts.todo} after one add`)
    const w = await probe<Wiring>(page, S.ADD_WIRING, undefined, ACTION_MS)
    if (w.value !== '') return bad(`input still holds "${w.value}" after a valid add`)
    if (!w.isActive) return bad('focus left #new-title after a valid add')
    if (w.invalid !== 'false') return bad(`aria-invalid is ${w.invalid} after a valid add`)

    let before = titlesOf(r).todo.length
    const invalid = [H.ADD_TITLES.empty, H.ADD_TITLES.spaces, H.ADD_TITLES.tooLong]
    for (const value of invalid) {
      const s = await act(page, { op: 'add', title: value })
      if (!s.act.ok) return bad(`the add did not run (${s.act.why ?? 'no result'})`)
      if (titlesOf(s.board).todo.length !== before) return bad(`invalid title (${value.length} chars) added a card`)
      if (s.wiring.invalid !== 'true') return bad(`aria-invalid is ${s.wiring.invalid} for an invalid title`)
      if ((s.wiring.errorText ?? '').trim() === '') return bad('no message in #add-error for an invalid title')
      if (!s.wiring.describedBy) return bad('#new-title is not described by #add-error')
      if (!s.addError.visible) return bad(`#add-error not visible: ${s.addError.detail}`)
      if (s.wiring.value !== value) return bad('the typed text was changed by an invalid submit')
      before = titlesOf(s.board).todo.length
    }

    const s = await act(page, { op: 'add', title: H.UNBROKEN_TITLE })
    if (!s.act.ok) return bad(`the 80-character add did not run (${s.act.why ?? 'no result'})`)
    const todo2 = titlesOf(s.board).todo
    if (todo2[todo2.length - 1] !== H.UNBROKEN_TITLE) return bad('80-character title was not accepted')
    if (s.wiring.invalid !== 'false') return bad(`aria-invalid is ${s.wiring.invalid} after a valid add`)
    if ((s.wiring.errorText ?? '').trim() !== '') return bad(`#add-error still shows "${clip(s.wiring.errorText ?? '', 60)}"`)
    if (s.wiring.value !== '') return bad(`input still holds "${s.wiring.value}" after a valid add`)
    if (!s.wiring.isActive) return bad('focus left #new-title after a valid add')
    const geo = await probe<{
      found: number
      titleRight: number
      cardRight: number
      cardLeft: number
      colRight: number
      colLeft: number
      scrollWidth: number
      clientWidth: number
    }>(page, S.LONG_TITLE_GEOMETRY, H.UNBROKEN_TITLE, ACTION_MS)
    if (geo.found !== 1) return bad(`long card found ${geo.found} times`)
    if (geo.titleRight > geo.cardRight + 1) return bad(`long title overflows its card by ${(geo.titleRight - geo.cardRight).toFixed(1)} px`)
    if (geo.cardRight > geo.colRight + 1 || geo.cardLeft < geo.colLeft - 1) return bad('long card leaves its column')
    if (geo.scrollWidth > geo.clientWidth + 1) return bad(`page scrolls sideways: ${geo.scrollWidth} > ${geo.clientWidth}`)
    return ok('normalised, 81 and empty rejected with wiring, 80-character title wraps')
  }
)

// ---------------------------------------------------------------------------
// 3. Keyboard moves, edge no-ops, announcements
// ---------------------------------------------------------------------------

const keyboardMoves = defineCheck(
  'kanban-keyboard-moves',
  13,
  'Shift+arrow swaps and moves and the Delete key change the board exactly as specified, edge no-ops included, and each move is announced.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const setup = await act(page, { op: 'add-many', titles: [...H.KEY_TITLES] })
    if (!setup.act.ok) return bad(`setup adds did not run (${setup.act.why ?? 'no result'})`)
    const model = new KanbanModel(FIRST_LOAD)
    for (const t of H.KEY_TITLES) model.add(t)
    // The history buttons are charged to structure, undo-redo and persistence, not here.
    const mismatch0 = compareModel(setup.board, model, false)
    if (mismatch0 !== null) return bad(`setup: ${mismatch0}`)

    const script = generateKeyScript(new KanbanModel(model.board), H.KEY_SEED)
    for (let i = 0; i < script.ops.length; i++) {
      const op = script.ops[i]!
      if (!(await focusCardTitle(page, op.title))) return bad(`step ${i + 1}: cannot focus "${op.title}"`)
      const dir = op.key === 'Shift+ArrowUp' || op.key === 'Shift+ArrowLeft' ? -1 : 1
      const outcome = applyCardKey(model, op.title, op.key)
      const destCol = op.key === 'Shift+ArrowLeft' || op.key === 'Shift+ArrowRight' ? COLS[COLS.indexOf(op.col) + dir] : undefined
      await pressKey(page, op.key)
      const r = await read(page)
      const mm = compareModel(r, model, false)
      if (mm !== null) return bad(`step ${i + 1} ${op.key} on "${op.title}": ${mm}`)
      const lay = layoutProblems(r)
      if (lay !== null) return bad(`step ${i + 1}: ${lay}`)
      if (outcome.ok) {
        if (destCol !== undefined) {
          if (!statusHas(r, op.title) || !statusHas(r, NAMES[destCol])) {
            return bad(`step ${i + 1}: status "${clip(r.status ?? '', 80)}" lacks "${op.title}" or "${NAMES[destCol]}"`)
          }
        } else if (op.key === 'Delete' || op.key === 'Shift+ArrowUp' || op.key === 'Shift+ArrowDown') {
          if (!statusHas(r, op.title)) return bad(`step ${i + 1}: status "${clip(r.status ?? '', 80)}" lacks "${op.title}"`)
        }
      }
    }
    return ok(`${script.ops.length} key operations match the model (seed ${script.seed})`)
  }
)

// ---------------------------------------------------------------------------
// 4. Focus management
// ---------------------------------------------------------------------------

const focusManagement = defineCheck(
  'kanban-focus-management',
  11,
  'Focus follows the moved card, plain arrows move focus without changing the board, and focus lands correctly after a delete.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const setup = await act(page, { op: 'add-many', titles: [...H.FOCUS_TITLES] })
    if (!setup.act.ok) return bad(`setup adds did not run (${setup.act.why ?? 'no result'})`)

    // (a) follow the moved card, and check where it went, through Shift+ArrowDown,
    // Shift+ArrowRight and Shift+ArrowLeft. Each step changes exactly one card's place.
    const moved = 'Update pricing copy'
    const b0 = titlesOf(setup.board)
    const i0 = b0.todo.indexOf(moved)
    if (i0 < 0 || i0 >= b0.todo.length - 1) return bad('the middle card is not above the last To do card')
    if (!(await focusCardTitle(page, moved))) return bad('cannot focus the middle card')

    await pressKey(page, 'Shift+ArrowDown')
    let r = await read(page)
    if (activeTitle(r) !== moved) return bad(`after Shift+ArrowDown focus is ${activeTitle(r)}`)
    const swapped = [...b0.todo]
    ;[swapped[i0], swapped[i0 + 1]] = [swapped[i0 + 1]!, swapped[i0]!]
    let want: Board = { todo: swapped, doing: b0.doing, done: b0.done }
    let diff = boardDiff(titlesOf(r), want)
    if (diff !== null) return bad(`after Shift+ArrowDown: ${diff}`)

    await pressKey(page, 'Shift+ArrowRight')
    r = await read(page)
    if (activeTitle(r) !== moved) return bad(`after Shift+ArrowRight focus is ${activeTitle(r)}`)
    want = { todo: want.todo.filter((t) => t !== moved), doing: [...want.doing, moved], done: want.done }
    diff = boardDiff(titlesOf(r), want)
    if (diff !== null) return bad(`after Shift+ArrowRight: ${diff}`)

    await pressKey(page, 'Shift+ArrowLeft')
    r = await read(page)
    if (activeTitle(r) !== moved) return bad(`after Shift+ArrowLeft focus is ${activeTitle(r)}`)
    want = { todo: [...want.todo, moved], doing: want.doing.filter((t) => t !== moved), done: want.done }
    diff = boardDiff(titlesOf(r), want)
    if (diff !== null) return bad(`after Shift+ArrowLeft: ${diff}`)

    // (b) plain arrows move focus to the next and previous card without changing the board;
    // ArrowUp on the first card has no previous card and leaves focus where it is.
    r = await read(page)
    const before = titlesOf(r)
    const undoBefore = r.undoDisabled
    if (!(await focusFirstCard(page, 'todo'))) return bad('cannot focus the first card')
    await pressKey(page, 'ArrowDown')
    r = await read(page)
    if (activeTitle(r) !== before.todo[1]) return bad(`ArrowDown focus is ${activeTitle(r)}`)
    await pressKey(page, 'ArrowUp')
    r = await read(page)
    if (activeTitle(r) !== before.todo[0]) return bad(`ArrowUp focus is ${activeTitle(r)}`)
    await pressKey(page, 'ArrowUp')
    r = await read(page)
    if (activeTitle(r) !== before.todo[0]) return bad(`ArrowUp on the first card moved focus to ${activeTitle(r)}`)
    diff = boardDiff(titlesOf(r), before)
    if (diff !== null) return bad(`plain arrows changed the board: ${diff}`)
    if (r.undoDisabled !== undoBefore) return bad('plain arrows changed the undo state')

    // (c) Delete: middle card -> next, last card -> previous, only card in Doing -> #new-title.
    r = await read(page)
    const todo = titlesOf(r).todo
    if (todo.length < 4) return bad(`To do has ${todo.length} cards, the check needs at least 4`)
    const mid = Math.floor(todo.length / 2) - 1
    if (!(await focusCardTitle(page, todo[mid]!))) return bad('cannot focus the middle card for delete')
    await pressKey(page, 'Delete')
    r = await read(page)
    if (activeTitle(r) !== todo[mid + 1]) return bad(`Delete on middle card focused ${activeTitle(r)}, want ${todo[mid + 1]}`)
    const afterMid = todo.filter((_, i) => i !== mid)
    diff = boardDiff(titlesOf(r), { todo: afterMid, doing: before.doing, done: before.done })
    if (diff !== null) return bad(`Delete on the middle card: ${diff}`)

    const todo2 = titlesOf(r).todo
    const lastTitle = todo2[todo2.length - 1]!
    const previousTitle = todo2[todo2.length - 2]!
    if (!(await focusCardTitle(page, lastTitle))) return bad('cannot focus the last card')
    await pressKey(page, 'Delete')
    r = await read(page)
    if (activeTitle(r) !== previousTitle) return bad(`Delete on last card focused ${activeTitle(r)}, want ${previousTitle}`)
    diff = boardDiff(titlesOf(r), { todo: todo2.slice(0, -1), doing: before.doing, done: before.done })
    if (diff !== null) return bad(`Delete on the last card: ${diff}`)

    if (titlesOf(r).doing.length !== 1) return bad(`Doing has ${titlesOf(r).doing.length} cards, the check needs exactly 1`)
    const onlyDoing = titlesOf(r).doing[0]!
    if (!(await focusCardTitle(page, onlyDoing))) return bad('cannot focus the only Doing card')
    await pressKey(page, 'Delete')
    r = await read(page)
    if (!(r.active.kind === 'id' && r.active.id === 'new-title')) return bad(`Delete on the only Doing card focused ${JSON.stringify(r.active)}`)
    if (titlesOf(r).doing.length !== 0) return bad('the only Doing card was not deleted')

    // (d) an in-page click on a delete button, read in the same turn.
    const todo3 = titlesOf(r).todo
    const target = todo3[1]!
    const expected = await probe<{
      error?: string
      expectInput: boolean
      expectTitle: string | null
      activeKind: string
      activeTitle: string | null
      activeId: string
      colBefore: string[]
      colAfter: string[]
    }>(page, S.DELETE_CLICK_FOCUS, target, ACTION_MS)
    if (expected.error) return bad(`click delete: ${expected.error}`)
    if (JSON.stringify(expected.colAfter) !== JSON.stringify(expected.colBefore.filter((t) => t !== target))) {
      return bad(`click delete on "${target}" left To do as ${clip(JSON.stringify(expected.colAfter), 120)}`)
    }
    if (expected.expectInput) {
      if (!(expected.activeKind === 'id' && expected.activeId === 'new-title')) return bad('click delete with no neighbour did not focus #new-title')
    } else if (expected.activeKind !== 'card' || expected.activeTitle !== expected.expectTitle) {
      return bad(`click delete focused ${expected.activeTitle}, want ${expected.expectTitle}`)
    }
    return ok('focus follows moves, plain arrows are not actions, delete focus rules hold')
  }
)

// ---------------------------------------------------------------------------
// 5. Work-in-progress limit
// ---------------------------------------------------------------------------

const wipLimit = defineCheck(
  'kanban-wip-limit',
  8,
  'Doing never exceeds 3 cards, by key or by button, the rejection is announced, and rejections stay out of the history.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    // A spare To do card, so the retry at the end moves a different card from the rejected one.
    const spare = await act(page, { op: 'add', title: H.WIP_SPARE })
    if (!spare.act.ok) return bad('add form missing')
    const a = await act(page, { op: 'action', title: 'Draft release notes', action: 'move-right' })
    if (!a.act.ok || a.act.disabled) return bad('first move-right click did not land')
    const s1 = titlesOf(a.board)
    const b = await act(page, { op: 'action', title: 'Fix login redirect', action: 'move-right' })
    if (!b.act.ok || b.act.disabled) return bad('second move-right click did not land')
    const s2 = titlesOf(b.board)
    if (s2.doing.length !== 3) return bad(`Doing holds ${s2.doing.length} after two moves, not 3`)

    // Refresh the status between attempts without changing the history depth: undo the
    // second move, redo it, and require the board to come back to the recorded state.
    const refresh = async (): Promise<string | null> => {
      const u = await act(page, { op: 'id', id: 'undo' })
      if (!u.act.ok || u.act.disabled) return 'undo is not available for the status refresh'
      const d1 = boardDiff(titlesOf(u.board), s1)
      if (d1 !== null) return `status refresh (undo): ${d1}`
      const rd = await act(page, { op: 'id', id: 'redo' })
      if (!rd.act.ok || rd.act.disabled) return 'redo is not available for the status refresh'
      const d2 = boardDiff(titlesOf(rd.board), s2)
      if (d2 !== null) return `status refresh (redo): ${d2}`
      return null
    }
    const rejected = async (label: string, run: () => Promise<BoardRead>): Promise<string | null> => {
      let r: BoardRead
      try {
        r = await run()
      } catch (e) {
        return `${label}: ${(e as Error).message}`
      }
      const d = boardDiff(titlesOf(r), s2)
      if (d !== null) return `${label} changed the board: ${d}`
      if (countsMatch(r) !== null) return `${label} changed the counts`
      if (!statusHas(r, 'limit')) return `${label}: status "${clip(r.status ?? '', 80)}" lacks "limit"`
      return null
    }

    let m = await rejected('Shift+ArrowRight on To do', async () => {
      if (!(await focusCardTitle(page, 'Update pricing copy'))) throw new Error('cannot focus To do card')
      await pressKey(page, 'Shift+ArrowRight')
      return read(page)
    })
    if (m !== null) return bad(m)
    m = await refresh()
    if (m !== null) return bad(m)
    m = await rejected('move-right button on To do', async () => {
      const s = await act(page, { op: 'action', title: H.WIP_SPARE, action: 'move-right' })
      if (!s.act.ok || s.act.disabled) throw new Error('move-right button not found')
      return s.board
    })
    if (m !== null) return bad(m)
    m = await refresh()
    if (m !== null) return bad(m)
    m = await rejected('Shift+ArrowLeft on Done', async () => {
      if (!(await focusCardTitle(page, 'Rotate API keys'))) throw new Error('cannot focus Done card')
      await pressKey(page, 'Shift+ArrowLeft')
      return read(page)
    })
    if (m !== null) return bad(m)

    const un = await act(page, { op: 'id', id: 'undo' })
    if (!un.act.ok || un.act.disabled) return bad('undo is not available after the rejections')
    const d3 = boardDiff(titlesOf(un.board), s1)
    if (d3 !== null) return bad(`one undo did not return to the board before the second successful move: ${d3}`)
    const re = await act(page, { op: 'id', id: 'redo' })
    if (!re.act.ok || re.act.disabled) return bad('redo is not available')
    const d4 = boardDiff(titlesOf(re.board), s2)
    if (d4 !== null) return bad(`redo did not restore the full Doing: ${d4}`)

    // Doing is full again, so the delete is what frees the slot for the retry.
    const del = await act(page, { op: 'action', title: 'Migrate billing cron', action: 'delete' })
    if (!del.act.ok || del.act.disabled) return bad('delete of a Doing card did not land')
    const retry = await act(page, { op: 'action', title: H.WIP_SPARE, action: 'move-right' })
    if (!retry.act.ok || retry.act.disabled) return bad('retry move-right did not land')
    if (!titlesOf(retry.board).doing.includes(H.WIP_SPARE)) return bad('move after a delete did not succeed')
    return ok('rejections keep the board, announce the limit each time and stay out of the history')
  }
)

// ---------------------------------------------------------------------------
// 6. Undo and redo
// ---------------------------------------------------------------------------

const undoRedo = defineCheck(
  'kanban-undo-redo',
  16,
  'History semantics: exact reversal, redo, redo cleared by a new action, no-ops not recorded, disabled states, a deep history and shortcuts that leave the text input alone.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const shown = await firstCardVisible(page, 'todo')
    if (!shown.visible) return bad(`the first To do card is not visible: ${shown.detail}`)
    const model = new KanbanModel(FIRST_LOAD)
    for (let i = 0; i < H.HISTORY_SCRIPT.length; i++) {
      const step = H.HISTORY_SCRIPT[i]!
      const label = `step ${i + 1} (${step.k})`
      let board: BoardRead | null = null
      switch (step.k) {
        case 'add': {
          const s = await act(page, { op: 'add', title: step.title })
          if (!s.act.ok) return bad(`${label}: add did not run (${s.act.why ?? 'no result'})`)
          model.add(step.title)
          board = s.board
          break
        }
        case 'click': {
          const s = await act(page, { op: 'action', title: step.title, action: step.action })
          if (!s.act.ok) return bad(`${label}: ${s.act.why ?? 'no result'}`)
          if (s.act.disabled) return bad(`${label}: ${step.action} on "${step.title}" is disabled`)
          if (step.action === 'delete') model.remove(step.title)
          else model.move(step.title, step.action === 'move-left' ? -1 : 1)
          board = s.board
          break
        }
        case 'undo': {
          const h = await historyAct(page, 'undo', label)
          if ('error' in h) return bad(h.error)
          model.undo()
          board = h.board
          break
        }
        case 'redo': {
          const h = await historyAct(page, 'redo', label)
          if ('error' in h) return bad(h.error)
          model.redo()
          board = h.board
          break
        }
        case 'undoAll':
          while (model.canUndo()) {
            const h = await historyAct(page, 'undo', label)
            if ('error' in h) return bad(h.error)
            model.undo()
            const mm = compareModel(h.board, model)
            if (mm !== null) return bad(`${label} inner undo: ${mm}`)
          }
          break
        case 'redoAll':
          while (model.canRedo()) {
            const h = await historyAct(page, 'redo', label)
            if ('error' in h) return bad(h.error)
            model.redo()
            const mm = compareModel(h.board, model)
            if (mm !== null) return bad(`${label} inner redo: ${mm}`)
          }
          break
        case 'key': {
          if ('inputText' in step) {
            await probe(page, S.SET_INPUT, step.inputText, ACTION_MS)
            const focused = await probe<{ ok: boolean }>(page, S.FOCUS_ID, 'new-title', ACTION_MS)
            if (!focused.ok) return bad(`${label}: cannot focus #new-title`)
            await pressKey(page, 'Control+z')
            const wiring = await probe<Wiring>(page, S.ADD_WIRING, undefined, ACTION_MS)
            if (!wiring.ok) return bad(`${label}: input missing`)
            if (wiring.value !== step.inputText) return bad(`${label}: Control+z changed the input text to "${wiring.value}"`)
            break
          }
          if (!(await focusCardTitle(page, step.title))) return bad(`${label}: cannot focus "${step.title}"`)
          if (step.key === 'Control+z') model.undo()
          else if (step.key === 'Control+y') model.redo()
          else applyCardKey(model, step.title, step.key)
          await pressKey(page, step.key)
          break
        }
      }
      const r = board ?? (await read(page))
      const mm = compareModel(r, model)
      if (mm !== null) return bad(`${label}: ${mm}`)
    }

    // A deep history: one hundred adds in one turn, then one hundred undos in one turn.
    // An artifact that keeps fewer levels stops early and its board cannot match the model.
    const depth = Array.from({ length: H.DEPTH_COUNT }, (_, i) => H.depthTitle(i))
    const grown = await act(page, { op: 'add-many', titles: depth }, 3000)
    if (!grown.act.ok || grown.act.n !== depth.length) return bad(`only ${grown.act.n ?? 0} of ${depth.length} adds ran`)
    for (const t of depth) model.add(t)
    let mm = compareModel(grown.board, model)
    if (mm !== null) return bad(`after ${depth.length} adds: ${mm}`)
    const shrunk = await act(page, { op: 'undo-many', count: depth.length }, 3000)
    if (!shrunk.act.ok) return bad('#undo is missing during the deep undo')
    if (shrunk.act.n !== depth.length) return bad(`only ${shrunk.act.n ?? 0} of ${depth.length} undos ran; the history is too shallow`)
    for (let i = 0; i < depth.length; i++) model.undo()
    mm = compareModel(shrunk.board, model)
    if (mm !== null) return bad(`after ${depth.length} undos: ${mm}`)

    // Shortcuts on the page, with focus on the body: every form the specification names.
    const sc = await act(page, { op: 'add', title: H.SHORTCUT_TITLE })
    if (!sc.act.ok) return bad('shortcut card did not add')
    model.add(H.SHORTCUT_TITLE)
    mm = compareModel(sc.board, model)
    if (mm !== null) return bad(`after the shortcut card: ${mm}`)
    await probe(page, S.BLUR, undefined, ACTION_MS)
    const shortcuts: Array<[string, 'undo' | 'redo']> = [
      ['Meta+z', 'undo'],
      ['Control+Shift+Z', 'redo'],
      ['Control+z', 'undo'],
      ['Meta+Shift+Z', 'redo'],
      ['Meta+z', 'undo'],
      ['Control+y', 'redo'],
    ]
    for (const [key, what] of shortcuts) {
      await pressKey(page, key)
      const applied = what === 'undo' ? model.undo() : model.redo()
      if (!applied) return bad(`${key}: the model has nothing to ${what}`)
      const r = await read(page)
      mm = compareModel(r, model)
      if (mm !== null) return bad(`${key} (${what}): ${mm}`)
    }

    const end = await read(page)
    mm = compareModel(end, model)
    if (mm !== null) return bad(`end: ${mm}`)
    return ok(`${H.HISTORY_SCRIPT.length}-step history script, a ${H.DEPTH_COUNT}-level undo and every shortcut form match the model`)
  }
)

// ---------------------------------------------------------------------------
// 7. Safe rendering on the add path and the restore path
// ---------------------------------------------------------------------------

interface HostileInfo {
  found: number
  titleElementChildren?: number
  badElements?: number
  buttons?: number
}

async function hostileCheck(page: Page, title: string): Promise<string | null> {
  const info = await probe<HostileInfo>(page, S.HOSTILE_INFO, title, ACTION_MS)
  if (info.found !== 1) return `card for ${JSON.stringify(title)} found ${info.found} times`
  if (info.titleElementChildren !== 0) return `title element has ${info.titleElementChildren} element children`
  if (info.badElements !== 0) return `card for ${JSON.stringify(title)} contains img, b, i or script`
  if (info.buttons !== 3) return `card has ${info.buttons} buttons, not 3`
  return null
}

const safeRendering = defineCheck(
  'kanban-safe-rendering',
  9,
  'User titles are rendered as text on both the add path and the restore-from-storage path.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const model = new KanbanModel(FIRST_LOAD)
    for (const t of H.HOSTILE_TITLES) {
      const s = await act(page, { op: 'add', title: t })
      if (!s.act.ok) return bad(`add did not run for ${JSON.stringify(t)}`)
      if (!titlesOf(s.board).todo.includes(t)) return bad(`textContent of the new card is not ${JSON.stringify(t)}`)
      model.add(t)
      const mm = compareModel(s.board, model, false)
      if (mm !== null) return bad(`add path, after ${JSON.stringify(t)}: ${mm}`)
    }
    for (const t of H.HOSTILE_TITLES) {
      const mm = await hostileCheck(page, t)
      if (mm !== null) return bad(`add path: ${mm}`)
    }
    const flag = await probe<boolean>(page, '() => typeof window.__kb === "undefined"', undefined, ACTION_MS)
    if (!flag) return bad('an injected handler ran on the add path')

    const hostile = H.HOSTILE_TITLES[0]!
    const moved = await act(page, { op: 'action', title: hostile, action: 'move-right' })
    if (!moved.act.ok || moved.act.disabled) return bad('move of the hostile card did not run')
    model.move(hostile, 1)
    const movedMm = compareModel(moved.board, model, false)
    if (movedMm !== null) return bad(`move of the hostile card: ${movedMm}`)
    const status = await probe<{ found: boolean; bad: number; text: string }>(page, S.STATUS_SAFE, undefined, ACTION_MS)
    if (!status.found) return bad('#status is missing')
    if (status.bad !== 0) return bad(`#status holds ${status.bad} img, b, i or script elements built from a title`)
    if (!status.text.includes(hostile)) return bad(`#status text "${clip(status.text, 80)}" does not contain the hostile title`)

    await reloadPage(page)
    const restored = await read(page)
    const mmRestored = compareModel(restored, new KanbanModel(model.board), false)
    if (mmRestored !== null) return bad(`restored board: ${mmRestored}`)
    for (const t of H.HOSTILE_TITLES) {
      if (!COLS.some((c) => (restored.titles[c] ?? []).includes(t))) return bad(`restored board lacks ${JSON.stringify(t)}`)
      const mm = await hostileCheck(page, t)
      if (mm !== null) return bad(`restore path: ${mm}`)
    }
    const flag2 = await probe<boolean>(page, '() => typeof window.__kb === "undefined"', undefined, ACTION_MS)
    if (!flag2) return bad('an injected handler ran on the restore path')
    return ok('hostile titles stay text on the add path and after a reload')
  }
)

// ---------------------------------------------------------------------------
// 8. Persistence and recovery from unreadable or invalid stored data
// ---------------------------------------------------------------------------

const persistence = defineCheck(
  'kanban-persistence-recovery',
  9,
  'The board survives a reload, the history does not, and unreadable or invalid stored data falls back to the first-load board.',
  async (ctx) => {
    const page = ctx.page
    const pageErrors: string[] = []
    const onError = (e: Error): void => {
      pageErrors.push(e.message)
    }
    page.on('pageerror', onError)
    try {
      await freshLoad(ctx)
      const model = new KanbanModel(FIRST_LOAD)
      for (const t of H.PERSIST_TITLES) {
        const s = await act(page, { op: 'add', title: t })
        if (!s.act.ok) return bad(`add of "${t}" did not run`)
        model.add(t)
      }
      for (const title of ['Persist A', 'Persist B']) {
        const s = await act(page, { op: 'action', title, action: 'move-right' })
        if (!s.act.ok || s.act.disabled) return bad(`move of "${title}" did not run`)
        model.move(title, 1)
      }
      const del = await act(page, { op: 'action', title: 'Draft release notes', action: 'delete' })
      if (!del.act.ok || del.act.disabled) return bad('delete of "Draft release notes" did not run')
      model.remove('Draft release notes')
      const beforeMm = compareModel(del.board, model, false)
      if (beforeMm !== null) return bad(`before the reload: ${beforeMm}`)
      await reloadPage(page)
      const after = await read(page)
      // The reloaded board is the model's board, with no history.
      const diff = compareModel(after, new KanbanModel(model.board), false)
      if (diff !== null) return bad(`board after reload: ${diff}`)
      if (countsMatch(after) !== null) return bad(`counts after reload: ${countsMatch(after)}`)
      if (after.undoDisabled !== true || after.redoDisabled !== true) return bad('history survived the reload')
      const keys = await probe<{ ok: boolean; n: number }>(page, S.STORAGE_KEYS, undefined, ACTION_MS)
      if (!keys.ok || keys.n < 1) return bad('no key was stored')

      for (const value of H.CORRUPT_VALUES) {
        const w = await probe<{ ok: boolean; n: number; why?: string }>(page, S.OVERWRITE_STORAGE, value, ACTION_MS)
        if (!w.ok || w.n < 1) return bad(`could not overwrite stored data (${w.why ?? 'no key'})`)
        const errorsBefore = pageErrors.length
        await reloadPage(page)
        const r = await read(page)
        const d = boardDiff(titlesOf(r), FIRST_LOAD)
        if (d !== null) return bad(`after ${clip(value, 30)}: ${d}`)
        if (pageErrors.length > errorsBefore) return bad(`page error after ${clip(value, 30)}: ${pageErrors[pageErrors.length - 1]}`)
        const s = await act(page, { op: 'add', title: H.RECOVERED_TITLE })
        if (!s.act.ok) return bad(`add did not run after ${clip(value, 30)}`)
        const todo = titlesOf(s.board).todo
        if (todo[todo.length - 1] !== H.RECOVERED_TITLE) return bad(`add failed after ${clip(value, 30)}`)
      }
      if (pageErrors.length > 0) return bad(`page errors: ${pageErrors.join(' | ')}`)
      return ok('reload keeps the board, drops history and recovers from six corrupt values')
    } finally {
      page.off('pageerror', onError)
    }
  }
)

// ---------------------------------------------------------------------------
// 9. Update budget: in-place work, counted in DOM nodes
// ---------------------------------------------------------------------------

const updateBudget = defineCheck(
  'kanban-update-budget',
  10,
  'Work per step: one action touches only what it must instead of re-creating the board.',
  async (ctx) => {
    const page = ctx.page
    await freshLoad(ctx)
    const titles = Array.from({ length: H.BULK_ADDS }, (_, i) => H.bulkTitle(i))
    const added = await act(page, { op: 'add-many', titles }, 3000)
    if (!added.act.ok || added.act.n !== titles.length) return bad('the bulk adds did not all run')
    const todo = titlesOf(added.board).todo
    if (todo.length !== 98) return bad(`To do holds ${todo.length} cards after 95 adds, not 98`)

    const tagIndices = Array.from({ length: H.TAGGED_CARDS }, (_, i) => 60 + i)
    const started = await probe<{ tagged: number }>(page, S.OBSERVER_START, { tagIndices }, ACTION_MS)
    if (started.tagged !== H.TAGGED_CARDS) return bad('could not tag ten cards')

    const card = todo[49]!
    const neighbour = todo[50]!
    if (!(await focusCardTitle(page, card))) return bad('cannot focus the 50th card')
    await pressKey(page, 'Shift+ArrowDown')
    const f1 = await probe<{ sum: number; intact: boolean }>(page, S.OBSERVER_FLUSH, undefined, ACTION_MS)
    const r1 = await read(page)
    const t1 = titlesOf(r1).todo
    if (f1.sum > H.UPDATE_BUDGET_NODES) return bad(`swap changed ${f1.sum} nodes, budget ${H.UPDATE_BUDGET_NODES}`)
    if (!f1.intact) return bad('a tagged card was re-created by the swap')
    if (t1[49] !== neighbour || t1[50] !== card) return bad('the swap did not exchange the two cards')

    await probe(page, S.OBSERVER_RESET, undefined, ACTION_MS)
    if (!(await focusCardTitle(page, card))) return bad('cannot re-focus the moved card')
    await pressKey(page, 'Shift+ArrowRight')
    const f2 = await probe<{ sum: number; intact: boolean }>(page, S.OBSERVER_FLUSH, undefined, ACTION_MS)
    const r2 = await read(page)
    const doing = titlesOf(r2).doing
    if (f2.sum > H.UPDATE_BUDGET_NODES) return bad(`move changed ${f2.sum} nodes, budget ${H.UPDATE_BUDGET_NODES}`)
    if (!f2.intact) return bad('a tagged card was re-created by the move')
    if (doing[doing.length - 1] !== card) return bad('the moved card is not last in Doing')
    return ok(`swap ${f1.sum} nodes, move ${f2.sum} nodes (budget ${H.UPDATE_BUDGET_NODES})`)
  }
)

// ---------------------------------------------------------------------------
// 10. Robust session: keyboard fuzz, invariants, and storage-throws mode
// ---------------------------------------------------------------------------

async function invariants(page: Page): Promise<string | null> {
  const r = await read(page)
  const counts = countsMatch(r)
  if (counts !== null) return counts
  if (titlesOf(r).doing.length > 3) return `Doing holds ${titlesOf(r).doing.length}`
  const dups = await probe<number>(page, S.DUPLICATE_IDS, undefined, ACTION_MS)
  if (dups > 0) return `${dups} duplicated id(s)`
  return null
}

async function runRobustStep(page: Page, step: RobustStep): Promise<void> {
  if (step.kind === 'emptySubmit') {
    await act(page, { op: 'add', title: '' })
    return
  }
  if (step.kind === 'add') {
    const title = H.ROBUST_TITLES[step.title % H.ROBUST_TITLES.length]!
    if (step.via === 'enter') {
      await probe(page, S.FOCUS_ID, 'new-title', ACTION_MS)
      await probe(page, S.SET_INPUT, title, ACTION_MS)
      await pressKey(page, 'Enter')
    } else {
      await act(page, { op: 'add', title })
    }
    return
  }
  await probe(page, S.KEY_TARGET, { target: step.target, pick: step.pick }, ACTION_MS)
  await pressKey(page, robustKeyName(step.key))
}

/**
 * The robust plan: ten Control+z and ten Control+y on the body before any history exists
 * (past both ends), then the seeded remainder of the sixty steps. The seeded list is the
 * first seed from ROBUST_SEED whose steps cover every shortcut on a button and a card and
 * one Enter submit; the seed used is returned for the run log.
 */
function robustPlan(): { seed: number; steps: RobustStep[] } {
  const past = (key: 'Control+z' | 'Control+y'): RobustStep[] =>
    Array.from({ length: 10 }, () => ({ kind: 'key' as const, target: 'body' as const, pick: 0, key }))
  const seeded = generateCoveringRobustSteps(H.ROBUST_SEED, H.ROBUST_STEP_COUNT - 20, H.ROBUST_TITLES.length)
  return { seed: seeded.seed, steps: [...past('Control+z'), ...past('Control+y'), ...seeded.steps] }
}

/**
 * Delete until every column is empty, press more keys on the body, then add the emoji,
 * right-to-left and zero-width-joiner titles as submits. Returns an error text, or null when
 * the board was emptied. Focus goes to the first card of a column by position, because titles
 * may repeat in this session.
 */
async function drainBoard(page: Page): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    const r = await read(page)
    const first = COLS.find((c) => (r.titles[c] ?? []).length > 0)
    if (first === undefined) break
    if (!(await focusFirstCard(page, first))) return `cannot focus the first card of ${NAMES[first]}`
    await pressKey(page, 'Delete')
  }
  const left = await read(page)
  if (COLS.some((c) => (left.titles[c] ?? []).length > 0)) return 'Delete did not empty the board'
  for (const key of ['Delete', 'Control+z', 'Control+y', 'Shift+ArrowRight']) {
    await probe(page, S.BLUR, undefined, ACTION_MS)
    await pressKey(page, key)
  }
  for (const index of [2, 3, 4, 8]) {
    await act(page, { op: 'add', title: H.ROBUST_TITLES[index]! })
  }
  return null
}

const robustSession = defineCheck(
  'kanban-robust-session',
  9,
  'No uncaught exception or console.error in a scripted session of edge-case input, with storage available and with storage throwing.',
  async (ctx) => {
    const page = ctx.page
    const watch = errorWatch(page)
    try {
      await freshLoad(ctx)
      const plan = robustPlan()
      for (const step of plan.steps) await runRobustStep(page, step)
      const drained = await drainBoard(page)
      if (drained !== null) return bad(`routed run: ${drained}`)
      const routedBoard = titlesOf(await read(page))
      const onBoard = [...routedBoard.todo, ...routedBoard.doing, ...routedBoard.done]
      const tail = [H.ROBUST_TITLES[2]!, H.ROBUST_TITLES[3]!, H.ROBUST_TITLES[4]!]
      const missing = tail.find((t) => !onBoard.includes(t))
      if (missing !== undefined) return bad(`routed run: the add of ${JSON.stringify(missing)} did not land`)
      const inv1 = await invariants(page)
      if (inv1 !== null) return bad(`routed run: ${inv1}`)
      const routedAlerts = (await watch.alerts()).filter((text) => ENGINE_SHAPE.test(text))
      if (routedAlerts.length > 0) return bad(`routed run: engine error shown: ${clip(routedAlerts.join(' | '), 160)}`)

      await loadOpaque(ctx)
      const start = await read(page)
      const startDiff = boardDiff(titlesOf(start), FIRST_LOAD)
      if (startDiff !== null) return bad(`storage-throws start-up: ${startDiff}`)
      for (const step of H.OPAQUE_STEPS) {
        if (step.k === 'add') {
          const s = await act(page, { op: 'add', title: step.title })
          if (!s.act.ok) return bad(`storage-throws run: add of "${step.title}" did not run`)
        } else if (step.k === 'move') {
          if (!(await focusCardTitle(page, step.title))) return bad(`storage-throws run: cannot focus "${step.title}"`)
          await pressKey(page, step.dir === 1 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft')
        } else if (step.k === 'delete') {
          if (!(await focusCardTitle(page, step.title))) return bad(`storage-throws run: cannot focus "${step.title}"`)
          await pressKey(page, 'Delete')
        } else {
          const s = await act(page, { op: 'id', id: 'undo' })
          if (!s.act.ok || s.act.disabled) return bad('storage-throws run: undo did not run')
        }
      }
      const inv2 = await invariants(page)
      if (inv2 !== null) return bad(`storage-throws run: ${inv2}`)
      const end = await read(page)
      if (!COLS.some((c) => (end.titles[c] ?? []).includes('Opaque four'))) {
        return bad('storage-throws run: the last add ("Opaque four") is not on the board')
      }

      if (watch.pageErrors.length > 0) return bad(`page errors: ${clip(watch.pageErrors.join(' | '), 160)}`)
      if (watch.consoleErrors.length > 0) return bad(`console errors: ${clip(watch.consoleErrors.join(' | '), 160)}`)
      const opaqueAlerts = (await watch.alerts()).filter((text) => ENGINE_SHAPE.test(text))
      if (opaqueAlerts.length > 0) return bad(`storage-throws run: engine error shown: ${clip(opaqueAlerts.join(' | '), 160)}`)
      return ok(`${plan.steps.length} routed steps (seed ${plan.seed}) and 15 storage-throws steps with no errors`)
    } finally {
      watch.detach()
    }
  }
)

/** The ten checks, keyed by name, in the specification's order. */
export const checks = {
  [structure.checkName!]: structure,
  [addValidation.checkName!]: addValidation,
  [keyboardMoves.checkName!]: keyboardMoves,
  [focusManagement.checkName!]: focusManagement,
  [wipLimit.checkName!]: wipLimit,
  [undoRedo.checkName!]: undoRedo,
  [safeRendering.checkName!]: safeRendering,
  [persistence.checkName!]: persistence,
  [updateBudget.checkName!]: updateBudget,
  [robustSession.checkName!]: robustSession,
} as const

export const CHECK_LIST = Object.values(checks)
