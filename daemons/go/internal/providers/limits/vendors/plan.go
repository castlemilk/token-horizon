package vendors

import (
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- Plan registry (PlanLimitsEngine port) ----

// DefaultAdapters: one per vendor. UI / /limits / snapshot recording pick
// them all up via the registry.
func DefaultAdapters() []limits.Adapter {
	return []limits.Adapter{
		Zhipu{}, MiniMax{}, OpenCodeGo{}, Alibaba{},
		Gemini{}, Claude{}, DeepSeek{}, Codex{}, Kimi{},
	}
}

// Plan fans out over adapters with per-vendor last-good retention: a
// transient fetch failure must not blank the vendor's meters; credentials
// that stopped RESOLVING = deliberate (signed out) — rows drop immediately.
type Plan struct {
	Adapters []limits.Adapter

	mu            sync.Mutex
	lastGood      map[string]lastGoodRows
	LastGoodGrace time.Duration
	now           func() time.Time
}

type lastGoodRows struct {
	rows []limits.Limit
	at   time.Time
}

func NewPlan(adapters []limits.Adapter) *Plan {
	return &Plan{Adapters: adapters, lastGood: map[string]lastGoodRows{},
		LastGoodGrace: 20 * time.Minute, now: time.Now}
}

func (p *Plan) FetchAll() []limits.Limit {
	var out []limits.Limit
	for _, adapter := range p.Adapters {
		rows := adapter.Fetch()
		if len(rows) > 0 {
			p.mu.Lock()
			p.lastGood[adapter.Provider()] = lastGoodRows{rows, p.now()}
			p.mu.Unlock()
			out = append(out, rows...)
			continue
		}
		if !adapter.HasCredentials() {
			// No credential → genuinely unconfigured/signed out.
			p.mu.Lock()
			delete(p.lastGood, adapter.Provider())
			p.mu.Unlock()
			continue
		}
		p.mu.Lock()
		stale, ok := p.lastGood[adapter.Provider()]
		p.mu.Unlock()
		if ok && p.now().Sub(stale.at) < p.LastGoodGrace {
			out = append(out, stale.rows...)
		}
	}
	return out
}
