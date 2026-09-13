// Package store defines the persistence port: what the use cases need,
// nothing about SQL. The sqlStore next door implements it over
// database/sql for both Postgres and DuckDB ($n placeholders, shared DDL
// shape — see migrations/).
package store

import (
	"context"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models"
)

// Store is the full persistence contract. Implementations must be safe for
// concurrent use; event/limit writes are idempotent by natural key.
type Store interface {
	// Users + machines (identity).
	ResolveUser(ctx context.Context, handle, displayName, team string) (models.User, error)
	RegisterMachine(ctx context.Context, m models.Machine) (models.Machine, error)
	Machines(ctx context.Context, userID string) ([]models.Machine, error)
	MachineByID(ctx context.Context, machineID string) (models.Machine, error)

	// Metered rows (idempotent ingest).
	InsertEvents(ctx context.Context, userID string, events []models.UsageEvent) (accepted, duplicates int, err error)
	InsertLimits(ctx context.Context, userID string, snaps []models.LimitSnapshot) (accepted int, err error)

	// Sync pathways (high-water + rollups).
	HighWater(ctx context.Context, machineID string) (eventsMaxTS time.Time, eventsCount int64, limitsMaxTS time.Time, err error)
	UsageSummary(ctx context.Context, q SummaryQuery) ([]VendorSummary, error)
	SetCursor(ctx context.Context, dataset, machineID, cursor string) error
	Cursor(ctx context.Context, dataset, machineID string) (string, error)
	Close() error
}

// SummaryQuery bounds a rollup read.
type SummaryQuery struct {
	Handle string
	Team   string
	Since  time.Time
	Vendor string // optional filter, "" = all
}

// VendorSummary is one row of a usage rollup (leaderboard fuel).
type VendorSummary struct {
	Vendor   string  `json:"vendor"`
	Model    string  `json:"model,omitempty"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
	Requests int64   `json:"requests"`
}
