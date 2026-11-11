/**
 * sector-clock: the prompt, checks, sandbox contract and method notes for the
 * Horizon suite task. GENERATED from task-sector-clock.json and prompts.ts by a
 * one-off script; the prompt is the specification's final_prompt, verbatim.
 */
import type { BenchmarkTask } from '../../../../types'

const PROMPT = `Build one self-contained HTML page that draws an analog clock as inline SVG with four text readouts. The clock never reads the system clock: it shows a fixed default on load and afterwards only what the test hooks set. A script grades it by setting hidden instants and measuring what is drawn on screen (hand directions, tick and numeral positions, sector pixels), so the geometry must be exact. Use every id and class exactly as written. Do not round coordinates or angles to fewer than 2 decimal places.

TIME MODEL
- An instant is utcMs (integer milliseconds since 1970-01-01T00:00:00Z, from -2208988800000 to 4133980799999, that is the years 1900 to 2100) plus offsetMinutes (integer, -720 to 840). Local time is UTC plus the offset, in the Gregorian calendar. The result must not depend on the time zone of the computer displaying the page.
- H, M, S are the local hour (0-23), minute and whole second. Discard milliseconds by flooring (also for negative utcMs).
- Angles are degrees clockwise from 12 o'clock as seen on screen:
  hour hand = ((H mod 12) + M/60 + S/3600) * 30
  minute hand = (M + S/60) * 6
  second hand = S * 6
  24-hour hand = (H + M/60 + S/3600) * 15

DRAWING, all inside <svg id="clock">. R is the radius of the dial.
- <circle id="dial">: the face. Its centre is the pivot. It must be a true circle on screen.
- Exactly 60 <line class="tick">, one every 6 degrees, each lying on a radius, entirely between 0.90R and 1.00R from the centre. The 12 ticks at multiples of 30 degrees also carry class "major" and are at least 1.5 times as long as the others.
- Exactly 12 <text class="numeral"> with text 1 to 12, upright (not rotated). Numeral n is centred at angle n*30 degrees, at a distance between 0.55R and 0.68R, and stays entirely inside 0.76R.
- <line id="hand-hour">, <line id="hand-minute">, <line id="hand-second">: one SVG line each. The line passes through the dial centre; its (x2,y2) end is the tip; its (x1,y1) end is at the centre or up to 0.2R behind it. Tip distance from the centre: hour 0.40R-0.55R, minute 0.62R-0.76R, second 0.62R-0.76R. You may place a hand by its coordinates or by a rotate transform.
- <circle id="subdial">: a 24-hour sub-dial, radius 0.10R-0.14R, centred directly below the dial centre at a distance of 0.26R-0.32R. <line id="hand-24h"> runs from the sub-dial centre (x1,y1) to its tip (x2,y2); tip distance 0.6-0.95 of the sub-dial radius. Midnight is at the top of the sub-dial.
- All four hands are stroked at least 1.5 px wide on screen, fully opaque, in colours that differ from the face by more than 80 in at least one RGB channel, with nothing drawn over them.
- <path id="sector">: a ring segment marking a time span on the 12-hour dial. It covers exactly the region between 0.78R and 0.88R from the centre, clockwise from angle start*0.5 degrees to angle end*0.5 degrees, where start and end are minutes after 12:00 (integers 0-719). If end < start the span passes through 12 o'clock. If start equals end the sector is empty and paints nothing. Paint it #f59e0b, fully opaque. Paint nothing else between 0.77R and 0.89R, and keep the face colour there clearly different from #f59e0b.
- Paint order: sector below the hands; hour hand, then minute hand, then second hand on top.

READOUTS (elements with these ids, anywhere on the page; the text content is exactly as specified)
- #digital: local time as HH:MM:SS, 24-hour, zero-padded.
- #date-window: local date as three-letter English weekday, one space, day of month without leading zero, for example "Tue 2".
- #offset-label: "UTC", then a + or - sign taken from offsetMinutes (+ for zero), then two-digit hours, a colon and two-digit minutes of its absolute value, for example "UTC+05:45", "UTC-03:30", "UTC+00:00".
- #week-label: the ISO 8601 week of the local date as YYYY-Www. Weeks start on Monday, week 1 is the week containing the year's first Thursday, and YYYY is the ISO week-numbering year, which can differ from the calendar year. Example: 14 March 2026 is "2026-W11".

TEST HOOKS on window.__bench
- setInstant(utcMs, offsetMinutes): update all four hands and all four readouts, return true.
- setSector(startMinutes, endMinutes): redraw the sector, return true.
- Both are synchronous: when the call returns, the DOM already shows the new state. Use no CSS transitions, animations or easing on anything these calls change.
- Arguments that are not integer numbers in the stated ranges (NaN, strings including numeric strings, fractions, out of range, missing) make the call return false without throwing and without changing anything on the page.

ON LOAD the page shows setInstant(1773453566000, 330) (07:29:26, "Sat 14", "UTC+05:30", "2026-W11") and setSector(540, 330) (09:00 round to 05:30, a 255-degree span).

LAYOUT
- The whole clock and the readouts are visible without scrolling at 1024x720 and at 380x480. The dial radius is at least 150 px on screen at 1024x720 and at least 100 px at 380x480.
- Style it as a finely made instrument. Colours, typography and extra decoration are yours to choose, as long as every rule above still holds.`

const SANDBOX_CONTRACT = `EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:
- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.
- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.
- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.
- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.
- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.
- No alert/confirm/prompt; render all feedback into the page itself.
- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.

Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.`

export const task: BenchmarkTask = {
  id: 'sector-clock',
  slug: 'sector-clock',
  category: 'ui-building',
  title: 'Sector Clock',
  blurb: "An analog clock with a 24-hour sub-dial, four readouts and a sector band, graded at the pixel level against integer calendar arithmetic.",
  prompt: PROMPT,
  runtimeHint: 'Browser, inline SVG, pixel-level screenshots and a second time-zone context',
  iterationsDefault: 3,
  methodNotes: "Behavioural checks, 70 points: the page is driven only through window.__bench and the DOM contract. Each hook call, the finish of the page's animations and the read of the hands and readouts happen in one in-page turn, so a page that draws after the call returns is read before its draw and fails. Each check requires only the elements it reads. Hand angles come from line endpoints through getScreenCTM and are compared with integer calendar arithmetic in reference.ts, not with the page's own readouts. Sector pixels come from decoded screenshots and are tied to the #sector element by hiding it; tick midpoints come from DOM geometry and are then proven painted by hiding the ticks. Each hand is proven painted at three points along its own drawn line (35%, 60% and 85%): hiding the four hands must change at least 40 channel units at each point. The sector is never judged by isPointInFill. Not measured by pixels: the numerals and the dial, which are judged by geometry only; visual style and typography; the exact stroke width or colour of the hands beyond the paint proof; and whether a page reads the system clock internally (the pins and the second zone bound it but cannot prove its absence). Host time-zone independence is checked in a second Pacific/Chatham context; every other check pins the page to UTC. Structural share (30 points) is the generic HTML scorer and any well-formed page earns most of it. Known limit (suite review): the sector pixel checks read the screen after a settle, not in the same turn as the call that changes the time.",
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: ["clock-structure","clock-ticks-numerals","clock-minute-second","clock-hour-hand","clock-offset-time","clock-date-window","clock-iso-week","clock-subdial-24h","clock-sector-band","clock-sector-arcs","clock-edge-instants","clock-host-timezone","clock-sync-validation"],
  sandboxConstraints: SANDBOX_CONTRACT,
}
