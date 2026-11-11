# Decoded-pixel measure: evaluated 2026-11-10, not adopted

**Decision.** The decoded-pixel measure was evaluated on 2026-11-10 and not
adopted. The five legacy canvas tasks keep the byte-level proxies `pixelDiffScore`
and `canvasContentScore` in `scorers/checks.ts`, with their original thresholds
(2%, 1%, 0.5%, 15%). They read the PNG file's bytes, not decoded pixels, and they
are kept for continuity with the 302 version-1 records. Those five tasks are smoke
tasks, a wiring check and not a ranking measure (see `scorer-changelog.md`).

`scorers/pixels.ts` (PNG decoding, `pixelDiffRatio`, `fractionOffBackground`) stays
in the package as a tested utility. No legacy check uses it.

## Why it was not adopted

1. **The canvas-only capture did not isolate the canvas.** It hid other elements
   with `visibility:hidden`, but CSS transitions on page controls ran until after
   the screenshot, and the canvas's own border, radius, box-shadow and background
   still counted as drawn content. A blank canvas with a 1px border scored 68
   instead of 30, and a page that never drew on its canvas passed
   `pendulum-renders`. The `ling-3.0-tiny` physics-pendulum-wave artifact draws
   nothing and still passed at 0.42%. Evidence:
   `evidence/decoded-pixel-2026-11-10/synth.out`.
2. **Rescoring moved the wrong scores.** Of the 63 stored best artifacts for
   `n-body-field` and `physics-pendulum-wave`, 33 changed by 20 points or more, and
   21 fell by 30 or more (for example `nemotron-3-ultra` n-body from 100 to 30). The
   stored 100 was an empty canvas with controls over it, so the new measure fixed
   one error and introduced its own (item 1). Evidence:
   `evidence/decoded-pixel-2026-11-10/scan.json` and `scan-summary.txt`.
3. **The thresholds did not separate decoration from drawing.** On the captures the
   threshold was judged on, blank pages with a 1px border, a border radius, an
   inset box-shadow or a gradient background passed under the page-region measure
   (0.07% to 62%). Evidence: `evidence/decoded-pixel-2026-11-10/fixcheck2.out`.
4. **The implementation round's sample did not contain these cases.** It measured
   165 stored HTML artifacts and counted 12 flips under the decoded measure. Items
   1 to 3 exercised the cases that sample did not contain, so the 12-flip count does
   not show the decoded measure is right. Evidence:
   `evidence/decoded-pixel-2026-11-10/t4-flips.mts.txt`.

## What would reopen this

A new scorer version, not a change to version 2. It needs a canvas capture that
isolates the canvas (transitions off, pseudo-elements and the canvas's own
decoration neutralised, and a check that a DOM-only change reads exactly 0),
thresholds chosen on a held-out set, and a rescore of every stored record under the
new version, shown side by side with version 2.

## Parity with version 1

`scripts/rescore-parity.mjs` rescored the 174 stored, live, browser-scored HTML
records of the nine behavioural tasks with the version 2 scorer (no network, no
model call, `results.json` read only) and wrote its findings to
`tmp/rescore-parity.json`. In the last run 144 of 174 records matched their stored
check outcomes. Of the 30 that differ, 19 are canvas records (dated 2026-07-03 to
2026-08-26): stored records from before 2026-09-22 were scored with the
`canvas.toDataURL` capture, and they reproduce under it. 9 are landing records:
landing records from before 2026-10-19 were scored with the earlier landing check,
so the cause is the landing check alone. 2 have a stored breakdown that cannot be
compared by name. The regimes, their dates and what they mean for comparing versions
are in `scorer-changelog.md`.
