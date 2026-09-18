//go:build duckdb

// Integration proof for the SQL dialect: migrates a fresh in-memory DuckDB
// and runs the whole store contract through it (identity, idempotent
// ingest, rollups, cursors). Needs the duckdb build tag:
//
//	go test -tags duckdb ./src/interfaces/store/
package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	_ "github.com/duckdb/duckdb-go/v2"

	"github.com/castlemilk/token-horizon/server/migrations"
	"github.com/castlemilk/token-horizon/server/src/models"
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
	m, err := s.RegisterMachine(ctx, models.Machine{
		MachineID: "m-1", UserID: u.ID, Alias: "lab", Platform: "Linux", LastSeen: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.Alias != "lab" || m.UserID != u.ID {
		t.Fatalf("machine: %+v", m)
	}

	mk := func(id string) models.UsageEvent {
		return models.UsageEvent{
			ID: id, Timestamp: time.Now().UTC(), MachineID: "m-1",
			Source: "external", Vendor: "kimi", Model: "k3",
			Tokens:      models.TokenBreakdown{Input: 100, Output: 20},
			Attestation: "measured",
		}
	}
	a, d, err := s.InsertEvents(ctx, u.ID, []models.UsageEvent{mk("e-1"), mk("e-2")})
	if err != nil || a != 2 || d != 0 {
		t.Fatalf("a=%d d=%d err=%v", a, d, err)
	}
	a, d, err = s.InsertEvents(ctx, u.ID, []models.UsageEvent{mk("e-1")})
	if err != nil || a != 0 || d != 1 {
		t.Fatalf("redelivery: a=%d d=%d err=%v", a, d, err)
	}

	if _, err := s.InsertLimits(ctx, u.ID, []models.LimitSnapshot{{
		ID: "l-1", RecordedAt: time.Now().UTC(), MachineID: "m-1",
		Provider: "kimi", Label: "5h", UsedPercent: 48,
	}}); err != nil {
		t.Fatal(err)
	}
	// Same natural minute dedups.
	if _, err := s.InsertLimits(ctx, u.ID, []models.LimitSnapshot{{
		ID: "l-2", RecordedAt: time.Now().UTC(), MachineID: "m-1",
		Provider: "kimi", Label: "5h", UsedPercent: 49,
	}}); err != nil {
		t.Fatal(err)
	}

	ets, count, _, err := s.HighWater(ctx, "m-1")
	if err != nil || count != 2 || ets.IsZero() {
		t.Fatalf("highwater: %v %d %v", ets, count, err)
	}
	rows, err := s.UsageSummary(ctx, SummaryQuery{Handle: "ada"})
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
	if _, err := s.RegisterMachine(ctx, models.Machine{
		MachineID: mid, UserID: u.ID, Alias: "lab", LastSeen: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	mk := func(id string, at time.Time, input int64) models.UsageEvent {
		return models.UsageEvent{
			ID: id, Timestamp: at, MachineID: mid,
			Source: "external", Vendor: "kimi", Model: "k3",
			Tokens: models.TokenBreakdown{Input: input}, Attestation: "measured",
		}
	}
	now := time.Now().UTC()
	day := func(off int) time.Time { return now.Add(time.Duration(-off*24) * time.Hour) }
	if _, _, err := s.InsertEvents(ctx, u.ID, []models.UsageEvent{
		mk("b-1", day(0), 300), mk("b-2", day(1), 100),
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.BoardTotals(ctx, "", day(0).Truncate(24*time.Hour))
	if err != nil || len(rows) != 1 || rows[0].Tokens != 300 || rows[0].Machines != 1 {
		t.Fatalf("board=%+v err=%v", rows, err)
	}
	days, err := s.BoardDays(ctx, "", day(0).Add(-72*time.Hour), 400)
	if err != nil || len(days["ada"]) != 2 {
		t.Fatalf("days=%+v err=%v", days, err)
	}
}
