package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func testSetup(t *testing.T, upstream http.Handler) (*API, *ProxyHandler, *Store, *Metrics) {
	t.Helper()
	cfg := Config{
		Port: 11436, OpenAIBase: "http://unused", AnthropicBase: "http://unused",
		OllamaBase: "http://unused", TraceDir: t.TempDir(), IngestURL: "",
	}
	if upstream != nil {
		srv := httptest.NewServer(upstream)
		t.Cleanup(srv.Close)
		cfg.OpenAIBase = srv.URL
		cfg.AnthropicBase = srv.URL
		cfg.OllamaBase = srv.URL
		cfg.KimiBase = srv.URL
		cfg.GLMBase = srv.URL
		cfg.MiniMaxBase = srv.URL
		cfg.DeepSeekBase = srv.URL
		cfg.QwenBase = srv.URL
		cfg.GrokBase = srv.URL
		cfg.GeminiBase = srv.URL
		cfg.OpenCodeBase = srv.URL
	}
	store := NewStore(cfg.TraceDir)
	metrics := NewMetrics()
	proxy := NewProxyHandler(cfg, store, metrics)
	api := &API{cfg: cfg, store: store, metrics: metrics}
	proxy.info = api.handleInfo
	return api, proxy, store, metrics
}

func serveMux(api *API, proxy *ProxyHandler) http.Handler {
	mux := http.NewServeMux()
	api.routes(mux)
	mux.Handle("/", proxy)
	return mux
}

// stubSSE plays a cloud provider: split SSE writes with a delay to exercise
// streaming + TTFT, close-delimited like real SSE endpoints.
func stubSSE(t *testing.T, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Ratelimit-Remaining", "99")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		mid := len(body) / 2
		w.Write([]byte(body[:mid]))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(50 * time.Millisecond)
		w.Write([]byte(body[mid:]))
	})
}

func TestRoundTripOpenAIChat(t *testing.T) {
	sse := "data: {\"id\":\"chatcmpl-t\",\"model\":\"test-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n" +
		"data: {\"id\":\"chatcmpl-t\",\"model\":\"test-model\",\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":13,\"total_tokens\":20}}\n\n" +
		"data: [DONE]\n"
	api, proxy, store, _ := testSetup(t, stubSSE(t, sse))
	srv := httptest.NewServer(serveMux(api, proxy))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"test-model","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-key")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	if string(body) != sse {
		t.Fatalf("body not relayed unchanged:\n%q", body)
	}
	traceID := res.Header.Get("X-Token-Horizon-Trace-Id")
	if traceID == "" {
		t.Fatal("missing trace id header")
	}
	if res.Header.Get("X-Ratelimit-Remaining") != "99" {
		t.Fatal("rate-limit header not relayed")
	}
	if res.Header.Get("Authorization") != "" || res.Header.Get("Set-Cookie") != "" {
		t.Fatal("sensitive headers must not flow downstream")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(store.Recent(5, TraceFilter{})) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no trace recorded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	trace, ok := store.Get(traceID)
	if !ok {
		t.Fatal("trace id not found in store")
	}
	if trace.Provider != ProviderOpenAI || trace.Endpoint != EndpointChatCompletions || trace.Model != "test-model" {
		t.Fatalf("%+v", trace)
	}
	if *trace.Usage.InputTokens != 7 || *trace.Usage.OutputTokens != 13 {
		t.Fatalf("%+v", trace.Usage)
	}
	if trace.TTFTMs == nil || trace.RetrySuspect {
		t.Fatalf("%+v", trace)
	}
}

func TestUnknownPathRejected(t *testing.T) {
	api, proxy, store, _ := testSetup(t, nil)
	srv := httptest.NewServer(serveMux(api, proxy))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/nope")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d", res.StatusCode)
	}
	if len(store.Recent(5, TraceFilter{})) != 0 {
		t.Fatal("rejected request must not record a trace")
	}
}

func TestReadAPIAndMetrics(t *testing.T) {
	sse := "data: {\"model\":\"m\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n"
	api, proxy, store, _ := testSetup(t, stubSSE(t, sse))
	srv := httptest.NewServer(serveMux(api, proxy))
	defer srv.Close()

	http.Post(srv.URL+"/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m","messages":[]}`))

	get := func(path string) (int, []byte) {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, body
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(store.Recent(5, TraceFilter{})) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	if code, body := get("/traces"); code != 200 {
		t.Fatalf("/traces=%d", code)
	} else {
		var obj map[string]any
		json.Unmarshal(body, &obj)
		if obj["count"].(float64) != 1 {
			t.Fatalf("%s", body)
		}
		list := obj["traces"].([]any)
		if _, hasBody := list[0].(map[string]any)["requestBody"]; hasBody {
			t.Fatal("list must omit bodies")
		}
	}
	id := store.Recent(1, TraceFilter{})[0].ID
	if code, body := get("/traces/" + id); code != 200 {
		t.Fatalf("detail=%d", code)
	} else {
		var obj map[string]any
		json.Unmarshal(body, &obj)
		if obj["requestBody"] == nil {
			t.Fatal("detail must include bodies")
		}
	}
	if code, _ := get("/traces/nope"); code != 404 {
		t.Fatalf("missing=%d", code)
	}
	if code, body := get("/proxy/stats?hours=24"); code != 200 {
		t.Fatalf("stats=%d", code)
	} else {
		var obj map[string]any
		json.Unmarshal(body, &obj)
		if obj["requests"].(float64) != 1 || obj["inputTokens"].(float64) != 10 {
			t.Fatalf("%s", body)
		}
	}
	if code, body := get("/proxy/config"); code != 200 {
		t.Fatalf("config=%d", code)
	} else {
		var obj map[string]any
		json.Unmarshal(body, &obj)
		if obj["openai_upstream"] == nil || obj["gateway_port"] == nil {
			t.Fatalf("%s", body)
		}
	}
	if code, body := get("/metrics"); code != 200 {
		t.Fatalf("metrics=%d", code)
	} else if !strings.Contains(string(body), "token_horizon_gateway_requests_total") {
		t.Fatalf("missing request counter:\n%s", body)
	}
	if code, _ := get("/__token_horizon"); code != 200 {
		t.Fatalf("info=%d", code)
	}
}

func TestStoreBoundsAndRetry(t *testing.T) {
	_, _, store, _ := testSetup(t, nil)
	store.diskEnabled = true // exercise JSONL against the temp dir
	mk := func(hash string) Trace {
		return Trace{ID: traceIDGenerator(), Provider: ProviderOpenAI,
			Endpoint: EndpointChatCompletions, Model: "m", StartedAt: UnixTime(time.Now()),
			DurationMs: 10, StatusCode: 200, RequestHash: hash,
			ToolCalls: []ToolCall{}, FinishReasons: []string{},
			Usage: Usage{Source: TokenAbsent}}
	}
	first := store.Record(mk("same"))
	if first.RetrySuspect {
		t.Fatal("first occurrence must not be a retry suspect")
	}
	second := store.Record(mk("same"))
	if !second.RetrySuspect {
		t.Fatal("repeat must be flagged")
	}
	for i := 0; i < MemoryCap+50; i++ {
		tr := mk("h")
		tr.ID = traceIDGenerator() + string(rune('a'+i%26)) + string(rune('0'+i%10))
		tr.RequestHash = "unique-" + tr.ID
		store.Record(tr)
	}
	if mem, _, _ := store.Counts(); mem != MemoryCap {
		t.Fatalf("memory=%d", mem)
	}
	if _, _, bytes := store.Counts(); bytes <= 0 {
		t.Fatal("expected JSONL bytes on disk")
	}
	if got := store.Recent(1000, TraceFilter{}); len(got) != 100 {
		t.Fatalf("recent clamp=%d", len(got))
	}
	if stats := store.Stats("", "", 24); stats.Requests != MemoryCap {
		t.Fatalf("stats=%d", stats.Requests)
	}
	if _, files := store.Clear(); files < 1 {
		t.Fatal("expected day files cleared")
	}
	if len(store.Recent(5, TraceFilter{})) != 0 {
		t.Fatal("clear must drop memory")
	}
}

func TestCapBody(t *testing.T) {
	if s, trunc := CapBody("hi"); s != "hi" || trunc {
		t.Fail()
	}
	big := strings.Repeat("é", BodyCapBytes) // multibyte: cut must stay valid UTF-8
	capped, trunc := CapBody(big + "tail")
	if !trunc || len(capped) > BodyCapBytes {
		t.Fatal("not capped")
	}
	if !utf8.ValidString(capped) {
		t.Fatal("cut mid-rune")
	}
	if !strings.HasPrefix(big, capped) {
		t.Fatal("must be a prefix")
	}
}
