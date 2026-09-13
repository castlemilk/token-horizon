// Package models holds the server's primitives: plain data + validation,
// no I/O, no business rules. Field names mirror the Swift Core contracts
// (UsageEvent, CloudSchema, MachineIdentity) so the wire stays obvious.
package models

import (
	"errors"
	"strings"
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

// User is one logged-in human. Handle is the identity the daemon reports
// (TH_SYNC_HANDLE, defaulting to the OS username) — unique, human-meaningful.
type User struct {
	ID          string    `json:"id"`
	Handle      string    `json:"handle"`
	DisplayName string    `json:"display_name"`
	Team        string    `json:"team"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Machine is one device reporting to the server, always owned by a user.
// MachineID is the stable per-device UUID minted by the daemon;
// Alias is the display label (never identity).
type Machine struct {
	ID        string    `json:"id"`
	MachineID string    `json:"machine_id"`
	UserID    string    `json:"user_id"`
	Alias     string    `json:"alias"`
	Platform  string    `json:"platform"`
	LastSeen  time.Time `json:"last_seen_at"`
	CreatedAt time.Time `json:"created_at"`
}

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

// SyncCursor is server-side high-water per dataset per machine, so clients
// can reconcile ("what have you seen from me?").
type SyncCursor struct {
	Dataset   string    `json:"dataset"`
	MachineID string    `json:"machine_id"`
	Cursor    string    `json:"cursor"`
	UpdatedAt time.Time `json:"updated_at"`
}

// NormalizeHandle folds a reported handle to canonical form (the daemon
// sends the OS username verbatim; matching must be case/space-insensitive).
func NormalizeHandle(h string) string {
	return strings.ToLower(strings.TrimSpace(h))
}
