package usecases

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models"
	"github.com/castlemilk/token-horizon/server/src/testfake"
)

func boardIngest(t *testing.T, ing Ingest, machine, handle string, at time.Time, input int64) {
	t.Helper()
	env := Envelope{MachineID: machine, MachineAlias: machine, Handle: handle}
	ev := models.UsageEvent{
		ID: machine + handle + at.Format("20060102-150405"), Timestamp: at,
		Source: "external", Vendor: "kimi", Model: "k3",
		Tokens:      models.TokenBreakdown{Input: input},
		Attestation: "measured",
	}
	if _, err := ing.Events(context.Background(), env, []models.UsageEvent{ev}); err != nil {
		t.Fatal(err)
	}
}

func TestLeaderboardRankDeltaStreak(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	today := time.Date(2026, 9, 13, 9, 0, 0, 0, time.UTC)
	yesterday := today.Add(-24 * time.Hour)

	boardIngest(t, ing, "m-ada", "ada", today, 300)
	boardIngest(t, ing, "m-ada", "ada", yesterday, 100)
	boardIngest(t, ing, "m-grace", "grace", today, 100)

	lb := Leaderboard{Store: fake, Now: func() time.Time { return now }}
	board, err := lb.Rank(context.Background(), "", "today")
	if err != nil {
		t.Fatal(err)
	}
	if len(board.Entries) != 2 {
		t.Fatalf("entries=%+v", board.Entries)
	}
	first, second := board.Entries[0], board.Entries[1]
	if first.Handle != "ada" || first.Tokens != 300 || first.Rank != 1 {
		t.Fatalf("first=%+v", first)
	}
	if first.DeltaPct != 200 {
		t.Fatalf("delta=%v", first.DeltaPct)
	}
	if second.Handle != "grace" || second.DeltaPct != 100 {
		t.Fatalf("second=%+v", second)
	}
	if first.StreakDays != 2 {
		t.Fatalf("streak=%d", first.StreakDays)
	}
	if _, err := lb.Rank(context.Background(), "", "bogus"); err == nil {
		t.Fatal("expected period error")
	}
}

func TestStreakDays(t *testing.T) {
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	day := func(off int) time.Time { return now.Add(time.Duration(-off*24) * time.Hour) }
	if got := streakDays([]time.Time{day(0), day(1), day(2)}, now); got != 3 {
		t.Fatalf("got %d", got)
	}
	if got := streakDays([]time.Time{day(1), day(2)}, now); got != 2 {
		t.Fatalf("quiet today got %d", got)
	}
	if got := streakDays([]time.Time{day(0), day(2)}, now); got != 1 {
		t.Fatalf("gap got %d", got)
	}
	if got := streakDays(nil, now); got != 0 {
		t.Fatalf("empty got %d", got)
	}
}
