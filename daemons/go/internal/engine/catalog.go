package engine

// TH-engine model catalog — Go port of
// clients/macos Sources/TokenHorizon/Engine/THEngineCatalog.swift.
//
// Unlike Splash's fixed packages these are ordinary HF repos: GGUF quants
// run on Metal via candle's quantized kernels; safetensors dirs run dense
// (CPU F32 — a correctness path, not the fast one). `tokenizer` points at
// the sibling base repo when a GGUF repo ships no tokenizer.json.

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

type THEngineModel struct {
	ID            string // HF repo id ("org/repo[:file]") or local path
	DisplayName   string
	File          string  // explicit file inside the repo (a .gguf); "" = none
	TokenizerRepo string  // passed as --tokenizer; "" = none
	ApproxGB      float64 // download size
	Kind          string  // "gguf" | "safetensors"
}

// ModelSpec is handed to `th-engine serve --model` — `repo:file` when a
// file is pinned, else the bare repo/path.
func (m THEngineModel) ModelSpec() string {
	if m.File != "" {
		return m.ID + ":" + m.File
	}
	return m.ID
}

// THEngineCatalog is the curated list — entries verified to load through
// candle 0.11. Fit is checked live against the hardware probe at serve time.
var THEngineCatalog = []THEngineModel{
	{ID: "Qwen/Qwen3-32B-GGUF", DisplayName: "Qwen3 32B · Q4_K_M",
		File: "Qwen3-32B-Q4_K_M.gguf", TokenizerRepo: "Qwen/Qwen3-32B",
		ApproxGB: 19.9, Kind: "gguf"},
	{ID: "Qwen/Qwen3-8B-GGUF", DisplayName: "Qwen3 8B · Q4_K_M",
		File: "Qwen3-8B-Q4_K_M.gguf", TokenizerRepo: "Qwen/Qwen3-8B",
		ApproxGB: 5.0, Kind: "gguf"},
	{ID: "Qwen/Qwen3-0.6B-GGUF", DisplayName: "Qwen3 0.6B · Q8_0 (smoke)",
		File: "Qwen3-0.6B-Q8_0.gguf", TokenizerRepo: "Qwen/Qwen3-0.6B",
		ApproxGB: 0.7, Kind: "gguf"},
}

// Installed reports whether the repo's weights are already in the HF cache
// — checked by the presence of the model dir (contents verified lazily by
// hf-hub). Honors HF_HOME like the Swift side's default cache location.
func (m THEngineModel) Installed() bool {
	hfHome := os.Getenv("HF_HOME")
	if hfHome == "" {
		hfHome = filepath.Join(platform.HomeDir(), ".cache", "huggingface")
	}
	dir := "models--" + strings.ReplaceAll(m.ID, "/", "--")
	root := filepath.Join(hfHome, "hub", dir, "snapshots")
	snaps, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	// A snapshot is usable if it has the pinned file (or any weights).
	for _, snap := range snaps {
		if !snap.IsDir() {
			continue
		}
		snapDir := filepath.Join(root, snap.Name())
		if m.File != "" {
			if _, err := os.Stat(filepath.Join(snapDir, m.File)); err == nil {
				return true
			}
			continue
		}
		entries, err := os.ReadDir(snapDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".safetensors") {
				return true
			}
		}
	}
	return false
}

// THEngineCatalogPayload emits the `thengine_models` array of GET /engine —
// same keys as the Swift side.
func THEngineCatalogPayload() []map[string]any {
	out := make([]map[string]any, 0, len(THEngineCatalog))
	for _, m := range THEngineCatalog {
		var tok any
		if m.TokenizerRepo != "" {
			tok = m.TokenizerRepo
		}
		out = append(out, map[string]any{
			"id":             m.ModelSpec(),
			"name":           m.DisplayName,
			"kind":           m.Kind,
			"package_gb":     m.ApproxGB,
			"tokenizer_repo": tok,
			"installed":      m.Installed(),
			"backend":        "thengine",
		})
	}
	return out
}
