// Package sync holds the cloud/machine sync pathways: what has the server
// seen from a device (high-water + reference counts), which rows are new
// (delta plan), what does the fleet look like, and usage rollups for
// leaderboards and team views.
package sync

import (
	"context"
	"errors"
	"time"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
)

// Sync exposes the sync + rollup read pathways.
type Sync struct {
	Store store.Store
}

// Status answers "what have you seen from this machine?" — the daemon uses
// it to reconcile after offline stretches (compare against local cursors).
// KnownEvents/KnownLimits count rows in the delta-sync reference table
// (sync_row_refs): how many payload rows the server has ever accepted from
// this device, per dataset.
type Status struct {
	MachineID   string    `json:"machine_id"`
	EventsMaxTS time.Time `json:"events_max_ts"`
	EventsCount int64     `json:"events_count"`
	LimitsMaxTS time.Time `json:"limits_max_ts"`
	KnownEvents int64     `json:"known_events"`
	KnownLimits int64     `json:"known_limits"`
	ServerTime  time.Time `json:"server_time"`
}

func (s Sync) Status(ctx context.Context, machineID string) (Status, error) {
	ets, count, lts, err := s.Store.HighWater(ctx, machineID)
	if err != nil {
		return Status{}, err
	}
	knownEvents, err := s.Store.RefCount(ctx, machineID, store.DatasetUsageEvents)
	if err != nil {
		return Status{}, err
	}
	knownLimits, err := s.Store.RefCount(ctx, machineID, store.DatasetLimitSnapshots)
	if err != nil {
		return Status{}, err
	}
	return Status{
		MachineID:   machineID,
		EventsMaxTS: ets,
		EventsCount: count,
		LimitsMaxTS: lts,
		KnownEvents: knownEvents,
		KnownLimits: knownLimits,
		ServerTime:  time.Now().UTC(),
	}, nil
}

// MaxPlanIDs caps one sync-plan candidate list.
const MaxPlanIDs = 10000

// Plan is the delta-sync handshake: the daemon lists the row ids it MIGHT
// push, the server answers with only the ones it has never seen (from the
// per-machine sync_row_refs reference table — never a payload-table scan),
// and the daemon then pushes just those. Row ids: usage_events → event
// UUIDs; limit_snapshots → dedup keys
// (machine|provider|account|label|minute-RFC3339).
type Plan struct {
	MachineID string   `json:"machine_id"`
	Dataset   string   `json:"dataset"`
	Known     int      `json:"known"`
	Missing   []string `json:"missing"`
}

func (s Sync) PlanRows(ctx context.Context, machineID, dataset string, ids []string) (Plan, error) {
	if machineID == "" {
		return Plan{}, errors.New("machine_id required")
	}
	switch dataset {
	case store.DatasetUsageEvents, store.DatasetLimitSnapshots:
	default:
		return Plan{}, errors.New("unknown dataset " + dataset)
	}
	if len(ids) > MaxPlanIDs {
		return Plan{}, errors.New("plan: candidate list exceeds 10000")
	}
	missing, err := s.Store.FilterMissingRows(ctx, machineID, dataset, ids)
	if err != nil {
		return Plan{}, err
	}
	if missing == nil {
		missing = []string{}
	}
	return Plan{MachineID: machineID, Dataset: dataset, Known: len(ids) - len(missing), Missing: missing}, nil
}

// FleetMachines lists every device registered to a user (by handle).
func (s Sync) FleetMachines(ctx context.Context, handle string) (Fleet, error) {
	user, err := s.Store.ResolveUser(ctx, handle, handle, "")
	if err != nil {
		return Fleet{}, err
	}
	machines, err := s.Store.Machines(ctx, user.ID)
	if err != nil {
		return Fleet{}, err
	}
	views := make([]MachineView, 0, len(machines))
	for _, m := range machines {
		views = append(views, MachineView{
			MachineID: m.MachineID,
			Alias:     m.Alias,
			Platform:  m.Platform,
			LastSeen:  m.LastSeen,
		})
	}
	return Fleet{User: user.Handle, Machines: views}, nil
}

// Fleet is one user's device fleet.
type Fleet struct {
	User     string        `json:"user"`
	Machines []MachineView `json:"machines"`
}

// MachineView is the JSON shape for a fleet device.
type MachineView struct {
	MachineID string    `json:"machine_id"`
	Alias     string    `json:"alias"`
	Platform  string    `json:"platform"`
	LastSeen  time.Time `json:"last_seen_at"`
}

// Summary reads usage rollups: per-vendor/model totals over a window,
// scoped to a user, a team, or the whole fleet. Leaderboards aggregate
// these rows cloud-side — the server never stores ranking state.
func (s Sync) Summary(ctx context.Context, handle, team, vendor string, since time.Time) ([]store.VendorSummary, error) {
	if handle == "" && team == "" {
		return nil, errors.New("summary: handle or team required")
	}
	if since.IsZero() {
		since = time.Now().UTC().Add(-30 * 24 * time.Hour)
	}
	if since.After(time.Now().UTC().Add(time.Hour)) {
		return nil, errors.New("summary: since is in the future")
	}
	return s.Store.UsageSummary(ctx, store.SummaryQuery{
		Handle: handle,
		Team:   team,
		Since:  since,
		Vendor: vendor,
	})
}
