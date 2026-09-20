package leaderboard

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/testfake"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/social"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/usage"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/ingest"
)

func boardIngest(t *testing.T, ing ingest.Ingest, machine, handle string, at time.Time, input int64) {
	t.Helper()
	env := ingest.Envelope{MachineID: machine, MachineAlias: machine, Handle: handle}
	ev := usage.UsageEvent{
		ID: machine + handle + at.Format("20060102-150405"), Timestamp: at,
		Source: "external", Vendor: "kimi", Model: "k3",
		Tokens:      usage.TokenBreakdown{Input: input},
		Attestation: "measured",
	}
	if _, err := ing.Events(context.Background(), env, []usage.UsageEvent{ev}); err != nil {
		t.Fatal(err)
	}
}

func TestLeaderboardRankDeltaStreak(t *testing.T) {
	fake := testfake.New()
	ing := ingest.Ingest{Store: fake}
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	today := time.Date(2026, 9, 13, 9, 0, 0, 0, time.UTC)
	yesterday := today.Add(-24 * time.Hour)

	boardIngest(t, ing, "m-ada", "ada", today, 300)
	boardIngest(t, ing, "m-ada", "ada", yesterday, 100)
	boardIngest(t, ing, "m-grace", "grace", today, 100)

	lb := Leaderboard{Store: fake, Now: func() time.Time { return now }}
	board, err := lb.Rank(context.Background(), store.BoardScope{}, "today", "")
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
	if _, err := lb.Rank(context.Background(), store.BoardScope{}, "bogus", ""); err == nil {
		t.Fatal("expected period error")
	}
}

func TestFollowingLeaderboard(t *testing.T) {
	fake := testfake.New()
	ing := ingest.Ingest{Store: fake}
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	today := time.Date(2026, 9, 13, 9, 0, 0, 0, time.UTC)

	boardIngest(t, ing, "m-ada", "ada", today, 300)
	boardIngest(t, ing, "m-grace", "grace", today, 100)
	boardIngest(t, ing, "m-hopper", "hopper", today, 999)

	ada, _ := fake.UserByHandle(context.Background(), "ada")
	grace, _ := fake.UserByHandle(context.Background(), "grace")
	if err := fake.Follow(context.Background(), ada.ID, grace.ID); err != nil {
		t.Fatal(err)
	}

	lb := Leaderboard{Store: fake, Now: func() time.Time { return now }}
	board, err := lb.Rank(context.Background(), store.BoardScope{FollowingOf: ada.ID}, "today", "")
	if err != nil {
		t.Fatal(err)
	}
	// Scope = grace (followed) + ada (self); hopper is excluded.
	if len(board.Entries) != 2 {
		t.Fatalf("entries=%+v", board.Entries)
	}
	if board.Entries[0].Handle != "ada" || board.Entries[1].Handle != "grace" {
		t.Fatalf("entries=%+v", board.Entries)
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

// Windows are UTC-anchored (repo time invariant): today = UTC midnight,
// week = ISO Monday, month/year = calendar, 6m = rolling 183 days, all = open.
func TestWindowBounds(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC) // a Wednesday
	since, prev, prevUntil, err := windowBounds("today", now)
	if err != nil || since.Hour() != 0 || since.Day() != 16 || prevUntil != since || since.Sub(prev) != 24*time.Hour {
		t.Fatalf("today: %v %v %v err=%v", since, prev, prevUntil, err)
	}
	since, prev, prevUntil, _ = windowBounds("week", now)
	if since.Weekday() != time.Monday || since.After(now) || since.Sub(prev) != 7*24*time.Hour || prevUntil != since {
		t.Fatalf("week: %v %v %v", since, prev, prevUntil)
	}
	since, prev, _, _ = windowBounds("month", now)
	if since.Day() != 1 || prev.Month() != time.August || prev.Day() != 1 {
		t.Fatalf("month: %v prev=%v", since, prev)
	}
	since, prev, _, _ = windowBounds("6m", now)
	if now.Sub(since) != 183*24*time.Hour || since.Sub(prev) != 183*24*time.Hour {
		t.Fatalf("6m: %v prev=%v", since, prev)
	}
	since, prev, _, _ = windowBounds("year", now)
	if since.Month() != time.January || since.Day() != 1 || prev.Year() != 2025 {
		t.Fatalf("year: %v prev=%v", since, prev)
	}
	since, prev, prevUntil, _ = windowBounds("all", now)
	if !since.IsZero() || !prev.IsZero() || !prevUntil.IsZero() {
		t.Fatalf("all: %v %v %v", since, prev, prevUntil)
	}
	if _, _, _, err := windowBounds("bogus", now); err == nil {
		t.Fatal("expected window error")
	}
}

// Categories rank by tokens/cost/requests; rising = biggest absolute gain
// vs the previous equal window; newcomers flagged; groups ride the row.
func TestCategoriesRisingGroups(t *testing.T) {
	fake := testfake.New()
	ing := ingest.Ingest{Store: fake}
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	today := time.Date(2026, 9, 16, 9, 0, 0, 0, time.UTC)
	yesterday := today.Add(-24 * time.Hour)

	// ada: most tokens, fewest requests. grace: most requests (many small).
	boardIngest(t, ing, "m-ada", "ada", today, 300)     // 300 tok, 1 req
	boardIngest(t, ing, "m-ada", "ada", yesterday, 100) // prev window
	for i := 0; i < 3; i++ {
		boardIngest(t, ing, "m-grace", "grace", today.Add(time.Duration(i)*time.Minute), 10)
	}
	// hopper: newcomer, big gain from zero.
	boardIngest(t, ing, "m-hopper", "hopper", today, 200)

	// Memberships: ada in a team + a group (multi-group rides the row).
	fake.Teams["t-1"] = social.Team{ID: "t-1", Slug: "core", Name: "Core Team"}
	ada, _ := fake.UserByHandle(context.Background(), "ada")
	fake.TeamMemb["t-1"] = map[string]string{ada.ID: "member"}
	fake.Groups["g-1"] = social.Group{ID: "g-1", TeamID: "t-1", Slug: "infra", Name: "Infra"}
	fake.GrpMemb["g-1"] = map[string]string{ada.ID: "member"}

	lb := Leaderboard{Store: fake, Now: func() time.Time { return now }}

	tokens, err := lb.Rank(context.Background(), store.BoardScope{}, "today", "tokens")
	if err != nil {
		t.Fatal(err)
	}
	if tokens.Entries[0].Handle != "ada" {
		t.Fatalf("tokens first=%+v", tokens.Entries[0])
	}
	if got := tokens.Entries[0].Groups; len(got) != 2 || got[0] != "Core Team" || got[1] != "Infra" {
		t.Fatalf("groups=%v", got)
	}

	reqs, err := lb.Rank(context.Background(), store.BoardScope{}, "today", "requests")
	if err != nil {
		t.Fatal(err)
	}
	if reqs.Entries[0].Handle != "grace" || reqs.Entries[0].Requests != 3 {
		t.Fatalf("requests first=%+v", reqs.Entries[0])
	}

	// Rising: ada gained +200 tokens vs yesterday; hopper (newcomer) rides
	// +200 too — ada wins the tie on delta_pct (200% > 100%).
	rising := tokens.Rising
	if len(rising) < 2 {
		t.Fatalf("rising=%+v", rising)
	}
	if rising[0].Handle != "ada" || rising[0].Delta != 200 {
		t.Fatalf("rising[0]=%+v", rising[0])
	}
	if !rising[1].New || rising[1].Handle != "hopper" {
		t.Fatalf("rising[1]=%+v", rising[1])
	}

	// All-time: no rising board (no previous window).
	all, err := lb.Rank(context.Background(), store.BoardScope{}, "all", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Rising) != 0 || all.Entries[0].Tokens != 400 {
		t.Fatalf("all=%+v", all)
	}

	if _, err := lb.Rank(context.Background(), store.BoardScope{}, "today", "bogus"); err == nil {
		t.Fatal("expected category error")
	}
}
