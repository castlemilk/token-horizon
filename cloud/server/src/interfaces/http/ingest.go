package api

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/cloud/server/src/models/usage"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/ingest"
)

// Ingest handlers: POST /ingest/events + /ingest/limits. The wire shape is
// exactly what the Swift CloudSync pushes — an identity envelope plus rows.

type envelopeWire struct {
	MachineID    string `json:"machine_id"`
	MachineAlias string `json:"machine_alias"`
	Handle       string `json:"handle"`
	UserID       string `json:"user_id"`
	Team         string `json:"team"`
	Platform     string `json:"platform"`
}

func (e envelopeWire) toDomain() ingest.Envelope {
	return ingest.Envelope{
		MachineID: e.MachineID, MachineAlias: e.MachineAlias,
		Handle: e.Handle, UserID: e.UserID, Team: e.Team, Platform: e.Platform,
	}
}

type eventWire struct {
	ID          string               `json:"id"`
	Ts          int64                `json:"ts"`
	Source      string               `json:"source"`
	Vendor      string               `json:"vendor"`
	Model       string               `json:"model"`
	Tokens      usage.TokenBreakdown `json:"tokens"`
	Cost        float64              `json:"cost"`
	CostSource  string               `json:"cost_source"`
	SessionID   string               `json:"session"`
	Product     string               `json:"product"`
	AccountID   string               `json:"account_id"`
	RequestID   string               `json:"request_id"`
	Attestation string               `json:"attestation"`
}

func (e eventWire) toDomain(machineID string) usage.UsageEvent {
	return usage.UsageEvent{
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
	events := make([]usage.UsageEvent, 0, len(body.Rows))
	for _, row := range body.Rows {
		events = append(events, row.toDomain(body.MachineID))
	}
	res, err := s.Ingest.Events(r.Context(), body.toDomain(), events)
	if err != nil {
		s.fail(w, err)
		return
	}
	// Geo hint for the leaderboard flag — best-effort, never fails ingest.
	if s.Store != nil {
		_ = s.Store.TouchUserIP(r.Context(), res.User.ID, clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": res.Accepted, "duplicates": res.Duplicates,
		"user": res.User.Handle, "machine": res.Machine.MachineID,
	})
}

// clientIP is the immediate peer, or the first X-Forwarded-For hop when
// the server sits behind a proxy/edge worker.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
	snaps := make([]usage.LimitSnapshot, 0, len(body.Rows))
	for _, row := range body.Rows {
		sn := usage.LimitSnapshot{
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
	if s.Store != nil {
		_ = s.Store.TouchUserIP(r.Context(), res.User.ID, clientIP(r))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": res.Accepted, "user": res.User.Handle, "machine": res.Machine.MachineID,
	})
}
