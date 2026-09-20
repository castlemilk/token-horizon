// Package leaderboard holds the ranking business logic: per-user metered
// totals over a window, scoped by team, group, or the caller's follow
// graph, ranked by one of three categories (tokens|cost|requests — the
// same trio the local dashboard totals), with previous-window gains
// powering the rising-star board, group chips, and active-day streaks.
// Ranking state never persists — boards derive at read time.
package leaderboard

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
)

// Leaderboard ranks users over a window, scoped by team, group, or the
// caller's follow graph (store.BoardScope; zero value = everyone).
// Streaks count trailing consecutive active UTC days (today counts if
// active, else the run must end yesterday).
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

// Windows mirror the UI picker. Calendar boundaries are UTC (the repo-wide
// time invariant): today = UTC midnight, week = ISO Monday, month/year =
// calendar; 6m is a rolling 183 days (no natural calendar boundary).
// prevSince/prevUntil bound the previous equal window for rising-star
// gains; both zero for "all".
func windowBounds(window string, now time.Time) (since, prevSince, prevUntil time.Time, err error) {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	switch window {
	case "", "today":
		return day, day.Add(-24 * time.Hour), day, nil
	case "week":
		iso := time.Date(now.Year(), now.Month(), now.Day()-int((now.Weekday()+6)%7), 0, 0, 0, 0, time.UTC)
		return iso, iso.AddDate(0, 0, -7), iso, nil
	case "month":
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		return first, first.AddDate(0, -1, 0), first, nil
	case "6m":
		since := now.AddDate(0, 0, -183)
		return since, since.AddDate(0, 0, -183), since, nil
	case "year":
		jan1 := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		return jan1, time.Date(now.Year()-1, 1, 1, 0, 0, 0, 0, time.UTC), jan1, nil
	case "all":
		return time.Time{}, time.Time{}, time.Time{}, nil
	}
	return time.Time{}, time.Time{}, time.Time{}, errors.New("unknown window " + window)
}

// Categories mirror the dashboard stats trio.
func validCategory(category string) error {
	switch category {
	case "", "tokens", "cost", "requests":
		return nil
	}
	return errors.New("unknown category " + category)
}

// metric extracts the ranked metric from an aggregate row.
func metric(r store.BoardRow, category string) float64 {
	switch category {
	case "cost":
		return r.Cost
	case "requests":
		return float64(r.Requests)
	default:
		return float64(r.Tokens)
	}
}

// Entry is one ranked row.
type Entry struct {
	Rank        int      `json:"rank"`
	Handle      string   `json:"handle"`
	DisplayName string   `json:"display_name"`
	AvatarURL   string   `json:"avatar_url"`
	CountryCode string   `json:"country_code,omitempty"`
	Groups      []string `json:"groups,omitempty"`
	Tokens      int64    `json:"tokens"`
	Cost        float64  `json:"cost"`
	Requests    int64    `json:"requests"`
	Machines    int      `json:"machines"`
	Delta       float64  `json:"delta,omitempty"`
	DeltaPct    float64  `json:"delta_pct,omitempty"`
	New         bool     `json:"new,omitempty"`
	StreakDays  int      `json:"streak_days,omitempty"`
}

// Board is a ranked page plus its rising-star chart.
type Board struct {
	Window   string  `json:"window"`
	Category string  `json:"category"`
	Team     string  `json:"team,omitempty"`
	Group    string  `json:"group,omitempty"`
	Entries  []Entry `json:"entries"`
	// Rising: the top climbers by absolute gain vs the previous equal
	// window (empty for "all" — no previous window exists). Newcomers
	// (no previous usage) rank by their current total, flagged new.
	Rising []Entry `json:"rising"`
}

// groupLabels flattens membership tags into display chips: group names win,
// bare team memberships show the team name. De-duplicated, order-stable.
func groupLabels(tags []store.GroupTag) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range tags {
		label := t.GroupName
		if label == "" {
			label = t.TeamName
		}
		if label == "" {
			label = t.TeamSlug
		}
		if label != "" && !seen[label] {
			seen[label] = true
			out = append(out, label)
		}
	}
	return out
}

// Rank returns the board for a window+category, with gains against the
// previous equal window (skipped for "all") and streaks always attached.
func (l Leaderboard) Rank(ctx context.Context, scope store.BoardScope, window, category string) (Board, error) {
	if err := validCategory(category); err != nil {
		return Board{}, err
	}
	if category == "" {
		category = "tokens"
	}
	now := l.now()
	since, prevSince, prevUntil, err := windowBounds(window, now)
	if err != nil {
		return Board{}, err
	}
	if window == "" {
		window = "today"
	}
	rows, err := l.Store.BoardTotals(ctx, scope, since, category)
	if err != nil {
		return Board{}, err
	}
	groups, err := l.Store.UserGroups(ctx)
	if err != nil {
		return Board{}, err
	}
	prevByHandle := map[string]float64{}
	if window != "all" {
		prev, err := l.Store.BoardTotalsRange(ctx, scope, prevSince, prevUntil, category)
		if err != nil {
			return Board{}, err
		}
		for _, r := range prev {
			prevByHandle[r.Handle] = metric(r, category)
		}
	}
	days, err := l.Store.BoardDays(ctx, scope, now.Add(-400*24*time.Hour), 400)
	if err != nil {
		return Board{}, err
	}
	entries := make([]Entry, 0, len(rows))
	for i, r := range rows {
		e := Entry{
			Rank: i + 1, Handle: r.Handle, DisplayName: r.DisplayName,
			AvatarURL: r.AvatarURL, CountryCode: r.CountryCode,
			Groups: groupLabels(groups[r.Handle]),
			Tokens: r.Tokens, Cost: r.Cost,
			Requests: r.Requests, Machines: r.Machines,
			StreakDays: streakDays(days[r.Handle], now),
		}
		cur := metric(r, category)
		if prev, ok := prevByHandle[r.Handle]; ok && prev > 0 {
			e.Delta = cur - prev
			e.DeltaPct = (cur - prev) / prev * 100
		} else if cur > 0 && window != "all" {
			e.Delta = cur
			e.DeltaPct = 100
			e.New = true
		}
		entries = append(entries, e)
	}
	board := Board{
		Window: window, Category: category,
		Team: scope.TeamSlug, Group: scope.GroupID,
		Entries: entries,
	}
	// Rising stars: biggest absolute gains vs the previous window. Every
	// entry with positive gain is eligible; newcomers ride their total.
	if window != "all" {
		rising := make([]Entry, 0, len(entries))
		for _, e := range entries {
			if e.Delta > 0 {
				rising = append(rising, e)
			}
		}
		sort.SliceStable(rising, func(i, j int) bool {
			if rising[i].Delta != rising[j].Delta {
				return rising[i].Delta > rising[j].Delta
			}
			return rising[i].DeltaPct > rising[j].DeltaPct
		})
		if len(rising) > 5 {
			rising = rising[:5]
		}
		board.Rising = rising
	}
	return board, nil
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
