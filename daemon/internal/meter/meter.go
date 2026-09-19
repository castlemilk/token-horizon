package meter

// Meter: a loopback HTTP relay (ported from Metering/RequestMeter.swift).
// Clients point their base URL at the meter; the meter forwards every
// request to the real API and streams the response back byte-identical
// while accumulating a copy. When the exchange completes it derives a
// core.Event — token breakdown, measured rates, context occupancy, cost —
// and stores it via the shared store. THE ONLY usage source.
//
// Wire-format differences live in Format implementations (openai.go,
// anthropic.go, gemini.go, ollama.go).

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

// Storer is the store surface meters need (core.Store satisfies it).
type Storer interface {
	InsertMetered(events []core.Event) (int, error)
	RecordLimits(snaps []core.LimitSnapshot) error
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
	Usage(x *Exchange) *core.TokenBreakdown
	// ContextOccupancy semantics differ per wire format.
	ContextOccupancy(t *core.TokenBreakdown) int64
	// RequestID / RequestIDAlt: provider request ids for cross-channel dedup.
	RequestID(x *Exchange) string
	RequestIDAlt(x *Exchange) string
	// Thinking normalizes the request's thinking config to a level + raw.
	Thinking(x *Exchange) (level, raw string, ok bool)
	// Rates: measured tok/s. Nil = use the default wall-clock derivation.
	Rates(x *Exchange, t *core.TokenBreakdown) (prompt, generation *float64)
	// LimitSnapshots: rate-limit windows riding response headers.
	LimitSnapshots(x *Exchange, vendor, machineID, accountID string) []core.LimitSnapshot
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

	ln     net.Listener
	server *http.Server
	client *http.Client
}

// Seen / Measured: lifetime 2xx exchanges vs stored events. seen-measured>0
// means traffic arrives but isn't parsed — surfaced via GET /meters.
func (m *Meter) Seen() int64     { return m.seen.Load() }
func (m *Meter) Measured() int64 { return m.measured.Load() }

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
	m.client = &http.Client{Timeout: 600 * time.Second}
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
	w.WriteHeader(resp.StatusCode)

	// Stream the body byte-identical while teeing into the exchange buffer.
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if x.FirstByteAt.IsZero() {
				x.FirstByteAt = time.Now()
			}
			chunk := buf[:n]
			x.ResponseBody.Write(chunk)
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

	// Measure only successful exchanges; parse + store off the hot path.
	if x.Status >= 200 && x.Status < 300 {
		go m.finalize(x)
	}
}

// finalize derives the event and wire limit snapshots from a completed
// exchange and persists them.
func (m *Meter) finalize(x *Exchange) {
	m.seen.Add(1)
	if event := m.buildEvent(x); event != nil {
		if m.Store != nil {
			_, _ = m.Store.InsertMetered([]core.Event{*event})
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
				"token-horizon: %s meter relayed POST %s but measured nothing (path or wire-format miss)\n",
				m.Vendor, x.Path)
		}
	}
	// Wire rate limits ride every response — capture them regardless of
	// whether the exchange metered.
	if m.Store != nil {
		snaps := m.Format.LimitSnapshots(x, m.Vendor, core.MachineID(), core.AccountKeyForHeaders(m.Vendor, x.RequestHeaders))
		if len(snaps) > 0 {
			_ = m.Store.RecordLimits(snaps)
		}
	}
}

// buildEvent is RequestMeter.event(from:): gates, parses, and assembles the
// UsageEvent with all provenance fields.
func (m *Meter) buildEvent(x *Exchange) *core.Event {
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

	event := &core.Event{
		Timestamp:           x.CompletedAt.Unix(),
		MachineID:           core.MachineID(),
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
	if alias := core.MachineAlias(); alias != "" {
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
	if acct := core.AccountKeyForHeaders(m.Vendor, x.RequestHeaders); acct != "" {
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
func defaultRates(x *Exchange, t *core.TokenBreakdown) (prompt, generation *float64) {
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
func defaultLimitSnapshots(x *Exchange, vendor, machineID, accountID string) []core.LimitSnapshot {
	var out []core.LimitSnapshot
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
		sn := core.LimitSnapshot{
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
