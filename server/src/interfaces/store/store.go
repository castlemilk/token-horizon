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

	// Leaderboard: per-user aggregates + active days for streaks.
	BoardTotals(ctx context.Context, team string, since time.Time) ([]BoardRow, error)
	BoardTotalsRange(ctx context.Context, team string, since, until time.Time) ([]BoardRow, error)
	BoardDays(ctx context.Context, team string, since time.Time, limitDays int) (map[string][]time.Time, error)

	// Identity: login, sessions, profile.
	ResolveUserByProvider(ctx context.Context, provider, sub string) (models.User, error)
	UserByHandle(ctx context.Context, handle string) (models.User, error)
	UserByID(ctx context.Context, id string) (models.User, error)
	LinkProvider(ctx context.Context, userID, provider, sub, email, avatarURL string) error
	UpdateUser(ctx context.Context, userID, displayName, handle, avatarURL string) (models.User, error)
	CreateSession(ctx context.Context, sess models.Session) error
	SessionByToken(ctx context.Context, tokenHash string) (models.Session, error)
	DeleteSession(ctx context.Context, tokenHash string) error
	CreateTicket(ctx context.Context, t models.Ticket) error
	AttachTicketSession(ctx context.Context, state, sessionID string) error
	Ticket(ctx context.Context, state string) (models.Ticket, error)
	ClaimTicket(ctx context.Context, state string) (models.Ticket, error)

	// Teams + groups.
	CreateTeam(ctx context.Context, id, slug, name, joinCode, ownerID string) (models.Team, error)
	MyTeams(ctx context.Context, userID string) ([]models.Team, error)
	TeamByJoinCode(ctx context.Context, code string) (models.Team, error)
	AddTeamMember(ctx context.Context, teamID, userID, role string) error
	LeaveTeamMember(ctx context.Context, teamID, userID string) error
	IsTeamMember(ctx context.Context, teamID, userID string) (bool, error)
	CreateGroup(ctx context.Context, id, teamID, slug, name, joinCode, ownerID string) (models.Group, error)
	GroupsByTeam(ctx context.Context, teamID, userID string) ([]models.Group, error)
	GroupByJoinCode(ctx context.Context, code string) (models.Group, error)
	AddGroupMember(ctx context.Context, groupID, userID, role string) error
	LeaveGroupMember(ctx context.Context, groupID, userID string) error
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

// BoardRow is one user's leaderboard aggregate.
type BoardRow struct {
	UserID      string  `json:"-"`
	Handle      string  `json:"handle"`
	DisplayName string  `json:"display_name"`
	AvatarURL   string  `json:"avatar_url"`
	Tokens      int64   `json:"tokens"`
	Cost        float64 `json:"cost"`
	Requests    int64   `json:"requests"`
	Machines    int     `json:"machines"`
}
