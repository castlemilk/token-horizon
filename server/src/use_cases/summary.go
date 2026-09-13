package usecases

import (
	"context"
	"errors"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
)

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
