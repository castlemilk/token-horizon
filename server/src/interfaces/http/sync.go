package api

import (
	"net/http"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
)

// Sync handlers: high-water status, the delta-sync plan handshake, cursors,
// usage rollups, and the device fleet.

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request) {
	machineID := r.URL.Query().Get("machine_id")
	if machineID == "" {
		badRequest(w, "machine_id required")
		return
	}
	st, err := s.Sync.Status(r.Context(), machineID)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// syncPlan is the delta-sync handshake: the daemon POSTs the candidate row
// ids it might push; the server answers with only the ones it has never
// seen (sync_row_refs), so the follow-up ingest carries new rows only.
func (s *Server) syncPlan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID string   `json:"machine_id"`
		Dataset   string   `json:"dataset"`
		IDs       []string `json:"ids"`
	}
	if !decodeJSON(w, r, 8<<20, &body) {
		return
	}
	plan, err := s.Sync.PlanRows(r.Context(), body.MachineID, body.Dataset, body.IDs)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
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
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	if body.Dataset == "" || body.MachineID == "" {
		badRequest(w, "dataset + machine_id required")
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
			badRequest(w, "since must be RFC3339")
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
		badRequest(w, "handle required")
		return
	}
	f, err := s.Sync.FleetMachines(r.Context(), handle)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}
