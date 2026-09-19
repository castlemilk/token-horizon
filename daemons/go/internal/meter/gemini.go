package meter

// Gemini generateContent wire format (GeminiMeter + Usage/GeminiUsage port)
// — covers the Gemini API and any Google-compatible gateway:
//
//	POST /v1beta/models/<model>:generateContent          (JSON response)
//	POST /v1beta/models/<model>:streamGenerateContent    (SSE; usageMetadata
//	                                                     rides the final chunk)
//
// The model is in the PATH, not the request body.

import (
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"strconv"
	"strings"
)

type geminiFormat struct{}

func (geminiFormat) ShouldMeter(method, path string) bool {
	return method == "POST" &&
		(strings.Contains(path, ":generateContent") || strings.Contains(path, ":streamGenerateContent"))
}

func (geminiFormat) Model(x *Exchange) string {
	// /v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse
	i := strings.Index(x.Path, "/models/")
	if i < 0 {
		return ""
	}
	rest := x.Path[i+len("/models/"):]
	if colon := strings.IndexByte(rest, ':'); colon >= 0 {
		return rest[:colon]
	}
	return ""
}

// Gemini semantics: promptTokenCount includes cached tokens. Storage is NET
// (input excludes cacheRead), so gross occupancy = net input + cached share.
func (geminiFormat) ContextOccupancy(t *usage.TokenBreakdown) int64 {
	return t.Input + t.CacheRead
}

func (f geminiFormat) Usage(x *Exchange) *usage.TokenBreakdown {
	text := x.ResponseBody.String()
	if strings.HasPrefix(text, "data:") {
		var found *usage.TokenBreakdown
		for _, obj := range sseObjects(text) {
			if meta, ok := obj["usageMetadata"].(map[string]any); ok {
				b := usage.GeminiUsageBreakdown(meta)
				found = &b
			}
		}
		return found
	}
	var obj map[string]any
	if jsonUnmarshal(x.ResponseBody.Bytes(), &obj) == nil {
		if meta, ok := obj["usageMetadata"].(map[string]any); ok {
			b := usage.GeminiUsageBreakdown(meta)
			return &b
		}
	}
	return nil
}

func (geminiFormat) RequestID(x *Exchange) string    { return "" }
func (geminiFormat) RequestIDAlt(x *Exchange) string { return "" }

// Gemini: `generationConfig.thinkingConfig.thinkingBudget: N` — a token
// budget (banded); 0 is an explicit OFF on this wire, -1 = dynamic.
func (geminiFormat) Thinking(x *Exchange) (string, string, bool) {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) != nil {
		return "", "", false
	}
	gc, ok := obj["generationConfig"].(map[string]any)
	if !ok {
		return "", "", false
	}
	tc, ok := gc["thinkingConfig"].(map[string]any)
	if !ok {
		return "", "", false
	}
	if budget, ok := tc["thinkingBudget"].(float64); ok {
		return thinkingLevelForBudget(int(budget), true), "thinkingBudget:" + strconv.Itoa(int(budget)), true
	}
	return "", "", false
}

func (geminiFormat) Rates(x *Exchange, t *usage.TokenBreakdown) (prompt, generation *float64) {
	return defaultRates(x, t)
}

func (geminiFormat) LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []usage.LimitSnapshot {
	return defaultLimitSnapshots(x, vendor, machineID, accountID)
}

// GeminiUsageBreakdown: thin wrapper over the ONE shared parser in core.
func GeminiUsageBreakdown(meta map[string]any) usage.TokenBreakdown {
	return usage.GeminiUsageBreakdown(meta)
}
