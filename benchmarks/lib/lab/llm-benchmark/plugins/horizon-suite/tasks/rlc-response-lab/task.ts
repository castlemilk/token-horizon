import type { BenchmarkTask } from '../../../../types'

/** Check names in specification order. checks.test.ts asserts they match checks.ts. */
const CHECK_NAMES = [
  'rlc-metrics',
  'rlc-peak-overshoot',
  'rlc-response',
  'rlc-step-underdamped',
  'rlc-step-critical-overdamped',
  'rlc-bode-curve',
  'rlc-bode-autorange',
  'rlc-peak-resolved',
  'rlc-step-plot',
  'rlc-readouts',
]

/**
 * The prompt the model receives. Copied verbatim from the final prompt of the
 * Horizon suite specification (task-rlc-response-lab.json); checks.test.ts compares
 * the two whenever that file is present.
 */
const PROMPT = `Build a single-file HTML page, "RLC Response Lab", for a series RLC circuit driven by an ideal voltage source: a schematic, a Bode plot and a step-response plot that update live from R, L and C. A grading script sets hidden component values through the JavaScript API below and compares your numbers, and the curves you actually draw, with the exact analytic solution. Use closed-form solutions; results are compared to about 1e-6. Use every id, class, data attribute and function name exactly as written.

CIRCUIT
- An ideal source Vin in series with R (ohms), L (henries) and C (farads). The output is the voltage across one selected element: 'C', 'R' or 'L'.
- Frequency response: H(jw) = Vout/Vin in sinusoidal steady state, w = 2*pi*f.
- Step response: Vin steps from 0 to 1 V at t = 0 with the capacitor uncharged and no current flowing; vout(t) for t >= 0 (at t = 0 give the value just after the step).
- Definitions: f0 = 1/(2*pi*sqrt(L*C)); zeta = (R/2)*sqrt(C/L); Q = 1/(2*zeta); regime is 'underdamped' if zeta < 1 - 1e-9, 'overdamped' if zeta > 1 + 1e-9, otherwise 'critical'; bandwidthHz = R/(2*pi*L).

API (define window.__bench synchronously while the page loads)
- __bench.set({R, L, C, output}): set the component values (any positive numbers in SI units, from 1e-9 to 1e6) and the output element, then recompute and redraw EVERYTHING synchronously.
- __bench.metrics(): returns {f0, zeta, Q, regime, bandwidthHz, peakDb, overshootPct}. peakDb is the largest value of 20*log10|H| over all f > 0 for the SELECTED output, exact rather than a high-Q approximation (it is 0 when the gain never exceeds 1). overshootPct is the percentage by which the CAPACITOR step response exceeds 1 at its highest point (0 if it never does), whichever output is selected.
- __bench.response(f): returns {gainDb, phaseDeg} for the selected output at f hertz; gainDb = 20*log10|H|, phaseDeg = arg(H) in degrees in (-180, 180].
- __bench.stepAt(t): the selected output's unit-step response at t seconds. It must be finite and accurate to 1e-6 in every regime, including zeta exactly 1, zeta within 1e-7 of 1, and zeta as large as 100.

BODE PLOT: <svg id="bode">
- <rect id="bode-area"> is the plotting rectangle. The gain curve is one <polyline id="bode-gain"> drawn inside it.
- Frequency is logarithmic: the left edge of #bode-area is fmin, the right edge is fmax. Gain is linear in dB: the bottom edge is dbmin, the top edge is dbmax. Publish these on the svg element as data-fmin, data-fmax, data-dbmin, data-dbmax.
- Auto-range on every set(): fmin and fmax are exact powers of ten with fmin <= f0/30 and fmax >= 30*f0, spanning at most 6 decades; dbmin and dbmax are multiples of 10 chosen so the whole curve between fmin and fmax lies inside the rectangle and is never clipped.
- For every power of ten from fmin to fmax draw a vertical gridline <line class="decade" data-f="..."> at the matching x position, with a label.
- The polyline has at least 200 vertices in increasing frequency from fmin to fmax. Do not round vertex coordinates to whole pixels (keep at least 2 decimals). It must resolve a resonance: its highest vertex is within 0.3 dB of the true maximum of the curve even at Q = 100.
- Also draw the phase as <polyline id="bode-phase"> on its own scale or panel.

STEP PLOT: <svg id="step">
- <rect id="step-area"> and <polyline id="step-curve"> with at least 200 vertices in increasing time. Linear axes: the left edge is t = 0, the right edge is tmax, the bottom is vmin, the top is vmax; publish data-tmax, data-vmin, data-vmax on the svg.
- tmax = 10*tau, where tau = 2*L/R when zeta <= 1, and tau = 1/|s_slow| when zeta > 1 (s_slow is the characteristic root closer to zero). Choose vmin and vmax so the curve is never clipped.

READOUTS (HTML text)
- <span id="readout-f0"> and <span id="readout-bw">: engineering notation: a mantissa with exactly 4 significant digits in the range [1, 1000), one space, an SI prefix from p n µ m (none) k M G, then Hz. Examples: "159.2 mHz", "1.000 kHz", "47.00 Hz". Never "1000 Hz" and never "0.1592 Hz".
- <span id="readout-q"> and <span id="readout-zeta">: plain decimal numbers with exactly 4 significant digits, no exponent (for example "0.07071", "2.500", "100.0").
- <span id="readout-regime">: the regime word.

PAGE
- A drawn schematic of the series loop (source, R, L, C) with the selected output element highlighted; three logarithmic sliders #slider-r, #slider-l, #slider-c and an output selector #output that use the same code path as __bench.set and stay in sync with it.
- On load show R = 20 ohm, L = 10 mH, C = 1 uF with output C. Dark theme; both plots visible without scrolling at 1024 x 720.`

/**
 * The hygiene-only sandbox contract: lines 23 to 30 of SANDBOX_CONSTRAINTS in
 * prompts.ts (the eight-line header and hygiene rules), then the task's own
 * sentence. checks.test.ts verifies the eight lines against prompts.ts.
 */
const SANDBOX_HYGIENE_LINES = [
  'EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:',
  '- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.',
  '- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.',
  '- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.',
  '- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.',
  '- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.',
  '- No alert/confirm/prompt; render all feedback into the page itself.',
  '- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.',
]

const SANDBOX_TASK_SENTENCE =
  'Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.'

export const task: BenchmarkTask = {
  id: 'rlc-response-lab',
  slug: 'rlc-response-lab',
  category: 'advanced-electronics',
  title: 'RLC Response Lab: analytic Bode and step response at hidden values',
  blurb: 'A live series RLC circuit with Bode and step plots, checked against closed-form solutions at hidden component values.',
  prompt: PROMPT,
  runtimeHint: 'Browser, inline SVG and plain JavaScript; the grader drives window.__bench.set at hidden values',
  iterationsDefault: 3,
  methodNotes:
    '70% browser checks and 30% structural HTML. Ten checks (100 points) drive window.__bench.set through hidden circuits and compare metrics(), response() and stepAt() with closed forms, and read the drawn Bode and step polylines through their own screen transforms and the published data-* axes. Verified: f0, zeta, Q, bandwidth and the regime word including the 1e-9 band; exact resonant peak and overshoot; gain and phase of three outputs at and above resonance; underdamped, critical, near-critical and overdamped step responses; that the drawn gain curve lies on the analytic curve; decade auto-range with one gridline per decade; that the drawn resonance reaches the true peak at Q = 100; and the 4-digit readouts with prefix rollover. Not verified: the schematic drawing, slider and selector behaviour, the phase polyline, the dark theme and the 1024 x 720 layout.',
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: CHECK_NAMES,
  sandboxConstraints: [...SANDBOX_HYGIENE_LINES, SANDBOX_TASK_SENTENCE].join('\n'),
}

/** The prompt text, exported for the equality test and the forbidden-token test. */
export const rlcPrompt = PROMPT
