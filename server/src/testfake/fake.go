// Package testfake is an in-memory store.Store for unit tests. No SQL,
// no drivers — it verifies use-case and handler logic only. SQL dialect is
// proven separately by the duckdb integration test (store_duck_test.go).
package testfake

import (
	"context"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models"
)

// Fake is a mutex-guarded in-memory Store.
type Fake struct {
	mu      sync.Mutex
	Users   map[string]models.User
	Machine map[string]models.Machine
	Events  []models.UsageEvent
	Limits  []models.LimitSnapshot
	Cursors map[string]string
	Err     error // injected failure for error paths
}

func New() *Fake {
	return &Fake{Users: map[string]models.User{}, Machine: map[string]models.Machine{}, Cursors: map[string]string{}}
}

func (f *Fake) Close() error { return nil }

func (f *Fake) ResolveUser(_ context.Context, handle, displayName, team string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return models.User{}, f.Err
	}
	if u, ok := f.Users[handle]; ok {
		u.DisplayName, u.Team = displayName, team
		f.Users[handle] = u
		return u, nil
	}
	now := time.Now().UTC()
	u := models.User{ID: "user-" + handle, Handle: handle, DisplayName: displayName, Team: team, CreatedAt: now, UpdatedAt: now}
	f.Users[handle] = u
	return u, nil
}

func (f *Fake) RegisterMachine(_ context.Context, m models.Machine) (models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if old, ok := f.Machine[m.MachineID]; ok {
		old.UserID, old.Alias, old.Platform, old.LastSeen = m.UserID, m.Alias, m.Platform, m.LastSeen
		f.Machine[m.MachineID] = old
		return old, nil
	}
	f.Machine[m.MachineID] = m
	return m, nil
}

func (f *Fake) Machines(_ context.Context, userID string) ([]models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []models.Machine
	for _, m := range f.Machine {
		if m.UserID == userID {
			out = append(out, m)
		}
	}
	return out, nil
}

func (f *Fake) MachineByID(_ context.Context, machineID string) (models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Machine[machineID], nil
}

func (f *Fake) InsertEvents(_ context.Context, _ string, events []models.UsageEvent) (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range f.Events {
		seen[e.ID] = true
	}
	accepted, dups := 0, 0
	for _, e := range events {
		if seen[e.ID] {
			dups++
			continue
		}
		seen[e.ID] = true
		f.Events = append(f.Events, e)
		accepted++
	}
	return accepted, dups, nil
}

func (f *Fake) InsertLimits(_ context.Context, _ string, snaps []models.LimitSnapshot) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Limits = append(f.Limits, snaps...)
	return len(snaps), nil
}

func (f *Fake) HighWater(_ context.Context, machineID string) (time.Time, int64, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ets, lts time.Time
	var n int64
	for _, e := range f.Events {
		if e.MachineID == machineID {
			n++
			if e.Timestamp.After(ets) {
				ets = e.Timestamp
			}
		}
	}
	for _, l := range f.Limits {
		if l.MachineID == machineID && l.RecordedAt.After(lts) {
			lts = l.RecordedAt
		}
	}
	return ets, n, lts, nil
}

func (f *Fake) UsageSummary(_ context.Context, q store.SummaryQuery) ([]store.VendorSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	byVendor := map[string]*store.VendorSummary{}
	for _, e := range f.Events {
		if !q.Since.IsZero() && e.Timestamp.Before(q.Since) {
			continue
		}
		if q.Vendor != "" && e.Vendor != q.Vendor {
			continue
		}
		v := byVendor[e.Vendor]
		if v == nil {
			v = &store.VendorSummary{Vendor: e.Vendor}
			byVendor[e.Vendor] = v
		}
		v.Tokens += e.Tokens.Total()
		v.Cost += e.Cost
		v.Requests++
	}
	var out []store.VendorSummary
	for _, v := range byVendor {
		out = append(out, *v)
	}
	return out, nil
}

func (f *Fake) SetCursor(_ context.Context, dataset, machineID, cursor string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Cursors[dataset+"|"+machineID] = cursor
	return nil
}

func (f *Fake) Cursor(_ context.Context, dataset, machineID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Cursors[dataset+"|"+machineID], nil
}
