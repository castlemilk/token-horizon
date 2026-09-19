package meter

// OpenAI wire format (OpenAICompatibleMeter port) — one implementation
// covers OpenAI itself plus every OpenAI-compatible server (vLLM, SGLang,
// llama.cpp, LiteLLM, OpenRouter, DeepSeek, Zhipu, MiniMax, Alibaba
// compatible-mode, Codex responses API).
//
//	Chat completions: POST /v1/chat/completions → JSON {usage} or SSE chunks
//	  whose final chunk carries "usage" (stream_options.include_usage).
//	Responses API (Codex CLI): POST /v1/responses → SSE response.completed
//	  (data.response.usage) or final JSON {usage:{input_tokens,...}}.

import (
	"strings"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

type openAIFormat struct{}

// Path SUFFIXES, not prefixes: bases carry prefixes (/zen/v1/... for
// opencode, /coding/v1/... for kimi-style gateways), and meters are
// per-vendor loopback relays — only that vendor's clients arrive here.
var openAIMeteredSuffixes = []string{
	"/v1/chat/completions", "/v1/completions", "/chat/completions", "/completions",
	"/v1/responses", "/responses", "/backend-api/codex/responses",
}

func (openAIFormat) ShouldMeter(method, path string) bool {
	if method != "POST" {
		return false
	}
	p := strings.SplitN(path, "?", 2)[0]
	for _, suffix := range openAIMeteredSuffixes {
		if strings.HasSuffix(p, suffix) {
			return true
		}
	}
	return false
}

func (openAIFormat) Model(x *Exchange) string {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) == nil {
		if m, ok := obj["model"].(string); ok {
			return m
		}
	}
	return ""
}

// OpenAI semantics: prompt_tokens already include cached tokens. Storage is
// NET (input excludes cacheRead), so gross occupancy = net input + cached.
func (openAIFormat) ContextOccupancy(t *core.TokenBreakdown) int64 {
	return t.Input + t.CacheRead
}

func (f openAIFormat) Usage(x *Exchange) *core.TokenBreakdown {
	if u := openAIUsageFromSSE(x.ResponseBody.String()); u != nil {
		return u
	}
	return openAIUsageFromJSON(x.ResponseBody.Bytes())
}

// Whole-body JSON response (non-streaming).
func openAIUsageFromJSON(body []byte) *core.TokenBreakdown {
	var obj map[string]any
	if jsonUnmarshal(body, &obj) != nil {
		return nil
	}
	usage, ok := obj["usage"].(map[string]any)
	if !ok {
		return nil
	}
	b := openAIParseUsage(usage)
	return &b
}

// SSE: usage rides a response.completed event (Responses API) or the final
// data: chunk (chat completions with include_usage; vLLM/SGLang always).
// Streams may start with `event:` (Zen) or `data:` (OpenAI).
func openAIUsageFromSSE(text string) *core.TokenBreakdown {
	if !strings.HasPrefix(text, "data:") && !strings.HasPrefix(text, "event:") {
		return nil
	}
	var found *core.TokenBreakdown
	for _, obj := range sseObjects(text) {
		if usage, ok := obj["usage"].(map[string]any); ok {
			b := openAIParseUsage(usage)
			found = &b
		} else if resp, ok := obj["response"].(map[string]any); ok {
			if usage, ok := resp["usage"].(map[string]any); ok {
				b := openAIParseUsage(usage)
				found = &b
			}
		}
	}
	return found
}

func openAIParseUsage(usage map[string]any) core.TokenBreakdown {
	// Chat completions names vs Responses API names are ALTERNATE spellings
	// of the same counters (Zen may send either) — take the max, never the
	// sum, so a dual-spelled payload can't double-count.
	grossInput := max(num(usage, "prompt_tokens"), num(usage, "input_tokens"))
	grossOutput := max(num(usage, "completion_tokens"), num(usage, "output_tokens"))
	var reasoning int64
	if d, ok := usage["completion_tokens_details"].(map[string]any); ok {
		reasoning = max(reasoning, num(d, "reasoning_tokens"))
	}
	if d, ok := usage["output_tokens_details"].(map[string]any); ok {
		reasoning = max(reasoning, num(d, "reasoning_tokens"))
	}
	var cacheRead int64
	if d, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		cacheRead = max(cacheRead, num(d, "cached_tokens"))
	}
	if d, ok := usage["input_tokens_details"].(map[string]any); ok {
		cacheRead = max(cacheRead, num(d, "cached_tokens"))
	}
	// NET storage: reasoning_tokens and cached_tokens USUALLY arrive as
	// subsets of the gross counters, so subtract to avoid double-counting.
	// But some gateway payloads are already net (subset LARGER than gross,
	// e.g. Zen tool-call steps) — never subtract past zero into a loss.
	in, out := grossInput, grossOutput
	if cacheRead <= grossInput {
		in = grossInput - cacheRead
	}
	if reasoning <= grossOutput {
		out = grossOutput - reasoning
	}
	return core.TokenBreakdown{Input: in, Output: out, Reasoning: reasoning, CacheRead: cacheRead}
}

func (openAIFormat) RequestID(x *Exchange) string {
	// Non-streaming: top-level body id. SSE: every chunk repeats the same
	// response id — first wins ("response" wrapper for the Responses API).
	var obj map[string]any
	if jsonUnmarshal(x.ResponseBody.Bytes(), &obj) == nil {
		if id, ok := obj["id"].(string); ok {
			return id
		}
	}
	text := x.ResponseBody.String()
	if !strings.HasPrefix(text, "data:") && !strings.HasPrefix(text, "event:") {
		return ""
	}
	for _, o := range sseObjects(text) {
		if id, ok := o["id"].(string); ok {
			return id
		}
		if resp, ok := o["response"].(map[string]any); ok {
			if id, ok := resp["id"].(string); ok {
				return id
			}
		}
	}
	return ""
}

func (openAIFormat) RequestIDAlt(x *Exchange) string { return "" }

// OpenAI: `reasoning_effort: "low|medium|high"` (chat) or
// `reasoning: {effort: ...}` (Responses API). Absent = model default.
func (openAIFormat) Thinking(x *Exchange) (string, string, bool) {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) != nil {
		return "", "", false
	}
	if effort, ok := obj["reasoning_effort"].(string); ok {
		return normalizeEffort(effort), "reasoning_effort:" + effort, true
	}
	if reasoning, ok := obj["reasoning"].(map[string]any); ok {
		if effort, ok := reasoning["effort"].(string); ok {
			return normalizeEffort(effort), "reasoning.effort:" + effort, true
		}
	}
	return "", "", false
}

func normalizeEffort(effort string) string {
	switch strings.ToLower(effort) {
	case "none", "minimal", "off":
		return "off"
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high", "max":
		return "high"
	case "auto":
		return "adaptive"
	default:
		return strings.ToLower(effort)
	}
}

func (openAIFormat) Rates(x *Exchange, t *core.TokenBreakdown) (prompt, generation *float64) {
	return defaultRates(x, t)
}

func (openAIFormat) LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []core.LimitSnapshot {
	return defaultLimitSnapshots(x, vendor, machineID, accountID)
}
