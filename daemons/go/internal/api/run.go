package api

// Boot: the daemon lifecycle (ported from token-horizon-headless/main.swift).
// Split as New (store + sync + identity) then Daemon.Run (capture hooks +
// serve) so the cmd layer can start meters in between without an import
// cycle (meter imports core, core never imports meter).

import (
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/cloudsync"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/store"
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
		serviceRemoveFn: d.ServiceRemoveFn, mitmStatusFn: d.MitmStatusFn, start: time.Now()}

	// Cloud sync backstop: retry pending deltas every 5 min so offline
	// stretches upload on reconnect (activity nudges cover the live path).
	if d.Syncer.Enabled() {
		go func() {
			time.Sleep(30 * time.Second)
			for {
				d.Syncer.Sync(d.Store)
				time.Sleep(300 * time.Second)
			}
		}()
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
