// Package usage holds the metered-usage primitives: token breakdowns,
// usage events, limit snapshots, and sync cursors. Plain data +
// validation, no I/O, no business rules. Field names mirror the Swift Core
// contracts (UsageEvent, CloudSchema) so the wire stays obvious.
package usage

import (
	"errors"
	"time"
)

// TokenBreakdown mirrors TokenBreakdown. Net semantics: Input excludes
// cache hits, Output excludes reasoning — meters subtract the wire subsets
// before storing, so Total equals provider ground truth.
type TokenBreakdown struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// Total is the sum of all categories (== provider gross under net semantics).
func (t TokenBreakdown) Total() int64 {
	return t.Input + t.Output + t.Reasoning + t.CacheRead + t.CacheWrite
}

// Validate rejects negative counters.
func (t TokenBreakdown) Validate() error {
	if t.Input < 0 || t.Output < 0 || t.Reasoning < 0 || t.CacheRead < 0 || t.CacheWrite < 0 {
		return errors.New("tokens: negative counter")
	}
	return nil
}

// Enumerations ride the wire as their Swift raw values.
var (
	validSources      = map[string]bool{"external": true, "selfManaged": true, "gateway": true}
	validAttestations = map[string]bool{"selfReported": true, "measured": true, "reconciled": true, "gatewayMetered": true}
)

// UsageEvent is one measured request, UUID-keyed so redelivery merges
// conflict-free (INSERT … ON CONFLICT DO NOTHING on id).
type UsageEvent struct {
	ID          string         `json:"id"`
	Timestamp   time.Time      `json:"timestamp"`
	MachineID   string         `json:"machine_id"`
	Source      string         `json:"source"`
	Vendor      string         `json:"vendor"`
	Model       string         `json:"model"`
	Tokens      TokenBreakdown `json:"tokens"`
	Cost        float64        `json:"cost"`
	CostSource  string         `json:"cost_source"`
	SessionID   string         `json:"session"`
	Product     string         `json:"product"`
	AccountID   string         `json:"account_id"`
	RequestID   string         `json:"request_id"`
	Attestation string         `json:"attestation"`
}

func (e UsageEvent) Validate() error {
	if e.ID == "" {
		return errors.New("event: missing id")
	}
	if e.MachineID == "" {
		return errors.New("event: missing machine_id")
	}
	if e.Vendor == "" {
		return errors.New("event: missing vendor")
	}
	if !validSources[e.Source] {
		return errors.New("event: bad source " + e.Source)
	}
	if !validAttestations[e.Attestation] {
		return errors.New("event: bad attestation " + e.Attestation)
	}
	if e.Timestamp.IsZero() {
		return errors.New("event: missing timestamp")
	}
	return e.Tokens.Validate()
}

// LimitSnapshot is one quota-window observation for the limits timeline.
type LimitSnapshot struct {
	ID          string    `json:"id"`
	RecordedAt  time.Time `json:"recorded_at"`
	MachineID   string    `json:"machine_id"`
	Provider    string    `json:"provider"`
	AccountID   string    `json:"account_id"`
	Label       string    `json:"label"`
	UsedPercent float64   `json:"used_percent"`
	ResetsAt    time.Time `json:"resets_at"`
	HasReset    bool      `json:"-"`
	Detail      string    `json:"detail"`
}

func (s LimitSnapshot) Validate() error {
	if s.MachineID == "" {
		return errors.New("limit: missing machine_id")
	}
	if s.Provider == "" || s.Label == "" {
		return errors.New("limit: missing provider/label")
	}
	if s.RecordedAt.IsZero() {
		return errors.New("limit: missing recorded_at")
	}
	return nil
}

// DedupKey is the natural identity of a limit snapshot: one row per
// (machine, provider, account, label, minute). Retries collapse onto it;
// the delta-sync reference table stores it as the row id.
func (s LimitSnapshot) DedupKey() string {
	return s.MachineID + "|" + s.Provider + "|" + s.AccountID + "|" + s.Label +
		"|" + s.RecordedAt.UTC().Truncate(time.Minute).Format(time.RFC3339)
}

// SyncCursor is server-side high-water per dataset per machine, so clients
// can reconcile ("what have you seen from me?").
type SyncCursor struct {
	Dataset   string    `json:"dataset"`
	MachineID string    `json:"machine_id"`
	Cursor    string    `json:"cursor"`
	UpdatedAt time.Time `json:"updated_at"`
}
