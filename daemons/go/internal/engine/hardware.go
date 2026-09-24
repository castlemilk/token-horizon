package engine

// Hardware probe + per-model fit analysis — the Go port of
// clients/macos Sources/TokenHorizon/Engine/HardwareProfile.swift.
//
// Splash's contract: Apple silicon M3+, macOS 26.4+ (placement-sparse
// support), ≥36 GB unified memory. Each model package has a fixed resident
// cost (weights + trained DFlash draft) plus a per-context KV/state cost,
// so fit is decided against physical memory — not free memory at launch.
// On non-darwin platforms Splash is simply ineligible (its binary is
// macOS-only); th-engine remains servable.

import (
	"runtime"
	"strings"
)

type Machine struct {
	ChipName         string  // "Apple M5 Max" / CPU model name
	PhysicalMemoryGB float64 // total RAM
	OSMajor          int     // macOS major on darwin, 0 elsewhere
	OSMinor          int
	OSName           string // "macOS" | "linux" | "windows" | ...
	ChipGeneration   int    // M3 => 3, M5 Max => 5; unknown => 0
	ChipTier         string // "base" | "pro" | "max" | "ultra"
}

// Probe inspects the host. Per-OS chip/OS detection lives in
// hardware_<goos>.go; memory comes from the shared system snapshot.
func Probe() Machine {
	chip, maj, min := hostInfo()
	return Machine{
		ChipName:         chip,
		PhysicalMemoryGB: totalMemoryGB(),
		OSMajor:          maj,
		OSMinor:          min,
		OSName:           runtime.GOOS,
		ChipGeneration:   chipGeneration(chip),
		ChipTier:         chipTier(chip),
	}
}

// "Apple M5 Max" -> 5; unknown -> 0.
func chipGeneration(name string) int {
	i := strings.IndexByte(name, 'M')
	if i < 0 {
		return 0
	}
	n := 0
	for j := i + 1; j < len(name) && name[j] >= '0' && name[j] <= '9'; j++ {
		n = n*10 + int(name[j]-'0')
	}
	return n
}

func chipTier(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "ultra"):
		return "ultra"
	case strings.Contains(n, "max"):
		return "max"
	case strings.Contains(n, "pro"):
		return "pro"
	default:
		return "base"
	}
}

// EligibilityBlocker is nil when the machine can host Splash; otherwise a
// human-readable blocker. Mirrors the native binary's own validation
// (macOS ≥26.4, Apple GPU family ≥9 ≈ M3+).
func EligibilityBlocker(m Machine) string {
	if m.OSName != "darwin" {
		return "Splash runs on macOS only (found " + m.OSName + ")"
	}
	if m.ChipGeneration > 0 && m.ChipGeneration < 3 {
		return "Splash needs Apple silicon M3 or newer (found " + m.ChipName + ")"
	}
	if m.OSMajor < 26 || (m.OSMajor == 26 && m.OSMinor < 4) {
		return "Splash needs macOS 26.4 or newer"
	}
	if m.PhysicalMemoryGB < 36 {
		return "Splash needs at least 36 GB unified memory"
	}
	return ""
}

// ---- Splash model catalog + fit ----

type EngineModel struct {
	ID               string // HF repo id
	DisplayName      string
	PackageGB        float64 // download size
	ResidentGB       float64 // weights + draft, fixed
	Kind             string  // "dense" | "moe"
	RecommendedRAMGB float64
}

// SplashCatalog is the official roster (splash install/catalog.py BUNDLED
// list). Static here — same as the Swift copy.
var SplashCatalog = []EngineModel{
	{ID: "incoai/Qwen3.8-27B-Splash", DisplayName: "Qwen3.8 27B",
		PackageGB: 17.4, ResidentGB: 16.2, Kind: "dense", RecommendedRAMGB: 48},
	{ID: "incoai/Qwen3.6-35B-A3B-Splash", DisplayName: "Qwen3.6 35B-A3B (MoE)",
		PackageGB: 20.9, ResidentGB: 18.5, Kind: "moe", RecommendedRAMGB: 48},
}

// Fit values and their UI badges — identical strings to the Swift side.
const (
	FitUnsupported = "unsupported"
	FitTight       = "tight"
	FitComfortable = "comfortable"
	FitGenerous    = "generous"
)

func FitBadge(fit string) string {
	switch fit {
	case FitUnsupported:
		return "won't fit"
	case FitTight:
		return "tight"
	case FitComfortable:
		return "good fit"
	case FitGenerous:
		return "plenty of headroom"
	}
	return fit
}

func Fit(model EngineModel, m Machine) string {
	ram := m.PhysicalMemoryGB
	if EligibilityBlocker(m) != "" || ram < model.ResidentGB+8 {
		return FitUnsupported
	}
	if ram < model.RecommendedRAMGB {
		return FitTight
	}
	if ram >= model.RecommendedRAMGB*2 {
		return FitGenerous
	}
	return FitComfortable
}

// RecommendedCeilings: default ceilings for a serve, tuned to the machine.
// Memory budget leaves ~25% on big machines, 12 GB on small ones; context
// defaults to 128K when memory is generous, else a conservative 32K.
func RecommendedCeilings(model EngineModel, m Machine) (maxMemoryGB, maxContextK int) {
	ram := m.PhysicalMemoryGB
	reserve := 12.0
	if ram >= 96 {
		reserve = ram * 0.25
	}
	budget := model.ResidentGB + 4
	if ram-reserve > budget {
		budget = ram - reserve
	}
	context := 32
	if Fit(model, m) == FitGenerous {
		context = 128
	}
	return int(budget), context
}
