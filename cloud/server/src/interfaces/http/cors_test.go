package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSPreflightAllowedOrigin(t *testing.T) {
	s := testServer()
	s.CORSOrigins = []string{"http://127.0.0.1:5173", "tauri://localhost"}
	req := httptest.NewRequest("OPTIONS", "/v1/leaderboard", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight code=%d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("allow-origin=%q", got)
	}
	if rec.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Fatal("no allow-headers on preflight")
	}
}

func TestCORSActualRequest(t *testing.T) {
	s := testServer()
	s.CORSOrigins = []string{"tauri://localhost"}
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Origin", "tauri://localhost")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "tauri://localhost" {
		t.Fatalf("allow-origin=%q", got)
	}
}

func TestCORSUnknownOriginGetsNoHeaders(t *testing.T) {
	s := testServer()
	s.CORSOrigins = []string{"http://127.0.0.1:5173"}
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d (request still served — the BROWSER blocks the read)", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unknown origin must not get CORS headers")
	}
}

func TestCORSWildcardReflects(t *testing.T) {
	s := testServer()
	s.CORSOrigins = []string{"*"}
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Origin", "http://anything.local:9999")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://anything.local:9999" {
		t.Fatalf("wildcard allow-origin=%q", got)
	}
}

func TestCORSDisabledByDefault(t *testing.T) {
	s := testServer() // no CORSOrigins
	req := httptest.NewRequest("OPTIONS", "/v1/leaderboard", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("no origins configured — must not emit CORS headers")
	}
}
