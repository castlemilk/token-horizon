/**
 * The gallery pose for sector-clock: the public showcase scenario, which for this
 * task is the on-load default (the prompt states it). It drives the artifact only
 * through its own hooks and uses no hidden input. No check reads this file.
 */
export const pose = `(function () {
  var b = window.__bench;
  if (!b) return false;
  var a = b.setInstant(1773453566000, 330);
  var s = b.setSector(540, 330);
  return a === true && s === true;
})`
