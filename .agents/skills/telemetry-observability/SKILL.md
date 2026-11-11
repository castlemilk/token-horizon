---
name: telemetry-observability
description: Maintain Token Horizon's bundled Ollama/MLX telemetry, OpenTelemetry metrics, Prometheus endpoint, and bounded UI rollups.
---

# Telemetry Observability

## Scope

Use this skill when changing:

- `OllamaTelemetryProxy.swift`
- `TelemetryMetrics.swift`
- `MLXHistory.swift` or the MLX tab (`mlxTab` in `DashboardTabs.swift`)
- `LocalServer.swift` `/metrics`
- telemetry documentation or operational checks

## Contracts

- The proxy binds only to `127.0.0.1` on port 11435 by default (`TOKEN_HORIZON_OLLAMA_PROXY_PORT` overrides it; if the port is taken, it tries the next ports, up to 20 attempts) and forwards to upstream `127.0.0.1:11434` (`TOKEN_HORIZON_OLLAMA_UPSTREAM` overrides it). It forwards response bytes unchanged. Request bytes are unchanged except that any `Connection` or `Proxy-Connection` header is removed and `Connection: close` is always appended. It parses completed Ollama metadata (`eval_count`, `eval_duration`, `prompt_eval_count`, `prompt_eval_duration`) and OpenAI-compatible `usage` objects.
- `OllamaTelemetryStore` aggregates prompt & eval token counts and message totals with bounded 90-day hourly history persisted to `~/.config/token-horizon/localllm-usage.json`.
- `UsageEngine` includes local LLM token usage under `tool: "ollama"`, contributing to total tokens today/all-time, trend charts, and MCP `token_horizon_usage`.
- Exact tok/s comes from Ollama `eval_count` / `eval_duration` or another measured source. Never estimate it from CPU, memory, disk, or network activity.
- Prometheus is served through the existing `LocalServer` on `127.0.0.1:8889/metrics`. Do not create another HTTP listener for the exporter.
- OTLP/HTTP is disabled unless `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Metric attributes must remain low-cardinality. Model labels are normalized, capped at 32 values, and overflow to `model="other"`.
- MLX histories are memory-only. Fine samples are capped at 1,800; 30-second averages are capped at 2,880.

## Verification

Run the Swift commands from `clients/macos`, where `Package.swift` lives. Run the focused tests first:

```bash
swift test --filter MLXObserverTests
```

Then run the complete suite, and run the release checks from the repository root:

```bash
swift test
./scripts/make-app.sh
curl -s http://127.0.0.1:8889/health
curl -s http://127.0.0.1:8889/metrics
```

For OTLP testing, set an HTTP collector endpoint before launching the app and confirm the collector receives metrics after the 60-second export interval. Do not make OTLP required for local startup.
