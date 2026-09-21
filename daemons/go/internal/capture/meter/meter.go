package meter

// Meter: a loopback HTTP relay (ported from Metering/RequestMeter.swift).
// Clients point their base URL at the meter; the meter forwards every
// request to the real API and streams the response back byte-identical
// while accumulating a copy. When the exchange completes it derives a
// usage.Event — token breakdown, measured rates, context occupancy, cost —
// and stores it via the shared store. THE ONLY usage source.
//
// Wire-format differences live in Format implementations (openai.go,
// anthropic.go, gemini.go, ollama.go).

import (
	"bytes"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Storer is the store surface meters need (store.Store satisfies it).
type Storer interface {
	InsertMetered(events []usage.Event) (int, error)
	RecordLimits(snaps []usage.LimitSnapshot) error
	RecordTrace(t usage.Trace) error
}

// Exchange is one fully-observed HTTP exchange captured by the relay.
type Exchange struct {
	Method          string
	Path            string
	RequestBody     []byte
	RequestHeaders  map[string]string // lowercase names
	Status          int
	ResponseHeaders map[string]string // lowercase names
	ResponseBody    bytes.Buffer
	StartedAt       time.Time
	FirstByteAt     time.Time // zero = no body byte observed
	CompletedAt     time.Time
	// EventID is assigned at ingress and returned to the client as
	// x-token-horizon-event-id, so client logs join to usage rows without
	// a second lookup. buildEvent reuses it (the store keeps preset IDs).
	EventID string
	// ResponseTruncated is set when the response exceeds responseCapBytes.
	// The client still receives the full stream; only the buffered copy
	// stops, and the exchange is relayed-but-unmeasured (a truncated tail
	// usually holds the usage block, so partial totals would lie).
	ResponseTruncated bool
	// ResponseBytes counts every relayed body byte, including past the
	// buffer cap (the buffer stops; this counter doesn't).
	ResponseBytes int
	// ErrorClass is classified once in handle for completed exchanges so
	// counting and trace capture share one verdict ("" = not classified,
	// e.g. client disconnected or upstream unreachable).
	ErrorClass string
}

func (x *Exchange) DurationMs() int64 {
	return x.CompletedAt.Sub(x.StartedAt).Milliseconds()
}

// Format is the per-wire-format parsing contract (the Swift subclass hooks).
type Format interface {
	// ShouldMeter gates which exchanges count (relay forwards everything).
	ShouldMeter(method, path string) bool
	// Model is the selected model from request body / path / response.
	Model(x *Exchange) string
	// Usage parses the token breakdown from the completed response.
	// Nil = not metered. NET semantics: input excludes cache, output
	// excludes reasoning.
	Usage(x *Exchange) *usage.TokenBreakdown
	// ContextOccupancy semantics differ per wire format.
	ContextOccupancy(t *usage.TokenBreakdown) int64
	// RequestID / RequestIDAlt: provider request ids for cross-channel dedup.
	RequestID(x *Exchange) string
	RequestIDAlt(x *Exchange) string
	// Thinking normalizes the request's thinking config to a level + raw.
	Thinking(x *Exchange) (level, raw string, ok bool)
	// Rates: measured tok/s. Nil = use the default wall-clock derivation.
	Rates(x *Exchange, t *usage.TokenBreakdown) (prompt, generation *float64)
	// LimitSnapshots: rate-limit windows riding response headers.
	LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []usage.LimitSnapshot
}

// Meter is the relay itself. One per (vendor, port).
type Meter struct {
	Vendor       string
	ListenPort   int
	TargetBase   string
	Source       string // sourceKind: "external" (cloud) | "selfManaged"
	Store        Storer
	Format       Format
	ProductLabel string // explicit product label (TH_METERS @product)
	Nudge        func() // sync noteActivity hook

	seen     atomic.Int64
	measured atomic.Int64
	logged   sync.Map // unmeasured paths logged once

	// Shared observation state (base-owned: no per-format logic).
	// retry counts repeat requests inside the window; errCounts tallies
	// classified failures; suspectIDs rings recent retry-suspect event IDs.
	// Meters are always used by pointer (atomics already require it).
	retryInit     sync.Once
	retry         *retryWindow
	retrySuspects atomic.Int64
	suspectIDs    []string
	suspectMu     sync.Mutex
	errMu         sync.Mutex
	errCounts     map[string]int64
	// Trace-toggle cache: settings live on disk, so snapshot the flag
	// with a short TTL instead of reading the file per request.
	traceMu      sync.Mutex
	traceCheckAt time.Time
	traceOn      bool

	ln     net.Listener
	server *http.Server
	client *http.Client
}

// window returns the meter's retry window, lazily initialized (meters are
// built as struct literals in registry and tests; finalize is the only
// user and it always runs post-Start).
func (m *Meter) window() *retryWindow {
	m.retryInit.Do(func() { m.retry = newRetryWindow() })
	return m.retry
}

// tracesEnabled snapshots the trace-capture toggle with a 30s TTL:
// settings live on disk and finalize runs per request.
func (m *Meter) tracesEnabled() bool {
	m.traceMu.Lock()
	defer m.traceMu.Unlock()
	if time.Since(m.traceCheckAt) < 30*time.Second {
		return m.traceOn
	}
	m.traceOn = platform.LoadSettings().TraceCaptureEnabled()
	m.traceCheckAt = time.Now()
	return m.traceOn
}

// responseCapBytes bounds the buffered response copy, symmetric with the
// 32MB request cap. The client always receives the full stream; over the
// cap only the copy stops and the exchange goes unmeasured (usage blocks
// trail responses, so partial totals would lie).
const responseCapBytes = 32 << 20

// eventIDHeader joins client logs to usage rows: the response carries the
// event's own UUID, fetchable via GET /analytics/events?id=.
const eventIDHeader = "x-token-horizon-event-id"

// Seen / Measured: lifetime 2xx exchanges vs stored events. seen-measured>0
// means traffic arrives but isn't parsed — surfaced via GET /meters.
func (m *Meter) Seen() int64     { return m.seen.Load() }
func (m *Meter) Measured() int64 { return m.measured.Load() }

// RetrySuspects counts metered requests repeating inside the retry window.
// RecentRetryIDs rings the last suspect event IDs (fetch via
// GET /analytics/events?id=). ErrorCounts tallies classified failures by
// class (network/auth/rateLimited/...); redirects are control flow, not
// failures, and are never counted.
func (m *Meter) RetrySuspects() int64 { return m.retrySuspects.Load() }

func (m *Meter) RecentRetryIDs() []string {
	m.suspectMu.Lock()
	defer m.suspectMu.Unlock()
	return append([]string(nil), m.suspectIDs...)
}

func (m *Meter) ErrorCounts() map[string]int64 {
	m.errMu.Lock()
	defer m.errMu.Unlock()
	out := make(map[string]int64, len(m.errCounts))
	for k, v := range m.errCounts {
		out[k] = v
	}
	return out
}

func (m *Meter) countError(class string) {
	if class == errNone {
		return
	}
	m.errMu.Lock()
	if m.errCounts == nil {
		m.errCounts = map[string]int64{}
	}
	m.errCounts[class]++
	m.errMu.Unlock()
}

func (m *Meter) rememberSuspect(eventID string) {
	m.retrySuspects.Add(1)
	m.suspectMu.Lock()
	m.suspectIDs = append(m.suspectIDs, eventID)
	if len(m.suspectIDs) > suspectRingCap {
		m.suspectIDs = append([]string(nil), m.suspectIDs[len(m.suspectIDs)-suspectRingCap:]...)
	}
	m.suspectMu.Unlock()
}

// Start binds the loopback listener and serves. Nothing listens without
// .metering consent (checked by the caller / registry).
func (m *Meter) Start() error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", m.ListenPort))
	if err != nil {
		return err
	}
	if m.ListenPort == 0 { // ephemeral (tests)
		m.ListenPort = ln.Addr().(*net.TCPAddr).Port
	}
	m.ln = ln
	// Never follow redirects: the meter relays whatever the upstream
	// answers (3xx included) so client credentials never travel to a
	// redirect target and SDKs see the provider's real control flow.
	m.client = &http.Client{
		Timeout: 600 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	m.server = &http.Server{Handler: http.HandlerFunc(m.handle)}
	go m.server.Serve(ln)
	return nil
}

func (m *Meter) Stop() {
	if m.server != nil {
		m.server.Close()
	}
}

var stripRequestHeaders = map[string]bool{
	"host": true, "connection": true, "content-length": true,
	"accept-encoding":   true, // identity keeps bodies parseable
	"transfer-encoding": true, "keep-alive": true,
}

var stripResponseHeaders = map[string]bool{
	"content-length": true, "transfer-encoding": true,
	"connection": true, "content-encoding": true,
}

func (m *Meter) handle(w http.ResponseWriter, r *http.Request) {
	x := &Exchange{
		Method:          r.Method,
		Path:            r.URL.RequestURI(),
		RequestHeaders:  map[string]string{},
		ResponseHeaders: map[string]string{},
		StartedAt:       time.Now(),
		EventID:         platform.NewUUID(),
	}
	for name, values := range r.Header {
		x.RequestHeaders[strings.ToLower(name)] = strings.Join(values, " ")
	}

	// Buffer the request body (32MB cap, same as the gateway contract).
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	x.RequestBody = body

	// Forward upstream (robust base+path join: avoid // and missing /).
	base := strings.TrimSuffix(m.TargetBase, "/")
	path := x.Path
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, base+path, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "bad upstream url", http.StatusBadGateway)
		return
	}
	for name, values := range r.Header {
		if stripRequestHeaders[strings.ToLower(name)] {
			continue
		}
		upstream.Header[name] = values
	}

	resp, err := m.client.Do(upstream)
	if err != nil {
		m.countError(classifyError(0, nil, err.Error()))
		http.Error(w, "upstream unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	x.Status = resp.StatusCode
	for name, values := range resp.Header {
		x.ResponseHeaders[strings.ToLower(name)] = strings.Join(values, " ")
	}
	for name, values := range resp.Header {
		if stripResponseHeaders[strings.ToLower(name)] {
			continue
		}
		w.Header()[name] = values
	}
	w.Header().Set(eventIDHeader, x.EventID)
	w.WriteHeader(resp.StatusCode)

	// Stream the body byte-identical while teeing a bounded copy into the
	// exchange buffer. Past the cap the client stream continues untouched;
	// only accumulation stops (see ResponseTruncated).
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if x.FirstByteAt.IsZero() {
				x.FirstByteAt = time.Now()
			}
			chunk := buf[:n]
			x.ResponseBytes += len(chunk)
			if !x.ResponseTruncated {
				if x.ResponseBody.Len()+len(chunk) > responseCapBytes {
					x.ResponseTruncated = true
				} else {
					x.ResponseBody.Write(chunk)
				}
			}
			if _, werr := w.Write(chunk); werr != nil {
				// Client gone: stop reading upstream into a dead socket.
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}
	x.CompletedAt = time.Now()

	// Classify once for completed exchanges: counting (failures only) and
	// trace capture (every row carries a class) share the verdict.
	// Failures are counted, never stored: counting semantics stay exactly
	// "metered 2xx rows". Redirects are provider control flow under the
	// no-follow policy, not failures.
	x.ErrorClass = classifyError(x.Status, x.ResponseBody.Bytes(), "")
	if x.Status >= 400 {
		m.countError(x.ErrorClass)
	}

	// Parse + persist off the hot path; finalize gates usage-event
	// derivation on 2xx itself but traces every completed exchange.
	go m.finalize(x)
}

// finalize derives the event and wire limit snapshots from a completed
// exchange and persists them. It also records the trace row (evidence,
// never counts) and notes the retry window — all base-owned, no
// per-format logic.
func (m *Meter) finalize(x *Exchange) {
	m.seen.Add(1)
	fp := requestFingerprint(x.Method, x.Path, x.RequestBody)
	suspect := false
	// POST-only window: polled GETs (models/tags) must not pollute it or
	// flag everything after 10 minutes of uptime.
	if x.Method == http.MethodPost {
		if m.window().note(fp, x.CompletedAt.Unix()) {
			suspect = true
			m.rememberSuspect(x.EventID)
		}
	}
	var event *usage.Event
	counted := x.Status >= 200 && x.Status < 300
	switch {
	case !counted:
		// Failures are counted (above), never stored: usage rows stay
		// exactly "metered 2xx".
	case x.ResponseTruncated:
		// Relayed whole, buffered partial: usage blocks trail responses,
		// so measuring the fragment would store a lie. Loud once per path.
		if _, loaded := m.logged.LoadOrStore("truncated:"+x.Path, true); !loaded {
			fmt.Fprintf(os.Stderr,
				"token-horizon: %s meter relayed %s %s over %dMiB response cap (unmeasured)\n",
				m.Vendor, x.Method, x.Path, responseCapBytes>>20)
		}
	default:
		if event = m.buildEvent(x); event != nil {
			if m.Store != nil {
				_, _ = m.Store.InsertMetered([]usage.Event{*event})
			}
			if m.Nudge != nil {
				m.Nudge() // fresh usage nudges cloud sync (debounced)
			}
			m.measured.Add(1)
		} else if x.Method == http.MethodPost {
			// Traffic arrived but yielded nothing — path allowlist or
			// wire-format miss. Log once per path so new client versions /
			// prefixed bases (cf. /zen/v1) surface loudly.
			if _, loaded := m.logged.LoadOrStore(x.Path, true); !loaded {
				fmt.Fprintf(os.Stderr,
					"token-horizon: %s meter relayed %s %s but measured nothing (path or wire-format miss)\n",
					m.Vendor, x.Method, x.Path)
			}
		}
	}
	// Wire rate limits ride every response — capture them regardless of
	// whether the exchange metered.
	if m.Store != nil {
		snaps := m.Format.LimitSnapshots(x, m.Vendor, platform.MachineID(), usage.AccountKeyForHeaders(m.Vendor, x.RequestHeaders))
		if len(snaps) > 0 {
			_ = m.Store.RecordLimits(snaps)
		}
	}
	// Trace capture (evidence, never counts): every completed exchange,
	// any status or method. Gated on the trace toggle; the ID matches the
	// usage row for metered exchanges, so the two join for free.
	if m.Store != nil && m.tracesEnabled() {
		if tr := m.buildTrace(x, event, fp, suspect); tr != nil {
			_ = m.Store.RecordTrace(*tr)
		}
	}
}

// buildEvent is RequestMeter.event(from:): gates, parses, and assembles the
// UsageEvent with all provenance fields.
func (m *Meter) buildEvent(x *Exchange) *usage.Event {
	if !m.Format.ShouldMeter(x.Method, x.Path) {
		return nil
	}
	tokens := m.Format.Usage(x)
	if tokens == nil || tokens.Total() <= 0 {
		return nil
	}
	model := m.Format.Model(x)
	prompt, generation := m.Format.Rates(x, tokens)
	cost, costSource := costDecision(m.Vendor, model, *tokens)
	occupancy := m.Format.ContextOccupancy(tokens)

	event := &usage.Event{
		ID:                  x.EventID,
		Timestamp:           x.CompletedAt.Unix(),
		MachineID:           platform.MachineID(),
		Source:              m.Source,
		Vendor:              m.Vendor,
		Model:               model,
		Tokens:              *tokens,
		ContextOccupancy:    &occupancy,
		Cost:                cost,
		CostRaw:             cost,
		PromptTokPerSec:     prompt,
		GenerationTokPerSec: generation,
		CostSource:          strPtr(costSource),
		Attestation:         "measured",
	}
	if alias := platform.MachineAlias(); alias != "" {
		event.MachineAlias = &alias
	}
	if ms := x.DurationMs(); ms > 0 {
		event.LatencyMs = &ms
	}
	if level, raw, ok := m.Format.Thinking(x); ok {
		event.ThinkingLevel = &level
		event.ThinkingRaw = &raw
	}
	// Product attribution with provenance: explicit label > UA sniff;
	// a later file annotation overrides sniffed labels but never explicit.
	if m.ProductLabel != "" {
		label := m.ProductLabel
		src := "explicitLabel"
		event.Product = &label
		event.ProductRaw = &label
		event.ProductSource = &src
	} else if product := sniffProduct(x.RequestHeaders["user-agent"]); product != "" {
		src := "headerSniffed"
		event.Product = &product
		event.ProductRaw = &product
		event.ProductSource = &src
	}
	if acct := usage.AccountKeyForHeaders(m.Vendor, x.RequestHeaders); acct != "" {
		event.AccountID = &acct
	}
	if rid := m.Format.RequestID(x); rid != "" {
		event.RequestID = &rid
	}
	if rid := m.Format.RequestIDAlt(x); rid != "" {
		event.RequestIDAlt = &rid
	}
	return event
}

func strPtr(s string) *string { return &s }
func f64(v float64) *float64  { return &v }

// defaultRates: generation tok/s = output over body-streaming duration
// (first byte → completion); prompt tok/s = input over time-to-first-byte
// (includes queueing; end-to-end measurement).
func defaultRates(x *Exchange, t *usage.TokenBreakdown) (prompt, generation *float64) {
	if !x.FirstByteAt.IsZero() {
		streamDur := x.CompletedAt.Sub(x.FirstByteAt).Seconds()
		if t.Output > 0 && streamDur > 0.05 {
			generation = f64(float64(t.Output) / streamDur)
		}
		ttfb := x.FirstByteAt.Sub(x.StartedAt).Seconds()
		if ttfb > 0.02 && t.Input > 0 {
			prompt = f64(float64(t.Input) / ttfb)
		}
	}
	return prompt, generation
}

// defaultLimitSnapshots: OpenAI-style x-ratelimit-* response headers.
// Anthropic overrides with anthropic-ratelimit-* (RFC3339 reset).
func defaultLimitSnapshots(x *Exchange, vendor, machineID, accountID string) []usage.LimitSnapshot {
	var out []usage.LimitSnapshot
	for _, kind := range []string{"requests", "tokens"} {
		limit, lok := headerFloat(x.ResponseHeaders, "x-ratelimit-limit-"+kind)
		remaining, rok := headerFloat(x.ResponseHeaders, "x-ratelimit-remaining-"+kind)
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
			Detail:      fmt.Sprintf("%d/%d remaining", int64(remaining), int64(limit)),
		}
		if d := parseResetDuration(x.ResponseHeaders["x-ratelimit-reset-"+kind]); d != nil {
			at := x.CompletedAt.Add(*d).Unix()
			sn.ResetsAt = &at
		}
		out = append(out, sn)
	}
	return out
}

func headerFloat(headers map[string]string, name string) (float64, bool) {
	raw, ok := headers[name]
	if !ok {
		return 0, false
	}
	var v float64
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%g", &v); err != nil {
		return 0, false
	}
	return v, true
}

// sseObjects: all JSON objects carried by SSE `data:` lines ([DONE]
// skipped). Shared by every SSE format parser.
func sseObjects(text string) []map[string]any {
	var out []map[string]any
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[5:])
		if payload == "[DONE]" || payload == "" {
			continue
		}
		var obj map[string]any
		if jsonUnmarshal([]byte(payload), &obj) == nil {
			out = append(out, obj)
		}
	}
	return out
}

func num(obj map[string]any, key string) int64 {
	if v, ok := obj[key].(float64); ok {
		return int64(v)
	}
	return 0
}
