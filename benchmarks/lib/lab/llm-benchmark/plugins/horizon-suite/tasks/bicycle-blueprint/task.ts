/**
 * The bicycle-blueprint task row. The prompt is the specification's final_prompt,
 * copied verbatim (a test compares it with the JSON file when that file exists).
 * Hidden constants live in hidden.ts and are never written here.
 */
import type { BenchmarkTask } from '../../../../types'

const PROMPT = `Build one self-contained HTML page that draws a parametric side-elevation blueprint of a bicycle as inline SVG, with a small readout panel. The bicycle faces right. A script grades it by setting hidden frame dimensions and crank angles through test hooks, then measuring the drawn geometry on screen (joints, radii, tangency, angles) and comparing the readouts with exact values, so every element must be computed from the parameters, not sketched by eye. Use every id, class and data attribute exactly as written. Do not round coordinates, radii or angles to fewer than 2 decimal places.

COORDINATES. Describe the bicycle in millimetres in a frame with its origin at the rear hub, x to the right (towards the front wheel) and y up. Map it to the SVG with one uniform scale, fitted so the complete drawing is visible for any valid parameters.

PARAMETERS (keys of the object passed to setParams; all required; numbers)
wheelRadius R 250-380; wheelbase W 700-1200; chainstay C 380-460; bbDrop D 30-80; seatTube S 420-620; seatAngle A 68-78 degrees; headAngle Hd 66-76 degrees; forkLength F 340-420; headTube T 90-200; chainringTeeth Nf integer 26-56; sprocketTeeth Nr integer 11-36; crankLength L 160-180; spokes N even integer 12-36.
Also required: W >= 2R + 20 and F >= R + 15.

GEOMETRY (angles in degrees)
- Rear hub (0, 0). Front hub (W, 0). Ground: the line y = -R.
- Bottom bracket BB: at distance C from the rear hub, D below the hub line, ahead of the rear hub: (sqrt(C^2 - D^2), -D).
- Seat cluster SC = BB + S * (-cos A, sin A).
- Fork crown FC = front hub + F * (-cos Hd, sin Hd). Head top HT = FC + T * (-cos Hd, sin Hd).
- Chainring pitch radius rf = Nf * 12.7 / (2*pi), centred on BB. Sprocket pitch radius rr = Nr * 12.7 / (2*pi), centred on the rear hub.
- The crank angle theta is measured clockwise from straight up as seen on screen. Right crank end = BB + L * (sin theta, cos theta). Left crank end = BB - L * (sin theta, cos theta).
- Wheel rotation phi = theta * Nf / Nr. Both wheels turn clockwise by phi. theta may exceed 360.

ELEMENTS, all inside <svg id="bike">
- <circle id="wheel-rear"> and <circle id="wheel-front">: radius R, centred on the hubs. <line id="ground">: horizontal, touching both wheels from below and reaching at least from under the rear hub to under the front hub.
- Frame tubes, one <line> each, whose two ends are exactly the named points: #chain-stay (rear hub to BB), #seat-stay (rear hub to SC), #seat-tube (BB to SC), #top-tube (SC to HT), #down-tube (BB to FC), #head-tube (FC to HT), #fork (FC to front hub).
- <circle id="chainring">: radius rf at BB. <circle id="sprocket">: radius rr at the rear hub.
- <line id="chain-upper"> and <line id="chain-lower">: the two straight chain runs. They are the two external common tangents of the chainring and sprocket circles: each end lies on its circle at the point of tangency, and the run touches both circles without cutting through either. Upper is above the line of centres, lower is below it.
- <line id="crank-right"> from BB to the right crank end and <line id="crank-left"> from BB to the left crank end. Two <rect class="pedal">, each centred on a crank end, wider than tall and always horizontal (they do not rotate with the crank).
- For each wheel, exactly N <line class="spoke" data-wheel="rear"> or data-wheel="front", from the hub centre to the rim (length R), spoke k at angle phi + k*360/N clockwise from straight up. One <circle class="valve" data-wheel="rear"> and one data-wheel="front", centred on the rim at angle phi clockwise from straight up.
- #saddle: any shape sitting directly above the seat cluster: entirely above SC, its lowest point within 120 mm of SC, its horizontal centre within 80 mm of SC. #handlebar: any shape whose centre is within 150 mm of HT and not below FC.
- Every element named above is visibly painted: a stroke at least 1.5 px wide on screen or a solid fill, fully opaque, in a colour that differs from what lies behind it by more than 80 in at least one RGB channel. Decoration (tyres, dimension lines, labels, grid) is welcome around the named elements but never on top of them.

READOUTS (text content: a number only, formatted as stated)
- #out-ratio: Nf / Nr with 2 decimals.
- #out-development: metres travelled per crank revolution = 2*pi*R*Nf/Nr / 1000, with 2 decimals.
- #out-chain: length in mm of the closed chain loop formed by the two tangent runs plus the arcs the chain wraps on the chainring and on the sprocket, with 1 decimal.
- #out-links: the smallest even integer n with n * 12.7 >= that loop length.
- #out-distance: metres travelled for the current crank angle = R * phi / 1000 with phi in radians, with 3 decimals.

TEST HOOKS on window.__bench
- setParams(p): validate, redraw everything and update the readouts for the current crank angle; return true.
- setCrank(thetaDegrees): any finite number >= 0. Redraw cranks, pedals, spokes and valves and update #out-distance; return true.
- Both are synchronous, with no transitions or animation. Invalid input (a missing key, a non-finite or out-of-range value, non-integer teeth or spokes, an odd spoke count, W < 2R + 20, F < R + 15, a negative or non-finite theta) returns false without throwing and leaves the drawing and readouts unchanged.

ON LOAD draw setParams({wheelRadius:340, wheelbase:1010, chainstay:425, bbDrop:65, seatTube:540, seatAngle:73, headAngle:72, forkLength:380, headTube:140, chainringTeeth:48, sprocketTeeth:18, crankLength:170, spokes:24}) followed by setCrank(35).

LAYOUT. The whole bicycle is visible without scrolling at 1024x720 and measures at least 560 px on screen from the rear edge of the rear wheel to the front edge of the front wheel, for any valid parameters, with the readouts not covering it. Style it as an engineering blueprint of your own design.`

/** The eight hygiene lines of SANDBOX_CONSTRAINTS (prompts.ts), then the suite's sentence. */
const SANDBOX = `EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:
- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.
- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.
- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.
- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.
- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.
- No alert/confirm/prompt; render all feedback into the page itself.
- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.
Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.`

export const CHECK_NAMES = [
  'bike-wheels-ground',
  'bike-frame-joints',
  'bike-drivetrain-circles',
  'bike-chain-tangent',
  'bike-crank-pedals',
  'bike-spokes',
  'bike-wheel-rotation',
  'bike-readouts',
  'bike-saddle-bars',
  'bike-fits-view',
  'bike-validation',
  'bike-painted',
] as const

export const task: BenchmarkTask = {
  id: 'bicycle-blueprint',
  slug: 'bicycle-blueprint',
  category: 'advanced-physics',
  title: 'Bicycle Blueprint',
  blurb: 'A parametric side elevation of a bicycle drawn as inline SVG; its joints, tangent chain, gear readouts and fit are checked against the drawn geometry.',
  prompt: PROMPT,
  runtimeHint: 'Browser, inline SVG and window.__bench test hooks; no canvas, no network',
  iterationsDefault: 3,
  methodNotes: 'Behavioural checks, 100 points (70 % of the composite): wheels and ground (8), frame joints (14), drivetrain circles (6), chain tangency (14), cranks and pedals (8), spokes (8), wheel rotation (10), readouts (12), saddle and bars (4), fit to view (6), validation (5), paint proof (5). Each measurement is taken from what the page draws (getScreenCTM, readout text, screenshot pixels) and compared with reference geometry computed from the parameters under the tolerances in hidden.ts. Not measured: the styling and legibility of the blueprint, the decorative layer, the quality of the code beyond the test hooks, and whether the page is pleasant to use. The checks confirm the mathematics of the drawing, not the design. Known limits (suite review): a drawing that ignores the chainstay, bottom-bracket drop, seat tube, angles and head tube can still score in the 80s, because the drivetrain, chain and crank checks measure against the drawn bottom bracket; the hidden parameter sets do not catch every fixed handlebar.',
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: [...CHECK_NAMES],
  sandboxConstraints: SANDBOX,
}
