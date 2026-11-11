/**
 * The gallery pose for pathfinding-lab: drives the artifact to the public showcase scenario,
 * one fixed 20 x 32 map (the built-in demo) solved with A*. It uses only the prompt's public
 * contract and public inputs. No check reads it, and it uses no hidden input.
 */
import { DEMO_GOAL, DEMO_ROWS, DEMO_START } from './demo-map'

const SCENARIO = {
  rows: [...DEMO_ROWS],
  start: [DEMO_START[0], DEMO_START[1]],
  goal: [DEMO_GOAL[0], DEMO_GOAL[1]],
  diagonals: false,
}

/** A plain-JavaScript arrow function, evaluated in the page. Returns the solve result. */
export const pose: string =
  '() => { window.__bench.loadGrid(' +
  JSON.stringify(SCENARIO) +
  '); document.getElementById("algo").value = "astar"; return window.__bench.solve("astar"); }'
