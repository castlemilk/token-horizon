//go:build duckdb

// Integration proof for the SQL dialect: migrates a fresh in-memory DuckDB
// and runs the whole store contract through it (identity, idempotent
// ingest, rollups, cursors). Needs the duckdb build tag:
//
//	go test -tags duckdb ./src/interfaces/store/sqlstore/
package sqlstore

import (
	"context"
	"database/sql"
	"testing"
	"time"

	_ "github.com/duckdb/duckdb-go/v2"

	"github.com/castlemilk/token-horizon/cloud/server/migrations"
	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/identity"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/usage"
)

func openMigrated(t *testing.T) *SQLStore {
	t.Helper()
	db, err := sql.Open("duckdb", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	files, err := migrations.DuckDB.ReadDir("duckdb")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		raw, err := migrations.DuckDB.ReadFile("duckdb/" + f.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(raw)); err != nil {
			t.Fatalf("%s: %v", f.Name(), err)
		}
	}
	t.Cleanup(func() { db.Close() })
	return &SQLStore{db: db}
}

func TestDuckDBIdentityAndIdempotentIngest(t *testing.T) {
	ctx := context.Background()
	s := openMigrated(t)

	u, err := s.ResolveUser(ctx, "ada", "Ada", "core")
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.RegisterMachine(ctx, identity.Machine{
		MachineID: "m-1", UserID: u.ID, Alias: "lab", Platform: "Linux", LastSeen: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.Alias != "lab" || m.UserID != u.ID {
		t.Fatalf("machine: %+v", m)
	}

	mk := func(id string) usage.UsageEvent {
		return usage.UsageEvent{
			ID: id, Timestamp: time.Now().UTC(), MachineID: "m-1",
			Source: "external", Vendor: "kimi", Model: "k3",
			Tokens:      usage.TokenBreakdown{Input: 100, Output: 20},
			Attestation: "measured",
		}
	}
	a, d, err := s.InsertEvents(ctx, u.ID, []usage.UsageEvent{mk("e-1"), mk("e-2")})
	if err != nil || a != 2 || d != 0 {
		t.Fatalf("a=%d d=%d err=%v", a, d, err)
	}
	a, d, err = s.InsertEvents(ctx, u.ID, []usage.UsageEvent{mk("e-1")})
	if err != nil || a != 0 || d != 1 {
		t.Fatalf("redelivery: a=%d d=%d err=%v", a, d, err)
	}

	if _, err := s.InsertLimits(ctx, u.ID, []usage.LimitSnapshot{{
		ID: "l-1", RecordedAt: time.Now().UTC(), MachineID: "m-1",
		Provider: "kimi", Label: "5h", UsedPercent: 48,
	}}); err != nil {
		t.Fatal(err)
	}
	// Same natural minute dedups.
	if _, err := s.InsertLimits(ctx, u.ID, []usage.LimitSnapshot{{
		ID: "l-2", RecordedAt: time.Now().UTC(), MachineID: "m-1",
		Provider: "kimi", Label: "5h", UsedPercent: 49,
	}}); err != nil {
		t.Fatal(err)
	}

	ets, count, _, err := s.HighWater(ctx, "m-1")
	if err != nil || count != 2 || ets.IsZero() {
		t.Fatalf("highwater: %v %d %v", ets, count, err)
	}
	rows, err := s.UsageSummary(ctx, store.SummaryQuery{Handle: "ada"})
	if err != nil || len(rows) != 1 || rows[0].Tokens != 240 || rows[0].Requests != 2 {
		t.Fatalf("summary: %+v %v", rows, err)
	}
	if err := s.SetCursor(ctx, "usage_events", "m-1", "42"); err != nil {
		t.Fatal(err)
	}
	c, err := s.Cursor(ctx, "usage_events", "m-1")
	if err != nil || c != "42" {
		t.Fatalf("cursor=%q err=%v", c, err)
	}
	if c, _ := s.Cursor(ctx, "usage_events", "nope"); c != "" {
		t.Fatalf("unset cursor=%q", c)
	}
}

func TestDuckDBLeaderboard(t *testing.T) {
	ctx := context.Background()
	s := openMigrated(t)

	u, _ := s.ResolveUser(ctx, "ada", "Ada", "")
	mid := "m-1"
	if _, err := s.RegisterMachine(ctx, identity.Machine{
		MachineID: mid, UserID: u.ID, Alias: "lab", LastSeen: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	mk := func(id string, at time.Time, input int64) usage.UsageEvent {
		return usage.UsageEvent{
			ID: id, Timestamp: at, MachineID: mid,
			Source: "external", Vendor: "kimi", Model: "k3",
			Tokens: usage.TokenBreakdown{Input: input}, Attestation: "measured",
		}
	}
	now := time.Now().UTC()
	day := func(off int) time.Time { return now.Add(time.Duration(-off*24) * time.Hour) }
	if _, _, err := s.InsertEvents(ctx, u.ID, []usage.UsageEvent{
		mk("b-1", day(0), 300), mk("b-2", day(1), 100),
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.BoardTotals(ctx, store.BoardScope{}, day(0).Truncate(24*time.Hour), "tokens")
	if err != nil || len(rows) != 1 || rows[0].Tokens != 300 || rows[0].Machines != 1 {
		t.Fatalf("board=%+v err=%v", rows, err)
	}
	days, err := s.BoardDays(ctx, store.BoardScope{}, day(0).Add(-72*time.Hour), 400)
	if err != nil || len(days["ada"]) != 2 {
		t.Fatalf("days=%+v err=%v", days, err)
	}
}

func TestDuckDBFollowsAndSyncPlan(t *testing.T) {
	ctx := context.Background()
	s := openMigrated(t)

	ada, err := s.ResolveUser(ctx, "ada", "Ada", "")
	if err != nil {
		t.Fatal(err)
	}
	grace, err := s.ResolveUser(ctx, "grace", "Grace", "")
	if err != nil {
		t.Fatal(err)
	}

	// Follow edges are idempotent; lists see both sides.
	if err := s.Follow(ctx, ada.ID, grace.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Follow(ctx, ada.ID, grace.ID); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.IsFollowing(ctx, ada.ID, grace.ID); err != nil || !ok {
		t.Fatalf("isfollowing=%v err=%v", ok, err)
	}
	following, err := s.Following(ctx, ada.ID)
	if err != nil || len(following) != 1 || following[0].Handle != "grace" {
		t.Fatalf("following=%+v err=%v", following, err)
	}
	followers, err := s.Followers(ctx, grace.ID)
	if err != nil || len(followers) != 1 || followers[0].Handle != "ada" {
		t.Fatalf("followers=%+v err=%v", followers, err)
	}

	// Follow-scoped board sees the followee + self, nobody else.
	hopper, err := s.ResolveUser(ctx, "hopper", "Hopper", "")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(id, machine string, input int64) usage.UsageEvent {
		return usage.UsageEvent{
			ID: id, Timestamp: time.Now().UTC(), MachineID: machine,
			Source: "external", Vendor: "kimi", Model: "k3",
			Tokens: usage.TokenBreakdown{Input: input}, Attestation: "measured",
		}
	}
	if _, _, err := s.InsertEvents(ctx, ada.ID, []usage.UsageEvent{mk("f-1", "m-ada", 300)}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.InsertEvents(ctx, grace.ID, []usage.UsageEvent{mk("f-2", "m-grace", 100)}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.InsertEvents(ctx, hopper.ID, []usage.UsageEvent{mk("f-3", "m-hopper", 999)}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.BoardTotals(ctx, store.BoardScope{FollowingOf: ada.ID}, time.Now().Add(-time.Hour), "")
	if err != nil || len(rows) != 2 {
		t.Fatalf("following board=%+v err=%v", rows, err)
	}

	// Delta-sync refs: ingest recorded them; plan answers from refs alone.
	missing, err := s.FilterMissingRows(ctx, "m-ada", store.DatasetUsageEvents, []string{"f-1", "f-new"})
	if err != nil || len(missing) != 1 || missing[0] != "f-new" {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}
	if n, err := s.RefCount(ctx, "m-ada", store.DatasetUsageEvents); err != nil || n != 1 {
		t.Fatalf("refcount=%d err=%v", n, err)
	}

	if err := s.Unfollow(ctx, ada.ID, grace.ID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.IsFollowing(ctx, ada.ID, grace.ID); ok {
		t.Fatal("still following after unfollow")
	}
}

// Groups ride ranking rows (multi-membership), the last-IP geo hint
// round-trips, and board rows carry the country code column.
func TestDuckDBUserGroupsAndTouchIP(t *testing.T) {
	ctx := context.Background()
	s := openMigrated(t)

	ada, _ := s.ResolveUser(ctx, "ada", "Ada", "")
	if _, err := s.ResolveUser(ctx, "grace", "Grace", ""); err != nil {
		t.Fatal(err)
	}

	// ada: one team + two groups inside it (multi-group membership).
	team, err := s.CreateTeam(ctx, "t-1", "core", "Core Team", "code-t1", ada.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddTeamMember(ctx, team.ID, ada.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateGroup(ctx, "g-1", team.ID, "infra", "Infra", "code-g1", ada.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateGroup(ctx, "g-2", team.ID, "evals", "Evals", "code-g2", ada.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddGroupMember(ctx, "g-1", ada.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if err := s.AddGroupMember(ctx, "g-2", ada.ID, "member"); err != nil {
		t.Fatal(err)
	}

	groups, err := s.UserGroups(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups["ada"]) != 3 { // team chip + two group chips
		t.Fatalf("ada groups=%+v", groups["ada"])
	}
	if len(groups["grace"]) != 0 {
		t.Fatalf("grace groups=%+v", groups["grace"])
	}

	// last_ip updates; country_code stays empty until the mapping lands.
	if err := s.TouchUserIP(ctx, ada.ID, "203.0.113.7"); err != nil {
		t.Fatal(err)
	}
	got, err := s.UserByID(ctx, ada.ID)
	if err != nil || got.LastIP != "203.0.113.7" || got.CountryCode != "" {
		t.Fatalf("user=%+v err=%v", got, err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET country_code = 'NL' WHERE id = $1`, ada.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.InsertEvents(ctx, ada.ID, []usage.UsageEvent{{
		ID: "g-1", Timestamp: time.Now().UTC(), MachineID: "m-ada",
		Source: "external", Tokens: usage.TokenBreakdown{Input: 5}, Attestation: "measured",
	}}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.BoardTotals(ctx, store.BoardScope{}, time.Now().Add(-time.Hour), "tokens")
	if err != nil || len(rows) != 1 || rows[0].CountryCode != "NL" {
		t.Fatalf("board=%+v err=%v", rows, err)
	}
}
