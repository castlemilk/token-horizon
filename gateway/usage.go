package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

// JSONObject parses one response body into its constituent objects,
// handling non-streaming JSON, NDJSON (Ollama), and SSE event streams
// (OpenAI/Anthropic data: lines + [DONE] sentinels). Partial tail lines
// that fail to parse are skipped.
func JSONObjects(data []byte) []map[string]any {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 {
		var root map[string]any
		if json.Unmarshal(trimmed, &root) == nil {
			return []map[string]any{root}
		}
	}
	var out []map[string]any
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		s := strings.TrimSpace(string(line))
		if rest, ok := strings.CutPrefix(s, "data:"); ok {
			s = strings.TrimSpace(rest)
		}
		if s == "" || s == "[DONE]" {
			continue
		}
		var obj map[string]any
		if json.Unmarshal([]byte(s), &obj) == nil {
			out = append(out, obj)
		}
	}
	return out
}

func num(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return int(i), true
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return int(f), true
		}
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func strMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// RequestInfo is best-effort model / stream / session extraction.
type RequestInfo struct {
	Model      string
	Stream     bool
	SessionKey string
}

func ParseRequestInfo(provider Provider, body []byte) RequestInfo {
	var info RequestInfo
	if len(body) == 0 {
		return info
	}
	var obj map[string]any
	if json.Unmarshal(body, &obj) != nil {
		return info
	}
	info.Model, _ = obj["model"].(string)
	info.Stream, _ = obj["stream"].(bool)
	switch provider {
	case ProviderOpenAI:
		if v, _ := obj["previous_response_id"].(string); v != "" {
			info.SessionKey = v
		} else if conv, ok := obj["conversation"].(map[string]any); ok {
			info.SessionKey, _ = conv["id"].(string)
		} else if conv, _ := obj["conversation"].(string); conv != "" {
			info.SessionKey = conv
		} else if meta, ok := obj["metadata"].(map[string]any); ok {
			info.SessionKey, _ = meta["session_id"].(string)
		}
	case ProviderAnthropic:
		if meta, ok := obj["metadata"].(map[string]any); ok {
			info.SessionKey, _ = meta["user_id"].(string)
		}
	}
	return info
}

// ExtractUsage pulls provider-reported token usage from captured response
// bytes. Absent usage yields TokenAbsent with nil counts — never estimated.
func ExtractUsage(provider Provider, endpoint Endpoint, responseBody []byte) Usage {
	objects := JSONObjects(responseBody)
	if len(objects) == 0 {
		return Usage{Source: TokenAbsent}
	}
	switch provider {
	case ProviderAnthropic:
		return anthropicUsage(objects)
	case ProviderOpenAI:
		if endpoint == EndpointResponses {
			return responsesUsage(objects)
		}
		return chatUsage(objects)
	case ProviderOllama:
		return ollamaUsage(responseBody)
	default:
		if u := chatUsage(objects); u.Source != TokenAbsent {
			return u
		}
		if u := responsesUsage(objects); u.Source != TokenAbsent {
			return u
		}
		return anthropicUsage(objects)
	}
}

// chatUsage handles OpenAI Chat Completions usage blocks. In SSE streams the
// usage object rides on the final chunk (stream_options.include_usage).
func chatUsage(objects []map[string]any) Usage {
	for i := len(objects) - 1; i >= 0; i-- {
		obj := objects[i]
		usage := strMap(obj["usage"])
		if usage == nil {
			usage = strMap(strMap(obj["message"])["usage"])
		}
		if usage == nil {
			continue
		}
		prompt, hasPrompt := num(usage["prompt_tokens"])
		completion, hasCompletion := num(usage["completion_tokens"])
		if !hasPrompt && !hasCompletion {
			continue
		}
		u := Usage{Source: TokenReported}
		if hasPrompt {
			u.InputTokens = intPtr(prompt)
		}
		if hasCompletion {
			u.OutputTokens = intPtr(completion)
		}
		if total, ok := num(usage["total_tokens"]); ok {
			u.TotalTokens = intPtr(total)
		}
		if details := strMap(usage["prompt_tokens_details"]); details != nil {
			if cached, ok := num(details["cached_tokens"]); ok {
				u.CachedTokens = intPtr(cached)
			}
		}
		if details := strMap(usage["completion_tokens_details"]); details != nil {
			if reasoning, ok := num(details["reasoning_tokens"]); ok {
				u.ReasoningTokens = intPtr(reasoning)
			}
		}
		return u
	}
	return Usage{Source: TokenAbsent}
}

// responsesUsage handles the OpenAI Responses API usage shape, including
// response.completed stream events.
func responsesUsage(objects []map[string]any) Usage {
	for i := len(objects) - 1; i >= 0; i-- {
		obj := objects[i]
		usage := strMap(obj["usage"])
		if usage == nil {
			usage = strMap(strMap(obj["response"])["usage"])
		}
		if usage == nil {
			continue
		}
		input, hasInput := num(usage["input_tokens"])
		output, hasOutput := num(usage["output_tokens"])
		if !hasInput && !hasOutput {
			continue
		}
		u := Usage{Source: TokenReported}
		if hasInput {
			u.InputTokens = intPtr(input)
		}
		if hasOutput {
			u.OutputTokens = intPtr(output)
		}
		if total, ok := num(usage["total_tokens"]); ok {
			u.TotalTokens = intPtr(total)
		}
		if details := strMap(usage["input_tokens_details"]); details != nil {
			if cached, ok := num(details["cached_tokens"]); ok {
				u.CachedTokens = intPtr(cached)
			}
		}
		if details := strMap(usage["output_tokens_details"]); details != nil {
			if reasoning, ok := num(details["reasoning_tokens"]); ok {
				u.ReasoningTokens = intPtr(reasoning)
			}
		}
		return u
	}
	return Usage{Source: TokenAbsent}
}

// anthropicUsage accumulates input from message_start and output from
// message deltas across an SSE stream (or a single non-streaming object).
func anthropicUsage(objects []map[string]any) Usage {
	var input, cacheRead *int
	var reasoning *int
	output := 0
	sawOutput := false
	accumulate := func(usage map[string]any) {
		if v, ok := num(usage["input_tokens"]); ok {
			input = intPtr(v)
		}
		if v, ok := num(usage["cache_read_input_tokens"]); ok {
			cacheRead = intPtr(v)
		}
		if v, ok := num(usage["output_tokens"]); ok {
			output += v
			sawOutput = true
		}
		if details := strMap(usage["output_tokens_details"]); details != nil {
			if v, ok := num(details["reasoning_tokens"]); ok {
				reasoning = intPtr(v)
			}
		}
	}
	for _, obj := range objects {
		if message := strMap(obj["message"]); message != nil {
			if usage := strMap(message["usage"]); usage != nil {
				accumulate(usage)
			}
		}
		if usage := strMap(obj["usage"]); usage != nil {
			accumulate(usage)
		}
	}
	if input == nil && !sawOutput {
		return Usage{Source: TokenAbsent}
	}
	u := Usage{Source: TokenAccumulated, InputTokens: input, CachedTokens: cacheRead, ReasoningTokens: reasoning}
	if sawOutput {
		u.OutputTokens = intPtr(output)
	}
	switch {
	case input != nil && sawOutput:
		u.TotalTokens = intPtr(*input + output)
	case input != nil:
		u.TotalTokens = intPtr(*input)
	case sawOutput:
		u.TotalTokens = intPtr(output)
	}
	return u
}

// ollamaUsage reads eval counts from native Ollama completion metadata.
func ollamaUsage(responseBody []byte) Usage {
	for _, obj := range JSONObjects(responseBody) {
		model, _ := obj["model"].(string)
		if model == "" {
			continue
		}
		if done, _ := obj["done"].(bool); done {
			eval, hasEval := num(obj["eval_count"])
			evalDur, hasDur := num(obj["eval_duration"])
			if hasEval && hasDur && evalDur > 0 {
				u := Usage{Source: TokenReported, OutputTokens: intPtr(eval)}
				if prompt, ok := num(obj["prompt_eval_count"]); ok {
					u.InputTokens = intPtr(prompt)
					u.TotalTokens = intPtr(prompt + eval)
				} else {
					u.TotalTokens = intPtr(eval)
				}
				return u
			}
		}
		if usage := strMap(obj["usage"]); usage != nil {
			if completion, ok := num(usage["completion_tokens"]); ok {
				u := Usage{Source: TokenReported, OutputTokens: intPtr(completion)}
				if prompt, ok := num(usage["prompt_tokens"]); ok {
					u.InputTokens = intPtr(prompt)
					u.TotalTokens = intPtr(prompt + completion)
				}
				return u
			}
		}
	}
	return Usage{Source: TokenAbsent}
}

// ExtractToolCalls returns model-requested tool invocations plus terminal
// finish/stop reasons. Streamed duplicates (same call id across deltas)
// collapse to one entry.
func ExtractToolCalls(provider Provider, endpoint Endpoint, responseBody []byte) ([]ToolCall, []string) {
	var calls []ToolCall
	reasons := map[string]struct{}{}
	for _, obj := range JSONObjects(responseBody) {
		switch provider {
		case ProviderOpenAI:
			if endpoint == EndpointResponses {
				var outputs []any
				if out, ok := obj["output"].([]any); ok {
					outputs = out
				} else if resp, ok := obj["response"].(map[string]any); ok {
					outputs, _ = resp["output"].([]any)
				}
				for _, item := range outputs {
					m, _ := item.(map[string]any)
					if m["type"] == "function_call" {
						name, _ := m["name"].(string)
						if name == "" {
							name = "unknown"
						}
						callID, _ := m["call_id"].(string)
						if callID == "" {
							callID, _ = m["id"].(string)
						}
						var idPtr *string
						if callID != "" {
							idPtr = stringPtr(callID)
						}
						calls = append(calls, ToolCall{Name: name, CallID: idPtr})
					}
				}
				if status, _ := obj["status"].(string); status == "completed" {
					reasons[status] = struct{}{}
				}
				if errObj, ok := obj["error"].(map[string]any); ok {
					if code, _ := errObj["code"].(string); code != "" {
						reasons[code] = struct{}{}
					}
				}
			} else {
				choices, _ := obj["choices"].([]any)
				for _, choice := range choices {
					m, _ := choice.(map[string]any)
					if reason, _ := m["finish_reason"].(string); reason != "" {
						reasons[reason] = struct{}{}
					}
					msg := strMap(m["message"])
					if msg == nil {
						msg = strMap(m["delta"])
					}
					if msg == nil {
						continue
					}
					tcs, _ := msg["tool_calls"].([]any)
					for _, tc := range tcs {
						tm, _ := tc.(map[string]any)
						fn := strMap(tm["function"])
						name, _ := fn["name"].(string)
						if name == "" {
							name = "unknown"
						}
						id, _ := tm["id"].(string)
						var idPtr *string
						if id != "" {
							idPtr = stringPtr(id)
						}
						calls = append(calls, ToolCall{Name: name, CallID: idPtr})
					}
				}
			}
		case ProviderAnthropic:
			if stop, _ := obj["stop_reason"].(string); stop != "" {
				reasons[stop] = struct{}{}
			}
			if delta := strMap(obj["delta"]); delta != nil {
				if stop, _ := delta["stop_reason"].(string); stop != "" {
					reasons[stop] = struct{}{}
				}
			}
			var blocks []any
			if content, ok := obj["content"].([]any); ok {
				blocks = content
			} else if message, ok := obj["message"].(map[string]any); ok {
				blocks, _ = message["content"].([]any)
			}
			for _, block := range blocks {
				bm, _ := block.(map[string]any)
				if bm["type"] == "tool_use" {
					name, _ := bm["name"].(string)
					if name == "" {
						name = "unknown"
					}
					id, _ := bm["id"].(string)
					var idPtr *string
					if id != "" {
						idPtr = stringPtr(id)
					}
					calls = append(calls, ToolCall{Name: name, CallID: idPtr})
				}
			}
			if block := strMap(obj["content_block"]); block != nil && block["type"] == "tool_use" {
				name, _ := block["name"].(string)
				if name == "" {
					name = "unknown"
				}
				id, _ := block["id"].(string)
				var idPtr *string
				if id != "" {
					idPtr = stringPtr(id)
				}
				calls = append(calls, ToolCall{Name: name, CallID: idPtr})
			}
		}
	}
	// Dedupe by call id; anonymous calls keep order with synthetic ids.
	seen := map[string]struct{}{}
	deduped := []ToolCall{}
	unnamed := 0
	for _, call := range calls {
		if call.CallID != nil && *call.CallID != "" {
			if _, ok := seen[*call.CallID]; ok {
				continue
			}
			seen[*call.CallID] = struct{}{}
			deduped = append(deduped, call)
		} else {
			unnamed++
			deduped = append(deduped, ToolCall{Name: call.Name, CallID: stringPtr("__anon_" + strconv.Itoa(unnamed))})
		}
	}
	if deduped == nil {
		deduped = []ToolCall{}
	}
	reasonList := make([]string, 0, len(reasons))
	for r := range reasons {
		reasonList = append(reasonList, r)
	}
	sort.Strings(reasonList)
	return deduped, reasonList
}

// ClassifyError maps a completed (or failed) exchange to an error class.
// 2xx with an error payload still classifies (SSE error objects).
func ClassifyError(statusCode int, responseBody []byte, networkError string) (ErrorClass, *string) {
	if networkError != "" {
		lower := strings.ToLower(networkError)
		if strings.Contains(lower, "cancelled") || strings.Contains(lower, "canceled") {
			return ErrCancelled, stringPtr(networkError)
		}
		return ErrNetwork, stringPtr(networkError)
	}
	var probe map[string]any
	if json.Unmarshal(bytes.TrimSpace(responseBody), &probe) != nil {
		probe = nil
	}
	if probe == nil {
		for _, obj := range JSONObjects(responseBody) {
			if obj["error"] != nil {
				probe = obj
				break
			}
		}
	}
	code := ""
	var message *string
	switch errVal := probe["error"].(type) {
	case map[string]any:
		if c, _ := errVal["code"].(string); c != "" {
			code = strings.ToLower(c)
		} else if t, _ := errVal["type"].(string); t != "" {
			code = strings.ToLower(t)
		}
		if m, _ := errVal["message"].(string); m != "" {
			message = stringPtr(m)
		} else if code != "" {
			message = stringPtr(code)
		}
	case string:
		code = strings.ToLower(errVal)
		message = stringPtr(errVal)
	}
	msgLower := ""
	if message != nil {
		msgLower = strings.ToLower(*message)
	}
	if statusCode < 200 || statusCode >= 300 {
		switch {
		case statusCode == 401 || statusCode == 403:
			if message == nil {
				message = stringPtr("authentication failed")
			}
			return ErrAuth, message
		case statusCode == 404:
			if message == nil {
				message = stringPtr("not found")
			}
			return ErrBadRequest, message
		case statusCode == 408 || statusCode == 409:
			return ErrBadRequest, message
		case statusCode == 429:
			if message == nil {
				message = stringPtr("rate limited")
			}
			return ErrRateLimited, message
		case statusCode == 529:
			if message == nil {
				message = stringPtr("model overloaded")
			}
			return ErrOverloaded, message
		case statusCode >= 500:
			if strings.Contains(code, "overloaded") {
				return ErrOverloaded, message
			}
			if message == nil {
				message = stringPtr("upstream server error")
			}
			return ErrServerError, message
		}
	} else if code == "" {
		return ErrNone, nil
	}
	switch {
	case strings.Contains(code, "context_length") || strings.Contains(code, "context-length") ||
		strings.Contains(code, "max_tokens") || strings.Contains(code, "too_many_tokens") ||
		strings.Contains(msgLower, "context length"):
		return ErrContextLength, message
	case strings.Contains(code, "rate_limit") || strings.Contains(code, "rate-limited") ||
		strings.Contains(code, "429"):
		return ErrRateLimited, message
	case strings.Contains(code, "overloaded") || strings.Contains(code, "529") ||
		strings.Contains(code, "capacity"):
		return ErrOverloaded, message
	case strings.Contains(code, "invalid_api_key") || strings.Contains(code, "authentication") ||
		strings.Contains(code, "unauthorized") || strings.Contains(code, "permission"):
		return ErrAuth, message
	}
	if code == "" {
		if statusCode == 0 {
			return ErrUnknown, nil
		}
		return ErrUnknown, message
	}
	if statusCode >= 400 {
		return ErrBadRequest, message
	}
	return ErrUnknown, message
}

// RequestFingerprint is a stable identity for retry-loop detection: the
// body minus volatile transport fields, hashed. Identical logical requests
// hash identically whether or not they were streamed.
func RequestFingerprint(provider Provider, endpoint Endpoint, model string, body []byte) string {
	var normalized any = map[string]any{}
	if len(body) > 0 {
		var obj map[string]any
		if json.Unmarshal(body, &obj) == nil {
			delete(obj, "stream")
			delete(obj, "stream_options")
			normalized = obj
		}
	}
	envelope := map[string]any{"p": string(provider), "e": string(endpoint), "m": model, "b": normalized}
	data, err := json.Marshal(envelope) // encoding/json sorts map keys
	if err != nil {
		return "unhashable"
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16]
}

// Rollup aggregates traces into window + per-model efficiency stats.
func Rollup(traces []Trace, windowHours int, since time.Time) Stats {
	empty := func() Stats {
		return Stats{WindowHours: windowHours, Since: UnixTime(since), ByModel: []ModelStats{}}
	}
	if len(traces) == 0 {
		return empty()
	}
	var errorCount, inputTotal, outputTotal, cachedTotal, retryCount, toolCallTraces int
	var costTotal float64
	var ttfts []float64
	type group struct {
		provider string
		model    string
		traces   []Trace
	}
	byKey := map[string]*group{}
	order := []string{}
	for _, t := range traces {
		if t.ErrorClass != ErrNone {
			errorCount++
		}
		if t.Usage.InputTokens != nil {
			inputTotal += *t.Usage.InputTokens
		}
		if t.Usage.OutputTokens != nil {
			outputTotal += *t.Usage.OutputTokens
		}
		if t.Usage.CachedTokens != nil {
			cachedTotal += *t.Usage.CachedTokens
		}
		if t.RetrySuspect {
			retryCount++
		}
		if len(t.ToolCalls) > 0 {
			toolCallTraces++
		}
		if t.EstCostUSD != nil {
			costTotal += *t.EstCostUSD
		}
		if t.TTFTMs != nil {
			ttfts = append(ttfts, *t.TTFTMs)
		}
		key := string(t.Provider) + "\x00" + t.Model
		g, ok := byKey[key]
		if !ok {
			g = &group{provider: string(t.Provider), model: t.Model}
			byKey[key] = g
			order = append(order, key)
		}
		g.traces = append(g.traces, t)
	}
	avgTokPerSec := func(list []Trace) *float64 {
		out := 0
		activeMs := 0.0
		for _, t := range list {
			if t.Usage.OutputTokens == nil || *t.Usage.OutputTokens <= 0 {
				continue
			}
			active := t.DurationMs
			if t.TTFTMs != nil {
				active -= *t.TTFTMs
			}
			if active <= 1 {
				continue
			}
			out += *t.Usage.OutputTokens
			activeMs += active
		}
		if out <= 0 || activeMs <= 0 {
			return nil
		}
		return floatPtr(float64(out) / (activeMs / 1000))
	}
	avg := func(vals []float64) *float64 {
		if len(vals) == 0 {
			return nil
		}
		sum := 0.0
		for _, v := range vals {
			sum += v
		}
		return floatPtr(sum / float64(len(vals)))
	}
	hitRate := func(cached, input int) *float64 {
		if input <= 0 {
			return nil
		}
		v := float64(cached) / float64(input)
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return floatPtr(v)
	}
	byModel := []ModelStats{}
	for _, key := range order {
		g := byKey[key]
		list := g.traces
		errs, ins, outs, cached := 0, 0, 0, 0
		var tts []float64
		tools, retries := 0, 0
		cost := 0.0
		for _, t := range list {
			if t.ErrorClass != ErrNone {
				errs++
			}
			if t.Usage.InputTokens != nil {
				ins += *t.Usage.InputTokens
			}
			if t.Usage.OutputTokens != nil {
				outs += *t.Usage.OutputTokens
			}
			if t.Usage.CachedTokens != nil {
				cached += *t.Usage.CachedTokens
			}
			if t.TTFTMs != nil {
				tts = append(tts, *t.TTFTMs)
			}
			if len(t.ToolCalls) > 0 {
				tools++
			}
			if t.RetrySuspect {
				retries++
			}
			if t.EstCostUSD != nil {
				cost += *t.EstCostUSD
			}
		}
		rate := 0.0
		if len(list) > 0 {
			rate = float64(tools) / float64(len(list))
		}
		byModel = append(byModel, ModelStats{
			Provider: g.provider, Model: g.model,
			Requests: len(list), ErrorCount: errs,
			InputTokens: ins, OutputTokens: outs, CachedTokens: cached,
			AvgTTFTMs: avg(tts), AvgTokPerSec: avgTokPerSec(list),
			CacheHitRate: hitRate(cached, ins), ToolCallRate: rate,
			RetrySuspectCount: retries, EstCostUSD: cost,
		})
	}
	sort.SliceStable(byModel, func(a, b int) bool { return byModel[a].Requests > byModel[b].Requests })
	n := float64(len(traces))
	return Stats{
		WindowHours: windowHours, Since: UnixTime(since),
		Requests: len(traces), ErrorCount: errorCount,
		InputTokens: inputTotal, OutputTokens: outputTotal, CachedTokens: cachedTotal,
		RetrySuspectCount: retryCount, ToolCallCount: toolCallTraces,
		EstCostUSD: costTotal,
		ErrorRate:  float64(errorCount) / n, ToolCallRate: float64(toolCallTraces) / n,
		CacheHitRate: hitRate(cachedTotal, inputTotal), AvgTTFTMs: avg(ttfts),
		ByModel: byModel,
	}
}
