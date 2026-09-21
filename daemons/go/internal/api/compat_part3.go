package api

// Compat routes, part 3 — the long tail of the LocalServer surface:
// leaderboard sync/share/config, discovery, process control, aliases.
// Peer leaderboard entries are read from (and POSTs upsert into) the
// Swift-written leaderboard.json in the shared config dir — the two daemons
// hand off the file during the migration window, no peer store re-ported.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/catalog"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
	"github.com/castlemilk/token-horizon/daemons/go/internal/system"
)

func (a *apiServer) compatRoutes3(mux *http.ServeMux) {
	// Aliases the Swift server exposes.
	mux.HandleFunc("GET /local-models", a.compatLocal)
	mux.HandleFunc("GET /mlx", a.compatLocal)
	mux.HandleFunc("GET /catalog", a.compatModelsCatalog)
	mux.HandleFunc("GET /cache/reset", a.compatCacheReset)
	mux.HandleFunc("POST /ingest/ollama", a.compatOllamaIngest)

	// Reads with no Go-side store yet — honest empty payloads.
	mux.HandleFunc("GET /projects", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []any{})
	})
	mux.HandleFunc("GET /claude/accounts", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []any{})
	})
	mux.HandleFunc("GET /widget", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"version": 5, "generatedAt": time.Now().Unix()})
	})

	// Process control.
	mux.HandleFunc("GET /process", a.compatProcessDetail)
	mux.HandleFunc("POST /kill", a.compatKill)

	// Discovery: the Go catalog refreshes itself (EnsureLoaded, 24h TTL);
	// scan forces a re-fetch.
	mux.HandleFunc("GET /discovery/status", a.compatDiscoveryStatus)
	mux.HandleFunc("GET /models/discovery", a.compatDiscoveryStatus)
	mux.HandleFunc("POST /discovery/scan", a.compatDiscoveryScan)
	mux.HandleFunc("POST /models/scan", a.compatDiscoveryScan)

	// Leaderboard: file-backed peer entries + cloud/sheets bridges.
	mux.HandleFunc("POST /leaderboard", a.compatLeaderboardUpsert)
	mux.HandleFunc("POST /leaderboard/sync", a.compatLeaderboardSync)
	mux.HandleFunc("GET /leaderboard/share", a.compatShare)
	mux.HandleFunc("GET /leaderboard/web", a.compatLeaderboardWeb)
	mux.HandleFunc("GET /leaderboard/pages", a.compatLeaderboardWeb)
	for _, p := range []string{"/leaderboard/sheets/config", "/leaderboard/cloud/config", "/leaderboard/cloudflare/config"} {
		mux.HandleFunc("GET "+p, a.compatLBConfigGet)
		mux.HandleFunc("POST "+p, a.compatLBConfigPost)
	}
	for _, p := range []string{"/leaderboard/cloud/publish", "/leaderboard/cloudflare/publish"} {
		mux.HandleFunc("POST "+p, a.compatCloudPublish)
		mux.HandleFunc("GET "+p, a.compatCloudPublish)
	}
	for _, p := range []string{"/leaderboard/cloud/pull", "/leaderboard/cloudflare/pull"} {
		mux.HandleFunc("POST "+p, a.compatCloudPull)
		mux.HandleFunc("GET "+p, a.compatCloudPull)
	}
	mux.HandleFunc("POST /leaderboard/sheets/publish", a.compatSheetsPublish)
	mux.HandleFunc("GET /leaderboard/sheets/publish", a.compatSheetsPublish)
	mux.HandleFunc("POST /leaderboard/sheets/pull", a.compatSheetsPull)
	mux.HandleFunc("GET /leaderboard/sheets/pull", a.compatSheetsPull)
}

// ---- ingest / process control ------------------------------------------

// POST /ingest/ollama — gateway sidecar's best-effort sample intake. The Go
// daemon measures Ollama through its own meter + runtime monitor, so the
// payload is acknowledged and dropped (documented in the Swift route too:
// "the gateway never retries; malformed samples are dropped loudly").
func (a *apiServer) compatOllamaIngest(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] == "" {
		writeErr(w, http.StatusBadRequest, "invalid ollama sample")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /process?pid= — single-process detail from the live sampler.
func (a *apiServer) compatProcessDetail(w http.ResponseWriter, r *http.Request) {
	pid, _ := strconv.Atoi(r.URL.Query().Get("pid"))
	for _, p := range system.AllProcesses() {
		if int(p.PID) == pid {
			writeJSON(w, 200, p)
			return
		}
	}
	writeErr(w, http.StatusNotFound, "no such pid")
}

// POST /kill — terminate a process by pid (SIGTERM; same as the Swift route).
func (a *apiServer) compatKill(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	pid, err := strconv.Atoi(r.Form.Get("pid"))
	if err != nil || pid <= 0 {
		var body struct {
			PID int `json:"pid"`
		}
		if json.NewDecoder(r.Body).Decode(&body) == nil {
			pid = body.PID
		}
	}
	if pid <= 0 {
		writeErr(w, http.StatusBadRequest, "missing pid")
		return
	}
	if err := system.Kill(int32(pid), syscall.SIGTERM); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "pid": pid})
}

// ---- discovery ----------------------------------------------------------

func (a *apiServer) compatDiscoveryStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"catalogCount": len(catalog.All()),
		"lastScanAt":   time.Now().UTC().Format(time.RFC3339),
		"sources":      map[string]any{"models.dev": "catalog", "runtimes": "monitor"},
	})
}

func (a *apiServer) compatDiscoveryScan(w http.ResponseWriter, r *http.Request) {
	catalog.Refresh()
	a.compatDiscoveryStatus(w, r)
}

// ---- leaderboard entries file ------------------------------------------

// leaderboardEntry mirrors the Swift LeaderboardEntry wire fields
// (leaderboard.json, camelCase, updatedAt epoch seconds).
type lbEntry struct {
	ID            string  `json:"id"`
	Handle        string  `json:"handle"`
	Team          string  `json:"team"`
	TokensToday   int64   `json:"tokensToday"`
	Tokens7d      int64   `json:"tokens7d"`
	TokensAll     int64   `json:"tokensAll"`
	CostToday     float64 `json:"costToday"`
	Cost7d        float64 `json:"cost7d"`
	CostAll       float64 `json:"costAll"`
	StreakDays    int     `json:"streakDays"`
	TopModel      string  `json:"topModel"`
	Hardware      string  `json:"hardware"`
	IsLocal       bool    `json:"isLocal"`
	UpdatedAt     int64   `json:"updatedAt"`
	MMR           int     `json:"mmr"`
	League        string  `json:"league"`
	Division      int     `json:"division"`
	Efficiency    float64 `json:"efficiency"`
	RequestsToday int64   `json:"requestsToday"`
	RequestsAll   int64   `json:"requestsAll"`
}

func leaderboardPath() string { return filepath.Join(platform.ConfigDir(), "leaderboard.json") }

func loadLBEntries() []lbEntry {
	data, err := os.ReadFile(leaderboardPath())
	if err != nil {
		return nil
	}
	var entries []lbEntry
	if json.Unmarshal(data, &entries) != nil {
		return nil
	}
	return entries
}

func saveLBEntries(entries []lbEntry) {
	data, err := json.Marshal(entries)
	if err != nil {
		return
	}
	_ = os.WriteFile(leaderboardPath(), data, 0o644)
}

// localLBEntry builds this machine's row from the metered store.
func (a *apiServer) localLBEntry() lbEntry {
	now := time.Now().Unix()
	rToday, _ := a.store.Summary(store.Filter{From: todayStart()})
	r7d, _ := a.store.Summary(store.Filter{From: now - 7*86400})
	rAll, _ := a.store.Summary(store.Filter{})
	return lbEntry{
		ID: "local", Handle: compatHandle(), Team: "",
		TokensToday: sumRows(rToday).tokens(), Tokens7d: sumRows(r7d).tokens(),
		TokensAll: sumRows(rAll).tokens(),
		CostToday: sumRows(rToday).cost, Cost7d: sumRows(r7d).cost, CostAll: sumRows(rAll).cost,
		StreakDays: a.compatStreak(), TopModel: topModel(rAll),
		Hardware: platform.MachineAlias(), IsLocal: true, UpdatedAt: now,
		RequestsToday: sumRows(rToday).requests, RequestsAll: sumRows(rAll).requests,
	}
}

// compatLeaderboard upgrades compat_leaderboard.go's self-only version to
// merge peer rows from leaderboard.json (Swift-written or cloud-pulled).
func (a *apiServer) compatLeaderboardPeers(w http.ResponseWriter, r *http.Request) {
	period := r.URL.Query().Get("period")
	entries := loadLBEntries()
	entries = append(entries, a.localLBEntry()) // local row is always live
	score := func(e lbEntry) int64 {
		switch period {
		case "today":
			return e.TokensToday
		case "week", "7d":
			return e.Tokens7d
		case "streak":
			return int64(e.StreakDays)
		default:
			return e.TokensAll
		}
	}
	sort.Slice(entries, func(i, j int) bool { return score(entries[i]) > score(entries[j]) })
	badges := []string{"🥇", "🥈", "🥉"}
	ranked := make([]any, 0, len(entries))
	var userRank any
	for i, e := range entries {
		badge := ""
		if i < 3 {
			badge = badges[i]
		}
		row := map[string]any{
			"rank": i + 1, "badge": badge, "percentile": 100 - float64(i)/float64(len(entries))*100,
			"entry": e, "score": score(e), "scoreFormatted": fmtTokens(score(e)),
			"costFormatted": fmt.Sprintf("$%.2f", e.CostAll), "relativePercent": 100,
			"league": e.League, "division": e.Division, "mmr": e.MMR,
			"efficiency": e.Efficiency, "avgPerRequest": 0, "trend": []any{},
		}
		if e.IsLocal {
			userRank = row
		}
		ranked = append(ranked, row)
	}
	titles := map[string]string{"today": "Today", "week": "Last 7 Days", "7d": "Last 7 Days", "all": "All Time", "streak": "Streak"}
	writeJSON(w, 200, map[string]any{
		"period": period, "periodTitle": titles[period], "total": len(ranked),
		"team": "", "userRank": userRank, "leaderboard": ranked,
	})
}

// POST /leaderboard — upsert an entry into leaderboard.json (peer or local).
func (a *apiServer) compatLeaderboardUpsert(w http.ResponseWriter, r *http.Request) {
	var e lbEntry
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil || e.ID == "" {
		writeErr(w, http.StatusBadRequest, "invalid entry")
		return
	}
	entries := loadLBEntries()
	for i, existing := range entries {
		if existing.ID == e.ID {
			entries[i] = e
			saveLBEntries(entries)
			writeJSON(w, 200, map[string]any{"ok": true, "count": len(entries)})
			return
		}
	}
	entries = append(entries, e)
	saveLBEntries(entries)
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(entries)})
}

// POST /leaderboard/sync — force the cloudsync outbox to flush now.
func (a *apiServer) compatLeaderboardSync(w http.ResponseWriter, r *http.Request) {
	if a.syncer != nil {
		go a.syncer.Sync(a.store)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /leaderboard/share?period=&format= — local share card (text/markdown).
func (a *apiServer) compatShare(w http.ResponseWriter, r *http.Request) {
	period := r.URL.Query().Get("period")
	e := a.localLBEntry()
	var score int64
	var label string
	switch period {
	case "today":
		score, label = e.TokensToday, "today"
	case "week", "7d":
		score, label = e.Tokens7d, "last 7 days"
	case "streak":
		score, label = int64(e.StreakDays), "day streak"
	default:
		score, label = e.TokensAll, "all time"
	}
	card := fmt.Sprintf("🏁 @%s — %s tokens %s · $%.2f · 🔥 %dd streak · top model %s",
		e.Handle, fmtTokens(score), label, e.CostAll, e.StreakDays, e.TopModel)
	if r.URL.Query().Get("format") == "json" {
		writeJSON(w, 200, map[string]any{"card": card, "period": period})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(card))
}

// GET /leaderboard/web|pages — 302 to the configured dashboard (or default).
func (a *apiServer) compatLeaderboardWeb(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	target := "https://token-horizon.dev/leaderboard"
	if cfg.CloudURL != "" {
		if strings.HasSuffix(cfg.CloudURL, "/leaderboard.html") {
			target = cfg.CloudURL
		} else {
			target = strings.TrimSuffix(cfg.CloudURL, "/") + "/leaderboard.html"
		}
	} else if cfg.SheetsURL != "" {
		target += "?sheet=" + cfg.SheetsURL
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// ---- leaderboard config + cloud/sheets bridges ---------------------------

type lbConfig struct {
	SheetsURL  string `json:"sheetsURL"`
	CloudURL   string `json:"cloudURL"`
	CloudToken string `json:"cloudToken,omitempty"`
	AutoSync   bool   `json:"autoSync"`
}

func lbConfigPath() string { return filepath.Join(platform.ConfigDir(), "leaderboard-config.json") }

func loadLBConfig() lbConfig {
	var cfg lbConfig
	if data, err := os.ReadFile(lbConfigPath()); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func (a *apiServer) compatLBConfigGet(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	writeJSON(w, 200, map[string]any{
		"sheetsURL": cfg.SheetsURL, "cloudURL": cfg.CloudURL,
		"cloudflareURL": cfg.CloudURL, "autoSync": cfg.AutoSync,
		"cloudConfigured": cfg.CloudURL != "",
	})
}

func (a *apiServer) compatLBConfigPost(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if v, ok := body["sheetsURL"].(string); ok {
		cfg.SheetsURL = v
	}
	if v, ok := body["cloudURL"].(string); ok {
		cfg.CloudURL = v
	}
	if v, ok := body["cloudflareURL"].(string); ok {
		cfg.CloudURL = v
	}
	if v, ok := body["cloudToken"].(string); ok && v != "" {
		cfg.CloudToken = v
	}
	if v, ok := body["autoSync"].(bool); ok {
		cfg.AutoSync = v
	}
	if data, err := json.Marshal(cfg); err == nil {
		_ = os.WriteFile(lbConfigPath(), data, 0o600)
	}
	a.compatLBConfigGet(w, r)
}

// Cloud publish: POST the local entry to <cloudURL>/api/leaderboard (the
// worker's upsert route). Cloud pull: GET /api/leaderboard?period=all&full=1
// → merge entries into leaderboard.json.
func (a *apiServer) compatCloudPublish(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	if cfg.CloudURL == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "cloud URL not configured"})
		return
	}
	entry := a.localLBEntry()
	body, _ := json.Marshal(entry)
	url := strings.TrimSuffix(cfg.CloudURL, "/") + "/api/leaderboard"
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if cfg.CloudToken != "" {
		req.Header.Set("X-Leaderboard-Secret", cfg.CloudToken)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	writeJSON(w, 200, map[string]any{"ok": resp.StatusCode < 300, "status": resp.StatusCode})
}

func (a *apiServer) compatCloudPull(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	if cfg.CloudURL == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "cloud URL not configured"})
		return
	}
	url := strings.TrimSuffix(cfg.CloudURL, "/") + "/api/leaderboard?period=all&full=1"
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Get(url)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	var payload struct {
		Leaderboard []struct {
			Entry lbEntry `json:"entry"`
		} `json:"leaderboard"`
		Entries []lbEntry `json:"entries"`
	}
	_ = json.Unmarshal(data, &payload)
	var pulled []lbEntry
	for _, r := range payload.Leaderboard {
		pulled = append(pulled, r.Entry)
	}
	pulled = append(pulled, payload.Entries...)
	if len(pulled) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "count": 0, "message": "no remote entries"})
		return
	}
	entries := loadLBEntries()
	idx := map[string]int{}
	for i, e := range entries {
		idx[e.ID] = i
	}
	for _, e := range pulled {
		if i, ok := idx[e.ID]; ok {
			entries[i] = e
		} else {
			entries = append(entries, e)
		}
	}
	saveLBEntries(entries)
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(pulled)})
}

// Sheets bridge: publish POSTs the local entry JSON to the webhook;
// pull GETs it (the Apps Script bridge echoes rows back).
func (a *apiServer) compatSheetsPublish(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	if cfg.SheetsURL == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "sheets URL not configured"})
		return
	}
	body, _ := json.Marshal(a.localLBEntry())
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Post(cfg.SheetsURL, "application/json", bytes.NewReader(body))
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	writeJSON(w, 200, map[string]any{"ok": resp.StatusCode < 300, "status": resp.StatusCode})
}

func (a *apiServer) compatSheetsPull(w http.ResponseWriter, r *http.Request) {
	cfg := loadLBConfig()
	if cfg.SheetsURL == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "sheets URL not configured"})
		return
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Get(cfg.SheetsURL)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	var pulled []lbEntry
	if json.Unmarshal(data, &pulled) == nil && len(pulled) > 0 {
		entries := loadLBEntries()
		idx := map[string]int{}
		for i, e := range entries {
			idx[e.ID] = i
		}
		for _, e := range pulled {
			if i, ok := idx[e.ID]; ok {
				entries[i] = e
			} else {
				entries = append(entries, e)
			}
		}
		saveLBEntries(entries)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(pulled)})
}
