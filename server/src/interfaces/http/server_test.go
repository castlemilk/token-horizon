package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store/testfake"
	"github.com/castlemilk/token-horizon/server/src/use_cases/ingest"
	syncuc "github.com/castlemilk/token-horizon/server/src/use_cases/sync"
)

func testServer() *Server {
	fake := testfake.New()
	return &Server{Ingest: ingest.Ingest{Store: fake}, Sync: syncuc.Sync{Store: fake}, Token: "s3cret"}
}

func TestAuthEnforced(t *testing.T) {
	s := testServer()
	req := httptest.NewRequest("POST", "/ingest/events", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d", rec.Code)
	}
}

func authed(method, path string, body any) *http.Request {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer s3cret")
	return req
}

// Mirrors the Swift CloudSchema wire shape (epoch ints, snake_case tokens).
func TestIngestEventsWireShape(t *testing.T) {
	s := testServer()
	body := map[string]any{
		"machine_id": "m-9", "machine_alias": "lab", "handle": "Ada", "team": "t",
		"rows": []any{map[string]any{
			"id": "resp-1", "ts": 1789000000, "source": "external",
			"vendor": "opencode", "model": "muse-spark",
			"tokens": map[string]any{"input": 2162, "output": 85, "reasoning": 24, "cache_read": 9000, "cache_write": 0},
			"cost":   0.0, "cost_source": "planFree", "session": "s1",
			"product": "opencode", "account_id": "opencode:abc", "request_id": "resp-1",
			"attestation": "measured",
		}},
	}
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, authed("POST", "/ingest/events", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["accepted"] != 1.0 || out["user"] != "ada" {
		t.Fatalf("out=%v", out)
	}

	// Redelivery is a no-op duplicate.
	rec2 := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec2, authed("POST", "/ingest/events", body))
	var out2 map[string]any
	_ = json.Unmarshal(rec2.Body.Bytes(), &out2)
	if out2["duplicates"] != 1.0 {
		t.Fatalf("out2=%v", out2)
	}
}

func TestIngestLimitsAndSyncPaths(t *testing.T) {
	s := testServer()
	// Seed one event so summary/high-water have rows in THIS server.
	seed := map[string]any{
		"machine_id": "m-9", "handle": "Ada",
		"rows": []any{map[string]any{
			"id": "resp-1", "ts": 1789000000, "source": "external",
			"vendor": "opencode", "model": "muse-spark",
			"tokens":      map[string]any{"input": 10, "output": 2},
			"attestation": "measured",
		}},
	}
	seedRec := httptest.NewRecorder()
	s.Routes().ServeHTTP(seedRec, authed("POST", "/ingest/events", seed))
	if seedRec.Code != http.StatusOK {
		t.Fatalf("seed code=%d", seedRec.Code)
	}
	limits := map[string]any{
		"machine_id": "m-9", "handle": "Ada",
		"rows": []any{map[string]any{
			"recorded_at": 1789000000, "provider": "kimi", "account_id": "",
			"label": "5h", "used_percent": 48.5, "resets_at": nil, "detail": "52 / 100 left",
		}},
	}
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, authed("POST", "/ingest/limits", limits))
	if rec.Code != http.StatusOK {
		t.Fatalf("limits code=%d body=%s", rec.Code, rec.Body.String())
	}

	for path, want := range map[string]string{
		"/v1/sync/status?machine_id=m-9": `"events_count":1`,
		"/v1/machines?handle=ada":        `"machine_id":"m-9"`,
		"/v1/usage/summary?handle=ada":   `"vendor":"opencode"`,
	} {
		rr := httptest.NewRecorder()
		s.Routes().ServeHTTP(rr, authed("GET", path, nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("%s code=%d", path, rr.Code)
		}
		if !strings.Contains(rr.Body.String(), want) {
			t.Fatalf("%s missing %s: %s", path, want, rr.Body.String())
		}
	}
}

func TestBadEnvelopeIs400(t *testing.T) {
	s := testServer()
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, authed("POST", "/ingest/events", map[string]any{"rows": []any{}}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d", rec.Code)
	}
}
