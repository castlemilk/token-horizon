package catalog

// Fidelity tests for the catalog pricing subset: lookup normalization
// (Swift ModelCatalog.lookup chain), flagship contains-rules, price math
// (CostEngine.price parity), and the models-cache.json round-trip.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func resetCatalog() {
	mu.Lock()
	byID = nil
	lastFetch = lastFetch.Truncate(0)
	mu.Unlock()
}

func seed(entries map[string]Entry) {
	mu.Lock()
	byID = entries
	lastFetch = lastFetch.Add(1) // non-zero → not stale
	mu.Unlock()
}

func TestLookupNormalizationChain(t *testing.T) {
	resetCatalog()
	seed(map[string]Entry{
		"openai/gpt-5-sol":       {ID: "gpt-5-sol", InputPerM: 2.5},
		"deepseek/deepseek-chat": {ID: "deepseek-chat", InputPerM: 0.27},
	})
	// Exact.
	if e := Lookup("openai/gpt-5-sol"); e == nil || e.ID != "gpt-5-sol" {
		t.Fatalf("exact: %v", e)
	}
	// Case + underscore fold + provider-suffix match.
	if e := Lookup("DeepSeek_Chat"); e == nil || e.ID != "deepseek-chat" {
		t.Fatalf("underscore+suffix: %v", e)
	}
	// Colon prefix (ollama-style tags).
	if e := Lookup("deepseek-chat:latest"); e == nil || e.ID != "deepseek-chat" {
		t.Fatalf("colon prefix: %v", e)
	}
}

func TestFlagshipContainsRules(t *testing.T) {
	resetCatalog()
	seed(map[string]Entry{}) // empty catalog → flagship rules only
	cases := map[string]struct {
		provider string
		input    float64
	}{
		"gpt-5-sol":        {"openai", 2.50},
		"openai/gpt-terra": {"openai", 1.20},
		"gpt-5.6-luna":     {"openai", 0.10},
		"deepseek-v4-pro":  {"deepseek", 0.14},
		"gemini-3.7-flash": {"google", 0.15},
		"gemini-2.5-pro":   {"google", 1.25},
		"glm-5.3-flash":    {"glm", 0.01},
		"glm-5.3":          {"glm", 0.70},
	}
	for query, want := range cases {
		e := Lookup(query)
		if e == nil {
			t.Errorf("%s: no entry", query)
			continue
		}
		if e.Provider != want.provider || e.InputPerM != want.input {
			t.Errorf("%s: got %s @ %v, want %s @ %v", query, e.Provider, e.InputPerM, want.provider, want.input)
		}
	}
	if e := Lookup("totally-unknown-model"); e != nil {
		t.Errorf("unknown model must not match: %+v", e)
	}
}

func TestPriceMath_CostEngineParity(t *testing.T) {
	cr := 0.038
	e := Entry{InputPerM: 0.15, OutputPerM: 0.60, CacheReadPerM: &cr}
	// cache-write priced as INPUT; reasoning priced as OUTPUT.
	got := e.Price(1000, 500, 200, 400, 300)
	want := (float64(1000+300)*0.15 + float64(500+200)*0.60 + 400*0.038) / 1_000_000
	if got != want {
		t.Fatalf("price %v, want %v", got, want)
	}
	// Nil cache rate → no cache contribution (1M input @ 0.15 = $0.15).
	e.CacheReadPerM = nil
	if got := e.Price(1_000_000, 0, 0, 1_000_000, 0); got != 0.15 {
		t.Fatalf("nil cache rate: %v", got)
	}
}

func TestModelsCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	entries := map[string]Entry{
		"openai/gpt-5-sol": {ID: "gpt-5-sol", Name: "GPT-5 Sol", Provider: "openai",
			ProviderName: "OpenAI", InputPerM: 2.5, OutputPerM: 10, ContextK: 256},
	}
	data, _ := json.Marshal(entries)
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "models-cache.json"), data, 0o600)

	RemoteURL = "http://127.0.0.1:1/unreachable" // force cache path
	resetCatalog()
	load()
	mu.Lock()
	got := byID["openai/gpt-5-sol"]
	mu.Unlock()
	if got.ID != "gpt-5-sol" || got.InputPerM != 2.5 {
		t.Fatalf("cache load: %+v", got)
	}
	// Flagship injection happens on top of cache.
	mu.Lock()
	_, hasTerra := byID["openai/gpt-5-terra"]
	mu.Unlock()
	if !hasTerra {
		t.Fatal("flagships must be injected over cache entries")
	}
}
