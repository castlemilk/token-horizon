package telemetry

// OTLP/HTTP push exporter — TelemetryMetrics.swift port. Same env contract:
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT (full URL) or
// OTEL_EXPORTER_OTLP_ENDPOINT (base; /v1/metrics appended). Off when unset.
// Push cadence 60s, matching the Swift PeriodicMetricReader. JSON encoding
// (OTLP spec allows application/json) — zero protobuf dependency.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Metric is one data point: a cumulative counter (sum) or a gauge.
type Metric struct {
	Name  string
	Value float64
	IsSum bool // true → cumulative monotonic sum; false → gauge
	Attrs map[string]string
	Unit  string // "1", "By", "s" — OTLP unit codes
}

// CollectFunc returns the current metric set (called every push interval).
type CollectFunc func() []Metric

type Exporter struct {
	endpoint string
	collect  CollectFunc
	stop     chan struct{}
	client   *http.Client
}

// EndpointFromEnv resolves the OTLP metrics endpoint per the standard env
// contract; "" means telemetry disabled.
func EndpointFromEnv() string {
	if v := os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"); v != "" {
		return v
	}
	if base := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"); base != "" {
		return strings.TrimSuffix(base, "/") + "/v1/metrics"
	}
	return ""
}

func New(collect CollectFunc) *Exporter {
	ep := EndpointFromEnv()
	if ep == "" {
		return nil
	}
	return &Exporter{endpoint: ep, collect: collect, client: &http.Client{Timeout: 15 * time.Second}}
}

func (e *Exporter) Start() {
	if e == nil {
		return
	}
	e.stop = make(chan struct{})
	go func() {
		e.push() // first sample immediately — dashboards see the daemon at once
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-e.stop:
				return
			case <-t.C:
				e.push()
			}
		}
	}()
}

func (e *Exporter) Stop() {
	if e != nil && e.stop != nil {
		close(e.stop)
	}
}

func (e *Exporter) push() {
	metrics := e.collect()
	if len(metrics) == 0 {
		return
	}
	body := encodeOTLP(metrics)
	req, err := http.NewRequest(http.MethodPost, e.endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.client.Do(req)
	if err != nil {
		return // offline — next tick retries; no queue, counters are cumulative
	}
	resp.Body.Close()
}

// encodeOTLP builds the OTLP/JSON ExportMetricsServiceRequest.
func encodeOTLP(metrics []Metric) []byte {
	now := fmt.Sprintf("%d", time.Now().UnixNano())
	var ms []any
	for _, m := range metrics {
		attrs := []any{}
		for k, v := range m.Attrs {
			attrs = append(attrs, map[string]any{
				"key": k, "value": map[string]any{"stringValue": v},
			})
		}
		pt := map[string]any{
			"timeUnixNano":      now,
			"startTimeUnixNano": now,
			"asDouble":          m.Value,
			"attributes":        attrs,
		}
		var entry map[string]any
		if m.IsSum {
			entry = map[string]any{"name": m.Name, "unit": m.Unit,
				"sum": map[string]any{
					"dataPoints":             []any{pt},
					"aggregationTemporality": 2, // CUMULATIVE
					"isMonotonic":            true,
				}}
		} else {
			entry = map[string]any{"name": m.Name, "unit": m.Unit,
				"gauge": map[string]any{"dataPoints": []any{pt}}}
		}
		ms = append(ms, entry)
	}
	payload := map[string]any{
		"resourceMetrics": []any{map[string]any{
			"resource": map[string]any{"attributes": []any{
				map[string]any{"key": "service.name", "value": map[string]any{"stringValue": "token-horizon-daemon"}},
			}},
			"scopeMetrics": []any{map[string]any{
				"scope":   map[string]any{"name": "token-horizon"},
				"metrics": ms,
			}},
		}},
	}
	data, _ := json.Marshal(payload)
	return data
}
