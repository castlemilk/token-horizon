package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---- provider inference ----

func TestPrefixedProviders(t *testing.T) {
	cases := []struct {
		path     string
		provider Provider
		endpoint Endpoint
	}{
		{"/th-kimi/v1/messages", ProviderKimi, EndpointMessages},
		{"/th-kimi/v1/chat/completions", ProviderKimi, EndpointChatCompletions},
		{"/th-glm/api/coding/paas/v4/chat/completions", ProviderGLM, EndpointChatCompletions},
		{"/th-glm/api/anthropic/v1/messages", ProviderGLM, EndpointMessages},
		{"/th-minimax/anthropic/v1/messages", ProviderMiniMax, EndpointMessages},
		{"/th-minimax/v1/chat/completions", ProviderMiniMax, EndpointChatCompletions},
		{"/th-deepseek/v1/chat/completions", ProviderDeepSeek, EndpointChatCompletions},
		{"/th-qwen/compatible-mode/v1/chat/completions", ProviderQwen, EndpointChatCompletions},
		{"/th-grok/v1/chat/completions", ProviderGrok, EndpointChatCompletions},
		{"/th-opencode/v1/chat/completions", ProviderOpenCode, EndpointChatCompletions},
		{"/th-gemini/v1beta/models/gemini-2.5-pro:generateContent", ProviderGemini, EndpointGeminiGenerate},
		{"/th-openai/v1/responses", ProviderOpenAI, EndpointResponses},
		{"/th-anthropic/v1/messages", ProviderAnthropic, EndpointMessages},
	}
	for _, c := range cases {
		p, e := InferProvider(c.path, map[string]string{}, nil)
		if p != c.provider || e != c.endpoint {
			t.Fatalf("%s -> %s/%s, want %s/%s", c.path, p, e, c.provider, c.endpoint)
		}
	}
	// Query strings must not break prefix matching.
	p, _ := InferProvider("/th-gemini/v1beta/models/g:streamGenerateContent?alt=sse&key=k", nil, nil)
	if p != ProviderGemini {
		t.Fatalf("query path -> %s", p)
	}
	// Unprefixed gemini native paths infer the provider by shape.
	p, e := InferProvider("/v1beta/models/gemini-2.5-flash:generateContent", nil, nil)
	if p != ProviderGemini || e != EndpointGeminiGenerate {
		t.Fatalf("bare gemini -> %s/%s", p, e)
	}
	// Model-name inference on ambiguous unprefixed /v1/* bodies.
	p, _ = InferProvider("/v1/chat/completions", nil,
		[]byte(`{"model":"kimi-k2-0905-preview","messages":[]}`))
	if p != ProviderKimi {
		t.Fatalf("kimi model body -> %s", p)
	}
	p, _ = InferProvider("/v1/chat/completions", nil,
		[]byte(`{"model":"deepseek-chat","messages":[]}`))
	if p != ProviderDeepSeek {
		t.Fatalf("deepseek model body -> %s", p)
	}
}

func TestUpstreamURLPrefixes(t *testing.T) {
	cfg := Config{
		OpenAIBase: "https://api.openai.com", KimiBase: "https://api.kimi.com/coding",
		GLMBase: "https://api.z.ai", GeminiBase: "https://generativelanguage.googleapis.com",
	}
	u, ok := cfg.UpstreamURL(ProviderKimi, "/th-kimi/v1/messages?x=1")
	if !ok || u.String() != "https://api.kimi.com/coding/v1/messages?x=1" {
		t.Fatalf("kimi upstream = %v", u)
	}
	u, ok = cfg.UpstreamURL(ProviderGLM, "/th-glm/api/coding/paas/v4/chat/completions")
	if !ok || u.String() != "https://api.z.ai/api/coding/paas/v4/chat/completions" {
		t.Fatalf("glm upstream = %v", u)
	}
	u, ok = cfg.UpstreamURL(ProviderGemini, "/th-gemini/v1beta/models/m:generateContent")
	if !ok || u.String() != "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent" {
		t.Fatalf("gemini upstream = %v", u)
	}
}

// ---- client + session capture ----

func TestDetectClient(t *testing.T) {
	cases := map[string]string{
		"claude-cli/2.0.30 (external, cli)": "claude-code",
		"codex_cli_rs/0.42.0":               "codex",
		"kimi-cli/0.5":                      "kimi-cli",
		"opencode/0.15":                     "opencode",
		"GeminiCLI/0.9.0":                   "gemini-cli",
		"python-httpx/0.28":                 "python",
		"curl/8.7":                          "curl",
		"Mozilla/5.0":                       "",
	}
	for ua, want := range cases {
		got := detectClient(map[string]string{"user-agent": ua})
		if got != want {
			t.Fatalf("ua %q -> %q, want %q", ua, got, want)
		}
	}
	if got := detectClient(map[string]string{"originator": "codex_cli_rs"}); got != "codex" {
		t.Fatalf("originator -> %q", got)
	}
}

// ---- gemini usage extraction ----

func TestGeminiUsage(t *testing.T) {
	body := `{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],
		"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":9,"cachedContentTokenCount":10,"thoughtsTokenCount":2,"totalTokenCount":51}}`
	u := ExtractUsage(ProviderGemini, EndpointGeminiGenerate, []byte(body))
	if u.Source != TokenReported || *u.InputTokens != 42 || *u.OutputTokens != 9 ||
		*u.CachedTokens != 10 || *u.ReasoningTokens != 2 || *u.TotalTokens != 51 {
		t.Fatalf("%+v", u)
	}
	calls, reasons := ExtractToolCalls(ProviderGemini, EndpointGeminiGenerate, []byte(body))
	if len(reasons) != 1 || reasons[0] != "STOP" {
		t.Fatalf("reasons=%v", reasons)
	}
	if len(calls) != 0 {
		t.Fatalf("calls=%v", calls)
	}
	// Streamed: usage rides the final SSE chunk; functionCall parts traced.
	sse := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"id\":\"c1\"}}]}}]}\n\n" +
		"data: {\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":3,\"totalTokenCount\":8}}\n\n"
	u = ExtractUsage(ProviderGemini, EndpointGeminiGenerate, []byte(sse))
	if *u.InputTokens != 5 || *u.OutputTokens != 3 {
		t.Fatalf("streamed %+v", u)
	}
	calls, _ = ExtractToolCalls(ProviderGemini, EndpointGeminiGenerate, []byte(sse))
	if len(calls) != 1 || calls[0].Name != "read_file" {
		t.Fatalf("calls=%v", calls)
	}
}

// ---- end-to-end: prefixed provider through the proxy ----

func TestPrefixedProxyRoundTrip(t *testing.T) {
	sse := "data: {\"model\":\"kimi-k2\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"model\":\"kimi-k2\",\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4,\"total_tokens\":15}}\n\ndata: [DONE]\n"
	api, proxy, store, _ := testSetup(t, stubSSE(t, sse))
	srv := httptest.NewServer(serveMux(api, proxy))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/th-kimi/v1/chat/completions",
		strings.NewReader(`{"model":"kimi-k2","messages":[],"stream":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kimi-cli/0.5")
	req.Header.Set("Session_Id", "sess-abc") // codex-style underscore header
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()

	deadline := time.Now().Add(5 * time.Second)
	var trace Trace
	for time.Now().Before(deadline) {
		recent := store.Recent(5, TraceFilter{})
		if len(recent) > 0 {
			trace, _ = store.Get(recent[0].ID)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if trace.Provider != ProviderKimi || trace.Endpoint != EndpointChatCompletions {
		t.Fatalf("%+v", trace)
	}
	if trace.Client != "kimi-cli" || trace.SessionKey == nil || *trace.SessionKey != "sess-abc" {
		t.Fatalf("attribution %+v", trace)
	}
	if trace.Source != "proxy" {
		t.Fatalf("source=%q", trace.Source)
	}
	if *trace.Usage.InputTokens != 11 || *trace.Usage.OutputTokens != 4 {
		t.Fatalf("%+v", trace.Usage)
	}
}

// ---- sessions + stats aggregation ----

func mkTrace(id, provider, client, session string, errClass ErrorClass, in, out int, durMs float64, at time.Time) Trace {
	sk := &session
	if session == "" {
		sk = nil
	}
	return Trace{
		ID: id, Provider: Provider(provider), Endpoint: EndpointChatCompletions,
		Model: "m", StartedAt: UnixTime(at), DurationMs: durMs, StatusCode: 200,
		Usage:      Usage{Source: TokenReported, InputTokens: intPtr(in), OutputTokens: intPtr(out)},
		ErrorClass: errClass, SessionKey: sk, Client: client, Source: "proxy",
		ToolCalls: []ToolCall{}, FinishReasons: []string{}, RequestHash: id,
	}
}

func TestSessionsAndStatsAggregation(t *testing.T) {
	_, _, store, _ := testSetup(t, nil)
	now := time.Now()
	store.Record(mkTrace("a", "openai", "codex", "s1", ErrNone, 10, 5, 100, now.Add(-3*time.Minute)))
	store.Record(mkTrace("b", "kimi", "kimi-cli", "s1", ErrRateLimited, 20, 8, 200, now.Add(-2*time.Minute)))
	store.Record(mkTrace("c", "openai", "codex", "s2", ErrNone, 30, 10, 300, now.Add(-time.Minute)))
	store.Record(mkTrace("d", "openai", "", "", ErrNone, 5, 2, 50, now)) // no session

	sessions := store.Sessions(24, 50)
	if len(sessions) != 2 {
		t.Fatalf("sessions=%d %+v", len(sessions), sessions)
	}
	if sessions[0].SessionKey != "s2" || sessions[0].Requests != 1 {
		t.Fatalf("newest first: %+v", sessions[0])
	}
	s1 := sessions[1]
	if s1.SessionKey != "s1" || s1.Requests != 2 || s1.ErrorCount != 1 {
		t.Fatalf("%+v", s1)
	}
	if s1.InputTokens != 30 || s1.OutputTokens != 13 || s1.SpanMs <= 0 {
		t.Fatalf("%+v", s1)
	}
	if len(s1.Providers) != 2 || len(s1.Clients) != 2 {
		t.Fatalf("sets %+v", s1)
	}

	stats := store.Stats("", "", 24)
	if stats.Requests != 4 || stats.ErrorCount != 1 {
		t.Fatalf("%+v", stats)
	}
	if len(stats.ByProvider) != 2 || stats.ByProvider[0].Provider != "openai" || stats.ByProvider[0].Requests != 3 {
		t.Fatalf("byProvider %+v", stats.ByProvider)
	}
	if len(stats.ByClient) != 2 {
		t.Fatalf("byClient %+v", stats.ByClient)
	}
	if len(stats.ByError) != 1 || stats.ByError[0].Class != string(ErrRateLimited) {
		t.Fatalf("byError %+v", stats.ByError)
	}
	if stats.P50DurationMs == nil || stats.P95DurationMs == nil {
		t.Fatal("percentiles must be populated")
	}
	if *stats.P50DurationMs <= 0 || *stats.P95DurationMs < *stats.P50DurationMs {
		t.Fatalf("p50=%v p95=%v", *stats.P50DurationMs, *stats.P95DurationMs)
	}
}

func TestTraceFilters(t *testing.T) {
	_, _, store, _ := testSetup(t, nil)
	now := time.Now()
	store.Record(mkTrace("a", "openai", "codex", "s1", ErrNone, 1, 1, 10, now))
	store.Record(mkTrace("b", "kimi", "kimi-cli", "s1", ErrAuth, 1, 1, 10, now))
	store.Record(mkTrace("c", "openai", "codex", "s2", ErrNone, 1, 1, 10, now))

	if got := store.Recent(50, TraceFilter{Session: "s1"}); len(got) != 2 {
		t.Fatalf("session filter=%d", len(got))
	}
	if got := store.Recent(50, TraceFilter{Client: "codex"}); len(got) != 2 {
		t.Fatalf("client filter=%d", len(got))
	}
	if got := store.Recent(50, TraceFilter{ErrorsOnly: true}); len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("errors filter=%v", got)
	}
	if got := store.Recent(50, TraceFilter{Provider: ProviderKimi}); len(got) != 1 {
		t.Fatalf("provider filter=%d", len(got))
	}
}

// ---- provider request id + API surface ----

func TestProviderRequestIDAndSessionsEndpoint(t *testing.T) {
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", "req_upstream_99")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"model":"m","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
	})
	api, proxy, store, _ := testSetup(t, stub)
	srv := httptest.NewServer(serveMux(api, proxy))
	defer srv.Close()

	http.Post(srv.URL+"/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m","messages":[]}`))

	deadline := time.Now().Add(5 * time.Second)
	var trace Trace
	for time.Now().Before(deadline) {
		if r := store.Recent(1, TraceFilter{}); len(r) > 0 {
			trace, _ = store.Get(r[0].ID)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if trace.ProviderRequestID == nil || *trace.ProviderRequestID != "req_upstream_99" {
		t.Fatalf("providerRequestId %+v", trace.ProviderRequestID)
	}

	res, err := http.Get(srv.URL + "/traces/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("sessions=%d", res.StatusCode)
	}
	var obj map[string]any
	json.NewDecoder(res.Body).Decode(&obj)
	if obj["sessions"] == nil {
		t.Fatal("sessions payload missing")
	}
	res2, _ := http.Get(srv.URL + "/traces?errors=1")
	body, _ := io.ReadAll(res2.Body)
	res2.Body.Close()
	if res2.StatusCode != 200 || !strings.Contains(string(body), `"count"`) {
		t.Fatalf("errors filter %d %s", res2.StatusCode, body)
	}
	res3, _ := http.Get(srv.URL + "/proxy/config")
	cfgBody, _ := io.ReadAll(res3.Body)
	res3.Body.Close()
	if !strings.Contains(string(cfgBody), "upstreams") || !strings.Contains(string(cfgBody), "providers") {
		t.Fatalf("config %s", cfgBody)
	}
}
