// Package store defines the persistence port: what the use cases need,
// nothing about SQL. The adapter lives in the sqlstore subpackage
// (database/sql over Postgres and DuckDB); an in-memory fake for unit
// tests lives in the testfake subpackage.
package store

import (
	"context"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/models/social"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
)

// Store is the full persistence contract. Implementations must be safe for
// concurrent use; event/limit writes are idempotent by natural key.
type Store interface {
	// Users + machines (identity).
	ResolveUser(ctx context.Context, handle, displayName, team string) (identity.User, error)
	RegisterMachine(ctx context.Context, m identity.Machine) (identity.Machine, error)
	Machines(ctx context.Context, userID string) ([]identity.Machine, error)
	MachineByID(ctx context.Context, machineID string) (identity.Machine, error)

	// Metered rows (idempotent ingest).
	InsertEvents(ctx context.Context, userID string, events []usage.UsageEvent) (accepted, duplicates int, err error)
	InsertLimits(ctx context.Context, userID string, snaps []usage.LimitSnapshot) (accepted int, err error)

	// Sync pathways (high-water + rollups).
	HighWater(ctx context.Context, machineID string) (eventsMaxTS time.Time, eventsCount int64, limitsMaxTS time.Time, err error)
	UsageSummary(ctx context.Context, q SummaryQuery) ([]VendorSummary, error)
	SetCursor(ctx context.Context, dataset, machineID, cursor string) error
	Cursor(ctx context.Context, dataset, machineID string) (string, error)

	// Delta-sync reference table (sync_row_refs): which payload rows has
	// this machine already delivered? FilterMissingRows answers the plan
	// question so daemons push only new rows, never the whole table.
	FilterMissingRows(ctx context.Context, machineID, dataset string, ids []string) (missing []string, err error)
	RefCount(ctx context.Context, machineID, dataset string) (int64, error)

	// Leaderboard: per-user aggregates + active days for streaks, scoped
	// by team, group, or the caller's follow graph (BoardScope).
	BoardTotals(ctx context.Context, scope BoardScope, since time.Time) ([]BoardRow, error)
	BoardTotalsRange(ctx context.Context, scope BoardScope, since, until time.Time) ([]BoardRow, error)
	BoardDays(ctx context.Context, scope BoardScope, since time.Time, limitDays int) (map[string][]time.Time, error)

	// Identity: login, sessions, profile.
	ResolveUserByProvider(ctx context.Context, provider, sub string) (identity.User, error)
	UserByHandle(ctx context.Context, handle string) (identity.User, error)
	UserByID(ctx context.Context, id string) (identity.User, error)
	LinkProvider(ctx context.Context, userID, provider, sub, email, avatarURL string) error
	UpdateUser(ctx context.Context, userID, displayName, handle, avatarURL, bio string) (identity.User, error)
	CreateSession(ctx context.Context, sess identity.Session) error
	SessionByToken(ctx context.Context, tokenHash string) (identity.Session, error)
	DeleteSession(ctx context.Context, tokenHash string) error
	CreateTicket(ctx context.Context, t identity.Ticket) error
	AttachTicketSession(ctx context.Context, state, sessionID string) error
	Ticket(ctx context.Context, state string) (identity.Ticket, error)
	ClaimTicket(ctx context.Context, state string) (identity.Ticket, error)

	// Follow/follower graph (asymmetric; edges idempotent by key).
	Follow(ctx context.Context, followerID, followeeID string) error
	Unfollow(ctx context.Context, followerID, followeeID string) error
	Followers(ctx context.Context, userID string) ([]social.FollowUser, error)
	Following(ctx context.Context, userID string) ([]social.FollowUser, error)
	IsFollowing(ctx context.Context, followerID, followeeID string) (bool, error)

	// Teams + groups.
	CreateTeam(ctx context.Context, id, slug, name, joinCode, ownerID string) (social.Team, error)
	MyTeams(ctx context.Context, userID string) ([]social.Team, error)
	TeamByJoinCode(ctx context.Context, code string) (social.Team, error)
	AddTeamMember(ctx context.Context, teamID, userID, role string) error
	LeaveTeamMember(ctx context.Context, teamID, userID string) error
	IsTeamMember(ctx context.Context, teamID, userID string) (bool, error)
	CreateGroup(ctx context.Context, id, teamID, slug, name, joinCode, ownerID string) (social.Group, error)
	GroupsByTeam(ctx context.Context, teamID, userID string) ([]social.Group, error)
	GroupByJoinCode(ctx context.Context, code string) (social.Group, error)
	AddGroupMember(ctx context.Context, groupID, userID, role string) error
	LeaveGroupMember(ctx context.Context, groupID, userID string) error
	Close() error
}

// Datasets the delta-sync reference table tracks (sync_row_refs.dataset).
const (
	DatasetUsageEvents    = "usage_events"
	DatasetLimitSnapshots = "limit_snapshots"
)

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

// BoardScope bounds a leaderboard read: everyone (zero value), one team
// (slug), one group (id), or the users a given user follows (plus
// themselves, so they see their own rank in context).
type BoardScope struct {
	TeamSlug    string
	GroupID     string
	FollowingOf string // user id
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
