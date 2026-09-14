# token-horizon-gateway

Standalone loopback-only LLM reverse proxy with full conversation-trace
capture. Zero dependencies (stdlib only), one static binary, runs anywhere
Go builds: macOS, Linux, Windows.

```bash
export OPENAI_BASE_URL="http://127.0.0.1:11436"       # Codex, OpenAI SDKs
export ANTHROPIC_BASE_URL="http://127.0.0.1:11436"    # Claude Code
export OLLAMA_HOST="http://127.0.0.1:11436"           # Ollama clients
```

## Why a sidecar, not in-app code

- **Portability**: the Mac app is macOS-only and must be running. The
  gateway runs headless on any box that runs harnesses.
- **Performance**: per-connection goroutines + stdlib reverse proxy; the
  app's UI process never touches request bytes.
- **Decoupling**: the gateway owns capture, storage, and its trace API.
  The app (or anything else) consumes traces over HTTP or JSONL. Crashes
  and deploys are independent.

## Build & run

```bash
cd gateway
go build -o token-horizon-gateway .   # single static binary
./token-horizon-gateway               # listens on 127.0.0.1:11436
```

Release builds stamp commit/time (`scripts/make-app.sh` passes
`-ldflags "-X main.buildCommit=<sha> -X main.buildAt=<utc>"`, reported in
`/__token_horizon`); the app's supervisor compares that stamp against its
own and logs mismatches loudly. Unstamped dev builds report `dev`.

The Token Horizon Mac app supervises this binary automatically (bundled in
`TokenHorizon.app/Contents/Resources/`, launched on app start, attached to
if already running). `TOKEN_HORIZON_GATEWAY_BIN` points the app at a dev
build instead.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `TOKEN_HORIZON_LLM_PROXY_PORT` | `11436` | First loopback port; next 19 tried on conflict |
| `TOKEN_HORIZON_OPENAI_UPSTREAM` | `https://api.openai.com` | OpenAI base (http(s) override = mocks) |
| `TOKEN_HORIZON_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Anthropic base |
| `TOKEN_HORIZON_OLLAMA_UPSTREAM` | `127.0.0.1:11434` | Ollama (bare host:port accepted) |
| `TOKEN_HORIZON_TRACE_DIR` | `~/.config/token-horizon/traces` | JSONL day-file directory |
| `TOKEN_HORIZON_INGEST_URL` | `http://127.0.0.1:8765/ingest/ollama` | Best-effort Ollama sample POST to the app (empty disables) |
| `TOKEN_HORIZON_GATEWAY_BIN` | — | App-side only: sidecar binary override |

## Behavior contract

- **Routing** (per request): path → auth headers → body shape
  (`infer.go`). `/th-openai/` + `/th-anthropic/` prefixes force the
  provider. Unknown paths get 400 (no trace recorded).
- **Relay**: response bytes stream unchanged; an
  `x-token-horizon-trace-id` header joins client logs to traces.
  Rate-limit/request-id headers relay for SDK backoff; auth/cookies never
  flow downstream. Redirects are never followed with client credentials.
  Requests over 32MB get 413.
- **Traces**: full bodies local-only (`256KB`/side, 30 day-files, 256MB,
  oldest pruned). Token counts are provider-reported or absent — never
  estimated. `estCostUSD` is always null: pricing lives with the catalog,
  not the proxy.
- **Usage totals**: cloud traces do NOT feed usage engines (file parsers
  already count that traffic). Ollama traces additionally POST a sample to
  the ingest URL so local totals stay correct on either loopback port.
- **Read API** (same port, loopback): `GET /traces?provider=&model=&limit=`
  (bodies omitted), `GET /traces/<id>`, `GET /proxy/stats?provider=&model=&hours=`,
  `GET /proxy/config`, `POST /traces/clear`, `GET /metrics` (Prometheus),
  `GET /__token_horizon` (identity for supervisor discovery).

## Tests

```bash
cd gateway && gofmt -l . && go vet ./... && go test ./...
```

`usage_test.go` pins every wire format; `proxy_test.go` round-trips a
split SSE stream through a stub upstream and asserts byte-identical relay,
trace-id correlation, parsed usage, and store bounds.
