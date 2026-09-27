# Token Horizon — high-fidelity UI and asset kit

Three desktop UI concepts and three individually generated reusable assets. Generated with the built-in image_gen tool. PNG masters and lossless WebP exports are included; the source wireframes remain in the separate `token-horizon-wireframes-images` folder.

## UI mockups

| Page | Preview / WebP | PNG master | Dimensions |
|---|---|---|---|
| Landing | [Open](mockups/token-horizon-landing-desktop.webp) | [PNG](mockups/token-horizon-landing-desktop.png) | 1536×1024 |
| Leaderboard | [Open](mockups/token-horizon-leaderboard-desktop.webp) | [PNG](mockups/token-horizon-leaderboard-desktop.png) | 1536×1024 |
| Model explorer | [Open](mockups/token-horizon-models-desktop.webp) | [PNG](mockups/token-horizon-models-desktop.png) | 1536×1024 |

These are raster design references, not functional screens or screenshots of the current app. Implement text, controls, tables, charts and layout as accessible HTML/CSS backed by the existing APIs. Do not ship the whole mockup as a webpage.

The mockups use readable sample content rather than skeletons. The leaderboard participants, teams, activity, dates and statistics are fictional. Its league names preserve Bronze, Silver, Gold, Platinum, Diamond, Master and Grandmaster. The model explorer uses selected values from the repository's existing catalog at generation time; this is a snapshot, not a current pricing assertion. Other landing preview data and quota limits are illustrative. Never encode those generated values as actual plan entitlements or production analytics. Provider initials are layout stand-ins; use the repository's existing provider marks in implementation.

## Individual assets

| Asset | PNG master | WebP | Dimensions | Use |
|---|---|---|---|---|
| Horizon artwork | [PNG](assets/token-horizon-horizon-art.png) | [WebP](assets/token-horizon-horizon-art.webp) | 1536×1024 | Product wallpaper, dark hero or editorial section background |
| Laptop cutout | [PNG](assets/token-horizon-laptop-cutout.png) | [WebP](assets/token-horizon-laptop-cutout.webp) | 1536×1024 | Product preview frame; exterior has alpha, screen is blank ivory |
| Community orbits | [PNG](assets/token-horizon-community-orbits.png) | [WebP](assets/token-horizon-community-orbits.webp) | 1254×1254 | Community invitation, onboarding or empty-state illustration |

Both cutouts contain verified alpha transparency, preserved in WebP. These are separate generated assets, not crops of the UI mockups. Use `object-fit: contain` for cutouts so the silhouette is not clipped. For the laptop, position an actual screenshot inside the display and preserve the top-center notch; the screen area is not a transparent hole. Match by measurement when composing, rather than stretching the whole screenshot to the outer device bounds. The horizon is opaque and works best on a dark surface, with copy placed outside its brightest ring.

The laptop is unbranded. The sphere illustrations are decorative artwork, not replacement identity marks. Retain the existing Token Horizon identity and provider logos.

### HTML examples

Paths below assume this kit remains in the repository root; adapt paths to the final asset location.

```html
<!-- Decorative asset accompanying an already labeled invitation. -->
<img src="./token-horizon-ui-kit/assets/token-horizon-community-orbits.webp"
     width="1254" height="1254" alt="" loading="lazy" decoding="async"
     style="max-width:20rem;width:100%;height:auto;object-fit:contain">

<!-- Standalone product frame, to be composed with a real product screenshot. -->
<img src="./token-horizon-ui-kit/assets/token-horizon-laptop-cutout.webp"
     width="1536" height="1024"
     alt="Front-facing graphite laptop with a blank ivory display and a camera notch."
     decoding="async" style="display:block;max-width:100%;height:auto">
```

Use empty alt text for purely decorative placement. If an asset itself carries relevant content, use the descriptive alt text in `manifest.json`. Do not lazy-load an above-the-fold hero if it is the page's largest visible image. Set intrinsic dimensions to avoid layout shift.

## Design handoff

- Graphite #101714, ivory #E9EEE8, mint #A9E8BC; dark green #236345 for interactive text and focus. Mint is for fills/selection, not small text on ivory.
- `tokens.css` provides opt-in, scoped starting values. Font stacks are implementation suggestions; the generated typography is not an exact font specification.
- Public navigation: Models, Leaderboard, Docs, GitHub and Install. Preserve existing deep links and authentication return paths.
- Landing: clear product explanation and installation action, accurate demo preview, community/catalog discovery, explicit optional sharing.
- Leaderboard: rankings first, compact league explanation, honest sparse/empty states; do not label an anonymous visitor as a participant.
- Models: explicit input/output price units, visible filters, model detail drawer and proposed comparison tray. Preserve primary-listing deduplication, plans, relevance order and windowed rendering. Plan-covered models must not display per-token prices.
- Keep real text and charts in code; use the standalone imagery only where imagery is appropriate. Retain existing vendored search/chart/avatar assets and exported catalog pipeline.

## Provenance and validation

`manifest.json` records actual dimensions, formats, byte sizes, transparency, alt text and prompt filenames. `prompts/` contains every full generation prompt and the targeted leaderboard label correction. Images were visually inspected; exports were decoded and dimensions and cutout alpha were checked. At the time the original kit was generated, these were unimplemented concepts. The landing implementation and its validation are documented below; the other concepts remain references. No production deployment has been performed.

## Landing implementation

The landing concept is now implemented in `docs/index.html`, `landing.css` and
`landing.js`, with optimized asset copies in `docs/assets/landing/`. It includes
an interactive seven-scene product tour and widget feature previews. See
[`docs/LANDING.md`](../docs/LANDING.md) for the design differences, routing and
validation record; `implementation/` contains browser screenshots. The
leaderboard and models images remain design references. The original archive
contains the design kit; the implemented page is in the repository workspace.
