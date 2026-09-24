package api

// Compat routes — local inference engine supervision (/engine/*) and the
// widget window toggle, matching LocalServer.engineResponse /
// widgetWindowResponse in the macOS app.
//
//   GET  /engine        — per-backend supervisor state + hardware + catalogs
//   GET  /engine/bench  — latest scripts/bench-engines.sh results
//   POST /engine/serve  {backend?, model, tokenizer?, max_memory_gb?,
//                        max_context_k?}  — backend defaults to "splash"
//   POST /engine/stop   {backend?}       — defaults to "splash"
//   GET|POST /widget/window ?value=hours|days|weeks|months|years

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/castlemilk/token-horizon/daemons/go/internal/engine"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

func (a *apiServer) compatEngineRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /engine", a.compatEngineSnapshot)
	mux.HandleFunc("GET /engine/bench", a.compatEngineBench)
	mux.HandleFunc("POST /engine/serve", a.compatEngineServe)
	mux.HandleFunc("GET /engine/serve", a.compatEngineServe)
	mux.HandleFunc("POST /engine/stop", a.compatEngineStop)
	mux.HandleFunc("GET /engine/stop", a.compatEngineStop)
	mux.HandleFunc("GET /widget/window", a.compatWidgetWindow)
	mux.HandleFunc("POST /widget/window", a.compatWidgetWindow)
}

func (a *apiServer) engineManager() *engine.Manager {
	if a.engineFn == nil {
		return nil
	}
	return a.engineFn()
}

func (a *apiServer) compatEngineSnapshot(w http.ResponseWriter, r *http.Request) {
	mgr := a.engineManager()
	if mgr == nil {
		writeErr(w, 503, "engine supervisor unavailable")
		return
	}
	writeJSON(w, 200, mgr.SnapshotPayload())
}

func (a *apiServer) compatEngineBench(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(engine.BenchPath())
	if err != nil {
		writeErr(w, 404, "no benchmark results yet — run scripts/bench-engines.sh")
		return
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		writeErr(w, 500, "bench file unreadable")
		return
	}
	writeJSON(w, 200, obj)
}

func (a *apiServer) compatEngineServe(w http.ResponseWriter, r *http.Request) {
	mgr := a.engineManager()
	if mgr == nil {
		writeErr(w, 503, "engine supervisor unavailable")
		return
	}
	var obj map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&obj); err != nil {
		writeErr(w, 400, "expected JSON body {backend?, model, tokenizer?, max_memory_gb?, max_context_k?}")
		return
	}
	model, _ := obj["model"].(string)
	if model == "" {
		writeErr(w, 400, "model is required")
		return
	}
	backend, _ := obj["backend"].(string)
	if backend == "" {
		backend = "splash"
	}
	sup := mgr.Supervisor(backend)
	if sup == nil {
		writeErr(w, 400, "unknown backend '"+backend+"' — splash|thengine")
		return
	}
	tokenizer, _ := obj["tokenizer"].(string)
	num := func(k string) int {
		if f, ok := obj[k].(float64); ok {
			return int(f)
		}
		return 0
	}
	sup.Serve(model, tokenizer, num("max_memory_gb"), num("max_context_k"))
	writeJSON(w, 202, map[string]any{"ok": true})
}

func (a *apiServer) compatEngineStop(w http.ResponseWriter, r *http.Request) {
	mgr := a.engineManager()
	if mgr == nil {
		writeErr(w, 503, "engine supervisor unavailable")
		return
	}
	backend := "splash"
	var obj map[string]any
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&obj) == nil {
		if b, ok := obj["backend"].(string); ok && b != "" {
			backend = b
		}
	}
	sup := mgr.Supervisor(backend)
	if sup == nil {
		writeErr(w, 400, "unknown backend '"+backend+"' — splash|thengine")
		return
	}
	sup.Stop()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// compatWidgetWindow persists the widget chart window into settings.json's
// widgetPreferences (merge-write — the Swift app owns sibling keys like
// page/accent). The macOS app re-reads settings on the change; the daemon
// just needs to persist faithfully.
func (a *apiServer) compatWidgetWindow(w http.ResponseWriter, r *http.Request) {
	value := r.URL.Query().Get("value")
	if value == "" {
		_ = r.ParseForm()
		value = r.PostForm.Get("value")
	}
	switch value {
	case "hours", "days", "weeks", "months", "years":
	default:
		writeErr(w, 400, "invalid window, use hours/days/weeks/months/years")
		return
	}
	if err := platform.SetWidgetWindow(value); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "window": value})
}
