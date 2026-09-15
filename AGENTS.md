# AGENTS.md — Token Horizon

Guide for coding agents working in this repo. Read alongside README.md (user setup + provider table).

## Layout

```
Sources/TokenHorizon/              # one executableTarget, grouped by feature/domain (not layer)
  App/                main.swift (AppKit entry, .accessory policy), AppDelegate.swift (surfaces, refresh loops, HTTP wiring, dashboard window), BuildInfo.swift, LaunchAgentCtl.swift
  Usage/              Models.swift (UsageSnapshot, ToolUsage, ModelUsage, ProviderLimit, HistoryPoint, TrendWindow, ShellEvent), UsageEngine.swift (all token/cost collection, hourly buckets, history/trends aggregation; opencode sqlite is stat-gated, dir listings are TTL-cached per `listingTTL`, agy media dirs pruned per `excludedDirNames`, scan tails version-memoized per `scanVersions`, engine-state saves dirty-gated + throttled per `engineSaveInterval`)
  Limits/             PlanLimitsEngine.swift (glm/minimax/opencode-go/alibaba/gemini/claude/agy fetchers), KimiLimitsEngine.swift (OAuth refresh + usage API), ClaudeDiscovery.swift (multi-account profiles, keychain, usage API, disk cache staleness), LimitNotifier.swift
  System/             SystemStats.swift (mach CPU, vm64 RAM, load avg, system I/O, top processes, narrow MLX sampling), DockerObserver.swift (container metrics, CPU%, RSS, VM host PID correlation)
  LocalModels/        MLXObserver.swift (independent runner detection, process-tree telemetry, measured tok/s), MLXHistory.swift (bounded fine samples + 30s rollups), OllamaTelemetryProxy.swift (loopback relay, streaming metrics, bounded store), OllamaClient.swift, ModelDiscoveryEngine.swift, LocalModelMetadata.swift
  Catalog/            ModelCatalog.swift, ModelsPipeline.swift (off-main merge + filter + sort + scope counts), ModelCatalogExport.swift (web catalog payload for `/models/catalog` + `--export-model-catalog`)
  Leaderboard/        LeaderboardStore.swift (multi-period rankings, badges, share cards, durable store), LeaderboardAnalytics.swift (pure league/MMR/season/efficiency/achievements — mirrored by the worker)
  Persistence/        DurableStore.swift (~/.config/token-horizon/cache persistence), SettingsStore.swift (settings.json)
  Discovery/          HomeDiscovery.swift (shared `~/.*` provider-home auto-discovery with 30s-cached $HOME listing)
  Telemetry/          TelemetryMetrics.swift (OTel meter, Prometheus text, optional OTLP/HTTP export; engine tick + files-tracked instruments)
  Server/             LocalServer.swift (NWListener HTTP on 127.0.0.1:8765)
  UI/                 UIModel.swift (UIModel history on BoundedSeries, SysWindow/MLXWindow), DashboardTabs.swift (DashboardTabs shell + routing + all tabs; per-tab extraction is the next split), Chrome.swift (notch chrome + tab enum), PlanLimitsViews.swift, Charts.swift (gauges, sparklines, heatmap, trends), ModelsViews.swift, LocalModelsViews.swift, ProviderLogos.swift, StatusIcon.swift (tray CPU/MEM rings), Panels.swift (NotchPanel hover driver + hysteresis)
  Core/               CLEAN seams (additive, behavior-free): Protocols.swift (consumer-defined ports), AppDependencies.swift (composition root factory), Clock.swift (injectable time), FileSystem.swift (injectable file reads), BoundedSeries.swift (generic bounded history), THError.swift (context-chained errors)
Tests/TokenHorizonPerfTests/       # one testTarget, split by kind
  Unit/               pure-logic XCTest suites (watermarks, parsers, stores, engines) + Unit/Core/ (seam tests)
  Perf/               budget-gated suites (ModelsPipeline, ScopeCounts, SystemHistory, ProcessMetrics)
  Integration/        OllamaProxyIntegrationTests (loopback relay round-trips)
  Fixtures/           catalog-7300.json + golden/testdata files (see Package.swift resources)
```
mcp/token-horizon-mcp.mjs   zero-dep stdio MCP server (talks to :8765, sqlite fallback for usage/sessions)
shell/token-horizon.zsh     zsh preexec/precmd hooks + `th` CLI (stats, limits, history, cache, reset-cache)
  scripts/make-app.sh         release build + .app bundle (LSUIElement) + ad-hoc codesign + relaunch
  scripts/refresh-models.sh   runs `TokenHorizon --export-model-catalog --refresh` → docs/data/models.json
.github/workflows/models-refresh.yml  weekly catalog refresh + commit when changed
  scripts/package-notarized.sh Developer ID hardened-runtime app + DMG/ZIP + optional notarytool submission
scripts/make-icon.swift     renders the black-hole AppIcon.icns
scripts/build-vendor.mjs    bundles @tanstack/charts + DiceBear → docs/vendor/*.js (`npm run vendor`)
scripts/process-league-badges.py  white-keyed/cropped league badge PNGs → docs/assets/leagues/
scripts/fetch-brand-logos.py  official white provider marks → docs/assets/brands/ (Simple Icons + BrandBrain)
scripts/onboard-domain.sh   Cloudflare zone creation + registrar NS steps for a custom domain
LEADERBOARD.md              objective-vs-current screen alignment + full leaderboard data flow
```

## Invariants — do not break

1. **UsageEngine.snapshot()/history()/trendHistory() take `lock`**; sqlite opened `READONLY | FULLMUTEX`. All engine calls run off-main via `DispatchQueue.global`. Concurrent unlocked sqlite use = SIGSEGV (happened before).
2. **Buckets are hourly epoch keys** everywhere (`per*HourPercentage`-style day math derives from them). "Today" = `bucket >= todayBucket()` (local midnight). Do not reintroduce day-keyed buckets.
3. **Codex parsing is stateful per file** (offset + watermarks + last). Never reset state on truncation without clearing buckets. Multi-dir scans share `codexFiles`; filter preserved state by path prefix.
4. **Incremental JSONL readers** only consume up to the last `\n` and advance the stored offset by exactly the consumed byte count (partial tail lines must survive to the next poll).
5. **The engine is the single source of truth.** MCP shim and any UI read from the HTTP API (fallback: direct sqlite read-only for usage/sessions). Never parse provider files from the MCP shim.
6. **Swift concurrency**: language mode 5, no Sendable gymnastics — keep it that way unless you enjoy type-checker timeouts.
7. **Dependencies stay deliberate.** System SQLite3, Network, AppKit/SwiftUI, and the pinned OpenTelemetry Swift SDK are allowed; do not add another dependency without review.
8. **Process list must always be populated.** `SystemStats.processSamples()` returns top 8 sorted by CPU and by MEM with *no* threshold filter — filtering `cpu >=0.5` at idle produced empty lists. It must use the temp-file pattern (`FileHandle(forWritingAtPath:)` → `Data(contentsOf:)`) not `Pipe` + `waitUntilExit` + `readDataToEndOfFile` (pipe deadlock on utility queue). It is exposed as `GET /processes` (`LocalServer.swift:143`) and `token_horizon_processes` MCP tool (`mcp/token-horizon-mcp.mjs:131`) — both must stay in sync with `AppDelegate.swift:182` `model.processes`/`processesMem`.

9. **System performance history is bounded.** `SystemStats.snapshot()` exposes CPU, memory, disk MB/s, and network MB/s. `UIModel` records fine samples every 2 seconds, caps each fine series at 1,800 points, and emits one 30-second average after every 15 samples. Each coarse series is capped at 2,880 points (24 hours); old points are discarded, not persisted. I/O sampling runs off-main, uses a 4-second cache, disk `iostat` totals, and non-loopback `getifaddrs` counters. Keep this path free of per-process history or unbounded allocations.

10. **MLX observability is independent.** `SystemStats.mlxProcessSamples()` uses full `ps` arguments to detect `--mlx-engine`/`mlx-lm` roots and includes their descendants, but does not run `nettop` or populate the general process table. `MLXObserver` must not read or mutate `UsageEngine`; tok/s must come from a measured source or remain unavailable rather than being estimated from resource usage.

11. **Ollama telemetry is out-of-band.** `OllamaTelemetryProxy` is a lightweight in-process TCP relay on loopback. It forwards request/response bytes unchanged, parses completed Ollama JSON metadata (`eval_count`, `prompt_eval_count`), bounds and persists history to `localllm-usage.json`, and feeds `UsageEngine` token counters under `tool: "ollama"`. It must never block the main queue.

12. **Telemetry metrics are bounded and opt-in.** Prometheus text is served by the existing loopback `LocalServer` at `/metrics`; do not start a second listener. OTLP/HTTP is enabled only by `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`. Keep metric attributes low-cardinality, with model labels capped and overflow grouped as `other`. MLX rollups are in-memory only: fine samples are capped at 1,800 points and 30-second averages at 2,880 points.

13. **One instance, one build, always identifiable.** The API port is fixed at `:8765` — never reintroduce port-hopping (two instances serving divergent data caused real "missing data" scares). `InstanceGuard.claimPort()` runs at launch: same-build duplicates exit quietly, different builds are replaced (newest launch wins), and a listener that dies before first ready is fatal via `LocalServer.onBindFailure` (never a silent API-less run). `scripts/make-app.sh` is the ONLY supported launcher: it stamps `THGitSHA`/`THBuiltAt` into Info.plist, syncs the build to `/Applications/TokenHorizon.app`, restarts via the LaunchAgent when installed (else direct launch), and health-gates on the serving build reporting our stamp. Crash recovery is the app binary itself (`--install-launch-agent` / `--uninstall-launch-agent` / `--agent-status`): a portable LaunchAgent pointing at its own bundle with snapshotted `TOKEN_HORIZON_*`/auth env, KeepAlive with `SuccessfulExit=false` so clean duplicate-exits don't loop. `/health` always carries `build{version,commit,built_at}` and the Settings tab shows the same line — if it doesn't match `git rev-parse --short HEAD`, you're looking at a stale binary: rebuild, don't debug the data.

13. **Durable disk persistence & instant hydration**: `DurableStore` persists `UsageSnapshot`, `HistoryPoint` array + streak, `TrendWindow` points, `ProviderLimit` arrays, and incremental parser file state (`engine-state.json`) to `~/.config/token-horizon/cache/`. On app launch, `AppDelegate` hydrates `UIModel` immediately on frame 1 to guarantee zero cold-start blank state or perceived history loss. `UsageEngine.history(days:)` overlays durable past days when log files have been rotated or pruned. Disk persistence is configurable via `SettingsStore.historyPersistenceEnabled` and can be cleanly cleared/rebuilt via `DurableStore.resetAll()`, `POST /cache/reset`, `th reset-cache`, or the Settings tab UI.

14. **Claude multi-account sequential querying & quota prioritization**: `ClaudeDiscovery.fetchAllLimits()` executes sequentially with a 100ms pause to eliminate Cloudflare HTTP 429 rate limiting. Disk cache files older than 2 hours (7200s) are ignored. Unified plan rendering explicitly prioritizes `label == "weekly"` for `cycleLimit`, routing model-scoped caps (`weekly · Fable`) to `extraLimit` / subtitle.

15. **Antigravity (AGY) language server telemetry**: Port discovery parses `~/.gemini/antigravity-cli/cli.log` and active `agy` process sockets with cache fallback to avoid slow full-system `lsof` scans. Token accounting dynamically queries `~/.gemini/antigravity-cli/settings.json` for configured models (`gemini-3.8-flash`) rather than hardcoding.

16. **Leaderboard & share card engine**: `LeaderboardStore` persists ranked entries across multi-accounts and peer nodes to `~/.config/token-horizon/leaderboard.json`, ranks across 4 periods (`today`, `week`/`7d`, `all`, `streak`), computes percentiles and badges (`🥇 1st`, `🥈 2nd`, `🥉 3rd`, `🔥 Streak`), and generates share cards in 4 formats (`text`, `markdown`, `json`, `svg`) with clipboard copy. The `/leaderboard` and `/leaderboard/share` endpoints serve API and shell clients (`th leaderboard`, `th share`). Privacy controls: `leaderboardShareCost`/`leaderboardShareHardware` (default on) and `leaderboardSharePrompts` (**default off** — when off, session rows still publish with empty titles so the Recent Activity timeline works, but titles/categories are stripped). Prompt history lives **only inside the individual profile**; the public Prompts view was removed, and the worker's `/api/prompts` + `topPrompts` are off unless the deployment opts in with the `PROMPTS_PUBLIC=1` var. Published entries also carry league/MMR/division/efficiency, input/output/request splits, season tokens, achievements, per-project rollups, a 7×24 heatmap, a trailing 17-week daily calendar, and (opt-in) recent sessions — computed by `LeaderboardAnalytics` and mirrored in `cloudflare/src/index.js`; keep both copies in sync.

17. **Token-class analytics & engine-state v4**: `UsageEngine` tracks input/output/cache-write/request splits per file, per model, and per hour (`ModelAccum`/`HourBucket`/`ProjectAccum`), plus per-model daily buckets (`modelDays`, trailing 17 weeks, per-file so truncation resets them) exposed as `UsageSnapshot.modelDaily`. `DurableStore.EngineStatePayload.version = 4`; `loadDurableEngineState` discards payloads older than v4 so the first scan rebuilds the full window (pre-v4 state only kept 8 days). `LeaderboardStore.syncLocal(..., heatmap:)` takes the engine's 4-week grid and preserves the last published grid when omitted; it derives `modelHistory` (top 8 models + Other) and `daily` (non-zero days, 17 weeks) from `snapshot.modelDaily`/`history` — the dashboard slices the last 7 days for the stacked chart and uses the rest for per-day heatmap drilldowns. Local endpoints: `/stats`, `/activity/heatmap?days=`, `/projects`, `/achievements`.

18. **Dashboard charts/avatars/search are vendored**: `docs/vendor/tanstack-charts.js` (stacked `barY` usage charts + structured tooltip), `docs/vendor/dicebear.js` (deterministic generated avatars) and `docs/vendor/fuse.js` (model explorer search) are minified IIFE bundles built by `npm run vendor` (`scripts/{vendor,dicebear,fuse}-entry.js` → `scripts/build-vendor.mjs`; root devDependencies only). Charts are declared per render into `chartRegistry`, definitions memoized by content key (`chartDefs`), and mounted hosts pooled by content key (`chartPool`, LRU 14) — identical data adopts the live host, it is NOT destroyed/remounted; only changed data mounts. If a bundle is missing the dashboard falls back to SVG `stackedArea` / initials. Provider brand marks are ported from `ProviderLogos.swift` (`providerLogo`). Avatars: owner-set Google photo / upload (R2 `avatars/<handle>`, served by `/api/avatar/:handle`) or DiceBear-seeded generated styles (`avatarStyle` on the entry); `/api/profile/avatar` is owner-only. Do not import these libraries from a CDN at runtime. Dashboard GETs are cached in-memory (worker `max-age`, 30s default) with in-flight dedupe; `loadLeaderboard` fingerprints payloads (FNV-1a) and the 30s tick skips `render()` on no-change; search/sort refresh only `#lb-table-wrap`. `LEADERBOARD.md` documents the objective-vs-current screen alignment and the full data flow.

19. **Dashboard identity & sign-in**: branding is "Token Horizon" everywhere (never TokenArena). The sign-in modal (`openSignInModal`, `requireSignIn` + `state.signInPending` resume, `?signin=1` deep link) pairs the GSI button with an animated ASCII black hole (`createBlackHole` light-map ray tracer; static under `prefers-reduced-motion`, RAF stops on close/detach). A second 22×9 instance is the sidebar brand mark (paused at rest, hover to animate, shield fallback <860px).

20. **Drop-in LLM gateway (Go sidecar, not Swift)**: `gateway/` is a zero-dep Go module (`token-horizon-gateway` binary) — portable, decoupled, headless-capable. It owns capture, JSONL storage (`~/.config/token-horizon/traces/`, 256KB/side, 30 day-files, 256MB, oldest pruned), and its read API (`/traces`, `/traces/<id>`, `/proxy/stats`, `/proxy/config`, `POST /traces/clear`, own `/metrics`). Single-port routing per request (path → auth headers → body shape, `infer.go`; `/th-openai/` + `/th-anthropic/` force it); responses stream unchanged with an `x-token-horizon-trace-id` header; redirects never followed with client credentials. Swift keeps only `Gateway/GatewaySupervisor.swift` (attach-or-spawn, port discovery via `/__token_horizon`, `TOKEN_HORIZON_GATEWAY_BIN` override) plus `GatewayBridge` (`:8765` reverse-proxy for the gateway paths, 503 when down) and `POST /ingest/ollama` (best-effort local-totals continuity). Cloud traces must NOT feed `UsageEngine` totals (file parsers already count that traffic). Token counts are provider-reported or absent — never estimated; `estCostUSD` stays null (pricing lives with the catalog). `scripts/make-app.sh` builds the sidecar into app Resources; pin wire formats in `gateway/*_test.go` (`gofmt -l . && go vet ./... && go test ./...`).

21. **Web model catalog is an app export** (`docs/data/models.json` + `GET /models/catalog` + `/models`): the static artifact is produced ONLY by `scripts/refresh-models.sh` (`TokenHorizon --export-model-catalog [--refresh]`, same `ModelsPipeline` merge as the MODELS tab) and committed by the weekly `models-refresh.yml` job; never hand-edit it and never fetch provider APIs from the dashboard. The worker proxies the ASSETS file at `/api/models/catalog` with CORS + `s-maxage=3600` and aggregates adoption at `/api/models/usage` (read-side over R2, normalized providers, input/output splits); `/models` is the canonical flat catalog route (SPA asset + no dashboard chrome; the landing-page nav links `./models/` and the static mirror `docs/models/index.html` redirects to `?view=models&flat=1`; `/leaderboard?view=models` 302s to `/models` unless `tab=providers`). The explorer (`renderModels`/`mx*` in `docs/leaderboard.html`) is client-side: lazy Fuse index (vendored `docs/vendor/fuse.js`, rebuilt via `npm run vendor`), windowed list (`MX_ROW_H_*` must match `.mx-row` CSS height), primary-listings dedupe on by default, relevance order while searching, `?model=<id>` drawer deep link, `?provider=<key>` provider filter (provider rows in the Providers tab and per-model drawer link through it). Per-user model lists (profile Model Inventory, session/activity chips, day drilldown, Billing, shared reports, chart legends) link into the drawer via `[data-model-link]`/`modelLink()` + one delegated handler; the drawer is the per-model provider view (cross-user totals split by provider, listings comparison, top publishers). Keep Fuse/search/dedupe/cross-links in the dashboard — do not move catalog filtering into the Swift server or the worker.

## UI invariants

- NotchPanel anchors top-flush to the notch screen (`auxiliaryTopLeft/RightArea` for exact bounds); expansion grows DOWNWARD only; hover uses the 60ms polled driver with hysteresis (0.12s in / 0.4s out) — never re-add `.onHover`-driven expansion (oscillation).
- `NSHostingView.sizingOptions = []` on panels; `canBecomeKey = true` (settings TextEditor needs Cmd+A); tooltips are custom hover bubbles (`.help()` never fires in non-activating panels).
- Tab content is inside `ScrollView(.vertical)` — clipping is a bug.
- No bottom statusline (user removed it). Surface precedence: `TOKEN_HORIZON_FORCE_TRAY=1` > Settings → Surface (`auto`/`notch`/`tray`) > auto-detect (notch screen present?). `showTrayIcon` keeps the menu-bar item alongside the notch panel (both at once). Forced notch on a notch-less display falls back to `NSScreen.main` top-center (NotchPanel already handles it); the tray item always shows CPU/MEM rings (`StatusIcon`, CoreGraphics — never a hosting view, so button clicks still toggle the popover).
- `heatmapExpanded` toggles 24W↔52W; heatmap sits LEFT of the chart; KPI cards (Total/Peak/Active days) beside it.

## Provider adapter contract

`ProviderLimit { provider, label, usedPercent 0-100, resetsAt Date?, detail }` — add new providers by returning rows from `PlanLimitsEngine.fetchAll()` (or KimiLimitsEngine for OAuth-style). UI/MCP/`/limits` pick them up automatically. Group-by-provider rendering handles N windows per row.

Auth sources (checked in order). A new `~/.<provider>-N` profile dir is picked
up automatically — all home discovery goes through `HomeDiscovery.variantDirs`
(env override → defaults → `~/<prefix>*` glob → `~/.config/<name>`, default-first):
- alibaba cookie: `SettingsStore.alibabaCookie` → env `ALIBABA_TOKEN_PLAN_COOKIE` (see `.agents/skills/provider-quota-alibaba/SKILL.md`)
- kimi: `KIMI_CODE_HOME`/`KIMI_HOME` + `~/.kimi-code/credentials/kimi-code.json` → `~/.kimi/credentials/…` → any `~/.kimi*/credentials/kimi-code.json` (see `.agents/skills/provider-quota-kimi/SKILL.md`)
- glm/minimax/opencode-go: opencode `auth.json` keys (`zai-coding-plan`, `minimax-coding-plan`, `opencode-go`), `OPENCODE_AUTH` → `~/.local/share/opencode/auth.json` → `~/.config/opencode/auth.json` → `~/.opencode/auth.json` (see `.agents/skills/provider-quota-zhipu/SKILL.md`, `minimax`, `opencode`)
- openai/codex: opencode `auth.json` key (`openai` OAuth access token + account ID) → live `https://chatgpt.com/backend-api/wham/usage` + `~/.codex*/sessions|archived_sessions/**/*.jsonl` recursive fallback (`$CODEX_HOME` first) (see `.agents/skills/provider-quota-openai/SKILL.md`)
- claude: `~/.claude*` variants (`$CLAUDE_CONFIG_DIR` first) → `<dir>/.credentials.json` → Keychain `Claude Code-credentials[-hash]` (see `.agents/skills/provider-quota-anthropic/SKILL.md`)
- gemini: `~/.gemini*/oauth_creds.json` (see `.agents/skills/provider-quota-google/SKILL.md`)
- generic JSONL tools: `~/.zcode|~/.glm` (glm), `~/.qwen*` (qwen), `~/.grok*|~/.xai*` (grok), `~/.dsh*|~/.deepseek*` (deepseek), `~/.gemini*` (gemini/agy) — all variant-aware
- deepseek: `DEEPSEEK_API_KEY` env → opencode `auth.json` (`deepseek`) (see `.agents/skills/provider-quota-deepseek/SKILL.md`)
- Complete provider quota skills catalog: `.agents/skills/provider-quota-*/SKILL.md`

## Verification checklist (run after changes)

```bash
./scripts/make-app.sh                     # build + install + relaunch (health-gated, exits 1 if :8765 isn't our stamp)
curl -s localhost:8765/health             # must show build.commit == `git rev-parse --short HEAD` (else stale binary)
curl -s localhost:8765/health | python3 -c "import json,sys; print(json.load(sys.stdin)['llm_gateway_port'])"
                                          # must be non-null: the app always ships with its gateway proxy
curl -s localhost:8765/stats | python3 -m json.tool | head -40
curl -s localhost:8765/models/catalog | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['count'], len(d['topPicks']), d['build']['commit'])"
                                          # web catalog export (docs/data/models.json is regenerated by `task models-refresh`)
curl -s "localhost:8765/trends?window=1D" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['points']), d['total'])"
curl -s localhost:8765/limits | python3 -m json.tool
curl -s "localhost:8765/activity/heatmap?days=7" | python3 -m json.tool | head
curl -s localhost:8765/achievements | python3 -m json.tool | head
curl -s localhost:8765/proxy/config | python3 -m json.tool | head -20
(cd gateway && gofmt -l . && go vet ./... && go test ./...)
                                          # sidecar gate (also `task gateway-test`, runs in CI)
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node mcp/token-horizon-mcp.mjs
```

The block above is also `task smoke` (task-native in `Taskfile.yml`, with PASS/FAIL
per line). Local gates live in `Taskfile.yml` (`task validate` = lint + full
suite, mirrors CI); see `TESTING.md` for the full stack (lint / unit /
fixtures / integration / perf / smoke rules).

Ground-truth checks when touching parsers:
- codex: `grep '"total_token_usage"' <file> | tail -1` per session, sum `total_tokens` → must equal parser all-time (verified exact before)
- opencode: session-table sums vs `message.data` per-model sums (json_extract)
- stress: 60× parallel `/stats` + `/event` curls; process must stay alive

## Leaderboard & MCP Server

- **Edge Architecture (`cloudflare/` + `cloudflare/src/index.js`)**: Cloudflare Worker + R2 bucket (`token-horizon-leaderboard`). Canonical URL: `https://token-horizon.dev` (`www` 301s to apex). `cloudflare/wrangler.toml` also keeps the legacy `tokens.benebsworth.com` route until the nameserver cutover is verified; `scripts/onboard-domain.sh` creates the zone (needs a Zone:Edit API token) and prints the registrar NS steps. Deploy with `--config wrangler.toml` (`scripts/deploy-cloudflare.sh` does): newer wrangler versions can otherwise walk up to the root `package.json` and deploy a stray worker named `token-horizon-dashboard`. Read APIs: `/api/leaderboard?period=&team=&league=` (ranked rows + `kpis` with real 7d deltas + `movers`/`mostImproved` + `season` + `leagueLadder`), `/api/user/:handle` (standing/achievements/rankHistory/teamRank), `/api/providers?days=`, `/api/teams`, `/api/season`, `/api/models/catalog` (ASSETS proxy of `docs/data/models.json`, CORS + edge cache), `/api/models/usage` (per-model adoption rollup over R2), `/api/config` (public client config), `/api/health`. `/api/prompts` and the `/api/providers` `topPrompts` payload exist only when the deployment opts in with `PROMPTS_PUBLIC=1` (prompt history is individual-profile-only by default). Publishing: `POST /api/leaderboard` also derives league/MMR when absent and appends a bounded daily `snapshots[]` entry (rank + cumulative tokens + per-provider totals) — movers, rank deltas, league progression, and provider-over-time all read from these snapshots, so they stay empty until ≥2 days of publishes exist.
- **Authentication & Claims**: Anonymous publish automatically mints a SHA-256 hashed `claimToken` preventing handle hijacking. Unclaimed profiles can be claimed and verified via Google OAuth (`POST /api/claim`). When `GOOGLE_CLIENT_ID` is set (worker `[vars]`), `parseGoogleAuth` only accepts RS256 ID tokens verified against Google's JWKS (`GOOGLE_JWKS` env overrides the fetch for hermetic tests) with `aud`/`iss`/`exp` checks; the unsigned `google:<email>` / `body.googleUser` fallbacks are legacy-only and disabled in production. Machine publishes (Mac app) use the `LEADERBOARD_SECRET` bearer instead. Never echo `ownerId`/`claimTokenHash` in responses (`sanitizeEntry`).
- **Sharing & access control**: R2-backed share records (`POST /api/share/create`, `GET /api/share/list`, `POST /api/share/revoke`, public `GET /api/shared/:id` honoring anonymize/hide-cost/full-token options) plus per-owner groups (`GET/POST /api/groups`) and an activity log. Public links are served at `/s/<id>` and rendered by the dashboard.
- **Frontend Dashboard (`docs/leaderboard.html`)**: Full Token Horizon SPA (inline CSS/JS + the vendored TanStack Charts bundle) with eight routed views — Dashboard deep-dive, Leaderboard, Player Profile, Teams, Models (catalog **Explorer** + provider-analytics **Providers** tab), Billing, Leagues & Season, and Settings (Sharing & Access Control) — plus the Share Usage Report modal and `?share=<id>` report pages. The explorer serves the static app-exported catalog (Fuse search + windowed list + detail drawer, see invariant 21) from `GET /api/models/catalog`; `/models` is the dedicated route (`?view=models`, `?model=<id>` opens the drawer). Deep links: `?view=`, `?user=<handle>` (opens Player Profile); breadcrumbs navigate. API base: same-origin on worker hosts (incl. localhost), canonical `https://token-horizon.dev` from static mirrors/`file://`. Usage-over-time charts stack by model (`usageHistory` from the leaderboard response; `breakdown.modelHistory` on profiles) with a structured tooltip + total; donuts/sparklines/heatmaps remain hand-rolled SVG. See `LEADERBOARD.md` for the screen-by-screen alignment.
- **MCP Server (`mcp/`)**: Model Context Protocol stdio server exposing 6 tools: `get_leaderboard`, `get_user_profile`, `get_daemon_metrics`, `publish_telemetry`, `claim_profile`, and `compare_users`. Run tests with `make mcp-test` or `npm test` inside `mcp/`.
- **Testing**: `make leaderboard-test` runs the edge worker test suite (`cloudflare/worker.test.mjs`) + hermetic Playwright E2E browser tests (`scripts/test-leaderboard-ui.mjs`, all API calls fixture-intercepted).

## Release & distribution (keep these in sync)

- Landing page: `docs/` (dependency-free static) → GitHub Pages via `.github/workflows/pages.yml` (Actions, watches `docs/**`). Project-page hosting: all internal links must stay relative (`./`), never root-absolute.
- Installer: `install.sh` (`curl -fsSL .../main/install.sh | bash`) resolves `/releases/latest`, installs the ZIP to `/Applications`, fetches versioned shell/MCP helpers, health-verifies. Test safely with `INSTALL_DIR=$TMP/Apps TH_NO_LAUNCH=1 TH_NO_AGENT=1 TH_NO_SHELL=1`.
- Releases: tag `v*` → `.github/workflows/release.yml` runs `scripts/package-notarized.sh` (Developer ID hardened-runtime signing + Apple notarization + stapling of app and DMG, Gatekeeper assessment) and publishes DMG/ZIP/sha256 + `video/` film. Without the Apple secrets (`APPLE_CERT_P12_BASE64`/`APPLE_CERT_PASSWORD`/`KEYCHAIN_PASSWORD` + notary auth: `APPLE_API_KEY_BASE64`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER_ID`, or `APPLE_ID`/`APPLE_TEAM_ID`/`APPLE_APP_PASSWORD`) it warns and ships an ad-hoc build — see `docs/notarized-release.md`. To validate locally: `DEVELOPER_ID_APPLICATION="Developer ID Application: …" NOTARYTOOL_PROFILE=token-horizon-notary MARKETING_VERSION=x.y.z ./scripts/package-notarized.sh`. Releases must stay FULL (not prerelease) — installer, landing film embed, and README video all resolve through `/releases/latest`, which skips prereleases.
- Homebrew: `packaging/homebrew/token-horizon.rb` is the Cask source of truth; the published tap is `castlemilk/homebrew-tap` (tap `castlemilk/tap`). Per release: bump `version` + `sha256` (from the release's `.sha256` asset), then `task brew-sync` (`scripts/sync-homebrew-tap.sh`) to copy + push the cask. Validate with `brew audit --cask castlemilk/tap/token-horizon` and `brew fetch --cask castlemilk/tap/token-horizon` (checksum); do not `brew uninstall` a dev-installed app — the cask only removes the app artifact and LaunchAgent plist.
- Product film: `video/` (Remotion, code-drawn, offline render). `npm run render` → `dist/TokenHorizon-film.mp4` is the release + landing-page asset. See `video/README.md` for scene/optimization notes.

## Performance budgets (Models tab)

The MODELS tab renders a 7,300-row deduped catalog with filter+sort. The pipeline runs in `ModelsPipeline.compute()` (`Sources/TokenHorizon/ModelsPipeline.swift`), off the main thread via `recomputeFilteredRows()` (`Views.swift:711`).

**Measured baselines (release build, Apple M-series, 7,300-row fixture):**
| Step | Budget | Measured | Test |
|---|---|---|---|
| Full pipeline (catalog merge + filter + sort + scope counts) | ≤ 400ms | ~220ms | `testFullPipeline_underHardBudget` |
| Filter+sort step alone | ≤ 100ms | ~34ms | `testFilterSort_alone_completesUnderBudget` |
| Scope counts alone (6 passes) | ≤ 50ms | ~10ms | `testScopeCounts_alone_completesUnderBudget` |
| Scope count lookup (cached) | O(1) | ~3µs | `testCachedScopeCounts_areConstantTimeLookup` |

**Critical invariants — do not regress:**
1. `countForScope` MUST NOT be called per view body update. Scope counts must come from `_scopeCounts: [ModelFilterScope: Int]` `@State` dictionary populated once by `ModelsPipeline.compute`.
2. The catalog merge MUST NOT run synchronously on the main thread. It runs in `Task.detached(priority: .userInitiated)`.
3. The view body MUST NOT do filter/sort work. `_filteredRows` is a `@State` array populated by the background task.
4. `recomputeFilteredRows()` MUST early-exit when `_lastBaseKey` matches and `_filteredRows` is non-empty (don't recompute on every 2s `sys` tick).

**Run perf tests:**
```bash
swift test --filter SystemHistoryTests                                  # I/O + rolling-history regression tests
swift test --filter ProcessMetricsTests                                 # per-process metrics regression tests
swift test                                                              # complete suite
./scripts/bench-models.sh                                              # bench + summary
./scripts/test-models-perf.sh                                          # regression guard (fails on budget breach)
./scripts/make-app-with-tests.sh                                       # release build gated on perf tests
task bench-leaderboard                                                 # dashboard charts/render/API-cache budgets (fails on breach)
make profile                                                           # live tick timing table (opt-in harness, no asserts)
make profile-sample                                                    # + 20s `sample` hotspot profile; TH_PERF_LOG=1 adds engine phase spans
make coverage                                                          # llvm-cov table for Sources/ (report-only, see below)
```

**Test layout:**
```
Tests/TokenHorizonPerfTests/
  Unit/               pure-logic suites (parsers, stores, engines, routes, view math) + Unit/Core/ (seam tests)
  Perf/               budget-gated suites (ModelsPipeline, ScopeCounts, SystemHistory, ProcessMetrics) + TickPerfHarness (opt-in via TH_PROFILE)
  Integration/        loopback relay + server-lifecycle round-trips
  Fixtures/catalog-7300.json      synthetic 7,300-row catalog (committed)
```

**Coverage policy (`make coverage`, CI `coverage` job — both report-only):**
- This suite exercises live machine state (displays, keychain, running
  tools, real $HOME), so absolute % differs per machine. A hard gate would
  be a flake factory — perf budgets gate, not coverage numbers.
- New pure logic (parsers, math, routing, formatting) must ship with
  table-driven unit tests. Widen `private` → internal with a doc comment
  when that is the only blocker (established precedent).
- Intentionally uncovered, do not chase: network fetchers, Keychain,
  SMAppService/launchd, destructive ops (kill, cache reset, sheet/cloud
  publish), live process spawns, SwiftUI view bodies, `main.swift`, and
  AppDelegate launch wiring.

If a test fails with "REGRESSION", the pipeline is slower than the budget. Common causes:
- New filter pass inside `modelsTab` view body
- `countForScope(scope)` called inside `ForEach`
- `_filteredRows`/`_scopeCounts` mutated via `MainActor.run` but read on main thread (race)
- New field added to `ModelRow` whose computed property is expensive (e.g. another `.lowerCased().contains(q)`)

## Known gaps

- alibaba 5h window intermittently absent (gateway omits it; retry ×3 handles most cases)
- minimax/glm/opencode-go keys expire per opencode re-auth — limits silently drop rows when 401
- claude token refresh not implemented (reads stored access token only; re-login fixes 401s)
- alibaba cookie is manual paste; browser auto-import not implemented
