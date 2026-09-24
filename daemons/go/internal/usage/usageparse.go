package usage

// THE shared wire-usage parsers (UsageEngine's breakdown helpers +
// GeminiUsage.swift port). ONE implementation per convention, consumed by
// the meters, the file scanners, and the consolidators — they can never
// drift apart. NET semantics everywhere: input excludes cache, output
// excludes reasoning; already-net payloads (subset > gross) kept as-is.

import (
	"encoding/json"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

// JSONInt coerces a JSON number field.
func JSONInt(dict map[string]any, key string) int64 {
	if v, ok := dict[key].(float64); ok {
		return int64(v)
	}
	return 0
}

// AnthropicUsageBreakdown: input/output/cache_read/cache_creation
// convention. input already excludes cache (net). thinking_tokens are a
// SUBSET of output — store net output + separate reasoning.
func AnthropicUsageBreakdown(usage map[string]any) TokenBreakdown {
	var reasoning int64
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		reasoning = JSONInt(details, "thinking_tokens")
	}
	grossOutput := JSONInt(usage, "output_tokens")
	output := grossOutput
	if reasoning <= grossOutput {
		output = grossOutput - reasoning
	}
	return TokenBreakdown{
		Input:      JSONInt(usage, "input_tokens"),
		Output:     output,
		Reasoning:  reasoning,
		CacheRead:  JSONInt(usage, "cache_read_input_tokens"),
		CacheWrite: JSONInt(usage, "cache_creation_input_tokens"),
	}
}

// OpenAIUsageBreakdown: prompt/completion + details.reasoning/cached.
// Alternate spellings (chat completions vs Responses API) take the max,
// never the sum.
func OpenAIUsageBreakdown(usage map[string]any) TokenBreakdown {
	grossInput := max(JSONInt(usage, "prompt_tokens"), JSONInt(usage, "input_tokens"))
	grossOutput := max(JSONInt(usage, "completion_tokens"), JSONInt(usage, "output_tokens"))
	var reasoning, cacheRead int64
	if d, ok := usage["completion_tokens_details"].(map[string]any); ok {
		reasoning = max(reasoning, JSONInt(d, "reasoning_tokens"))
	}
	if d, ok := usage["output_tokens_details"].(map[string]any); ok {
		reasoning = max(reasoning, JSONInt(d, "reasoning_tokens"))
	}
	if d, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		cacheRead = max(cacheRead, JSONInt(d, "cached_tokens"))
	}
	if d, ok := usage["input_tokens_details"].(map[string]any); ok {
		cacheRead = max(cacheRead, JSONInt(d, "cached_tokens"))
	}
	in, out := grossInput, grossOutput
	if cacheRead <= grossInput {
		in = grossInput - cacheRead
	}
	if reasoning <= grossOutput {
		out = grossOutput - reasoning
	}
	return TokenBreakdown{Input: in, Output: out, Reasoning: reasoning, CacheRead: cacheRead}
}

// GeminiUsageBreakdown: usageMetadata → TokenBreakdown. Both snake_case and
// camelCase spellings occur across channels. promptTokenCount INCLUDES
// cached tokens. Falls back to the bare total (attributed as input) when
// components are absent.
func GeminiUsageBreakdown(meta map[string]any) TokenBreakdown {
	grossInput := max(JSONInt(meta, "prompt_token_count"), JSONInt(meta, "promptTokenCount"))
	output := max(JSONInt(meta, "candidates_token_count"), JSONInt(meta, "candidatesTokenCount"))
	reasoning := max(JSONInt(meta, "thoughts_token_count"), JSONInt(meta, "thoughtsTokenCount"))
	cacheRead := max(JSONInt(meta, "cached_content_token_count"), JSONInt(meta, "cachedContentTokenCount"))
	in := grossInput
	if cacheRead <= grossInput {
		in = grossInput - cacheRead
	}
	b := TokenBreakdown{Input: in, Output: output, Reasoning: reasoning, CacheRead: cacheRead}
	if b.Total() == 0 {
		if total := max(JSONInt(meta, "total_token_count"), JSONInt(meta, "totalTokenCount")); total > 0 {
			b.Input += total
		}
	}
	return b
}

// ParseJSONLine: one JSONL line → object (nil when malformed).
func ParseJSONLine(line []byte) map[string]any {
	var obj map[string]any
	if json.Unmarshal(line, &obj) != nil {
		return nil
	}
	return obj
}

// ---- Vendor cost classes (CostEngine.decide port) ----

// PlanVendors: subscription/plan-covered vendors — quota is the ceiling,
// not a bill; per-request cost is 0 (.planFree).
var PlanVendors = map[string]bool{
	"kimi": true, "glm": true, "minimax": true, "alibaba": true, "opencode": true,
}

// LocalComputeVendors: self-managed runtimes — inference is local, marginal
// cost is 0 (bounded by hardware, not a bill).
var LocalComputeVendors = map[string]bool{
	"ollama": true, "vllm": true, "sglang": true, "llamacpp": true, "mlx": true,
}

// CostSourcePlanFree / CostSourceUnknown / ... are the cost_source values.
const (
	CostSourcePlanFree = "planFree"
	CostSourceComputed = "computed"
	CostSourceReported = "reported"
	CostSourceUnknown  = "unknown"
)

// ---- Kimi paths (KimiPaths port — ONE home for kimi file locations) ----

// KimiHomes: code-home first; env overrides replace the default dotdir.
// Never empty.
func KimiHomes() []string {
	home := platform.HomeDir()
	code := platform.EnvOr("KIMI_CODE_HOME", home+"/.kimi-code")
	classic := platform.EnvOr("KIMI_HOME", home+"/.kimi")
	if code == classic {
		return []string{code}
	}
	return []string{code, classic}
}

// KimiSessionDirs: wire.jsonl session roots (scanners, consolidator).
func KimiSessionDirs() []string {
	var out []string
	for _, h := range KimiHomes() {
		out = append(out, h+"/sessions")
	}
	return out
}

// KimiCredentialFiles: OAuth credential files, one per profile (limits).
func KimiCredentialFiles() []string {
	var out []string
	for _, h := range KimiHomes() {
		out = append(out, h+"/credentials/kimi-code.json")
	}
	return out
}
