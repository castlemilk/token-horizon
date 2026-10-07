package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type metadataTransport func(*http.Request) (*http.Response, error)

func (f metadataTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type cancelledReader struct{ cancel context.CancelFunc }

func (r cancelledReader) Read([]byte) (int, error) { r.cancel(); return 0, io.ErrUnexpectedEOF }

func TestBodyCaptureRequiresExactOptIn(t *testing.T) {
	for _, value := range []string{"", "0", "true", "1"} {
		t.Setenv("TOKEN_HORIZON_CAPTURE_BODIES", value)
		if ConfigFromEnv().CaptureBodies != (value == "1") {
			t.Fatalf("unexpected capture for %q", value)
		}
	}
}

func TestAbortHandlerStillRecordsCancelledTrace(t *testing.T) {
	_, proxy, store, _ := testSetup(t, nil)
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), http.ServerContextKey, &http.Server{}))
	defer cancel()
	proxy.proxy.Transport = metadataTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Request: r, Body: io.NopCloser(io.MultiReader(strings.NewReader("data: {\"usage\":{\"prompt_tokens\":5}}\n\n"), cancelledReader{cancel}))}, nil
	})
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true}`)).WithContext(ctx)
	var recovered any
	func() { defer func() { recovered = recover() }(); proxy.ServeHTTP(httptest.NewRecorder(), req) }()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("expected stream abort, got %v", recovered)
	}
	traces := store.Recent(1, TraceFilter{})
	if len(traces) != 1 {
		t.Fatal("abort lost trace")
	}
	if traces[0].CompletionState != "cancelled" || traces[0].UsageCoverage != "partial" {
		t.Fatalf("cancelled coverage %+v", traces[0])
	}
}

func TestLongStreamFinalUsageAndMetadataPrivacy(t *testing.T) {
	// The final usage frame is well beyond the retained content prefix.
	stream := strings.Repeat("data: {\"choices\":[{\"delta\":{\"content\":\"PRIVATE_RESPONSE\"}}]}\n\n", BodyCapBytes/20)
	stream += "data: {\"id\":\"resp-final\",\"model\":\"actual-model\",\"usage\":{\"prompt_tokens\":17,\"completion_tokens\":41,\"total_tokens\":58}}\n\ndata: [DONE]\n\n"
	_, proxy, store, _ := testSetup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer PRIVATE_KEY" {
			t.Error("auth not forwarded")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-ID", "request-final")
		io.WriteString(w, stream)
	}))
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"requested-alias","messages":[{"role":"user","content":"PRIVATE_PROMPT"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer PRIVATE_KEY")
	res := httptest.NewRecorder()
	proxy.ServeHTTP(res, req)
	if res.Body.String() != stream {
		t.Fatal("stream bytes changed")
	}
	traces := store.Recent(1, TraceFilter{})
	if len(traces) != 1 {
		t.Fatalf("traces: %d", len(traces))
	}
	tr := traces[0]
	if (tr.Usage.InputTokens == nil || *tr.Usage.InputTokens != 17) || (tr.Usage.OutputTokens == nil || *tr.Usage.OutputTokens != 41) {
		t.Fatalf("late usage lost: %+v", tr.Usage)
	}
	if tr.Model != "actual-model" || tr.RequestedModel != "requested-alias" || tr.ProviderResponseID != "resp-final" || (tr.ProviderRequestID == nil || *tr.ProviderRequestID != "request-final") {
		t.Fatalf("identities lost: %+v", tr)
	}
	if tr.CompletionState != "complete" || tr.UsageCoverage != "reported" || tr.CaptureMode != "metadata" {
		t.Fatalf("coverage: %+v", tr)
	}
	full, _ := store.Get(tr.ID)
	payload, _ := json.Marshal(full)
	for _, secret := range []string{"PRIVATE_PROMPT", "PRIVATE_RESPONSE", "PRIVATE_KEY"} {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("content leaked: %s", secret)
		}
	}
	if full.RequestBody != nil || full.ResponseBody != nil {
		t.Fatal("body capture must be opt-in")
	}
}

func TestMetadataObserverSplitFramesAndOversizedFrame(t *testing.T) {
	var observer streamMetadata
	wire := "data: " + strings.Repeat("x", BodyCapBytes+1) + "\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"output\":[{\"text\":\"PRIVATE\"}],\"usage\":{\"input_tokens\":9,\"output_tokens\":12,\"total_tokens\":21}}}\n\n"
	for i := 0; i < len(wire); i += 7 {
		end := i + 7
		if end > len(wire) {
			end = len(wire)
		}
		observer.write([]byte(wire[i:end]))
	}
	metadata := observer.finish()
	usage := ExtractUsage(ProviderOpenAI, EndpointResponses, metadata)
	if (usage.InputTokens == nil || *usage.InputTokens != 9) || (usage.OutputTokens == nil || *usage.OutputTokens != 12) || !observer.skipped || !observer.complete {
		t.Fatalf("observer/usage %+v %+v", observer, usage)
	}
	if strings.Contains(string(metadata), "PRIVATE") {
		t.Fatal("observer retained response text")
	}
}

func TestInterruptedStreamReportsPartialUsage(t *testing.T) {
	_, proxy, store, _ := testSetup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n")
	}))
	proxy.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true}`)))
	tr := store.Recent(1, TraceFilter{})[0]
	if tr.CompletionState != "partial" || tr.UsageCoverage != "partial" || (tr.Usage.InputTokens == nil || *tr.Usage.InputTokens != 3) {
		t.Fatalf("partial stream laundered as complete: %+v", tr)
	}
}

func TestAnthropicUsageSnapshotsAreNotDoubleCounted(t *testing.T) {
	var observer streamMetadata
	observer.write([]byte("data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"model\":\"claude\",\"usage\":{\"input_tokens\":11,\"output_tokens\":0}}}\n\n" +
		"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n" +
		"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":13}}\n\n" +
		"data: {\"type\":\"message_stop\"}\n\n"))
	usage := ExtractUsage(ProviderAnthropic, EndpointMessages, observer.finish())
	if usage.InputTokens == nil || *usage.InputTokens != 11 || usage.OutputTokens == nil || *usage.OutputTokens != 13 || !observer.complete {
		t.Fatalf("usage snapshots %+v", usage)
	}
}
