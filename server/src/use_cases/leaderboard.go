package usecases

import (
	"context"
	"errors"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
)

// Leaderboard ranks users by metered tokens over a period, optionally
// scoped to a team. Streaks count trailing consecutive active UTC days
// (today counts if active, else the run must end yesterday).
type Leaderboard struct {
	Store store.Store
	Now   func() time.Time
}

func (l Leaderboard) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now().UTC()
}

// Periods mirror the UI picker.
func periodStart(period string, now time.Time) (since, prevSince time.Time, err error) {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	switch period {
	case "", "today":
		return day, day.Add(-24 * time.Hour), nil
	case "week":
		return now.Add(-7 * 24 * time.Hour), now.Add(-14 * 24 * time.Hour), nil
	case "all":
		return time.Time{}, time.Time{}, nil
	case "streak":
		return now.Add(-90 * 24 * time.Hour), time.Time{}, nil
	}
	return time.Time{}, time.Time{}, errors.New("unknown period " + period)
}

// Entry is one ranked row.
type Entry struct {
	Rank        int     `json:"rank"`
	Handle      string  `json:"handle"`
	DisplayName string  `json:"display_name"`
	AvatarURL   string  `json:"avatar_url"`
	Tokens      int64   `json:"tokens"`
	Cost        float64 `json:"cost"`
	Requests    int64   `json:"requests"`
	Machines    int     `json:"machines"`
	DeltaPct    float64 `json:"delta_pct,omitempty"`
	StreakDays  int     `json:"streak_days,omitempty"`
}

// Board is a ranked page.
type Board struct {
	Period  string  `json:"period"`
	Team    string  `json:"team,omitempty"`
	Entries []Entry `json:"entries"`
}

// Rank returns the board for a period ("" = today), with deltas against the
// previous equal window (skipped for "all") and streaks always attached.
func (l Leaderboard) Rank(ctx context.Context, team, period string) (Board, error) {
	now := l.now()
	since, prevSince, err := periodStart(period, now)
	if err != nil {
		return Board{}, err
	}
	if period == "" {
		period = "today"
	}
	rows, err := l.Store.BoardTotals(ctx, team, since)
	if err != nil {
		return Board{}, err
	}
	prevByHandle := map[string]int64{}
	if period != "all" {
		prev, err := l.Store.BoardTotalsRange(ctx, team, prevSince, since)
		if err != nil {
			return Board{}, err
		}
		for _, r := range prev {
			prevByHandle[r.Handle] = r.Tokens
		}
	}
	days, err := l.Store.BoardDays(ctx, team, now.Add(-400*24*time.Hour), 400)
	if err != nil {
		return Board{}, err
	}
	entries := make([]Entry, 0, len(rows))
	for i, r := range rows {
		e := Entry{
			Rank: i + 1, Handle: r.Handle, DisplayName: r.DisplayName,
			AvatarURL: r.AvatarURL, Tokens: r.Tokens, Cost: r.Cost,
			Requests: r.Requests, Machines: r.Machines,
			StreakDays: streakDays(days[r.Handle], now),
		}
		if prev, ok := prevByHandle[r.Handle]; ok && prev > 0 {
			e.DeltaPct = (float64(r.Tokens) - float64(prev)) / float64(prev) * 100
		} else if r.Tokens > 0 {
			e.DeltaPct = 100
		}
		entries = append(entries, e)
	}
	return Board{Period: period, Team: team, Entries: entries}, nil
}

// streakDays counts the trailing run of consecutive active UTC days ending
// today — or yesterday when today is still quiet.
func streakDays(days []time.Time, now time.Time) int {
	if len(days) == 0 {
		return 0
	}
	seen := map[string]bool{}
	for _, d := range days {
		seen[d.UTC().Format("2006-01-02")] = true
	}
	cursor := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if !seen[cursor.Format("2006-01-02")] {
		cursor = cursor.Add(-24 * time.Hour)
		if !seen[cursor.Format("2006-01-02")] {
			return 0
		}
	}
	n := 0
	for seen[cursor.Format("2006-01-02")] {
		n++
		cursor = cursor.Add(-24 * time.Hour)
	}
	return n
}
