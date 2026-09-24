package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

// MaxRequestBytes bounds a client request body held in memory. Beyond it
// the gateway refuses with 413 rather than truncating a proxied call.
const MaxRequestBytes = 32 * 1024 * 1024

// OllamaSampleCap retains a longer response prefix purely to parse Ollama
// eval-count telemetry (usage often trails large generations).
const OllamaSampleCap = 2 * 1024 * 1024

// ProxyHandler is the catch-all reverse proxy. Provider-specific read APIs
// (/traces, /proxy/*, /metrics, /__token_horizon) are routed before it.
type ProxyHandler struct {
	cfg     Config
	store   *Store
	metrics *Metrics
	proxy   *httputil.ReverseProxy
	ingest  *http.Client
	// info serves the exact "/" document (the mux routes every other API
	// path before this catch-all). Set by main after construction.
	info http.HandlerFunc
}

func NewProxyHandler(cfg Config, store *Store, metrics *Metrics) *ProxyHandler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 120 * time.Second
	h := &ProxyHandler{
		cfg:     cfg,
		store:   store,
		metrics: metrics,
		ingest:  &http.Client{Timeout: 2 * time.Second},
	}
	rp := &httputil.ReverseProxy{
		Director:       h.director,
		ModifyResponse: h.modifyResponse,
		ErrorHandler:   h.errorHandler,
		Transport:      transport,
	}
	h.proxy = rp
	return h
}

// relayResponseHeader allowlists upstream headers worth exposing to client
// SDKs (backoff depends on these). Auth/cookie/set-cookie never flow down.
func relayResponseHeader(name string) bool {
	lower := strings.ToLower(name)
	switch lower {
	case "content-type", "retry-after", "request-id", "x-request-id":
		return true
	}
	return strings.HasPrefix(lower, "ratelimit-") ||
		strings.HasPrefix(lower, "x-ratelimit-") ||
		strings.HasPrefix(lower, "openai-") ||
		strings.HasPrefix(lower, "anthropic-")
}

func writeJSON(w http.ResponseWriter, status int, obj any) {
	data, _ := json.Marshal(obj)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}

func (h *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" && h.info != nil {
		h.info(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.WriteHeader(http.StatusOK)
		return
	}

	rawPath := r.URL.RequestURI()
	headers := map[string]string{}
	for name := range r.Header {
		headers[strings.ToLower(name)] = r.Header.Get(name)
	}
	var reqBody []byte
	if r.Body != nil {
		defer r.Body.Close()
		body, err := io.ReadAll(io.LimitReader(r.Body, MaxRequestBytes+1))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot read request body"})
			return
		}
		if len(body) > MaxRequestBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
			return
		}
		reqBody = body
	}

	provider, endpoint := InferProvider(rawPath, headers, reqBody)
	if provider == ProviderUnknown {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unknown provider for path " + rawPath,
			"hint":  "use /v1/chat/completions, /v1/responses, /v1/messages, /v1beta/*, /api/*, or prefix with /th-<provider>/ (openai, anthropic, kimi, glm, minimax, deepseek, qwen, grok, gemini, opencode)",
		})
		return
	}
	info := ParseRequestInfo(provider, rawPath, headers, reqBody)
	model := info.Model
	if model == "" {
		// GET /v1/models and friends carry no body; label by credential
		// shape so rollups stay meaningful without inventing a model name.
		if headers["x-api-key"] != "" || headers["anthropic-version"] != "" {
			model = "anthropic-api"
		} else {
			model = "openai-api"
		}
	}
	h.metrics.Request(provider, endpoint, model)

	start := time.Now()
	cw := &captureWriter{ResponseWriter: w, ollama: provider == ProviderOllama}
	// Stash request context for director/modifyResponse/errorHandler, which
	// only receive the rewritten request.
	ctx := &requestContext{
		provider: provider, endpoint: endpoint, path: rawPath,
		model: model, stream: info.Stream, sessionKey: info.SessionKey,
		client:      detectClient(headers),
		requestBody: reqBody, start: start, capture: cw, traceID: traceIDGenerator(),
	}
	r = r.WithContext(contextWithTrace(r.Context(), ctx))
	// Re-attach the consumed body for the upstream round trip.
	if reqBody != nil {
		r.Body = io.NopCloser(bytes.NewReader(reqBody))
		r.ContentLength = int64(len(reqBody))
	}
	h.proxy.ServeHTTP(cw, r)
	h.finalize(ctx)
}

func (h *ProxyHandler) director(req *http.Request) {
	ctx := traceFromContext(req.Context())
	if ctx == nil {
		return
	}
	target, ok := h.cfg.UpstreamURL(ctx.provider, ctx.path)
	if !ok {
		return
	}
	req.URL.Scheme = target.Scheme
	req.URL.Host = target.Host
	req.URL.Path = target.Path
	req.URL.RawPath = target.RawPath
	req.URL.RawQuery = target.RawQuery
	req.Host = target.Host
}

func (h *ProxyHandler) modifyResponse(res *http.Response) error {
	ctx := traceFromContext(res.Request.Context())
	if ctx == nil {
		return nil
	}
	ctx.statusCode = res.StatusCode
	for name := range res.Header {
		lower := strings.ToLower(name)
		if lower == "request-id" || lower == "x-request-id" || lower == "x-requestid" {
			if v := res.Header.Get(name); v != "" {
				ctx.providerRequestID = v
			}
		}
		if !relayResponseHeader(name) {
			res.Header.Del(name)
		}
	}
	res.Header.Set("X-Token-Horizon-Trace-Id", ctx.traceID)
	return nil
}

func (h *ProxyHandler) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	ctx := traceFromContext(r.Context())
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	if ctx != nil {
		ctx.networkError = msg
	}
	if cw, ok := w.(*captureWriter); !ok || !cw.wroteHeader {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream unavailable"})
		return
	}
	// Headers already streamed: nothing valid left to send; the connection
	// close below terminates the body.
}

func (h *ProxyHandler) finalize(ctx *requestContext) {
	durationMs := float64(time.Since(ctx.start).Nanoseconds()) / 1e6
	cw := ctx.capture
	respBytes := cw.total
	var captured []byte
	if ctx.provider == ProviderOllama && len(cw.ollamaExtra) > 0 {
		captured = cw.ollamaExtra
	} else {
		captured = cw.captured
	}
	networkError := ctx.networkError
	if ctx.statusCode >= 200 && ctx.statusCode < 300 && respBytes > 0 {
		// Upstream delivered (or the client hung up mid-stream after a good
		// start): don't launder a transport note into an error class.
		networkError = ""
	}
	usage := ExtractUsage(ctx.provider, ctx.endpoint, captured)
	toolCalls, reasons := ExtractToolCalls(ctx.provider, ctx.endpoint, captured)
	errorClass, errorMessage := ClassifyError(ctx.statusCode, captured, networkError)

	reqText := string(ctx.requestBody)
	reqStored, reqTrunc := CapBody(reqText)
	if reqText == "" {
		reqStored, reqTrunc = "", false
	}
	respText := string(captured)
	respStored, respTrunc := CapBody(respText)
	if len(captured) == 0 {
		respStored, respTrunc = "", false
	}
	var ttft *float64
	if cw.hasBody {
		v := float64(cw.firstByte.Sub(ctx.start).Nanoseconds()) / 1e6
		ttft = &v
	}
	trace := Trace{
		ID: ctx.traceID, Provider: ctx.provider, Endpoint: ctx.endpoint,
		Path: ctx.path, Model: ctx.model, StartedAt: UnixTime(ctx.start),
		TTFTMs: ttft, DurationMs: durationMs, Stream: ctx.stream,
		StatusCode: ctx.statusCode, Usage: usage,
		ToolCalls: toolCalls, FinishReasons: reasons,
		ErrorClass: errorClass, ErrorMessage: errorMessage,
		Source: "proxy", Client: ctx.client,
		RequestTruncated:  reqTrunc || len(ctx.requestBody) > BodyCapBytes,
		ResponseTruncated: respTrunc || respBytes > BodyCapBytes,
		RequestBytes:      len(ctx.requestBody), ResponseBytes: respBytes,
		RequestHash: RequestFingerprint(ctx.provider, ctx.endpoint, ctx.model, ctx.requestBody),
	}
	if reqStored != "" {
		trace.RequestBody = &reqStored
	}
	if respStored != "" {
		trace.ResponseBody = &respStored
	}
	if ctx.sessionKey != "" {
		trace.SessionKey = stringPtr(ctx.sessionKey)
	}
	if ctx.providerRequestID != "" {
		trace.ProviderRequestID = stringPtr(ctx.providerRequestID)
	}
	stored := h.store.Record(trace)
	out := 0
	if usage.OutputTokens != nil {
		out = *usage.OutputTokens
	}
	ttftSecs := 0.0
	if ttft != nil {
		ttftSecs = *ttft / 1000
	}
	h.metrics.Complete(ctx.provider, ctx.endpoint, ctx.model, ctx.statusCode, ttftSecs, durationMs/1000, out)
	if (ctx.provider == ProviderOllama || ctx.provider == ProviderSplash) &&
		h.cfg.IngestURL != "" && usage.Source != TokenAbsent && out > 0 {
		h.ingestOllama(ctx.model, usage, durationMs, ctx.start)
	}
	_ = stored
}

// ingestOllama forwards a local-model sample to the Mac app so its usage
// totals stay correct for gateway-routed Ollama traffic. Best-effort:
// failures are dropped, never retried, never block the trace path.
func (h *ProxyHandler) ingestOllama(model string, usage Usage, durationMs float64, at time.Time) {
	payload := map[string]any{
		"model": model, "completedAt": float64(at.UnixNano()) / 1e9,
		"evalCount": outOrZero(usage), "evalDurationNs": uint64(durationMs * 1e6),
	}
	if usage.InputTokens != nil {
		payload["promptEvalCount"] = *usage.InputTokens
	}
	data, _ := json.Marshal(payload)
	go func() {
		req, err := http.NewRequest(http.MethodPost, h.cfg.IngestURL, bytes.NewReader(data))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := h.ingest.Do(req)
		if err != nil {
			return
		}
		io.Copy(io.Discard, io.LimitReader(res.Body, 1024))
		res.Body.Close()
	}()
}

func outOrZero(u Usage) int {
	if u.OutputTokens != nil {
		return *u.OutputTokens
	}
	return 0
}

// captureWriter tees response bytes to the client while retaining a bounded
// prefix for trace analysis. Forwarding is never truncated.
type captureWriter struct {
	http.ResponseWriter
	ollama      bool
	status      int
	wroteHeader bool
	hasBody     bool
	firstByte   time.Time
	captured    []byte
	ollamaExtra []byte
	total       int
}

func (w *captureWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *captureWriter) Write(b []byte) (int, error) {
	if !w.hasBody {
		w.hasBody = true
		w.firstByte = time.Now()
		if !w.wroteHeader {
			w.status = http.StatusOK
		}
	}
	if len(w.captured) < BodyCapBytes {
		w.captured = append(w.captured, b[:min(len(b), BodyCapBytes-len(w.captured))]...)
	}
	if w.ollama && len(w.ollamaExtra) < OllamaSampleCap {
		w.ollamaExtra = append(w.ollamaExtra, b[:min(len(b), OllamaSampleCap-len(w.ollamaExtra))]...)
	}
	w.total += len(b)
	n, err := w.ResponseWriter.Write(b)
	// Flush each chunk so SSE streams arrive live, not buffered.
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
	return n, err
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type requestContext struct {
	provider          Provider
	endpoint          Endpoint
	path              string
	model             string
	stream            bool
	sessionKey        string
	client            string
	providerRequestID string
	requestBody       []byte
	start             time.Time
	capture           *captureWriter
	traceID           string
	statusCode        int
	networkError      string
}

type ctxKey struct{}

func contextWithTrace(parent context.Context, ctx *requestContext) context.Context {
	return context.WithValue(parent, ctxKey{}, ctx)
}

func traceFromContext(c context.Context) *requestContext {
	if c == nil {
		return nil
	}
	if ctx, ok := c.Value(ctxKey{}).(*requestContext); ok {
		return ctx
	}
	return nil
}
