# AGENTS.md — Token Horizon

Guide for coding agents working in this repo. Read alongside README.md (user setup + provider table).

## Layout

```
Sources/TokenHorizonCore/   portable server-side module (macOS + Linux; Windows TBD)
  Usage/                  UsageEngine (BACKFILL PARSER + macOS-app UI source: opencode sqlite,
                          claude/codex/kimi/generic JSONL → backfillEvents; 15-min buckets,
                          TokenBreakdown input/output/reasoning/cacheRead/cacheWrite) + shared
                          DTOs (UsageSnapshot, ProviderLimit + .clamped factory, ...)
    IncrementalJSONL.swift  THE incremental tail reader (inout offset + onTruncate hook +
                          consume-to-last-newline) — used by every JSONL tailer
                          (FileConsolidator + all UsageEngine scanners)
    JSONFields.swift        shared int/timestamp JSON field extraction
    CodexRateLimits.swift   ONE parser for codex token_count rate_limits windows
                          (UsageEngine backfill + CodexConsolidator LimitSnapshots)
    GeminiUsage.swift       ONE usageMetadata → TokenBreakdown parser (GeminiMeter + engine)
    Events/               unified measurement contract: UsageEvent (per-request, UUID-keyed,
                          machineID, attestation tier, RAW vendor/model spellings —
                          canonicalized at query time, meter product/cost observations +
                          separately-stored file observations with rank resolution on read,
                          pseudonymous accountID, thinkingLevel/thinkingRaw normalized
                          across vendors), FileAnnotation (tool/cost claim from files, keyed
                          by provider request id, joined at READ time), ContextState (live
                          context occupancy), UsageStoring protocol + SQLiteUsageStore
                          (usage.db, WAL). Analytics primitives (all filterable via
                          UsageFilter, all query-time-canonical): query (tabular newest-first,
                          rowid-paginated, annotation LEFT JOIN), aggregate (vendor/model/
                          machine/product/session/day), buckets (arbitrary resolution),
                          summarize (provider→model rollup with avg measured rates).
                          Cloud backends slot in behind UsageStoring later.
    Consolidation/        file ANNOTATION + LIMITS ingestion (files never create or modify
                          usage rows): FileConsolidator base + per-provider consolidators
                          (Claude/Kimi/pi/OpenCode → FileAnnotations by provider request id;
                          Codex → rate-limit LimitSnapshots). FilePoller runs them ONLY on demand
                          (POST /consolidate; continuous 60s polling is opt-in via
                          Settings.filePolling / TH_FILE_POLL=1); annotations are
                          read-joined, so poll timing cannot matter and re-polls are
                          natural-key no-ops. AttributionScheduler arms REACTIVE
                          consolidation passes (5s→30s→2m→10m backoff, 1h TTL,
                          .fileReading-gated) whenever a live metered/MITM event
                          lands without wire-inferable product attribution — the
                          read-time join resolves every pending request at once.
                          ConsolidationRunner.run remains a deliberate one-off (TH_CONSOLIDATE=1).
    AccountKey.swift      (Usage/) pseudonymous per-account ids (vendor + truncated SHA-256 of
                          the credential) — multi-account vendors consolidate usage/limits per
                          account; raw credentials are never persisted.
    CostEngine.swift      (Usage/) per-request cost decision: plan/subscription vendors + local
                          runtimes → 0 (.planFree, quota is the ceiling), API-billed vendors →
                          catalog pricing (.computed, cache-write priced as input), tool/provider-
                          reported cost from files overrides (.reported), no pricing basis → .unknown.
                          Read-side PRICING cache (pricing table: VALIDITY
                          INTERVALS keyed vendor||'/'||model + valid_from —
                          provider-scoped, first observation prices all
                          history, rate changes reprice FORWARD only) joins
                          the rate in effect at each request's own timestamp
                          as cost_equivalent — identical USD normalization
                          for plan and API rows (label stays on cost_source),
                          stored rows never rewritten.
  Providers/              per-vendor integrations — ONE folder per provider, everything
                          about that provider inside (quota adapter, meter target/wire
                          format, auth config). Cloud vs self-managed is a property of the
                          class (SourceKind), not a folder split.
    Auth/                   VendorAuth credential chains: composable CredentialSource
                            (.env/.opencodeKey/.fileText/.fileJSON/.keychain/.custom)
    Limits/                 generic quota infra: LimitsEngine base (cache/refresh/notify),
                            VendorLimitsAdapter (shared HTTP/JSON + auth chain + clamped
                            limit() builder + makeMeter), PlanLimitsEngine registry
    Runtimes/               generic runtime infra: LocalInferenceRuntime (process detection
                            via Platform.systemStats, Prometheus /metrics scraping, counter-delta
                            tok/s, makeMeter, defaultMeterListenPort — deterministic auto-meter
                            port: ollama 11435 / vllm 9311 / sglang 9312 / llamacpp 9313 /
                            mlx 9314), InferenceMonitor (poll loop + onRuntimeSighting hook —
                            CoreAPIRouter.startAutoMetering starts a request meter for EVERY
                            detected runtime, deduped by vendor; internal clients route through
                            live meters via MeterRegistry.routedURL), RuntimeUsageLedger
                            (DURABLE 15-min buckets, runtime-usage.json), RuntimeTelemetry
    Meterable.swift         dual-tracking contract: every provider vends a request meter
    Claude/ Gemini/ Zhipu/ MiniMax/ OpenCodeGo/ Alibaba/ DeepSeek/ Kimi/   cloud vendors
                            (Kimi/ also owns KimiPaths — the ONE source for kimi session /
                            credential file locations, consumed by engine, consolidator,
                            limits engine, and FilePoller)
    VLLM/ SGLang/ LlamaCpp/   runtime adapters (ports, process signatures, counter names)
    Ollama/                 OllamaClient (REST + benchmarks; routes through any live meter
                            via MeterRegistry.routedURL — no per-vendor wiring)
    MLX/                    MLXTypes, MLXHistory, MLXObserver (macOS)
  Metering/               RequestMeter base (loopback HTTP relay: forwards to real API,
                          streams response byte-identical, measures TTFT/stream duration,
                          emits UsageEvent per completed request — THE ONLY usage source —
                          plus wire rate-limit LimitSnapshots from response headers, tool
                          attribution from header sniffing, and accountID from credential
                          hashes). ProductSniff (ONE UA→product table) + ThinkingBands (ONE
                          thinking-budget→level banding, zero-semantics parameterized) live
                          here, shared by all meters AND the MITM addon (MitmAddonScript
                          interpolates ProductSniff.uaTable into the generated Python —
                          MitmAddonScriptTests asserts the agreement). Per-wire-format meters:
                          OpenAICompatibleMeter (chat/completions + Responses API → OpenAI,
                          Codex, DeepSeek, Zhipu, MiniMax, Alibaba, vLLM, SGLang, llama.cpp),
                          AnthropicMeter (claude, kimi), GeminiMeter (usageMetadata),
                          OllamaMeter (NDJSON + provider-ns durations → exact tok/s).
                          Daemon: TH_METERS="vendor:port->target,..."; GET /meters.
    Mitm/                 capture-mode seam: MeterCaptureMode (point|mitm; settings
                          meterCaptureMode / TH_CAPTURE_MODE) + MitmCaptureManager
                          (scoped TLS interception of AI VENDOR HOSTS ONLY — every
                          other connection passes through undecrypted; TLS core
                          delegated to mitmproxy; .mitm consent, never auto-granted;
                          embedded addon emits the same UsageEvents via
                          POST /analytics/events). Personal machines opt in;
                          corporate machines stay on point mode.
  Catalog/                ModelCatalog (identity/pricing/benchmarks), ModelsPipeline (off-main
                          merge/filter/sort), ModelRow/ModelTableColumn/ModelFilterScope,
                          Canonical (vendor/model spelling folds) + canonical.json in the config
                          dir — USER-EDITABLE override map (vendors: raw→canonical; models:
                          post-transformation→canonical) that WINS over built-in tables, reloads
                          live (5s mtime TTL), and drives every read-time fold: vendor CASE,
                          spelling cache (INSERT OR REPLACE), and pricing keys (canonical
                          namespace, so one config line maps any raw spelling onto its rates)
  Telemetry/              OllamaClient (meter-routed via MeterRegistry.routedURL), TelemetryMetrics (OTel on
                          macOS, no-op stub elsewhere), MLXTypes, MLXHistory, OllamaTelemetryStore
  Events/                 EventStore (bounded shell-event ring buffer)
  Settings/               SettingsStore (config dir settings.json, path via Platform.paths)
  Notifications.swift     shared Notification.Name constants
  Platform/
    HTTP.swift              ONE blocking JSON-over-HTTP helper (lock-box Response with
                          status/headers/data, getJSON/postJSON) — every limits adapter, runtime
                          probe, CloudSync and catalog refresh uses it; never hand-roll
                          URLSession+semaphore (Swift 6 captured-var diagnostics, drift)
    Permissions/            PermissionManager: OS capability probes (networkListen /
                            networkOutbound / localStorage / processInspection) with
                            per-platform remediation steps relayed via GET /permissions.
                            Consent = "may we?" (ConsentManager); capabilities = "can we?".
    Consent/                ConsentManager: per-scope grants (metering/fileReading/telemetry)
                            persisted in consents.json; OS-native prompts (macOS osascript,
                            Linux zenity/kdialog, Windows PowerShell MessageBox); headless
                            NEVER auto-grants — TH_CONSENT=scope env, or TH_ASK_CONSENT=1
                            to prompt. Meters do not start without .metering consent.
    SystemStatsProviding.swift  ProcSample/ProcDetail/SystemSnapshot DTOs + protocol
    PlatformPaths.swift         paths protocol + per-OS typealias
    CredentialStore.swift       credential protocol + Platform registry (paths/credentials/systemStats)
    LocalHTTPServing.swift      HTTP protocol + POSIXLoopbackHTTPServer (BSD sockets, macOS+Linux)
    CoreAPIRouter.swift         THE loopback API router — single implementation used by every host
                                (macOS app + headless daemon, both over POSIXLoopbackHTTPServer)
    macOS/    SystemStats (mach/vm64/iostat/ps), MacOSKeychainStore, MacOSPaths
    Linux/    ProcFSSystemStats (/proc+ps), LinuxPaths (XDG), credential stub
    Windows/  WindowsPaths (APPDATA), credential stub
    DaemonAutoStart.swift   user-scoped boot/login registration for the headless daemon:
                            systemd --user + linger (Linux; XDG autostart fallback),
                            LaunchAgent (macOS), unsupported on Windows. Pure generators
                            unit-tested; CLI: --install-service/--uninstall-service/
                            --service-status; API: GET /service, POST /service/install,
                            POST /service/uninstall. Never root/system-level — the
                            daemon needs the user's credentials and config dirs.
Sources/token-horizon-headless/  cross-platform daemon: same loopback API as the macOS app, no UI
ui/                              cross-platform desktop UI: SvelteKit (TS, adapter-static SPA, no
                                 Tailwind) + Tauri v2 shell; thin client of the loopback API
Sources/CSQLite/                 system sqlite3 module-map shim (non-macOS only)
Sources/TokenHorizon/            macOS app — UI + lifecycle only (server = core POSIX transport)
  main.swift            AppKit entry, .accessory activation policy
  AppDelegate.swift     surfaces (notch vs tray), refresh loops, Platform seam wiring
  LimitNotifier.swift   UNUserNotification limit alerts
  UI/Panels.swift       NotchPanel (hover driver + hysteresis), ring gauges live in Views
  UI/Views.swift        UIModel, DashboardTabs (shared by notch/popover/window), all tab views
mcp/token-horizon-mcp.mjs   zero-dep stdio MCP server (talks to :8765, sqlite fallback for usage/sessions)
shell/token-horizon.zsh     zsh preexec/precmd hooks + `th` CLI
  scripts/make-app.sh         release build + .app bundle (LSUIElement) + ad-hoc codesign + relaunch
  scripts/package-notarized.sh Developer ID hardened-runtime app + DMG/ZIP + optional notarytool submission
scripts/make-icon.swift     renders the black-hole AppIcon.icns
scripts/run-dev.sh          cross-platform dev stack (daemon on Linux, app on macOS, Tauri/vite UI);
                            kills stale backends/dev servers before starting (TH_REUSE=1 to reuse)
build_scripts/tauri/        per-platform Tauri release bundle scripts (linux/macos/windows)
```

See docs/cross-platform.md for the Linux/Windows port status and the Platform seam contract;
docs/dev-environment-linux.md for the Linux dev-box toolchain/snap pitfalls run-dev.sh works around.

## Invariants — do not break

1. **UsageEngine.snapshot()/history()/trendHistory() take `lock`**; sqlite opened `READONLY | FULLMUTEX`. All engine calls run off-main via `DispatchQueue.global`. Concurrent unlocked sqlite use = SIGSEGV (happened before).
2. **Buckets are 5-minute epoch keys at finest** (`UsageEngine.bucketSeconds = 300`;
  `BucketResolution` snaps to 300/900/3600/86400 by horizon: 5m ≤1D, 15m ≤7D,
  1h ≤31D, else 1d). "Today" = `bucket >= todayBucket()` (UTC midnight — see the UTC invariant). Each bucket carries a compat `tokens`/`cost` aggregate plus a granular `TokenBreakdown` (input/output/reasoning/cacheRead/cacheWrite) — compat totals must stay byte-exact vs provider ground truth; breakdown detail (e.g. codex cached/reasoning beyond displayTokens) lives only in `breakdown`. Pre-change 900s keys remain valid (900 is a multiple of 300, epoch-aligned).
4a. **All time boundaries are UTC.** Stored timestamps are epoch seconds; day buckets, "today" splits, streaks, heatmap cells, the `.day` aggregate (`strftime` WITHOUT 'localtime'), and trend day alignment all use UTC midnight via `DayBoundary` — never `Calendar.current.startOfDay` for data boundaries (it bakes the server's timezone into served shapes and machines disagree). Local time is inferred by frontends at render time only (the SvelteKit activity grid already re-buckets UTC-day buckets into local days; format.ts renders epochs via toLocale*).
3. **Codex parsing is stateful per file** (offset + watermarks + last). Never reset state on truncation without clearing buckets. Multi-dir scans share `codexFiles`; filter preserved state by path prefix.
4. **Incremental JSONL readers** only consume up to the last `\n` and advance the stored offset by exactly the consumed byte count (partial tail lines must survive to the next poll). There is ONE implementation: `Usage/IncrementalJSONL.swift` — callers pass `inout offset` + an `onTruncate` hook (reset per-file accumulators there; codex resets its whole CodexFileState).
5. **Endpoints are store-first; files only backfill.** /stats, /summary, /history, /trends read from SQLiteUsageStore whenever a store is wired (CoreAPIRouter.storeSnapshot/storeHistory/storeTrends + summarize); UsageEngine is the fallback for storeless hosts and remains the backfill parser + the macOS app's direct UI source. The MCP shim and any UI read from the HTTP API (fallback: direct sqlite read-only for usage/sessions). Never parse provider files from the MCP shim.
6. **Swift concurrency**: language mode 5, no Sendable gymnastics — keep it that way unless you enjoy type-checker timeouts.
7. **Dependencies stay deliberate.** System SQLite3, Network, AppKit/SwiftUI, and the pinned OpenTelemetry Swift SDK are allowed; do not add another dependency without review.
8. **Process list must always be populated.** `SystemStats.processSamples()` returns top 8 sorted by CPU and by MEM with *no* threshold filter — filtering `cpu >=0.5` at idle produced empty lists. It must use the temp-file pattern (`FileHandle(forWritingAtPath:)` → `Data(contentsOf:)`) not `Pipe` + `waitUntilExit` + `readDataToEndOfFile` (pipe deadlock on utility queue). It is exposed as `GET /processes` (`Platform/CoreAPIRouter.swift`) and `token_horizon_processes` MCP tool (`mcp/token-horizon-mcp.mjs:131`) — both must stay in sync with `AppDelegate.swift:182` `model.processes`/`processesMem`.

9. **System performance history is bounded.** `SystemStats.snapshot()` exposes CPU, memory, disk MB/s, and network MB/s. `UIModel` records fine samples every 2 seconds, caps each fine series at 1,800 points, and emits one 30-second average after every 15 samples. Each coarse series is capped at 2,880 points (24 hours); old points are discarded, not persisted. I/O sampling runs off-main, uses a 4-second cache, disk `iostat` totals, and non-loopback `getifaddrs` counters. Keep this path free of per-process history or unbounded allocations.

10. **MLX observability is independent.** `SystemStats.mlxProcessSamples()` uses full `ps` arguments to detect `--mlx-engine`/`mlx-lm` roots and includes their descendants, but does not run `nettop` or populate the general process table. `MLXObserver` must not read or mutate `UsageEngine`; tok/s must come from a measured source or remain unavailable rather than being estimated from resource usage.

11. **Inference telemetry comes from request meters.** The macOS `OllamaTelemetryProxy` was removed in favor of `OllamaMeter` (Metering/): a consented loopback listener that forwards bytes unchanged and parses only completed Ollama JSON metadata (exact ns-duration rates). Meters bridge measured samples into `InferenceTelemetryStore` + OTel metrics, and emit `UsageEvent`s into the store. They must never feed `UsageEngine` aggregates directly or block the main queue, and never listen without consent.

12. **Runtime usage parity is measured-only.** Self-managed runtimes feed `UsageEngine` (stats/trends/history, same 15-min `BucketEntry`s as providers) exclusively through `RuntimeUsageLedger`: persisted deltas of cumulative Prometheus counters, keyed by scope (`vendor`, `vendor|model`). First sighting of a counter establishes a baseline — never backfill unmeasured tokens; a counter decrease means server restart (delta = current reading). tok/s rates stay in `InferenceMonitor` snapshots; estimation from resource usage remains forbidden. Request metering of runtimes is GENERIC: `InferenceMonitor.onRuntimeSighting` → `CoreAPIRouter.startAutoMetering` starts a meter for every detected runtime on its deterministic `defaultMeterListenPort` (consent-gated, deduped by vendor, retried each poll); there is no per-vendor meter wiring in hosts, and internal clients route through live meters via `MeterRegistry.routedURL`.

13. **Telemetry metrics are bounded and opt-in.** Prometheus text is served by the loopback API at `/metrics` (CoreAPIRouter); do not start a second listener. OTLP/HTTP is enabled only by `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`. Keep metric attributes low-cardinality, with model labels capped and overflow grouped as `other`. Runtime rollups (InferenceMonitor RuntimeHistory, and MLXHistory on macOS) are in-memory only: fine samples are capped at 1,800 points and 30-second averages at 2,880 points. Runtime liveness is HTTP probes only — ps merely decorates local snapshots with pids/cpu/mem; remote runtimes must work with zero process inspection.

14. **Usage is metered-only; files annotate at full resolution; stored spellings are raw.** Every counted row in `usage_event` originates from a request meter (`insertMetered`, attestation ≥ measured) — the ONLY writer. Provider/tool session files contribute ONLY: (a) `FileAnnotation`s — the file's own claim of tool label + tool-reported cost, stored in `file_annotation` keyed by provider request id and LEFT JOINed onto metered rows at READ time; (b) `LimitSnapshot`s (e.g. codex `rate_limits` windows). Files never create AND never modify usage rows — no write-time merging: the meter's product/cost and the file's product/cost coexist, and the rank (explicit label > file > header sniff; reported cost > computed) is resolved at query time (`effectiveProduct`/`effectiveCost`). ONE documented exception: `POST /analytics/backfill` — a deliberate, operator-triggered bootstrap import of file-derived bucket history (`UsageEngine.backfillEvents()`), attestation `.selfReported` (runtime-ledger deltas `.measured`), model `(file import)`, deterministic id from `backfill|<tool>|<bucket>` so re-runs are INSERT OR IGNORE no-ops. Never automatic. Arrival order (file before/after the response) therefore cannot matter. Vendor/model/provider spellings are stored RAW as received — canonicalization happens exclusively in the read path and entirely in SQL (vendor CASE expression; model folds via the read-side `spelling` cache table joined in aggregation/filter queries); never rewrite stored rows to canonical form, and never merge observations early. Every row carries `machine_id` (persisted UUID); the alias lives ONCE per machine in the `machine` table (upserted on write, JOINed at read — never stored per row) and is inferred: TH_MACHINE_ALIAS > machine-alias file > sanitized hostname — alias is display-only, id is identity. **Wire encoding resolves the ranks**: UsageEvent.encode emits `product`/`cost` as the EFFECTIVE (query-time-ranked) values with the meter's raw observations as `productRaw`/`costRaw` — API consumers never re-implement the rank; decode stays synthesized over stored fields. The schema is v1 (`PRAGMA user_version = 1`) with NO migrations: pre-v1 databases are archived aside as `usage.legacy-<ts>.db` on open, never migrated. Limits and usage consolidate per vendor ACCOUNT (`AccountKey` = vendor + truncated SHA-256 of the credential; raw credentials are never stored); quota windows for different accounts of the same vendor are separate rows and must never merge.

15. **Capture modes are swappable and consent-scoped.** `SettingsStore.meterCaptureMode` (env `TH_CAPTURE_MODE`) selects point (default; corporate-safe: every measured byte was deliberately routed) or mitm. MITM mode: requires the dedicated `.mitm` consent (never auto-granted, headless only via TH_CONSENT=mitm), intercepts ONLY allowlisted AI vendor API hosts (all other TLS passes through undecrypted), delegates the TLS core to mitmproxy (never hand-rolled in core), and presents privileged setup (CA trust, proxy config) as user-run remediation steps — never silent sudo. Both modes emit identical UsageEvents into the same store; analytics/sync/UI stay mode-agnostic.

## UI invariants

- NotchPanel anchors top-flush to the notch screen (`auxiliaryTopLeft/RightArea` for exact bounds); expansion grows DOWNWARD only; hover uses the 60ms polled driver with hysteresis (0.12s in / 0.4s out) — never re-add `.onHover`-driven expansion (oscillation).
- `NSHostingView.sizingOptions = []` on panels; `canBecomeKey = true` (settings TextEditor needs Cmd+A); tooltips are custom hover bubbles (`.help()` never fires in non-activating panels).
- Tab content is inside `ScrollView(.vertical)` — clipping is a bug.
- No bottom statusline (user removed it). No menu bar item when a notch display exists.
- `heatmapExpanded` toggles 24W↔52W; heatmap sits LEFT of the chart; KPI cards (Total/Peak/Active days) beside it.

## Provider contract

`ProviderLimit { provider, label, usedPercent 0-100, resetsAt Date?, detail }` — one folder per
provider in `Sources/TokenHorizonCore/Providers/<Vendor>/`, quota adapter subclassing
`VendorLimitsAdapter`.
Required overrides: `fetch()` (fatalError if forgotten) and usually `auth` (a `VendorAuth`
credential chain from `Providers/Auth/`). Build rows via `limit(label:usedPercent:resetsAt:detail:)`
— it stamps the provider and clamps 0-100 automatically. Register by appending to
`PlanLimitsEngine.vendors`; the `LimitsEngine` base class supplies caching, throttled refresh,
and `.planLimitsUpdated` notifications. OAuth-style providers (e.g. `Providers/Kimi/`)
subclass `LimitsEngine` directly. UI/MCP/`/limits` pick new providers up automatically.
Group-by-provider rendering handles N windows per row.
Every provider is also `Meterable`: declare `meterTarget` (API base) and override `makeMeter`
only when the wire format isn't OpenAI-compatible (claude→AnthropicMeter, google→GeminiMeter).
Self-managed runtimes subclass `Providers/Runtimes/LocalInferenceRuntime` instead and get
both channels (Prometheus ledger + request meter) from the base.

Auth sources (checked in order):
- alibaba cookie: `SettingsStore.alibabaCookie` → env `ALIBABA_TOKEN_PLAN_COOKIE` (see `.agents/skills/provider-quota-alibaba/SKILL.md`)
- kimi: `KIMI_CODE_HOME`/`KIMI_HOME` + `~/.kimi-code/credentials/kimi-code.json` → `~/.kimi/credentials/…` (see `.agents/skills/provider-quota-kimi/SKILL.md`)
- glm/minimax/opencode-go: opencode `auth.json` keys (`zai-coding-plan`, `minimax-coding-plan`, `opencode-go`) (see `.agents/skills/provider-quota-zhipu/SKILL.md`, `minimax`, `opencode`)
- claude: `CLAUDE_CONFIG_DIR/.credentials.json` → Keychain `Claude Code-credentials` (see `.agents/skills/provider-quota-anthropic/SKILL.md`)
- gemini: `~/.gemini/oauth_creds.json` (see `.agents/skills/provider-quota-google/SKILL.md`)
- Complete provider quota skills catalog: `.agents/skills/provider-quota-*/SKILL.md`

## Verification checklist (run after changes)

```bash
./scripts/make-app.sh                     # build + relaunch
curl -s localhost:8765/health
curl -s localhost:8765/stats | python3 -m json.tool | head -40
curl -s "localhost:8765/trends?window=1D" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['points']), d['total'])"
curl -s localhost:8765/limits | python3 -m json.tool
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node mcp/token-horizon-mcp.mjs
```

Ground-truth checks when touching parsers:
- codex: `grep '"total_token_usage"' <file> | tail -1` per session, sum `total_tokens` → must equal parser all-time (verified exact before)
- opencode: session-table sums vs `message.data` per-model sums (json_extract)
- stress: 60× parallel `/stats` + `/event` curls; process must stay alive

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
```

**Test layout:**
```
Tests/TokenHorizonPerfTests/
  ModelsPipelinePerfTests.swift   perf budgets + dedup + search
  ScopeCountsCachingTests.swift   cached lookup is O(1), not O(n)
  CanonicalIdentityTests.swift    family-key dedup contract
  ProcessMetricsTests.swift       live process sampling and metric ordering
  ProcessTreeTests.swift          process hierarchy safety and ordering
  SystemHistoryTests.swift        I/O rates, cache behavior, and 24-hour retention
  Fixtures/catalog-7300.json      synthetic 7,300-row catalog (committed)
```

If a test fails with "REGRESSION", the pipeline is slower than the budget. Common causes:
- New filter pass inside `modelsTab` view body
- `countForScope(scope)` called inside `ForEach`
- `_filteredRows`/`_scopeCounts` mutated via `MainActor.run` but read on main thread (race)
- New field added to `ModelRow` whose computed property is expensive (e.g. another `.lowerCased().contains(q)`)

## Known gaps

- UsageEngine's bucket-keeping half is still live for the macOS app UI (UIModel reads
  engine.snapshot() directly); the HTTP endpoints are store-first. Deleting the duplicate
  bucket aggregation requires rewiring the macOS app onto the store first.
- macOS-app files converted to the shared HTTP helper (ClaudeDiscovery, BuildInfo,
  Catalog/ModelCatalog) compile only on macOS — verify with ./scripts/make-app.sh.
- alibaba 5h window intermittently absent (gateway omits it; retry ×3 handles most cases)
- minimax/glm/opencode-go keys expire per opencode re-auth — limits silently drop rows when 401
- claude token refresh not implemented (reads stored access token only; re-login fixes 401s)
- alibaba cookie is manual paste; browser auto-import not implemented
- pi ignores `models.json` provider `baseUrl`: model-level entries from
  `models-store.json` (refreshed from pi's remote catalog at startup) replace
  local entries wholesale (`mergeModels` matches on id), so meter routing must
  be patched into `models-store.json` (all `baseUrl`s → the loopback meter),
  not just `models.json`. Verified `pi update --models` does not revert it,
  but a catalog-side URL change would. Upstream issue: earendil-works/pi —
  user endpoint overrides should survive the catalog merge. Agent runbook:
  `docs/agent-guides/pi-meter-routing.md` (+ upstream draft in
  `docs/agent-guides/upstream-issues/`).
