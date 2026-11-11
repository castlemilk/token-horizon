/**
 * Fixtures for sector-clock: one good artifact (the reference solution, written as
 * a careful human expert would), four good variants that draw or animate the same
 * clock differently, twenty-one broken variants and cheats each made by one small,
 * documented mutation of the good source, and a composite control that draws the
 * correct default view and does nothing else.
 *
 * The good source is a String.raw template: it must contain no backtick and no
 * dollar-brace sequence. Each mutation replaces a span that must occur exactly
 * once; replaceOnce asserts that the replacement actually changed the text.
 */

export const goodArtifact = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sector Clock</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0a0d13;
  --glow: #172033;
  --panel: #111723;
  --panel-line: #222b3c;
  --ink: #e9ecf3;
  --muted: #8b95aa;
  --face: #161c28;
  --rim: #2d3648;
  --tick: #6e7a92;
  --tick-major: #dfe4ee;
  --numeral: #cfd6e4;
  --hand: #f4f0e6;
  --second: #ef4444;
  --hand24: #7dd3fc;
  --subdial: #0e131e;
  --amber: #f59e0b;
}
html, body { margin: 0; min-height: 100%; }
body {
  background: radial-gradient(ellipse at 50% 35%, var(--glow) 0%, var(--bg) 72%);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main {
  box-sizing: border-box;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 14px 16px;
}
#clock {
  display: block;
  width: min(88vw, 58vh, 520px);
  height: auto;
  overflow: visible;
}
#dial { fill: var(--face); stroke: var(--rim); stroke-width: 2; }
#subdial { fill: var(--subdial); stroke: var(--rim); stroke-width: 1; }
.tick { stroke: var(--tick); stroke-width: 1.2; }
.tick.major { stroke: var(--tick-major); stroke-width: 2.2; }
.numeral {
  fill: var(--numeral);
  font-size: 13px;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: central;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
#hand-24h { stroke: var(--hand24); stroke-width: 1.3; }
#sector { fill: var(--amber); stroke: none; }
#hand-hour { stroke: var(--hand); stroke-width: 4.4; }
#hand-minute { stroke: var(--hand); stroke-width: 3.2; }
#hand-second { stroke: var(--second); stroke-width: 1.6; }
.readouts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  width: min(92vw, 560px);
  margin: 0;
}
.cell {
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--panel-line);
  border-radius: 10px;
  padding: 8px;
  text-align: center;
}
.k {
  display: block;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
.v {
  display: block;
  margin-top: 4px;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#digital { font-size: 17px; }
#fault {
  margin: 0;
  color: #fecaca;
  background: #3b0d0d;
  border: 1px solid #7f1d1d;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
@media (max-width: 480px) {
  .readouts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
</head>
<body>
<main>
  <svg id="clock" viewBox="-112 -112 224 224" role="img" aria-labelledby="clock-title">
    <title id="clock-title">Analog clock with a 24-hour sub-dial and a sector band</title>
    <circle id="dial" cx="0" cy="0" r="100"/>
    <g id="ticks"></g>
    <g id="numerals"></g>
    <circle id="subdial" cx="0" cy="29" r="12"/>
    <line id="hand-24h" x1="0" y1="29" x2="0" y2="19.4"/>
    <path id="sector" d=""/>
    <line id="hand-hour" x1="0" y1="0" x2="0" y2="-47"/>
    <line id="hand-minute" x1="0" y1="0" x2="0" y2="-70"/>
    <line id="hand-second" x1="0" y1="0" x2="0" y2="-72"/>
  </svg>
  <section class="readouts" aria-label="Clock readouts">
    <div class="cell"><span class="k">Local time</span><span id="digital" class="v">07:29:26</span></div>
    <div class="cell"><span class="k">Date</span><span id="date-window" class="v">Sat 14</span></div>
    <div class="cell"><span class="k">Offset</span><span id="offset-label" class="v">UTC+05:30</span></div>
    <div class="cell"><span class="k">ISO week</span><span id="week-label" class="v">2026-W11</span></div>
  </section>
  <p id="fault" role="alert" hidden></p>
</main>
<script>
(function () {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var RAD = Math.PI / 180;
  var R_IN = 78, R_OUT = 88;
  var NUM_R = 61.5;
  var UTC_LO = -2208988800000, UTC_HI = 4133980799999;
  var WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + String(n); }
  function floorDiv(a, b) { return Math.floor(a / b); }
  function isInt(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi;
  }
  /* Clockwise from 12 o'clock on screen: x grows right, y grows down. */
  function polar(deg, dist) {
    var t = deg * RAD;
    return [dist * Math.sin(t), -dist * Math.cos(t)];
  }

  /* Integer calendar: days from 1970-01-01 and back, proleptic Gregorian. */
  function civilFromDays(z) {
    var s = z + 719468;
    var era = floorDiv(s, 146097);
    var doe = s - era * 146097;
    var yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
    var doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
    var mp = floorDiv(5 * doy + 2, 153);
    var d = doy - floorDiv(153 * mp + 2, 5) + 1;
    var m = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
  }
  function daysFromCivil(y, m, d) {
    var yy = m <= 2 ? y - 1 : y;
    var era = floorDiv(yy, 400);
    var yoe = yy - era * 400;
    var doy = floorDiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
    var doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
  }
  /* Monday = 0 .. Sunday = 6. Day 0 (1970-01-01) is a Thursday. */
  function weekdayIndex(day) { return ((day + 3) % 7 + 7) % 7; }

  /* Local hour, minute, second and date fields of an instant, flooring milliseconds. */
  function fieldsOf(utcMs, off) {
    /*@fields*/
    var secs = floorDiv(utcMs, 1000) + off * 60;
    var day = floorDiv(secs, 86400);
    var sod = secs - day * 86400;
    var dateDay = day;
    var thu = day - weekdayIndex(day) + 3;
    var wy = civilFromDays(thu)[0];
    var week = floorDiv(thu - daysFromCivil(wy, 1, 1), 7) + 1;
    return { H: floorDiv(sod, 3600), M: floorDiv(sod % 3600, 60), S: sod % 60, dateDay: dateDay, wy: wy, week: week };
    /*@/fields*/
  }

  /* Move a hand from (x0, y0) by len along the clockwise angle deg. */
  function place(el, x0, y0, deg, len) {
    var t = deg * RAD;
    el.setAttribute('x1', x0);
    el.setAttribute('y1', y0);
    el.setAttribute('x2', x0 + len * Math.sin(t));
    el.setAttribute('y2', y0 - len * Math.cos(t));
  }

  function setInstant(utcMs, off) {
    if (!isInt(utcMs, UTC_LO, UTC_HI) || !isInt(off, -720, 840)) return false;
    var f = fieldsOf(utcMs, off);
    var abs = Math.abs(off);
    $('digital').textContent = pad2(f.H) + ':' + pad2(f.M) + ':' + pad2(f.S);
    $('date-window').textContent = WEEKDAY[weekdayIndex(f.dateDay)] + ' ' + civilFromDays(f.dateDay)[2];
    $('offset-label').textContent = 'UTC' + (off < 0 ? '-' : '+') + pad2(floorDiv(abs, 60)) + ':' + pad2(abs % 60);
    $('week-label').textContent = f.wy + '-W' + pad2(f.week);
    var hourDeg = ((f.H % 12) + f.M / 60 + f.S / 3600) * 30;
    var minDeg = (f.M + f.S / 60) * 6;
    var secDeg = f.S * 6;
    var h24Deg = (f.H + f.M / 60 + f.S / 3600) * 15;
    /*@hands*/
    place($('hand-hour'), 0, 0, hourDeg, 47);
    place($('hand-minute'), 0, 0, minDeg, 70);
    place($('hand-second'), 0, 0, secDeg, 72);
    /*@/hands*/
    place($('hand-24h'), 0, 29, h24Deg, 9.6);
    return true;
  }

  /* The ring segment from start to end minutes after 12:00, clockwise. */
  function setSector(a, b) {
    if (!isInt(a, 0, 719) || !isInt(b, 0, 719)) return false;
    var path = $('sector');
    var minutes = ((b - a) % 720 + 720) % 720;
    if (minutes === 0) {
      path.setAttribute('d', '');
      return true;
    }
    var large = minutes > 360 ? 1 : 0;
    var t0 = a * 0.5, t1 = b * 0.5;
    var o0 = polar(t0, R_OUT), o1 = polar(t1, R_OUT);
    var i1 = polar(t1, R_IN), i0 = polar(t0, R_IN);
    path.setAttribute('d',
      'M' + o0[0] + ' ' + o0[1] +
      ' A' + R_OUT + ' ' + R_OUT + ' 0 ' + large + ' 1 ' + o1[0] + ' ' + o1[1] +
      ' L' + i1[0] + ' ' + i1[1] +
      ' A' + R_IN + ' ' + R_IN + ' 0 ' + large + ' 0 ' + i0[0] + ' ' + i0[1] + ' Z');
    return true;
  }

  /* Sixty ticks (every twelfth is a longer major) and twelve upright numerals. */
  function buildFace() {
    var ticks = $('ticks');
    var numerals = $('numerals');
    for (var k = 0; k < 60; k++) {
      var major = k % 5 === 0;
      var p = polar(k * 6, major ? 90 : 95);
      var q = polar(k * 6, 100);
      var line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('class', major ? 'tick major' : 'tick');
      line.setAttribute('x1', p[0]);
      line.setAttribute('y1', p[1]);
      line.setAttribute('x2', q[0]);
      line.setAttribute('y2', q[1]);
      ticks.appendChild(line);
    }
    for (var n = 1; n <= 12; n++) {
      var c = polar(n * 30, NUM_R);
      var t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'numeral');
      t.setAttribute('x', c[0]);
      t.setAttribute('y', c[1]);
      t.textContent = String(n);
      numerals.appendChild(t);
    }
  }

  try {
    buildFace();
    setSector(540, 330);
    setInstant(1773453566000, 330);
    window.__bench = { setInstant: setInstant, setSector: setSector };
  } catch (err) {
    var fault = $('fault');
    fault.hidden = false;
    fault.textContent = 'Start-up error: ' + (err && err.message ? err.message : String(err));
  }
})();
</script>
</body>
</html>
`

/**
 * Replace one span of the source. The span must occur exactly once, and the
 * replacement must change the text; otherwise the mutation is a bug in this file.
 */
export function replaceOnce(source: string, from: string, to: string, label: string): string {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`mutation ${label}: expected exactly one match, found ${count}`)
  const out = source.replace(from, () => to)
  if (out === source) throw new Error(`mutation ${label}: replacement left the text unchanged`)
  return out
}

/** Replace the text between two markers (inclusive of neither), exactly once. */
export function replaceRegion(source: string, open: string, close: string, body: string, label: string): string {
  const start = source.indexOf(open)
  const end = source.indexOf(close)
  if (start < 0 || end < 0 || source.indexOf(open, start + 1) >= 0 || source.indexOf(close, end + 1) >= 0) {
    throw new Error(`mutation ${label}: markers ${open} and ${close} must each occur once`)
  }
  const out = source.slice(0, start + open.length) + '\n' + body + '\n    ' + source.slice(end)
  if (out === source) throw new Error(`mutation ${label}: replacement left the text unchanged`)
  return out
}

const MUTATION = {
  paintOrder: (s: string): string => {
    const second = '    <line id="hand-second" x1="0" y1="0" x2="0" y2="-72"/>\n'
    const hour = '    <line id="hand-hour" x1="0" y1="0" x2="0" y2="-47"/>\n'
    const without = replaceOnce(s, second, '', 'paint-order:remove-second')
    return replaceOnce(without, hour, second + hour, 'paint-order:insert-second-first')
  },
  numeralsFromThree: (s: string): string =>
    replaceOnce(
      s,
      'var c = polar(n * 30, NUM_R);',
      'var c = [NUM_R * Math.cos(n * 30 * RAD), NUM_R * Math.sin(n * 30 * RAD)];',
      'numerals-from-three'
    ),
  minuteSteps: (s: string): string =>
    replaceOnce(s, 'var minDeg = (f.M + f.S / 60) * 6;', 'var minDeg = f.M * 6;', 'minute-steps'),
  hourNoAdvance: (s: string): string =>
    replaceOnce(
      s,
      'var hourDeg = ((f.H % 12) + f.M / 60 + f.S / 3600) * 30;',
      'var hourDeg = (f.H % 12) * 30;',
      'hour-no-advance'
    ),
  negativeOffsetWrap: (s: string): string =>
    replaceOnce(
      s,
      'var sod = secs - day * 86400;',
      'var sod = ((floorDiv(utcMs, 1000) - floorDiv(floorDiv(utcMs, 1000), 86400) * 86400) + off * 60) % 86400;',
      'negative-offset-wrap'
    ),
  dateIgnoresOffset: (s: string): string =>
    replaceOnce(s, 'var dateDay = day;', 'var dateDay = floorDiv(floorDiv(utcMs, 1000), 86400);', 'date-ignores-offset'),
  naiveWeek: (s: string): string =>
    replaceOnce(
      s,
      'var wy = civilFromDays(thu)[0];\n    var week = floorDiv(thu - daysFromCivil(wy, 1, 1), 7) + 1;',
      'var wy = civilFromDays(day)[0];\n    var week = Math.ceil((day - daysFromCivil(wy, 1, 1) + 1) / 7);',
      'naive-week'
    ),
  rate24h: (s: string): string =>
    replaceOnce(
      s,
      'var h24Deg = (f.H + f.M / 60 + f.S / 3600) * 15;',
      'var h24Deg = ((f.H % 12) + f.M / 60 + f.S / 3600) * 30;',
      '24h-rate'
    ),
  wideBand: (s: string): string =>
    replaceOnce(s, 'var R_IN = 78, R_OUT = 88;', 'var R_IN = 70, R_OUT = 95;', 'wide-band'),
  largeArcFlag: (s: string): string =>
    replaceOnce(s, 'var large = minutes > 360 ? 1 : 0;', 'var large = 0;', 'large-arc-flag'),
  roundSeconds: (s: string): string =>
    replaceOnce(
      s,
      'var secs = floorDiv(utcMs, 1000) + off * 60;',
      'var secs = Math.round(utcMs / 1000) + off * 60;',
      'round-seconds'
    ),
  localGetters: (s: string): string =>
    replaceRegion(
      s,
      '/*@fields*/',
      '/*@/fields*/',
      [
        '    var d = new Date(utcMs + off * 60000);',
        '    var dateDay = daysFromCivil(d.getFullYear(), d.getMonth() + 1, d.getDate());',
        '    var thu = dateDay - weekdayIndex(dateDay) + 3;',
        '    var wy = civilFromDays(thu)[0];',
        '    var week = floorDiv(thu - daysFromCivil(wy, 1, 1), 7) + 1;',
        '    return { H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), dateDay: dateDay, wy: wy, week: week };',
      ].join('\n'),
      'local-getters'
    ),
  cssTransition: (s: string): string =>
    replaceRegion(
      s,
      '/*@hands*/',
      '/*@/hands*/',
      [
        "    [['hand-hour', hourDeg], ['hand-minute', minDeg], ['hand-second', secDeg]].forEach(function (pair) {",
        '      var el = $(pair[0]);',
        "      el.style.transition = 'transform .4s ease';",
        "      el.style.transform = 'rotate(' + pair[1] + 'deg)';",
        '    });',
      ].join('\n'),
      'css-transition'
    ),
  missingWeekLabel: (s: string): string => {
    const removed = replaceOnce(s, '<span id="week-label" class="v">2026-W11</span>', '', 'missing-week-label:remove')
    return replaceOnce(
      removed,
      "$('week-label').textContent = f.wy + '-W' + pad2(f.week);",
      "if ($('week-label')) $('week-label').textContent = f.wy + '-W' + pad2(f.week);",
      'missing-week-label:guard'
    )
  },
  missingSubdial: (s: string): string => {
    const block = '    <circle id="subdial" cx="0" cy="29" r="12"/>\n    <line id="hand-24h" x1="0" y1="29" x2="0" y2="19.4"/>\n'
    const removed = replaceOnce(s, block, '', 'missing-subdial:remove')
    return replaceOnce(
      removed,
      "place($('hand-24h'), 0, 29, h24Deg, 9.6);",
      "if ($('hand-24h')) place($('hand-24h'), 0, 29, h24Deg, 9.6);",
      'missing-subdial:guard'
    )
  },
  zeroLengthHour: (s: string): string =>
    replaceOnce(s, "place($('hand-hour'), 0, 0, hourDeg, 47);", "place($('hand-hour'), 0, 0, hourDeg, 0);", 'zero-length-hour'),
  readoutsHidden: (s: string): string =>
    replaceOnce(s, '.readouts {\n  display: grid;', '.readouts {\n  display: none;', 'readouts-hidden'),
  deferredTimeout: (s: string): string =>
    replaceOnce(
      s,
      'window.__bench = { setInstant: setInstant, setSector: setSector };',
      'window.__bench = { setInstant: function (u, o) { if (!isInt(u, UTC_LO, UTC_HI) || !isInt(o, -720, 840)) return false; setTimeout(function () { setInstant(u, o); }, 0); return true; }, setSector: setSector };',
      'deferred-timeout'
    ),
  deferredMicrotask: (s: string): string =>
    replaceOnce(
      s,
      'window.__bench = { setInstant: setInstant, setSector: setSector };',
      'window.__bench = { setInstant: function (u, o) { if (!isInt(u, UTC_LO, UTC_HI) || !isInt(o, -720, 840)) return false; Promise.resolve().then(function () { setInstant(u, o); }); return true; }, setSector: setSector };',
      'deferred-microtask'
    ),
  ghostPaint: (s: string): string =>
    replaceOnce(
      s,
      '@media (max-width: 480px) {',
      '#clock line { stroke: none !important; }\n#sector { fill: none !important; }\n@media (max-width: 480px) {',
      'ghost-paint'
    ),
  ghostSector: (s: string): string => {
    const withElement = replaceOnce(
      s,
      '<path id="sector" d=""/>',
      '<path id="sector" d=""/>\n    <path id="ghost-sector" fill="#f59e0b" stroke="none" d=""/>',
      'ghost-sector:element'
    )
    return replaceOnce(withElement, "var path = $('sector');", "var path = $('ghost-sector');", 'ghost-sector:draw')
  },
  staticHooks: (s: string): string =>
    replaceOnce(
      s,
      'window.__bench = { setInstant: setInstant, setSector: setSector };',
      'window.__bench = { setInstant: function () { return true; }, setSector: function () { return true; } };',
      'static-hooks'
    ),
}

/** Good variants: each edit is a legitimate way to draw or animate the same clock. */
const VARIANT = {
  introOpacity: (s: string): string =>
    replaceOnce(
      s,
      '@media (max-width: 480px) {',
      'main { opacity: 0; animation: intro .5s ease-out forwards; }\n@keyframes intro { to { opacity: 1; } }\n@media (max-width: 480px) {',
      'intro-opacity'
    ),
  introRise: (s: string): string =>
    replaceOnce(
      s,
      '@media (max-width: 480px) {',
      'main { opacity: 0; transform: translateY(24px); animation: rise .5s ease-out forwards; }\n@keyframes rise { to { opacity: 1; transform: none; } }\n@media (max-width: 480px) {',
      'intro-rise'
    ),
  svgIntro: (s: string): string =>
    replaceOnce(
      s,
      '@media (max-width: 480px) {',
      '#clock { animation: svg-in .4s ease-out both; }\n@keyframes svg-in { from { opacity: 0; } to { opacity: 1; } }\n@media (max-width: 480px) {',
      'svg-intro'
    ),
  decorativePulse: (s: string): string => {
    const withDot = replaceOnce(s, '<g id="numerals"></g>', '<g id="numerals"></g>\n    <circle id="pulse" cx="-40" cy="-40" r="1.6" fill="#e5e7eb"/>', 'pulse:element')
    return replaceOnce(
      withDot,
      '@media (max-width: 480px) {',
      '#pulse { animation: pulse 1.2s ease-in-out infinite; }\n@keyframes pulse { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }\n@media (max-width: 480px) {',
      'pulse:css'
    )
  },
}

/**
 * Good artifacts that differ from the reference in how they draw or animate, and must
 * still score 100: a finished entrance on <main> (opacity, then transform), a finished
 * fade on the clock itself, and a decorative pulse inside the clock that nothing changes.
 */
export const goodVariants: Record<string, string> = {
  'clock-good-intro-opacity': VARIANT.introOpacity(goodArtifact),
  'clock-good-intro-rise': VARIANT.introRise(goodArtifact),
  'clock-good-svg-intro': VARIANT.svgIntro(goodArtifact),
  'clock-good-decorative-pulse': VARIANT.decorativePulse(goodArtifact),
}

export const brokenArtifacts: Record<string, string> = {
  'clock-broken-paint-order': MUTATION.paintOrder(goodArtifact),
  'clock-broken-numerals-from-three': MUTATION.numeralsFromThree(goodArtifact),
  'clock-broken-minute-steps': MUTATION.minuteSteps(goodArtifact),
  'clock-broken-hour-no-advance': MUTATION.hourNoAdvance(goodArtifact),
  'clock-broken-negative-offset-wrap': MUTATION.negativeOffsetWrap(goodArtifact),
  'clock-broken-date-ignores-offset': MUTATION.dateIgnoresOffset(goodArtifact),
  'clock-broken-naive-week': MUTATION.naiveWeek(goodArtifact),
  'clock-broken-24h-rate': MUTATION.rate24h(goodArtifact),
  'clock-broken-wide-band': MUTATION.wideBand(goodArtifact),
  'clock-broken-large-arc-flag': MUTATION.largeArcFlag(goodArtifact),
  'clock-broken-round-seconds': MUTATION.roundSeconds(goodArtifact),
  'clock-broken-local-getters': MUTATION.localGetters(goodArtifact),
  'clock-broken-css-transition': MUTATION.cssTransition(goodArtifact),
  'clock-broken-missing-week-label': MUTATION.missingWeekLabel(goodArtifact),
  'clock-broken-missing-subdial': MUTATION.missingSubdial(goodArtifact),
  'clock-broken-zero-length-hour': MUTATION.zeroLengthHour(goodArtifact),
  'clock-broken-readouts-hidden': MUTATION.readoutsHidden(goodArtifact),
  'clock-broken-deferred-timeout': MUTATION.deferredTimeout(goodArtifact),
  'clock-broken-deferred-microtask': MUTATION.deferredMicrotask(goodArtifact),
  'clock-cheat-ghost-paint': MUTATION.ghostPaint(goodArtifact),
  'clock-cheat-sector-elsewhere': MUTATION.ghostSector(goodArtifact),
}

/**
 * A composite control: the correct static picture of the default view, with hooks
 * that return true and change nothing.
 */
export const staticPicture = MUTATION.staticHooks(goodArtifact)

export const ALL_CHECK_NAMES = [
  'clock-structure',
  'clock-ticks-numerals',
  'clock-minute-second',
  'clock-hour-hand',
  'clock-offset-time',
  'clock-date-window',
  'clock-iso-week',
  'clock-subdial-24h',
  'clock-sector-band',
  'clock-sector-arcs',
  'clock-edge-instants',
  'clock-host-timezone',
  'clock-sync-validation',
] as const

/**
 * The checks a page fails when setInstant draws after it returns: the nine that read the call's result in the same
 * turn, and clock-structure, whose paint proof samples the hand endpoints read in that turn (the hands are not
 * painted there when the screenshot is taken).
 */
const DEFERRED_DRAW = [
  'clock-structure',
  'clock-minute-second',
  'clock-hour-hand',
  'clock-offset-time',
  'clock-date-window',
  'clock-iso-week',
  'clock-subdial-24h',
  'clock-edge-instants',
  'clock-host-timezone',
  'clock-sync-validation',
]

/**
 * The checks each fixture must fail, as the specification states them. Where the
 * matrix shows more failing checks than the specification names, the test reports
 * it; the expectation is not loosened to match.
 */
export const expectations: Record<string, 'good' | readonly string[]> = {
  'clock-good': 'good',
  ...Object.fromEntries(Object.keys(goodVariants).map((name) => [name, 'good' as const])),
  'clock-broken-paint-order': ['clock-structure'],
  'clock-broken-numerals-from-three': ['clock-ticks-numerals'],
  'clock-broken-minute-steps': ['clock-minute-second'],
  'clock-broken-hour-no-advance': ['clock-hour-hand'],
  'clock-broken-negative-offset-wrap': ['clock-offset-time', 'clock-host-timezone'],
  'clock-broken-date-ignores-offset': ['clock-date-window', 'clock-host-timezone'],
  'clock-broken-naive-week': ['clock-iso-week', 'clock-host-timezone'],
  'clock-broken-24h-rate': ['clock-subdial-24h'],
  'clock-broken-wide-band': ['clock-sector-band'],
  'clock-broken-large-arc-flag': ['clock-sector-arcs'],
  'clock-broken-round-seconds': ['clock-edge-instants'],
  'clock-broken-local-getters': ['clock-host-timezone'],
  'clock-broken-css-transition': ['clock-sync-validation'],
  'clock-broken-missing-week-label': ['clock-structure', 'clock-iso-week', 'clock-host-timezone', 'clock-sync-validation'],
  'clock-broken-missing-subdial': ['clock-structure', 'clock-subdial-24h', 'clock-sync-validation'],
  'clock-broken-zero-length-hour': ['clock-structure', 'clock-hour-hand', 'clock-offset-time', 'clock-host-timezone'],
  'clock-broken-readouts-hidden': ['clock-structure'],
  'clock-broken-deferred-timeout': DEFERRED_DRAW,
  'clock-broken-deferred-microtask': DEFERRED_DRAW,
  'clock-cheat-ghost-paint': ['clock-structure', 'clock-ticks-numerals', 'clock-sector-band', 'clock-sector-arcs'],
  'clock-cheat-sector-elsewhere': ['clock-sector-band'],
  'clock-control-static-picture': ALL_CHECK_NAMES.filter((n) => n !== 'clock-ticks-numerals' && n !== 'clock-structure'),
}
