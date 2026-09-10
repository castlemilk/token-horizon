---
name: telemetry-observability
description: Maintain Token Horizon's bundled Ollama/MLX telemetry, OpenTelemetry metrics, Prometheus endpoint, and bounded UI rollups.
---

# Telemetry Observability

## Scope

Use this skill when changing:

- `Metering/OllamaMeter.swift` (consented loopback meter; supersedes the removed OllamaTelemetryProxy)
- `TelemetryMetrics.swift`
- `MLXHistory.swift` or the MLX tab in `Views.swift`
- `LocalServer.swift` `/metrics`
- telemetry documentation or operational checks

## Contracts

- The proxy binds only to `127.0.0.1`, forwards request and response bytes unchanged, and parses completed Ollama metadata (`eval_count`, `eval_duration`, `prompt_eval_count`, `prompt_eval_duration`).
- `OllamaTelemetryStore` aggregates prompt & eval token counts and message totals with bounded 90-day hourly history persisted to `~/.config/token-horizon/localllm-usage.json`.
- `UsageEngine` includes local LLM token usage under `tool: "ollama"`, contributing to total tokens today/all-time, trend charts, and MCP `token_horizon_usage`.
- Exact tok/s comes from Ollama `eval_count` / `eval_duration` or another measured source. Never estimate it from CPU, memory, disk, or network activity.
- Prometheus is served through the existing `LocalServer` on `127.0.0.1:8765/metrics`. Do not create another HTTP listener for the exporter.
- OTLP/HTTP is disabled unless `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Metric attributes must remain low-cardinality. Model labels are normalized, capped at 32 values, and overflow to `model="other"`.
- MLX histories are memory-only. Fine samples are capped at 1,800; 30-second averages are capped at 2,880.

## Verification

Run the focused tests first:

```bash
swift test --filter MLXObserverTests
```

Then run the complete suite and release checks:

```bash
swift test
./scripts/make-app.sh
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/metrics
```

For OTLP testing, set an HTTP collector endpoint before launching the app and confirm the collector receives metrics after the 60-second export interval. Do not make OTLP required for local startup.
