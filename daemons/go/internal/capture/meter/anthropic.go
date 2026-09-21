package meter

// Anthropic Messages wire format (AnthropicMeter port) — covers Claude Code
// and anthropic-compatible endpoints (e.g. Kimi for Coding).
//
// Streaming SSE anatomy:
//
//	message_start → data.message.usage { input_tokens, cache_read_input_tokens,
//	                cache_creation_input_tokens }  (context fill at send time)
//	message_delta → data.usage { output_tokens }   (final output count)
//
// Non-streaming: plain JSON response with the same usage object.

import (
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"strconv"
	"strings"
	"time"
)

type anthropicFormat struct{}

func (anthropicFormat) ShouldMeter(method, path string) bool {
	// Anthropic-compatible bases carry prefixes: kimi is /coding/v1/messages,
	// zhipu is /api/anthropic/v1/messages — match the SUFFIX, not a prefix.
	p := strings.SplitN(path, "?", 2)[0]
	return method == "POST" && (strings.HasSuffix(p, "/v1/messages") || strings.HasPrefix(p, "/messages"))
}

// Anthropic's `request-id` response header == the `requestId` field Claude
// Code transcripts persist — the strong cross-channel dedup key.
func (anthropicFormat) RequestID(x *Exchange) string {
	return x.ResponseHeaders["request-id"]
}

// The body id (msg_...) is the SECOND Anthropic id: pi-style harnesses
// persist it as `responseId`, so file annotations from those tools join on
// this value.
func (anthropicFormat) RequestIDAlt(x *Exchange) string {
	var obj map[string]any
	if jsonUnmarshal(x.ResponseBody.Bytes(), &obj) == nil {
		if id, ok := obj["id"].(string); ok {
			return id
		}
	}
	text := x.ResponseBody.String()
	if !strings.HasPrefix(text, "event:") && !strings.HasPrefix(text, "data:") {
		return ""
	}
	for _, o := range sseObjects(text) {
		if o["type"] == "message_start" {
			if msg, ok := o["message"].(map[string]any); ok {
				if id, ok := msg["id"].(string); ok {
					return id
				}
			}
		}
	}
	return ""
}

func (anthropicFormat) Model(x *Exchange) string {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) == nil {
		if m, ok := obj["model"].(string); ok {
			return m
		}
	}
	return ""
}

// Anthropic semantics: input_tokens EXCLUDE cache read/creation — the full
// context occupancy is the sum.
func (anthropicFormat) ContextOccupancy(t *usage.TokenBreakdown) int64 {
	return t.Input + t.CacheRead + t.CacheWrite
}

func (f anthropicFormat) Usage(x *Exchange) *usage.TokenBreakdown {
	text := x.ResponseBody.String()
	if strings.HasPrefix(text, "event:") || strings.HasPrefix(text, "data:") {
		return f.usageFromSSE(text)
	}
	var obj map[string]any
	if jsonUnmarshal(x.ResponseBody.Bytes(), &obj) == nil {
		if u, ok := obj["usage"].(map[string]any); ok {
			b := anthropicParseUsage(u, usage.TokenBreakdown{})
			return &b
		}
	}
	return nil
}

func (f anthropicFormat) usageFromSSE(text string) *usage.TokenBreakdown {
	var b usage.TokenBreakdown
	sawUsage := false
	for _, obj := range sseObjects(text) {
		typ, _ := obj["type"].(string)
		switch typ {
		case "message_start":
			if msg, ok := obj["message"].(map[string]any); ok {
				if usage, ok := msg["usage"].(map[string]any); ok {
					b = anthropicParseUsage(usage, b)
					sawUsage = true
				}
			}
		case "message_delta":
			if usage, ok := obj["usage"].(map[string]any); ok {
				// output_tokens is the cumulative GROSS count (includes
				// thinking). TokenBreakdown stores NET output, so subtract.
				thinking := b.Reasoning
				if details, ok := usage["output_tokens_details"].(map[string]any); ok {
					if t, ok := details["thinking_tokens"].(float64); ok {
						thinking = int64(t)
						b.Reasoning = thinking
						sawUsage = true
					}
				}
				if out, ok := usage["output_tokens"].(float64); ok {
					gross := int64(out)
					if thinking <= gross {
						b.Output = gross - thinking
					} else {
						b.Output = gross // already-net payload kept as-is
					}
					sawUsage = true
				}
			}
		}
	}
	if !sawUsage {
		return nil
	}
	return &b
}

func anthropicParseUsage(usage map[string]any, b usage.TokenBreakdown) usage.TokenBreakdown {
	if v, ok := usage["input_tokens"].(float64); ok {
		b.Input = int64(v)
	}
	// Non-streaming twin of the SSE delta: thinking tokens ride
	// output_tokens_details.thinking_tokens as a SUBSET of output — store
	// NET output so total isn't double-counted.
	thinking := b.Reasoning
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		if t, ok := details["thinking_tokens"].(float64); ok {
			thinking = int64(t)
			b.Reasoning = thinking
		}
	}
	if v, ok := usage["output_tokens"].(float64); ok {
		gross := int64(v)
		if thinking <= gross {
			b.Output = gross - thinking
		} else {
			b.Output = gross
		}
	}
	b.CacheRead = num(usage, "cache_read_input_tokens")
	b.CacheWrite = num(usage, "cache_creation_input_tokens")
	return b
}

// Anthropic: `thinking: {"type": "enabled", "budget_tokens": N}` — the
// level is a token BUDGET, so we band it (off/low/medium/high; 0 = adaptive
// on this wire).
func (anthropicFormat) Thinking(x *Exchange) (string, string, bool) {
	var obj map[string]any
	if jsonUnmarshal(x.RequestBody, &obj) != nil {
		return "", "", false
	}
	thinking, ok := obj["thinking"].(map[string]any)
	if !ok {
		return "", "", false
	}
	typ, ok := thinking["type"].(string)
	if !ok {
		return "", "", false
	}
	if typ != "enabled" {
		return "off", "type:" + typ, true
	}
	budget := int(num(thinking, "budget_tokens"))
	return thinkingLevelForBudget(budget, false), "budget_tokens:" + strconv.Itoa(budget), true
}

func (anthropicFormat) Rates(x *Exchange, t *usage.TokenBreakdown) (prompt, generation *float64) {
	return defaultRates(x, t)
}

// Anthropic rate limits ride every response as
// `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`; reset is
// an RFC3339 timestamp (not a duration like OpenAI).
func (anthropicFormat) LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []usage.LimitSnapshot {
	var out []usage.LimitSnapshot
	for _, kind := range []string{"requests", "tokens"} {
		limit, lok := headerFloat(x.ResponseHeaders, "anthropic-ratelimit-"+kind+"-limit")
		remaining, rok := headerFloat(x.ResponseHeaders, "anthropic-ratelimit-"+kind+"-remaining")
		if !lok || !rok || limit <= 0 {
			continue
		}
		used := (1 - remaining/limit) * 100
		if used < 0 {
			used = 0
		}
		if used > 100 {
			used = 100
		}
		sn := usage.LimitSnapshot{
			RecordedAt:  x.CompletedAt.Unix(),
			MachineID:   machineID,
			Provider:    vendor,
			AccountID:   accountID,
			Label:       kind + " (wire)",
			UsedPercent: used,
		}
		sn.Detail = strconv.FormatInt(int64(remaining), 10) + "/" + strconv.FormatInt(int64(limit), 10) + " remaining"
		if raw := x.ResponseHeaders["anthropic-ratelimit-"+kind+"-reset"]; raw != "" {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw)); err == nil {
				at := t.Unix()
				sn.ResetsAt = &at
			}
		}
		out = append(out, sn)
	}
	return out
}
