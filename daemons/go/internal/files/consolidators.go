package files

// File consolidators (Usage/Consolidation/FileConsolidator.swift port):
// recover TOOL ATTRIBUTION and LIMITS from provider files. Files NEVER
// create or modify usage rows — annotations are keyed by provider request
// id and LEFT JOINed at read time; limit snapshots ride the timeline.
//
// Incremental: per-file byte offsets (the 60s poll reads only NEW bytes).
// Natural-key idempotent, so re-polls and truncations are harmless.

import (
	"database/sql"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"os"
	"strings"
	"time"
)

type annotStore interface {
	Annotate([]usage.FileAnnotation) error
	RecordLimits([]usage.LimitSnapshot) error
}

// Consolidator is the per-tool contract.
type Consolidator interface {
	Vendor() string
	Consolidate(store annotStore) (int, error)
}

// jsonlConsolidator: shared incremental tail machinery.
type jsonlConsolidator struct {
	offsets map[string]*uint64
}

func (c *jsonlConsolidator) forEachNewLine(path string, body func(obj map[string]any)) {
	if c.offsets == nil {
		c.offsets = map[string]*uint64{}
	}
	off := c.offsets[path]
	if off == nil {
		off = new(uint64)
		c.offsets[path] = off
	}
	IncrementalRead(path, off, func() {}, func(line []byte) {
		if obj := usage.ParseJSONLine(line); obj != nil {
			body(obj)
		}
	})
}

func jsonlFiles(dirs []string, suffix string) []string {
	var out []string
	for _, dir := range dirs {
		out = append(out, jsonlFilesUnder(resolveHome(dir), suffix)...)
	}
	return out
}

func resolveHome(path string) string {
	home, _ := os.UserHomeDir()
	if path == "~" {
		return home
	}
	if len(path) > 2 && path[:2] == "~/" {
		return home + path[1:]
	}
	return path
}

// ---- Claude Code ----
// Transcript requestId == the `request-id` response header the
// AnthropicMeter captures — the exact join key.

type ClaudeConsolidator struct{ jsonlConsolidator }

func (ClaudeConsolidator) Vendor() string { return "claude" }

func (c ClaudeConsolidator) Consolidate(store annotStore) (int, error) {
	var annotations []usage.FileAnnotation
	for _, file := range jsonlFiles([]string{"~/.claude/projects", "~/.claude/transcripts"}, ".jsonl") {
		f := file
		c.forEachNewLine(f, func(obj map[string]any) {
			message, ok := obj["message"].(map[string]any)
			if !ok {
				return
			}
			u, ok := message["usage"].(map[string]any)
			if !ok {
				return
			}
			if usage.JSONInt(u, "input_tokens") <= 0 && usage.JSONInt(u, "output_tokens") <= 0 {
				return
			}
			rid, _ := obj["requestId"].(string)
			if rid == "" {
				return
			}
			ts, _ := parseTimestamp(obj["timestamp"])
			if ts == 0 {
				ts = time.Now().Unix()
			}
			annotations = append(annotations, usage.FileAnnotation{
				Vendor: "claude", RequestID: rid, Product: "claude-code",
				Timestamp: ts, SourceFile: f,
			})
		})
	}
	return len(annotations), store.Annotate(annotations)
}

// ---- Codex ----
// token_count payloads carry no provider request id — no annotations; what
// they DO carry is the account's rate-limit state → limit snapshots.

type CodexConsolidator struct{ jsonlConsolidator }

func (CodexConsolidator) Vendor() string { return "codex" }

func (c CodexConsolidator) Consolidate(store annotStore) (int, error) {
	var snapshots []usage.LimitSnapshot
	for _, file := range jsonlFiles([]string{"~/.codex/sessions", "~/.codex/archived_sessions"}, ".jsonl") {
		c.forEachNewLine(file, func(obj map[string]any) {
			payload, ok := obj["payload"].(map[string]any)
			if !ok || payload["type"] != "token_count" {
				return
			}
			ts, _ := parseTimestamp(obj["timestamp"])
			if ts == 0 {
				ts = time.Now().Unix()
			}
			for window, w := range CodexRateLimitsParse(payload) {
				sn := usage.LimitSnapshot{
					RecordedAt: ts, MachineID: platform.MachineID(),
					Provider: "codex", Label: codexWindowLabel(w.windowMinutes),
					UsedPercent: w.usedPercent,
					Detail:      fmt.Sprintf("codex %s window (file)", window),
				}
				if w.resetsAt > 0 {
					at := int64(w.resetsAt)
					sn.ResetsAt = &at
				}
				snapshots = append(snapshots, sn)
			}
		})
	}
	return len(snapshots), store.RecordLimits(snapshots)
}

// ---- Kimi ----
// wire.jsonl records usually carry no provider request id; when one is
// present it joins the AnthropicMeter's wire id (kimi speaks
// anthropic-compatible).

type KimiConsolidator struct{ jsonlConsolidator }

func (KimiConsolidator) Vendor() string { return "kimi" }

func (c KimiConsolidator) Consolidate(store annotStore) (int, error) {
	var annotations []usage.FileAnnotation
	for _, file := range jsonlFiles(usage.KimiSessionDirs(), "wire.jsonl") {
		f := file
		c.forEachNewLine(f, func(obj map[string]any) {
			ts, _ := parseTimestamp(obj["timestamp"])
			if ts == 0 {
				ts = time.Now().Unix()
			}
			// Old CLI (~/.kimi): message.payload.token_usage + message_id.
			if message, ok := obj["message"].(map[string]any); ok {
				if payload, ok := message["payload"].(map[string]any); ok && payload["token_usage"] != nil {
					rid := firstString(payload, "request_id", "requestId", "message_id")
					if rid == "" {
						rid, _ = message["requestId"].(string)
					}
					if rid == "" {
						rid, _ = obj["request_id"].(string)
					}
					if rid == "" {
						return
					}
					annotations = append(annotations, usage.FileAnnotation{
						Vendor: "kimi", RequestID: rid, Product: "kimi-cli",
						Timestamp: ts, SourceFile: f,
					})
					return
				}
			}
			// New CLI (~/.kimi-code): context.append_loop_event → step.end.
			if obj["type"] == "context.append_loop_event" {
				event, _ := obj["event"].(map[string]any)
				if event == nil || event["type"] != "step.end" || event["usage"] == nil {
					return
				}
				rid, _ := event["messageId"].(string)
				if rid == "" {
					return
				}
				annotations = append(annotations, usage.FileAnnotation{
					Vendor: "kimi", RequestID: rid, Product: "kimi-code",
					Timestamp: ts, SourceFile: f,
				})
			}
		})
	}
	return len(annotations), store.Annotate(annotations)
}

func firstString(dict map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, _ := dict[k].(string); v != "" {
			return v
		}
	}
	return ""
}

// ---- pi (coding agent harness) ----
// message.provider is the upstream vendor (annotation vendor); product is
// "pi"; usage.cost.total is the pi-reported billed cost (outranks computed
// at read time; both stored, nothing merged).

type PiConsolidator struct{ jsonlConsolidator }

func (PiConsolidator) Vendor() string { return "pi" }

func (c PiConsolidator) Consolidate(store annotStore) (int, error) {
	var annotations []usage.FileAnnotation
	for _, file := range jsonlFiles([]string{"~/.pi/agent/sessions"}, ".jsonl") {
		f := file
		c.forEachNewLine(f, func(obj map[string]any) {
			if obj["type"] != "message" {
				return
			}
			message, ok := obj["message"].(map[string]any)
			if !ok || message["role"] != "assistant" || message["usage"] == nil {
				return
			}
			rid, _ := message["responseId"].(string)
			if rid == "" {
				return
			}
			provider, _ := message["provider"].(string)
			if provider == "" {
				provider = "pi"
			}
			provider = strings.ToLower(strings.ReplaceAll(provider, " ", "-"))
			var cost *float64
			if usage, ok := message["usage"].(map[string]any); ok {
				if costBlock, ok := usage["cost"].(map[string]any); ok {
					if total, ok := costBlock["total"].(float64); ok {
						cost = &total
					}
				}
			}
			ts, _ := parseTimestamp(obj["timestamp"])
			if ts == 0 {
				ts = time.Now().Unix()
			}
			annotations = append(annotations, usage.FileAnnotation{
				Vendor: provider, RequestID: rid, Product: "pi", Cost: cost,
				Timestamp: ts, SourceFile: f,
			})
		})
	}
	return len(annotations), store.Annotate(annotations)
}

// ---- opencode (sqlite) ----
// One annotation per assistant message row exposing an upstream response
// id; rows carry the zen-reported cost.

type OpenCodeConsolidator struct{ Engine *Engine } // Engine for DB path override (tests)

func (OpenCodeConsolidator) Vendor() string { return "opencode" }

func (c OpenCodeConsolidator) dbPath() string {
	if c.Engine != nil {
		return c.Engine.opencodeDBPath()
	}
	return NewEngine().opencodeDBPath()
}

func (c OpenCodeConsolidator) Consolidate(store annotStore) (int, error) {
	path := c.dbPath()
	if path == "" {
		return 0, nil
	}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(150)", path))
	if err != nil {
		return 0, nil
	}
	defer db.Close()
	rows, err := db.Query(`SELECT COALESCE(json_extract(data,'$.responseID'),
			json_extract(data,'$.responseId'),
			json_extract(data,'$.provider.responseId'), ''),
		time_created, COALESCE(json_extract(data,'$.cost'),0)
		FROM message WHERE json_extract(data,'$.role')='assistant'`)
	if err != nil {
		return 0, nil
	}
	defer rows.Close()
	var annotations []usage.FileAnnotation
	for rows.Next() {
		var rid string
		var createdMs, cost float64
		if rows.Scan(&rid, &createdMs, &cost) != nil || rid == "" {
			continue
		}
		annotations = append(annotations, usage.FileAnnotation{
			Vendor: "opencode", RequestID: rid, Product: "opencode", Cost: &cost,
			Timestamp: int64(createdMs / 1000), SourceFile: path,
		})
	}
	return len(annotations), store.Annotate(annotations)
}

// DefaultConsolidators: one per file-reading tool.
func DefaultConsolidators(engine *Engine) []Consolidator {
	return []Consolidator{
		ClaudeConsolidator{}, CodexConsolidator{}, KimiConsolidator{},
		PiConsolidator{}, OpenCodeConsolidator{Engine: engine},
	}
}
