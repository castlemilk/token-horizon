package files

// Fidelity tests for the files subsystem: incremental tail semantics,
// additive/codex/kimi line parsers, codex watermark statefulness, opencode
// sqlite buckets, backfill event assembly (deterministic ids, selfReported),
// and the annotation consolidators.

import (
	"database/sql"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func testHome(t *testing.T) *Engine {
	t.Helper()
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	t.Setenv("TH_CONSENT", "fileReading")
	return &Engine{
		Home:         t.TempDir(),
		claudeFiles:  map[string]*additiveFileState{},
		genericFiles: map[string]*additiveFileState{},
		kimiFiles:    map[string]*additiveFileState{},
		codexFiles:   map[string]*codexFileState{},
	}
}

func TestIncrementalRead_PartialTailSurvives(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.jsonl")
	os.WriteFile(path, []byte("{\"a\":1}\n{\"b\":2}\n{\"c\":3"), 0o600) // partial tail
	var off uint64
	var lines [][]byte
	IncrementalRead(path, &off, func() { t.Error("no truncate") }, func(l []byte) { lines = append(lines, l) })
	if len(lines) != 2 {
		t.Fatalf("consumed %d lines, want 2 (partial tail must survive)", len(lines))
	}
	wantOff := uint64(len("{\"a\":1}\n{\"b\":2}\n"))
	if off != wantOff {
		t.Fatalf("offset %d, want exactly %d", off, wantOff)
	}
	// Complete the tail line + add another: only new bytes are read.
	os.WriteFile(path, []byte("{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n{\"d\":4}\n"), 0o600)
	lines = nil
	IncrementalRead(path, &off, func() {}, func(l []byte) { lines = append(lines, l) })
	if len(lines) != 2 || string(lines[0]) != `{"c":3}` {
		t.Fatalf("incremental read: %q", lines)
	}
}

func TestIncrementalRead_TruncationFiresHook(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.jsonl")
	os.WriteFile(path, []byte("{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n"), 0o600)
	var off uint64
	IncrementalRead(path, &off, func() {}, func([]byte) {})
	if off == 0 {
		t.Fatal("initial read")
	}
	os.WriteFile(path, []byte("{\"x\":1}\n"), 0o600) // shrank = rotation
	truncated := false
	var lines [][]byte
	IncrementalRead(path, &off, func() { truncated = true }, func(l []byte) { lines = append(lines, l) })
	if !truncated {
		t.Fatal("truncate hook must fire before any line is delivered")
	}
	if len(lines) != 1 || string(lines[0]) != `{"x":1}` {
		t.Fatalf("restart at 0: %q", lines)
	}
}

func TestParseAdditiveLine_Conventions(t *testing.T) {
	e := testHome(t)
	// Anthropic message.usage (claude transcripts).
	p := e.parseAdditiveLine([]byte(`{"timestamp":"2026-09-19T10:00:00Z","message":{"model":"claude-opus-4-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":10,"output_tokens_details":{"thinking_tokens":5}}}}`))
	if p == nil || p.breakdown.Input != 100 || p.breakdown.Output != 45 || p.breakdown.Reasoning != 5 ||
		p.breakdown.CacheRead != 200 || p.breakdown.CacheWrite != 10 {
		t.Fatalf("anthropic breakdown: %+v", p)
	}
	// OpenAI usage block.
	p = e.parseAdditiveLine([]byte(`{"timestamp":"2026-09-19T10:05:00Z","usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens_details":{"reasoning_tokens":10}}}`))
	if p == nil || p.breakdown.Input != 600 || p.breakdown.Output != 90 {
		t.Fatalf("openai breakdown: %+v", p)
	}
	// costUSD + model fallbacks.
	p = e.parseAdditiveLine([]byte(`{"created_at":"2026-09-19T10:10:00Z","costUSD":0.05,"model_name":"m1","usage":{"prompt_tokens":10}}`))
	if p == nil || p.cost != 0.05 || p.model != "m1" {
		t.Fatalf("cost/model: %+v", p)
	}
	// ms epoch timestamps.
	p = e.parseAdditiveLine([]byte(`{"timestamp":1789700000000,"usage":{"input_tokens":5}}`))
	if p == nil || p.hour != bucketStart(1789700000) {
		t.Fatalf("ms epoch: %+v", p)
	}
}

func TestCodexWatermark_StatefulAccept(t *testing.T) {
	_ = testHome(t)
	st := &codexFileState{buckets: map[int64]*BucketEntry{}}
	mk := func(in, out, cached, reasoning int64) *codexParsed {
		return &codexParsed{
			totals: codexWatermark{in, out, cached, reasoning},
			last:   codexWatermark{in, out, cached, reasoning},
			hour:   1789700100,
		}
	}
	// First sighting: delta = current.
	d := codexAccept(mk(1000, 100, 400, 50), st)
	if d.input != 1000 || d.cached != 400 {
		t.Fatalf("first delta: %+v", d)
	}
	// Growth: only the increment.
	d = codexAccept(mk(1500, 150, 500, 60), st)
	if d.input != 500 || d.output != 50 || d.cached != 100 || d.reasoning != 10 {
		t.Fatalf("incremental delta: %+v", d)
	}
	// Stale duplicate (small dip within 2%): ignored.
	d = codexAccept(mk(1490, 149, 499, 60), st)
	if d.input != 0 || d.output != 0 {
		t.Fatalf("stale guard: %+v", d)
	}
}

func TestCodexParseLine_RateLimits(t *testing.T) {
	e := testHome(t)
	line := []byte(`{"timestamp":"2026-09-19T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"output_tokens":500,"cached_input_tokens":2000,"reasoning_output_tokens":100}},"rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":1789701000.0}}}}`)
	p := e.parseCodexLine(line)
	if p == nil {
		t.Fatal("token_count parse")
	}
	if p.totals.input != 5000 || p.totals.cached != 2000 || p.totals.reasoning != 100 {
		t.Fatalf("watermark: %+v", p.totals)
	}
	if p.rate == nil || p.rate.UsedPercent != 42.5 || p.rate.Label != "5h (file)" {
		t.Fatalf("rate: %+v", p.rate)
	}
	if p.rate.ResetsAt == nil || *p.rate.ResetsAt != 1789701000 {
		t.Fatalf("resets: %v", p.rate.ResetsAt)
	}
}

func TestCodexScan_BucketNetSemantics(t *testing.T) {
	e := testHome(t)
	dir := filepath.Join(e.Home, ".codex/sessions/2026/09/19")
	os.MkdirAll(dir, 0o755)
	line := `{"timestamp":"2026-09-19T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":100,"cached_input_tokens":400,"reasoning_output_tokens":50},"last_token_usage":{"input_tokens":1000,"output_tokens":100,"cached_input_tokens":400,"reasoning_output_tokens":50}}}}` + "\n"
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(line), 0o600)
	buckets := e.scanCodex([]string{"~/.codex/sessions"})
	var got *BucketEntry
	for _, b := range buckets {
		got = b
	}
	if got == nil {
		t.Fatal("no bucket")
	}
	// NET: input 1000-400=600, output 100-50=50; reasoning 50; cache 400.
	if got.Breakdown.Input != 600 || got.Breakdown.Output != 50 ||
		got.Breakdown.Reasoning != 50 || got.Breakdown.CacheRead != 400 {
		t.Fatalf("net bucket: %+v", got.Breakdown)
	}
	// Re-scan with no new bytes: no double count.
	buckets = e.scanCodex([]string{"~/.codex/sessions"})
	total := int64(0)
	for _, b := range buckets {
		total += b.Breakdown.Total()
	}
	if total != 600+50+50+400 {
		t.Fatalf("re-scan must not double count: %d", total)
	}
}

func makeOpenCodeDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.Exec(`CREATE TABLE session (time_created REAL, tokens_input INTEGER, tokens_output INTEGER,
		tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL)`)
	db.Exec(`CREATE TABLE message (data TEXT, time_created REAL)`)
	db.Exec(`INSERT INTO session VALUES (1789700100000.0, 1000, 100, 50, 400, 0, 0.25)`)
	db.Exec(`INSERT INTO message VALUES ('{"role":"assistant","responseID":"resp_1","cost":0.25}', 1789700100000.0)`)
	db.Exec(`INSERT INTO message VALUES ('{"role":"user"}', 1789700100000.0)`)
	return path
}

func TestOpenCodeBackfillAndAnnotation(t *testing.T) {
	e := testHome(t)
	e.OpenCodeDB = makeOpenCodeDB(t)
	buckets := e.opencodePerBucket()
	if len(buckets) != 1 {
		t.Fatalf("buckets: %v", buckets)
	}
	for _, b := range buckets {
		if b.Breakdown.Input != 1000 || b.Breakdown.Reasoning != 50 || b.Cost != 0.25 {
			t.Fatalf("opencode bucket: %+v", b)
		}
	}
	// Consolidator: one annotation per assistant row with a response id.
	store := newMemStore()
	n, err := OpenCodeConsolidator{Engine: e}.Consolidate(store)
	if err != nil || n != 1 {
		t.Fatalf("annotate n=%d err=%v", n, err)
	}
	if len(store.annotations) != 1 || store.annotations[0].RequestID != "resp_1" ||
		store.annotations[0].Cost == nil || *store.annotations[0].Cost != 0.25 {
		t.Fatalf("annotation: %+v", store.annotations)
	}
}

func TestClaudeConsolidator(t *testing.T) {
	e := testHome(t)
	dir := filepath.Join(e.Home, ".claude/projects/p1")
	os.MkdirAll(dir, 0o755)
	lines := `{"timestamp":"2026-09-19T10:00:00Z","requestId":"req_hdr_1","message":{"usage":{"input_tokens":100,"output_tokens":50}}}` + "\n" +
		`{"timestamp":"2026-09-19T10:00:01Z","requestId":"req_hdr_2","message":{"usage":{"input_tokens":0,"output_tokens":0}}}` + "\n"
	os.WriteFile(filepath.Join(dir, "t.jsonl"), []byte(lines), 0o600)
	// Point the consolidator's home at the test home via HOME env.
	t.Setenv("HOME", e.Home)
	store := newMemStore()
	n, err := ClaudeConsolidator{}.Consolidate(store)
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v (zero-usage rows skipped)", n, err)
	}
	a := store.annotations[0]
	if a.Vendor != "claude" || a.RequestID != "req_hdr_1" || a.Product != "claude-code" {
		t.Fatalf("annotation: %+v", a)
	}
}

func TestBackfillEvents_Assembly(t *testing.T) {
	e := testHome(t)
	t.Setenv("HOME", e.Home)
	e.OpenCodeDB = makeOpenCodeDB(t)
	dir := filepath.Join(e.Home, ".claude/projects")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "t.jsonl"), []byte(
		`{"timestamp":"2026-09-19T10:00:00Z","requestId":"r1","message":{"usage":{"input_tokens":100,"output_tokens":50}}}`+"\n"), 0o600)

	events := e.BackfillEvents()
	if len(events) < 2 {
		t.Fatalf("events: %d", len(events))
	}
	byVendor := map[string]usage.Event{}
	for _, ev := range events {
		byVendor[ev.Vendor] = ev
	}
	oc := byVendor["opencode"]
	if oc.Model != "(file import)" || oc.Attestation != "selfReported" {
		t.Fatalf("opencode event: %+v", oc)
	}
	if oc.CostSource == nil || *oc.CostSource != "reported" { // cost 0.25 > 0.0001
		t.Fatalf("reported cost: %v", oc.CostSource)
	}
	cl := byVendor["claude"]
	if cl.Tokens.Input != 100 || cl.Tokens.Output != 50 {
		t.Fatalf("claude event: %+v", cl.Tokens)
	}
	if cl.ProductSource == nil || *cl.ProductSource != "fileJoined" {
		t.Fatalf("product source: %v", cl.ProductSource)
	}
	// Determinism: same scan → same ids.
	events2 := NewEngine()
	events2.Home = e.Home
	events2.OpenCodeDB = e.OpenCodeDB
	for _, ev := range events2.BackfillEvents() {
		for _, ev1 := range events {
			if ev.Vendor == ev1.Vendor && ev.ID != ev1.ID {
				t.Fatalf("ids must be deterministic across engines: %s vs %s", ev.ID, ev1.ID)
			}
		}
	}
}

// memStore captures annotations/limits for tests.
type memStore struct {
	annotations []usage.FileAnnotation
	limits      []usage.LimitSnapshot
}

func newMemStore() *memStore { return &memStore{} }

func (m *memStore) Annotate(a []usage.FileAnnotation) error {
	m.annotations = append(m.annotations, a...)
	return nil
}

func (m *memStore) RecordLimits(l []usage.LimitSnapshot) error {
	m.limits = append(m.limits, l...)
	return nil
}

func TestPollerGating(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	p := NewPoller(newMemStore(), testHome(t))
	// No consent → disabled.
	t.Setenv("TH_CONSENT", "")
	if p.Enabled() {
		t.Fatal("no consent → disabled")
	}
	t.Setenv("TH_CONSENT", "fileReading")
	// filePolling off + point methodology → disabled.
	if p.Enabled() {
		t.Fatal("polling is opt-in in point methodology")
	}
	// files methodology forces polling on.
	t.Setenv("TH_CAPTURE_METHODOLOGY", "files")
	if !p.Enabled() {
		t.Fatal("files methodology forces polling")
	}
	t.Setenv("TH_CAPTURE_METHODOLOGY", "point")
	t.Setenv("TH_FILE_POLL", "1")
	if !p.Enabled() {
		t.Fatal("TH_FILE_POLL=1 forces polling")
	}
}
