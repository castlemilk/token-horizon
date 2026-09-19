package runtime

// Self-managed runtime observability (Providers/Runtimes port):
// LocalInferenceRuntime base (process signatures via ps, Prometheus /metrics
// scraping, counter-delta tok/s), InferenceMonitor (15s poll loop +
// onRuntimeSighting hook — the daemon starts a request meter for EVERY
// detected runtime, deduped by vendor), and RuntimeUsageLedger (durable
// 5-min buckets in runtime-usage.json — measured counter DELTAS only:
// first sighting establishes a baseline, never backfill unmeasured tokens;
// a counter decrease means server restart → delta = current reading).

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/system"
)

// Spec describes one self-managed runtime (subclass fields flattened).
type Spec struct {
	Vendor            string
	DisplayName       string
	DefaultPorts      []int
	ProcessSignatures []string
	PromptCounters    []string
	GenerationCounter []string
	ExtraMetrics      []string
	ModelLabelKeys    []string
	// Ollama probes /api/ps + /api/version instead of Prometheus.
	NativeAPI bool
}

// Specs: one entry per supported runtime (order = poll order).
var Specs = []Spec{
	{Vendor: "vllm", DisplayName: "vLLM", DefaultPorts: []int{8000},
		ProcessSignatures: []string{"vllm"},
		PromptCounters:    []string{"vllm:prompt_tokens_total"},
		GenerationCounter: []string{"vllm:generation_tokens_total"},
		ModelLabelKeys:    []string{"model_name", "model"}},
	{Vendor: "sglang", DisplayName: "SGLang", DefaultPorts: []int{30000, 30001},
		ProcessSignatures: []string{"sglang"},
		PromptCounters:    []string{"sglang:prompt_tokens_total"},
		GenerationCounter: []string{"sglang:generation_tokens_total"},
		ModelLabelKeys:    []string{"model_name", "model"}},
	{Vendor: "llamacpp", DisplayName: "llama.cpp", DefaultPorts: []int{8080},
		ProcessSignatures: []string{"llama-server", "llamacpp", "llama.cpp"},
		PromptCounters:    []string{"llamacpp:prompt_tokens_total"},
		GenerationCounter: []string{"llamacpp:tokens_predicted_total"}},
	{Vendor: "ollama", DisplayName: "Ollama", DefaultPorts: []int{11434},
		ProcessSignatures: []string{"ollama serve", "ollama runner", "ollama "},
		NativeAPI:         true},
	{Vendor: "mlx", DisplayName: "MLX", DefaultPorts: []int{8081},
		ProcessSignatures: []string{"mlx_lm", "mlx.server", "mlx-lm", "--mlx-engine"}},
}

// Snapshot: external view of one runtime (JSON contract of GET /runtimes).
type Snapshot struct {
	Vendor          string             `json:"vendor"`
	DisplayName     string             `json:"displayName"`
	Running         bool               `json:"running"`
	PIDs            []int32            `json:"pids,omitempty"`
	Port            *int               `json:"port,omitempty"`
	GenerationTotal *float64           `json:"generationTokensTotal,omitempty"`
	PromptTotal     *float64           `json:"promptTokensTotal,omitempty"`
	TokPerSec       *float64           `json:"tokPerSec,omitempty"`
	PromptTokPerSec *float64           `json:"promptTokPerSec,omitempty"`
	Extra           map[string]float64 `json:"extra"`
	SampledAt       int64              `json:"sampledAt"`
}

// ---- Prometheus parsing ----

// ParsePrometheus: minimal text parser — sums samples by metric name
// (labels collapsed; cardinality bounded by construction).
func ParsePrometheus(text string) map[string]float64 {
	sums := map[string]float64{}
	for _, line := range strings.Split(text, "\n") {
		if line == "" || line[0] == '#' {
			continue
		}
		var name, valuePart string
		if brace := strings.Index(line, "{"); brace >= 0 {
			name = line[:brace]
			close := strings.Index(line, "}")
			if close < 0 {
				continue
			}
			rest := strings.TrimSpace(line[close+1:])
			valuePart = strings.Fields(rest)[0]
		} else {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			name, valuePart = fields[0], fields[1]
		}
		if v, err := strconv.ParseFloat(valuePart, 64); err == nil {
			sums[name] += v
		}
	}
	return sums
}

type modelCounts struct {
	Prompt     float64 `json:"prompt"`
	Generation float64 `json:"generation"`
}

// ParsePrometheusPerModel: label-aware per-model sums for the token counters.
func ParsePrometheusPerModel(text string, s Spec) map[string]modelCounts {
	if len(s.PromptCounters) == 0 || len(s.ModelLabelKeys) == 0 {
		return nil
	}
	counterNames := map[string]bool{}
	isPrompt := map[string]bool{}
	for _, n := range s.PromptCounters {
		counterNames[n] = true
		isPrompt[n] = true
	}
	for _, n := range s.GenerationCounter {
		counterNames[n] = true
	}
	out := map[string]modelCounts{}
	for _, line := range strings.Split(text, "\n") {
		if line == "" || line[0] == '#' {
			continue
		}
		brace := strings.Index(line, "{")
		if brace < 0 {
			continue
		}
		name := line[:brace]
		if !counterNames[name] {
			continue
		}
		cls := strings.Index(line, "}")
		if cls < 0 {
			continue
		}
		rest := strings.Fields(strings.TrimSpace(line[cls+1:]))
		if len(rest) == 0 {
			continue
		}
		value, err := strconv.ParseFloat(rest[0], 64)
		if err != nil {
			continue
		}
		labels := line[brace+1 : cls]
		model := ""
		for _, key := range s.ModelLabelKeys {
			prefix := key + `="`
			if idx := strings.Index(labels, prefix); idx >= 0 {
				rem := labels[idx+len(prefix):]
				if end := strings.Index(rem, `"`); end >= 0 {
					model = rem[:end]
					break
				}
			}
		}
		if model == "" {
			continue
		}
		c := out[model]
		if isPrompt[name] {
			c.Prompt += value
		} else {
			c.Generation += value
		}
		out[model] = c
	}
	return out
}

// ---- HTTP probes ----

var probeClient = &http.Client{Timeout: 2 * time.Second}

// FetchMetricsText: first candidate /metrics URL answering 2xx with actual
// Prometheus content (a 2xx HTML page on a default port must not read as a
// runtime).
func FetchMetricsText(url string) string {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return ""
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	buf := make([]byte, 1<<20)
	n, _ := resp.Body.Read(buf)
	text := string(buf[:n])
	if !strings.Contains(text, "# HELP") && !strings.Contains(text, "# TYPE") {
		return ""
	}
	return text
}

func httpOK(url string) bool {
	resp, err := probeClient.Get(url)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func fetchJSON(url string) (map[string]any, bool) {
	resp, err := probeClient.Get(url)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	var obj map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&obj); err != nil {
		return nil, false
	}
	return obj, true
}

// Endpoints: user-configured remote endpoints (settings runtimeEndpoints).
func endpointsFor(vendor string) []string {
	home, _ := os.UserHomeDir()
	configDir := os.Getenv("TH_CONFIG_DIR")
	if configDir == "" {
		configDir = filepath.Join(home, ".config/token-horizon")
	}
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		return nil
	}
	var settings struct {
		RuntimeEndpoints map[string][]struct {
			URL string `json:"url"`
		} `json:"runtimeEndpoints"`
	}
	if json.Unmarshal(data, &settings) != nil {
		return nil
	}
	var out []string
	for _, e := range settings.RuntimeEndpoints[vendor] {
		out = append(out, strings.TrimSuffix(e.URL, "/"))
	}
	return out
}

// Probe: HTTP liveness — THE signal (remote runtimes count; ps only
// decorates). Returns (metricsText, extra, ok).
func Probe(s Spec) (string, map[string]float64, bool) {
	if s.NativeAPI { // Ollama: /api/ps gauges + /api/version liveness
		for _, base := range ollamaBases(s) {
			if obj, ok := fetchJSON(base + "/api/ps"); ok {
				extra := map[string]float64{}
				if models, ok := obj["models"].([]any); ok {
					extra["loaded_models"] = float64(len(models))
					for _, m := range models {
						if md, ok := m.(map[string]any); ok {
							extra["loaded_size_bytes"] += number(md["size"])
							extra["loaded_vram_bytes"] += number(md["size_vram"])
						}
					}
				}
				return "", extra, true
			}
			if httpOK(base + "/api/version") {
				return "", map[string]float64{}, true
			}
		}
		return "", nil, false
	}
	for _, url := range metricsURLs(s) {
		if text := FetchMetricsText(url); text != "" {
			return text, map[string]float64{}, true
		}
	}
	return "", nil, false
}

func ollamaBases(s Spec) []string {
	bases := endpointsFor(s.Vendor)
	for _, port := range s.DefaultPorts {
		bases = append(bases, "http://127.0.0.1:"+strconv.Itoa(port))
	}
	return bases
}

func metricsURLs(s Spec) []string {
	var urls []string
	for _, e := range endpointsFor(s.Vendor) {
		urls = append(urls, e+"/metrics")
	}
	for _, port := range s.DefaultPorts {
		urls = append(urls, "http://127.0.0.1:"+strconv.Itoa(port)+"/metrics")
	}
	return urls
}

func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}

// DetectProcesses: local decoration only (pids/cpu/mem via ps).
func DetectProcesses(s Spec) []system.ProcSample {
	var out []system.ProcSample
	for _, p := range psAll() {
		cmd := strings.ToLower(p.Command)
		for _, sig := range s.ProcessSignatures {
			if strings.Contains(cmd, sig) {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

// psAll: full process list for signature matching (HTTP probes stay THE
// liveness signal; ps only decorates local snapshots).
func psAll() []system.ProcSample { return system.AllProcesses() }

// ---- Monitor ----

type counterState struct {
	generation float64
	prompt     float64
	at         time.Time
}

// Monitor polls registered runtimes and derives measured throughput from
// Prometheus counter deltas. Bounded in-memory state; the durable ledger
// receives the deltas.
type Monitor struct {
	Ledger *Ledger
	// OnSighting fires on EVERY poll where a runtime is alive — the daemon
	// hooks it to (idempotently) start request meters.
	OnSighting func(vendor string)

	mu           sync.Mutex
	snapshots    map[string]*Snapshot
	lastCounters map[string]*counterState
	lastModels   map[string]modelCounts
	stop         chan struct{}
}

func NewMonitor(ledger *Ledger) *Monitor {
	return &Monitor{
		Ledger:       ledger,
		snapshots:    map[string]*Snapshot{},
		lastCounters: map[string]*counterState{},
		lastModels:   map[string]modelCounts{},
		stop:         make(chan struct{}),
	}
}

// Current: latest snapshot per vendor, sorted.
func (m *Monitor) Current() []Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Snapshot, 0, len(m.snapshots))
	for _, s := range m.snapshots {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Vendor < out[j].Vendor })
	return out
}

func (m *Monitor) Start(interval time.Duration) {
	go func() {
		m.Poll()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-m.stop:
				return
			case <-ticker.C:
				m.Poll()
			}
		}
	}()
}

func (m *Monitor) Stop() { close(m.stop) }

// Poll: one pass over all specs (blocks briefly on HTTP probes — off-main).
func (m *Monitor) Poll() []Snapshot {
	var results []Snapshot
	for _, spec := range Specs {
		results = append(results, m.pollOne(spec, time.Now()))
	}
	return results
}

func (m *Monitor) pollOne(s Spec, now time.Time) Snapshot {
	processes := DetectProcesses(s)
	text, extra, alive := Probe(s)
	return m.pollOneCore(s, processes, text, extra, alive, now)
}

// pollOneText: poll-one against provided metrics text (tests bypass HTTP).
func (m *Monitor) pollOneText(s Spec, text string, now time.Time) Snapshot {
	return m.pollOneCore(s, nil, text, map[string]float64{}, true, now)
}

func (m *Monitor) pollOneCore(s Spec, processes []system.ProcSample, text string, extra map[string]float64, alive bool, now time.Time) Snapshot {
	snap := Snapshot{Vendor: s.Vendor, DisplayName: s.DisplayName, Extra: map[string]float64{}, SampledAt: now.Unix()}

	if !alive && len(processes) == 0 {
		m.mu.Lock()
		delete(m.lastCounters, s.Vendor)
		for key := range m.lastModels {
			if strings.HasPrefix(key, s.Vendor+"|") {
				delete(m.lastModels, key)
			}
		}
		snap.Running = false
		m.snapshots[s.Vendor] = &snap
		m.mu.Unlock()
		return snap
	}

	if m.OnSighting != nil {
		m.OnSighting(s.Vendor)
	}

	snap.Running = true
	for _, p := range processes {
		snap.PIDs = append(snap.PIDs, p.PID)
	}
	for k, v := range extra {
		snap.Extra[k] = v
	}
	if len(processes) > 0 {
		for _, p := range processes {
			snap.Extra["proc_cpu_percent"] += p.CPU
			snap.Extra["proc_mem_mb"] += p.MemMB
		}
	}
	// Token counters exist only for Prometheus runtimes; Ollama & co. get
	// usage truth from their request meter instead.
	if text == "" {
		m.mu.Lock()
		m.snapshots[s.Vendor] = &snap
		m.mu.Unlock()
		return snap
	}
	values := ParsePrometheus(text)
	promptTotal := 0.0
	for _, n := range s.PromptCounters {
		promptTotal += values[n]
	}
	genTotal := 0.0
	for _, n := range s.GenerationCounter {
		genTotal += values[n]
	}
	perModel := ParsePrometheusPerModel(text, s)
	snap.GenerationTotal = &genTotal
	snap.PromptTotal = &promptTotal
	for _, n := range s.ExtraMetrics {
		if v, ok := values[n]; ok {
			snap.Extra[n] = v
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	prev := m.lastCounters[s.Vendor]
	if prev != nil {
		dt := now.Sub(prev.at).Seconds()
		if dt > 0 {
			if d := genTotal - prev.generation; d >= 0 {
				v := d / dt
				snap.TokPerSec = &v
			}
			if d := promptTotal - prev.prompt; d >= 0 {
				v := d / dt
				snap.PromptTokPerSec = &v
			}
		}
	}
	m.lastCounters[s.Vendor] = &counterState{genTotal, promptTotal, now}

	// Durable ledger: measured deltas only (first sighting = baseline 0;
	// counter decrease = server restart → delta = current reading).
	measuredDelta := func(cur float64, prev float64, has bool) int {
		if !has {
			return 0
		}
		d := cur - prev
		if d >= 0 {
			return int(math.Round(d))
		}
		return int(math.Round(cur))
	}
	if m.Ledger != nil {
		inDelta := measuredDelta(promptTotal, 0, false)
		outDelta := measuredDelta(genTotal, 0, false)
		if prev != nil {
			inDelta = measuredDelta(promptTotal, prev.prompt, true)
			outDelta = measuredDelta(genTotal, prev.generation, true)
		}
		if inDelta > 0 || outDelta > 0 {
			m.Ledger.Record(s.Vendor, "", inDelta, outDelta, now)
		}
		for model, counts := range perModel {
			key := s.Vendor + "|" + model
			prevM, hasM := m.lastModels[key]
			mIn := measuredDelta(counts.Prompt, prevM.Prompt, hasM)
			mOut := measuredDelta(counts.Generation, prevM.Generation, hasM)
			if mIn > 0 || mOut > 0 {
				m.Ledger.Record(s.Vendor, model, mIn, mOut, now)
			}
			m.lastModels[key] = counts
		}
		for key := range m.lastModels {
			if strings.HasPrefix(key, s.Vendor+"|") {
				if _, ok := perModel[key[len(s.Vendor)+1:]]; !ok {
					delete(m.lastModels, key)
				}
			}
		}
	}
	m.snapshots[s.Vendor] = &snap
	return snap
}
