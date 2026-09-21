package cloudsync

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The cloud server gates /ingest/* behind TH_SYNC_TOKEN; the daemon must
// present it as a bearer or every push 401s (silent "cloud degraded").
func TestPostSendsBearerToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := &Syncer{BaseURL: srv.URL, Token: "t0ken", httpc: srv.Client()}
	if err := s.post("/ingest/events", map[string]any{"rows": []any{}}); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer t0ken" {
		t.Fatalf("Authorization=%q", gotAuth)
	}
}

func TestPostOmitsHeaderWhenNoToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := &Syncer{BaseURL: srv.URL, httpc: srv.Client()}
	if err := s.post("/ingest/events", map[string]any{"rows": []any{}}); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "" {
		t.Fatalf("Authorization=%q (want empty)", gotAuth)
	}
}
