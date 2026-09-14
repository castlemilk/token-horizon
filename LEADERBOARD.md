# Token Horizon — Objective vs Current State

How the leaderboard/dashboard works end-to-end, what each mockup screen asked
for, what shipped, and where reality deviates. Keep this in sync when changing
the dashboard, the worker, or the published entry schema.

- **Objective**: the nine ChatGPT dashboard wireframes (`Dashboard`,
  `Leaderboard`, `Player Profile`, `Leagues`, `Provider Breakdown`,
  `Share modal`, `Sharing & Access Control`).
- **Current**: `docs/leaderboard.html` (static SPA) + `cloudflare/src/index.js`
  (edge API) + the macOS `UsageEngine`/`LeaderboardStore` publish pipeline.
- **Canonical URL**: <https://token-horizon.dev> (`www` 301s to apex; the
  legacy `tokens.benebsworth.com` serves `/api/*` and 301s browser traffic).

---

## 1. Screen-by-screen alignment

### Screen 3 — Token Usage Leaderboard ✅

| Wireframe element | State | Notes |
|---|---|---|
| Season selector + dates | ✅ | Current season only; snapshots are bounded to 60 days, so past seasons aren't replayable yet |
| Global search / filters | ✅ | Search filters the table; Filters = league + team |
| 4 KPI cards with deltas | ✅ | Deltas come from each entry's snapshot closest to −7d; show "—" until ≥2 days of publishes |
| League Ladder (7 tiers) | ✅ | Clickable tier filter; "You are here" marker; MMR bands 400 pts each |
| Table: Tokens/Input/Output/Cost/Requests/Avg/Req/Trend/Efficiency/Streak | ✅ | All real; Input/Output/Requests are period-scoped (today/all) |
| Top Movers / Most Improved | ✅ | From daily snapshots (rank + cumulative tokens); empty until history accrues |
| Token Usage Over Time | ✅ | **Stacked by model** (TanStack Charts) with rich tooltip + total |
| Usage by Model/Provider donut | ✅ | Provider aggregation across entries |
| Ready-for-higher-league card | ✅ | Real MMR-to-next-tier progress |

### Screen 2 — Player Profile ✅

| Wireframe element | State | Notes |
|---|---|---|
| Hero: avatar, league, MMR, rank, rank Δ, streak | ✅ | League/division derived from MMR; rank Δ from snapshots |
| Tabs: Overview / Usage & Costs / Prompts / Projects / Comparisons / Achievements | ✅ | Six real tabs |
| 8 KPI cards | ✅ | Tokens, Input, Output, Cost, Requests, Avg/Req, Efficiency, Active Days. The mockup's "prompt success rate" is not tracked anywhere, so it is replaced with a real metric rather than faked |
| League progression | ✅ | MMR/rank history from snapshots (empty until ≥2 days) |
| Token usage over time | ✅ | Stacked by model |
| Usage by model/provider, by project/team | ✅ | Real model shares + working-directory rollups |
| Top prompts/workloads, recent activity | ✅ | From published sessions (title, provider, model, tokens, cost, requests) |
| Peer comparison, achievements | ✅ | Percentile/team rank; achievements derived from real thresholds |

### Screen 1 — User Activity Deep Dive ✅

Recent-activity table, GitHub-style calendar heatmap, stacked usage over time,
model donut, cost by project, prompt categories, league activity, achievements,
anomalies. The heatmap renders the trailing 17-week contribution calendar when
more than a week of daily history is published (`breakdown.daily`), falling
back to the weekday × hour grid; anomalies are z-score flags over the published
7-day history; prompt categories are keyword heuristics over session titles.
Prompt/session titles are **private by default** (`leaderboardSharePrompts`,
off) — panels show a privacy note until the owner opts in.

### Screen 4 — Leagues & Season Progression ✅

Tier ladder, "How leagues work" cards, league distribution, season timeline,
season rewards, current standings, top climbers, recent promotions. Climbers
and promotions read snapshots (populate after ~1 week). Placement matches,
decay, and relegation are explanatory copy only — there is no enforcement job.

### Screen 5 — Provider Usage Breakdown ✅

KPI cards, provider-over-time stacked area, provider mix donut, usage by team,
comparison table, insights. **Latency and
success-rate columns are omitted**: no telemetry source exists for them, and
the earlier UI fabricated those numbers. Cost/1M is real.

### Screen 6 — Share Usage Report modal ✅

Scope cards (only me / people / group / org / public), audience + groups,
six privacy options, public link + expiry, "who will have access", settings
summary, and a real `POST /api/share/create`. The preview thumbnail is a
stylized placeholder rather than a live mini-chart.

### Screen 7 — Sharing & Access Control ✅

Active/internal/public share counts, shared-items table with revoke, groups
CRUD, recent activity log, permissions matrix (documentation), and
"Default Sharing Rules". The rules persist client-side and seed new shares;
they are not enforced by an admin backend.

---

## 2. How it works

```
macOS app                          Cloudflare Worker + R2              Browser
─────────                          ──────────────────────              ───────
UsageEngine (parsers)                                              
  ├─ claude/codex/kimi/generic JSONL                              
  ├─ opencode sqlite (stat-gated)                                 
  ├─ ollama proxy store                                           
  └─ engine-state.json v3                                         
        │                                                         
        ▼                                                         
UsageSnapshot                                                     
  tokens/cost/input/output/requests                               
  projects · modelDaily · heatmap                                 
        │                                                         
        ▼                                                         
LeaderboardStore.syncLocal                                        
  league/MMR/division (LeaderboardAnalytics)                      
  efficiency · achievements · seasonTokens                        
  modelHistory (top 8 models + Other)                             
  projects · sessions · 7×24 heatmap                              
        │                                                         
        ▼                                                         
~/.config/token-horizon/leaderboard.json                          
        │                                                         
        │  POST /api/leaderboard  (Bearer LEADERBOARD_SECRET      
        ▼  or verified Google ID token)                           
R2 leaderboard.json ──────────────────────────────────────────────► GET /api/leaderboard
  entry + breakdown                            ranked + kpis + movers + usageHistory
  snapshots[] (daily rank/tokens/providers)    GET /api/user/:handle (full profile)
                                               GET /api/providers · /teams · /season
                                               GET /api/user/:handle
                                               GET /api/providers · /api/teams · /api/season
                                               GET /api/config
                                               GET /api/shared/:id  (public reports)
```

### 2.1 Ingestion (macOS)

- **Parsers** are incremental and stateful per file: additive JSONL
  (claude/generic), codex watermarks, kimi wire, opencode sqlite (stat-gated),
  Ollama loopback relay. Engine state is versioned: **v4** adds per-model daily
  buckets over the trailing 17 weeks; older payloads fail decoding and trigger
  a one-time full reparse.
- **`UsageSnapshot`** carries totals, input/output/request splits, projects
  (working directories), `modelDaily` (trailing 17-week model×day tokens), and
  `recentSessions` (provider/model/tokens/requests).
- **`LeaderboardStore.syncLocal`** is the single aggregation point. It computes
  league/MMR/division, efficiency, achievements, season tokens, the per-model
  daily history window, projects, sessions, and the 7×24 heatmap, then persists
  the local entry to `~/.config/token-horizon/leaderboard.json`.

### 2.2 Publish (app → edge)

- `publishToCloud` POSTs the entry with `Authorization: Bearer
  <leaderboardCloudToken>`. The worker accepts: (a) `LEADERBOARD_SECRET`
  bearer, (b) a verified Google ID token from the owner, or (c) anonymous
  claim-token rules for unclaimed profiles.
- On write the worker derives league/MMR when absent and appends a bounded
  daily snapshot: `{day, tokensAll, tokens7d, costAll, mmr, league, rank,
  providers}` (max 60). Snapshots power movers, rank deltas, league
  progression, and provider-over-time.
- **Monotonic history merge**: `mergeBreakdownHistory` unions incoming and
  stored `modelHistory`/`daily`/`history` days (incoming wins on overlap,
  remote-only days survive, trailing 130 days retained). A fresh client, reset
  engine state, or short local window can never truncate history already
  published for a handle.
- **Change-gated sync** (app side): pulls are TTL-gated, publishes require a
  minimum interval plus a material token delta, and unchanged publishes are
  dropped with a 304 — auto-sync never hammers the edge.

### 2.3 Read APIs (edge)

| Endpoint | Returns |
|---|---|
| `GET /api/leaderboard?period=&team=&league=&historyDays=` | ranked rows (score, input/output/requests, trend, efficiency, rankΔ) + `kpis` (real 7d deltas) + `movers` + `usageHistory` (stacked model series, 7–120 day window) + `season` + `leagueLadder` |
| `GET /api/user/:handle` | full entry + standing/percentile/team rank + achievements + `rankHistory` |
| `GET /api/providers?days=` | provider aggregation, provider-over-time, teams, insights |
| `GET /api/teams` · `GET /api/season` | team rollups · ladder/distribution/standings/promotions |
| `GET /api/config` | public client config (Google client ID, canonical URL, season) |
| `POST /api/profile/avatar` | owner-only avatar update: Google photo, image URL, uploaded data URL (stored in R2), or generated style |
| `GET /api/avatar/:handle` | uploaded avatar bytes (R2, cached 24h) |
| `GET /api/share` | SVG/Markdown/text cards (README badges) |
| `GET /api/health` | storage, edge colo, build info |

### 2.4 Auth & claims

- **Google**: the dashboard signs in with Google Identity Services and sends
  the ID token. When `GOOGLE_CLIENT_ID` is set, the worker verifies RS256
  against Google's JWKS (`aud`/`iss`/`exp`/`email_verified`); the legacy
  `google:<email>` / `body.googleUser` paths are disabled.
- **Claims**: first anonymous publish mints a hashed `claimToken`; `POST
  /api/claim` verifies Google ownership. `ownerId`/`claimTokenHash` are never
  echoed (`sanitizeEntry`).
- **Machine publishing**: `LEADERBOARD_SECRET` bearer, shared with the app's
  cloud token field.

### 2.5 Sharing

- R2 records: `shares/<id>.json`, `shares-index/<handle>.json`,
  `groups/<owner>.json`, `activity/<owner>.json`.
- `POST /api/share/create` requires owner auth (Google or claim token) and
  stores scope, audience, groups, options, expiry. Public links render at
  `/s/<id>` → `GET /api/shared/<id>`, honoring anonymize / hide-cost /
  rounded-token options. Revocation returns 410.

### 2.5.1 Sign-in modal & groups

- Signed-out users get one entry point: the topbar **Sign in** button — and
  every gated action — opens the sign-in modal, a two-column popout with an
  animated ASCII black hole on the left and the Google Identity Services
  button on the right (dev email fallback when `GOOGLE_CLIENT_ID` is unset).
- The ASCII art (`createBlackHole` in `docs/leaderboard.html`) is a small
  Schwarzschild ray tracer: 72×32 character cells integrate null geodesics
  once into a light map (disk-plane crossings + escape stars), then each
  ~30fps frame only re-evaluates the accretion-disk + inbound token-stream
  field. Classic Gargantua look — dark shadow, photon ring, edge-on disk,
  lensed arcs — with tokens (amber) spiralling inward. Static single frame
  under `prefers-reduced-motion`; the RAF loop stops when the modal closes.
  A second 22×9 instance is the sidebar brand mark (`#nav-bh`, 62×40 tile
  beside the name, no-star "clean" render): paused at rest, resumes on hover,
  pauses on leave (shield fallback under 860px).
- `requireSignIn()` stores the attempted action in `state.signInPending`;
  after the credential callback the modal closes and the action resumes
  (New Group, Share New, profile share, claim profile).
- **Groups** now have a real modal (name + @handle chips, leaderboard
  suggestions) replacing the old `prompt()` chain; `POST /api/groups` carries
  the Google credential and the Settings view re-renders after create. The
  signed-out Settings page shows a "Sign in to unlock sharing" banner.

### 2.6 Leagues, MMR, season

`LeaderboardAnalytics.swift` and the worker mirror each other:
token thresholds (Bronze 0–50k … Grandmaster 100M+) define the ladder; MMR
interpolates log-progress inside each 400-point band plus streak/consistency/
diversity bonuses; divisions are within-band thirds; seasons are quarters
anchored at 2026-01-01 (Season 1 — Genesis). Efficiency is a 0–100 composite
of cache-hit rate, output ratio, and free/local share.

### 2.7 Charts, logos & avatars

- `docs/vendor/tanstack-charts.js` is a minified IIFE bundle of
  `@tanstack/charts@0.18.0` (vanilla `mountChart` host), built by
  `npm run vendor` (`scripts/vendor-entry.js` → `scripts/build-vendor.mjs`).
- **Stacked `barY`** + `group-x` focus + structured tooltip (title, color
  rows, total), with **compact axis units** (`1B`/`1M`/`12k` via `fmtTokens`)
  so labels never push the plot off-card. Columns are notch-dense: `barY`
  `inset: 0` and `scaleBand().padding(0.03)` (~1px gaps on 30-day windows; no
  internal gaps between stack segments). If the vendor bundle is unavailable,
  the dashboard falls back to its hand-rolled SVG `stackedArea`.
- **Rich chart legend**: each series renders provider logo + color swatch
  (matching the bar fill) + model name + description (provider label and share
  of the window) + total tokens, in an auto-filling two-column grid.
- **Chart host pool & caching**: definitions are memoized by content key
  (`chartDefs`) and mounted hosts are pooled (`chartPool`, LRU 14). A re-render
  or view switch with identical data adopts the live host element (no scene
  rebuild); only changed data mounts a new host. Diagnostics live on
  `window.__thPerf` (renders, `renderMs`, mounts/reuses/evictions, API
  cache hits, skipped renders).
- **Render/data caching**: GET responses are cached in-memory with the
  worker's `max-age` (30s default) and duplicate in-flight GETs are deduped.
  `loadLeaderboard` fingerprints the payload (FNV-1a); the 30s tick and manual
  refresh skip `render()` entirely when nothing changed. Search/sort swap only
  `#lb-table-wrap` (debounced 120ms), so charts never remount while typing.
  The range pill drives `historyDays=7|14|30|90` on `/api/leaderboard`.
- `task bench-leaderboard` (`scripts/bench-leaderboard.mjs`) is a hermetic
  budget gate: cold-load-to-chart, view-switch median/p95, zero extra chart
  mounts after warm-up, search→table refresh, idle-tick skip, and API cache
  hit. `task test` / CI stay green independently of it.
- **Provider brand marks** are official white logos on brand-colored tiles,
  fetched by `scripts/fetch-brand-logos.py` into `docs/assets/brands/`
  (Simple Icons CC0 for Anthropic/Google/OpenAI/DeepSeek/Meta/Mistral/xAI/
  MiniMax/OpenCode/Qwen/Ollama, plus BrandBrain's fetched Moonshot raster),
  used in chart legends, the provider mix/comparison, model inventories,
  session chips, billing, and team cards. `providerLogo()` falls back to the
  ported `ProviderLogos.swift` glyphs for brands without an asset (zhipu,
  agy, local, unknown). `providerKey()` normalizes provider/model strings to a
  brand (claude→anthropic, gpt/codex→openai, …). Lozenges use `.chip.logo-chip`
  (roomier padding, 8px gaps, gradient tile, inset highlight).
- **League tier badges** are generated art processed into transparent 384px
  PNGs under `docs/assets/leagues/` (`scripts/process-league-badges.py` keys out
  the white background via a border flood fill, drops watermarks with a
  density crop, and centers each badge). `leagueIcon()` renders the image with
  a league-colored glow and falls back to the inline SVG shield if an asset is
  missing; badges appear in the ladder, hero, table chips, standings, and
  league cards.
- **Per-day heatmap drilldown**: clicking a calendar day opens the day's token
  breakdown — total tokens/cost, per-model rows (provider logo, tokens, share
  bar, % of day) from the 17-week `modelHistory`, and any redacted activity
  rows for that day. Days outside the published window show a notice instead
  of fabricated data.
- **Avatars**: a signed-in owner can associate their Google photo, upload an
  image (≤400KB, stored in R2), paste an image URL, or pick a generated style
  from the Display photo modal. Everyone else gets a deterministic DiceBear
  avatar seeded by handle (`docs/vendor/dicebear.js`, styles: identicon, thumbs,
  shapes, initials, bottts, emoji, rings) — stable across renders, falling back
  to initials if the bundle is missing. `avatarUrl`/`avatarStyle` live on the
  entry; `/api/avatar/:handle` serves uploads.
- Navigation: sidebar, `?view=`, `?user=` (opens Player Profile),
  clickable breadcrumbs, `?share=<id>` report pages, `/` focuses search.

### 2.8 Infra

- Cloudflare zone `token-horizon.dev` (NS `fred`/`vera.ns.cloudflare.com`,
  registrar NS managed at Vercel), Worker `token-horizon-leaderboard`, R2
  bucket `token-horizon-leaderboard`, static assets from `docs/`.
- `scripts/onboard-domain.sh` creates the zone (needs `Zone:Edit`) and prints
  registrar steps; `scripts/deploy-cloudflare.sh` deploys routes + assets.
- `scripts/make-app.sh` builds/signs/relaunches the app and health-gates on
  the build stamp.

---

## 3. Known deviations (deliberate)

1. **No latency / success-rate telemetry** — omitted rather than fabricated.
2. **Placement/decay/relegation** are copy only; no scheduled job.
3. **Prompt categories** are keyword heuristics over session titles.
4. **Season history** is bounded to the snapshot window (60 days); the season
   selector shows the current season only.
5. **Default sharing rules** are client-side defaults, not server-enforced.
6. **Share preview** is a stylized thumbnail, not a live mini-chart.
7. **Prompt history is opt-in** (`leaderboardSharePrompts`, default off) and
   lives **only inside the individual profile**. The global Prompts view and
   the Models "Top prompts" card were removed; `/api/prompts` and the
   `topPrompts` payload are off unless the deployment is explicitly opted in
   with the `PROMPTS_PUBLIC=1` worker var. When the per-owner setting is off,
   activity rows still publish with empty titles (time/model/tokens/cost), so
   the Recent Activity timeline keeps working; titles and prompt categories
   stay private. Existing entries keep whatever they last published until the
   next publish overwrites the breakdown.
8. **TanStack Charts is pre-alpha (0.18)** — vendored + feature-detected with
   an SVG fallback so a breaking release can't take the dashboard down.
9. **`docs/index.html`** remains the dependency-free landing page; the
   dashboard is the only page with a JS vendor bundle.

## 4. Verify / rebuild

```bash
npm install && npm run vendor          # rebuild docs/vendor/tanstack-charts.js
task lint && swift test                # Swift gates (engine v3, analytics)
make leaderboard-test                  # worker tests + hermetic Playwright UI
task bench-leaderboard                 # dashboard render/chart/API budgets (fails on breach)
./scripts/make-app.sh                  # install + relaunch, health-gated
./scripts/deploy-cloudflare.sh         # worker + docs assets
task smoke                             # local API + MCP contract
```

### UI audit passes (`/audit` → `/critique`)

Reusable commands live in `.opencode/commands/`. Rules established by audit
rounds and enforced by `scripts/test-leaderboard-ui.mjs` §11:

- **Honesty first**: API failures surface error banners (never silent empty
  states); the offline demo fallback carries a "demo data" banner + retry.
- **No page-level horizontal scroll** at 390px (wrapping topbar, `min-width:0`
  grid children, collapsing ladder/donut layouts, scroll-wrapped tables).
- **Keyboard parity**: nav/sort/rows/tiers/tabs/rule-switches/cal-cells are
  focusable with Enter/Space; modals trap Tab, label close buttons, lock body
  scroll, and return focus on close; `:focus-visible` outlines.
- **Privacy copy**: title-less rows render "title private" + 🔒 everywhere
  (prompts, top-prompts, profile sessions) — never "(untitled)".
- **Cost precision**: `fmtRate` (~3 sig figs) for all $/rate figures on both
  sides of the edge; worker no longer rounds `avgCostPerM` to 4dp.
- **Donut consistency**: ring, center, and legend share one denominator and
  every time-based card labels its window ("Last N days" vs "All-time").
