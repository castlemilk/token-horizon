package main

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// API serves the gateway's read surface on its own loopback port:
// /traces, /traces/<id>, /proxy/stats, /proxy/config, /traces/clear,
// /__token_horizon, /metrics. The Mac app reverse-proxies these under
// :8765 so clients keep one API surface.
type API struct {
	cfg         Config
	store       *Store
	metrics     *Metrics
	port        uint16
	baseURL     string
	buildCommit string
	buildAt     string
}

func (a *API) routes(mux *http.ServeMux) {
	mux.HandleFunc("/traces", a.handleTraces)
	mux.HandleFunc("/traces/", a.handleTraceDetail)
	mux.HandleFunc("/proxy/stats", a.handleStats)
	mux.HandleFunc("/proxy/config", a.handleConfig)
	mux.HandleFunc("/traces/clear", a.handleClear)
	mux.HandleFunc("/__token_horizon", a.handleInfo)
	mux.HandleFunc("/metrics", a.handleMetrics)
	// NOTE: "/" is intentionally not registered here; the catch-all proxy
	// serves the info document for exact "/" (see ProxyHandler).
}

func queryParam(q url.Values, key string) string { return q.Get(key) }

func (a *API) handleTraces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	limit := 25
	if v, err := strconv.Atoi(queryParam(q, "limit")); err == nil {
		limit = v
	}
	provider := Provider(strings.ToLower(queryParam(q, "provider")))
	switch provider {
	case ProviderOpenAI, ProviderAnthropic, ProviderOllama, ProviderUnknown:
	default:
		provider = ""
	}
	model := queryParam(q, "model")
	traces := a.store.Recent(limit, provider, model)
	if traces == nil {
		traces = []Trace{}
	}
	mem, days, bytes := a.store.Counts()
	writeJSON(w, http.StatusOK, map[string]any{
		"count": len(traces), "memory": mem, "dayFiles": days, "bytes": bytes,
		"traces": traces,
	})
}

func (a *API) handleTraceDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/traces/")
	if id == "" || strings.Contains(id, "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trace not found"})
		return
	}
	trace, ok := a.store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trace not found"})
		return
	}
	writeJSON(w, http.StatusOK, trace)
}

func (a *API) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	q := r.URL.Query()
	provider := Provider(strings.ToLower(queryParam(q, "provider")))
	switch provider {
	case ProviderOpenAI, ProviderAnthropic, ProviderOllama, ProviderUnknown:
	default:
		provider = ""
	}
	model := queryParam(q, "model")
	hours := 24
	if v, err := strconv.Atoi(queryParam(q, "hours")); err == nil {
		hours = v
	}
	writeJSON(w, http.StatusOK, a.store.Stats(provider, model, hours))
}

func (a *API) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	mem, days, bytes := a.store.Counts()
	writeJSON(w, http.StatusOK, map[string]any{
		"gateway_port":         a.port,
		"gateway_url":          a.baseURL,
		"openai_upstream":      hostOf(a.cfg.OpenAIBase),
		"anthropic_upstream":   hostOf(a.cfg.AnthropicBase),
		"ollama_upstream":      hostOf(a.cfg.OllamaBase),
		"request_cap_bytes":    MaxRequestBytes,
		"body_cap_bytes":       BodyCapBytes,
		"trace_retention_days": MaxDayFiles,
		"traces_memory":        mem,
		"trace_day_files":      days,
		"trace_bytes":          bytes,
	})
}

func (a *API) handleClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	traces, files := a.store.Clear()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "clearedTraces": traces, "clearedFiles": files})
}

func (a *API) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":      "token-horizon-llm-gateway",
		"providers": []string{"openai", "anthropic", "ollama"},
		"config": map[string]any{
			"gateway_port": a.port,
			"gateway_url":  a.baseURL,
		},
		"build": map[string]any{
			"commit":   a.buildCommit,
			"built_at": a.buildAt,
		},
	})
}

func (a *API) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(a.metrics.Text()))
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Host
}
