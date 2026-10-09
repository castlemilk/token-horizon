# Token Horizon — Quiet precision

Version 1.0 · 27 September 2026 · Web icon-action guidance reviewed 2 October 2026

Token Horizon makes a complex AI workspace legible. Its identity should feel like a precise instrument: confident numbers, clear boundaries, a controlled light signal, and space to think. The event horizon gives this system its own visual signature.

This kit establishes the art direction and reusable foundations. The generated boards explore appearances; this specification, the SVGs and the semantic tokens govern implementation. Product mockups contain illustrative data and exploratory layouts.

## Design principles

**Clarity.** Lead with the useful value, then its unit, time window and freshness. Keep an explanation within reach. Never let a dramatic visual obscure a permission, price or status.

**Continuity.** Carry the same eclipse geometry, type hierarchy and state colors across web, desktop, widgets and the notch. Adapt density and interaction to the surface.

**Control.** Make selected, focused, stale and unavailable states unmistakable. Motion explains a transition and settles. A denied permission or disconnected provider is a comprehensible state with a next action.

Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/foundations) are the platform reference for native behavior. Token Horizon supplies its own identity. The rules below are project decisions, not a claim of Apple certification.

## Identity

The **horizon seam** is the signature: one horizontal interruption in a circular form. Use it in the mark, a reveal transition or a single editorial divider. It should not become a texture across every control.

Three original SVG constructions are included:

| Asset | Use | Optical adjustment |
| --- | --- | --- |
| `assets/mark-16.svg` | Favicon, dense compact identity | Two-pixel open seam, no orbit |
| `assets/mark-24.svg` | Navigation, app chrome | Clear seam, no fine orbital detail |
| `assets/mark-64.svg` | Brand lockups, larger introductions | Thin tilted orbit, enlarged silhouette |

Use `currentColor` for a one-color mark. Maintain clear space of at least one quarter of the disc diameter. Use a single color with sufficient contrast; do not add gradients to the functional mark. Never distort the circle or animate it continuously in navigation.

The generated **Horizon Lettering** study proposes a slightly extended wordmark with a modified first “o”. It is a lettering concept, not a complete custom font. The live manual uses real Hubot Sans lettering paired with the custom eclipse symbol. Do not extract small raster letters from a concept board for production.

Brand spelling is always **Token Horizon**, with a space in accessible text. Editorial phrases in generated artwork, incidental dates, provider/model associations and prices are not approved product copy.

## Typography

The distinctive display treatment is **Hubot Sans at 112% width**, weight 600, with tight but readable spacing. The actual font is locally bundled, unmodified, with its SIL Open Font License. It is a third-party typeface; the treatment, pairing and symbol form the bespoke system.

| Role | Family | Size / line height | Weight / width | Tracking |
| --- | --- | --- | --- | --- |
| Marketing display | Hubot Sans | 72–112 / 1.02; 44–64 on mobile | 600 / 112% | −0.045em |
| Page title | Hubot Sans | 40 / 1.1; 32 on mobile | 600 / 105% | −0.035em |
| Section heading | Hubot Sans | 28 / 1.15 | 600 / 100% | −0.02em |
| Primary metric | Hubot Sans | 40–56 / 1.05 | 600 / 100% | −0.035em |
| Body / help text | Platform system sans | 16 / 1.5 | 400 / normal | 0 |
| Dense desktop table | Platform system sans | 14 / 1.45 | 400–600 | 0 |
| Technical value | JetBrains Mono | 12–14 / 1.5 | 400 | 0 |
| Editorial eyebrow | JetBrains Mono | 11 / 1.5 | 400 | +0.12em |

Use the small eyebrow only for optional supporting metadata. Critical instructions and consent text stay at readable body sizes. Do not apply uppercase tracking to paragraphs. Use tabular lining figures for totals, ranks and prices; align numbers to the right and names to the left.

Native surfaces retain system text styles and support the platform's text-size/accessibility settings. The display font is appropriate for brand moments and key metrics, not a replacement for every native control label. Allow text to grow and wrap before truncating meaningful state.

Hubot Sans source: [github/hubot-sans](https://github.com/github/hubot-sans), pinned at `d4b2f67cd7686f5907296d3f027112bbc4f69f42`. The included TTF axes were inspected: width 80–120, weight 200–900, italic 0–1. CSS declares these actual ranges. JetBrains Mono is copied from the repository's existing licensed font asset. Both licenses are in `fonts/`.

## Color and material

| Primitive | Value | Purpose |
| --- | --- | --- |
| Void | `#070A08` | Immersive artwork, deepest native chrome |
| Graphite | `#121714` | Main ink, dark panels |
| Forest | `#235E43` | Light-theme actions and emphasis |
| Signal | `#B6F2CF` | Dark-theme actions and selected emphasis |
| Titanium | `#CDD3CC` | Decorative rules on light backgrounds |
| Mineral | `#F3F4EF` | Main light canvas |

Components consume semantic tokens such as `--th-ink`, `--th-action`, `--th-selected` and `--th-control-border`. Do not hardcode primitives inside interactive components. Light and dark themes have independent semantic values.

Use mineral or opaque white for information surfaces. Use graphite for the notch and quiet dark panels. A surface does not need a shadow to establish hierarchy. Reserve the floating shadow and 20px radius for menus, widgets and transient panels.

Use platform materials on native floating chrome when they retain contrast; honor Reduce Transparency with opaque surfaces. Tables, permission forms and model pricing remain opaque. Use a solid fallback before a web blur loads or when blur is unavailable.

Titanium rules divide already identifiable regions. They are too subtle to identify an input by themselves: use the stronger control-border token for interactive boundaries. Mint on white is decorative only; use Forest for readable text and active controls.

### Measured contrast

Ratios are calculated from exact solid-color sRGB token pairs; see `contrast.json`.

| Pair | Ratio |
| --- | ---: |
| Graphite on Mineral | 16.40:1 |
| Light secondary text on Mineral | 5.71:1 |
| White on Forest button | 7.63:1 |
| Dark secondary text on Graphite | 8.58:1 |
| Graphite on Signal button | 14.32:1 |
| Light control boundary on white | 3.81:1 |
| Dark control boundary on Graphite | 4.78:1 |

These checks cover the listed pairs, not arbitrary artwork backgrounds or a full accessibility audit. Test composed screens as they are implemented.

## Geometry and layout

Use a 4px spacing base: **4, 8, 12, 16, 24, 32, 48, 64, 96**. Pair compact interior spacing with more generous space between sections. Default control radius is **6px**, panel radius **12px**, floating radius **20px**. Pills are for genuinely segmented or compact status controls, not every container.

Use 1 CSS-pixel rules at web scale; native strokes align to the device pixel grid. The notch follows the physical screen contour and can use its own 24px lower corners.

For the web, start with 24px mobile gutters, 32px tablet gutters and 48–64px desktop gutters. Use 12 columns on wide pages and collapse to a single useful reading order on mobile. The comparison table may scroll horizontally inside its own labeled region; the page itself must not overflow.

Controls have a 44px minimum interaction area in this system, including icon-only controls. The visible glyph can remain 16–24px. Dense desktop rows start at 56px, expanding for larger text and multi-line values.

## Iconography

The kit includes seventeen original SVGs: Usage, Models, Leaderboard, Limits, Traces, Sessions, Widgets, Notch, Connect, Privacy, Settings, Engine, Crew, Invite, About, Share and Close.

- 24 × 24 viewBox; 1.5-unit stroke; square caps and softened joins.
- Work within the 2–22 coordinate region, with small optical allowances.
- Prefer one recognizable silhouette and at most two internal details.
- At 16px, simplify detail instead of shrinking the full grid blindly.
- Use an adjacent visible label when the meaning may be unfamiliar. The compact Teams action row uses the shared named-and-described icon-action pattern below; mode, range and filter choices retain visible text.
- In labeled controls, inline SVGs are decorative: `aria-hidden="true"`.
- Icon-only buttons require a meaningful accessible name and focus state.
- A selected icon uses the semantic action color and a separate selection indicator.

SVGs use `currentColor` and can be inlined or used through a sprite. An SVG loaded as an `img` does not inherit the surrounding CSS color; inline it for theme-aware coloring. Keep downloads as individual files. The concept board is visual inspiration; the vector assets are the editable icon source.

## Component and data behavior

**Purpose and scope:** every view states its task, whose data it shows and its supported next action. Distinguish verified-owned profiles, explicit public previews and community aggregates. Personal/account destinations never fall back to the first community row or community totals.

**Meaningful states:** name the actual loading step and identify request failures. Declare empty only after a successful request; offer the relevant setup, publication or recovery action. Preserve valid snapshots during refresh failures. Unknown or pending values are unavailable, not zero or sample measurements. Controls must perform real supported actions; local UI preferences must not masquerade as server-enforced permissions.

**Workspace and account views:** Workspace analyzes published snapshots, without reading live/private device telemetry. Signed-out visitors get Sign in; sign-in discovers verified-owned profiles without publishing or claiming them. A verified empty account gets publication/account-linking guidance; one profile opens directly and multiple profiles require intentional selection. Public previews identify their handle and scope. Remove promotional feature cards and invitations from Workspace analysis. Model costs opens its Models & costs section for the selected profile; Report sharing requires verified-owned choice before private reads. Do not render fake local Default Sharing Rules or unsupported Comment/Edit permission matrices.

**Buttons:** a single dominant action per local task; an outlined or text secondary action; a visible focus outline; explicit disabled and pending states. Never make permission approval the only obvious way out.

**Inputs:** persistent label above, helper text below, error tied to the field with `aria-describedby`. Error messages describe the recovery action. Do not use placeholder text as the sole label.

**Navigation:** the active destination has both a shape/rule and color. Separate navigation destinations from filter controls. Preserve the actual route and information architecture of each product surface.

**Sign-in entry:** landing, documentation and blog headers keep a persistent “Sign in” link outside collapsed menus, with a minimum 44px interaction height. Pair its visible text with the decorative original [Sign in SVG](assets/icons/sign-in.svg) following the 24-unit, 1.5-stroke, square-cap system. The Worker destination is canonical `/login`; static mirrors use a relative login alias that preserves their deployment base. The SPA's authenticated account menu remains authoritative. Connect and OAuth consent use a same-page link to the embedded authentication section instead, retaining the authorization request and consent flow.

### Shared web icon actions

Compact Teams destination and utility actions use `.th-icon-action` through the shared `TokenHorizonActions` renderer in [production icon-actions.js](../docs/icon-actions.js), styled by [production horizon-system.css](../docs/horizon-system.css). The reviewed [web guide](../DESIGN.md) and [Teams surface brief](../.impeccable/surfaces/docs-leaderboard-html.md) specify the surface application. Use a minimum 44×44px interaction area with a 24-unit, 1.5-stroke, square-cap, round-join SVG in `currentColor`; preserve a visible focus boundary and semantic theme roles.

| Meaning | Original construction | Description must explain |
| --- | --- | --- |
| Rankings | [Leaderboard podium](assets/icons/leaderboard.svg) | All-time standings from published profiles. |
| Analytics | [Usage bars](assets/icons/usage.svg) | Comparisons/daily history and the independent all-time provider scope. |
| Your crew | Authored two-person silhouette | The current account's private crew controls, distinct from public standings and analytics. |
| Create / Invite | Authored person-plus | The capability supported for the current account and any required sign-in. |
| About | Authored circled information mark | The introduction's current show/hide action. |
| Share | Authored export/share arrow | Public profile sharing, distinguished from a membership invitation. |
| Close | Authored crossed strokes | The specific surface being closed. |

SVGs are decorative. The native link or button owns a concise `aria-label` and an `aria-describedby` reference to persistent detailed text, available independently of the visual tooltip. Real destination links retain actual routes, anchors, query state, modified clicks and copying across Worker and static-mirror deployments. Operations remain buttons; disclosures carry `aria-expanded` and `aria-controls`. Tab visits each action normally. Radio/mode/filter controls retain their visible text and existing keyboard behavior.

One shared, viewport-clamped tooltip portal shows the action name and detailed text on hover/focus. Use readable body type and an opaque semantic surface. Content stays visible while the trigger or tooltip is hovered/focused and can be dismissed with Escape without moving focus. Close on outside activation, navigation and trigger removal. Tooltip content is text-only; interactive content requires a different disclosure pattern.

Touch taps perform the actual action immediately. A stationary 450ms press-and-hold reveals the same help and suppresses only that hold's activation; dragging or pointer cancellation cancels the hold while native scrolling remains available. The tooltip remains readable until outside activation or another dismissal, and the next normal tap acts immediately. Do not require a first tap to reveal help before an action can work. Under reduced motion, show and hide without movement. Native controls continue to work when tooltip JavaScript is unavailable.

Verify focus, Escape, hover into content, viewport placement, first-tap activation, held-touch help, cancelled holds, dynamic account names/descriptions and native links. These are implementation acceptance criteria; an SVG or raster concept alone does not establish accessibility.

### Data and feedback

**Tables:** stable numeric columns; explicit units; sticky headings only when they help; sorting announced through semantic state. A missing value is an em dash with an explanation, never zero. Keep search, row actions and model deep links keyboard accessible.

**Charts:** discrete bars with aligned baselines and flat fills. Prefer at most four named series plus Other. Pair color with legend labels, a tooltip/focus equivalent and an accessible data table. Use the semantic chart palette on each theme; do not depend on a pale mint bar being visible on white. Show the selected time window and time zone. Preserve a user's selection on refresh.

**Data freshness:** label current, stale and unavailable separately. Cached data stays visible with its last-updated time. Placeholders should not look like zero usage. No fabricated measurements in the shipped product; the manual's deterministic sample values are labeled.

**Empty/error states:** preserve the screen's layout and explain the next step. An empty model search offers clearing filters. Disconnected local data offers reconnect/install guidance. Pending requests do not obscure the last valid values.

## Surface recipes

| Surface | Apply the system | Preserve product behavior |
| --- | --- | --- |
| Landing | One hero artwork, extended display headline, useful live-looking demonstrations | Demos clearly identified; real CTA destinations |
| Models | Bright flat comparison canvas, precise pricing, Forest selection | Canonical `/models` stays flat; Explorer / Cheapest / Providers / Plans; search, filters, virtual row-height constants, model drawers and deep links remain |
| Model pricing | Right-aligned amounts with consistent units | App-exported catalog only; plan-covered models never show per-token prices |
| Leaderboard | Rank + person + value + trend; selected self row | Actual periods, privacy preferences, profile links and existing analytics |
| Widgets | One dominant metric, useful chart, clear period controls | Shared WidgetSnapshot contract and existing deep-link interaction |
| Notch | Graphite enclosure anchored to top screen edge | Stable hit areas, existing hover/hysteresis and native behavior |
| Connector | Opaque consent panel beside dither artwork | Actual identity, requested scopes, cancel, errors and revocation path |

The product-surfaces board uses an assembled desktop layout to illustrate the system; its sidebar is not a proposal to add dashboard chrome to the canonical flat Models route. Invented models, dates, associations, prices and controls in raster mockups must be replaced by actual application data and supported actions.

The authorization storyboard illustrates a direction for permission clarity. Its checkbox selection behavior is exploratory: render only choices the actual OAuth implementation supports. Do not imply scope deselection, account switching or additional management capabilities without implementing them. Public data access remains distinguishable from authorization to an individual's data.

## Motion

| Motion token | Duration | Purpose |
| --- | ---: | --- |
| Feedback | 120ms | Hover and press |
| Control | 180ms | Segments, selection, local disclosure |
| Panel | 280ms | Drawer/dialog content |
| Arrive | 420ms | Notch or brand entrance |

Use `cubic-bezier(.2,.8,.2,1)` for arrivals and `cubic-bezier(.4,0,.2,1)` for reversible changes. The manual includes a replayable notch specimen.

**Notch entrance:** reveal from the existing top anchor, then admit the data within it. Keep the surrounding page stable. Avoid spring overshoot that stretches text. Open once on entering a preview; do not replay on every data refresh.

**Black-hole authorization:** arrive from a sparse dither field into a stable eclipse over 420ms. Hold while the user reviews permissions. On approval, give immediate 180ms control feedback; any actual waiting state continues until the request resolves. Success is shown only after actual success. Settle the horizon once, accompanied by a labeled success state. Errors return attention to the form.

**Dither language:** use monochrome characters or a regular ordered-dot grid, a legible disc silhouette and one horizontal seam. Keep artwork separate from permission text. On small screens it can collapse to a static compact mark.

**Reduced motion:** replace movement, particle fields and dimensional expansion with an immediate final static state. Keep all content and feedback. A branded animation must never impose a delay on authentication. Stop animation work on detach, dismissal, hidden documents or offscreen content. Do not render a continuous animated black hole in every widget.

The browser manual respects system reduced-motion preferences and offers an explicit static-preview checkbox. It uses finite CSS animations and no continuous animation loop.

## Art direction

Signature artwork is a silver-mint event horizon in a nearly black field. Thin lensing detail gives it physical character. The empty left side in `assets/event-horizon.png` is reserved for live HTML text. Let the artwork carry atmosphere; text, permission state and product data remain real elements.

Use one focal image per major introduction. Crop intentionally with a preserved silhouette; on mobile, darken behind copy or move artwork below it. Avoid loud neon, busy galaxies, scattered glass tiles and provider logos floating in space.

The four concept boards and standalone artwork were generated with the **built-in imagegen tool**. Exact prompts and the targeted navigation refinement are retained in `prompts/`. The clean SVG marks and icon assets were authored separately for reliable reuse.

## Adoption

Start with semantic tokens and font loading, then migrate shared navigation, tables, drawers and buttons. Apply the identity to landing artwork and public pages before adjusting native surfaces. Preserve every existing data contract, filter, privacy default and authentication capability.

Load `tokens.css`, add `data-th-system` to the intended root, and set `data-theme="light"` or `"dark"`. Definitions are opt-in; they do not change existing production pages by themselves. The JSON export carries the same CSS values; resolve `var(...)` aliases when mapping to native colors.

Verify text scaling, keyboard focus, VoiceOver order, mobile overflow, empty/error states, contrast over actual materials, and reduced motion in each implemented surface. Pixel-perfect raster text is not the acceptance criterion; coherent behavior and the written system are.
