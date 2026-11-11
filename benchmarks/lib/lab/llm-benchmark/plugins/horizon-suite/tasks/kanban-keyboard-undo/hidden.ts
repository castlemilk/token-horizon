/**
 * Every hidden constant the kanban-keyboard-undo checks use. Single source for the
 * checks and the fixtures; never imported by the prompt. Rotate HIDDEN_VERSION when
 * any value changes.
 *
 * The keyboard-moves script is GENERATED from a seed against the reference model
 * (reference.ts: generateKeyScript), not written out. The history script is written
 * out and validated against the model by reference.test.ts.
 */
// v2: history script adds a successful Shift+ArrowDown and Shift+ArrowRight, each undone and redone; the keyboard script is unchanged.
export const HIDDEN_VERSION = 'kanban-keyboard-undo/v2'

/** Five titles added in-page for the keyboard check, so To do holds eight cards. */
export const KEY_TITLES: readonly string[] = [
  'Audit log export',
  'Retry failed webhooks',
  'Trim onboarding copy',
  'Cache invalidation',
  'Footer typo fix',
]

/** Three titles added in-page for the focus check. */
export const FOCUS_TITLES: readonly string[] = ['Hidden one', 'Hidden two', 'Hidden three']

/** Seed for the keyboard-moves script. */
export const KEY_SEED = 7310
export const KEY_STEP_COUNT = 18

// ---------------------------------------------------------------------------
// History script: 35 steps from the first-load board with empty history.
// 28 are clicks, submits or history buttons. 7 are real keys (two successful
// Shift+arrow moves, two edge no-ops, Control+z and Control+y with a card focused,
// Control+z with #new-title focused).
// Cards are named by title, so the script does not depend on DOM order.
// ---------------------------------------------------------------------------

export type HistoryStep =
  | { k: 'add'; title: string }
  | { k: 'click'; action: 'move-left' | 'move-right' | 'delete'; title: string }
  | { k: 'undo' }
  | { k: 'redo' }
  | { k: 'undoAll' }
  | { k: 'redoAll' }
  | { k: 'key'; key: 'Shift+ArrowLeft' | 'Shift+ArrowRight' | 'Shift+ArrowDown'; title: string }
  | { k: 'key'; key: 'Control+z' | 'Control+y'; title: string }
  | { k: 'key'; key: 'Control+z'; inputText: string }

export const INPUT_DRAFT = 'Scratch'

/**
 * Thirty-five steps. Non-key steps (add, click, undo, redo, undoAll, redoAll) count 28; the
 * seven key steps are steps 4, 8, 10, 13, 20, 21 and 22 (the Shift+arrow moves in 10 and 13
 * are successful, and each is undone). undoAll and redoAll each count as one step and run the
 * matching button until it is disabled.
 */
export const HISTORY_SCRIPT: readonly HistoryStep[] = [
  { k: 'add', title: 'Ship the Q3 report' },
  { k: 'add', title: 'Draft press kit' },
  { k: 'click', action: 'move-right', title: 'Draft press kit' },
  { k: 'key', key: 'Shift+ArrowLeft', title: 'Draft release notes' },
  { k: 'undo' },
  { k: 'redo' },
  { k: 'click', action: 'move-right', title: 'Draft release notes' },
  { k: 'key', key: 'Shift+ArrowRight', title: 'Rotate API keys' },
  { k: 'undo' },
  { k: 'key', key: 'Shift+ArrowDown', title: 'Draft release notes' },
  { k: 'undo' },
  { k: 'redo' },
  { k: 'key', key: 'Shift+ArrowRight', title: 'Update pricing copy' },
  { k: 'undo' },
  { k: 'click', action: 'delete', title: 'Fix login redirect' },
  { k: 'click', action: 'move-left', title: 'Draft press kit' },
  { k: 'undo' },
  { k: 'undo' },
  { k: 'add', title: 'Refresh staging data' },
  { k: 'key', key: 'Control+z', title: 'Ship the Q3 report' },
  { k: 'key', key: 'Control+y', title: 'Ship the Q3 report' },
  { k: 'key', key: 'Control+z', inputText: INPUT_DRAFT },
  { k: 'click', action: 'move-right', title: 'Update pricing copy' },
  { k: 'click', action: 'delete', title: 'Refresh staging data' },
  { k: 'undoAll' },
  { k: 'redoAll' },
  { k: 'add', title: 'Write changelog' },
  { k: 'click', action: 'move-left', title: 'Update pricing copy' },
  { k: 'click', action: 'move-right', title: 'Update pricing copy' },
  { k: 'click', action: 'move-left', title: 'Draft press kit' },
  { k: 'undo' },
  { k: 'undo' },
  { k: 'redo' },
  { k: 'click', action: 'delete', title: 'Write changelog' },
  { k: 'undo' },
]

/** Seed and length for the robust-session generator. */
export const ROBUST_SEED = 20261110
export const ROBUST_STEP_COUNT = 60

/** Opaque-origin session: fifteen steps, add, move, delete and undo. */
export const OPAQUE_STEPS: readonly (
  | { k: 'add'; title: string }
  | { k: 'move'; title: string; dir: 1 | -1 }
  | { k: 'delete'; title: string }
  | { k: 'undo' }
)[] = [
  { k: 'add', title: 'Opaque one' },
  { k: 'add', title: 'Opaque two' },
  { k: 'move', title: 'Opaque one', dir: 1 },
  { k: 'move', title: 'Opaque two', dir: 1 },
  { k: 'delete', title: 'Opaque one' },
  { k: 'undo' },
  { k: 'move', title: 'Opaque one', dir: -1 },
  { k: 'add', title: 'Opaque three' },
  { k: 'delete', title: 'Opaque three' },
  { k: 'undo' },
  { k: 'undo' },
  { k: 'move', title: 'Draft release notes', dir: 1 },
  { k: 'undo' },
  { k: 'add', title: 'Opaque four' },
  { k: 'move', title: 'Opaque four', dir: 1 },
]

/** Hostile titles for the safe-rendering check. Each is a plain string. */
export const HOSTILE_TITLES: readonly string[] = [
  '<img src=x onerror="window.__kb=1">',
  '<b>bold</b> <i>it</i> &amp; "quoted"',
  '</li><script>window.__kb=2</script>',
]

/**
 * Stored values the persistence check writes over every key before reloading. The last
 * two parse as JSON and throw nowhere in a naive restore, so only a shape check gets them
 * right: a number is not a title, and Doing may hold no more than 3 cards.
 */
export const CORRUPT_VALUES: readonly string[] = [
  '{"todo":["a"',
  'null',
  '{"todo":"x","doing":[],"done":[]}',
  '[1,2,3]',
  '{"todo":[1,2],"doing":[],"done":[]}',
  '{"todo":[],"doing":["w","x","y","z"],"done":[]}',
]

/** The card added as the spare To do card for the WIP-limit retry (a hidden title). */
export const WIP_SPARE = 'Limit spare card'

/** The card added before the keyboard-shortcut phase of the history check. */
export const SHORTCUT_TITLE = 'Shortcut card'

/** Titles added by the persistence check before the reload, and the card added after recovery. */
export const PERSIST_TITLES: readonly string[] = ['Persist A', 'Persist B', 'Persist C']
export const RECOVERED_TITLE = 'Recovered card'

/** One hundred history levels: the specification's minimum. Added in one turn, undone in one turn. */
export const DEPTH_COUNT = 100
export function depthTitle(i: number): string {
  return 'Depth ' + String(i + 1).padStart(3, '0')
}

/** Titles for the update-budget bulk adds (95 cards on top of the 3 To do seeds). */
export function bulkTitle(i: number): string {
  return 'Bulk card ' + String(i + 1).padStart(3, '0')
}

/** Long unbroken title: 80 characters, no spaces. */
export const UNBROKEN_TITLE = 'ab'.repeat(40)

/** Titles the add-validation check uses. */
export const ADD_TITLES = {
  messy: '  Ship   the\tQ3  report ',
  messyNormalised: 'Ship the Q3 report',
  empty: '',
  spaces: '   ',
  tooLong: 'q'.repeat(81),
} as const

/** Robust-session title bank: emoji, right-to-left, zero-width joiner, 5000 characters, empties. */
export const ROBUST_TITLES: readonly string[] = [
  'Plan the offsite',
  '  spaced   out   title  ',
  'Emoji check \u{1F680} ship it',
  'مراجعة الميزانية',
  'zero‍width‍join',
  '',
  '   ',
  'x'.repeat(81),
  'y'.repeat(5000),
  'Normal card',
]

/** Per-action DOM budget on a 100-card board (the specification's 20-node ceiling). */
export const UPDATE_BUDGET_NODES = 20
export const BULK_ADDS = 95
export const BULK_CARD_COUNT = 100
export const TAGGED_CARDS = 10
