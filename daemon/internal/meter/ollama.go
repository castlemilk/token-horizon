package meter

// Ollama native API (OllamaMeter port): POST /api/chat, /api/generate.
// Responses are NDJSON: one JSON object per line; the final line carries
//
//	{ "done": true, "prompt_eval_count": N, "prompt_eval_duration": ns,
//	  "eval_count": M, "eval_duration": ns }
//
// Provider-reported nanosecond durations give EXACT rates — this format
// overrides rates to use them instead of wall-clock estimates.

import (
	"strings"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

type ollamaFormat struct{}

func (ollamaFormat) ShouldMeter(method, path string) bool {
	return method == "POST" &&
		(strings.HasPrefix(path, "/api/chat") || strings.HasPrefix(path, "/api/generate"))
}

func (ollamaFormat) Model(x *Exchange) string {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) == nil {
		if m, ok := obj["model"].(string); ok {
			return m
		}
	}
	// Fall back to the model echoed in the final NDJSON line.
	if final := ollamaFinalObject(x.ResponseBody.String()); final != nil {
		if m, ok := final["model"].(string); ok {
			return m
		}
	}
	return ""
}

// Ollama: prompt_eval_count IS the full prompt (cache mechanics hidden).
func (ollamaFormat) ContextOccupancy(t *core.TokenBreakdown) int64 { return t.Input }

func (ollamaFormat) Usage(x *Exchange) *core.TokenBreakdown {
	final := ollamaFinalObject(x.ResponseBody.String())
	if final == nil {
		return nil
	}
	input := int64FromAny(final["prompt_eval_count"])
	output := int64FromAny(final["eval_count"])
	if input <= 0 && output <= 0 {
		return nil
	}
	return &core.TokenBreakdown{Input: input, Output: output}
}

func (ollamaFormat) RequestID(x *Exchange) string    { return "" }
func (ollamaFormat) RequestIDAlt(x *Exchange) string { return "" }

// Ollama: `think` is bool OR a level string ("low"/"medium"/"high"),
// depending on model support.
func (ollamaFormat) Thinking(x *Exchange) (string, string, bool) {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) != nil {
		return "", "", false
	}
	think, present := obj["think"]
	if !present {
		return "", "", false
	}
	switch v := think.(type) {
	case bool:
		if v {
			return "adaptive", "think:true", true
		}
		return "off", "think:false", true
	case string:
		return strings.ToLower(v), "think:" + v, true
	}
	return "", "", false
}

// Exact provider-measured rates from nanosecond durations.
func (ollamaFormat) Rates(x *Exchange, t *core.TokenBreakdown) (prompt, generation *float64) {
	final := ollamaFinalObject(x.ResponseBody.String())
	if final == nil {
		return nil, nil
	}
	if count := int64FromAny(final["prompt_eval_count"]); count > 0 {
		if ns := int64FromAny(final["prompt_eval_duration"]); ns > 0 {
			prompt = f64(float64(count) / (float64(ns) / 1_000_000_000))
		}
	}
	if count := int64FromAny(final["eval_count"]); count > 0 {
		if ns := int64FromAny(final["eval_duration"]); ns > 0 {
			generation = f64(float64(count) / (float64(ns) / 1_000_000_000))
		}
	}
	return prompt, generation
}

func (ollamaFormat) LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []core.LimitSnapshot {
	return nil // local runtime: no wire rate limits
}

// Last non-empty NDJSON line as an object.
func ollamaFinalObject(text string) map[string]any {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		var obj map[string]any
		if jsonUnmarshal([]byte(trimmed), &obj) == nil {
			return obj
		}
	}
	return nil
}

func int64FromAny(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	}
	return 0
}
