package usecases

import (
	"context"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
)

// Sync exposes the cloud/machine sync pathways: what has the server seen
// from a device (high-water), and what does the fleet's usage look like
// (rollups for leaderboards and team views).
type Sync struct {
	Store store.Store
}

// Status answers "what have you seen from this machine?" — the daemon uses
// it to reconcile after offline stretches (compare against local cursors).
type Status struct {
	MachineID   string    `json:"machine_id"`
	EventsMaxTS time.Time `json:"events_max_ts"`
	EventsCount int64     `json:"events_count"`
	LimitsMaxTS time.Time `json:"limits_max_ts"`
	ServerTime  time.Time `json:"server_time"`
}

func (s Sync) Status(ctx context.Context, machineID string) (Status, error) {
	ets, count, lts, err := s.Store.HighWater(ctx, machineID)
	if err != nil {
		return Status{}, err
	}
	return Status{
		MachineID:   machineID,
		EventsMaxTS: ets,
		EventsCount: count,
		LimitsMaxTS: lts,
		ServerTime:  time.Now().UTC(),
	}, nil
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
