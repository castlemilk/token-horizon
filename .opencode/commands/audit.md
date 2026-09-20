---
description: Impeccable UI audit of the Token Horizon dashboard — every view, state, breakpoint, and interaction, with Playwright evidence and severity-ranked findings.
subtask: true
---

# /audit — Token Horizon dashboard UI audit

Audit the Token Horizon web dashboard (`docs/leaderboard.html`, APIs in `cloudflare/src/index.js`) with the rigor of a release-blocking design review. Be exhaustive, be specific, be adversarial: assume every pixel is guilty until proven innocent. **Findings only — do not change any code.**

## Method (mandatory)

1. Serve nothing; open `docs/leaderboard.html` via `file://` in headless Chromium (Playwright is at `/Users/benebsworth/projects/tautau/web/node_modules/playwright/index.mjs`). Intercept `https://token-horizon.dev/api/**` with fixtures (see `scripts/leaderboard/test-leaderboard-ui.mjs` for the pattern) — never touch production.
2. Walk every routed view (`dashboard`, `leaderboard`, `players` + all profile tabs, `teams`, `prompts`, `models`, `billing`, `leagues`, `settings`, all modals, `?share=` report, `?signin=1`) at **1440px and 390px** widths. Screenshot anything you claim is broken (`/tmp/audit-*.png`).
3. Exercise states: loading (throttle API), empty, error (404 fixtures), signed-out, expired session, `prefers-reduced-motion`.
4. Keyboard-walk interactive elements; check focus visibility, tab order, ESC handling, ARIA labels/roles.
5. Collect console errors and `window.__thPerf` counters; run `node scripts/leaderboard/bench-leaderboard.mjs` and note any budget breach.

## Checklist

- **Visual hierarchy & consistency**: heading scale, card rhythm, spacing, alignment, one accent language (no competing blues/purples), no orphaned headers or runaway text. "Token Horizon" branding everywhere (never TokenArena).
- **Data honesty**: every number traceable to a fixture field; no fabricated values; empty states explain why and what unlocks them.
- **Charts**: stacked columns dense and touching; legend swatch == bar fill; logos load (no glyph fallbacks when an asset exists); tooltips readable, never clipped; axes inside cards; no-op re-renders must not remount (`chartReuses` grows, `chartMounts` flat).
- **Responsive**: no horizontal page scroll at 390px; tables scroll internally; modals fit with reachable close buttons; sidebar collapses cleanly.
- **A11y**: contrast ≥ 4.5:1 for body text; visible focus; icon-only buttons have labels/titles; ASCII art is `aria-hidden`; motion stops under reduced-motion and on modal close.
- **Copy**: no lorem/placeholder text, no stale references, correct units/plurals, no `alert()`/`prompt()` left in user flows.
- **Perf**: cold load, view-switch p95, and idle-tick numbers vs `scripts/leaderboard/bench-leaderboard.mjs` budgets; flag any new network fan-out or unbounded growth (timers, listeners, maps).

## Output

A findings table, nothing else:

| # | Sev (P0/P1/P2) | View / breakpoint | Issue (one sentence) | Evidence (screenshot path or repro steps) | Suspected location (`file:line`) |

- P0 = broken/misleading; P1 = visibly wrong or sloppy; P2 = polish/nit.
- Verify every claim twice (re-read the code or re-screenshot). If you cannot reproduce it, drop it.
- End with: total counts per severity, and the 3 findings you would fix first if forced.
