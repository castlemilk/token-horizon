# Landing page and interactive product tour

The public root introduces Token Horizon with the approved graphite, ivory and
mint direction. `index.html`, `landing.css` and `landing.js` are independent of
the shared blog/documentation styles and the leaderboard SPA.

## Product demonstration

The laptop contains actual HTML charts and panels composed over the generated
device frame. Its seven scenes show the notch, desktop widgets, dashboard,
provider limits, local inference, gateway traces and model catalog. Native CSS
and Web Animations keep the preview interactive without a video runtime or a
new dependency. The existing Remotion project is unaffected.

- The refined scenes include provider marks, three-color token stacks, CPU and
  memory rings, input/output/cache splits, project activity, reset headroom,
  local throughput, a request waterfall with tool events, and a model inspector.
- Explore the demo opens a larger, manual seven-scene tour. Next/previous wraps
  through the scenes; closing restores focus to the launch button. On small
  screens the preview can be scrolled horizontally to preserve readable details.
- Scenes advance every 6.5 seconds. Selecting a feature pauses the tour.
- Play/Pause is explicit. Hidden tabs and an offscreen tour suspend playback.
- Reduced motion disables autoplay and transitions; the playback button becomes
  a manual Next control.
- The separate widget feature preview switches between usage, activity and
  limits, with five working time-window controls. These illustrate widget
  features rather than reproduce the native widget's page navigation exactly.
- Demo figures are fixed illustrations, never live standings, current prices
  or plan entitlements. No provider API or local daemon is contacted.
- The page remains readable without JavaScript, with static previews, working
  navigation and install commands. Interactive-only controls are hidden.

## Assets and design decisions

The three generated assets in `assets/landing/` total 188,294 bytes (184 KiB).
They derive from the PNG masters in `../token-horizon-ui-kit/assets/`; exact
generation prompts and original provenance are in that kit's `prompts/` and
`manifest.json`. WebP conversion preserves cutout alpha. Decorative images have
empty alt text, fixed dimensions and appropriate eager/lazy loading.

The implementation follows the approved mockup's key features:

1. Dark navigation, three-line headline, left-aligned installation actions.
2. Large graphite laptop on the right, with mint horizon wallpaper.
3. Restrained provider strip and paired community/catalog discovery sections.
4. Dark desktop-widget section followed by an ivory installation section.
5. Real semantic text, tables and buttons using the same palette and spacing.

Intentional differences: native system typography replaces generated lettering;
feature controls sit below the laptop; the catalog teaser links into real
explorer/price/plan views instead of repeating sample prices; additional
capability and privacy sections explain the product. Mobile stacks the hero
and discovery columns, with an expandable navigation menu.

## Routes

The worker serves the landing at `/`, including marketing query parameters.
Recognized legacy root dashboard queries (`view`, `tab`, `share`, `signin`,
`period`, `model`, `provider`, `plan`, `flat`) still serve the SPA. Existing
`?user=`, `/u/`, `/s/`, `/leaderboard.html` and `/models` handling is preserved.
Relative asset and navigation links also support the static project site.

## Preview and validation

From the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
node --check docs/landing.js
node --test cloudflare/worker.test.mjs
```

Open `http://127.0.0.1:4173/`. The static preview demonstrates the landing; the
worker's routing is covered by its tests.

Verified in the browser at 1536, 768, 390 and 320 CSS-pixel widths: responsive
layout, all seven scenes, Play/Pause, widget features and all five activity
windows, disabled window controls for provider limits, mobile menu, Homebrew
copy including its newline, and installer disclosure. No document horizontal
overflow at the checked widths. Reduced-motion behavior and the no-JavaScript
fallback are implemented but were not emulated in this browser session.

All 35 worker tests passed. Source syntax and `git diff --check` passed.
Screenshots are in `../token-horizon-ui-kit/implementation/`. No production
deployment or native application rebuild was performed.

The fidelity refinement was checked in Browser at 1536×1024 and 390×844:
all seven laptop scenes fit without clipping; expanded next/previous wraps and
stays in sync; closing restores focus and unlocks page scrolling; mobile detail
panning works and resets on scene change. The widget week view still renders
119 activity cells. No browser console errors or warnings were observed.
