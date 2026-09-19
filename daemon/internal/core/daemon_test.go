package core

// Port-fidelity tests: the Go daemon is correct when it reproduces the
// Swift core's documented behaviors — net token semantics, read-time
// canonicalization, annotation rank resolution, pricing intervals with
// reasoning at the output rate, cursor-based sync with drain + ack-only
// advancement, and the capture-methodology config.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	s, err := openStore(filepath.Join(dir, "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func meteredEvent(id, vendor, model string, in, out, reas, cr, cw int64) Event {
	return Event{
		ID: id, Timestamp: 1_789_700_000, MachineID: "m1", Source: "external",
		Vendor: vendor, Model: model,
		Tokens:      TokenBreakdown{Input: in, Output: out, Reasoning: reas, CacheRead: cr, CacheWrite: cw},
		Attestation: "measured",
	}
}

func TestInsertIdempotentOnUUID(t *testing.T) {
	s := testStore(t)
	n, err := s.InsertMetered([]Event{meteredEvent("E1", "kimi", "k3-256k", 100, 10, 5, 50, 0)})
	if err != nil || n != 1 {
		t.Fatalf("first insert: n=%d err=%v", n, err)
	}
	n, err = s.InsertMetered([]Event{meteredEvent("E1", "kimi", "k3-256k", 100, 10, 5, 50, 0)})
	if err != nil || n != 0 {
		t.Fatalf("redelivery must be a no-op: n=%d err=%v", n, err)
	}
	count, _ := s.Count()
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
}

func TestMeteredFilterExcludesSelfReported(t *testing.T) {
	s := testStore(t)
	metered := meteredEvent("E1", "kimi", "k3", 10, 1, 0, 0, 0)
	backfill := meteredEvent("E2", "kimi", "k3", 20, 2, 0, 0, 0)
	backfill.Attestation = "selfReported"
	backfill.Model = "(file import)"
	if _, err := s.InsertMetered([]Event{metered, backfill}); err != nil {
		t.Fatal(err)
	}
	all, _, _ := s.EventsPage(Filter{}, 0, 10)
	if len(all) != 2 {
		t.Fatalf("unfiltered = %d, want 2", len(all))
	}
	meteredOnly, _, _ := s.EventsPage(Filter{MeteredOnly: true}, 0, 10)
	if len(meteredOnly) != 1 || meteredOnly[0].ID != "E1" {
		t.Fatalf("metered=1 must exclude selfReported: %+v", meteredOnly)
	}
}

func TestAnnotationRankResolution(t *testing.T) {
	s := testStore(t)
	e := meteredEvent("E1", "claude", "claude-opus-4-5", 10, 5, 0, 0, 0)
	rid := "req_123"
	e.RequestID = &rid
	sniffed := "headerSniffed"
	e.ProductSource = &sniffed
	prod := "claude-code-sniff"
	e.Product = &prod // ingest: `product` carries the meter's observation
	if _, err := s.InsertMetered([]Event{e}); err != nil {
		t.Fatal(err)
	}
	// File annotation joins by provider request id and OUTRANKS the sniff.
	_, err := s.db.Exec(`INSERT INTO file_annotation (vendor, request_id, product, cost, ts) VALUES ('claude','req_123','claude-code',1.25,?)`, 1_789_700_000)
	if err != nil {
		t.Fatal(err)
	}
	page, _, err := s.EventsPage(Filter{}, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	got := page[0]
	if got.Product == nil || *got.Product != "claude-code" {
		t.Fatalf("file product must win over sniff: %v", got.Product)
	}
	if got.ProductRaw == nil || *got.ProductRaw != "claude-code-sniff" {
		t.Fatalf("raw observation must be preserved: %v", got.ProductRaw)
	}
	if got.Cost != 1.25 || got.CostSource == nil || *got.CostSource != "reported" {
		t.Fatalf("reported cost must win: cost=%v source=%v", got.Cost, got.CostSource)
	}
}

func TestExplicitLabelOutranksFile(t *testing.T) {
	s := testStore(t)
	e := meteredEvent("E1", "claude", "x", 1, 1, 0, 0, 0)
	rid := "req_9"
	e.RequestID = &rid
	explicit := "explicitLabel"
	e.ProductSource = &explicit
	prod := "pinned"
	e.Product = &prod
	s.InsertMetered([]Event{e})
	s.db.Exec(`INSERT INTO file_annotation (vendor, request_id, product, ts) VALUES ('claude','req_9','from-file',1)`)
	page, _, _ := s.EventsPage(Filter{}, 0, 10)
	if *page[0].Product != "pinned" {
		t.Fatalf("explicit label must outrank file: %v", *page[0].Product)
	}
}

func TestCostEquivalentPricesReasoningAtOutputRate(t *testing.T) {
	s := testStore(t)
	// Pricing interval covering all history for canonical key kimi/k3.
	_, err := s.db.Exec(`INSERT INTO pricing (raw, valid_from, input_per_m, output_per_m, cache_read_per_m)
		VALUES ('kimi/k3', 0, 1.0, 2.0, NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	// Net storage: output EXCLUDES reasoning. 1M in + 500K out + 500K think
	// must price as $1 + (500K+500K)*$2/M = $3 — thinking is never free.
	e := meteredEvent("E1", "kimi", "k3", 1_000_000, 500_000, 500_000, 0, 0)
	s.InsertMetered([]Event{e})
	page, _, err := s.EventsPage(Filter{}, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	got := page[0].CostEquivalent
	if got == nil || *got < 2.99 || *got > 3.01 {
		t.Fatalf("costEquivalent = %v, want ~3.0 (reasoning at output rate)", got)
	}
}

func TestPricingIntervalsRepriceForwardOnly(t *testing.T) {
	s := testStore(t)
	s.db.Exec(`INSERT INTO pricing (raw, valid_from, input_per_m, output_per_m) VALUES ('kimi/k3', 0, 1.0, 1.0)`)
	s.db.Exec(`INSERT INTO pricing (raw, valid_from, input_per_m, output_per_m) VALUES ('kimi/k3', 1789700000, 10.0, 10.0)`)
	old := meteredEvent("OLD", "kimi", "k3", 1_000_000, 0, 0, 0, 0)
	old.Timestamp = 1_789_600_000
	newer := meteredEvent("NEW", "kimi", "k3", 1_000_000, 0, 0, 0, 0)
	s.InsertMetered([]Event{old, newer})
	page, _, _ := s.EventsPage(Filter{}, 0, 10)
	byID := map[string]Event{}
	for _, e := range page {
		byID[e.ID] = e
	}
	if *byID["OLD"].CostEquivalent > 1.01 || *byID["OLD"].CostEquivalent < 0.99 {
		t.Fatalf("old row must keep the old rate: %v", *byID["OLD"].CostEquivalent)
	}
	if *byID["NEW"].CostEquivalent < 9.99 || *byID["NEW"].CostEquivalent > 10.01 {
		t.Fatalf("new row must price at the new rate: %v", *byID["NEW"].CostEquivalent)
	}
}

func TestBucketsSnapAndVendorFold(t *testing.T) {
	s := testStore(t)
	// opencode-go must fold into canonical opencode at read time.
	a := meteredEvent("A", "opencode-go", "muse", 100, 10, 0, 50, 0)
	b := meteredEvent("B", "opencode", "muse", 200, 20, 0, 60, 0)
	a.Timestamp = 1_789_700_100
	b.Timestamp = 1_789_700_250 // same 5m bucket (start 1789700100)
	s.InsertMetered([]Event{a, b})
	buckets, err := s.Buckets(Filter{}, 300)
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 {
		t.Fatalf("folded vendors must share one bucket row: %+v", buckets)
	}
	if buckets[0].Vendor != "opencode" {
		t.Fatalf("vendor = %q, want canonical opencode", buckets[0].Vendor)
	}
	if buckets[0].Tokens.Input != 300 || buckets[0].Requests != 2 {
		t.Fatalf("bucket sums wrong: %+v", buckets[0])
	}
	if buckets[0].Start != 1_789_700_100/300*300 {
		t.Fatalf("bucket start not epoch-aligned: %d", buckets[0].Start)
	}
	if SnapBucketSeconds(150) != 300 || SnapBucketSeconds(900) != 900 ||
		SnapBucketSeconds(2000) != 3600 || SnapBucketSeconds(99999) != 86400 {
		t.Fatal("bucket snapping drifted from BucketResolution.snap")
	}
}

func TestSummaryRollsUpCanonicalVendor(t *testing.T) {
	s := testStore(t)
	s.InsertMetered([]Event{
		meteredEvent("A", "opencode-go", "muse", 100, 10, 5, 50, 0),
		meteredEvent("B", "opencode", "muse", 100, 10, 5, 50, 0),
		meteredEvent("C", "kimi", "k3", 500, 50, 25, 250, 0),
	})
	providers, err := s.Summary(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 2 {
		t.Fatalf("vendor fold must merge spellings: %+v", providers)
	}
	var oc *ProviderSummary
	for i := range providers {
		if providers[i].Vendor == "opencode" {
			oc = &providers[i]
		}
	}
	if oc == nil || oc.Requests != 2 || oc.Tokens.Input != 200 {
		t.Fatalf("opencode rollup wrong: %+v", oc)
	}
	if len(oc.Models) != 1 || oc.Models[0].Tokens.Reasoning != 10 {
		t.Fatalf("model rollup wrong: %+v", oc.Models)
	}
}

func TestCanonicalFolds(t *testing.T) {
	if Vendor("Zhipu") != "glm" || Vendor("opencode-go") != "opencode" || Vendor("unknownx") != "unknownx" {
		t.Fatal("vendor fold drifted")
	}
	if Model("claude", "Claude-Opus-4-5-20251101") != "claude-opus-4-5" {
		t.Fatal("snapshot-date fold drifted")
	}
	if Model("claude", "claude-sonnet-4.5") != "claude-sonnet-4-5" {
		t.Fatal("claude dotted fold drifted")
	}
	if Model("x", "gpt-5@luh-crank") != "gpt-5" {
		t.Fatal("attribution-suffix fold drifted")
	}
}

// ---- sync ----

func TestSyncDrainsBacklogAndAdvancesCursorOnlyOnAck(t *testing.T) {
	s := testStore(t)
	var batches atomic.Int64
	var lastEnvelope map[string]any
	var totalRows atomic.Int64
	fail := atomic.Bool{}
	cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(503)
			return
		}
		batches.Add(1)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		lastEnvelope = body
		totalRows.Add(int64(len(body["rows"].([]any))))
		w.WriteHeader(200)
	}))
	defer cloud.Close()

	// 3 pages worth of events.
	var events []Event
	for i := 0; i < 1200; i++ {
		events = append(events, meteredEvent("E"+strconv.Itoa(i), "kimi", "k3", 1, 1, 0, 0, 0))
	}
	s.InsertMetered(events)

	sy := NewSyncer()
	sy.BaseURL = cloud.URL
	sy.UserID = "u-123"
	sy.Handle = "wock"

	// Transport failure: cursor must NOT advance.
	fail.Store(true)
	rep := sy.Sync(s)
	if rep.Error == "" {
		t.Fatal("failed push must report an error")
	}
	c, _ := s.SyncCursor(datasetUsageEvents)
	if c != "" && c != "0" {
		t.Fatalf("cursor advanced without ack: %q", c)
	}

	fail.Store(false)
	sy.mu.Lock() // clear the error backoff to retry immediately
	sy.backoffUntil = time.Time{}
	sy.mu.Unlock()
	rep = sy.Sync(s)
	if rep.Error != "" {
		t.Fatalf("sync: %v", rep.Error)
	}
	if rep.Pushed[datasetUsageEvents] != 1200 {
		t.Fatalf("drain must push the whole backlog in one Sync: %v", rep.Pushed)
	}
	if batches.Load() != 3 {
		t.Fatalf("1200 rows @500 = 3 pages, got %d", batches.Load())
	}
	if lastEnvelope["user_id"] != "u-123" || lastEnvelope["handle"] != "wock" {
		t.Fatalf("envelope identity missing: %v", lastEnvelope)
	}
	// Second sync: nothing left.
	rep = sy.Sync(s)
	if rep.Pushed[datasetUsageEvents] != 0 {
		t.Fatalf("re-sync must be empty: %v", rep.Pushed)
	}
}

func TestSyncDisabledWithoutBaseURL(t *testing.T) {
	s := testStore(t)
	sy := NewSyncer()
	sy.BaseURL = ""
	rep := sy.Sync(s)
	if len(rep.Skipped) != 2 {
		t.Fatalf("disabled sync must skip both datasets: %+v", rep)
	}
}

// ---- config / identity ----

func TestMethodologyResolution(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	if (Settings{}).Methodology() != MethodologyPoint {
		t.Fatal("default must be point")
	}
	if (Settings{MeterCaptureMode: "mitm"}).Methodology() != MethodologyMITM {
		t.Fatal("legacy meterCaptureMode must map through")
	}
	if (Settings{CaptureMethodology: "files"}).Methodology() != MethodologyFiles {
		t.Fatal("files methodology")
	}
	t.Setenv("TH_CAPTURE_METHODOLOGY", "mitm")
	if (Settings{CaptureMethodology: "files"}).Methodology() != MethodologyMITM {
		t.Fatal("env override must win")
	}
}

func TestCloudIdentityRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	if loadCloudIdentity() != nil {
		t.Fatal("empty before save")
	}
	id := &CloudIdentity{BaseURL: "https://cloud.example.com", Handle: "wock", UserID: "u-1", Team: "core"}
	if err := saveCloudIdentity(id); err != nil {
		t.Fatal(err)
	}
	got := loadCloudIdentity()
	if got == nil || got.Handle != "wock" || got.UserID != "u-1" || got.SavedAt <= 0 {
		t.Fatalf("round trip: %+v", got)
	}
	info, _ := os.Stat(cloudIdentityPath())
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity must be 0600: %v", info.Mode())
	}
	clearCloudIdentity()
	if loadCloudIdentity() != nil {
		t.Fatal("clear failed")
	}
}

func TestIdentityAppliesToSyncer(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	sy := NewSyncer()
	sy.ApplyIdentity(&CloudIdentity{BaseURL: "https://c.example.com", Handle: "wock", UserID: "u-9"})
	if sy.BaseURL != "https://c.example.com" || sy.UserID != "u-9" {
		t.Fatal("apply failed")
	}
	sy.ClearIdentity()
	if sy.BaseURL != "" || sy.UserID != "" {
		t.Fatal("clear must restore env defaults (empty here)")
	}
}

func TestSaveSettingsMergesSwiftCoreKeys(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	// The settings file is shared with the Swift core — writing the
	// methodology must not drop keys this daemon doesn't know about.
	os.WriteFile(settingsPath(), []byte(`{"alibabaCookie":"secret","meterToggles":{"kimi":true},"captureMethodology":"point"}`), 0o600)
	if err := setMethodology(MethodologyFiles); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(settingsPath())
	var merged map[string]any
	json.Unmarshal(data, &merged)
	if merged["captureMethodology"] != "files" {
		t.Fatalf("methodology not written: %v", merged)
	}
	if merged["alibabaCookie"] != "secret" {
		t.Fatalf("merge dropped Swift-core keys: %v", merged)
	}
	if _, ok := merged["meterToggles"].(map[string]any)["kimi"]; !ok {
		t.Fatalf("merge dropped nested keys: %v", merged)
	}
}

func TestMachineIDPersists(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	a := machineID()
	if a == "" || !strings.Contains(a, "-") {
		t.Fatalf("bad uuid: %q", a)
	}
	if b := machineID(); b != a {
		t.Fatal("machine id must persist across calls")
	}
}
