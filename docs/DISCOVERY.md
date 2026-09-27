# Public leaderboard and model directory

The accepted desktop references are
`../token-horizon-ui-kit/mockups/token-horizon-leaderboard-desktop.png` and
`../token-horizon-ui-kit/mockups/token-horizon-models-desktop.png`.
The static SPA remains `leaderboard.html`; `discovery.css` applies the public
palette only to the leaderboard and model routes. No dependencies were added.

## Design alignment

Compared the rendered pages with both approved images:

1. Graphite horizontal navigation, ivory canvas, mint selections and actions.
2. Left-aligned headings, concise supporting text, and tabular numeric columns.
3. Community summary strip, searchable ranking table, league/community sidebar.
4. Model tabs, search/sort, left filters, compact rows and a right inspector.
5. Removable model selections in a floating comparison tray with a real dialog.
6. The generated community orbit asset is reused from the landing asset set.

Intentional differences: real published entries replace mockup names and values;
summary tokens/requests are labeled all-time because that is the API contract.
The existing seven league badge assets replace the mockup's progress dots.
Activity sits below the ranking table so a small community does not create an
empty full-width block. Provider colors remain recognizable in stacked charts.
Workspace and sign-in preserve access to existing analytics/account features.
The inspector retains all existing pricing, benchmark, adoption and listing
information. Benchmarked picks and community highlights are disclosures.
The provider filter is a select suited to the actual 170+ provider catalog.

## Interaction and data

- Ranking periods request the existing API; period deep links survive reload.
  Team/league/search filter the full community payload locally. Search/sort only
  refresh the table and preserve chart hosts. More metrics expands the table.
- The model source remains the app-exported catalog. Fuse relevance, primary
  listing dedupe, TanStack column sorting, provider/plan filters and cross-links
  remain in the client. Static model redirects preserve query parameters.
- Select 2–4 models to compare. Selections survive filtering and remain only in
  memory. The comparison shows direct published prices, context, capabilities,
  benchmark source and subscription coverage; unknown prices stay unavailable.
- Virtual rows are 72px at every breakpoint, matching all `MX_ROW_H_*` constants.
  The list scrolls horizontally on small screens and the filter panel collapses.
- The inspector docks at 1300px+. Below that it locks scrolling, moves/traps
  focus, closes on Escape and restores focus. The comparison uses native dialog
  modality. Reduced motion removes transitions. A skip link reaches main content.
- Existing personal dashboards retain their dark theme. Prompt privacy and
  publishing/authentication behavior are unchanged. An anonymous visitor is
  never identified as the first ranked publisher.

## Validation

`node --test cloudflare/worker.test.mjs`: all 35 tests pass.
`node scripts/test-leaderboard-ui.mjs`: existing route, profile, sharing, auth,
model search/sort/deep-link, plans and cheapest tests pass. Added checks for
community filters, period reload, anonymous identity, 4-model comparison cap,
selection persistence/removal, dialog focus, mobile controls and reduced motion.
`node scripts/bench-leaderboard.mjs`: all budgets pass using 120 builders and
3,000 models; 20 initial model rows, 33 after deep scroll, zero extra chart
mounts, approximately 141ms model search and 126ms builder search on this run.

Browser inspected at 1440px and 390px with public read-only API data. No
horizontal document overflow at either width. The live API currently has one
published builder and its catalog has no plan cards; the hermetic regression
fixtures separately exercise plans and multi-builder states. Screenshots are
kept in `/tmp`, not shipped as application assets. Released to https://token-horizon.dev on 2026-09-27. Connector deployment and validation are documented in `../cloudflare/CONNECTOR.md`.
