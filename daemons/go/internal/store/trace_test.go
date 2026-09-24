package store

// Trace capture tests: idempotent writes, bodyless lists, detail lookup,
// aggregates, clear, and bound enforcement (row cap + age retention).

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
)

func testTraceStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	s, err := OpenStore(filepath.Join(dir, "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func sampleTrace(id, vendor, model string, status int, class string) usage.Trace {
	return usage.Trace{
		ID: id, Timestamp: 1_789_700_000, Vendor: vendor, Model: model,
		Method: "POST", Path: "/v1/chat/completions", StatusCode: status,
		TTFBMs: 200, DurationMs: 2200, InputTokens: 100, OutputTokens: 100,
		ErrorClass: class, RequestHash: "hash-" + id,
		RequestBody: `{"model":"m"}`, ResponseBody: `{"ok":true}`,
		RequestBytes: 13, ResponseBytes: 12,
	}
}

func TestRecordTraceIdempotentOnUUID(t *testing.T) {
	s := testTraceStore(t)
	if err := s.RecordTrace(sampleTrace("T1", "openai", "gpt", 200, "none")); err != nil {
		t.Fatal(err)
	}
	// Redelivery (same event UUID) is a no-op, like usage rows.
	if err := s.RecordTrace(sampleTrace("T1", "openai", "gpt", 200, "none")); err != nil {
		t.Fatal(err)
	}
	n, err := s.TraceCount()
	if err != nil || n != 1 {
		t.Fatalf("count=%d err=%v, want 1", n, err)
	}
}

func TestTracePageOmitsBodies(t *testing.T) {
	s := testTraceStore(t)
	tr := sampleTrace("T1", "openai", "gpt", 200, "none")
	tr.RequestBody = strings.Repeat("r", 1000)
	tr.ResponseBody = strings.Repeat("s", 1000)
	tr.RequestBytes, tr.ResponseBytes = 1000, 1000
	if err := s.RecordTrace(tr); err != nil {
		t.Fatal(err)
	}
	page, err := s.TracePage("", "", 0) // default limit
	if err != nil || len(page) != 1 {
		t.Fatalf("page=%d err=%v", len(page), err)
	}
	// Summaries carry sizes and flags, never bodies.
	if page[0].RequestBytes != 1000 || page[0].ResponseBytes != 1000 {
		t.Fatalf("sizes missing: %+v", page[0])
	}
	full, err := s.TraceByID("T1")
	if err != nil || len(full.RequestBody) != 1000 || len(full.ResponseBody) != 1000 {
		t.Fatalf("detail must include bodies: err=%v len=%d/%d", err, len(full.RequestBody), len(full.ResponseBody))
	}
	if _, err := s.TraceByID("nope"); err == nil {
		t.Fatal("missing id must error (callers map to 404)")
	}
}

func TestTraceStatsAggregates(t *testing.T) {
	s := testTraceStore(t)
	now := time.Now().Unix() // must land inside the default 24h stats window
	mk := func(id, model string, status int, class string, out int64, dur int64) usage.Trace {
		tr := sampleTrace(id, "openai", model, status, class)
		tr.Timestamp = now
		tr.OutputTokens = out
		tr.DurationMs = dur
		tr.TTFBMs = 200
		return tr
	}
	_ = s.RecordTrace(mk("A", "gpt", 200, "none", 100, 2200))     // active 2000ms → 50 t/s
	_ = s.RecordTrace(mk("B", "gpt", 429, "rateLimited", 0, 500)) // error, no output
	_ = s.RecordTrace(mk("C", "o3", 200, "none", 50, 1200))       // active 1000ms → 50 t/s
	st, err := s.TraceStats("", "", 0)                            // default 24h window
	if err != nil {
		t.Fatal(err)
	}
	if st.Requests != 3 || st.Errors != 1 {
		t.Fatalf("totals wrong: %+v", st)
	}
	if st.ErrorRate < 0.33 || st.ErrorRate > 0.34 {
		t.Fatalf("errorRate=%v want ~1/3", st.ErrorRate)
	}
	if len(st.ByModel) != 2 || st.ByModel[0].Model != "gpt" || st.ByModel[0].Requests != 2 {
		t.Fatalf("per-model rows sorted desc: %+v", st.ByModel)
	}
	// Σout=150 / Σactive=3s = 50 t/s; TTFT mean over 3 rows = 200.
	if st.AvgTokPerSec < 49.9 || st.AvgTokPerSec > 50.1 {
		t.Fatalf("avgTokPerSec=%v want 50", st.AvgTokPerSec)
	}
	if st.AvgTTFBMs != 200 {
		t.Fatalf("avgTtftMs=%v want 200", st.AvgTTFBMs)
	}
	if st.ByModel[1].AvgTokPerSec < 49.9 || st.ByModel[1].AvgTokPerSec > 50.1 {
		t.Fatalf("model tok/s=%v want 50", st.ByModel[1].AvgTokPerSec)
	}
	if n, _ := s.ClearTraces(); n != 3 {
		t.Fatalf("clear=%d want 3", n)
	}
	if n, _ := s.TraceCount(); n != 0 {
		t.Fatalf("count after clear=%d want 0", n)
	}
}

func TestTraceRetentionAndRowCap(t *testing.T) {
	s := testTraceStore(t)
	old := sampleTrace("OLD", "openai", "gpt", 200, "none")
	old.Timestamp = 100 // ancient
	if err := s.RecordTrace(old); err != nil {
		t.Fatal(err)
	}
	// Age prune is env-gated like usage rows; row-cap prune is throttled,
	// so exercise enforcement directly here.
	t.Setenv("TH_RETENTION_DAYS", "30")
	s.pruneTraces(retentionCutoff())
	if n, _ := s.TraceCount(); n != 0 {
		t.Fatalf("ancient row must prune under retention, count=%d", n)
	}
	// Row cap: overfill, prune, expect FIFO survival of the newest.
	for i := range traceCapRows + 10 {
		tr := sampleTrace(fmt.Sprintf("R%06d", i), "openai", "gpt", 200, "none")
		tr.Timestamp = int64(1_789_700_000 + i)
		if err := s.RecordTrace(tr); err != nil {
			t.Fatal(err)
		}
	}
	s.pruneTraces(0) // no age cutoff: cap only
	n, _ := s.TraceCount()
	if n != traceCapRows {
		t.Fatalf("count=%d want cap %d", n, traceCapRows)
	}
}
