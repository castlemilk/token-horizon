package files

// Project rollups — the /projects surface. Metered events carry session_id
// (opaque UUIDs), not directories, so projects are derived the way the Swift
// engine derives them: from the session FILE layout. Claude sessions live
// under ~/.claude/projects/<slugified-cwd>/*.jsonl — each file's usage
// fields sum to that project's totals. Results cache 30s; a rescan is a
// bounded directory walk (only .jsonl tails are parsed).

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type ProjectUsage struct {
	Directory    string   `json:"directory"`
	Tokens       int64    `json:"tokens"`
	Cost         float64  `json:"cost"`
	Sessions     int      `json:"sessions"`
	Models       []string `json:"models"`
	LastActivity int64    `json:"lastActivity"`
}

var projCache struct {
	mu   sync.Mutex
	rows []ProjectUsage
	at   time.Time
}

// ProjectTotals scans provider project dirs and returns per-directory
// rollups sorted by tokens desc. Only claude uses a project-keyed layout
// today; other vendors land in a future pass (their session dirs don't
// encode cwd).
func ProjectTotals() []ProjectUsage {
	projCache.mu.Lock()
	defer projCache.mu.Unlock()
	if time.Since(projCache.at) < 30*time.Second && projCache.rows != nil {
		return projCache.rows
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var rows []ProjectUsage
	for _, root := range []string{
		filepath.Join(home, ".claude", "projects"),
	} {
		dirs, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, d := range dirs {
			if !d.IsDir() {
				continue
			}
			dir := filepath.Join(root, d.Name())
			pu := scanProjectDir(dir, unslug(d.Name()))
			if pu.Tokens > 0 || pu.Sessions > 0 {
				rows = append(rows, pu)
			}
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Tokens > rows[j].Tokens })
	projCache.rows = rows
	projCache.at = time.Now()
	return rows
}

// unslug: "-Users-x-Projects-foo" → "/Users/x/Projects/foo" (claude encodes
// cwd by replacing / with -). Ambiguity (real hyphens become - too) is
// accepted — Swift's engine decodes the same way.
func unslug(slug string) string {
	return "/" + strings.TrimPrefix(strings.ReplaceAll(slug, "-", "/"), "/")
}

func scanProjectDir(dir, decodedPath string) ProjectUsage {
	pu := ProjectUsage{Directory: decodedPath}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return pu
	}
	models := map[string]bool{}
	for _, f := range entries {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, f.Name())
		info, err := f.Info()
		if err != nil {
			continue
		}
		if mt := info.ModTime().Unix(); mt > pu.LastActivity {
			pu.LastActivity = mt
		}
		if sumSessionFile(path, &pu.Tokens, &pu.Cost, models) {
			pu.Sessions++
		}
	}
	for m := range models {
		pu.Models = append(pu.Models, m)
	}
	sort.Strings(pu.Models)
	return pu
}

// sumSessionFile totals a claude session JSONL's message.usage fields:
// input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens; model taken from message.model.
func sumSessionFile(path string, tokens *int64, cost *float64, models map[string]bool) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	found := false
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var obj struct {
			Message struct {
				Model string `json:"model"`
				Usage struct {
					InputTokens        int64 `json:"input_tokens"`
					OutputTokens       int64 `json:"output_tokens"`
					CacheReadInput     int64 `json:"cache_read_input_tokens"`
					CacheCreationInput int64 `json:"cache_creation_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &obj) != nil {
			continue
		}
		u := obj.Message.Usage
		if u.InputTokens+u.OutputTokens+u.CacheReadInput+u.CacheCreationInput > 0 {
			*tokens += u.InputTokens + u.OutputTokens + u.CacheReadInput + u.CacheCreationInput
			found = true
		}
		if obj.Message.Model != "" {
			models[obj.Message.Model] = true
		}
	}
	return found
}
