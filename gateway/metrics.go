package main

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Metrics are hand-rolled Prometheus counters/histograms (stdlib only).
// Label policy mirrors the app: provider/endpoint/status are fixed
// vocabularies; model labels are capped with overflow to "other".
type Metrics struct {
	mu          sync.Mutex
	modelLabels map[string]struct{}
	requests    map[metricKey]int64
	completed   map[metricKeyStatus]int64
	outTokens   map[metricKey]int64
	ttft        map[metricKey][]float64
	duration    map[metricKey][]float64
}

type metricKey struct {
	provider string
	endpoint string
	model    string
}

type metricKeyStatus struct {
	metricKey
	status string
}

const maxModelLabels = 32

var ttftBuckets = []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 60}
var durationBuckets = []float64{0.1, 0.5, 1, 2, 5, 15, 60, 300, 900}

func NewMetrics() *Metrics {
	return &Metrics{
		modelLabels: map[string]struct{}{},
		requests:    map[metricKey]int64{},
		completed:   map[metricKeyStatus]int64{},
		outTokens:   map[metricKey]int64{},
		ttft:        map[metricKey][]float64{},
		duration:    map[metricKey][]float64{},
	}
}

func (m *Metrics) label(model string) string {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if normalized == "" {
		normalized = "unknown"
	}
	if len(normalized) > 96 {
		normalized = normalized[:96]
	}
	if _, ok := m.modelLabels[normalized]; ok || len(m.modelLabels) < maxModelLabels {
		m.modelLabels[normalized] = struct{}{}
		return normalized
	}
	return "other"
}

func statusClass(status int) string {
	switch {
	case status >= 100 && status < 300:
		return "2xx"
	case status >= 300 && status < 400:
		return "3xx"
	case status >= 400 && status < 500:
		return "4xx"
	case status >= 500 && status < 600:
		return "5xx"
	default:
		return "error"
	}
}

// Request records a gateway request start.
func (m *Metrics) Request(provider Provider, endpoint Endpoint, model string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := metricKey{string(provider), string(endpoint), m.label(model)}
	m.requests[k]++
}

// Complete records a gateway completion.
func (m *Metrics) Complete(provider Provider, endpoint Endpoint, model string, status int, ttftSecs, durationSecs float64, outputTokens int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := metricKey{string(provider), string(endpoint), m.label(model)}
	m.completed[metricKeyStatus{k, statusClass(status)}]++
	if outputTokens > 0 {
		m.outTokens[k] += int64(outputTokens)
	}
	if ttftSecs > 0 {
		m.ttft[k] = append(m.ttft[k], ttftSecs)
	}
	m.duration[k] = append(m.duration[k], durationSecs)
}

func labelsString(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%q", k, labels[k]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// Text renders Prometheus exposition format.
func (m *Metrics) Text() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	counter := func(name, help string, vals map[metricKey]int64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
		keys := make([]metricKey, 0, len(vals))
		for k := range vals {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].provider != keys[j].provider {
				return keys[i].provider < keys[j].provider
			}
			if keys[i].endpoint != keys[j].endpoint {
				return keys[i].endpoint < keys[j].endpoint
			}
			return keys[i].model < keys[j].model
		})
		for _, k := range keys {
			labels := map[string]string{"provider": k.provider, "endpoint": k.endpoint, "model": k.model}
			fmt.Fprintf(&b, "%s%s %d\n", name, labelsString(labels), vals[k])
		}
	}
	histogram := func(name, help string, vals map[metricKey][]float64, buckets []float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s histogram\n", name, help, name)
		keys := make([]metricKey, 0, len(vals))
		for k := range vals {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].provider != keys[j].provider {
				return keys[i].provider < keys[j].provider
			}
			if keys[i].endpoint != keys[j].endpoint {
				return keys[i].endpoint < keys[j].endpoint
			}
			return keys[i].model < keys[j].model
		})
		for _, k := range keys {
			labels := map[string]string{"provider": k.provider, "endpoint": k.endpoint}
			sorted := append([]float64(nil), vals[k]...)
			sort.Float64s(sorted)
			count := 0
			sum := 0.0
			for _, v := range sorted {
				sum += v
			}
			for _, bound := range buckets {
				for count < len(sorted) && sorted[count] <= bound {
					count++
				}
				bl := map[string]string{"provider": k.provider, "endpoint": k.endpoint, "le": fmt.Sprintf("%g", bound)}
				fmt.Fprintf(&b, "%s_bucket%s %d\n", name, labelsString(bl), count)
			}
			bl := map[string]string{"provider": k.provider, "endpoint": k.endpoint, "le": "+Inf"}
			fmt.Fprintf(&b, "%s_bucket%s %d\n", name, labelsString(bl), len(sorted))
			fmt.Fprintf(&b, "%s_sum%s %g\n", name, labelsString(labels), sum)
			fmt.Fprintf(&b, "%s_count%s %d\n", name, labelsString(labels), len(sorted))
		}
	}
	counter("token_horizon_gateway_requests_total", "Gateway requests started.", m.requests)
	{
		name := "token_horizon_gateway_completed_total"
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, "Gateway requests completed by status class.", name)
		keys := make([]metricKeyStatus, 0, len(m.completed))
		for k := range m.completed {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].provider != keys[j].provider {
				return keys[i].provider < keys[j].provider
			}
			if keys[i].endpoint != keys[j].endpoint {
				return keys[i].endpoint < keys[j].endpoint
			}
			if keys[i].model != keys[j].model {
				return keys[i].model < keys[j].model
			}
			return keys[i].status < keys[j].status
		})
		for _, k := range keys {
			labels := map[string]string{"provider": k.provider, "endpoint": k.endpoint, "model": k.model, "status": k.status}
			fmt.Fprintf(&b, "%s%s %d\n", name, labelsString(labels), m.completed[k])
		}
	}
	counter("token_horizon_gateway_output_tokens_total", "Provider-reported output tokens through the gateway.", m.outTokens)
	histogram("token_horizon_gateway_ttft_seconds", "Time to first response byte.", m.ttft, ttftBuckets)
	histogram("token_horizon_gateway_duration_seconds", "Total upstream duration.", m.duration, durationBuckets)
	return b.String()
}
