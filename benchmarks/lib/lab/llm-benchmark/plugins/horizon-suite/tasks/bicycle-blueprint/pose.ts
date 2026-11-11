/**
 * The public showcase scenario for the gallery: the load defaults named in the
 * prompt (wheelRadius 340 ... spokes 24) with the crank at 35 degrees. A plain
 * JavaScript source string, evaluated in the page through the test hooks only.
 * Pose inputs are public and are never used by a check.
 */
export const pose =
  '() => { var B = window.__bench; if (!B) return false; ' +
  'var a = B.setParams({ wheelRadius: 340, wheelbase: 1010, chainstay: 425, bbDrop: 65, seatTube: 540, seatAngle: 73, ' +
  'headAngle: 72, forkLength: 380, headTube: 140, chainringTeeth: 48, sprocketTeeth: 18, crankLength: 170, spokes: 24 }); ' +
  'var b = B.setCrank(35); return a === true && b === true; }'
