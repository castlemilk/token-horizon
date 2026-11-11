/**
 * In-page sources this task needs beyond the kit's own. Each is a plain
 * JavaScript source string (postmortem 0008: no TypeScript helpers may reach the
 * page). Every geometry read goes through the element's own getScreenCTM, the
 * same rule the kit's SVG_GEOM and LINE_SCREENS follow.
 *
 * Every measurement of a drawn value is ONE source that calls __bench.set and
 * reads the page in the same JavaScript turn. A page that redraws later (in a
 * timer or an animation frame) therefore shows its stale drawing, which the
 * check then rejects, instead of racing the check's own reads.
 */
import { LINE_SCREENS, SVG_GEOM } from '../../lib/sources'

/** All data-* attributes of the first element matching a selector, as strings. */
export const DATA_ATTRS_SOURCE = `(a) => {
  var el = document.querySelector(a.selector);
  if (!el) return null;
  var out = {};
  for (var i = 0; i < el.attributes.length; i++) {
    var at = el.attributes[i];
    if (at.name.indexOf('data-') === 0) out[at.name] = at.value;
  }
  return out;
}`

/** Text content of several elements by id, trimmed; null for a missing id. */
export const TEXT_BY_ID_SOURCE = `(ids) => ids.map(function (id) {
  var el = document.getElementById(id);
  return el ? el.textContent.trim() : null;
})`

/**
 * Set the circuit, then read the plot in the same turn: the svg's data-* axes,
 * the plot rectangle's corners (through its own CTM) and the polyline's vertices.
 * arg: { R, L, C, output, svg, area, line, lines } where lines is an optional
 * selector for the decade gridlines (null when not wanted).
 */
export const PLOT_SNAPSHOT_SOURCE = `(a) => {
  __bench.set({ R: a.R, L: a.L, C: a.C, output: a.output });
  var geom = (${SVG_GEOM});
  var lineScreens = (${LINE_SCREENS});
  return {
    attrs: (${DATA_ATTRS_SOURCE})({ selector: a.svg }),
    area: geom({ op: 'bboxCorners', selector: a.area }),
    line: geom({ op: 'polylineScreen', selector: a.line }),
    lines: a.lines ? lineScreens({ selector: a.lines }) : null
  };
}`

/** Set the circuit, then read text by id in the same turn. arg: { R, L, C, output, ids }. */
export const SET_THEN_TEXT_SOURCE = `(a) => {
  __bench.set({ R: a.R, L: a.L, C: a.C, output: a.output });
  return (${TEXT_BY_ID_SOURCE})(a.ids);
}`

/** Metrics after each circuit is set in order. */
export const METRICS_SWEEP_SOURCE = `(a) => a.cases.map(function (k) {
  __bench.set({ R: k.R, L: k.L, C: k.C, output: k.output });
  return __bench.metrics();
})`

/** Response samples for each case: an array of {gainDb, phaseDeg} per frequency. */
export const RESPONSE_SWEEP_SOURCE = `(a) => a.cases.map(function (k) {
  __bench.set({ R: k.R, L: k.L, C: k.C, output: k.output });
  return k.fs.map(function (f) { return __bench.response(f); });
})`

/** Step samples for each case: an array of numbers per time. */
export const STEP_SWEEP_SOURCE = `(a) => a.cases.map(function (k) {
  __bench.set({ R: k.R, L: k.L, C: k.C, output: k.output });
  return k.ts.map(function (t) { return __bench.stepAt(t); });
})`
