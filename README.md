# Token Horizon

[![GitHub release](https://img.shields.io/github/v/release/castlemilk/token-horizon?include_prereleases)](https://github.com/castlemilk/token-horizon/releases/latest)
[![Landing page](https://img.shields.io/badge/site-token--horizon.dev-7c5cff)](https://token-horizon.dev/)

Native macOS statusline + notch dashboard tracking AI token usage, costs, system stats, and provider plan limits. Built with Swift + AppKit/SwiftUI, system SQLite, and the OpenTelemetry Swift SDK for optional metrics export.

🌐 **Landing page:** https://token-horizon.dev/ · 🎬 **Film below** · 📦 [Releases](https://github.com/castlemilk/token-horizon/releases/latest)

## Product film

<video src="https://github.com/castlemilk/token-horizon/releases/download/v0.3.0/TokenHorizon-film.mp4" poster="https://raw.githubusercontent.com/castlemilk/token-horizon/main/docs/assets/og.png" controls width="100%"></video>

*Forty seconds, rendered entirely in code ([`video/`](video/) — Remotion, zero stock footage). Also embedded on the [landing page](https://token-horizon.dev/#film).*

## Getting started

Requires macOS on Apple silicon. Three steps, under two minutes:

**1. Install** — one line, no prompts, no sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/castlemilk/token-horizon/main/install.sh | bash
```

This installs the latest release to `/Applications`, enables crash auto-recovery, and wires up the `th` shell helper. Alternatives: `brew tap castlemilk/tap && brew install --cask token-horizon` · [DMG from GitHub Releases](https://github.com/castlemilk/token-horizon/releases/latest) · build from source with `./scripts/make-app.sh`.

**2. Glance at your notch** (menu bar if you have no notch): the CPU/MEM rings are live. Hover to open the panel and flip through the tabs — **TOKENS** (usage, costs, plan limits), **ACTIVITY** (Mac performance), **MLX** (local models), **LEADERBOARD**, **SHELLS**, **⚙ SETTINGS**. The ⤢ button pops everything out into a resizable dashboard window.

**3. Confirm it's tracking you:**

```bash
curl -s localhost:8765/health | python3 -m json.tool   # must report this checkout's commit
th /stats     # usage + system snapshot in your terminal
th /limits    # remaining quota on every provider plan
```

If `/health` reports a different commit than `git rev-parse --short HEAD`, the running binary is stale — rebuild with `./scripts/make-app.sh`, don't debug the data.

**Next steps:** connect your coding agent via the [MCP server](#mcp-server) · compare usage with your team ([Leaderboard](#leaderboard--backend-options)) · track a model catalogue that updates itself with live pricing · hack on it: [`TESTING.md`](TESTING.md) + `task validate`.

## Surfaces

| Surface | When | Contents |
|---|---|---|
| **Notch panel** | notch display present | Collapsed: CPU/MEM activity rings flanking the camera. Hover: tabbed popout |
| **Menu bar + popover** | no notch (closed lid / external display), forced, or pinned alongside the notch | CPU/MEM rings + `◉ cpu% mem%` item, popover with the same tabs. ⚙ SETTINGS → Surface: auto / notch / menu bar (+ “also show menu bar” toggle). `TOKEN_HORIZON_FORCE_TRAY=1` always forces menu bar |
| **Bottom statusline** | removed | — |
| **Dashboard window** | ⤢ button in any popout | Resizable window, all tabs |

Tabs: **ACTIVITY** (CPU, memory, disk I/O, and network sparklines; top processes by CPU/RSS/disk/network) · **MLX** (independent MLX/Ollama runner observability: CPU, memory, disk rates, 5M/1H/6H/24H bounded rollups, and measured tok/s when available) · **TOKENS** (today/all-time, window pills 1D–1Y + stacked provider chart, 365-day heatmap with KPI cards, BY TOOL, MODELS incl. free vs pay-go, PLAN LIMITS, recent sessions) · **LEADERBOARD** (team & multi-account rankings across Today/7D/All-Time/Streak periods, edge-cached Cloudflare Worker+R2 backend with TTL/change-gated sync — Google Sheets stays as legacy fallback — and live SVG/Markdown share card previews) · **SHELLS** (recent zsh commands) · **⚙ SETTINGS** (Desktop widget configuration with live preview, Alibaba cookie editor + Google Sheets leaderboard config + provider notes).

### Desktop widget

`Widget/` ships a native WidgetKit extension (macOS 14+) embedded at build time by `scripts/make-widget.sh`. Add it from the desktop's **Edit Widgets** gallery in small/medium/large. The widget has a 3-page carousel (‹ ›): **usage** (token total, per-provider stacked bars, compressed Σ/⌀/peak stats, provider legend with brand marks), **plan limits** (usage bars per provider with reset countdowns), and **plans & resets** (soonest-expiring callout plus expiry-sorted rows, urgency-colored <24h/<48h). The chart carries a segmented **1H · 1D · 1W · 1M · 1Y** picker — 24 hourly bars, 7 daily, 17 weekly, 30 daily, 12 monthly — and the GitHub-style heatmap always matches the selected window (12×2 / 7×1 / 17×7 / 15×2 / 6×2 cells). Configure everything in ⚙ SETTINGS → Desktop widget (enable, period, accent, show cost/limits/chart) with a live preview; the app publishes a versioned snapshot to the extension via `GET /widget`. Widget taps are `tokenhorizon://` deep links (window/page), so the app owns the state and the widget, preview and app always agree.

## Performance Stats

The ACTIVITY tab samples system performance every 2 seconds on a utility queue. CPU and memory use native Mach/VM counters. Disk throughput uses cumulative `iostat` counters, and network throughput sums non-loopback interface byte counters from `getifaddrs`. I/O collection is cached for 4 seconds so the external disk query does not run on every UI tick.

The MLX tab is an independent observer for `ollama runner --mlx-engine` and `mlx-lm` process trees. It samples only matching processes and their children, so it does not enable the heavier general process table. MLX histories are bounded to the same fine-sample ceiling as system history. tok/s comes from Ollama's completed response metadata (`eval_count` / `eval_duration`) or the benchmark cache; the displayed rate uses a small token-weighted recent window so short completions do not create misleading spikes. It is never inferred from CPU, memory, or network traffic.

Click an Ollama model row in MODELS or an MLX runner row in the MLX tab to inspect its local configuration. Ollama details combine the complete `/api/tags` and `/api/show` payloads, including size, digest, format, family, parameter count, context, quantization, capabilities, templates, and model info. Direct MLX model paths are inspected for their model files and JSON configuration, with total size, format, and inferred quantization shown when available.

Token Horizon also starts a lightweight local Ollama telemetry proxy at `http://127.0.0.1:11435` when that port is available. If it is occupied, the app tries the next 19 loopback ports and shows the selected port in the MLX tab. Point an Ollama-compatible client at that endpoint to capture exact completion metrics without changing Ollama or the MLX runner. The proxy forwards streaming responses unchanged and keeps a bounded recent window for up to 256 model names. Set `TOKEN_HORIZON_OLLAMA_PROXY_PORT` to change the starting port and `TOKEN_HORIZON_OLLAMA_UPSTREAM` when Ollama is not on `127.0.0.1:11434`.

The proxy cannot observe traffic sent directly to `11434`; the calling client must use `http://127.0.0.1:11435` as its Ollama-compatible base URL. Token Horizon's own Ollama model discovery and benchmark requests are routed through it automatically. The listener is loopback-only and does not expose the Ollama API to other machines.

### LLM gateway (drop-in proxy for Codex / Claude Code / others)

Token Horizon supervises a standalone Go sidecar (`gateway/`, zero-dep single binary, `token-horizon-gateway`) listening at `http://127.0.0.1:11436` (next free port if occupied; see `llm_gateway_port` in `/health` and the MLX tab). It also runs headless without the app — handy on Linux boxes or servers. Point any provider client at it as its base URL — no other config change needed:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:11436"       # Codex, OpenAI SDKs (/v1/chat/completions, /v1/responses)
export ANTHROPIC_BASE_URL="http://127.0.0.1:11436"    # Claude Code (/v1/messages)
export OLLAMA_HOST="http://127.0.0.1:11436"           # Ollama clients (/api/*)
```

The gateway infers the provider per request (path → auth headers → body shape; `/th-openai/` and `/th-anthropic/` prefixes force it), forwards to the provider over HTTPS, and streams the response back unchanged. Every relayed response carries an `x-token-horizon-trace-id` header for joining client logs to traces.

What it stores beyond harness conversation logs: harness logs record what the harness chose to persist after the fact. The gateway measures the live wire — time-to-first-token, total duration, provider-reported token usage (never estimated), cache-hit splits, tool-call names/ids with finish reasons, retry suspects (same normalized request repeated within 10 minutes), best-effort cost via the model catalog, and an error taxonomy (auth / rate-limited / overloaded / context-length / …). Cloud traces do not feed usage totals (the file parsers already count that traffic, so totals would double-count); Ollama traces additionally feed local tok/s telemetry so MODELS stays correct whichever loopback port a client uses.

- Traces: `GET /traces?provider=openai&model=gpt-5&limit=25` (bodies omitted), `GET /traces/<id>` (full bodies), `POST /traces/clear`
- Stats: `GET /proxy/stats?provider=anthropic&hours=24` (TTFT, tok/s, cache-hit, tool-call, retry, error rates per model)
- Config: `GET /proxy/config` (ports, upstream hosts, storage bounds — never secrets)
- Metrics: `token_horizon_gateway_requests_total`, `token_horizon_gateway_completed_total{status}`, `token_horizon_gateway_ttft_seconds`, `token_horizon_gateway_duration_seconds`, `token_horizon_gateway_output_tokens_total` on the gateway's own `/metrics` (the sidecar owns its instruments; `:8765/metrics` keeps Ollama/MLX/engine series)

Privacy and bounds: full request/response bodies stay in `~/.config/token-horizon/traces/` on this machine only (256KB per side per trace, 30 day-files, 256MB total, oldest pruned first). Auth headers pass through upstream and are never stored; traces are never published to the leaderboard, sheets, or cloud. Upstreams default to `https://api.openai.com` / `https://api.anthropic.com` plus the Ollama upstream; override with `TOKEN_HORIZON_OPENAI_UPSTREAM` / `TOKEN_HORIZON_ANTHROPIC_UPSTREAM` / `TOKEN_HORIZON_OLLAMA_UPSTREAM` (handy for mocks), and set `TOKEN_HORIZON_LLM_PROXY_PORT` to move the listener. Redirects are never followed with client credentials attached. The `:8765` endpoints above are reverse-proxied from the sidecar by the app (`GatewayBridge`, degrading to 503 when the sidecar is down); cost estimates are intentionally absent from traces — pricing lives with the model catalog, not the proxy. See `gateway/README.md` for the sidecar contract, standalone use, and its Go test suite.

History is intentionally an in-memory rolling window:

- Fine samples: 1,800 points at 2-second resolution, covering approximately 1 hour.
- Coarse samples: one average every 30 seconds, capped at 2,880 points, covering approximately 24 hours.
- Once a limit is reached, the oldest values are discarded. No raw samples are persisted to disk, so memory use stays bounded.
- Per-process sampling remains enabled only while the process table is visible; process history is not retained.

### Metrics

`GET http://127.0.0.1:8765/metrics` serves Prometheus text from the OpenTelemetry meter. Ollama request/completion counters, token counters, generation duration, tok/s, gateway request/completion/TTFT/duration/token counters (per provider/endpoint, model labels capped with the shared 32-value set), and current MLX resource gauges are included. Model labels are normalized and capped at 32 distinct values; additional models use `model="other"`.

`GET http://127.0.0.1:8765/health` includes `ollama_proxy_port` and `llm_gateway_port`, allowing clients to discover the selected relay ports when the defaults are occupied.

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

The local script uses an ad-hoc signature for development; published releases are Developer ID signed and Apple-notarized (`scripts/package-notarized.sh`, wired into the release workflow); see `docs/notarized-release.md`. This build intentionally is not App Sandbox-compatible because it reads local AI tool data and observes system processes.

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
| `GET /leaderboard?period=today\|week\|all\|streak&team=...` | ranked multi-period token leaderboard with badges & percentiles |
| `GET /leaderboard/share?period=...&format=text\|markdown\|json\|svg&copy=1` | formatted share card (terminal box, markdown table, json, or standalone SVG) |
| `GET /leaderboard/web` | 302 redirect to the GitHub Pages web leaderboard with sheet parameter |
| `POST /leaderboard/sheets/publish` | push local token stats to configured Google Sheet |
| `GET\|POST /leaderboard/sheets/pull` | pull team rankings from Google Sheet |
| `POST /leaderboard/sheets/config` | configure leaderboard handle, team, Google Sheet URL, and auto-sync |
| `GET /events` | recent shell events |
| `GET /traces?provider=&model=&limit=` | recent gateway traces (bodies omitted) + store counts |
| `GET /traces/<id>` | one full gateway trace with request/response bodies |
| `POST /traces/clear` | drop in-memory traces + delete trace day files |
| `GET /proxy/stats?provider=&model=&hours=` | gateway efficiency stats (TTFT, tok/s, cache-hit, tool-call, retry, errors) |
| `GET /proxy/config` | gateway port, upstream hosts, trace storage bounds |
| `GET /health` | liveness + version |
| `GET /widget` | versioned desktop-widget snapshot (hourly/days/weeks/months stacks, heatmap, limits, prefs) |
| `POST /widget/window?value=hours\|days\|weeks\|months\|years` | set the widget chart window (same path as the widget's deep links) |
| `GET /metrics` | Prometheus/OpenTelemetry metrics text |

## MCP server

`mcp/token-horizon-mcp.mjs` (zero-dep Node, stdio JSON-RPC). Registered in `~/.config/opencode/opencode.jsonc`. Tools: `token_horizon_usage` (incl. per-model), `token_horizon_system`, `token_horizon_sessions`, `token_horizon_history`, `token_horizon_limits`, `token_horizon_proxy_guide` (Ollama startup sequence plus universal gateway drop-in configs for `client="codex"` / `client="claude"` / `client="opencode"`), `token_horizon_leaderboard` (get rankings, publish/pull Google Sheet, or get GitHub Pages web URL), and `token_horizon_share` (generate text/markdown/json/svg share cards). Call `token_horizon_proxy_guide` with `client="startup"` for the safe Ollama-upstream plus Token Horizon-proxy startup sequence, live proxy status, verification commands, and warnings against binding `ollama serve` to the proxy port. Falls back to direct sqlite for usage/sessions if the app isn't running.

## Leaderboard & Backend Options

Token Horizon includes a built-in team and cross-account leaderboard system with two collaborative backend options: **Cloudflare Edge + R2** (ultra-fast, <25ms) and **Google Spreadsheets** (zero-infrastructure, ~1-3s).

The edge-hosted **Token Horizon** dashboard (`docs/leaderboard.html`) ships eight real-data views — Dashboard deep-dive, Leaderboard (league ladder + MMR + Top Movers/Most Improved), Player Profile (usage/costs, prompts, projects, comparisons, achievements), Teams, Models (provider breakdown), Billing, Leagues & Season Progression, and Sharing & Access Control — plus the Share Usage Report modal and public `/s/<id>` report links. Prompt history is visible only inside the individual profile (opt-in per owner, `leaderboardSharePrompts`); there is no public cross-user prompts surface. Usage-over-time charts are stacked bars by model with a structured tooltip (vendored [TanStack Charts](https://tanstack.com/charts), rebuilt via `npm run vendor`); provider brand marks match the app's model list, and every player gets an avatar — Google photo, uploaded image, or a deterministic generated style (vendored [DiceBear](https://dicebear.com)). League/MMR/season/efficiency/achievement math lives in `Sources/TokenHorizon/Leaderboard/LeaderboardAnalytics.swift` and is mirrored by the worker; rank history comes from bounded daily snapshots appended on each publish (movers and league progression stay empty until ≥2 days of publishes exist). Screen-by-screen objective-vs-current alignment and the full data flow live in [`LEADERBOARD.md`](LEADERBOARD.md).

### Backend Comparison

| Feature | Cloudflare Edge + R2 (Recommended) | Google Sheets (No Infra) |
|---|---|---|
| **Global Latency** | **<25ms** (Edge-cached across 330+ cities) | 1,500ms – 3,000ms (Apps Script cold-start) |
| **Object Storage** | Cloudflare R2 (`leaderboard.json`) | Google Drive Sheet |
| **Web Hosting** | Edge-hosted via Worker `[assets]` (`../docs`) | GitHub Pages (`castlemilk.github.io`) |
| **Dynamic README Badges** | `GET /api/share?handle=...&format=svg` (live SVG badge) | Offline generated SVG |
| **Setup Effort** | 1 command (`./scripts/deploy-cloudflare.sh`) | Paste Apps Script into Sheet Extensions |

---

### Cloudflare Edge Webhosting & R2 Backend (Ultra-Fast)

Deploy a private or team leaderboard edge API and web dashboard in seconds:

1. **Deploy with 1 Command**:
   ```bash
   ./scripts/deploy-cloudflare.sh
   ```
   This creates the Cloudflare R2 bucket `token-horizon-leaderboard`, bundles the static web dashboard from `docs/`, and deploys the Worker to Cloudflare's global edge network.

2. **Connect Token Horizon Desktop App**:
   ```bash
   th leaderboard config cf "https://token-horizon-leaderboard.<your-subdomain>.workers.dev"
   ```
   Or paste the URL in the **⚙ SETTINGS** tab or the **LEADERBOARD** drawer in Token Horizon.

3. **Publish & Pull Usage**:
   ```bash
   th leaderboard publish --cf   # push your current usage to Cloudflare R2
   th leaderboard pull --cf      # pull team rankings from edge
   th leaderboard web            # open edge leaderboard in browser
   ```

4. **Dynamic SVG Badges for GitHub READMEs**:
   Embed live auto-updating token usage cards in your GitHub profile or repository README:
   ```markdown
   [![AI Token Usage](https://token-horizon.dev/api/share?handle=yourname&format=svg)](https://token-horizon.dev/leaderboard)
   ```

5. **Google sign-in (optional, recommended for public deployments)**:
   Users sign in with Google to claim profiles, manage sharing, and publish to a claimed handle. The worker verifies the GSI ID token (RS256 against Google's JWKS) — unsigned tokens are rejected once a client ID is configured.
   1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   2. **Authorized JavaScript origins**: `https://token-horizon.dev` (add `http://localhost:8765` for local testing).
   3. Put the client ID (a public value) in `cloudflare/wrangler.toml`:
      ```toml
      [vars]
      GOOGLE_CLIENT_ID = "1234567890-abc.apps.googleusercontent.com"
      ```
   4. `./scripts/deploy-cloudflare.sh` — the dashboard fetches `/api/config` and renders the official Google button.
   For daemon publishes from the Mac app, set a shared machine secret instead:
   `npx wrangler secret put LEADERBOARD_SECRET` and paste the same value into the app's leaderboard cloud token field.

### Custom domain (token-horizon.dev)

`token-horizon.dev` is the canonical host (Worker custom domain + `www` → apex redirect). To onboard a new domain to Cloudflare:
```bash
./scripts/onboard-domain.sh          # dashboard steps, or run with CLOUDFLARE_API_TOKEN to create the zone
# set the printed nameservers at the registrar (Vercel → Domains → Nameservers)
./scripts/onboard-domain.sh --check  # poll until the zone is Active
./scripts/deploy-cloudflare.sh       # deploy routes + assets
```

---

### Google Spreadsheet Backend (Zero-Infra Alternative)
You can alternatively use a Google Sheet as a shared backend across your team or personal machines:

1. **Option A: Google Apps Script Web App (Read + Write)**:
   - Create a Google Sheet.
   - Open **Extensions > Apps Script** and paste the code from [`scripts/google-sheets-leaderboard.js`](file:///Users/benebsworth/projects/token-horizon/scripts/google-sheets-leaderboard.js).
   - Click **Deploy > New deployment**, select **Web app**, set *Execute as* to **Me**, and *Who has access* to **Anyone**.
   - Copy the Web App URL (`https://script.google.com/macros/s/<ID>/exec`).
   - Configure in Token Horizon:
     ```bash
     th leaderboard config sheets "https://script.google.com/macros/s/<ID>/exec"
     ```
2. **Option B: Public Google Sheet CSV (Read-Only Feed)**:
   - In your Google Sheet, choose **File > Share > Publish to web**, select **Entire Document** as **CSV**, and click Publish.
   - Or paste the normal sheet URL (`https://docs.google.com/spreadsheets/d/<ID>/edit`); Token Horizon automatically resolves it to the CSV export endpoint.

### Shell CLI Commands
```bash
th leaderboard                # view today's leaderboard rankings
th leaderboard week           # view 7-day rolling rankings
th leaderboard all            # view all-time rankings
th leaderboard streak         # view active streak rankings
th leaderboard web            # open leaderboard web dashboard in browser
th leaderboard publish --cf   # push stats to Cloudflare Edge + R2
th leaderboard pull --cf      # pull rankings from Cloudflare Edge
th leaderboard publish --sheets # push stats to Google Sheet
th leaderboard config cf <url> # configure Cloudflare Worker URL
th leaderboard config sheets <url> # configure Google Sheet URL
th share                      # generate and copy share card to clipboard
th share markdown --copy      # generate GitHub Markdown share card and copy
th share svg > usage-card.svg # export SVG share card
```

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
