package catalog

// Benchmarks — benchmarks.json loader + top-picks scoring, ported from
// Catalog/ModelCatalog.loadBenchmarks + ModelsPipeline.computeTopPicks.
// The JSON is embedded so the daemon carries its own curated scores
// (SWE-bench Verified / LiveCodeBench); ~/.config/token-horizon/benchmarks.json
// overrides it when present (same precedence as the Swift app).

import (
	_ "embed"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

//go:embed benchmarks.json
var bundledBenchmarks []byte

type Benchmark struct {
	Name   string   `json:"name"`
	Match  string   `json:"match"`
	SWE    *float64 `json:"swe,omitempty"`
	LCB    *float64 `json:"lcb,omitempty"`
	Source string   `json:"source"`
}

var benchOnce struct {
	mu   sync.Mutex
	byID map[string]Benchmark
}

func loadBenchmarks() map[string]Benchmark {
	data := bundledBenchmarks
	if home, err := os.UserHomeDir(); err == nil {
		if user, err := os.ReadFile(filepath.Join(home, ".config/token-horizon/benchmarks.json")); err == nil {
			data = user // user override wins over the embedded copy
		}
	}
	var obj struct {
		Entries []Benchmark `json:"entries"`
	}
	if json.Unmarshal(data, &obj) != nil {
		return nil
	}
	out := map[string]Benchmark{}
	for _, e := range obj.Entries {
		e.Match = strings.ToLower(e.Match)
		out[e.Match] = e
	}
	return out
}

// BenchmarksFor resolves a model id/name to curated scores. Exact match on
// the model slug (after provider prefix), else longest `match` contained in
// the id — covers dated suffixes like claude-3-7-sonnet-20250219.
func BenchmarksFor(id string) *Benchmark {
	benchOnce.mu.Lock()
	if benchOnce.byID == nil {
		benchOnce.byID = loadBenchmarks()
	}
	byID := benchOnce.byID
	benchOnce.mu.Unlock()

	key := strings.ToLower(id)
	if i := strings.LastIndex(key, "/"); i >= 0 {
		key = key[i+1:]
	}
	if b, ok := byID[key]; ok {
		return &b
	}
	var best *Benchmark
	bestLen := 0
	for match, b := range byID {
		if len(match) > bestLen && strings.Contains(key, match) {
			cp := b
			best, bestLen = &cp, len(match)
		}
	}
	return best
}

// ---- top picks (ModelsPipeline.computeTopPicks port) --------------------

type TopPick struct {
	Rank            int      `json:"rank"`
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Provider        string   `json:"provider"`
	ProviderName    string   `json:"providerName"`
	ValueScore      float64  `json:"valueScore"`
	PerfScore       float64  `json:"perfScore"`
	BlendedCostPerM float64  `json:"blendedCostPerM"`
	PriceKnown      bool     `json:"priceKnown"`
	Badge           string   `json:"badge"`
	BadgeColor      string   `json:"badgeColor"`
	Reason          string   `json:"reason"`
	SWE             *float64 `json:"swe,omitempty"`
	LCB             *float64 `json:"lcb,omitempty"`
}

// TopPicks: balanced Pareto value scoring — capability-weighted with a
// frontier premium, divided by log-cost, over the full catalog. Identical
// constants to computeTopPicks.
func TopPicks() []TopPick {
	type cand struct {
		e        Entry
		b        Benchmark
		perf     float64
		cost     float64
		rawScore float64
	}
	var cands []cand
	for _, e := range All() {
		idLower := strings.ToLower(e.ID)
		if strings.Contains(idLower, "x-preview") || strings.Contains(idLower, "ox-alpha") {
			continue
		}
		if strings.Contains(strings.ToLower(e.Name), "deprecated") {
			continue
		}
		b := BenchmarksFor(e.ID)
		if b == nil {
			b = BenchmarksFor(e.Name)
		}
		if b == nil || (b.SWE == nil && b.LCB == nil) {
			continue
		}
		norm := func(v float64) float64 {
			if v <= 1.0 && v > 0 {
				return v * 100.0
			}
			return v
		}
		var perf float64
		switch {
		case b.SWE != nil && b.LCB != nil:
			perf = norm(*b.SWE)*0.65 + norm(*b.LCB)*0.35
		case b.SWE != nil:
			perf = norm(*b.SWE)
		default:
			perf = norm(*b.LCB)
		}
		if perf < 35.0 {
			continue
		}
		blended := e.InputPerM*0.75 + e.OutputPerM*0.25
		if e.InputPerM == 0 && e.OutputPerM == 0 {
			blended = 0.04 // free/local floor — never a fabricated $0
		}
		if blended < 0.04 {
			blended = 0.04
		}
		costFactor := math.Log2(1.0+blended*2.5) + 1.2
		perfFactor := math.Pow(perf/50.0, 2.6)
		switch {
		case perf >= 83.0:
			perfFactor *= 2.20 // premier frontier flagship
		case perf >= 80.0:
			perfFactor *= 1.35 // frontier S-tier premium
		case perf >= 75.0:
			perfFactor *= 1.18
		}
		cands = append(cands, cand{e: e, b: *b, perf: perf, cost: blended,
			rawScore: perfFactor * 100.0 / costFactor})
	}
	// Dedupe by benchmark match: the catalog lists the same model under many
	// providers (302ai, openrouter, direct) — keep the best-scored listing
	// per benchmark entry so picks aren't the same model repeated.
	seen := map[string]bool{}
	var deduped []cand
	sort.Slice(cands, func(i, j int) bool { return cands[i].rawScore > cands[j].rawScore })
	for _, c := range cands {
		if seen[c.b.Match] {
			continue
		}
		seen[c.b.Match] = true
		deduped = append(deduped, c)
	}
	cands = deduped
	if len(cands) > 10 {
		cands = cands[:10]
	}
	if len(cands) == 0 || cands[0].rawScore <= 0 {
		return nil
	}
	maxScore := cands[0].rawScore
	out := make([]TopPick, 0, len(cands))
	for i, c := range cands {
		normScore := 75.0 + (c.rawScore/maxScore)*24.5
		valueScore := math.Min(99.9, math.Round(normScore*10)/10)
		badge, color := "TOP VALUE", "green"
		free := c.e.InputPerM == 0 && c.e.OutputPerM == 0
		switch {
		case free:
			// catalog free-tier listing — not a local runtime row
			badge, color = "FREE", "blue"
		case c.perf >= 80.0:
			badge, color = "FRONTIER S-TIER", "purple"
		case c.cost <= 0.35:
			badge, color = "BUDGET PICK", "green"
		}
		priceKnown := free || c.e.InputPerM > 0 || c.e.OutputPerM > 0
		reason := badge + " · " + fmtPerf(c.perf) + " perf"
		if priceKnown {
			reason += " · $" + trimFloat(c.cost) + "/1M"
		}
		out = append(out, TopPick{
			Rank: i + 1, ID: c.e.ID, Name: c.e.Name,
			Provider: c.e.Provider, ProviderName: c.e.ProviderName,
			ValueScore: valueScore, PerfScore: math.Round(c.perf*10) / 10,
			BlendedCostPerM: c.cost, PriceKnown: priceKnown,
			Badge: badge, BadgeColor: color, Reason: reason,
			SWE: c.b.SWE, LCB: c.b.LCB,
		})
	}
	return out
}

func fmtPerf(v float64) string { return trimFloat(v) + "%" }

func trimFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}
