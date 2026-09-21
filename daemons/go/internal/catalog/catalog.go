package catalog

// ModelCatalog pricing subset (Catalog/ModelCatalog.swift port — the parts
// the daemon needs: identity + pricing for CostEngine.decide; benchmarks /
// benchmark-name display / the Models-tab pipeline stay in the macOS app).
//
// Source chain (identical to Swift): models.dev/api.json → models-cache.json
// (SHARED with the Swift daemon — same file, same format) → hardcoded
// flagship injection. Lookup normalization: lowercase/trim, underscores →
// hyphens, colon-prefix, "<provider>/<model>" suffix match, then the
// flagship contains-rules.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Entry: one catalog model (pricing-relevant subset of the Swift Entry).
type Entry struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Provider      string   `json:"provider"`
	ProviderName  string   `json:"providerName"`
	InputPerM     float64  `json:"inputPerM"`
	OutputPerM    float64  `json:"outputPerM"`
	CacheReadPerM *float64 `json:"cacheReadPerM,omitempty"`
	ContextK      int      `json:"contextK"`
}

var (
	mu        sync.Mutex
	byID      map[string]Entry
	lastFetch time.Time
)

// Price: USD for a token breakdown at this entry's rates — cache-write
// priced as input; reasoning priced as output (CostEngine.price parity).
func (e Entry) Price(input, output, reasoning, cacheRead, cacheWrite int64) float64 {
	usd := (float64(input+cacheWrite)*e.InputPerM + float64(output+reasoning)*e.OutputPerM) / 1_000_000
	if e.CacheReadPerM != nil {
		usd += float64(cacheRead) * *e.CacheReadPerM / 1_000_000
	}
	return usd
}

// Lookup: normalization chain identical to Swift ModelCatalog.lookup.
func Lookup(id string) *Entry {
	EnsureLoaded()
	mu.Lock()
	defer mu.Unlock()
	clean := strings.ToLower(strings.TrimSpace(id))
	if e, ok := byID[clean]; ok {
		return &e
	}
	hyphens := strings.ReplaceAll(clean, "_", "-")
	if e, ok := byID[hyphens]; ok {
		return &e
	}
	colons := strings.SplitN(clean, ":", 2)[0]
	if e, ok := byID[colons]; ok {
		return &e
	}
	for k, v := range byID {
		if strings.HasSuffix(k, "/"+clean) || strings.HasSuffix(k, "/"+hyphens) || strings.HasSuffix(k, "/"+colons) {
			entry := v
			return &entry
		}
	}
	if e := flagshipContains(clean); e != nil {
		return e
	}
	return nil
}

// flagshipContains: the hardcoded flagship contains-rules (Swift lookup
// fallbacks for models absent from models.dev).
func flagshipContains(clean string) *Entry {
	switch {
	case strings.Contains(clean, "sol") || strings.Contains(clean, "gpt-5-sol") ||
		strings.Contains(clean, "gpt-sol") || strings.Contains(clean, "gpt-5.6-sol"):
		cr := 0.50
		return &Entry{ID: "gpt-5-sol", Name: "GPT-5 Sol", Provider: "openai", ProviderName: "OpenAI",
			InputPerM: 2.50, OutputPerM: 10.00, CacheReadPerM: &cr, ContextK: 256}
	case strings.Contains(clean, "terra") || strings.Contains(clean, "gpt-5-terra") ||
		strings.Contains(clean, "gpt-terra") || strings.Contains(clean, "gpt-5.6-terra"):
		cr := 0.15
		return &Entry{ID: "gpt-5-terra", Name: "GPT-5 Terra", Provider: "openai", ProviderName: "OpenAI",
			InputPerM: 1.20, OutputPerM: 4.80, CacheReadPerM: &cr, ContextK: 256}
	case strings.Contains(clean, "luna") || strings.Contains(clean, "gpt-5-luna") ||
		strings.Contains(clean, "gpt-luna") || strings.Contains(clean, "gpt-5.6-luna"):
		cr := 0.025
		return &Entry{ID: "gpt-5-luna", Name: "GPT-5 Luna", Provider: "openai", ProviderName: "OpenAI",
			InputPerM: 0.10, OutputPerM: 0.40, CacheReadPerM: &cr, ContextK: 128}
	case strings.Contains(clean, "deepseek-v4-pro"):
		cr := 0.014
		return &Entry{ID: "deepseek-v4-pro", Name: "DeepSeek V4 Pro", Provider: "deepseek", ProviderName: "DeepSeek",
			InputPerM: 0.14, OutputPerM: 0.28, CacheReadPerM: &cr, ContextK: 128}
	case strings.Contains(clean, "gemini-3.7-flash") || strings.Contains(clean, "gemini-3.5-flash"):
		cr := 0.038
		return &Entry{ID: "gemini-3.5-flash", Name: "Gemini 3.5 Flash", Provider: "google", ProviderName: "Google",
			InputPerM: 0.15, OutputPerM: 0.60, CacheReadPerM: &cr, ContextK: 1000}
	case strings.Contains(clean, "gemini-2.5-pro") || strings.Contains(clean, "gemini-3.1-pro") ||
		strings.Contains(clean, "gemini-3-pro"):
		cr := 0.31
		return &Entry{ID: "gemini-2.5-pro", Name: "Gemini 2.5 Pro", Provider: "google", ProviderName: "Google",
			InputPerM: 1.25, OutputPerM: 5.00, CacheReadPerM: &cr, ContextK: 2000}
	case strings.Contains(clean, "gemini-2.5-flash") || strings.Contains(clean, "gemini-2.0-flash"):
		cr := 0.038
		return &Entry{ID: "gemini-2.5-flash", Name: "Gemini 2.5 Flash", Provider: "google", ProviderName: "Google",
			InputPerM: 0.15, OutputPerM: 0.60, CacheReadPerM: &cr, ContextK: 1000}
	case strings.Contains(clean, "glm-5.3-flash") || strings.Contains(clean, "glm-4-flash"):
		cr := 0.005
		return &Entry{ID: "glm-5.3-flash", Name: "GLM 5.3 Flash", Provider: "glm", ProviderName: "Zhipu AI",
			InputPerM: 0.01, OutputPerM: 0.01, CacheReadPerM: &cr, ContextK: 128}
	case strings.Contains(clean, "glm-5.3") || strings.Contains(clean, "glm-5"):
		cr := 0.14
		return &Entry{ID: "glm-5.3", Name: "GLM 5.3", Provider: "glm", ProviderName: "Zhipu AI",
			InputPerM: 0.70, OutputPerM: 0.70, CacheReadPerM: &cr, ContextK: 128}
	}
	return nil
}

// EnsureLoaded: lazy load — remote (60s throttle) → cache → flagships only.
func EnsureLoaded() {
	mu.Lock()
	stale := byID == nil || time.Since(lastFetch) > 24*time.Hour
	mu.Unlock()
	if stale {
		go load()
	}
}

// Refresh forces a reload (used by tests + POST /catalog/refresh later).
func Refresh() { load() }

func cachePath() string {
	home, _ := os.UserHomeDir()
	configDir := os.Getenv("TH_CONFIG_DIR")
	if configDir == "" {
		configDir = filepath.Join(home, ".config/token-horizon")
	}
	return filepath.Join(configDir, "models-cache.json")
}

func load() {
	if entries := fetchRemote(); entries != nil {
		injectFlagships(entries)
		publish(entries)
		if data, err := json.Marshal(entries); err == nil {
			os.MkdirAll(filepath.Dir(cachePath()), 0o755)
			os.WriteFile(cachePath(), data, 0o600)
		}
		return
	}
	if data, err := os.ReadFile(cachePath()); err == nil {
		var entries map[string]Entry
		if json.Unmarshal(data, &entries) == nil && len(entries) > 0 {
			injectFlagships(entries)
			publish(entries)
			return
		}
	}
	entries := map[string]Entry{}
	injectFlagships(entries)
	publish(entries)
}

func publish(entries map[string]Entry) {
	mu.Lock()
	byID = entries
	lastFetch = time.Now()
	mu.Unlock()
}

// All returns a snapshot of every catalog entry (readers get a copy — the
// map is swapped whole by publish). Sorted by provider/name for stable
// /models responses.
func All() []Entry {
	EnsureLoaded()
	mu.Lock()
	out := make([]Entry, 0, len(byID))
	for _, e := range byID {
		out = append(out, e)
	}
	mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// RemoteURL is overridable in tests.
var RemoteURL = "https://models.dev/api.json"

// fetchRemote: models.dev schema → Entry map keyed "<provider>/<model>".
func fetchRemote() map[string]Entry {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(RemoteURL)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil
	}
	var obj map[string]struct {
		Name   string `json:"name"`
		Doc    string `json:"doc"`
		Models map[string]struct {
			Name string `json:"name"`
			Cost struct {
				Input     float64  `json:"input"`
				Output    float64  `json:"output"`
				CacheRead *float64 `json:"cache_read"`
			} `json:"cost"`
			Limit struct {
				Context int `json:"context"`
			} `json:"limit"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &obj) != nil || len(obj) == 0 {
		return nil
	}
	entries := map[string]Entry{}
	for providerID, prov := range obj {
		providerName := prov.Name
		if providerName == "" {
			providerName = providerID
		}
		for modelID, m := range prov.Models {
			key := strings.ToLower(providerID + "/" + modelID)
			entries[key] = Entry{
				ID: modelID, Name: firstNonEmpty(m.Name, modelID),
				Provider: providerID, ProviderName: providerName,
				InputPerM: m.Cost.Input, OutputPerM: m.Cost.Output,
				CacheReadPerM: m.Cost.CacheRead,
				ContextK:      m.Limit.Context / 1000,
			}
		}
	}
	if len(entries) == 0 {
		return nil
	}
	return entries
}

// injectFlagships: hardcoded flagships win over the remote merge (they
// carry promo pricing models.dev doesn't know about).
func injectFlagships(entries map[string]Entry) {
	for _, id := range []string{
		"gpt-5-sol", "gpt-5-terra", "gpt-5-luna", "deepseek-v4-pro",
		"gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash",
		"glm-5.3-flash", "glm-5.3",
	} {
		if e := flagshipContains(id); e != nil {
			entries[strings.ToLower(e.Provider+"/"+e.ID)] = *e
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
