package api

// Loopback API — implements the CoreAPIRouter contract (the SvelteKit UI,
// MCP shim and shell hooks speak HTTP and are implementation-agnostic).
// M1 surface: health, analytics reads, event ingest, sync, cloud identity,
// capture-methodology config. Meters / MITM / limits engines / file
// consolidators / system stats land in M2-M3 behind these same routes.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/castlemilk/token-horizon/daemons/go/internal/cloudsync"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"net"
	"net/http"
	"strconv"
	"time"
)

type apiServer struct {
	store            *store.Store
	syncer           *cloudsync.Syncer
	meters           MeterRegistry
	limitsRows       func() any
	limitsRefresh    func()
	consolidateFn    func() any
	backfillFn       func() any
	systemFn         func() any
	processesFn      func() any
	runtimesFn       func() any
	serviceStatusFn  func() any
	serviceInstallFn func() any
	serviceRemoveFn  func() any
	mitmStatusFn     func() any
	start            time.Time
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

// clearTraces serves POST (and legacy GET) /traces/clear.
func (a *apiServer) clearTraces(w http.ResponseWriter, r *http.Request) {
	n, err := a.store.ClearTraces()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "clearedTraces": n})
}

func queryFilter(r *http.Request) store.Filter {
	q := r.URL.Query()
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
	to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
	return store.Filter{
		From:        from,
		To:          to,
		MeteredOnly: q.Get("metered") == "1",
		Vendor:      q.Get("vendor"),
		Model:       q.Get("model"),
		MachineID:   q.Get("machine"),
		Product:     q.Get("product"),
		SessionID:   q.Get("session"),
		ID:          q.Get("id"),
	}
}

func (a *apiServer) mux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"ok": true, "name": "token-horizon-daemon", "platform": platform.Name(),
			"version": platform.Version(), "usage_store": a.store != nil,
			"machine_id": platform.MachineID(), "machine_alias": platform.MachineAlias(),
			"methodology": platform.LoadSettings().Methodology(),
			"uptime_s":    int64(time.Since(a.start).Seconds()),
		})
	})

	// ---- meters (point-mode capture; the meter package registers here) ----

	mux.HandleFunc("GET /meters", func(w http.ResponseWriter, r *http.Request) {
		point := []MeterStatus{}
		catalog := []VendorStatus{}
		if a.meters != nil {
			point = a.meters.Status()
			catalog = a.meters.Catalog()
		}
		resp := map[string]any{
			"mode":    platform.LoadSettings().Methodology(),
			"point":   point,
			"catalog": catalog,
		}
		if a.mitmStatusFn != nil {
			resp["mitm"] = a.mitmStatusFn()
		}
		writeJSON(w, 200, resp)
	})

	// ---- system stats (the system package registers here) ----

	mux.HandleFunc("GET /system", func(w http.ResponseWriter, r *http.Request) {
		if a.systemFn == nil {
			writeErr(w, 404, "no system stats provider on this platform")
			return
		}
		writeJSON(w, 200, a.systemFn())
	})

	mux.HandleFunc("GET /processes", func(w http.ResponseWriter, r *http.Request) {
		if a.processesFn == nil {
			writeErr(w, 404, "no system stats provider on this platform")
			return
		}
		writeJSON(w, 200, a.processesFn())
	})

	mux.HandleFunc("GET /runtimes", func(w http.ResponseWriter, r *http.Request) {
		// Bare array — the Swift wire contract the UI parses.
		if a.runtimesFn == nil {
			writeJSON(w, 200, []any{})
			return
		}
		writeJSON(w, 200, a.runtimesFn())
	})

	// ---- auto-start service registration ----

	mux.HandleFunc("GET /service", func(w http.ResponseWriter, r *http.Request) {
		if a.serviceStatusFn == nil {
			writeErr(w, 404, "auto-start not supported on this platform")
			return
		}
		writeJSON(w, 200, a.serviceStatusFn())
	})

	mux.HandleFunc("POST /service/install", func(w http.ResponseWriter, r *http.Request) {
		if a.serviceInstallFn == nil {
			writeErr(w, 404, "auto-start not supported on this platform")
			return
		}
		writeJSON(w, 200, a.serviceInstallFn())
	})

	mux.HandleFunc("POST /service/uninstall", func(w http.ResponseWriter, r *http.Request) {
		if a.serviceRemoveFn == nil {
			writeErr(w, 404, "auto-start not supported on this platform")
			return
		}
		writeJSON(w, 200, a.serviceRemoveFn())
	})

	// ---- file consolidation (files annotate; deliberate passes) ----

	mux.HandleFunc("POST /consolidate", func(w http.ResponseWriter, r *http.Request) {
		// Deliberate one-pass file consolidation (tool annotations + limit
		// snapshots). Files never create usage rows in point/mitm.
		if !platform.ConsentGranted("fileReading") {
			writeErr(w, 403, "fileReading consent not granted")
			return
		}
		if a.consolidateFn == nil {
			writeErr(w, 503, "consolidation unavailable")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "observations": a.consolidateFn()})
	})

	mux.HandleFunc("POST /analytics/backfill", func(w http.ResponseWriter, r *http.Request) {
		// Deliberate one-time import of file-derived history into the event
		// store (attestation-marked; deterministic ids make re-runs no-ops).
		// Files stay annotation-only on the live path — this is the
		// documented bootstrap exception (automatic ONLY in files methodology).
		if a.backfillFn == nil {
			writeErr(w, 503, "backfill unavailable")
			return
		}
		writeJSON(w, 200, a.backfillFn())
	})

	// ---- analytics ----

	mux.HandleFunc("GET /analytics/events", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		events, next, err := a.store.EventsPage(queryFilter(r), cursor, limit)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"events": events, "next_cursor": next})
	})

	mux.HandleFunc("POST /analytics/events", func(w http.ResponseWriter, r *http.Request) {
		var events []usage.Event
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
		if err := dec.Decode(&events); err != nil {
			var single usage.Event
			if err2 := json.NewDecoder(r.Body).Decode(&single); err2 != nil || single.ID == "" {
				writeErr(w, 400, "body must be a UsageEvent or [UsageEvent] JSON (max 1000)")
				return
			}
			events = []usage.Event{single}
		}
		if len(events) == 0 || len(events) > 1000 {
			writeErr(w, 400, "body must be a UsageEvent or [UsageEvent] JSON (max 1000)")
			return
		}
		for i := range events {
			if events[i].MachineID == "" {
				events[i].MachineID = platform.MachineID()
			}
			if events[i].Timestamp == 0 {
				events[i].Timestamp = time.Now().Unix()
			}
		}
		inserted, err := a.store.InsertMetered(events)
		if err != nil {
			writeErr(w, 500, "insert failed: "+err.Error())
			return
		}
		a.syncer.NoteActivity(a.store)
		total, _ := a.store.Count()
		writeJSON(w, 200, map[string]any{"inserted": inserted, "total": total})
	})

	mux.HandleFunc("GET /analytics/buckets", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		res, _ := strconv.Atoi(q.Get("resolution"))
		buckets, err := a.store.Buckets(queryFilter(r), res)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"resolution": store.SnapBucketSeconds(res), "buckets": buckets})
	})

	mux.HandleFunc("GET /analytics/summary", func(w http.ResponseWriter, r *http.Request) {
		providers, err := a.store.Summary(queryFilter(r))
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"providers": providers})
	})

	mux.HandleFunc("GET /analytics/count", func(w http.ResponseWriter, r *http.Request) {
		n, err := a.store.Count()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"count": n})
	})

	// ---- traces (sidecar /traces + /proxy/stats contract, daemon-owned:
	// one row per completed exchange, bodies capped, auth never stored) ----
	mux.HandleFunc("GET /traces", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		traces, err := a.store.TracePage(q.Get("provider"), q.Get("model"), limit)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		if traces == nil {
			traces = []usage.TraceSummary{}
		}
		n, _ := a.store.TraceCount()
		writeJSON(w, 200, map[string]any{"traces": traces, "count": n})
	})

	mux.HandleFunc("GET /traces/{id}", func(w http.ResponseWriter, r *http.Request) {
		tr, err := a.store.TraceByID(r.PathValue("id"))
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, 404, "no such trace")
			return
		}
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, tr)
	})

	// GET kept for sidecar parity (its UI used plain links); POST is the
	// semantically correct form.
	mux.HandleFunc("POST /traces/clear", a.clearTraces)
	mux.HandleFunc("GET /traces/clear", a.clearTraces)

	mux.HandleFunc("GET /proxy/stats", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		hours, _ := strconv.Atoi(q.Get("hours"))
		stats, err := a.store.TraceStats(q.Get("provider"), q.Get("model"), hours)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, stats)
	})

	// ---- limits (M1: latest recorded snapshots from the store; the vendor
	// quota engines land in M2 and record into the same table) ----

	mux.HandleFunc("GET /limits", func(w http.ResponseWriter, r *http.Request) {
		// Quota-engine cache (Swift: PlanLimitsEngine + KimiLimitsEngine
		// cachedLimits). Wire-recorded windows live on the history timeline.
		if a.limitsRows != nil {
			writeJSON(w, 200, map[string]any{"limits": a.limitsRows()})
			return
		}
		writeJSON(w, 200, map[string]any{"limits": []any{}})
	})

	mux.HandleFunc("POST /limits/refresh", func(w http.ResponseWriter, r *http.Request) {
		// Manual refresh: force a re-fetch, return the current cache
		// immediately — the UI fast-polls GET /limits until rows land.
		if a.limitsRefresh != nil {
			a.limitsRefresh()
		}
		if a.limitsRows != nil {
			writeJSON(w, 200, map[string]any{"limits": a.limitsRows()})
			return
		}
		writeJSON(w, 200, map[string]any{"limits": []any{}})
	})

	mux.HandleFunc("GET /limits/history", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
		to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
		if to == 0 {
			to = time.Now().Unix() + 1
		}
		snaps, err := a.store.LimitHistory(from, to, 2000)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		if provider := q.Get("provider"); provider != "" {
			filtered := snaps[:0]
			for _, sn := range snaps {
				if usage.Vendor(sn.Provider) == usage.Vendor(provider) {
					filtered = append(filtered, sn)
				}
			}
			snaps = filtered
		}
		writeJSON(w, 200, map[string]any{"snapshots": snaps})
	})

	// ---- sync ----

	mux.HandleFunc("GET /sync/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, a.syncer.Status(a.store))
	})
	mux.HandleFunc("POST /sync/now", func(w http.ResponseWriter, r *http.Request) {
		report := a.syncer.Sync(a.store)
		writeJSON(w, 200, map[string]any{"report": report})
	})

	// ---- cloud identity (daemon-held sign-in; identical file + semantics
	// to the Swift core's /cloud/identity) ----

	mux.HandleFunc("GET /cloud/identity", func(w http.ResponseWriter, r *http.Request) {
		id := platform.LoadCloudIdentity()
		out := map[string]any{
			"signed_in":    id != nil,
			"sync_enabled": a.syncer.Enabled(),
			"handle":       nil, "user_id": nil, "team": nil,
			"display_name": nil, "avatar_url": nil, "base_url": nil, "saved_at": nil,
		}
		if id != nil {
			out["handle"] = id.Handle
			out["user_id"] = id.UserID
			out["team"] = id.Team
			out["display_name"] = id.DisplayName
			out["avatar_url"] = id.AvatarURL
			out["base_url"] = id.BaseURL
			out["saved_at"] = id.SavedAt
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /cloud/identity", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BaseURL     string `json:"base_url"`
			Handle      string `json:"handle"`
			UserID      string `json:"user_id"`
			Team        string `json:"team"`
			DisplayName string `json:"display_name"`
			AvatarURL   string `json:"avatar_url"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		if body.Handle == "" || body.UserID == "" {
			writeErr(w, 400, "body must be {base_url, handle, user_id, team?, display_name?, avatar_url?}")
			return
		}
		id := &platform.CloudIdentity{
			BaseURL: body.BaseURL, Handle: body.Handle, UserID: body.UserID,
			Team: body.Team, DisplayName: body.DisplayName, AvatarURL: body.AvatarURL,
		}
		if err := platform.SaveCloudIdentity(id); err != nil {
			writeErr(w, 500, "persist failed: "+err.Error())
			return
		}
		a.syncer.ApplyIdentity(id)
		a.syncer.NoteActivity(a.store)
		writeJSON(w, 200, map[string]any{"ok": true, "signed_in": true, "sync_enabled": a.syncer.Enabled()})
	})
	mux.HandleFunc("DELETE /cloud/identity", func(w http.ResponseWriter, r *http.Request) {
		platform.ClearCloudIdentity()
		a.syncer.ClearIdentity()
		writeJSON(w, 200, map[string]any{"ok": true, "signed_in": false})
	})

	// ---- capture methodology config ----

	mux.HandleFunc("GET /config/capture", func(w http.ResponseWriter, r *http.Request) {
		s := platform.LoadSettings()
		writeJSON(w, 200, map[string]any{
			"methodology": s.Methodology(),
			"options":     []string{platform.MethodologyPoint, platform.MethodologyMITM, platform.MethodologyFiles},
			"note":        "point/mitm always annotate from files; files mode makes scanners the usage source (selfReported)",
			"filePolling": s.FilePolling,
		})
	})
	mux.HandleFunc("POST /config/capture", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Methodology string `json:"methodology"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		switch body.Methodology {
		case platform.MethodologyPoint, platform.MethodologyMITM, platform.MethodologyFiles:
		default:
			writeErr(w, 400, "methodology must be point|mitm|files")
			return
		}
		if err := platform.SetMethodology(body.Methodology); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "methodology": body.Methodology})
	})

	// ---- metrics (minimal Prometheus text; OTel lands with telemetry M3) ----

	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		n, _ := a.store.Count()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte("token_horizon_usage_events_total " + strconv.FormatInt(n, 10) + "\n"))
	})

	a.compatRoutes(mux)
	return mux
}

// listen tries the loopback port range (8765-8784), same as the Swift
// daemon and the MITM addon's probe range.
func listen(preferred int) (net.Listener, int, error) {
	for p := preferred; p < preferred+20; p++ {
		ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			return ln, p, nil
		}
	}
	return nil, 0, &net.OpError{Op: "listen", Err: strconv.ErrSyntax}
}
