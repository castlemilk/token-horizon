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
| [assets/icons/](assets/icons/) | Twelve original, editable 24-unit SVG icons |
| [assets/mark-16.svg](assets/mark-16.svg), [mark-24.svg](assets/mark-24.svg), [mark-64.svg](assets/mark-64.svg) | Original eclipse mark at three optical sizes |
| [fonts/](fonts/) | Unmodified Hubot Sans variable font and existing JetBrains Mono, with licenses |
| [contrast.json](contrast.json) | Calculated core token contrast ratios |
| [manifest.json](manifest.json) | Asset provenance, dimensions and checksums |

The images were created using **built-in imagegen**, not the CLI/API fallback. The five final prompt files are [01-direction](prompts/01-direction.txt), [02-surfaces](prompts/02-surfaces.txt), [03-identity](prompts/03-identity.txt), [04-event-horizon](prompts/04-event-horizon.txt) and [05-connection](prompts/05-connection.txt). A targeted [surface refinement](prompts/02-surfaces-refinement.txt) corrected the generated navigation labels.

The raster lettering is a custom wordmark study, not a new installable font. The live typography uses the licensed [Hubot Sans](https://github.com/github/hubot-sans) family with a distinctive width/weight treatment. Concept-board copy, data and layouts are illustrative; use the specification for implementation.

The web implementation lives in `docs/horizon-system.css`, shared by the landing page, public model explorer, community leaderboard and the worker-generated connector/consent pages. The landing page opts in with `body.landing`; public discovery uses `body.discovery`; the observability workspace uses `docs/workspace.css` with mineral content and graphite navigation. Device wallpaper is served as an optimized WebP derivative. Page-specific styles continue to own layout and the 72px virtual model rows.
