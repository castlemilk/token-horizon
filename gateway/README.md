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
| `TOKEN_HORIZON_KIMI_UPSTREAM` | `https://api.kimi.com/coding` | Moonshot Kimi (OpenAI + Anthropic shapes) |
| `TOKEN_HORIZON_GLM_UPSTREAM` | `https://api.z.ai` | Zhipu GLM (`/api/anthropic/v1/messages`, OpenAI shape) |
| `TOKEN_HORIZON_MINIMAX_UPSTREAM` | `https://api.minimax.io` | MiniMax (Anthropic shape) |
| `TOKEN_HORIZON_DEEPSEEK_UPSTREAM` | `https://api.deepseek.com` | DeepSeek (OpenAI shape) |
| `TOKEN_HORIZON_QWEN_UPSTREAM` | `https://dashscope.aliyuncs.com` | Alibaba Qwen / DashScope (OpenAI shape) |
| `TOKEN_HORIZON_GROK_UPSTREAM` | `https://api.x.ai` | xAI Grok (OpenAI + Responses shapes) |
| `TOKEN_HORIZON_GEMINI_UPSTREAM` | `https://generativelanguage.googleapis.com` | Google Gemini (native + OpenAI shapes) |
| `TOKEN_HORIZON_OPENCODE_UPSTREAM` | `https://opencode.ai/zen` | OpenCode Zen (OpenAI + Anthropic shapes) |
| `TOKEN_HORIZON_TRACE_DIR` | `~/.config/token-horizon/traces` | JSONL day-file directory |
| `TOKEN_HORIZON_INGEST_URL` | `http://127.0.0.1:8765/ingest/ollama` | Best-effort Ollama sample POST to the app (empty disables) |
| `TOKEN_HORIZON_GATEWAY_BIN` | — | App-side only: sidecar binary override |

## Providers

| Provider | Force prefix | Endpoint families parsed |
|---|---|---|
| openai | `/th-openai/` | chat completions, responses, embeddings, completions |
| anthropic | `/th-anthropic/` | `/v1/messages` |
| ollama | (path inference) | `/api/generate`, `/api/chat`, `/api/tags`, Ollama `/v1/*` |
| kimi | `/th-kimi/` | chat completions, messages, responses |
| glm | `/th-glm/` | messages (`/api/anthropic/v1/messages`), chat completions |
| minimax | `/th-minimax/` | messages, chat completions |
| deepseek | `/th-deepseek/` | chat completions |
| qwen | `/th-qwen/` | chat completions (`/compatible-mode/v1/…`) |
| grok | `/th-grok/` | chat completions, responses |
| gemini | `/th-gemini/` | `:generateContent`/`:streamGenerateContent`, chat completions |
| opencode | `/th-opencode/` | messages, chat completions |
| splash | `/th-splash/` | chat completions, responses, messages (local engine on :8000) |

Unprefixed `/v1/*` requests resolve by path first, then by unambiguous
model name in the body (`kimi-*`, `glm-*`, `minimax-*`, `deepseek-*`,
`qwen-*`, `grok-*`, `gemini-*` → their provider; `claude-*` → anthropic;
`gpt-*`/`o1`… → openai; `*-splash`/`incoai/*` → splash local engine).
Any path may carry a `/th-<provider>/` prefix;
the remainder is still classified by wire shape, so e.g.
`/th-glm/api/anthropic/v1/messages` parses Anthropic-protocol usage.

## Behavior contract

- **Routing** (per request): `/th-<provider>/` prefix → path → auth
  headers → model name → body shape (`infer.go`). Unknown paths get 400
  (no trace recorded).
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
- **Attribution**: each trace carries `client` (harness classified from
  User-Agent/originator headers — claude-code, codex, kimi-cli,
  opencode, gemini-cli, aider, cursor, …), `sessionKey` (`session_id` /
  `x-session-id` / `x-conversation-id` headers, else body-derived keys),
  `providerRequestId` (upstream `x-request-id`/`request-id`/`x-trace-id`),
  and `source` (`proxy`).
- **Read API** (same port, loopback): `GET /traces?provider=&model=&client=&session=&errors=&limit=`
  (bodies omitted), `GET /traces/<id>` (full bodies),
  `GET /traces/sessions?hours=&limit=` (session spans: first/last ts,
  span, providers, models, clients, tokens, tool calls, errors),
  `GET /proxy/stats?provider=&model=&hours=` (totals, byProvider/
  byModel/byClient/byError cuts, duration + TTFT p50/p95),
  `GET /proxy/config`, `POST /traces/clear`, `GET /metrics` (Prometheus),
  `GET /__token_horizon` (identity for supervisor discovery).

## Tests

```bash
cd gateway && gofmt -l . && go vet ./... && go test ./...
```

`usage_test.go` pins every wire format; `proxy_test.go` round-trips a
split SSE stream through a stub upstream and asserts byte-identical relay,
trace-id correlation, parsed usage, and store bounds.
