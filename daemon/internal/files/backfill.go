package files

// Backfill scanner engine (Usage/UsageEngine.swift backfill half port) —
// parses provider session FILES into 5-minute bucket history. This is the
// counting source of the `files` capture methodology; in point/mitm
// methodology its events are imported only via deliberate backfill.
//
// Sources (identical to the Swift engine):
//   opencode  sqlite session table (~/.local/share/opencode/opencode.db)
//   claude    ~/.claude/projects + transcripts (*.jsonl, additive)
//   generic   glm/qwen/grok/deepseek/gemini/agy dirs (additive)
//   kimi      KimiSessionDirs (wire.jsonl)
//   codex     ~/.codex/sessions + archived_sessions (stateful watermarks)
//
// Bucket keys are 300s epoch-aligned; day boundaries are UTC.

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

const BucketSeconds = 300

func bucketStart(epoch int64) int64 { return epoch / BucketSeconds * BucketSeconds }

// UTC midnight as epoch seconds (DayBoundary port).
func dayBoundary(epoch int64) int64 {
	t := time.Unix(epoch, 0).UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).Unix()
}

// BucketEntry: one tool's tokens/cost in one 5-min bucket.
type BucketEntry struct {
	Breakdown core.TokenBreakdown
	Cost      float64
}

func (e *BucketEntry) add(b core.TokenBreakdown, cost float64) {
	e.Breakdown.Input += b.Input
	e.Breakdown.Output += b.Output
	e.Breakdown.Reasoning += b.Reasoning
	e.Breakdown.CacheRead += b.CacheRead
	e.Breakdown.CacheWrite += b.CacheWrite
	e.Cost += cost
}

// additiveFileState: per-file running accumulators (reset on truncation).
type additiveFileState struct {
	offset  uint64
	buckets map[int64]*BucketEntry
}

// codexWatermark: cumulative counters per codex session file.
type codexWatermark struct {
	input, output, cached, reasoning int64
}

func (w codexWatermark) total() int64 { return w.input + w.output }

func (w codexWatermark) ge(o codexWatermark) bool {
	return w.input >= o.input && w.output >= o.output && w.cached >= o.cached && w.reasoning >= o.reasoning
}

func (w codexWatermark) delta(prev codexWatermark) codexWatermark {
	return codexWatermark{w.input - prev.input, w.output - prev.output, w.cached - prev.cached, w.reasoning - prev.reasoning}
}

type codexFileState struct {
	offset    uint64
	watermark codexWatermark
	last      codexWatermark
	buckets   map[int64]*BucketEntry
	rate      *core.LimitSnapshot
}

// Engine is the backfill scanner with incremental per-file state.
type Engine struct {
	claudeFiles  map[string]*additiveFileState
	genericFiles map[string]*additiveFileState
	kimiFiles    map[string]*additiveFileState
	codexFiles   map[string]*codexFileState
	Home         string // home dir override (tests)
	OpenCodeDB   string // opencode.db path override (tests)
	// Ledger: self-managed runtime counter-delta contributions (durable
	// runtime-usage.json) — merged into backfill as "(ledger import)"
	// events with .measured attestation (they are server counters).
	Ledger LedgerProvider
}

// LedgerProvider: the runtime ledger surface backfill consumes (interface
// keeps files independent of the runtime package).
type LedgerProvider interface {
	Contributions() map[string]map[int]core.TokenBreakdown
}

func NewEngine() *Engine {
	return &Engine{
		claudeFiles:  map[string]*additiveFileState{},
		genericFiles: map[string]*additiveFileState{},
		kimiFiles:    map[string]*additiveFileState{},
		codexFiles:   map[string]*codexFileState{},
	}
}

func (e *Engine) home() string {
	if e.Home != "" {
		return e.Home
	}
	h, _ := os.UserHomeDir()
	return h
}

func (e *Engine) resolve(path string) string {
	if path == "~" {
		return e.home()
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(e.home(), path[2:])
	}
	return path
}

// Generic additive sources (UsageEngine.genericSources).
var genericSources = []struct {
	tool string
	dirs []string
}{
	{"glm", []string{"~/.zcode/projects"}},
	{"qwen", []string{"~/.qwen/projects"}},
	{"grok", []string{"~/.grok/sessions"}},
	{"deepseek", []string{"~/.dsh/sessions"}},
	{"gemini", []string{"~/.gemini/transcripts", "~/.gemini/sessions", "~/.gemini/projects"}},
	{"agy", []string{"~/.gemini/antigravity-cli/brain", "~/.gemini/antigravity-cli/conversations"}},
}

// jsonlFilesUnder: recursive *.jsonl walk (skips /chunks/ and
// transcript_full.jsonl), like UsageEngine.cachedFiles.
func jsonlFilesUnder(root, suffix string) []string {
	var out []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, suffix) &&
			!strings.Contains(path, "/chunks/") &&
			!strings.HasSuffix(path, "transcript_full.jsonl") {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// parseTimestamp: ISO string or epoch number (ms when > 1e12).
func parseTimestamp(v any) (int64, bool) {
	switch ts := v.(type) {
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if t, err := time.Parse(layout, ts); err == nil {
				return t.Unix(), true
			}
		}
	case float64:
		if ts > 1e12 {
			ts /= 1000
		}
		return int64(ts), true
	}
	return 0, false
}

func (e *Engine) bucketFromTimestamp(v any) int64 {
	if ts, ok := parseTimestamp(v); ok {
		return bucketStart(ts)
	}
	return bucketStart(time.Now().Unix())
}

// additiveParsed: one parsed additive line.
type additiveParsed struct {
	breakdown core.TokenBreakdown
	cost      float64
	hour      int64
	model     string
}

// parseAdditiveLine: UsageEngine.parseAdditiveLine port — claude + every
// generic additive source. Handles message.usage, usage/token_usage/
// usageMetadata blocks across anthropic/openai/gemini conventions, and
// cost blocks.
func (e *Engine) parseAdditiveLine(line []byte) *additiveParsed {
	obj := core.ParseJSONLine(line)
	if obj == nil {
		return nil
	}
	var breakdown core.TokenBreakdown
	cost := 0.0

	add := func(b core.TokenBreakdown) {
		breakdown.Input += b.Input
		breakdown.Output += b.Output
		breakdown.Reasoning += b.Reasoning
		breakdown.CacheRead += b.CacheRead
		breakdown.CacheWrite += b.CacheWrite
	}

	if message, ok := obj["message"].(map[string]any); ok {
		if usage, ok := message["usage"].(map[string]any); ok {
			add(core.AnthropicUsageBreakdown(usage))
		}
	}
	for _, key := range []string{"usage", "token_usage", "usageMetadata", "usage_metadata"} {
		if usage, ok := obj[key].(map[string]any); ok {
			add(core.AnthropicUsageBreakdown(usage))
			add(core.OpenAIUsageBreakdown(usage))
			add(core.GeminiUsageBreakdown(usage))
		}
	}
	if costBlock, ok := obj["cost"].(map[string]any); ok {
		if total, ok := costBlock["total"].(float64); ok {
			cost += total
		}
	}
	if c, ok := obj["costUSD"].(float64); ok {
		cost += c
	}

	hour := bucketStart(time.Now().Unix())
	if _, present := obj["timestamp"]; present {
		hour = e.bucketFromTimestamp(obj["timestamp"])
	} else if _, present := obj["created_at"]; present {
		hour = e.bucketFromTimestamp(obj["created_at"])
	}

	model := ""
	if message, ok := obj["message"].(map[string]any); ok {
		model, _ = message["model"].(string)
	}
	if model == "" {
		model, _ = obj["model"].(string)
	}
	if model == "" {
		model, _ = obj["model_name"].(string)
	}
	if model == "" {
		model, _ = obj["modelId"].(string)
	}
	if model == "" && (obj["type"] == "PLANNER_RESPONSE" || obj["source"] == "MODEL") {
		model = "gemini-3.7-flash"
	}

	if breakdown.Total() <= 0 && cost <= 0 {
		return nil
	}
	return &additiveParsed{breakdown, cost, hour, model}
}

// scanAdditive: claude + generic sources (UsageEngine.scanAdditive port).
func (e *Engine) scanAdditive(dirs []string, state map[string]*additiveFileState, prefix string) map[int64]*BucketEntry {
	merged := map[int64]*BucketEntry{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		root := e.resolve(dir)
		for _, full := range jsonlFilesUnder(root, ".jsonl") {
			key := prefix + "::" + full
			seen[key] = true
			st := state[key]
			if st == nil {
				st = &additiveFileState{buckets: map[int64]*BucketEntry{}}
				state[key] = st
			}
			IncrementalRead(full, &st.offset, func() {
				st.buckets = map[int64]*BucketEntry{}
			}, func(line []byte) {
				p := e.parseAdditiveLine(line)
				if p == nil {
					return
				}
				entry := st.buckets[p.hour]
				if entry == nil {
					entry = &BucketEntry{}
					st.buckets[p.hour] = entry
				}
				entry.add(p.breakdown, p.cost)
			})
		}
	}
	for key := range state {
		if strings.HasPrefix(key, prefix+"::") && !seen[key] {
			delete(state, key)
		}
	}
	for key, st := range state {
		if !strings.HasPrefix(key, prefix+"::") {
			continue
		}
		for h, b := range st.buckets {
			entry := merged[h]
			if entry == nil {
				entry = &BucketEntry{}
				merged[h] = entry
			}
			entry.add(b.Breakdown, b.Cost)
		}
	}
	return merged
}

// parseKimiLine: UsageEngine.parseKimiLine port — wire.jsonl token_usage.
func (e *Engine) parseKimiLine(line []byte) (core.TokenBreakdown, int64, bool) {
	obj := core.ParseJSONLine(line)
	if obj == nil {
		return core.TokenBreakdown{}, 0, false
	}
	message, ok := obj["message"].(map[string]any)
	if !ok {
		return core.TokenBreakdown{}, 0, false
	}
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return core.TokenBreakdown{}, 0, false
	}
	usage, ok := payload["token_usage"].(map[string]any)
	if !ok {
		return core.TokenBreakdown{}, 0, false
	}
	field := func(names ...string) int64 {
		for _, n := range names {
			if v := core.JSONInt(usage, n); v > 0 {
				return v
			}
		}
		return 0
	}
	b := core.TokenBreakdown{
		Input:      field("input_other", "inputOther"),
		Output:     field("output"),
		CacheRead:  field("input_cache_read", "inputCacheRead"),
		CacheWrite: field("input_cache_creation", "inputCacheCreation"),
	}
	if b.Total() <= 0 {
		return core.TokenBreakdown{}, 0, false
	}
	return b, e.bucketFromTimestamp(obj["timestamp"]), true
}

func (e *Engine) scanKimi() map[int64]*BucketEntry {
	merged := map[int64]*BucketEntry{}
	seen := map[string]bool{}
	for _, dir := range core.KimiSessionDirs() {
		root := e.resolve(dir)
		for _, full := range jsonlFilesUnder(root, "wire.jsonl") {
			seen[full] = true
			st := e.kimiFiles[full]
			if st == nil {
				st = &additiveFileState{buckets: map[int64]*BucketEntry{}}
				e.kimiFiles[full] = st
			}
			IncrementalRead(full, &st.offset, func() {
				st.buckets = map[int64]*BucketEntry{}
			}, func(line []byte) {
				b, hour, ok := e.parseKimiLine(line)
				if !ok {
					return
				}
				entry := st.buckets[hour]
				if entry == nil {
					entry = &BucketEntry{}
					st.buckets[hour] = entry
				}
				entry.add(b, 0)
			})
		}
	}
	for key := range e.kimiFiles {
		if !seen[key] {
			delete(e.kimiFiles, key)
		}
	}
	for _, st := range e.kimiFiles {
		for h, b := range st.buckets {
			entry := merged[h]
			if entry == nil {
				entry = &BucketEntry{}
				merged[h] = entry
			}
			entry.add(b.Breakdown, b.Cost)
		}
	}
	return merged
}
