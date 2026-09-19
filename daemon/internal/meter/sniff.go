package meter

// Shared attribution vocabulary, ported 1:1 from Metering/RequestMeter.swift
// (ProductSniff, ThinkingBands) and Usage/AccountKey.swift. The mitm addon
// interpolates the SAME UA table — keep the two in lockstep.

import (
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/catalog"
	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

// uaTable: UA-substring → product, matched in order (specific needles first).
var uaTable = []struct{ needle, product string }{
	{"claude-cli", "claude-code"}, {"claude_code", "claude-code"},
	{"codex_cli_rs", "codex"}, {"codex", "codex"},
	{"opencode", "opencode"},
	{"kimi", "kimi-cli"},
	{"gemini-cli", "gemini-cli"}, {"gemini_cli", "gemini-cli"},
	{"pi-ai", "pi"}, {"pi/", "pi"}, {"pi-coding-agent", "pi"}, {"pi_coding", "pi"},
	{"aider", "aider"}, {"cursor", "cursor"}, {"continue", "continue"},
	{"python-", "python-sdk"}, {"node", "node-sdk"},
	{"curl", "curl"},
}

// UATable exports the UA→product rows (the MITM addon interpolates the SAME
// table into its generated Python — Go and Python paths cannot drift).
func UATable() [][2]string {
	out := make([][2]string, len(uaTable))
	for i, row := range uaTable {
		out[i] = [2]string{row.needle, row.product}
	}
	return out
}

func sniffProduct(userAgent string) string {
	ua := strings.ToLower(userAgent)
	if ua == "" {
		return ""
	}
	for _, row := range uaTable {
		if strings.Contains(ua, row.needle) {
			return row.product
		}
	}
	return ""
}

// ThinkingBands: token-budget → level. Bands are vendor-neutral vocabulary:
// off / adaptive / low / medium / high. zeroSemantics distinguishes what a
// zero budget means on the wire: Anthropic treats budget<1 as "model
// decides" (adaptive); Gemini's 0 is an explicit off switch.
func thinkingLevelForBudget(budget int, zeroIsOff bool) string {
	if budget == 0 {
		if zeroIsOff {
			return "off"
		}
		return "adaptive"
	}
	if budget < 0 { // e.g. Gemini -1 = dynamic
		return "adaptive"
	}
	switch {
	case budget < 4_000:
		return "low"
	case budget < 16_000:
		return "medium"
	default:
		return "high"
	}
}

// parseResetDuration parses OpenAI-style reset values ("500ms", "1m2.5s",
// "20s") — durations, not timestamps. nil when unparsable.
func parseResetDuration(raw string) *time.Duration {
	d, err := time.ParseDuration(raw)
	if err != nil {
		return nil
	}
	return &d
}

// CostEngine.decide port: plan/subscription vendors and local runtimes are
// zero-rated (.planFree — quota is the ceiling, not a bill). API-billed
// vendors price from the ModelCatalog (.computed; cache-write priced as
// input, reasoning as output); no pricing basis → .unknown and the
// READ-side cost_equivalent (pricing intervals) carries the USD
// normalization.

func costDecision(vendor, model string, tokens core.TokenBreakdown) (float64, string) {
	v := core.Vendor(vendor)
	if core.PlanVendors[v] || core.LocalComputeVendors[v] {
		return 0, "planFree"
	}
	if entry := catalog.Lookup(model); entry != nil {
		cost := entry.Price(tokens.Input, tokens.Output, tokens.Reasoning, tokens.CacheRead, tokens.CacheWrite)
		if cost > 0 || (entry.InputPerM == 0 && entry.OutputPerM == 0) {
			return cost, "computed"
		}
	}
	return 0, "unknown"
}
