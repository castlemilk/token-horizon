# Widget morph debugging (Tauri vs browser)

Field notes from chasing a tile↔modal morph that flew in the Tauri shell but
not in the web browser, and that streamed digit soup on close in Tauri.
Written for the next agent so the eliminated hypotheses don't get
re-eliminated at full cost.

## The system in one paragraph

`WidgetMorph.svelte` is a shared-container morph: the SAME DOM node is the
tile and the modal (`class:tile={!open}` / `class:modal={open}`), and GSAP
choreographs a single timeline. "Travelers" (widget-declared `[data-travel]`
nodes) never actually move — body-level CLONES fly viewport-rect to
viewport-rect while the sources are concealed. Everything is measured live;
nothing is hardcoded. Devtools hints live in the shell: `?morphdebug=1` logs
every flight decision and bail reason (`[morph]` lines), `?slowmo=1` runs
timelines at 4× slow for frame inspection.

## Confirmed bugs (fixed)

1. **Close flight never concealed its sources** — the open path parks
   traveler sources hidden (`conceal-head`), but the exit path spawned
   clones parked over *visible* modal numbers. Any clone/source pixel
   disagreement (see "why engines differ" below) double-renders as numbers
   popping out of nowhere before the collapse. Fixed by mirroring open:
   `.conceal-exit [data-travel] { visibility: hidden }` for the whole exit
   phase (the rule lives in `app.css` — traveler nodes render inside widget
   files, so scoped CSS in the shell gets tree-shaken as unused).

2. **Clone text sampled from `textContent` is digit soup** — travelers
   containing `CountUp` carry an odometer roller: every digit 0–9 stacked
   in a clipped strip, `textContent` = `0123456789`. The close clone then
   flew `0123456789.0123456789M`. Open never showed it because its source
   is the tile's static text. Fixed: `sampleText` prefers `aria-label` —
   first on the traveler, then on a nested descendant (the roller labels
   itself with the settled value), falling back to `textContent`. The
   descendant lookup matters: the label sits INSIDE the traveler, not on it.

3. **Icon travelers flew invisibly** (RecentWidget's provider icons) — the
   clone contract was text-or-dot, and the dot takes the wrapper span's
   `backgroundColor`, which is transparent for icon wrappers. The flight
   played; nothing visible traveled. Fixed: a third clone variant,
   `visual`, serializes the traveler's internals (img/svg markup — scoped
   Svelte styles ride along via attribute selectors) plus sampled
   frame/paint props (size, flex centering, background, radius, shadow).
   Priority: text > visual > dot.

4. **Ungated polls corrupt in-flight measurements** — every widget polls
   its feed on a timer; a poll resolving mid-flight re-sizes/re-mounts the
   very nodes the clones were measured from, so travelers land on stale
   positions. Fixed by gating each poll on `phase === 'settle'` (skipped
   ticks resume on the next cycle): ActivityBarsWidget, CountersWidget,
   RecentWidget. New widgets MUST gate their feeds the same way.

## Eliminated hypotheses (with evidence)

- **`prefers-reduced-motion` divergence** — the only environment-dependent
  gate in the code (`canFly = () => !reduce`). Checked both shells:
  `matchMedia('(prefers-reduced-motion: reduce)').matches` returned `false`
  in browser AND webview. Dead end.
  - Quick OS-level check without consoles:
    `gsettings get org.gnome.desktop.interface enable-animations`.
- **Stale browser bundle** — the browser and the webview load the same
  vite dev server (`:5173`) under `run-dev.sh`, so HMR keeps them in sync.
  (Would be the prime suspect if the browser viewed the built SPA instead.)
- **GSAP itself** — same bundle, both shells; no environment branches.
- **DPR/rendering** — flight math is pure `getBoundingClientRect`
  translation+scale; DPI changes dot sharpness, not whether a flight plays.

## Why Tauri ≠ browser on this code path (lessons)

1. **Same bundle ≠ same behavior.** The split can only come from
   environment: media queries, layout/viewport differences (the home grid
   is container-driven), font metrics, or timing. The visible tree is
   identical; the measurement context is not.
2. **Font metrics differ between engines.** WebKitGTK (Tauri/Linux) and
   Chrome rasterize the same `tabular-nums` counter at different widths.
   The morph is *supposed* to be metric-proof (clone carries its own text
   with sampled font), which is why source concealment — not metric
   agreement — is the load-bearing defense.
3. **`visibility:hidden` is a feature here, `display:none` is a bug.**
   Measurements must succeed on nodes that must not paint: `pre-show`
   keeps the mounted modal measurable-but-invisible until the timeline
   parks it over the tile. If a future refactor "cleans up" a conceal with
   `display:none`, every measured box collapses to zero and the flight
   silently bails.
4. **Text-shaped travelers need text-shaped truth.** Anything that renders
   its value as transformed DOM (odometers, split-flap, letter-scatter)
   must publish the semantic value via `aria-label`, or the clone layer
   will fly the rendering internals.
5. **A clone that shows nothing is a working flight.** "Nothing travels"
   can mean the flight bailed OR the clone is transparent — check whether
   the source is measurable-but-empty (no text, no background). Icon
   travelers need the `visual` variant, not the dot fallback.
6. **Feed timers are flight-unaware by default.** Any widget poll that can
   resolve during a flight invalidates measured boxes. Gate on
   `phase === 'settle'`.

## Procedure when it happens again

1. **Isolate the shell difference.** Same viewport size in both. Check
   `prefers-reduced-motion` in both consoles first — it is the ONLY
   environment gate and has burned me once.
2. **Instrument, don't guess.** Run with `?morphdebug=1` in both shells
   and diff the `[morph]` lines from one open + close cycle. The log names
   the exact bail point: `canFly false` / `tile measure fail` /
   `modal measure fail` / `key miss` / `launch aborted` / close equivalents.
3. **Slow it down.** `?slowmo=1` makes a bad handoff visible instead of
   fast-and-wrong.
4. **Console access.** Browser: F12 → Console. Tauri debug builds:
   right-click → Inspect Element → Console. Release bundles strip the
   inspector; use `run-dev.sh`.
5. **If clones appear but land wrong,** suspect font metrics — then fix by
   hiding sources (never by interpolating font properties; GSAP can't
   tween family/weight/style).

## Still open at time of writing

The web-browser OPEN flight not playing (Tauri flies; both engines report
`reduce=false`). With all code-level gates eliminated, the answer is
expected from the `?morphdebug=1` trace — most likely a measurement bail
(`modal measure fail` would match "modal appears at resting size instantly,
no flight"). Update this doc with the `[morph]` output when captured.
