package runtime

// RuntimeUsageLedger: durable 5-minute usage buckets for self-managed
// runtimes (vLLM, SGLang, llama.cpp). Local runtimes keep token counters in
// server memory only — restart the server and they reset, restart the daemon
// and the deltas are lost. The ledger persists MEASURED COUNTER DELTAS into
// buckets so local inference accrues the same queryable history as
// providers. Honesty rule: only measured deltas are recorded; tokens
// generated while the daemon was down are NOT backfilled.
//
// Disk format matches Swift exactly: {"scopes": {"<scope>": {"<bucket>":
// {"input":n,"output":n,"reasoning":n,"cacheRead":n,"cacheWrite":n}}}}
// (scope = "vendor" aggregate or "vendor|model"; bucket keys are decimal
// strings). runtime-usage.json in the shared config dir is byte-compatible.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

const BucketSeconds = 300

const RetentionSeconds = 366 * 86_400

// Entry: token-type deltas for one bucket — alias of core.TokenBreakdown
// (identical JSON shape, shared with the files backfill interface).
type Entry = core.TokenBreakdown

func addEntry(dst *Entry, src Entry) {
	dst.Input += src.Input
	dst.Output += src.Output
	dst.Reasoning += src.Reasoning
	dst.CacheRead += src.CacheRead
	dst.CacheWrite += src.CacheWrite
}

type diskFormat struct {
	Scopes map[string]map[string]Entry `json:"scopes"`
}

// Ledger: thread-safe, dirty-tracked, 30s-throttled atomic flushes.
type Ledger struct {
	path      string
	mu        sync.Mutex
	scopes    map[string]map[int]Entry
	dirty     bool
	lastFlush time.Time
}

func BucketStart(epochSeconds int64) int64 {
	return epochSeconds / BucketSeconds * BucketSeconds
}

func NewLedger(path string) *Ledger {
	l := &Ledger{path: path, scopes: map[string]map[int]Entry{}}
	l.load()
	return l
}

// DefaultLedgerPath: <configDir>/runtime-usage.json.
func DefaultLedgerPath(configDir string) string {
	return filepath.Join(configDir, "runtime-usage.json")
}

// Record measured deltas into the bucket containing `at`. model == ""
// writes the vendor aggregate scope; a non-nil model writes ONLY the
// "vendor|model" scope (callers record the aggregate separately).
func (l *Ledger) Record(vendor, model string, input, output int, at time.Time) {
	l.RecordBreakdown(vendor, model, Entry{Input: int64(input), Output: int64(output)}, at)
}

func (l *Ledger) RecordBreakdown(vendor, model string, e Entry, at time.Time) {
	if e.Total() <= 0 {
		return
	}
	bucket := int(BucketStart(at.Unix()))
	l.mu.Lock()
	scope := vendor
	if model != "" {
		scope = vendor + "|" + model
	}
	buckets := l.scopes[scope]
	if buckets == nil {
		buckets = map[int]Entry{}
		l.scopes[scope] = buckets
	}
	entry := buckets[bucket]
	addEntry(&entry, e)
	buckets[bucket] = entry
	l.dirty = true
	due := time.Since(l.lastFlush) > 30*time.Second
	l.mu.Unlock()
	if due {
		l.Flush()
	}
}

// Totals: vendor-aggregate all-time/today totals (UTC day boundary).
func (l *Ledger) Totals(vendor string) (all, today int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	todayStart := todayBucket()
	for bucket, e := range l.scopes[vendor] {
		all += int(e.Total())
		if int64(bucket) >= todayStart {
			today += int(e.Total())
		}
	}
	return all, today
}

// Contributions: vendor-aggregate buckets keyed by bucket epoch — the shape
// BackfillEvents consumes ("(ledger import)" events, attestation measured).
func (l *Ledger) Contributions() map[string]map[int]Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]map[int]Entry{}
	for scope, buckets := range l.scopes {
		if strings.Contains(scope, "|") {
			continue // per-model scopes don't feed the aggregate contribution
		}
		agg := out[scope]
		if agg == nil {
			agg = map[int]Entry{}
			out[scope] = agg
		}
		for bucket, e := range buckets {
			cur := agg[bucket]
			addEntry(&cur, e)
			agg[bucket] = cur
		}
	}
	return out
}

// todayBucket: UTC midnight (never local — servers disagree otherwise).
func todayBucket() int64 {
	now := time.Now().UTC()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return midnight.Unix() / BucketSeconds * BucketSeconds
}

// Flush: prune old buckets + atomic write (temp sibling + rename).
func (l *Ledger) Flush() {
	l.mu.Lock()
	if !l.dirty {
		l.mu.Unlock()
		return
	}
	cutoff := int(time.Now().Unix()) - RetentionSeconds
	disk := diskFormat{Scopes: map[string]map[string]Entry{}}
	for scope, buckets := range l.scopes {
		kept := map[int]Entry{}
		out := map[string]Entry{}
		for bucket, e := range buckets {
			if bucket >= cutoff {
				kept[bucket] = e
				out[strconv.Itoa(bucket)] = e
			}
		}
		l.scopes[scope] = kept
		disk.Scopes[scope] = out
	}
	l.dirty = false
	l.lastFlush = time.Now()
	path := l.path
	l.mu.Unlock()

	data, err := json.Marshal(disk)
	if err != nil {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	os.Rename(tmp, path)
}

func (l *Ledger) load() {
	data, err := os.ReadFile(l.path)
	if err != nil {
		return
	}
	var disk diskFormat
	if json.Unmarshal(data, &disk) != nil {
		return
	}
	for scope, buckets := range disk.Scopes {
		out := map[int]Entry{}
		for key, e := range buckets {
			if bucket, err := strconv.Atoi(key); err == nil {
				out[bucket] = e
			}
		}
		l.scopes[scope] = out
	}
}
