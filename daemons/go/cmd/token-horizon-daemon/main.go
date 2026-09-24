package main

// token-horizon-daemon — thin main over internal/core + internal/meter.
// The Go port of TokenHorizonCore: same usage.db schema, same config files,
// same loopback API contract as the Swift daemon it replaces at parity.

import (
	"flag"
	"github.com/castlemilk/token-horizon/daemons/go/internal/api"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"log"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/capture/files"
	"github.com/castlemilk/token-horizon/daemons/go/internal/capture/meter"
	"github.com/castlemilk/token-horizon/daemons/go/internal/capture/mitm"
	rtpkg "github.com/castlemilk/token-horizon/daemons/go/internal/capture/runtime"
	enginepkg "github.com/castlemilk/token-horizon/daemons/go/internal/engine"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform/service"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform/system"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits/vendors"
)

func main() {
	port := flag.Int("port", 8765, "first loopback port to try (next 19 on conflict)")
	flag.Parse()

	daemon, err := api.New()
	if err != nil {
		panic(err)
	}

	// Point-mode capture (consent + methodology gated inside the registry;
	// files methodology starts no meters — the scanners count there).
	meters := meter.NewRegistry(daemon.Store, func() { daemon.Syncer.NoteActivity(daemon.Store) })
	meters.StartFromEnv()
	meters.StartFromToggles()

	// Quota engines: refresh every 60s (matches LimitsEngine maxAge), rows
	// recorded into the store's limit timeline on every refresh.
	plan := vendors.NewPlan(vendors.DefaultAdapters())
	engine := limits.NewEngine(daemon.Store)
	daemon.LimitsRows = func() any { return engine.Cached() }
	daemon.LimitsRefresh = func() { engine.RefreshNow(plan.FetchAll) }
	go func() {
		for {
			engine.RefreshIfDue(plan.FetchAll, 60*time.Second)
			time.Sleep(60 * time.Second)
		}
	}()

	// File subsystem: consolidators annotate in every methodology;
	// continuous polling is opt-in (filePolling; files methodology forces
	// it AND counts usage from the scanners on a 15-min schedule).
	filesEngine := files.NewEngine()
	poller := files.NewPoller(daemon.Store, filesEngine)
	daemon.ConsolidateFn = func() any { return poller.Poll() }
	daemon.BackfillFn = func() any {
		events := filesEngine.BackfillEvents()
		inserted, err := daemon.Store.InsertMetered(events)
		if err != nil {
			return map[string]any{"error": "backfill failed: " + err.Error()}
		}
		total, _ := daemon.Store.Count()
		return map[string]any{"candidates": len(events), "inserted": inserted, "total": total}
	}
	if platform.LoadSettings().FilePollingEnabled() {
		poller.Start()
	}
	if platform.LoadSettings().Methodology() == platform.MethodologyFiles {
		files.RunFilesModeCounting(daemon.Store, filesEngine, poller)
	}

	// MITM methodology: scoped mitmproxy capture (.mitm consent-gated
	// inside; AI vendor hosts only — everything else passes through
	// undecrypted). Status rides on GET /mitm/status with user-run
	// remediation steps.
	mitmManager := mitm.NewManager()
	mitmManager.Logf = func(format string, args ...any) { log.Printf(format, args...) }
	if platform.LoadSettings().Methodology() == platform.MethodologyMITM {
		mitmManager.Start()
		defer mitmManager.Stop()
	}
	daemon.MitmStatusFn = func() any { return mitmManager.Status() }

	// System stats: /system snapshot + /processes (top-8 CPU/MEM, always
	// populated — no threshold filter).
	daemon.SystemFn = func() any { return system.TakeSnapshot() }
	// Full {all,tree,byCPU,byMem,byDisk,byNet} — the LocalServer shape the
	// clients render (top-8 CPU/MEM plus disk/net leaderboards).
	daemon.ProcessesFn = func() any { return api.CompatProcessPayload() }

	// Auto-start service registration (user-scoped; systemd --user /
	// LaunchAgent — never root).
	daemon.ServiceStatusFn = func() any { return service.Current() }
	daemon.ServiceInstallFn = func() any { return service.Install() }
	daemon.ServiceRemoveFn = func() any { return service.Uninstall() }

	// Self-managed runtime monitor: 15s polls, measured counter deltas into
	// the durable ledger (backfill merges them as "(ledger import)",
	// attestation measured), and EVERY sighting (idempotently) starts the
	// vendor's deterministic-port request meter (consent-gated inside).
	ledger := rtpkg.NewLedger(rtpkg.DefaultLedgerPath(platform.ConfigDir()))
	filesEngine.Ledger = ledger
	monitor := rtpkg.NewMonitor(ledger)
	monitor.OnSighting = meters.EnsureVendor
	monitor.Start(15 * time.Second)
	defer monitor.Stop()
	daemon.RuntimesFn = func() any { return monitor.Current() }

	// Local inference supervision: splash (:8000) + th-engine (:8001)
	// sidecars behind /engine/*, attach-or-spawn — same discipline as the
	// macOS app's EngineManager (foreign servers are adopted, never killed).
	engineMgr := enginepkg.NewManager()
	engineMgr.StartPolling()
	defer engineMgr.Shutdown()
	daemon.Engine = engineMgr

	daemon.Run(*port, meters)
}
