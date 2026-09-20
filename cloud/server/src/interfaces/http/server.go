// Package api adapts the outside world to the use cases: JSON routes,
// auth, and error mapping. No business rules here — parsing in, results out.
// One delivery package, one file per concern:
//
//	server.go      mux, middleware, shared helpers (this file)
//	ingest.go      POST /ingest/* (CloudSync-compatible wire)
//	sync.go        /v1/sync/* + /v1/usage/summary + /v1/machines
//	auth.go        login dance (OAuth tickets) + route mounting
//	account.go     /v1/users/me + avatars
//	teams.go       /v1/teams/* + /v1/groups/*
//	follows.go     /v1/follows/*
//	leaderboard.go /v1/leaderboard
//
// Wire compatibility: POST /ingest/events and POST /ingest/limits accept
// exactly what the Swift CloudSync pushes (identity envelope + CloudSchema
// rows), so TH_SYNC_URL can point at this server unchanged.
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/auth"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/ingest"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/leaderboard"
	syncuc "github.com/castlemilk/token-horizon/cloud/server/src/use_cases/sync"
)

// Server wires routes to use cases.
type Server struct {
	Ingest ingest.Ingest
	Sync   syncuc.Sync
	// Board serves the leaderboard (nil = disabled).
	Board *leaderboard.Leaderboard
	// AuthN resolves session bearer tokens to users (login identity).
	AuthN auth.Auth
	// AuthRoutes serves login/account/teams/avatar (nil = disabled).
	AuthRoutes *Auth
	// Token, when non-empty, enforces `Authorization: Bearer <token>` on
	// the machine ingest paths. Empty = open (local dev only).
	Token string
	// Store is held for side-band writes off the ingest hot path
	// (last-IP geo hint for leaderboard flags).
	Store store.Store
	// CORSOrigins lists browser origins allowed to call the API cross-
	// origin (the SvelteKit UI on the vite dev server or inside the Tauri
	// webview). "*" reflects any origin (dev convenience). Empty = CORS
	// disabled: browsers block cross-origin calls, daemons unaffected.
	CORSOrigins []string
	Log         *log.Logger
}

// Routes returns the mux.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /ingest/events", s.withAuth(s.ingestEvents))
	mux.HandleFunc("POST /ingest/limits", s.withAuth(s.ingestLimits))
	mux.HandleFunc("GET /v1/sync/status", s.withAuth(s.syncStatus))
	mux.HandleFunc("POST /v1/sync/plan", s.withAuth(s.syncPlan))
	mux.HandleFunc("GET /v1/sync/cursors", s.withAuth(s.getCursor))
	mux.HandleFunc("POST /v1/sync/cursors", s.withAuth(s.setCursor))
	mux.HandleFunc("GET /v1/usage/summary", s.withAuth(s.usageSummary))
	mux.HandleFunc("GET /v1/machines", s.withAuth(s.fleet))
	if s.AuthRoutes != nil {
		s.mountAuth(mux, s.AuthRoutes)
	}
	return mux
}

// Handler is Routes wrapped in CORS middleware — the entry point cmd
// should serve. Routes stays bare for in-process tests.
func (s *Server) Handler() http.Handler {
	return s.cors(s.Routes())
}

// cors answers preflights and stamps allow-headers for configured origins.
// Unknown origins get NO CORS headers (the browser then blocks the read);
// non-browser clients (daemons, curl) are unaffected either way.
func (s *Server) cors(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	wild := false
	for _, o := range s.CORSOrigins {
		if o == "*" {
			wild = true
			continue
		}
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (wild || allowed[origin]) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "token-horizon-cloud"})
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token != "" && r.Header.Get("Authorization") != "Bearer "+s.Token {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// withAuthOptional lets the service token through but never requires a
// user (used where the caller may be pre-login machinery).
func (s *Server) withAuthOptional(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r)
	}
}

// withUser requires a valid session token and passes the user id through.
// The service sync token alone is NOT a user (ingest keeps its own path).
func (s *Server) withUser(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || (s.Token != "" && token == s.Token) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sign in required"})
			return
		}
		user, err := s.AuthN.Authenticate(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid session"})
			return
		}
		next(w, r, user.ID)
	}
}

// --- helpers ---

// decodeJSON reads a capped JSON body into v (false = 400 already written).
func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad json"})
		return false
	}
	return true
}

// badRequest writes a 400 with a message.
func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg})
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	msg := err.Error()
	status := http.StatusInternalServerError
	switch {
	case strings.Contains(msg, "missing") || strings.Contains(msg, "bad ") ||
		strings.Contains(msg, "exceeds") || strings.Contains(msg, "required") ||
		strings.Contains(msg, "future"):
		status = http.StatusBadRequest
	}
	if s.Log != nil {
		s.Log.Printf("request failed: %v", err)
	}
	writeJSON(w, status, map[string]any{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
