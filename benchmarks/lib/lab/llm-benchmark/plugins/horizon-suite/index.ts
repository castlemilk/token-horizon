/**
 * Horizon Suite: seven harder, deterministically graded tasks. Each task is a
 * self-contained directory under ./tasks/<id>/ (task.ts, checks.ts, fixtures.ts,
 * pose.ts, plus hidden.ts and reference.ts where the checks need them). See README.md.
 *
 * Roster order is the display order and matches the design brief. Every task's
 * checks sum to 100 points; the registry rejects any plugin check whose key is not
 * its declared name.
 */
import type { BenchmarkPlugin } from '../registry'
import type { BenchmarkTask } from '../../types'
import type { CheckFn } from '../../scorers/check-meta'
import { task as orbitLab } from './tasks/orbit-lab/task'
import { task as pathfindingLab } from './tasks/pathfinding-lab/task'
import { task as rlcResponseLab } from './tasks/rlc-response-lab/task'
import { task as bicycleBlueprint } from './tasks/bicycle-blueprint/task'
import { task as sectorClock } from './tasks/sector-clock/task'
import { task as kanbanKeyboardUndo } from './tasks/kanban-keyboard-undo/task'
import { task as seatPricing } from './tasks/seat-pricing/task'
import { checks as orbitChecks } from './tasks/orbit-lab/checks'
import { checks as pathfindingChecks } from './tasks/pathfinding-lab/checks'
import { checks as rlcChecks } from './tasks/rlc-response-lab/checks'
import { checks as bicycleChecks } from './tasks/bicycle-blueprint/checks'
import { checks as sectorChecks } from './tasks/sector-clock/checks'
import { checks as kanbanChecks } from './tasks/kanban-keyboard-undo/checks'
import { checks as seatChecks } from './tasks/seat-pricing/checks'
import { HorizonSuiteDemo } from './demo'

const TASKS: BenchmarkTask[] = [
  orbitLab,
  pathfindingLab,
  rlcResponseLab,
  bicycleBlueprint,
  sectorClock,
  kanbanKeyboardUndo,
  seatPricing,
]

/**
 * Merge every task's check map into one registry map. A duplicate check name is a
 * module-load error: two tasks sharing a name would silently overwrite each other's
 * scoring, so the failure is raised here, before anything is registered.
 */
function mergeChecks(maps: ReadonlyArray<readonly [string, Record<string, CheckFn>]>): Record<string, CheckFn> {
  const merged: Record<string, CheckFn> = {}
  const owner = new Map<string, string>()
  for (const [taskId, map] of maps) {
    for (const [name, fn] of Object.entries(map)) {
      const prior = owner.get(name)
      if (prior !== undefined) {
        throw new Error(`[horizon-suite] check '${name}' is defined by both '${prior}' and '${taskId}'`)
      }
      owner.set(name, taskId)
      merged[name] = fn
    }
  }
  return merged
}

export const horizonSuite: BenchmarkPlugin = {
  id: 'horizon-suite',
  name: 'Horizon Suite',
  version: '1.0.0',
  description: 'Seven harder tasks (physics, pathfinding, circuits, geometry, calendars, kanban, pricing) graded by 76 deterministic browser checks.',
  capabilities: ['tasks', 'checks', 'demos'],
  tasks: TASKS,
  checks: mergeChecks([
    ['orbit-lab', orbitChecks],
    ['pathfinding-lab', pathfindingChecks],
    ['rlc-response-lab', rlcChecks],
    ['bicycle-blueprint', bicycleChecks],
    ['sector-clock', sectorChecks],
    ['kanban-keyboard-undo', kanbanChecks],
    ['seat-pricing', seatChecks],
  ]),
  demos: { HorizonSuiteDemo },
}
