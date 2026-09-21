package files

// Codex stateful scanning, opencode sqlite, and the backfillEvents
// assembler (deterministic ids, selfReported attestation).

import (
	"database/sql"
	"encoding/binary"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"os"
)

// codexParsed: one parsed token_count line.
type codexParsed struct {
	totals codexWatermark
	last   codexWatermark
	hour   int64
	rate   *usage.LimitSnapshot
}

// parseCodexLine: UsageEngine.parseCodexLine port — token_count payloads
// with total/last watermarks + rate_limits windows.
func (e *Engine) parseCodexLine(line []byte) *codexParsed {
	obj := usage.ParseJSONLine(line)
	if obj == nil {
		return nil
	}
	payload, ok := obj["payload"].(map[string]any)
	if !ok || payload["type"] != "token_count" {
		return nil
	}
	info, ok := payload["info"].(map[string]any)
	if !ok {
		return nil
	}
	watermark := func(key string) (codexWatermark, bool) {
		u, ok := info[key].(map[string]any)
		if !ok {
			return codexWatermark{}, false
		}
		cachedA := usage.JSONInt(u, "cached_input_tokens")
		cachedB := usage.JSONInt(u, "cache_read_input_tokens")
		cached := cachedA
		if cachedB > cached {
			cached = cachedB
		}
		return codexWatermark{
			input:     max(usage.JSONInt(u, "input_tokens"), 0),
			output:    max(usage.JSONInt(u, "output_tokens"), 0),
			cached:    max(cached, 0),
			reasoning: max(usage.JSONInt(u, "reasoning_output_tokens"), 0),
		}, true
	}
	totals, ok := watermark("total_token_usage")
	if !ok {
		return nil
	}
	last, lok := watermark("last_token_usage")
	if !lok {
		last = totals
	}
	parsed := &codexParsed{totals: totals, last: last, hour: e.bucketFromTimestamp(obj["timestamp"])}
	for window, w := range CodexRateLimitsParse(payload) {
		label := codexWindowLabel(w.windowMinutes)
		parsed.rate = &usage.LimitSnapshot{
			MachineID: platform.MachineID(), Provider: "codex",
			Label: label, UsedPercent: w.usedPercent,
			Detail: fmt.Sprintf("codex %s window (file)", window),
		}
		if w.resetsAt > 0 {
			at := int64(w.resetsAt)
			parsed.rate.ResetsAt = &at
		}
	}
	return parsed
}

// codexAccept: UsageEngine.codexAccept port — the stateful watermark logic.
// Returns the accepted delta (zero when nothing new).
func codexAccept(parsed *codexParsed, st *codexFileState) codexWatermark {
	prev := st.watermark
	cur := parsed.totals
	if cur.ge(prev) {
		delta := cur.delta(prev)
		st.watermark = cur
		st.last = parsed.last
		return delta
	}
	prevTotal, curTotal, lastTotal := prev.total(), cur.total(), st.last.total()
	stale := prevTotal > 0 && curTotal > 0 && lastTotal > 0 &&
		(curTotal*100 >= prevTotal*98 || curTotal+lastTotal*2 >= prevTotal)
	if stale {
		return codexWatermark{}
	}
	st.watermark = cur
	st.last = parsed.last
	return parsed.last
}

// scanCodex: UsageEngine.scanCodex port — stateful per file; never reset
// state on truncation without clearing buckets (the onTruncate hook clears
// the whole CodexFileState).
func (e *Engine) scanCodex(dirs []string) map[int64]*BucketEntry {
	merged := map[int64]*BucketEntry{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		root := e.resolve(dir)
		for _, full := range jsonlFilesUnder(root, ".jsonl") {
			seen[full] = true
			st := e.codexFiles[full]
			if st == nil {
				st = &codexFileState{buckets: map[int64]*BucketEntry{}}
				e.codexFiles[full] = st
			}
			IncrementalRead(full, &st.offset, func() {
				st.watermark = codexWatermark{}
				st.last = codexWatermark{}
				st.buckets = map[int64]*BucketEntry{}
			}, func(line []byte) {
				parsed := e.parseCodexLine(line)
				if parsed == nil {
					return
				}
				delta := codexAccept(parsed, st)
				if parsed.rate != nil {
					st.rate = parsed.rate
				}
				display := delta.input + delta.output // gross delta (provider truth)
				if display > 0 {
					entry := st.buckets[parsed.hour]
					if entry == nil {
						entry = &BucketEntry{}
						st.buckets[parsed.hour] = entry
					}
					// NET storage: cached ⊂ input, reasoning ⊂ output.
					netInput := delta.input
					if delta.cached <= delta.input {
						netInput = delta.input - delta.cached
					}
					netOutput := delta.output
					if delta.reasoning <= delta.output {
						netOutput = delta.output - delta.reasoning
					}
					entry.add(usage.TokenBreakdown{
						Input: netInput, Output: netOutput,
						Reasoning: delta.reasoning, CacheRead: delta.cached,
					}, 0)
				}
			})
		}
	}
	for key := range e.codexFiles {
		if !seen[key] {
			delete(e.codexFiles, key)
		}
	}
	for _, st := range e.codexFiles {
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

// codexWindowLabel: CodexConsolidator.windowLabel port.
func codexWindowLabel(minutes int) string {
	switch {
	case minutes == 0:
		return "window (file)"
	case minutes == 10_080:
		return "weekly (file)"
	case minutes == 1_440:
		return "daily (file)"
	case minutes%60 == 0:
		return fmt.Sprintf("%dh (file)", minutes/60)
	default:
		return fmt.Sprintf("%dm (file)", minutes)
	}
}

// CodexRateWindow: one parsed rate_limits window (CodexRateLimits port).
type CodexRateWindow struct {
	usedPercent   float64
	windowMinutes int
	resetsAt      float64
}

// CodexRateLimitsParse: payload.rate_limits.{primary,secondary} — parsed
// ONCE here, shared by backfill scanner and consolidator.
func CodexRateLimitsParse(payload map[string]any) map[string]CodexRateWindow {
	rateLimits, ok := payload["rate_limits"].(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]CodexRateWindow{}
	for _, key := range []string{"primary", "secondary"} {
		w, ok := rateLimits[key].(map[string]any)
		if !ok {
			continue
		}
		used, ok := w["used_percent"].(float64)
		if !ok {
			continue
		}
		out[key] = CodexRateWindow{
			usedPercent:   used,
			windowMinutes: int(usage.JSONInt(w, "window_minutes")),
			resetsAt:      numOrZero(w["resets_at"]),
		}
	}
	return out
}

func numOrZero(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

// ---- opencode sqlite ----

func (e *Engine) opencodeDBPath() string {
	if e.OpenCodeDB != "" {
		return e.OpenCodeDB
	}
	home := e.home()
	for _, c := range []string{
		home + "/.local/share/opencode/opencode.db",
		home + "/Library/Application Support/opencode/opencode.db",
	} {
		if fileExists(c) {
			return c
		}
	}
	return ""
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// opencodePerBucket: UsageEngine.opencodePerBucket port — session-table
// rows into 5-min buckets.
func (e *Engine) opencodePerBucket() map[int64]*BucketEntry {
	merged := map[int64]*BucketEntry{}
	path := e.opencodeDBPath()
	if path == "" {
		return merged
	}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(150)", path))
	if err != nil {
		return merged
	}
	defer db.Close()
	rows, err := db.Query(`SELECT time_created,
		COALESCE(tokens_input,0), COALESCE(tokens_output,0),
		COALESCE(tokens_reasoning,0), COALESCE(tokens_cache_read,0),
		COALESCE(tokens_cache_write,0), COALESCE(cost,0) FROM session`)
	if err != nil {
		return merged
	}
	defer rows.Close()
	for rows.Next() {
		var createdMs, cost float64
		var in, out, reasoning, cacheRead, cacheWrite int64
		if rows.Scan(&createdMs, &in, &out, &reasoning, &cacheRead, &cacheWrite, &cost) != nil {
			continue
		}
		bucket := bucketStart(int64(createdMs / 1000))
		entry := merged[bucket]
		if entry == nil {
			entry = &BucketEntry{}
			merged[bucket] = entry
		}
		entry.add(usage.TokenBreakdown{
			Input: in, Output: out, Reasoning: reasoning,
			CacheRead: cacheRead, CacheWrite: cacheWrite,
		}, cost)
	}
	return merged
}

// LatestCodexRate: the freshest codex window from scanned files.
func (e *Engine) LatestCodexRate() *usage.LimitSnapshot {
	var best *usage.LimitSnapshot
	for _, st := range e.codexFiles {
		if st.rate == nil {
			continue
		}
		if best == nil || (st.rate.ResetsAt != nil && (best.ResetsAt == nil || *st.rate.ResetsAt < *best.ResetsAt)) {
			best = st.rate
		}
	}
	return best
}

// ---- BackfillEvents: merged buckets → UsageEvents ----

// BackfillEvents: UsageEngine.backfillEvents port. Deterministic ids
// (dual FNV-1a mix — EXACT same algorithm as Swift, so re-imports across
// daemons collide on the PRIMARY KEY and skip), attestation selfReported,
// model "(file import)", product = tool.
func (e *Engine) BackfillEvents() []usage.Event {
	merged := map[int64]map[string]*BucketEntry{}
	addAll := func(tool string, buckets map[int64]*BucketEntry) {
		for bucket, entry := range buckets {
			tools := merged[bucket]
			if tools == nil {
				tools = map[string]*BucketEntry{}
				merged[bucket] = tools
			}
			prev := tools[tool]
			if prev == nil {
				prev = &BucketEntry{}
				tools[tool] = prev
			}
			prev.add(entry.Breakdown, entry.Cost)
		}
	}

	addAll("opencode", e.opencodePerBucket())
	addAll("claude", e.scanAdditive([]string{"~/.claude/projects", "~/.claude/transcripts"}, e.claudeFiles, "claude"))
	addAll("kimi", e.scanKimi())
	addAll("codex", e.scanCodex([]string{"~/.codex/sessions", "~/.codex/archived_sessions"}))
	for _, source := range genericSources {
		addAll(source.tool, e.scanAdditive(source.dirs, e.genericFiles, source.tool))
	}

	// Runtime ledger contributions: vendor-aggregate counter deltas,
	// tool=vendor (measured server counters → attestation measured).
	if e.Ledger != nil {
		for vendor, buckets := range e.Ledger.Contributions() {
			for bucket, entry := range buckets {
				tools := merged[int64(bucket)]
				if tools == nil {
					tools = map[string]*BucketEntry{}
					merged[int64(bucket)] = tools
				}
				be := tools[vendor]
				if be == nil {
					be = &BucketEntry{}
					tools[vendor] = be
				}
				be.Breakdown.Input += entry.Input
				be.Breakdown.Output += entry.Output
				be.Breakdown.Reasoning += entry.Reasoning
				be.Breakdown.CacheRead += entry.CacheRead
				be.Breakdown.CacheWrite += entry.CacheWrite
			}
		}
	}

	var events []usage.Event
	for bucket, tools := range merged {
		for tool, entry := range tools {
			vendor := usage.Vendor(tool)
			isRuntime := usage.LocalComputeVendors[vendor]
			costSource := usage.CostSourceUnknown
			if entry.Cost > 0.0001 {
				costSource = usage.CostSourceReported
			} else if usage.PlanVendors[vendor] || isRuntime {
				costSource = usage.CostSourcePlanFree
			}
			model := "(file import)"
			source := "external"
			attestation := "selfReported"
			if isRuntime {
				model = "(ledger import)"
				source = "selfManaged"
				attestation = "measured"
			}
			events = append(events, usage.Event{
				ID:            backfillUUID(tool, bucket),
				Timestamp:     bucket + BucketSeconds/2,
				MachineID:     platform.MachineID(),
				Source:        source,
				Vendor:        vendor,
				Model:         model,
				Tokens:        entry.Breakdown,
				Cost:          entry.Cost,
				CostRaw:       entry.Cost,
				Product:       strPtr(tool),
				ProductRaw:    strPtr(tool),
				ProductSource: strPtr("fileJoined"),
				CostSource:    strPtr(costSource),
				Attestation:   attestation,
			})
		}
	}
	return events
}

func strPtr(s string) *string { return &s }

// backfillUUID: deterministic UUID from the backfill natural key
// (dual FNV-1a mix) — the EXACT Swift algorithm, so ids are identical
// across daemons and re-imports dedup via INSERT OR IGNORE.
func backfillUUID(tool string, bucket int64) string {
	h1 := uint64(0xcbf29ce484222325)
	h2 := uint64(0x84222325cbf29ce4)
	for _, b := range []byte(fmt.Sprintf("backfill|%s|%d", tool, bucket)) {
		h1 = (h1 ^ uint64(b)) * 0x100000001b3
		h2 = (h2 + uint64(b)) * 0x9e3779b97f4a7c15
	}
	var uuid [16]byte
	binary.BigEndian.PutUint64(uuid[:8], h1)
	binary.BigEndian.PutUint64(uuid[8:], h2)
	return fmt.Sprintf("%X-%X-%X-%X-%X",
		uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16])
}
