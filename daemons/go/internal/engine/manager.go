package engine

// Manager facade — Go port of EngineManager: one entry point for the API,
// holding both backend supervisors and producing the combined /engine
// payload (per-backend state + hardware + model catalogs).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

type Manager struct {
	Splash   *Supervisor
	THEngine *Supervisor

	mu    sync.Mutex
	bench map[string]any
	stop  chan struct{}
}

func NewManager() *Manager {
	return &Manager{
		Splash:   NewSupervisor(SplashBackend()),
		THEngine: NewSupervisor(THEngineBackend()),
		stop:     make(chan struct{}),
	}
}

// Backend constructors — kept as funcs so tests can override env.
func SplashBackend() Backend   { return Splash }
func THEngineBackend() Backend { return THEngine }

// BenchPath: scripts/bench-engines.sh writes
// ~/.config/token-horizon/engine-bench.json — same file the Swift side reads.
func BenchPath() string {
	return filepath.Join(platform.ConfigDir(), "engine-bench.json")
}

// ReloadBench re-reads the bench results file.
func (m *Manager) ReloadBench() {
	data, err := os.ReadFile(BenchPath())
	if err != nil {
		return
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return
	}
	m.mu.Lock()
	m.bench = obj
	m.mu.Unlock()
}

// Bench returns the latest side-by-side bench results, or nil.
func (m *Manager) Bench() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bench
}

// Supervisor resolves a backend id — "splash" | "thengine" (aliases th /
// th-engine accepted, same as the Swift supervisor(for:)).
func (m *Manager) Supervisor(id string) *Supervisor {
	switch id {
	case "splash":
		return m.Splash
	case "thengine", "th", "th-engine":
		return m.THEngine
	}
	return nil
}

// StartPolling refreshes backend state every 5s and reloads bench results
// every 15s — the Swift EngineManager.startPolling cadence.
func (m *Manager) StartPolling() {
	m.ReloadBench()
	m.Splash.Refresh()
	m.THEngine.Refresh()
	go func() {
		fast := time.NewTicker(5 * time.Second)
		slow := time.NewTicker(15 * time.Second)
		defer fast.Stop()
		defer slow.Stop()
		for {
			select {
			case <-m.stop:
				return
			case <-fast.C:
				m.Splash.Refresh()
				m.THEngine.Refresh()
			case <-slow.C:
				m.ReloadBench()
			}
		}
	}()
}

func (m *Manager) Shutdown() {
	select {
	case <-m.stop:
	default:
		close(m.stop)
	}
	m.Splash.Shutdown()
	m.THEngine.Shutdown()
}

// SnapshotPayload is the combined GET /engine payload — identical shape to
// the Swift EngineManager.snapshotPayload().
func (m *Manager) SnapshotPayload() map[string]any {
	machine := Probe()
	installed := SplashInstalledModelIDs()
	models := make([]map[string]any, 0, len(SplashCatalog))
	for _, mod := range SplashCatalog {
		fit := Fit(mod, machine)
		memGB, ctxK := RecommendedCeilings(mod, machine)
		models = append(models, map[string]any{
			"id":                      mod.ID,
			"name":                    mod.DisplayName,
			"kind":                    mod.Kind,
			"package_gb":              mod.PackageGB,
			"resident_gb":             mod.ResidentGB,
			"recommended_ram_gb":      mod.RecommendedRAMGB,
			"fit":                     fit,
			"fit_label":               FitBadge(fit),
			"installed":               installed[mod.ID],
			"suggested_max_memory_gb": memGB,
			"suggested_max_context_k": ctxK,
		})
	}
	macos := fmt.Sprintf("%d.%d", machine.OSMajor, machine.OSMinor)
	if machine.OSName != "darwin" {
		macos = machine.OSName
	}
	var blocker any
	if b := EligibilityBlocker(machine); b != "" {
		blocker = b
	}
	return map[string]any{
		"backends": map[string]any{
			"splash":   m.Splash.Payload(),
			"thengine": m.THEngine.Payload(),
		},
		"hardware": map[string]any{
			"chip":      machine.ChipName,
			"memory_gb": machine.PhysicalMemoryGB,
			"macos":     macos,
			"eligible":  EligibilityBlocker(machine) == "",
			"blocker":   blocker,
		},
		"models":          models,
		"thengine_models": THEngineCatalogPayload(),
	}
}
