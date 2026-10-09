# Token Horizon design system

**Quiet precision:** mineral white, graphite, controlled mint, crisp rules, extended technical typography and a signature eclipse seam.

Open [index.html](index.html) for the browsable manual. It includes light/dark themes, downloadable SVGs, live component specimens, a replayable notch entrance, reduced-motion preview and the generated concept gallery.

For browser preview, serve this directory locally:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 --directory token-horizon-design-system
```

Then visit [the local manual](http://127.0.0.1:4174/).

## Deliverables

| File | Purpose |
| --- | --- |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Brand, typography, materials, accessibility, component behavior, motion and adoption rules |
| [tokens.css](tokens.css) / [tokens.json](tokens.json) | Scoped, reusable light/dark semantic tokens |
| [concepts/01-direction.png](concepts/01-direction.png) | Master art-direction board |
| [concepts/02-surfaces.png](concepts/02-surfaces.png) | Model explorer, notch, widget and leaderboard visual concepts |
| [concepts/03-identity.png](concepts/03-identity.png) | Custom lettering study, optical marks and iconography concept |
| [assets/event-horizon.png](assets/event-horizon.png) | Standalone text-free hero artwork, 1983 × 793 |
| [concepts/05-connection.png](concepts/05-connection.png) | ASCII/dither connection concept and motion storyboard |
| [concepts/06-workspace.png](concepts/06-workspace.png) | Observability workspace concept; [built-in imagegen prompt](prompts/06-workspace.txt) |
| [assets/icons/](assets/icons/) | Eighteen original, editable 24-unit SVG icons |
| [assets/mark-16.svg](assets/mark-16.svg), [mark-24.svg](assets/mark-24.svg), [mark-64.svg](assets/mark-64.svg) | Original eclipse mark at three optical sizes |
| [fonts/](fonts/) | Unmodified Hubot Sans variable font and existing JetBrains Mono, with licenses |
| [contrast.json](contrast.json) | Calculated core token contrast ratios |
| [manifest.json](manifest.json) | Asset provenance, dimensions and checksums |

The images were created using **built-in imagegen**, not the CLI/API fallback. The five final prompt files are [01-direction](prompts/01-direction.txt), [02-surfaces](prompts/02-surfaces.txt), [03-identity](prompts/03-identity.txt), [04-event-horizon](prompts/04-event-horizon.txt) and [05-connection](prompts/05-connection.txt). A targeted [surface refinement](prompts/02-surfaces-refinement.txt) corrected the generated navigation labels.

The raster lettering is a custom wordmark study, not a new installable font. The live typography uses the licensed [Hubot Sans](https://github.com/github/hubot-sans) family with a distinctive width/weight treatment. Concept-board copy, data and layouts are illustrative; use the specification for implementation.

The reviewed web guidance lives in [DESIGN.md](../DESIGN.md), with the [Teams surface brief](../.impeccable/surfaces/docs-leaderboard-html.md) recording its application. The web implementation uses [horizon-system.css](../docs/horizon-system.css), [theme.css](../docs/theme.css) and [surfaces.css](../docs/surfaces.css), shared by the landing page, public model explorer, community leaderboard and worker-generated connector/consent pages. The landing page opts in with `body.landing`; public discovery uses `body.discovery`; the observability workspace uses [workspace.css](../docs/workspace.css). Device wallpaper is served as an optimized WebP derivative. Page-specific styles continue to own layout and the 72px virtual model rows.

The shared Teams icon-action pattern in [production icon-actions.js](../docs/icon-actions.js) reuses [leaderboard.svg](assets/icons/leaderboard.svg) and [usage.svg](assets/icons/usage.svg), with matching original crew, invite, information, share and close glyphs authored in production code. Every action has a 44×44px minimum target, a persistent accessible name/description and detailed hover/focus help. A normal touch tap acts immediately; a 450ms hold reveals help without activating that held action. Modes and filters keep visible text. See [the specification](DESIGN_SYSTEM.md#shared-web-icon-actions) for the complete behavior contract.

These are developer references for the local manual and production components. They do not add a design-system destination to public product navigation. The root `token-horizon-design-system.zip` is refreshed from this working directory; concept imagery keeps its original 27 September provenance.

## Refresh the working component kit

The [icon-action specimen](index.html#icon-actions) runs the same renderer and styles as the live Teams toolbar. The bundled files in `components/` are generated from the canonical web sources. After changing those sources, run:

```sh
python3 scripts/package-design-system.py
```

Run this from the repository root. It refreshes the editable action SVGs, component copies, manifest checksums and `token-horizon-design-system.zip`. The archive includes the standalone interactive specimen and the updated interaction guidance; generated concepts retain their original provenance.
