---
name: Token Horizon
description: Quiet precision for voluntarily shared AI usage
colors:
  mineral: "#f3f4ef"
  graphite: "#121714"
  forest: "#235e43"
  signal: "#b6f2cf"
  titanium: "#cdd3cc"
  void: "#070a08"
typography:
  display:
    fontFamily: "Hubot Sans"
  data:
    fontFamily: "JetBrains Mono"
---

# Token Horizon design system

## Overview

Preserve the committed **Quiet precision** identity. Its visual signature is the eclipse with a horizontal horizon seam: a precise instrument, confident measurements and space to think. This document records the incumbent web system and the reviewed Teams implementation; it does not replace the native design specification.

The detailed identity, optical SVG marks, original icons and licensed fonts are in [the design-system specification](token-horizon-design-system/DESIGN_SYSTEM.md) and [local component manual](token-horizon-design-system/index.html). The [kit README](token-horizon-design-system/README.md) explains how to preview it. Runtime styles are authoritative for computed web behavior: [horizon-system.css](docs/horizon-system.css), [theme.css](docs/theme.css), [surfaces.css](docs/surfaces.css) and the relevant surface stylesheet.

## Purpose, ownership and states

Every view identifies its purpose, whose data it shows and the supported next action. Distinguish personal account data, an explicitly opened public profile and community aggregates in the heading or adjacent scope text. A personal/account destination must never fall back to the first community row or community totals.

Loading text names the actual step: checking sign-in, finding owned profiles or loading a published snapshot. An empty state follows a successful request and explains the relevant setup or publication step. An error names the failed step, keeps any valid snapshot visible and offers recovery. Unknown data remains unavailable; do not turn pending requests into zero metrics or decorative sample charts. Render real actions with accurate names and states; do not present local-only controls as server-enforced permissions.

Workspace is published-snapshot analysis. Signed-out visitors receive a Sign in action; sign-in discovers verified-owned profiles without publishing or claiming them. A verified empty account receives publication and supported account-linking guidance. One owned profile opens directly; several require intentional selection. An explicitly selected public profile is labelled as a public preview. Keep the interface focused on that task, without promotional feature cards or Invite friends in the analysis heading.

The account destination **Model costs** opens Workspace's **Models & costs** section for the selected profile. **Report sharing** requires a verified-owned profile choice before private reads and exposes only supported report settings/actions. Community cost aggregates, fake local “Default Sharing Rules” and unsupported Comment/Edit matrices do not belong in these account destinations.

## Colors

Mineral, Graphite, Forest, Signal, Titanium and Void are the existing brand pigments. Components consume semantic `--th-*` roles instead of using these pigments as fixed interaction colors. `theme.css` supplies independent light/dark values for surfaces, text, muted text, rules, selected states, controls and focus.

Forest is the light-theme action color; Signal is the dark-theme action color. Provider colors identify reported model usage and retain their brand associations. They are data colors, not permission, success or error states. The provider horizon uses a contrasting boundary behind pale segments. Team histories use a small, stable series palette and written names; the aggregated Other series also has a dashed stroke.

## Typography

Use locally bundled Hubot Sans for display and headings, with the incumbent extended treatment where already applied. Use JetBrains Mono for measurements, dates and technical values; use the existing system-sans stack for body text and controls. Counts use tabular figures. Preserve readable wrapping for long team names and explicit units and time windows beside totals.

## Layout

The Teams analytics panel keeps one task per area: team comparisons or histories on the left, an explicitly all-time provider instrument on the right. The two columns become one on narrow screens. Window controls belong inside the panel they affect. Tables scroll inside their own panels rather than widening the document.

Keep related controls together, with generous separation between tasks. Interactive team links, provider choices and segmented controls have at least 44px target height. The chart legend is bounded to four named teams plus Other, while the reported total covers every team in the view.

## Elevation & Depth

The analytics surface uses a defined edge and tonal layering. The horizon is geometric data artwork, with proportional arcs and calibration marks. Motion stays concentrated in the decorative arrival black hole, which pauses offscreen and under reduced motion; analytics remain readable at rest.

## Shapes

Preserve the original optical eclipse marks at their intended sizes. Functional icons are authored SVG with a consistent 24-unit view box, 1.5-unit strokes, square caps and round joins. Provider logos retain their official constructions. Team identity uses an uploaded logo or the same two-character monogram rule across public pages, invitations and share cards.

## Components

- **Public exploration navigation:** Models and Community share an anchored panel that moves between triggers. Native links support copying and modified clicks; a direct Teams destination stays visible. Compact menus reveal the same groups inline. Escape returns focus to the trigger; reduced motion removes movement.
- **Sign-in entry:** landing, documentation and blog headers keep a visible “Sign in” link outside collapsed menus, with a minimum 44px target height and a matching original entry SVG beside the text. Use the canonical `/login` route on the Worker and a relative login alias that preserves the site base on static mirrors. The signed-in SPA account menu remains authoritative. Connect and OAuth consent headers link to their embedded authentication section on the current page, preserving the authorization flow and its request state.
- **Icon actions:** compact destination and utility actions share `.th-icon-action` and the `TokenHorizonActions` renderer. Each action has a minimum 44×44px target, an original SVG, a persistent accessible name and a detailed description. Hover/focus reveals one shared tooltip; a normal touch tap acts immediately, while a stationary 450ms hold reveals help. Keep radio, mode, window and filter choices visibly labelled.
- **Teams directory introduction:** the compact heading and standings lead. “About teams” reveals the decorative introduction, with both open and closed preferences remembered locally. Closed introductions load no scene runtime, and closing cancels pending mounts and disposes the scene.
- **Single-choice controls:** labelled radio groups, one tabbable selected choice, arrow/Home/End selection and focus retained after panel replacement. Use visible labels rather than icon-only mode controls.
- **Provider horizon:** actual all-time provider proportions, a persistent selected provider name/count/share, keyboard-selectable rows and a separate model-catalog link. It must never imply that the history window affects provider totals.
- **Comparison / Over time:** the community toggle preserves comparison settings. History supports 7, 30 and 119 UTC days; its URL records the mode and window. Lines use published daily records, straight segments and gaps for unreported days; explicit reported zeroes stay zeroes.
- **Day inspector:** a native range input, persistent exact UTC date and counts, a jump to the real peak day, and an accessible daily-values table. Inspection updates readings without remounting the chart. Unknown values say Not reported.
- **Charts and effects:** reuse the locally vendored chart runtime, content-keyed definition cache and bounded host pool. Missing runtime has an SVG fallback. Decorative 3D failure retains a static eclipse and hides its unavailable animation control.

### Shared icon actions

Teams uses a small original action vocabulary. The shared [icon-actions.js](docs/icon-actions.js) renderer and [horizon-system.css](docs/horizon-system.css) implement it. Rankings and Analytics reuse the editable kit vectors; the remaining silhouettes are authored in the same 24-unit geometry, with 1.5-unit strokes, square caps, round joins and `currentColor`. The SVG is decorative; the link or button owns the accessible name.

| Action | Symbol | Detailed help communicates |
| --- | --- | --- |
| Rankings | Original [Leaderboard podium](token-horizon-design-system/assets/icons/leaderboard.svg) | Jump to the team standings; ranks use all-time published token totals. |
| Analytics | Original [Usage bars](token-horizon-design-system/assets/icons/usage.svg) | Jump to usage comparisons or daily history; provider totals remain all time. |
| Your crew | Two-person silhouette | Open the current account's private crew controls; membership and publishing are separate. |
| Create your crew / Invite friends | Person with plus | Create a crew or open invitations, according to the current account's actual capability; sign-in is required when applicable. |
| About teams | Circled information mark | Show or hide the introduction without changing public data. |
| Share team | Export/share arrow | Open the public profile sharing tools; a public profile link differs from a membership invite. |
| Close introduction | Crossed strokes | Close the introduction and stop its decorative runtime. |

Destination actions remain real `<a href>` links, including anchors and current shareable query values. Resolve them against the deployment's actual site base so Worker routes and static project mirrors agree. Links retain native modified-click, copying and browser-history behavior. Buttons perform operations or toggle existing disclosures; their `aria-expanded` and `aria-controls` reflect the real state. Do not apply toolbar arrow-key behavior to an ordinary action row: Tab reaches each action, Enter activates links, and Space/Enter activate buttons.

Give every action a concise `aria-label` and an `aria-describedby` reference to persistent detailed text. The description is available to assistive technology when the visual tooltip is closed. The tooltip repeats the action name before its detail and uses readable body type, semantic surface/ink/rule tokens and no tracked eyebrow. A single portal avoids clipping inside panels; clamp and flip it within the viewport. Its content is hoverable, remains visible while the trigger or tooltip has hover/focus, and dismisses on Escape, outside activation, navigation or removal. Escape hides help without activating the action or moving focus. Do not place links or other interactive controls inside a tooltip.

On touch, the first normal tap always activates the actual action. A stationary press-and-hold of 450ms opens the same detailed tooltip and suppresses only the activation caused by that hold; a later normal tap works immediately. Cancel the hold on drag or pointer cancellation and preserve native scrolling. Help remains visible until another action, outside tap or dismissal; it never becomes a mandatory first-tap gate. Reduced motion removes tooltip movement. Essential destinations and operations remain available without tooltip JavaScript.

Gamma's InsightChart, ElasticSegment, MorphTabs and InstrumentWatch informed interaction principles. The implementation is independently authored vanilla JavaScript/CSS/SVG; provenance and the image concept are recorded in [.impeccable/concepts/README.md](.impeccable/concepts/README.md).

## Do's and Don'ts

- Put publication scope, UTC window and partial-coverage caveats beside the measurement.
- Preserve the distinction between team membership, published profiles and profiles reporting a window.
- Describe token volume as activity; do not imply productivity or invent missing measurements.
- Preserve the horizon signature, semantic theme roles, official provider marks and consistent original icons.
- Use an image concept first for future new surfaces, as requested by the user. Treat concept values as illustrative and implement meaningful visuals in code.
- Keep prompts and local traces private under the product's existing rules. Decorative effects must not delay public data or authentication.
