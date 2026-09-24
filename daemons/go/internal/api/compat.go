package api

// Compat routes — the LocalServer surface (clients/macos Server/LocalServer.swift)
// that the cross-platform client, shell `th`, and the MCP shim already speak.
// These handlers translate the metered store analytics onto that wire shape so
// one daemon build serves both the native app and the React port. Routes the
// store can't answer truthfully (leaderboard, model catalog, shell events,
// widget snapshot) stay Swift-daemon-only — never fabricate them here.

import (
	"net/http"
	"strconv"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform/system"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
)

// dayEpoch mirrors the Swift convention: integer days since epoch (ts/86400).
func dayEpoch(ts int64) int64 { return ts / 86400 }

func todayStart() int64 {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
}

// sumRollup reduces a provider summary list into the flat totals UsageSnapshot
// carries. CostEquivalent (rate-at-timestamp list pricing) wins over raw cost
// when present — same rule as the Swift read path.
type rollup struct {
	input, output, reasoning, cacheRead, cacheWrite, requests int64
	cost                                                      float64
}

func sumRows(rows []store.ProviderSummary) rollup {
	var r rollup
	for _, p := range rows {
		r.input += p.Tokens.Input
		r.output += p.Tokens.Output
		r.reasoning += p.Tokens.Reasoning
		r.cacheRead += p.Tokens.CacheRead
		r.cacheWrite += p.Tokens.CacheWrite
		r.requests += p.Requests
		if p.CostEquivalent != nil {
			r.cost += *p.CostEquivalent
		} else {
			r.cost += p.Cost
		}
	}
	return r
}

func (r rollup) tokens() int64 {
	return r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite
}

func (a *apiServer) compatRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /stats", a.compatStats)
	mux.HandleFunc("GET /trends", a.compatTrends)
	mux.HandleFunc("GET /activity/heatmap", a.compatHeatmap)
	a.compatRoutes2(mux)
	a.compatRoutes3(mux)
	a.compatEngineRoutes(mux)
}

// compatStats emits StatsResponse: { usage: UsageSnapshot, system } — the
// shape /stats serves on the macOS daemon. Vendor rollups map onto perTool
// (the vendor IS the tool: claude, codex, kimi...); sessions/projects/
// claudeAccounts/modelDaily have no metered equivalent and stay empty.
func (a *apiServer) compatStats(w http.ResponseWriter, r *http.Request) {
	dayStart := todayStart()
	all, err := a.store.Summary(store.Filter{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	today, err := a.store.Summary(store.Filter{From: dayStart})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	allR, todayR := sumRows(all), sumRows(today)

	// perTool: today-vs-all-time join by vendor.
	type acc struct{ today, all rollup }
	byVendor := map[string]*acc{}
	for _, p := range all {
		v := byVendor[p.Vendor]
		if v == nil {
			v = &acc{}
			byVendor[p.Vendor] = v
		}
		v.all = sumRows([]store.ProviderSummary{p})
	}
	for _, p := range today {
		v := byVendor[p.Vendor]
		if v == nil {
			v = &acc{}
			byVendor[p.Vendor] = v
		}
		v.today = sumRows([]store.ProviderSummary{p})
	}
	perTool := make([]map[string]any, 0, len(byVendor))
	for vendor, v := range byVendor {
		perTool = append(perTool, map[string]any{
			"tool":              vendor,
			"tokensToday":       v.today.tokens(),
			"tokensAllTime":     v.all.tokens(),
			"costToday":         v.today.cost,
			"costAllTime":       v.all.cost,
			"requestsToday":     v.today.requests,
			"requestsAllTime":   v.all.requests,
			"cacheReadAll":      v.all.cacheRead,
			"cacheWriteAll":     v.all.cacheWrite,
			"inputTokensToday":  v.today.input,
			"outputTokensToday": v.today.output,
		})
	}

	// models: join each provider's model rows across the two windows.
	models := []map[string]any{}
	todayByVendor := map[string][]store.ProviderSummary{}
	for _, p := range today {
		todayByVendor[p.Vendor] = append(todayByVendor[p.Vendor], p)
	}
	for _, p := range all {
		var todayModels []store.ModelSummary
		for _, tp := range todayByVendor[p.Vendor] {
			todayModels = append(todayModels, tp.Models...)
		}
		todayIdx := map[string]store.ModelSummary{}
		for _, m := range todayModels {
			todayIdx[m.Model] = m
		}
		for _, m := range p.Models {
			tm := todayIdx[m.Model]
			cost := m.Cost
			if m.CostEquivalent != nil {
				cost = *m.CostEquivalent
			}
			entry := map[string]any{
				"provider":    p.Vendor,
				"model":       m.Model,
				"tokensAll":   m.Tokens.Total(),
				"tokensToday": tm.Tokens.Total(),
				"cost":        cost,
				"messages":    m.Requests,
				"free":        cost == 0,
			}
			if m.AvgGenerationTokPerSec != nil {
				entry["tokPerSec"] = *m.AvgGenerationTokPerSec
			}
			if m.AvgPromptTokPerSec != nil {
				entry["promptTokPerSec"] = *m.AvgPromptTokPerSec
			}
			models = append(models, entry)
		}
	}

	limits := any([]any{})
	if a.limitsRows != nil {
		if rows := a.limitsRows(); rows != nil {
			limits = rows
		}
	}

	snap := map[string]any{}
	if a.systemFn != nil {
		if s, ok := a.systemFn().(system.Snapshot); ok {
			snap = map[string]any{
				"cpu_percent":  s.CPUPercent,
				"ram_used_gb":  s.RAMUsedGB,
				"ram_total_gb": s.RAMTotalGB,
				"load_1m":      s.LoadAvg1,
				"disk_mbps":    s.DiskMBps,
				"net_mbps":     s.NetMBps,
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"usage": map[string]any{
			"tokensToday":         todayR.tokens(),
			"tokensAllTime":       allR.tokens(),
			"costToday":           todayR.cost,
			"costAllTime":         allR.cost,
			"perTool":             perTool,
			"models":              models,
			"limits":              limits,
			"claudeAccounts":      []any{},
			"recentSessions":      []any{},
			"sources":             []string{"metered"},
			"updatedAt":           time.Now().Unix(),
			"inputTokensToday":    todayR.input,
			"outputTokensToday":   todayR.output,
			"inputTokensAllTime":  allR.input,
			"outputTokensAllTime": allR.output,
			"requestsToday":       todayR.requests,
			"requestsAllTime":     allR.requests,
			"projects":            []any{},
			"modelDaily":          []any{},
		},
		"system": snap,
	})
}

// compatTrends emits {window, total, points:[{day, tokens, cost, byTool}]}
// over daily buckets; byTool keys on vendor (the canonical tool axis).
func (a *apiServer) compatTrends(w http.ResponseWriter, r *http.Request) {
	days := map[string]int64{"1D": 1, "1W": 7, "1M": 30, "3M": 90, "1Y": 370}[r.URL.Query().Get("window")]
	if days == 0 {
		days = 30
	}
	buckets, err := a.store.Buckets(store.Filter{From: time.Now().Unix() - days*86400}, 86400)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	type pt struct {
		tokens int64
		cost   float64
		byTool map[string]int64
	}
	perDay := map[int64]*pt{}
	var total int64
	for _, b := range buckets {
		d := dayEpoch(b.Start)
		p := perDay[d]
		if p == nil {
			p = &pt{byTool: map[string]int64{}}
			perDay[d] = p
		}
		t := b.Tokens.Total()
		p.tokens += t
		p.byTool[b.Vendor] += t
		if b.CostEquivalent != nil {
			p.cost += *b.CostEquivalent
		} else {
			p.cost += b.Cost
		}
		total += t
	}
	points := make([]map[string]any, 0, len(perDay))
	for d, p := range perDay {
		points = append(points, map[string]any{"day": d, "tokens": p.tokens, "cost": p.cost, "byTool": p.byTool})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window": r.URL.Query().Get("window"), "total": total, "points": points,
	})
}

// compatHeatmap emits {days, max, total, grid[day][hour]} — the 7×24-style
// activity grid the Swift heatmap renders (grid[0] = oldest day).
func (a *apiServer) compatHeatmap(w http.ResponseWriter, r *http.Request) {
	days, err := strconv.Atoi(r.URL.Query().Get("days"))
	if err != nil || days <= 0 || days > 370 {
		days = 28
	}
	buckets, err := a.store.Buckets(store.Filter{From: time.Now().Unix() - int64(days)*86400}, 3600)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	today := dayEpoch(time.Now().Unix())
	oldest := today - int64(days) + 1
	grid := make([][]int64, days)
	for i := range grid {
		grid[i] = make([]int64, 24)
	}
	var max, total int64
	for _, b := range buckets {
		d := int(dayEpoch(b.Start) - oldest)
		if d < 0 || d >= days {
			continue
		}
		h := time.Unix(b.Start, 0).Hour()
		v := b.Tokens.Total()
		grid[d][h] += v
		total += v
		if grid[d][h] > max {
			max = grid[d][h]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": days, "max": max, "total": total, "grid": grid})
}
