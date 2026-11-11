/**
 * The seat-pricing task row. The prompt is the specification's final_prompt, copied
 * verbatim (checks.test.ts compares it with the JSON file when that file exists).
 * Generated from the specification; edit the specification, not the string.
 */
import type { BenchmarkTask } from '../../../../types'

export const SEAT_PRICING_PROMPT = `Build a single-file HTML pricing page for a fictional team chat product called Relay, with a live seat calculator and an itemised order summary. It should look like a polished, shippable product page. An automated browser script grades it against the exact contract below, with inputs you have not seen. Every id below appears exactly once, on a visible element.

PLAN CARDS
- Three cards in this order, each an element with data-plan-card="starter", "team" or "scale", showing the plan name, its list price per seat per month, a short feature list and a selection button. List prices: Starter $9.00, Team $14.50, Scale $23.75.
- The selection button is <button data-plan="starter|team|scale">. Its accessible name contains the plan name (for example "Choose Team"). It has aria-pressed="true" on the selected plan and "false" on the other two. Team is selected by default.

CONTROLS
- Billing period: an element with role="radiogroup" and accessible name "Billing period" containing exactly two native <input type="radio"> elements, #billing-monthly (accessible name "Monthly") and #billing-annual (accessible name "Annual"). Monthly is the default; arrow keys switch between them.
- Seats: <input id="seats" type="text" inputmode="numeric"> with accessible name "Seats" and default value "5", placed between <button id="seats-dec"> (accessible name "Decrease seats") and <button id="seats-inc"> (accessible name "Increase seats"), which change the value by 1.
- Promo code: <input id="promo" type="text"> (accessible name "Promo code"), <button id="promo-apply"> (accessible name "Apply promo code") and <p id="promo-status">. Pressing Enter in #promo does the same as the button.
- Tax region: <select id="region"> (accessible name "Tax region") whose option values are exactly none, ca, ny, uk, de. Default none.
- <button id="checkout"> whose text starts with "Checkout".

PRICING RULES
All money is a whole number of US cents. "round" always means round half up to the nearest cent (exactly half a cent goes up), applied to the exact mathematical value. An amount that is one cent off is wrong.
1. Seats N is a whole number from 1 to 5000.
2. Graduated volume pricing: each seat is priced by its own position. Seats 1 to 10 cost 100% of the plan's list price, seats 11 to 50 cost 90%, seats 51 to 200 cost 80%, seats 201 and above cost 70%.
3. months = 1 for monthly billing, 12 for annual billing.
4. subtotal = round(months x the sum of the per-seat prices from rule 2). Round once, at the end.
5. annual discount = round(17% of subtotal) for annual billing, 0 for monthly.
6. promo discount, calculated on (subtotal - annual discount):
   LAUNCH20: round(20% of it).
   FLAT50: $50.00, or the whole amount if that is smaller.
   TEAM10: round(10% of it). Valid only when the plan is Team or Scale and N is at least 5.
7. taxable = subtotal - annual discount - promo discount.
8. tax = round(taxable x rate). Rates: none 0%, ca 7.25%, ny 8.875%, uk 20%, de 19%.
9. total = taxable + tax.
10. per-seat price = round(total / (N x months)).

PROMO BEHAVIOUR
- Codes match case-insensitively after trimming whitespace. One code at a time: applying a new one replaces the old one, and applying an empty value removes it.
- #promo-status has data-state="none" (no code), "applied" (a valid code is in effect) or "error" (unknown code, or TEAM10 while it is not valid: zero discount and a visible message).
- An applied code stays in place when other controls change. If TEAM10 stops being valid because the plan or seat count changed, it goes to the error state with zero discount, and returns to applied when it is valid again.

ORDER SUMMARY
- An element #summary containing six amount elements: #subtotal, #annual-discount, #promo-discount, #tax, #total, #per-seat.
- Each amount element has data-cents set to the whole number of cents (discounts as positive numbers), and its only text is that amount in US dollars: a $ sign, comma thousands separators and exactly two decimals, for example "$1,234.56" or "$0.00". Discount amounts may start with a minus sign. Put labels in separate elements.
- #total is inside an element with aria-live="polite".
- The summary updates synchronously in the input, change or click handler of every control. No calculate button, no debounce, no number animation.

BREAKDOWN BAR
- An element #breakdown, at least 240px wide at every viewport width, with exactly three children in one row, left to right: data-segment="net", data-segment="tax", data-segment="saved".
- Their rendered widths are proportional to taxable, tax and (annual discount + promo discount), as shares of the sum of those three amounts. A segment whose amount is 0 has zero width. No min-width, padding, border, margin or gap on the segments.

INVALID SEATS
- The seats text is valid only if, after trimming whitespace, it consists solely of the digits 0 to 9 and its value is from 1 to 5000. So " 7 " and "007" mean 7, while "", "0", "12.5", "1e3", "+5", "-3", "12abc" and "5001" are invalid.
- While it is invalid: #seats has aria-invalid="true"; <p id="seats-error"> shows a message and is referenced by aria-describedby on #seats; all six amount elements show an em dash (—) and have data-cents=""; #checkout, #seats-dec and #seats-inc are disabled.
- When it is valid again all of that is undone: aria-invalid="false", #seats-error empty, amounts back.
- #seats-dec is disabled at 1 and #seats-inc at 5000. Never rewrite the text in #seats while the user is typing in it; only the two buttons may change it.

ACCESSIBILITY AND LAYOUT
- <html lang="en">, exactly one <h1>, all content inside <main>.
- Everything works with the keyboard alone. Tab order: the three plan buttons (starter, team, scale), the billing radios, #seats-dec, #seats, #seats-inc, #promo, #promo-apply, #region, #checkout. Each of them shows a clearly visible focus indicator when focused from the keyboard.
- Every piece of text, including muted labels, text on buttons, the promo message and the error message, has a contrast ratio of at least 4.5:1 against its background (3:1 for text of 24px or more, or bold text of 18.66px or more). Put text on solid background colours only, never directly over a gradient or an image. Disabled controls are exempt.
- Responsive: the page never scrolls horizontally at viewport widths of 390, 768 and 1440 px. At 1440 the three plan cards sit side by side in one row; at 390 they stack in one column. Every control listed above stays completely inside the viewport width.`

/** Hygiene-only sandbox contract for DOM and SVG tasks (see suite-notes SANDBOX CONTRACT). */
export const SEAT_PRICING_SANDBOX = `EXECUTION ENVIRONMENT — your artifact runs inside a locked-down sandboxed iframe (sandbox="allow-scripts", opaque origin, NO network access). Hard requirements:
- Produce ONE complete, self-contained HTML document: <!DOCTYPE html> through </html>.
- Use this exact skeleton: <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>...</style></head><body>...</body></html>. The DOCTYPE must be the very first node — a DOCTYPE after any other content still triggers quirks mode, and the canvas/CSS sizing comes out wrong. All visible content must live inside <body>, never as bare siblings of <html>.
- Inline ALL CSS and JavaScript. Nothing may load from the network: no <script src>, no <link href>, no @import, no CDN (React/Tailwind/three.js/fonts/images included). If you need a library, hand-write the code instead.
- Write plain browser JavaScript only. No JSX, no <script type="text/babel">, no Babel standalone, no TypeScript, no build step, no runtime compilation.
- localStorage/sessionStorage/cookies may be unavailable — feature-detect or wrap in try/catch; the page must still work without them.
- No alert/confirm/prompt; render all feedback into the page itself.
- Wrap your top-level script body in try/catch and, on failure, write the error message into a visible <div role="alert"> inside <body>. The sandbox auto-injects an error overlay, but a model that catches its own errors and renders them gives a much better demo than one that crashes silently.

Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Open the document with <html lang="en">. Every control must work; no placeholder text. Output only the HTML document.`

export const task: BenchmarkTask = {
  id: 'seat-pricing',
  slug: 'seat-pricing',
  category: 'ui-building',
  title: 'Seat Pricing Calculator',
  blurb: "A live seat calculator with graduated volume pricing, exact half-up cent rounding, promo rules and an accessible, responsive order summary.",
  prompt: SEAT_PRICING_PROMPT,
  runtimeHint: 'Browser, DOM, keyboard, layout and computed-style checks; offline, single file',
  iterationsDefault: 3,
  methodNotes: "Behavioural checks carry 70% of the composite and the structural share the rest. The ten checks are worth 100 points: tiers 10, discount order 12, exact rounding 14, display format 7, seat validation 11, keyboard 10, accessible names 8, contrast 8, responsive 10, breakdown geometry 10. Money is judged in whole cents against an exact BigInt reference over fixed scenarios held in hidden.ts (graduated tiers, the discount and promo state machine, twelve half-cent ties, four display states, four breakdown states); the page's own arithmetic is never trusted. The format and breakdown checks compare the visible text and drawn widths with the page's own data-cents, so they score presentation rather than arithmetic. Keyboard focus is judged from computed outline, box-shadow, border and background, not from paint, and keyboard steps use real key events only where the specification names them. Contrast is measured on paint: the page is photographed as drawn and again with each text made transparent, so a backdrop painted by an image, a canvas, an SVG, a pseudo-element or a pointer-events:none layer is seen where the text sits. Responsive checks use geometry at 390, 768 and 1440 px with a 1 px tolerance; no screenshot is compared. Not scored: visual polish, copy, the quality of the layout between the measured points, plan feature text, and whether the checkout button does anything beyond the preview note. Hidden inputs are in hidden.ts and are versioned (seat-pricing/v4); the prompt contains none of the amounts or scenarios the checks use. Each check requires only the contract ids and plan buttons it drives or reads, so a missing element costs the checks that need it and no others. Transitions are stopped and running animations finished before each check reads; a page is not measured mid-transition. A line is judged by its worst quartile of pixel ratios, so a band or a fade over a fifth of a line fails; a glyph covered by a layer, or faded by a mask, fails where it is hidden. Text parked off screen, clipped away or made of an emoji is skipped, not failed. Placeholder text is not measured. A focus ring is measured against the composite of translucent ancestors down to the canvas, not against white.",
  demoComponentName: 'HorizonSuiteDemo',
  scorer: 'behavioral',
  checks: [
    'pricing-graduated-tiers',
    'pricing-discount-order',
    'pricing-exact-rounding',
    'pricing-display-format',
    'pricing-seats-validation',
    'pricing-keyboard',
    'pricing-accessible-names',
    'pricing-contrast',
    'pricing-responsive',
    'pricing-breakdown-geometry',
  ],
  sandboxConstraints: SEAT_PRICING_SANDBOX,
}
