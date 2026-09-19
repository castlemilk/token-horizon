package core

// Cloud sync outbox — a faithful port of Sync/CloudSync.swift:
//
// Per dataset (usage events, limits): read the persisted cursor from
// sync_state, pull the delta (rowid / timestamp based), POST it with the
// identity envelope, advance the cursor ONLY on acknowledged push.
// Offline = deltas accumulate; the next Sync() after reconnect pushes
// everything. Event UUIDs make redelivery idempotent (cloud ingest is
// ON CONFLICT DO NOTHING).
//
// Two triggers: the 5-minute backstop timer (main.go) and noteActivity(),
// a debounced nudge fired by event ingestion so fresh usage ships in
// seconds. The cursor is the only "what to sync" boundary — the nudge
// decides WHEN, never WHAT.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	datasetUsageEvents = "usage_events" // cursor: rowid
	datasetLimits      = "limits"       // cursor: epoch seconds
)

type Syncer struct {
	BaseURL   string // empty = disabled (TH_SYNC_URL)
	Handle    string // envelope identity: TH_SYNC_HANDLE > persisted
	Team      string // TH_SYNC_TEAM    > cloud-identity.json > defaults
	UserID    string // TH_SYNC_USER_ID  > cloud-identity.json
	BatchSize int

	mu           sync.Mutex
	backoffUntil time.Time
	nudgePending bool
	lastSync     time.Time
	lastReport   *SyncReport
	httpc        *http.Client
	now          func() time.Time
}

type SyncReport struct {
	Pushed  map[string]int `json:"pushed"`
	Skipped []string       `json:"skipped"`
	Error   string         `json:"error,omitempty"`
}

func NewSyncer() *Syncer {
	s := &Syncer{
		BaseURL:   os.Getenv("TH_SYNC_URL"),
		Handle:    os.Getenv("TH_SYNC_HANDLE"),
		Team:      os.Getenv("TH_SYNC_TEAM"),
		UserID:    os.Getenv("TH_SYNC_USER_ID"),
		BatchSize: 500,
		httpc:     &http.Client{Timeout: 20 * time.Second},
		now:       time.Now,
	}
	if s.Handle == "" {
		s.Handle = os.Getenv("USER")
		if s.Handle == "" {
			s.Handle = "unknown"
		}
	}
	return s
}

// ApplyIdentity overlays the persisted cloud sign-in (daemon-held so sync
// attributes to the right user with the UI closed). An empty BaseURL keeps
// the env-configured target.
func (s *Syncer) ApplyIdentity(id *CloudIdentity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id.BaseURL != "" {
		s.BaseURL = id.BaseURL
	}
	s.Handle = id.Handle
	s.Team = id.Team
	s.UserID = id.UserID
}

// ClearIdentity restores env/default identity (sign-out/unlink). A base URL
// that came from the persisted identity (not env) is dropped with it.
func (s *Syncer) ClearIdentity() {
	envBase := os.Getenv("TH_SYNC_URL")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.BaseURL = envBase
	s.Handle = os.Getenv("TH_SYNC_HANDLE")
	if s.Handle == "" {
		s.Handle = os.Getenv("USER")
	}
	s.Team = os.Getenv("TH_SYNC_TEAM")
	s.UserID = os.Getenv("TH_SYNC_USER_ID")
}

func (s *Syncer) enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.BaseURL != ""
}

func (s *Syncer) envelope() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"machine_id":    machineID(),
		"machine_alias": machineAlias(),
		"handle":        s.Handle,
		"team":          s.Team,
		"user_id":       s.UserID,
	}
}

func (s *Syncer) post(path string, payload any) error {
	s.mu.Lock()
	base := s.BaseURL
	s.mu.Unlock()
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	url := base + path
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.httpc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("sync POST %s: HTTP %d", path, res.StatusCode)
	}
	return nil
}

// maxPagesPerSync bounds the drain loop; inserts arriving mid-drain keep the
// cursor moving forward, so the cap just defers the remainder to the next
// tick/nudge.
const maxPagesPerSync = 40

// Sync pushes all pending deltas, draining the backlog page by page until
// caught up. Cursors advance only for acknowledged datasets. Safe to call
// offline (errors, pushes nothing, backs off 60s).
func (s *Syncer) Sync(store *Store) SyncReport {
	if !s.enabled() {
		return SyncReport{Skipped: []string{datasetUsageEvents, datasetLimits}}
	}
	s.mu.Lock()
	if s.now().Before(s.backoffUntil) {
		s.mu.Unlock()
		return SyncReport{Error: "backing off"}
	}
	s.mu.Unlock()

	report := SyncReport{Pushed: map[string]int{}}
	err := func() error {
		n, err := s.drainUsage(store)
		if err != nil {
			return err
		}
		report.Pushed[datasetUsageEvents] = n
		m, err := s.drainLimits(store)
		if err != nil {
			return err
		}
		report.Pushed[datasetLimits] = m
		return nil
	}()
	if err != nil {
		report.Error = err.Error()
		s.mu.Lock()
		s.backoffUntil = s.now().Add(60 * time.Second)
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.lastReport = &report
	if report.Error == "" {
		s.lastSync = s.now()
	}
	s.mu.Unlock()
	return report
}

func (s *Syncer) drainUsage(store *Store) (int, error) {
	total := 0
	for range maxPagesPerSync {
		cursorStr, err := store.SyncCursor(datasetUsageEvents)
		if err != nil {
			return total, err
		}
		cursor, _ := strconv.ParseInt(cursorStr, 10, 64)
		events, last, err := store.EventsAfter(cursor, s.BatchSize)
		if err != nil {
			return total, err
		}
		if len(events) == 0 {
			return total, nil
		}
		rows := make([]map[string]any, 0, len(events))
		for _, e := range events {
			rows = append(rows, map[string]any{
				"id":         e.ID,
				"ts":         e.Timestamp,
				"machine_id": e.MachineID,
				"source":     e.Source,
				"vendor":     Vendor(e.Vendor),
				"model":      Model(e.Vendor, e.Model),
				"tokens": map[string]any{
					"input": e.Tokens.Input, "output": e.Tokens.Output,
					"reasoning": e.Tokens.Reasoning, "cache_read": e.Tokens.CacheRead,
					"cache_write": e.Tokens.CacheWrite,
				},
				"cost":        e.Cost,
				"cost_source": e.CostSource,
				"session":     e.SessionID,
				"product":     e.Product,
				"account_id":  e.AccountID,
				"request_id":  e.RequestID,
				"attestation": e.Attestation,
			})
		}
		payload := s.envelope()
		payload["rows"] = rows
		if err := s.post("/ingest/events", payload); err != nil {
			return total, err
		}
		if err := store.SetSyncCursor(datasetUsageEvents, strconv.FormatInt(last, 10)); err != nil {
			return total, err
		}
		total += len(events)
		if len(events) < s.BatchSize {
			break
		}
	}
	return total, nil
}

func (s *Syncer) drainLimits(store *Store) (int, error) {
	total := 0
	var lastCursor string
	for range maxPagesPerSync {
		cursorStr, err := store.SyncCursor(datasetLimits)
		if err != nil {
			return total, err
		}
		sinceEpoch, _ := strconv.ParseInt(cursorStr, 10, 64)
		snaps, err := store.LimitHistory(sinceEpoch, s.now().Unix(), s.BatchSize)
		if err != nil {
			return total, err
		}
		if len(snaps) == 0 {
			return total, nil
		}
		rows := make([]map[string]any, 0, len(snaps))
		var maxAt int64
		for _, sn := range snaps {
			if sn.RecordedAt > maxAt {
				maxAt = sn.RecordedAt
			}
			rows = append(rows, map[string]any{
				"recorded_at":  sn.RecordedAt,
				"machine_id":   sn.MachineID,
				"provider":     Vendor(sn.Provider),
				"account_id":   sn.AccountID,
				"label":        sn.Label,
				"used_percent": sn.UsedPercent,
				"resets_at":    sn.ResetsAt,
				"detail":       sn.Detail,
			})
		}
		payload := s.envelope()
		payload["rows"] = rows
		if err := s.post("/ingest/limits", payload); err != nil {
			return total, err
		}
		if err := store.SetSyncCursor(datasetLimits, strconv.FormatInt(maxAt, 10)); err != nil {
			return total, err
		}
		total += len(snaps)
		if len(snaps) < s.BatchSize {
			break
		}
		// The limits cursor is epoch-second inclusive — stop if it stalls.
		if cursorStr == lastCursor {
			break
		}
		lastCursor = cursorStr
	}
	return total, nil
}

// noteActivity is the ingestion nudge: debounced (4s), burst-coalescing,
// backoff-aware, no-op when disabled.
func (s *Syncer) noteActivity(store *Store) {
	if !s.enabled() {
		return
	}
	s.mu.Lock()
	if s.nudgePending {
		s.mu.Unlock()
		return
	}
	s.nudgePending = true
	s.mu.Unlock()
	time.AfterFunc(4*time.Second, func() {
		s.mu.Lock()
		s.nudgePending = false
		s.mu.Unlock()
		s.Sync(store)
	})
}

// Status for GET /sync/status.
func (s *Syncer) Status(store *Store) map[string]any {
	cursors := map[string]string{}
	for _, ds := range []string{datasetUsageEvents, datasetLimits} {
		c, _ := store.SyncCursor(ds)
		cursors[ds] = c
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{
		"enabled": s.BaseURL != "",
		"cursors": cursors,
		"handle":  s.Handle,
		"user_id": s.UserID,
	}
	if !s.lastSync.IsZero() {
		out["last_sync"] = s.lastSync.Unix()
	} else {
		out["last_sync"] = nil
	}
	if s.lastReport != nil {
		out["last_report"] = s.lastReport
	}
	return out
}
