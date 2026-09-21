package api

// Compat routes, part 2 — the remaining LocalServer surface the clients
// speak. Honest translations only: what the Go daemon genuinely has (store
// analytics, runtime monitor, catalog, processes) is mapped onto the Swift
// wire shape; what it doesn't (docker stats, benchmark scores, peer
// leaderboard entries) returns empty rather than fabricated.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/catalog"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	rtpkg "github.com/castlemilk/token-horizon/daemons/go/internal/runtime"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
	"github.com/castlemilk/token-horizon/daemons/go/internal/system"
)

func (a *apiServer) compatRoutes2(mux *http.ServeMux) {
	mux.HandleFunc("GET /history", a.compatHistory)
	mux.HandleFunc("POST /event", a.compatEventPost)
	mux.HandleFunc("GET /events", a.compatEvents)
	mux.HandleFunc("GET /cache", a.compatCache)
	mux.HandleFunc("POST /cache/reset", a.compatCacheReset)
	mux.HandleFunc("GET /docker", a.compatDocker)
	mux.HandleFunc("GET /models", a.compatModels)
	mux.HandleFunc("GET /models/catalog", a.compatModelsCatalog)
	mux.HandleFunc("GET /top-picks", a.compatTopPicks)
	mux.HandleFunc("GET /models/top-picks", a.compatTopPicks)
	mux.HandleFunc("GET /local", a.compatLocal)
	mux.HandleFunc("GET /leaderboard", a.compatLeaderboardPeers)
	mux.HandleFunc("GET /achievements", a.compatAchievements)
}

// ---- shell event ring -------------------------------------------------

// shellEvent mirrors Swift ShellEvent {id, time, cwd, durationMs, exit}.
type shellEvent struct {
	ID         string `json:"id"`
	Time       int64  `json:"time"`
	Cwd        string `json:"cwd"`
	DurationMs int64  `json:"durationMs"`
	Exit       int    `json:"exit"`
}

var shellRing struct {
	mu     sync.Mutex
	events []shellEvent
	seq    int64
}

// POST /event — form-encoded (cwd/dur/exit, same as the zsh hook posts) or JSON.
func (a *apiServer) compatEventPost(w http.ResponseWriter, r *http.Request) {
	var ev shellEvent
	ct := r.Header.Get("Content-Type")
	if strings.Contains(ct, "application/json") {
		_ = json.NewDecoder(r.Body).Decode(&ev)
	} else {
		_ = r.ParseForm()
		ev.Cwd = r.Form.Get("cwd")
		ev.DurationMs, _ = strconv.ParseInt(r.Form.Get("dur"), 10, 64)
		ev.Exit, _ = strconv.Atoi(r.Form.Get("exit"))
	}
	ev.Time = time.Now().Unix()
	shellRing.mu.Lock()
	shellRing.seq++
	ev.ID = fmt.Sprintf("%x-%x", ev.Time, shellRing.seq)
	shellRing.events = append([]shellEvent{ev}, shellRing.events...)
	if len(shellRing.events) > 200 {
		shellRing.events = shellRing.events[:200]
	}
	shellRing.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /events — newest-first, capped at 25 like EventStore.recent.
func (a *apiServer) compatEvents(w http.ResponseWriter, r *http.Request) {
	shellRing.mu.Lock()
	n := 25
	if len(shellRing.events) < n {
		n = len(shellRing.events)
	}
	out := append([]shellEvent{}, shellRing.events[:n]...)
	shellRing.mu.Unlock()
	writeJSON(w, http.StatusOK, out)
}

// ---- history -----------------------------------------------------------

// GET /history?days= — {days, streak, points:[{day,tokens,cost,byTool}]}.
// Streak counts consecutive non-zero days ending today (or yesterday if
// today is empty yet — same rule as the Swift dashboard).
func (a *apiServer) compatHistory(w http.ResponseWriter, r *http.Request) {
	days, err := strconv.Atoi(r.URL.Query().Get("days"))
	if err != nil {
		days = 365
	}
	if days < 7 {
		days = 7
	}
	if days > 370 {
		days = 370
	}
	buckets, err := a.store.Buckets(store.Filter{From: time.Now().Unix() - int64(days)*86400}, 86400)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	perDay := map[int64]struct {
		tokens int64
		cost   float64
		byTool map[string]int64
	}{}
	for _, b := range buckets {
		d := dayEpoch(b.Start)
		p := perDay[d]
		if p.byTool == nil {
			p.byTool = map[string]int64{}
		}
		t := b.Tokens.Total()
		p.tokens += t
		p.byTool[b.Vendor] += t
		if b.CostEquivalent != nil {
			p.cost += *b.CostEquivalent
		} else {
			p.cost += b.Cost
		}
		perDay[d] = p
	}
	points := make([]map[string]any, 0, len(perDay))
	for d, p := range perDay {
		points = append(points, map[string]any{"day": d, "tokens": p.tokens, "cost": p.cost, "byTool": p.byTool})
	}
	sort.Slice(points, func(i, j int) bool {
		return points[i]["day"].(int64) < points[j]["day"].(int64)
	})
	today := dayEpoch(time.Now().Unix())
	streak := 0
	start := today
	if perDay[today].tokens == 0 {
		start = today - 1
	}
	for d := start; perDay[d].tokens > 0; d-- {
		streak++
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": days, "streak": streak, "points": points})
}

// ---- cache / docker ----------------------------------------------------

// GET /cache — the Go daemon's durable store IS usage.db; report its stats.
func (a *apiServer) compatCache(w http.ResponseWriter, r *http.Request) {
	count, _ := a.store.Count()
	var bytes, mtime int64
	if fi, err := os.Stat(filepath.Join(platform.ConfigDir(), "usage.db")); err == nil {
		bytes = fi.Size()
		mtime = fi.ModTime().Unix()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"persistenceEnabled": true,
		"filesCount":         count,
		"totalBytes":         bytes,
		"lastUpdated":        mtime,
	})
}

// POST /cache/reset — refuse to delete the metered ledger; retention is
// TH_RETENTION_DAYS (documented on OpenStore).
func (a *apiServer) compatCacheReset(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      false,
		"message": "usage.db is the durable metered ledger — set TH_RETENTION_DAYS to bound it",
	})
}

// GET /docker — no container observer in the Go daemon yet; honest empty.
func (a *apiServer) compatDocker(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"containers": []any{}, "count": 0,
		"totalContainerMemMB": 0, "totalContainerCpu": 0,
		"vmHostPid": 0, "vmHostMemMB": 0,
	})
}

// ---- models catalog ----------------------------------------------------

// GET /models?search=&scope= — catalog listing in CatalogModel shape.
// Scopes: FREE filters isFree; LOCAL filters isLocal (none — runtime entries
// aren't catalog rows); other scopes pass through (no capability tags in the
// Go catalog yet).
func (a *apiServer) compatModels(w http.ResponseWriter, r *http.Request) {
	search := strings.ToLower(r.URL.Query().Get("search"))
	scope := strings.ToUpper(r.URL.Query().Get("scope"))
	rows := []map[string]any{}
	for _, e := range catalog.All() {
		free := e.InputPerM == 0 && e.OutputPerM == 0
		if scope == "FREE" && !free {
			continue
		}
		if scope == "LOCAL" {
			continue // catalog has no local-runtime rows
		}
		if search != "" && !strings.Contains(strings.ToLower(e.ID+" "+e.Name+" "+e.Provider), search) {
			continue
		}
		blended := e.InputPerM*0.75 + e.OutputPerM*0.25 // Swift blended heuristic approx
		rows = append(rows, map[string]any{
			"id":                  e.ID,
			"name":                e.Name,
			"provider":            e.Provider,
			"inputPrice":          e.InputPerM,
			"outputPrice":         e.OutputPerM,
			"effectiveInputPrice": e.InputPerM,
			"blendedNetCost":      blended,
			"blendedNetCostText":  fmt.Sprintf("$%.2f", blended),
			"netSavingsPercent":   0,
			"hasDiscount":         false,
			"contextK":            e.ContextK,
			"contextText":         fmt.Sprintf("%dk", e.ContextK),
			"isLocal":             false,
			"isFree":              free,
			"cachePrice":          e.CacheReadPerM,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": len(rows), "scope": scope, "models": rows})
}

// GET /models/catalog — flat catalog dump (id → entry), the export shape.
func (a *apiServer) compatModelsCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"count": len(catalog.All()), "models": catalog.All()})
}

// GET /top-picks — needs benchmark scores (SWE-bench/LCB) the Go catalog
// doesn't carry; empty rather than fabricated.
func (a *apiServer) compatTopPicks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"topPicks": []any{}, "count": 0})
}

// ---- local runtimes ----------------------------------------------------

// GET /local — runtime monitor snapshots mapped onto the Swift /local shape.
// MLX process detail is macOS-only upstream too; here the processes list is
// the detected inference runtimes with measured tok/s from the monitor.
func (a *apiServer) compatLocal(w http.ResponseWriter, r *http.Request) {
	procs := []map[string]any{}
	var cpu, mem float64
	var decode, prefill float64
	models := map[string]any{}
	if a.runtimesFn != nil {
		if snaps, ok := a.runtimesFn().([]rtpkg.Snapshot); ok {
			for _, s := range snaps {
				pid := int32(0)
				if len(s.PIDs) > 0 {
					pid = s.PIDs[0]
				}
				var tok, ptok float64
				if s.TokPerSec != nil {
					tok = *s.TokPerSec
				}
				if s.PromptTokPerSec != nil {
					ptok = *s.PromptTokPerSec
				}
				procs = append(procs, map[string]any{
					"pid": pid, "name": s.DisplayName, "command": s.Vendor,
					"model": s.Vendor, "cpu": 0, "memoryMB": 0,
					"tokPerSec": tok, "prefillTokPerSec": ptok,
				})
				decode += tok
				prefill += ptok
				models[s.Vendor] = map[string]any{
					"today": s.Usage.TokensToday, "all": s.Usage.TokensAll,
					"prompt": 0, "eval": s.Usage.TokensAll, "messages": 0,
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sampledAt": time.Now().Unix(),
		"processes": procs,
		"totals": map[string]any{
			"cpuPercent": cpu, "memoryMB": mem,
			"diskReadMBps": 0, "diskWriteMBps": 0,
			"measuredTokPerSec": decode, "measuredPrefillTokPerSec": prefill,
		},
		"ollama": map[string]any{"models": models},
	})
}

// ---- leaderboard / achievements ----------------------------------------

func compatHandle() string {
	if id := platform.LoadCloudIdentity(); id != nil && id.Handle != "" {
		return id.Handle
	}
	if h, _ := os.Hostname(); h != "" {
		return h
	}
	return "local"
}

func (a *apiServer) compatStreak() int {
	buckets, err := a.store.Buckets(store.Filter{From: time.Now().Unix() - 370*86400}, 86400)
	if err != nil {
		return 0
	}
	days := map[int64]bool{}
	for _, b := range buckets {
		if b.Tokens.Total() > 0 {
			days[dayEpoch(b.Start)] = true
		}
	}
	today := dayEpoch(time.Now().Unix())
	start := today
	if !days[today] {
		start = today - 1
	}
	streak := 0
	for d := start; days[d]; d-- {
		streak++
	}
	return streak
}

func topModel(rows []store.ProviderSummary) string {
	best, bestTok := "", int64(0)
	for _, p := range rows {
		for _, m := range p.Models {
			if m.Tokens.Total() > bestTok {
				best, bestTok = m.Model, m.Tokens.Total()
			}
		}
	}
	return best
}

func fmtTokens(n int64) string {
	switch {
	case n >= 1e9:
		return fmt.Sprintf("%.2fB", float64(n)/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	default:
		return strconv.FormatInt(n, 10)
	}
}

// GET /achievements — achievements are leaderboard-engine output; empty set.
func (a *apiServer) compatAchievements(w http.ResponseWriter, r *http.Request) {
	all, _ := a.store.Summary(store.Filter{})
	writeJSON(w, http.StatusOK, map[string]any{
		"season": map[string]any{
			"id": "local", "number": 1, "name": "", "displayName": "Local",
			"daysRemaining": 0, "progress": 0,
		},
		"seasonTokens": sumRows(all).tokens(),
		"achievements": []any{},
	})
}

// ---- processes shape upgrade -------------------------------------------

// CompatProcessPayload builds the full {all,tree,byCPU,byMem,byDisk,byNet}
// shape the clients render (main.go's ProcessesFn was {byCPU,byMem} only).
func CompatProcessPayload() map[string]any {
	all := system.AllProcesses()
	byCPU, byMem := system.ProcessSamples()
	byDisk := append([]system.ProcSample{}, all...)
	byNet := append([]system.ProcSample{}, all...)
	sort.Slice(byDisk, func(i, j int) bool {
		return byDisk[i].DiskRead+byDisk[i].DiskWrite > byDisk[j].DiskRead+byDisk[j].DiskWrite
	})
	sort.Slice(byNet, func(i, j int) bool {
		return byNet[i].NetIn+byNet[i].NetOut > byNet[j].NetIn+byNet[j].NetOut
	})
	if len(byDisk) > 16 {
		byDisk = byDisk[:16]
	}
	if len(byNet) > 16 {
		byNet = byNet[:16]
	}
	return map[string]any{
		"all": all, "tree": all, "byCPU": byCPU, "byMem": byMem,
		"byDisk": byDisk, "byNet": byNet,
	}
}
