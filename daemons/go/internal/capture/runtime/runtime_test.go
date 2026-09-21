package runtime

// Fidelity tests for runtime observability: Prometheus parsing (sums +
// per-model labels), counter-delta semantics (baseline/restart/parity),
// ledger persistence format parity, and monitor poll behavior.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const vllmMetrics = `# HELP vllm:prompt_tokens_total Number of prefill tokens processed.
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{model_name="qwen3-32b"} 1000
vllm:prompt_tokens_total{model_name="llama-3-8b"} 500
# HELP vllm:generation_tokens_total Number of generation tokens processed.
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{model_name="qwen3-32b"} 100
vllm:generation_tokens_total{model_name="llama-3-8b"} 50
vllm:gpu_cache_usage_perc 0.42
`

func TestParsePrometheus_SumsLabelsCollapsed(t *testing.T) {
	sums := ParsePrometheus(vllmMetrics)
	if sums["vllm:prompt_tokens_total"] != 1500 {
		t.Fatalf("prompt sum: %v", sums["vllm:prompt_tokens_total"])
	}
	if sums["vllm:generation_tokens_total"] != 150 {
		t.Fatalf("generation sum: %v", sums["vllm:generation_tokens_total"])
	}
	if sums["vllm:gpu_cache_usage_perc"] != 0.42 {
		t.Fatalf("gauge: %v", sums["vllm:gpu_cache_usage_perc"])
	}
}

func TestParsePrometheusPerModel(t *testing.T) {
	spec := Specs[0] // vllm
	per := ParsePrometheusPerModel(vllmMetrics, spec)
	if per["qwen3-32b"].Prompt != 1000 || per["qwen3-32b"].Generation != 100 {
		t.Fatalf("qwen: %+v", per["qwen3-32b"])
	}
	if per["llama-3-8b"].Prompt != 500 {
		t.Fatalf("llama: %+v", per["llama-3-8b"])
	}
}

func TestFetchMetricsText_ContentCheck(t *testing.T) {
	// A 2xx HTML page must NOT read as Prometheus.
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>not prometheus</html>"))
	}))
	defer html.Close()
	if got := FetchMetricsText(html.URL); got != "" {
		t.Fatalf("html page accepted as prometheus")
	}
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("# TYPE x counter\nx 1\n"))
	}))
	defer prom.Close()
	if got := FetchMetricsText(prom.URL); got == "" {
		t.Fatal("real prometheus text rejected")
	}
}

func TestLedger_DeltasAndParity(t *testing.T) {
	dir := t.TempDir()
	l := NewLedger(filepath.Join(dir, "runtime-usage.json"))
	now := time.Now()
	l.Record("vllm", "", 100, 10, now)
	l.Record("vllm", "qwen3-32b", 100, 10, now) // per-model scope only
	l.Flush()

	// Aggregate scope unaffected by per-model writes.
	all, _ := l.Totals("vllm")
	if all != 110 {
		t.Fatalf("aggregate total %d, want 110", all)
	}
	contrib := l.Contributions()
	if len(contrib) != 1 || (func() int { e := contrib["vllm"][int(BucketStart(now.Unix()))]; return int(e.Total()) }()) != 110 {
		t.Fatalf("contributions: %+v", contrib)
	}

	// Disk format parity: decimal-string bucket keys.
	data, _ := os.ReadFile(filepath.Join(dir, "runtime-usage.json"))
	var disk struct {
		Scopes map[string]map[string]Entry `json:"scopes"`
	}
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	if _, ok := disk.Scopes["vllm"][strconv.Itoa(int(BucketStart(now.Unix())))]; !ok {
		t.Fatalf("bucket key format: %v", disk.Scopes["vllm"])
	}
	if disk.Scopes["vllm|qwen3-32b"] == nil {
		t.Fatal("per-model scope persisted")
	}

	// Reload: same numbers.
	l2 := NewLedger(filepath.Join(dir, "runtime-usage.json"))
	if all, _ := l2.Totals("vllm"); all != 110 {
		t.Fatalf("reload total %d", all)
	}
}

func TestMonitor_CounterDeltaSemantics(t *testing.T) {
	dir := t.TempDir()
	ledger := NewLedger(filepath.Join(dir, "ledger.json"))
	m := NewMonitor(ledger)

	readings := []string{
		"# TYPE vllm:prompt_tokens_total counter\nvllm:prompt_tokens_total 1000\n# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total 100\n",
		"# TYPE vllm:prompt_tokens_total counter\nvllm:prompt_tokens_total 1500\n# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total 160\n",
		"# TYPE vllm:prompt_tokens_total counter\nvllm:prompt_tokens_total 200\n# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total 20\n", // server restart
	}
	idx := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(readings[min(idx, len(readings)-1)]))
	}))
	defer srv.Close()

	spec := Spec{
		Vendor: "vllm", DisplayName: "vLLM",
		PromptCounters:    []string{"vllm:prompt_tokens_total"},
		GenerationCounter: []string{"vllm:generation_tokens_total"},
	}
	// Redirect the probe to the test server via endpoints config: point
	// metricsURLs at the server by monkeying the spec — probe() uses
	// endpointsFor() from settings; instead test pollOne against a custom
	// fetch by injecting the URL through TH settings is heavy. Directly
	// exercise the delta logic via the ledger semantics:
	t0 := time.Now()
	// Poll 1: baseline → no ledger write.
	snap1 := m.pollOneWithProbe(spec, readings[0], t0)
	if snap1.Running != true || snap1.TokPerSec != nil {
		t.Fatalf("baseline poll: %+v", snap1)
	}
	// Poll 2: delta 500 in / 60 out over 15s → 4 tok/s.
	snap2 := m.pollOneWithProbe(spec, readings[1], t0.Add(15*time.Second))
	if snap2.TokPerSec == nil || *snap2.TokPerSec != 4.0 {
		t.Fatalf("tok/s: %v", snap2.TokPerSec)
	}
	if all, _ := ledger.Totals("vllm"); all != 560 {
		t.Fatalf("ledger after delta: %d, want 560", all)
	}
	// Poll 3: restart (counters dropped) → delta = current reading.
	m.pollOneWithProbe(spec, readings[2], t0.Add(30*time.Second))
	if all, _ := ledger.Totals("vllm"); all != 560+220 {
		t.Fatalf("ledger after restart: %d, want 780", all)
	}
	_ = idx
	_ = srv
}

// pollOneWithProbe: pollOne against provided metrics text (bypasses HTTP).
func (m *Monitor) pollOneWithProbe(s Spec, text string, now time.Time) Snapshot {
	return m.pollOneText(s, text, now)
}
