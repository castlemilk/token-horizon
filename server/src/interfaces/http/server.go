// Package api adapts the outside world to the use cases: JSON routes,
// auth, and error mapping. No business rules here — parsing in, results out.
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
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models"
	usecases "github.com/castlemilk/token-horizon/server/src/use_cases"
)

// Server wires routes to use cases.
type Server struct {
	Ingest usecases.Ingest
	Sync   usecases.Sync
	// Token, when non-empty, enforces `Authorization: Bearer <token>` on
	// everything but /healthz. Empty = open (local dev only).
	Token string
	Log   *log.Logger
}

// Routes returns the mux.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /ingest/events", s.withAuth(s.ingestEvents))
	mux.HandleFunc("POST /ingest/limits", s.withAuth(s.ingestLimits))
	mux.HandleFunc("GET /v1/sync/status", s.withAuth(s.syncStatus))
	mux.HandleFunc("GET /v1/sync/cursors", s.withAuth(s.getCursor))
	mux.HandleFunc("POST /v1/sync/cursors", s.withAuth(s.setCursor))
	mux.HandleFunc("GET /v1/usage/summary", s.withAuth(s.usageSummary))
	mux.HandleFunc("GET /v1/machines", s.withAuth(s.fleet))
	return mux
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

// --- ingest ---

type envelopeWire struct {
	MachineID    string `json:"machine_id"`
	MachineAlias string `json:"machine_alias"`
	Handle       string `json:"handle"`
	Team         string `json:"team"`
	Platform     string `json:"platform"`
}

func (e envelopeWire) toDomain() usecases.Envelope {
	return usecases.Envelope{
		MachineID: e.MachineID, MachineAlias: e.MachineAlias,
		Handle: e.Handle, Team: e.Team, Platform: e.Platform,
	}
}

type eventWire struct {
	ID          string                `json:"id"`
	Ts          int64                 `json:"ts"`
	Source      string                `json:"source"`
	Vendor      string                `json:"vendor"`
	Model       string                `json:"model"`
	Tokens      models.TokenBreakdown `json:"tokens"`
	Cost        float64               `json:"cost"`
	CostSource  string                `json:"cost_source"`
	SessionID   string                `json:"session"`
	Product     string                `json:"product"`
	AccountID   string                `json:"account_id"`
	RequestID   string                `json:"request_id"`
	Attestation string                `json:"attestation"`
}

func (e eventWire) toDomain(machineID string) models.UsageEvent {
	return models.UsageEvent{
		ID: e.ID, Timestamp: time.Unix(e.Ts, 0).UTC(), MachineID: machineID,
		Source: e.Source, Vendor: e.Vendor, Model: e.Model, Tokens: e.Tokens,
		Cost: e.Cost, CostSource: e.CostSource, SessionID: e.SessionID,
		Product: e.Product, AccountID: e.AccountID, RequestID: e.RequestID,
		Attestation: e.Attestation,
	}
}

func (s *Server) ingestEvents(w http.ResponseWriter, r *http.Request) {
	var body struct {
		envelopeWire
		Rows []eventWire `json:"rows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad json: " + err.Error()})
		return
	}
	events := make([]models.UsageEvent, 0, len(body.Rows))
	for _, row := range body.Rows {
		events = append(events, row.toDomain(body.MachineID))
	}
	res, err := s.Ingest.Events(r.Context(), body.toDomain(), events)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": res.Accepted, "duplicates": res.Duplicates,
		"user": res.User.Handle, "machine": res.Machine.MachineID,
	})
}

type limitWire struct {
	RecordedAt  int64   `json:"recorded_at"`
	Provider    string  `json:"provider"`
	AccountID   string  `json:"account_id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"used_percent"`
	ResetsAt    *int64  `json:"resets_at"`
	Detail      string  `json:"detail"`
}

func (s *Server) ingestLimits(w http.ResponseWriter, r *http.Request) {
	var body struct {
		envelopeWire
		Rows []limitWire `json:"rows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad json: " + err.Error()})
		return
	}
	snaps := make([]models.LimitSnapshot, 0, len(body.Rows))
	for _, row := range body.Rows {
		sn := models.LimitSnapshot{
			RecordedAt: time.Unix(row.RecordedAt, 0).UTC(), MachineID: body.MachineID,
			Provider: row.Provider, AccountID: row.AccountID, Label: row.Label,
			UsedPercent: row.UsedPercent, Detail: row.Detail,
		}
		if row.ResetsAt != nil {
			sn.ResetsAt = time.Unix(*row.ResetsAt, 0).UTC()
			sn.HasReset = true
		}
		snaps = append(snaps, sn)
	}
	res, err := s.Ingest.Limits(r.Context(), body.toDomain(), snaps)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": res.Accepted, "user": res.User.Handle, "machine": res.Machine.MachineID,
	})
}

// --- sync pathways ---

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request) {
	machineID := r.URL.Query().Get("machine_id")
	if machineID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "machine_id required"})
		return
	}
	st, err := s.Sync.Status(r.Context(), machineID)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) getCursor(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	c, err := s.Sync.Store.Cursor(r.Context(), q.Get("dataset"), q.Get("machine_id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cursor": c})
}

func (s *Server) setCursor(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Dataset   string `json:"dataset"`
		MachineID string `json:"machine_id"`
		Cursor    string `json:"cursor"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad json"})
		return
	}
	if body.Dataset == "" || body.MachineID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "dataset + machine_id required"})
		return
	}
	if err := s.Sync.Store.SetCursor(r.Context(), body.Dataset, body.MachineID, body.Cursor); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) usageSummary(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var since time.Time
	if raw := q.Get("since"); raw != "" {
		var err error
		since, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "since must be RFC3339"})
			return
		}
	}
	rows, err := s.Sync.Summary(r.Context(), q.Get("handle"), q.Get("team"), q.Get("vendor"), since)
	if err != nil {
		s.fail(w, err)
		return
	}
	if rows == nil {
		rows = []store.VendorSummary{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

func (s *Server) fleet(w http.ResponseWriter, r *http.Request) {
	handle := r.URL.Query().Get("handle")
	if handle == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "handle required"})
		return
	}
	f, err := s.Sync.FleetMachines(r.Context(), handle)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// --- helpers ---

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
