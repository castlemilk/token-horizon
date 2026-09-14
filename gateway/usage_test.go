package main

import (
	"strings"
	"testing"
	"time"
)

func testTime() time.Time { return time.Unix(1_786_000_000, 0).UTC() }

func TestInferProvider(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		headers  map[string]string
		body     string
		provider Provider
		endpoint Endpoint
	}{
		{"chat completions", "/v1/chat/completions",
			map[string]string{"authorization": "Bearer sk-x"}, `{"model":"gpt-5-mini"}`,
			ProviderOpenAI, EndpointChatCompletions},
		{"responses with query", "/v1/responses?store=true",
			map[string]string{"authorization": "Bearer sk-x"}, `{"model":"gpt-5"}`,
			ProviderOpenAI, EndpointResponses},
		{"anthropic messages", "/v1/messages",
			map[string]string{"x-api-key": "sk-ant-x", "anthropic-version": "2023-06-01"}, `{}`,
			ProviderAnthropic, EndpointMessages},
		{"models via x-api-key", "/v1/models",
			map[string]string{"x-api-key": "sk-ant-x"}, ``,
			ProviderAnthropic, EndpointModels},
		{"models via bearer", "/v1/models",
			map[string]string{"authorization": "Bearer sk-x"}, ``,
			ProviderOpenAI, EndpointModels},
		{"models via sk-ant bearer", "/v1/models",
			map[string]string{"authorization": "Bearer sk-ant-x"}, ``,
			ProviderAnthropic, EndpointModels},
		{"ollama chat", "/api/chat", nil, ``, ProviderOllama, EndpointOllamaChat},
		{"ollama generate", "/api/generate", nil, ``, ProviderOllama, EndpointOllamaGenerate},
		{"ollama other", "/api/tags", nil, ``, ProviderOllama, EndpointOther},
		{"explicit anthropic prefix", "/th-anthropic/v1/messages", nil, ``,
			ProviderAnthropic, EndpointMessages},
		{"explicit openai prefix", "/th-openai/v1/chat/completions", nil, ``,
			ProviderOpenAI, EndpointChatCompletions},
		{"body fallback claude", "/v1/foo", nil, `{"model":"claude-x"}`,
			ProviderAnthropic, EndpointOther},
		{"body fallback gpt", "/v1/foo", nil, `{"model":"gpt-x"}`,
			ProviderOpenAI, EndpointOther},
		{"body fallback input", "/v1/foo", nil, `{"model":"gpt-x","input":"hi"}`,
			ProviderOpenAI, EndpointResponses},
		{"embeddings", "/v1/embeddings", map[string]string{"authorization": "Bearer sk-x"}, `{}`,
			ProviderOpenAI, EndpointEmbeddings},
		{"unknown", "/weird", nil, ``, ProviderUnknown, EndpointOther},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, e := InferProvider(c.path, c.headers, []byte(c.body))
			if p != c.provider || e != c.endpoint {
				t.Fatalf("got (%s,%s) want (%s,%s)", p, e, c.provider, c.endpoint)
			}
		})
	}
}

func TestStripPrefix(t *testing.T) {
	if got := StripPrefix("/th-openai/v1/models", "/th-openai"); got != "/v1/models" {
		t.Fatal(got)
	}
	if got := StripPrefix("/th-openai", "/th-openai"); got != "/" {
		t.Fatal(got)
	}
	if got := StripPrefix("/v1/models", "/th-openai"); got != "/v1/models" {
		t.Fatal(got)
	}
}

func TestRequestInfo(t *testing.T) {
	info := ParseRequestInfo(ProviderOpenAI,
		[]byte(`{"model":"gpt-5","stream":true,"previous_response_id":"resp_9"}`))
	if info.Model != "gpt-5" || !info.Stream || info.SessionKey != "resp_9" {
		t.Fatalf("%+v", info)
	}
	info = ParseRequestInfo(ProviderAnthropic,
		[]byte(`{"model":"claude-x","metadata":{"user_id":"sess-1"}}`))
	if info.SessionKey != "sess-1" || info.Stream {
		t.Fatalf("%+v", info)
	}
	info = ParseRequestInfo(ProviderOpenAI, nil)
	if info.Model != "" || info.Stream || info.SessionKey != "" {
		t.Fatalf("%+v", info)
	}
}

func TestChatUsageSSE(t *testing.T) {
	sse := "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"delta\":{}}]}\n\n" +
		"data: {\"model\":\"gpt-5-mini\",\"choices\":[],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":12,\"total_tokens\":42,\"prompt_tokens_details\":{\"cached_tokens\":20},\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n\n" +
		"data: [DONE]\n"
	u := ExtractUsage(ProviderOpenAI, EndpointChatCompletions, []byte(sse))
	if u.Source != TokenReported || *u.InputTokens != 30 || *u.OutputTokens != 12 ||
		*u.TotalTokens != 42 || *u.CachedTokens != 20 || *u.ReasoningTokens != 5 {
		t.Fatalf("%+v", u)
	}
}

func TestChatUsageAbsentWithoutIncludeUsage(t *testing.T) {
	sse := "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"delta\":{\"content\":\"Hello world\"}}]}\n\ndata: [DONE]\n"
	u := ExtractUsage(ProviderOpenAI, EndpointChatCompletions, []byte(sse))
	if u.Source != TokenAbsent || u.InputTokens != nil || u.OutputTokens != nil {
		t.Fatalf("%+v", u)
	}
}

func TestResponsesUsage(t *testing.T) {
	body := `{"id":"resp_1","model":"gpt-5","status":"completed",
		"output":[{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{}"}],
		"usage":{"input_tokens":200,"output_tokens":40,"total_tokens":240,
		"input_tokens_details":{"cached_tokens":150},
		"output_tokens_details":{"reasoning_tokens":30}}}`
	u := ExtractUsage(ProviderOpenAI, EndpointResponses, []byte(body))
	if *u.InputTokens != 200 || *u.OutputTokens != 40 || *u.CachedTokens != 150 || *u.ReasoningTokens != 30 {
		t.Fatalf("%+v", u)
	}
	calls, reasons := ExtractToolCalls(ProviderOpenAI, EndpointResponses, []byte(body))
	if len(calls) != 1 || calls[0].Name != "get_weather" || *calls[0].CallID != "call_1" {
		t.Fatalf("%+v", calls)
	}
	if len(reasons) != 1 || reasons[0] != "completed" {
		t.Fatalf("%v", reasons)
	}
}

func TestAnthropicUsageSSE(t *testing.T) {
	sse := "event: message_start\n" +
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":120,\"cache_read_input_tokens\":100,\"output_tokens\":0}}}\n\n" +
		"event: message_delta\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":25}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n"
	u := ExtractUsage(ProviderAnthropic, EndpointMessages, []byte(sse))
	if u.Source != TokenAccumulated || *u.InputTokens != 120 || *u.OutputTokens != 25 ||
		*u.TotalTokens != 145 || *u.CachedTokens != 100 {
		t.Fatalf("%+v", u)
	}
}

func TestToolCalls(t *testing.T) {
	chat := `{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[
		{"id":"call_a","function":{"name":"Read"}},
		{"id":"call_b","function":{"name":"Bash"}}]}}]}`
	calls, reasons := ExtractToolCalls(ProviderOpenAI, EndpointChatCompletions, []byte(chat))
	if len(calls) != 2 || len(reasons) != 1 || reasons[0] != "tool_calls" {
		t.Fatalf("%+v %+v", calls, reasons)
	}
	anthropic := `{"stop_reason":"tool_use","content":[
		{"type":"text"},{"type":"tool_use","id":"toolu_1","name":"Read"}]}`
	calls, reasons = ExtractToolCalls(ProviderAnthropic, EndpointMessages, []byte(anthropic))
	if len(calls) != 1 || calls[0].Name != "Read" || *calls[0].CallID != "toolu_1" {
		t.Fatalf("%+v", calls)
	}
	dup := "data: {\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"Bash\"}}\n\n" +
		"data: {\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"Bash\"}}\n"
	calls, _ = ExtractToolCalls(ProviderAnthropic, EndpointMessages, []byte(dup))
	if len(calls) != 1 {
		t.Fatalf("%+v", calls)
	}
}

func TestClassifyError(t *testing.T) {
	cases := []struct {
		status int
		body   string
		netErr string
		want   ErrorClass
	}{
		{401, `{"error":{"code":"invalid_api_key","message":"bad"}}`, "", ErrAuth},
		{429, `{}`, "", ErrRateLimited},
		{529, `{"error":{"type":"overloaded_error"}}`, "", ErrOverloaded},
		{400, `{"error":{"code":"context_length_exceeded"}}`, "", ErrContextLength},
		{200, `{"status":"completed"}`, "", ErrNone},
		{200, `{"error":{"code":"context_length_exceeded"}}`, "", ErrContextLength},
		{0, ``, "cancelled by client", ErrCancelled},
		{0, ``, "connection reset", ErrNetwork},
	}
	for _, c := range cases {
		got, _ := ClassifyError(c.status, []byte(c.body), c.netErr)
		if got != c.want {
			t.Fatalf("status=%d body=%s net=%q: got %s want %s", c.status, c.body, c.netErr, got, c.want)
		}
	}
}

func TestFingerprint(t *testing.T) {
	a := []byte(`{"model":"gpt-5","messages":[{"content":"hi"}],"stream":true}`)
	b := []byte(`{"model":"gpt-5","messages":[{"content":"hi"}],"stream":false}`)
	c := []byte(`{"model":"gpt-5","messages":[{"content":"bye"}]}`)
	fa := RequestFingerprint(ProviderOpenAI, EndpointChatCompletions, "gpt-5", a)
	fb := RequestFingerprint(ProviderOpenAI, EndpointChatCompletions, "gpt-5", b)
	fc := RequestFingerprint(ProviderOpenAI, EndpointChatCompletions, "gpt-5", c)
	if fa != fb {
		t.Fatal("stream flag should not affect fingerprint")
	}
	if fa == fc {
		t.Fatal("different content must differ")
	}
	if len(fa) != 16 || strings.Trim(fa, "0123456789abcdef") != "" {
		t.Fatalf("bad fingerprint %q", fa)
	}
}

func TestTraceDerivedMath(t *testing.T) {
	tr := Trace{DurationMs: 2500, TTFTMs: floatPtr(500),
		Usage: Usage{InputTokens: intPtr(200), OutputTokens: intPtr(100), Source: TokenReported}}
	if got := *tr.TokPerSec(); got != 50 {
		t.Fatalf("tok/s=%v", got)
	}
	tr.Usage.CachedTokens = intPtr(150)
	if got := *tr.CacheHitRate(); got != 0.75 {
		t.Fatalf("hit=%v", got)
	}
	if (Trace{}).TokPerSec() != nil {
		t.Fatal("empty trace must have nil tok/s")
	}
	s := tr.Summary()
	_ = s
}

func TestRollup(t *testing.T) {
	now := UnixTime(testTime())
	mk := func(p Provider, model string, in, out, cached *int, ttft *float64, dur float64, tools int, err ErrorClass, retry bool) Trace {
		total := 0
		if in != nil {
			total += *in
		}
		if out != nil {
			total += *out
		}
		tr := Trace{Provider: p, Endpoint: EndpointChatCompletions, Model: model,
			StartedAt: now, TTFTMs: ttft, DurationMs: dur, StatusCode: 200,
			ErrorClass: err, RetrySuspect: retry,
			Usage: Usage{InputTokens: in, OutputTokens: out, TotalTokens: intPtr(total), CachedTokens: cached, Source: TokenReported}}
		for i := 0; i < tools; i++ {
			tr.ToolCalls = append(tr.ToolCalls, ToolCall{Name: "Tool", CallID: stringPtr("c")})
		}
		return tr
	}
	traces := []Trace{
		mk(ProviderOpenAI, "gpt-5", intPtr(100), intPtr(50), intPtr(40), floatPtr(200), 1200, 2, ErrNone, false),
		mk(ProviderOpenAI, "gpt-5", nil, nil, nil, nil, 50, 0, ErrRateLimited, true),
		mk(ProviderAnthropic, "claude-x", intPtr(300), intPtr(60), intPtr(300), floatPtr(400), 1600, 0, ErrNone, false),
	}
	st := Rollup(traces, 24, testTime().Add(-24*time.Hour))
	if st.Requests != 3 || st.ErrorCount != 1 || st.InputTokens != 400 || st.OutputTokens != 110 ||
		st.CachedTokens != 340 || st.ToolCallCount != 1 || st.RetrySuspectCount != 1 {
		t.Fatalf("%+v", st)
	}
	if *st.CacheHitRate != 0.85 || *st.AvgTTFTMs != 300 || len(st.ByModel) != 2 {
		t.Fatalf("%+v", st)
	}
	if got := st.ErrorRate; got < 0.333 || got > 0.334 {
		t.Fatalf("errorRate=%v", got)
	}
	if empty := Rollup(nil, 24, testTime()); empty.Requests != 0 || empty.ByModel == nil {
		t.Fatalf("%+v", empty)
	}
}
