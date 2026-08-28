# Token Horizon

Native macOS statusline + notch dashboard tracking AI token usage, costs, system stats, and provider plan limits. Built with Swift + AppKit/SwiftUI, system SQLite, and the OpenTelemetry Swift SDK for optional metrics export.

## Surfaces

| Surface | When | Contents |
|---|---|---|
| **Notch panel** | notch display present | Collapsed: CPU/MEM activity rings flanking the camera. Hover: tabbed popout |
| **Menu bar + popover** | no notch (closed lid / external display) | `◉ cpu% mem%` item, popover with the same tabs. Force with `TOKEN_HORIZON_FORCE_TRAY=1` |
| **Bottom statusline** | removed | — |
| **Dashboard window** | ⤢ button in any popout | Resizable window, all tabs |

Tabs: **ACTIVITY** (CPU, memory, disk I/O, and network sparklines; top processes by CPU/RSS/disk/network) · **MLX** (independent MLX/Ollama runner observability: CPU, memory, disk rates, 5M/1H/6H/24H bounded rollups, and measured tok/s when available) · **TOKENS** (today/all-time, window pills 1D–1Y + stacked provider chart, 365-day heatmap with KPI cards, BY TOOL, MODELS incl. free vs pay-go, PLAN LIMITS, recent sessions) · **SHELLS** (recent zsh commands) · **⚙ SETTINGS** (Alibaba cookie editor + provider notes).

## Performance Stats

The ACTIVITY tab samples system performance every 2 seconds on a utility queue. CPU and memory use native Mach/VM counters. Disk throughput uses cumulative `iostat` counters, and network throughput sums non-loopback interface byte counters from `getifaddrs`. I/O collection is cached for 4 seconds so the external disk query does not run on every UI tick.

The MLX tab is an independent observer for `ollama runner --mlx-engine` and `mlx-lm` process trees. It samples only matching processes and their children, so it does not enable the heavier general process table. MLX histories are bounded to the same fine-sample ceiling as system history. tok/s is captured from Ollama's completed response metadata (`eval_count` / `eval_duration`) or the benchmark cache; it is never inferred from CPU, memory, or network traffic.

Token Horizon also starts a lightweight local Ollama telemetry proxy at `http://127.0.0.1:11435` when that port is available. If it is occupied, the app tries the next 19 loopback ports and shows the selected port in the MLX tab. Point an Ollama-compatible client at that endpoint to capture exact completion metrics without changing Ollama or the MLX runner. The proxy forwards streaming responses unchanged and keeps only the latest 256 model samples. Set `TOKEN_HORIZON_OLLAMA_PROXY_PORT` to change the starting port and `TOKEN_HORIZON_OLLAMA_UPSTREAM` when Ollama is not on `127.0.0.1:11434`.

The proxy cannot observe traffic sent directly to `11434`; the calling client must use `http://127.0.0.1:11435` as its Ollama-compatible base URL. Token Horizon's own Ollama model discovery and benchmark requests are routed through it automatically. The listener is loopback-only and does not expose the Ollama API to other machines.

History is intentionally an in-memory rolling window:

- Fine samples: 1,800 points at 2-second resolution, covering approximately 1 hour.
- Coarse samples: one average every 30 seconds, capped at 2,880 points, covering approximately 24 hours.
- Once a limit is reached, the oldest values are discarded. No raw samples are persisted to disk, so memory use stays bounded.
- Per-process sampling remains enabled only while the process table is visible; process history is not retained.

### Metrics

`GET http://127.0.0.1:8765/metrics` serves Prometheus text from the OpenTelemetry meter. Ollama request/completion counters, token counters, generation duration, tok/s, and current MLX resource gauges are included. Model labels are normalized and capped at 32 distinct values; additional models use `model="other"`.

`GET http://127.0.0.1:8765/health` includes `ollama_proxy_port`, allowing clients to discover the selected relay port when the default port is occupied.

OTLP/HTTP metrics export is disabled by default. Set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to an explicit metrics endpoint, or set `OTEL_EXPORTER_OTLP_ENDPOINT` to a base endpoint (Token Horizon appends `/v1/metrics`). The export interval is 60 seconds. Prometheus remains local and does not require an external collector.

Regression coverage is in `Tests/TokenHorizonPerfTests/SystemHistoryTests.swift` and `ProcessMetricsTests.swift`. Run `swift test --filter SystemHistoryTests` for the history/I/O checks or `swift test` for the complete suite.

## Build & run

```bash
cd ~/projects/token-horizon
./scripts/make-app.sh          # swift build -c release + TokenHorizon.app bundle + relaunch
```

`make-app.sh` launches the bundled executable directly so
`TOKEN_HORIZON_OLLAMA_UPSTREAM` and `TOKEN_HORIZON_OLLAMA_PROXY_PORT` are
inherited. The app writes its launch log to
`~/Library/Logs/TokenHorizon.log`.

The local script uses an ad-hoc signature for development. For a distributable full-feature build, use `scripts/package-notarized.sh` with a Developer ID Application certificate; see `docs/notarized-release.md`. This build intentionally is not App Sandbox-compatible because it reads local AI tool data and observes system processes.

- Icon: `scripts/make-icon.swift` → `Resources/AppIcon.icns` (black hole, CoreGraphics)
- Settings: `~/.config/token-horizon/settings.json` (0600) — alibaba cookie lives here
- Shell hook: `shell/token-horizon.zsh` (sourced from `~/.zshrc`) — posts cwd/duration/exit per command; `th` CLI (`th /stats`, `th /limits`, …)

## HTTP API (127.0.0.1:8765)

| Endpoint | Returns |
|---|---|
| `GET /stats` | usage (today/all-time, perTool, models, limits, sessions) + system (cpu/ram/load) |
| `GET /history?days=N` | N daily points (7–370) with per-tool breakdown + streak |
| `GET /trends?window=1D\|1W\|1M\|3M\|1Y` | hourly (1D) or daily/weekly bars, per-provider |
| `GET /limits` | merged plan limits (all providers) |
| `GET /events` | recent shell events |
| `GET /health` | liveness + version |
| `GET /metrics` | Prometheus/OpenTelemetry metrics text |

## MCP server

`mcp/token-horizon-mcp.mjs` (zero-dep Node, stdio JSON-RPC). Registered in `~/.config/opencode/opencode.jsonc`. Tools: `token_horizon_usage` (incl. per-model), `token_horizon_system`, `token_horizon_sessions`, `token_horizon_history`, `token_horizon_limits`, and `token_horizon_proxy_guide`. Call `token_horizon_proxy_guide` with `client="startup"` for the safe Ollama-upstream plus Token Horizon-proxy startup sequence, live proxy status, verification commands, and warnings against binding `ollama serve` to the proxy port. Falls back to direct sqlite for usage/sessions if the app isn't running.

## Provider requirements

| Provider | Token usage source | Limits/quotas | Requirements |
|---|---|---|---|
| **opencode** | `~/.local/share/opencode/opencode.db` (sqlite ro; sessions + per-model via `message.data` JSON) | — | opencode installed/used |
| **claude** | `~/.claude/projects/**/*.jsonl` (+ `transcripts/`), additive `message.usage` + `costUSD` | `api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`); windows `five_hour`/`seven_day`/`seven_day_oauth_apps` + `limits[] weekly_scoped` | Claude Code OAuth login: `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) or macOS Keychain `Claude Code-credentials` |
| **codex** | `~/.codex/sessions/` + `archived_sessions/` JSONL — see watermark protocol below | `rate_limits.primary` embedded in the same files (`used_percent`, `window_minutes`, `resets_at`) — offline, no auth | Codex CLI/Desktop used |
| **kimi** | `~/.kimi*/sessions/**/wire.jsonl` (`StatusUpdate.payload.token_usage`; snake `input_other` + camel `inputOther` aliases) | `api.kimi.com/coding/v1/usages` (Bearer); `usage.limit`+`used`, `limits[].window.timeUnit` | OAuth creds `~/.kimi-code/credentials/kimi-code.json` (or `~/.kimi/credentials/`, `KIMI_HOME`/`KIMI_CODE_HOME` override); auto token refresh via `auth.kimi.com` (client_id `17e5f671-d194-4dfb-9706-5516cb48c098`) |
| **glm** | `~/.zcode/projects/**/*.jsonl` (generic scanner) | `api.z.ai/api/monitor/usage/quota/limit` → `data.limits[].percentage` | `zai-coding-plan` (or `zai`) API key in opencode `auth.json` |
| **minimax** | — (no local files; API-only) | `minimax.io/v1/token_plan/remains` → `model_remains[0]` interval/weekly remaining % | `minimax-coding-plan` key in opencode `auth.json` (or `MINIMAX_TOKEN_PLAN_*` env) |
| **opencode-go** | — | `opencode.ai/zen/go/v1/usage` → `usage.{rolling,weekly,monthly}.percent/resetsAt` | `opencode-go` key in opencode `auth.json` |
| **alibaba** | — | Bailian OneConsole rolling-window API — see protocol below | **Browser cookie** for `bailian-singapore-cs.alibabacloud.com` (⚙ SETTINGS tab, or `settings.json alibabaCookie`, or `ALIBABA_TOKEN_PLAN_COOKIE`); `sec_token` auto-scraped from ModelStudio dashboard |
| **gemini** | `~/.gemini/` (stubbed) | `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | Gemini CLI login (`~/.gemini/oauth_creds.json`) — activates automatically |
| **qwen / grok / deepseek** | generic additive scanner on `~/.qwen/projects`, `~/.grok/sessions`, `~/.dsh/sessions` | — | auto-activate when dirs appear |

## Protocols & gotchas (learned the hard way)

- **Codex watermark algorithm** (ported from tokscale `crates/tokscale-core/src/sessions/codex.rs`): track per-field (input/output/cached/reasoning) watermarks; delta only when monotonic; regression ≤2% = stale snapshot (skip, don't touch watermark); hard reset → count `last_token_usage` instead. `cached = max(cached_input, cache_read)` is a SUBSET of input; `reasoning` a SUBSET of output → display tokens = input + output.
- **All usage buckets are hourly** (epoch-hour keys). "Today" filters compare `bucket >= localMidnight`. Daily/weekly views aggregate hourly.
- **SQLite**: open with `SQLITE_OPEN_FULLMUTEX` + engine-level `NSLock` — concurrent access from the refresh timer and HTTP handlers segfaulted with `NOMUTEX`.
- **Multi-root scans** (codex sessions + archived) must share one state dict and filter by path prefix — filtering by `seen` alone wipes the other root's incremental offsets (caused double-counting).
- **Alibaba OneConsole**: must be **POST** form-encoded (`product/action/region/language/params`), `params` = `{"Api", "V":"1.0", "Data":{"cornerstoneParam":{feTraceId, feURL, protocol V2, ONE_CONSOLE, productCode p_efm, consoleSite MODELSTUDIO_ALBABACLOUD, domain, X-Anonymous-Id = cna cookie}}}`, plus `sec_token` scraped from the ModelStudio dashboard HTML and CSRF headers from `login_aliyunid_csrf`. GET with query params → Taobao login page. Windows nested at `data.DataV2.data.data` as RATIOS (`per5HourPercentage`, `per1WeekPercentage`); gateway intermittently returns empty windows → retry ×3.
- **Kimi quota fields**: plan usage is `usage.limit` + `usage.used` (NOT `remaining`); rolling windows use `remaining` + camelCase `timeUnit` (`TIME_UNIT_MINUTE`).
- **Claude quota**: `utilization` is used directly as percent.
- **Starship** (still installed): custom modules can't be referenced as `$custom.name` in the root format — `$custom` renders all; `[cpu]` isn't a built-in module.
- **Non-activating panels**: `.help()` tooltips never fire → custom hover bubbles; `NSHostingView.sizingOptions = []` or intrinsic size pushes the panel off-screen; panel must be key-able (`canBecomeKey = true`) for TextEditor editing (Cmd+A).
- **Bottom bar removed** by user preference — notch when present, systray popover when not.
