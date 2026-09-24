package api

// Boot: the daemon lifecycle (ported from token-horizon-headless/main.swift).
// Split as New (store + sync + identity) then Daemon.Run (capture hooks +
// serve) so the cmd layer can start meters in between without an import
// cycle (meter imports core, core never imports meter).

import (
	"fmt"
	rtpkg "github.com/castlemilk/token-horizon/daemons/go/internal/capture/runtime"
	"github.com/castlemilk/token-horizon/daemons/go/internal/cloudsync"
	"github.com/castlemilk/token-horizon/daemons/go/internal/engine"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform/system"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
	"github.com/castlemilk/token-horizon/daemons/go/internal/telemetry"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// MeterStatus is one running meter's diagnostics (GET /meters).
type MeterStatus struct {
	Vendor     string `json:"vendor"`
	ListenPort int    `json:"listen_port"`
	Target     string `json:"target"`
	Source     string `json:"source"`
	Seen       int64  `json:"seen"`
	Measured   int64  `json:"measured"`
	// Classified failures by class (auth/rateLimited/...; never stored).
	Errors map[string]int64 `json:"errors,omitempty"`
	// Repeat requests inside the retry window (possible double-counts).
	RetrySuspects  int64    `json:"retry_suspects"`
	RecentRetryIDs []string `json:"recent_retry_ids,omitempty"`
}

// VendorStatus is one catalog entry (GET /meters "catalog" — the UI renders
// toggles from this; no hardcoded vendor list client-side).
type VendorStatus struct {
	Vendor     string `json:"vendor"`
	Running    bool   `json:"running"`
	ListenPort int    `json:"listen_port,omitempty"`
	Target     string `json:"target,omitempty"`
}

// MeterRegistry is what the meter package provides to the API router.
type MeterRegistry interface {
	Status() []MeterStatus
	Catalog() []VendorStatus
}

type Daemon struct {
	Store  *store.Store
	Syncer *cloudsync.Syncer
	// LimitsRows supplies fresh quota rows for GET /limits (the limits
	// package registers here). LimitsRefresh forces a re-fetch.
	LimitsRows    func() any
	LimitsRefresh func()
	// Consolidate runs one file-consolidation pass (POST /consolidate);
	// Backfill imports file history (POST /analytics/backfill).
	ConsolidateFn func() any
	BackfillFn    func() any
	// SystemFn backs GET /system; ProcessesFn backs GET /processes.
	SystemFn    func() any
	ProcessesFn func() any
	// RuntimesFn backs GET /runtimes (self-managed runtime snapshots).
	RuntimesFn func() any
	// ServiceStatus/Install/Uninstall back the /service endpoints
	// (user-scoped auto-start: systemd --user / LaunchAgent).
	ServiceStatusFn  func() any
	ServiceInstallFn func() any
	ServiceRemoveFn  func() any
	// MitmStatusFn folds the scoped-MITM checklist into GET /meters.
	MitmStatusFn func() any
	// Engine is the local-inference supervisor behind GET/POST /engine/*
	// (splash :8000 + th-engine :8001, attach-or-spawn). Nil disables the
	// routes with 503.
	Engine *engine.Manager
}

func New() (*Daemon, error) {
	storePath := filepath.Join(platform.ConfigDir(), "usage.db")
	store, err := store.OpenStore(storePath)
	if err != nil {
		return nil, fmt.Errorf("usage store unavailable: %w", err)
	}
	syncer := cloudsync.NewSyncer()
	// Persisted cloud sign-in overrides env identity (daemon syncs as the
	// signed-in user with the UI closed) — same boot order as Swift main.
	if id := platform.LoadCloudIdentity(); id != nil {
		syncer.ApplyIdentity(id)
	}
	return &Daemon{Store: store, Syncer: syncer}, nil
}

// Run starts capture hooks (meters passed from the cmd layer) and serves.
func (d *Daemon) Run(port int, meters MeterRegistry) {
	defer d.Store.Close()

	methodology := platform.LoadSettings().Methodology()
	fmt.Fprintf(os.Stderr, "token-horizon-daemon %s: methodology=%s\n", platform.Version(), methodology)

	srv := &apiServer{store: d.Store, syncer: d.Syncer, meters: meters,
		limitsRows: d.LimitsRows, limitsRefresh: d.LimitsRefresh,
		consolidateFn: d.ConsolidateFn, backfillFn: d.BackfillFn,
		systemFn: d.SystemFn, processesFn: d.ProcessesFn, runtimesFn: d.RuntimesFn,
		serviceStatusFn: d.ServiceStatusFn, serviceInstallFn: d.ServiceInstallFn,
		serviceRemoveFn: d.ServiceRemoveFn, mitmStatusFn: d.MitmStatusFn,
		engineFn: func() *engine.Manager { return d.Engine }, start: time.Now()}

	// Cloud sync backstop: retry pending deltas every 5 min so offline
	// stretches upload on reconnect (activity nudges cover the live path).
	// Always running: Sync() self-gates on sign-in, so the backstop starts
	// pushing as soon as the user completes the identity handoff.
	go func() {
		time.Sleep(30 * time.Second)
		for {
			d.Syncer.Sync(d.Store)
			time.Sleep(300 * time.Second)
		}
	}()

	// OTLP push exporter — off unless OTEL_EXPORTER_OTLP_* is set (same env
	// contract as the Swift TelemetryMetrics). Cumulative counters need no
	// queue: an offline collector just sees the next tick's totals.
	if exp := telemetry.New(func() []telemetry.Metric {
		return collectMetrics(d.Store, meters, d.RuntimesFn)
	}); exp != nil {
		exp.Start()
		defer exp.Stop()
	}

	ln, actual, err := listen(port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "token-horizon-daemon: no free loopback port in %d-%d\n", port, port+19)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "token-horizon-daemon: listening on http://127.0.0.1:%d\n", actual)
	if err := http.Serve(ln, srv.mux()); err != nil {
		fmt.Fprintf(os.Stderr, "token-horizon-daemon: serve: %v\n", err)
		os.Exit(1)
	}
}

// collectMetrics builds the OTLP set each push: usage event count,
// per-meter seen/measured/errors, runtime tok/s gauges, system snapshot.
func collectMetrics(st *store.Store, meters MeterRegistry, runtimesFn func() any) []telemetry.Metric {
	var out []telemetry.Metric
	if n, err := st.Count(); err == nil {
		out = append(out, telemetry.Metric{Name: "token_horizon_usage_events_total", Value: float64(n), IsSum: true, Unit: "1"})
	}
	if meters != nil {
		for _, m := range meters.Status() {
			attrs := map[string]string{"vendor": m.Vendor}
			out = append(out,
				telemetry.Metric{Name: "token_horizon_meter_seen_total", Value: float64(m.Seen), IsSum: true, Unit: "1", Attrs: attrs},
				telemetry.Metric{Name: "token_horizon_meter_measured_total", Value: float64(m.Measured), IsSum: true, Unit: "1", Attrs: attrs},
				telemetry.Metric{Name: "token_horizon_meter_retry_suspects_total", Value: float64(m.RetrySuspects), IsSum: true, Unit: "1", Attrs: attrs})
			for class, n := range m.Errors {
				out = append(out, telemetry.Metric{
					Name: "token_horizon_meter_errors_total", Value: float64(n), IsSum: true, Unit: "1",
					Attrs: map[string]string{"vendor": m.Vendor, "class": class}})
			}
		}
	}
	if runtimesFn != nil {
		if snaps, ok := runtimesFn().([]rtpkg.Snapshot); ok {
			for _, s := range snaps {
				attrs := map[string]string{"vendor": s.Vendor}
				running := 0.0
				if s.Running {
					running = 1
				}
				out = append(out,
					telemetry.Metric{Name: "token_horizon_runtime_active", Value: running, Unit: "1", Attrs: attrs},
					telemetry.Metric{Name: "token_horizon_runtime_tokens_total", Value: float64(s.Usage.TokensAll), IsSum: true, Unit: "1", Attrs: attrs})
				if s.TokPerSec != nil {
					out = append(out, telemetry.Metric{Name: "token_horizon_runtime_tok_per_sec", Value: *s.TokPerSec, Unit: "1", Attrs: attrs})
				}
			}
		}
	}
	snap := system.TakeSnapshot()
	out = append(out,
		telemetry.Metric{Name: "token_horizon_system_cpu_percent", Value: snap.CPUPercent, Unit: "1"},
		telemetry.Metric{Name: "token_horizon_system_ram_used_bytes", Value: snap.RAMUsedGB * 1073741824, Unit: "By"},
		telemetry.Metric{Name: "token_horizon_system_disk_bytes_per_sec", Value: snap.DiskMBps * 1048576, Unit: "By/s"},
		telemetry.Metric{Name: "token_horizon_system_net_bytes_per_sec", Value: snap.NetMBps * 1048576, Unit: "By/s"})
	return out
}
