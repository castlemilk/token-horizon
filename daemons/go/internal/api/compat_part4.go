package api

// Compat routes, part 4 — the subsystems that needed real ports, not just
// wire translation: /projects (claude project-dir scan), /claude/accounts
// (ClaudeDiscovery port: ~/.claude* dirs + .claude.json oauthAccount), and
// /widget — the full WidgetSnapshot schema (v5) the WidgetKit extension and
// menu-bar widget consume: hourly/daily/weekly/monthly DayTokens series
// with per-provider stacks plus the 17-week heatmap and limits.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/capture/files"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
)

// GET /projects — per-directory usage rollups from the claude session-file
// layout (~/.claude/projects/<slug>/*.jsonl). See files.ProjectTotals.
func (a *apiServer) compatProjects(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, files.ProjectTotals())
}

// ---- claude accounts -----------------------------------------------------

// compatClaudeAccounts ports ClaudeDiscovery + UsageEngine's account rollup:
// enumerate ~/.claude* config dirs (incl. CLAUDE_CONFIG_DIR), read each
// dir's .claude.json oauthAccount for identity metadata, and attach the
// aggregated claude-vendor usage to the primary account. Per-account token
// splits need metered account_id attribution — where events carry one it's
// used; file-imported history lands on the primary dir's row.
func (a *apiServer) compatClaudeAccounts(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		writeJSON(w, 200, []any{})
		return
	}
	dirs := claudeConfigDirs(home)
	claudeAll, _ := a.store.Summary(store.Filter{Vendor: "claude"})
	claudeToday, _ := a.store.Summary(store.Filter{Vendor: "claude", From: todayStart()})
	tAll, tToday := sumRows(claudeAll), sumRows(claudeToday)

	out := []map[string]any{}
	for i, dir := range dirs {
		oauth := readClaudeOAuth(dir, home)
		acct := map[string]any{
			"id":                   strings.TrimPrefix(filepath.Base(dir), "."),
			"label":                deriveClaudeLabel(dir, strOf(oauth["emailAddress"])),
			"configDir":            dir,
			"accountUuid":          strOf(oauth["accountUuid"]),
			"email":                strOf(oauth["emailAddress"]),
			"displayName":          strOf(oauth["displayName"]),
			"organizationUuid":     strOf(oauth["organizationUuid"]),
			"organizationName":     strOf(oauth["organizationName"]),
			"organizationType":     strOf(oauth["organizationType"]),
			"rateLimitTier":        strOf(oauth["organizationRateLimitTier"]),
			"hasExtraUsageEnabled": oauth["hasExtraUsageEnabled"] == true,
			"limits":               claudeLimitsFor(a, dir),
			"updatedAt":            time.Now().Unix(),
			"tokensToday":          int64(0), "tokensAllTime": int64(0),
			"costToday": 0.0, "costAllTime": 0.0,
		}
		if i == 0 {
			// Primary dir gets the file-imported claude aggregate.
			acct["tokensToday"] = tToday.tokens()
			acct["tokensAllTime"] = tAll.tokens()
			acct["costToday"] = tToday.cost
			acct["costAllTime"] = tAll.cost
		}
		out = append(out, acct)
	}
	writeJSON(w, 200, out)
}

func claudeConfigDirs(home string) []string {
	var dirs []string
	if env := os.Getenv("CLAUDE_CONFIG_DIR"); env != "" {
		dirs = append(dirs, env)
	}
	def := filepath.Join(home, ".claude")
	dirs = append(dirs, def)
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".claude") && name != ".claude" {
			dirs = append(dirs, filepath.Join(home, name))
		}
	}
	// dedupe, keep order
	seen := map[string]bool{}
	var out []string
	for _, d := range dirs {
		if !seen[d] {
			if fi, err := os.Stat(d); err == nil && fi.IsDir() {
				seen[d] = true
				out = append(out, d)
			}
		}
	}
	return out
}

func readClaudeOAuth(dir, home string) map[string]any {
	candidates := []string{filepath.Join(dir, ".claude.json"), filepath.Join(home, ".claude.json")}
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		if oauth, ok := obj["oauthAccount"].(map[string]any); ok {
			return oauth
		}
	}
	return map[string]any{}
}

// deriveLabel ports ClaudeDiscovery.deriveLabel: gmail/outlook/icloud/proton
// emails label by user part; other domains by the domain's first label;
// no email → dir basename minus the leading dot.
func deriveClaudeLabel(dir, email string) string {
	email = strings.TrimSpace(email)
	if email != "" {
		if at := strings.Index(email, "@"); at >= 0 {
			user := email[:at]
			domain := strings.ToLower(email[at+1:])
			primary := strings.SplitN(domain, ".", 2)[0]
			switch primary {
			case "gmail", "outlook", "icloud", "proton":
				if user != "" {
					return user
				}
			}
			return primary
		}
	}
	base := filepath.Base(dir)
	return strings.TrimPrefix(base, ".")
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// claudeLimitsFor passes the limits cache through; clients filter by
// provider/accountID (metered limits carry account_id attribution).
func claudeLimitsFor(a *apiServer, dir string) any {
	if a.limitsRows == nil {
		return []any{}
	}
	if rows := a.limitsRows(); rows != nil {
		return rows
	}
	return []any{}
}

// ---- widget snapshot -----------------------------------------------------

// compatWidget emits WidgetSnapshot schema v5 — the exact JSON the WidgetKit
// extension decodes: tokens/requests/cost totals, hourly(24)/days(30)/
// weeks(17)/months(12) DayTokens series with per-provider stacks (top 5,
// rest merged as "other"), and the 119-cell heatmap.
func (a *apiServer) compatWidget(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	todayR, _ := a.store.Summary(store.Filter{From: todayStart()})
	tAll, _ := a.store.Summary(store.Filter{})

	hourly := widgetBuckets(a, now.Add(-24*time.Hour).Unix(), 3600)
	days := widgetBuckets(a, now.Add(-30*24*time.Hour).Unix(), 86400)
	weeks := widgetWeekBuckets(a, now, 17)
	months := widgetMonthBuckets(a, now, 12)
	heatmap := widgetHeatmap(a, now)

	limits := any([]any{})
	if a.limitsRows != nil {
		if rows := a.limitsRows(); rows != nil {
			limits = rows
		}
	}

	writeJSON(w, 200, map[string]any{
		"version":     5,
		"preferences": map[string]any{},
		"updatedAt":   now.Unix(),
		"tokens":      sumRows(todayR).tokens(),
		"requests":    sumRows(todayR).requests,
		"cost":        sumRows(todayR).cost,
		"hourly":      hourly,
		"days":        days,
		"weeks":       weeks,
		"months":      months,
		"heatmap":     heatmap,
		"limits":      limits,
		"allTime": map[string]any{
			"tokens": sumRows(tAll).tokens(),
			"cost":   sumRows(tAll).cost,
		},
	})
}

// dayTokens are bucket series in the WidgetSnapshot shape: {tokens,
// byProvider{top5..., other}}.
func widgetBuckets(a *apiServer, from int64, size int) []map[string]any {
	buckets, _ := a.store.Buckets(store.Filter{From: from}, size)
	byBucket := map[int64]map[string]any{}
	for _, b := range buckets {
		row := byBucket[b.Start]
		if row == nil {
			row = map[string]any{"tokens": int64(0), "byProvider": map[string]int64{}}
			byBucket[b.Start] = row
		}
		t := b.Tokens.Total()
		row["tokens"] = row["tokens"].(int64) + t
		row["byProvider"].(map[string]int64)[b.Vendor] += t
	}
	out := make([]map[string]any, 0, len(byBucket))
	starts := sortedKeys(byBucket)
	for _, s := range starts {
		out = append(out, collapseProviders(byBucket[s]))
	}
	return out
}

func widgetWeekBuckets(a *apiServer, now time.Time, n int) []map[string]any {
	// 17 ISO weeks ending this week — daily buckets grouped by week start.
	from := now.Add(-time.Duration(n) * 7 * 24 * time.Hour).Unix()
	buckets, _ := a.store.Buckets(store.Filter{From: from}, 86400)
	byWeek := map[int64]map[string]int64{}
	for _, b := range buckets {
		weekStart := dayEpoch(b.Start) - (dayEpoch(b.Start) % 7) // epoch-day weeks
		m := byWeek[weekStart]
		if m == nil {
			m = map[string]int64{}
			byWeek[weekStart] = m
		}
		m[b.Vendor] += b.Tokens.Total()
	}
	keys := sortedKeys64(byWeek)
	out := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, collapseProviders2(byWeek[k]))
	}
	return out
}

func widgetMonthBuckets(a *apiServer, now time.Time, n int) []map[string]any {
	from := now.AddDate(0, -n, 0).Unix()
	buckets, _ := a.store.Buckets(store.Filter{From: from}, 86400)
	byMonth := map[string]map[string]int64{}
	var order []string
	for _, b := range buckets {
		mk := time.Unix(b.Start, 0).Format("2006-01")
		m := byMonth[mk]
		if m == nil {
			m = map[string]int64{}
			byMonth[mk] = m
			order = append(order, mk)
		}
		m[b.Vendor] += b.Tokens.Total()
	}
	out := make([]map[string]any, 0, len(order))
	for _, mk := range order {
		out = append(out, collapseProviders2(byMonth[mk]))
	}
	return out
}

// widgetHeatmap: 17 weeks × 7 days, oldest-first (the extension's grid).
func widgetHeatmap(a *apiServer, now time.Time) []int64 {
	const weeks = 17
	grid := make([]int64, weeks*7)
	buckets, _ := a.store.Buckets(store.Filter{From: now.Unix() - weeks*7*86400}, 86400)
	today := dayEpoch(now.Unix())
	oldest := today - (weeks*7 - 1)
	for _, b := range buckets {
		d := dayEpoch(b.Start) - oldest
		if d >= 0 && d < int64(weeks*7) {
			grid[d] += b.Tokens.Total()
		}
	}
	return grid
}

// collapseProviders keeps the top 5 vendors by tokens; the rest merge into
// "other" — the widget's bounded payload contract.
func collapseProviders(row map[string]any) map[string]any {
	byProvider := row["byProvider"].(map[string]int64)
	row["byProvider"] = collapseProviderMap(byProvider)
	return row
}

func collapseProviders2(m map[string]int64) map[string]any {
	var total int64
	for _, v := range m {
		total += v
	}
	return map[string]any{"tokens": total, "byProvider": collapseProviderMap(m)}
}

func collapseProviderMap(m map[string]int64) map[string]int64 {
	if len(m) <= 5 {
		return m
	}
	type kv struct {
		k string
		v int64
	}
	var pairs []kv
	for k, v := range m {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].v > pairs[j].v })
	out := map[string]int64{}
	for i, kv := range pairs {
		if i < 5 {
			out[kv.k] = kv.v
		} else {
			out["other"] += kv.v
		}
	}
	return out
}

func sortedKeys(m map[int64]map[string]any) []int64 {
	keys := make([]int64, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}

func sortedKeys64(m map[int64]map[string]int64) []int64 {
	keys := make([]int64, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}
