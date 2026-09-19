package files

// FilePoller (Usage/FilePoller.swift port): runs the consolidators on a
// 60s loop — ONLY when .fileReading consent is granted AND (filePolling
// setting OR the files capture methodology). In point/mitm methodology the
// deliberate one-off is POST /consolidate.

import (
	"fmt"
	"os"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

type Poller struct {
	Engine        *Engine
	Consolidators []Consolidator
	Store         annotStore
}

func NewPoller(store annotStore, engine *Engine) *Poller {
	if engine == nil {
		engine = NewEngine()
	}
	return &Poller{Engine: engine, Consolidators: DefaultConsolidators(engine), Store: store}
}

// Enabled: consent + (filePolling setting; files methodology forces it).
func (p *Poller) Enabled() bool {
	if !core.ConsentGranted("fileReading") {
		return false
	}
	return core.LoadSettings().FilePollingEnabled()
}

// Poll runs one pass over every consolidator. Returns observation counts
// per vendor. Idempotent by store natural keys.
func (p *Poller) Poll() map[string]int {
	report := map[string]int{}
	for _, c := range p.Consolidators {
		n, err := c.Consolidate(p.Store)
		if err != nil {
			fmt.Fprintf(os.Stderr, "token-horizon: %s consolidation failed: %v\n", c.Vendor(), err)
			continue
		}
		report[c.Vendor()] = n
	}
	return report
}

// Start launches the 60s loop.
func (p *Poller) Start() {
	go func() {
		for {
			if p.Enabled() {
				p.Poll()
			}
			time.Sleep(60 * time.Second)
		}
	}()
}

// RunFilesModeCounting: the files-methodology counting loop — every 15 min,
// consolidate (annotations/limits) AND import file history into the store
// (selfReported, deterministic ids). Gated on .fileReading consent.
func RunFilesModeCounting(store *core.Store, engine *Engine, poller *Poller) {
	if engine == nil {
		engine = NewEngine()
	}
	go func() {
		time.Sleep(30 * time.Second)
		for {
			if core.LoadSettings().Methodology() != core.MethodologyFiles {
				return // methodology switched away from files
			}
			if core.ConsentGranted("fileReading") {
				poller.Poll()
				events := engine.BackfillEvents()
				if _, err := store.InsertMetered(events); err != nil {
					fmt.Fprintf(os.Stderr, "token-horizon: files-mode backfill failed: %v\n", err)
				}
			}
			time.Sleep(15 * time.Minute)
		}
	}()
}
