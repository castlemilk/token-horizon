package meter

// Wire-format fidelity tests, ported from the Swift meter behaviors:
// byte-identical relay, NET token semantics (input excl. cache, output excl.
// reasoning), already-net guards, per-format occupancy, thinking
// normalization, request-id extraction, wire rate-limit snapshots, exact
// Ollama ns rates, and the consent/methodology start gates.

import (
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testEnv(t *testing.T) *store.Store {
	t.Helper()
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	t.Setenv("TH_CONSENT", "metering")
	st, err := store.OpenStore(t.TempDir() + "/usage.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// startMeter runs a meter against the stub upstream and returns its base URL.
func startMeter(t *testing.T, st *store.Store, vendor string, format Format, upstream http.Handler) string {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	m := &Meter{
		Vendor: vendor, TargetBase: up.URL, Source: "external",
		Store: st, Format: format,
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	return "http://127.0.0.1:" + itoaPort(m.ListenPort)
}

func itoaPort(p int) string { return strconv.Itoa(p) }

// waitEvent polls until one event lands (finalize runs on a goroutine).
func waitEvent(t *testing.T, st *store.Store) usage.Event {
	t.Helper()
	for range 100 {
		events, _, err := st.EventsPage(store.Filter{}, 0, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) > 0 {
			return events[0]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no event stored after 1s")
	return usage.Event{}
}

const chatSSE = `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hel"}}]}

data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"lo"}}]}

data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens_details":{"reasoning_tokens":50}}}

data: [DONE]

`

func TestOpenAISSE_RelayByteIdenticalAndNetSemantics(t *testing.T) {
	st := testEnv(t)
	base := startMeter(t, st, "deepseek", openAIFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-ratelimit-limit-requests", "500")
		w.Header().Set("x-ratelimit-remaining-requests", "498")
		w.Header().Set("x-ratelimit-reset-requests", "1m30s")
		w.WriteHeader(200)
		// split writes exercise the streaming tee
		for _, chunk := range []string{chatSSE[:120], chatSSE[120:]} {
			w.Write([]byte(chunk))
			w.(http.Flusher).Flush()
		}
	}))
	req, _ := http.NewRequest("POST", base+"/v1/chat/completions",
		strings.NewReader(`{"model":"deepseek-v4","stream":true,"reasoning_effort":"high"}`))
	req.Header.Set("User-Agent", "pi-coding-agent/1.0")
	req.Header.Set("Authorization", "Bearer sk-test-credential")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != chatSSE {
		t.Fatalf("relay must be byte-identical:\n%q", got)
	}

	e := waitEvent(t, st)
	// NET: input 1000-400=600, output 200-50=150, reasoning 50, cache 400.
	if e.Tokens.Input != 600 || e.Tokens.Output != 150 || e.Tokens.Reasoning != 50 || e.Tokens.CacheRead != 400 {
		t.Fatalf("net breakdown wrong: %+v", e.Tokens)
	}
	if e.Vendor != "deepseek" || e.Model != "deepseek-v4" {
		t.Fatalf("identity: %s/%s", e.Vendor, e.Model)
	}
	if e.ContextOccupancy == nil || *e.ContextOccupancy != 1000 {
		t.Fatalf("OpenAI occupancy = net input + cacheRead = 1000: %v", e.ContextOccupancy)
	}
	if e.Product == nil || *e.Product != "pi" || e.ProductSource == nil || *e.ProductSource != "headerSniffed" {
		t.Fatalf("UA sniff: %v/%v", e.Product, e.ProductSource)
	}
	if e.ThinkingLevel == nil || *e.ThinkingLevel != "high" || *e.ThinkingRaw != "reasoning_effort:high" {
		t.Fatalf("thinking: %v", e.ThinkingLevel)
	}
	if e.RequestID == nil || *e.RequestID != "chatcmpl-1" {
		t.Fatalf("request id from SSE chunk: %v", e.RequestID)
	}
	if e.AccountID == nil || !strings.HasPrefix(*e.AccountID, "deepseek:") {
		t.Fatalf("account key: %v", e.AccountID)
	}
	if e.Attestation != "measured" || e.CostSource == nil || *e.CostSource != "unknown" {
		t.Fatalf("attestation/cost: %s/%v", e.Attestation, e.CostSource)
	}
	// Wire limits recorded even though cost isn't catalog-computed yet.
	for range 100 {
		snaps, _ := st.LimitHistory(0, time.Now().Unix()+1, 10)
		if len(snaps) > 0 {
			sn := snaps[0]
			if sn.Label != "requests (wire)" || sn.UsedPercent < 0.3 || sn.UsedPercent > 0.5 {
				t.Fatalf("wire limit: %+v", sn)
			}
			if sn.ResetsAt == nil {
				t.Fatal("reset duration must land as an absolute epoch")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("wire limit snapshot not recorded")
}

func TestOpenAIResponsesAPI_DualSpellingMaxNeverSum(t *testing.T) {
	st := testEnv(t)
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_9\",\"usage\":{\"input_tokens\":500,\"output_tokens\":120,\"input_tokens_details\":{\"cached_tokens\":100},\"output_tokens_details\":{\"reasoning_tokens\":20}}}}\n\ndata: [DONE]\n\n"
	base := startMeter(t, st, "codex", openAIFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(sse))
	}))
	resp, _ := http.Post(base+"/v1/responses", "application/json",
		strings.NewReader(`{"model":"gpt-5.2-codex","reasoning":{"effort":"medium"}}`))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if e.Tokens.Input != 400 || e.Tokens.Output != 100 || e.Tokens.Reasoning != 20 || e.Tokens.CacheRead != 100 {
		t.Fatalf("responses-api net breakdown: %+v", e.Tokens)
	}
	if e.RequestID == nil || *e.RequestID != "resp_9" {
		t.Fatalf("responses wrapper id: %v", e.RequestID)
	}
	if e.ThinkingLevel == nil || *e.ThinkingLevel != "medium" {
		t.Fatalf("reasoning.effort: %v", e.ThinkingLevel)
	}
}

func TestOpenAI_AlreadyNetPayloadNotDoubleSubtracted(t *testing.T) {
	st := testEnv(t)
	// Zen-style payload: cached > gross means counters were already net.
	body := `{"id":"x","usage":{"prompt_tokens":50,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":300},"completion_tokens_details":{"reasoning_tokens":10}}}`
	base := startMeter(t, st, "opencode", openAIFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(body))
	}))
	resp, _ := http.Post(base+"/zen/v1/chat/completions", "application/json", strings.NewReader(`{"model":"muse"}`))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if e.Tokens.Input != 50 || e.Tokens.Output != 70 {
		t.Fatalf("already-net guard: %+v", e.Tokens)
	}
	if e.CostSource == nil || *e.CostSource != "planFree" {
		t.Fatalf("opencode is a plan vendor: %v", e.CostSource)
	}
}

const anthropicSSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_abc","usage":{"input_tokens":800,"cache_read_input_tokens":2000,"cache_creation_input_tokens":500}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"text":"Hi"}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":150,"output_tokens_details":{"thinking_tokens":40}}}

event: message_stop
data: {"type":"message_stop"}

`

func TestAnthropicSSE_NetOutputExcludesThinking(t *testing.T) {
	st := testEnv(t)
	base := startMeter(t, st, "claude", anthropicFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("request-id", "req_hdr_1")
		w.Header().Set("anthropic-ratelimit-tokens-limit", "100000")
		w.Header().Set("anthropic-ratelimit-tokens-remaining", "90000")
		w.Header().Set("anthropic-ratelimit-tokens-reset", "2026-09-20T00:00:00Z")
		w.Write([]byte(anthropicSSE))
	}))
	resp, _ := http.Post(base+"/v1/messages", "application/json",
		strings.NewReader(`{"model":"claude-opus-4-5","thinking":{"type":"enabled","budget_tokens":10000}}`))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if e.Tokens.Input != 800 || e.Tokens.CacheRead != 2000 || e.Tokens.CacheWrite != 500 {
		t.Fatalf("input/cache: %+v", e.Tokens)
	}
	if e.Tokens.Output != 110 || e.Tokens.Reasoning != 40 {
		t.Fatalf("net output = 150-40 = 110: %+v", e.Tokens)
	}
	if *e.ContextOccupancy != 3300 {
		t.Fatalf("anthropic occupancy = input+cacheRead+cacheWrite = 3300: %v", *e.ContextOccupancy)
	}
	if *e.RequestID != "req_hdr_1" || *e.RequestIDAlt != "msg_abc" {
		t.Fatalf("dual request ids: %v / %v", e.RequestID, e.RequestIDAlt)
	}
	if *e.ThinkingLevel != "medium" || *e.ThinkingRaw != "budget_tokens:10000" {
		t.Fatalf("thinking bands: %v / %v", e.ThinkingLevel, e.ThinkingRaw)
	}
	for range 100 {
		snaps, _ := st.LimitHistory(0, time.Now().Unix()+1, 10)
		if len(snaps) > 0 {
			if snaps[0].UsedPercent < 9.9 || snaps[0].UsedPercent > 10.1 || snaps[0].ResetsAt == nil {
				t.Fatalf("anthropic wire limit: %+v", snaps[0])
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("anthropic wire limit not recorded")
}

func TestGeminiUsageMetadata_MaxFoldAndFallback(t *testing.T) {
	st := testEnv(t)
	sse := "data: {\"candidates\":[],\"usageMetadata\":{\"promptTokenCount\":1200,\"candidatesTokenCount\":300,\"thoughtsTokenCount\":100,\"cachedContentTokenCount\":700}}\n\n"
	base := startMeter(t, st, "gemini", geminiFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(sse))
	}))
	resp, _ := http.Post(base+"/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse", "application/json",
		strings.NewReader(`{"contents":[],"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}`))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if e.Model != "gemini-3-pro" {
		t.Fatalf("model from path: %q", e.Model)
	}
	if e.Tokens.Input != 500 || e.Tokens.Output != 300 || e.Tokens.Reasoning != 100 || e.Tokens.CacheRead != 700 {
		t.Fatalf("gemini net breakdown: %+v", e.Tokens)
	}
	if *e.ContextOccupancy != 1200 {
		t.Fatalf("gemini occupancy = net input + cacheRead: %v", *e.ContextOccupancy)
	}
	if *e.ThinkingLevel != "off" { // 0 = explicit off on the Gemini wire
		t.Fatalf("thinkingBudget 0 = off: %v", *e.ThinkingLevel)
	}
}

func TestGeminiBareTotalFallback(t *testing.T) {
	b := GeminiUsageBreakdown(map[string]any{"totalTokenCount": float64(900)})
	if b.Input != 900 || b.Total() != 900 {
		t.Fatalf("bare total attributed as input: %+v", b)
	}
}

func TestOllamaNDJSON_ExactNanoRates(t *testing.T) {
	st := testEnv(t)
	ndjson := "{\"model\":\"qwen3:32b\",\"message\":{\"content\":\"a\"}}\n" +
		"{\"model\":\"qwen3:32b\",\"message\":{\"content\":\"b\"}}\n" +
		"{\"model\":\"qwen3:32b\",\"done\":true,\"prompt_eval_count\":500,\"prompt_eval_duration\":250000000,\"eval_count\":100,\"eval_duration\":2000000000}\n"
	base := startMeter(t, st, "ollama", ollamaFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(ndjson))
	}))
	resp, _ := http.Post(base+"/api/chat", "application/json", strings.NewReader(`{"model":"qwen3:32b","think":"low"}`))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if e.Tokens.Input != 500 || e.Tokens.Output != 100 {
		t.Fatalf("ollama counts: %+v", e.Tokens)
	}
	// 500 tok / 0.25s = 2000 t/s prompt; 100 tok / 2s = 50 t/s generation.
	if e.PromptTokPerSec == nil || *e.PromptTokPerSec < 1999 || *e.PromptTokPerSec > 2001 {
		t.Fatalf("exact prompt rate: %v", e.PromptTokPerSec)
	}
	if e.GenerationTokPerSec == nil || *e.GenerationTokPerSec < 49.9 || *e.GenerationTokPerSec > 50.1 {
		t.Fatalf("exact generation rate: %v", e.GenerationTokPerSec)
	}
	if *e.ThinkingLevel != "low" || *e.ThinkingRaw != "think:low" {
		t.Fatalf("think level: %v", e.ThinkingLevel)
	}
	if *e.CostSource != "planFree" { // local runtime: marginal cost 0
		t.Fatalf("ollama cost: %v", *e.CostSource)
	}
}

func TestNonMeteredPathRelaysButDoesNotCount(t *testing.T) {
	st := testEnv(t)
	base := startMeter(t, st, "deepseek", openAIFormat{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	resp, _ := http.Get(base + "/v1/models")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != `{"ok":true}` {
		t.Fatalf("relay: %q", body)
	}
	time.Sleep(50 * time.Millisecond)
	n, _ := st.Count()
	if n != 0 {
		t.Fatalf("GET must relay but not count: %d rows", n)
	}
}

// ---- start gates ----

func TestRegistryGates(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	st := testEnv(t)
	// Files methodology: no meters, ever.
	t.Setenv("TH_CAPTURE_METHODOLOGY", "files")
	reg := NewRegistry(st, nil)
	if reg.Add("deepseek", 0, "", "") {
		t.Fatal("files methodology must refuse meters (scanners count)")
	}
	// Point methodology but no consent: refuse.
	t.Setenv("TH_CAPTURE_METHODOLOGY", "point")
	t.Setenv("TH_CONSENT", "")
	if reg.Add("deepseek", 0, "", "") {
		t.Fatal("no consent → no listener")
	}
	// Consent granted: starts on the deterministic default port.
	t.Setenv("TH_CONSENT", "metering")
	if !reg.Add("deepseek", 0, "http://127.0.0.1:1", "") {
		t.Fatal("consented add must start")
	}
	statuses := reg.Status()
	if len(statuses) != 1 || statuses[0].ListenPort != 9249 {
		t.Fatalf("deterministic port 9249: %+v", statuses)
	}
	if DefaultListenPort("kimi") != 9246 || DefaultListenPort("ollama") != 11435 {
		t.Fatal("default port table drifted")
	}
}

func TestTHMetersParsing(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	st := testEnv(t)
	reg := NewRegistry(st, nil)
	t.Setenv("TH_METERS", "kimi:9266@pi->https://api.kimi.com, bad-entry, openai:notaport")
	reg.StartFromEnv()
	statuses := reg.Status()
	if len(statuses) != 1 || statuses[0].Vendor != "kimi" || statuses[0].ListenPort != 9266 {
		t.Fatalf("TH_METERS parse: %+v", statuses)
	}
	if reg.meters[0].ProductLabel != "pi" {
		t.Fatalf("@product label: %+v", reg.meters[0].ProductLabel)
	}
}

func TestExplicitLabelOutranksSniff(t *testing.T) {
	st := testEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"usage":{"prompt_tokens":10,"completion_tokens":5}}`))
	}))
	defer up.Close()
	m := &Meter{Vendor: "deepseek", TargetBase: up.URL, Source: "external",
		Store: st, Format: openAIFormat{}, ProductLabel: "my-harness"}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	req, _ := http.NewRequest("POST", "http://127.0.0.1:"+itoaPort(m.ListenPort)+"/v1/chat/completions",
		strings.NewReader(`{"model":"x"}`))
	req.Header.Set("User-Agent", "codex_cli_rs/1.0")
	resp, _ := http.DefaultClient.Do(req)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	e := waitEvent(t, st)
	if *e.Product != "my-harness" || *e.ProductSource != "explicitLabel" {
		t.Fatalf("explicit label must win: %v/%v", e.Product, e.ProductSource)
	}
}
