package main

import (
	"bufio"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// BodyCapBytes bounds stored body text per side per trace. Normal chat
	// traffic is single-digit KB; 256KB covers large tool results while
	// keeping a worst-case trace ~0.5MB.
	BodyCapBytes = 256 * 1024
	// MemoryCap bounds the in-memory ring serving /traces + /proxy/stats.
	MemoryCap = 200
	// MaxDayFiles retains 30 JSONL day files on disk.
	MaxDayFiles = 30
	// MaxDirBytes caps the trace directory; oldest days are pruned first.
	MaxDirBytes = int64(256 * 1024 * 1024)
	// RetryWindow flags a repeated request hash as a retry suspect.
	RetryWindow = 10 * time.Minute
	// loadMaxBytes / loadMaxDays bound cold-start hydration.
	loadMaxBytes = 8 * 1024 * 1024
	loadMaxDays  = 7
)

// Store is the bounded trace store: an in-memory ring for instant reads
// plus append-only JSONL day files for full-text history. Cloud-provider
// traces are NOT usage-engine totals (file parsers already count that
// traffic); they are analytics records.
type Store struct {
	mu           sync.Mutex
	traces       []Trace
	dir          string
	loaded       bool
	diskEnabled  bool
	pruneCounter int
}

func NewStore(dir string) *Store {
	return &Store{dir: dir, diskEnabled: true}
}

// CapBody truncates body text to the storage budget, reporting truncation.
func CapBody(text string) (string, bool) {
	if text == "" {
		return "", false
	}
	if len(text) <= BodyCapBytes {
		return text, false
	}
	// Cut at a UTF-8 boundary.
	end := BodyCapBytes
	for end > 0 && !validPrefix(text, end) {
		end--
	}
	return text[:end], true
}

func validPrefix(s string, n int) bool {
	if n >= len(s) {
		return true
	}
	c := s[n]
	// Continuation bytes have the form 10xxxxxx.
	return c < 0x80 || c >= 0xC0
}

// Record stores a trace, flagging retry suspects (same request hash seen
// within the retry window). It returns the stored copy.
func (s *Store) Record(t Trace) Trace {
	s.mu.Lock()
	s.ensureLoaded()
	cutoff := t.StartedAt.Time().Add(-RetryWindow)
	for _, prev := range s.traces {
		if prev.RequestHash == t.RequestHash && !prev.StartedAt.Time().Before(cutoff) && prev.ID != t.ID {
			t.RetrySuspect = true
			break
		}
	}
	s.traces = append(s.traces, t)
	if len(s.traces) > MemoryCap {
		s.traces = append([]Trace(nil), s.traces[len(s.traces)-MemoryCap:]...)
	}
	s.pruneCounter++
	shouldPrune := s.pruneCounter%25 == 0
	disk := s.diskEnabled
	s.mu.Unlock()

	if disk {
		s.appendJSONL(t)
		if shouldPrune {
			go s.prune()
		}
	}
	return t
}

// TraceFilter narrows Recent results; the zero value matches everything.
type TraceFilter struct {
	Provider   Provider
	Model      string
	Session    string
	Client     string
	ErrorsOnly bool
}

func (f TraceFilter) match(t Trace) bool {
	if f.Provider != "" && t.Provider != f.Provider {
		return false
	}
	if f.Model != "" && !equalFold(t.Model, f.Model) {
		return false
	}
	if f.Session != "" && (t.SessionKey == nil || *t.SessionKey != f.Session) {
		return false
	}
	if f.Client != "" && t.Client != f.Client {
		return false
	}
	if f.ErrorsOnly && t.ErrorClass == ErrNone {
		return false
	}
	return true
}

// Recent returns the newest traces first, filtered.
func (s *Store) Recent(limit int, f TraceFilter) []Trace {
	s.mu.Lock()
	s.ensureLoaded()
	all := append([]Trace(nil), s.traces...)
	s.mu.Unlock()
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	var filtered []Trace
	for i := len(all) - 1; i >= 0; i-- {
		t := all[i]
		if !f.match(t) {
			continue
		}
		filtered = append(filtered, t.Summary())
		if len(filtered) >= limit {
			break
		}
	}
	if filtered == nil {
		filtered = []Trace{}
	}
	return filtered
}

// Sessions groups windowed traces by session key into conversation spans,
// newest activity first. Traces without a session key are skipped.
func (s *Store) Sessions(hours, limit int) []SessionStats {
	if hours < 1 {
		hours = 1
	}
	if hours > 168 {
		hours = 168
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	s.mu.Lock()
	s.ensureLoaded()
	all := append([]Trace(nil), s.traces...)
	s.mu.Unlock()
	type acc struct {
		stats     SessionStats
		providers map[string]struct{}
		models    map[string]struct{}
		clients   map[string]struct{}
	}
	byKey := map[string]*acc{}
	for _, t := range all {
		if t.SessionKey == nil || *t.SessionKey == "" || t.StartedAt.Time().Before(since) {
			continue
		}
		a := byKey[*t.SessionKey]
		if a == nil {
			a = &acc{
				stats:     SessionStats{SessionKey: *t.SessionKey, FirstAt: t.StartedAt, LastAt: t.StartedAt},
				providers: map[string]struct{}{}, models: map[string]struct{}{}, clients: map[string]struct{}{},
			}
			byKey[*t.SessionKey] = a
		}
		a.stats.Requests++
		if t.ErrorClass != ErrNone {
			a.stats.ErrorCount++
		}
		if t.Usage.InputTokens != nil {
			a.stats.InputTokens += *t.Usage.InputTokens
		}
		if t.Usage.OutputTokens != nil {
			a.stats.OutputTokens += *t.Usage.OutputTokens
		}
		a.stats.ToolCallCount += len(t.ToolCalls)
		a.providers[string(t.Provider)] = struct{}{}
		if t.Model != "" {
			a.models[t.Model] = struct{}{}
		}
		if t.Client != "" {
			a.clients[t.Client] = struct{}{}
		}
		if t.StartedAt.Time().Before(a.stats.FirstAt.Time()) {
			a.stats.FirstAt = t.StartedAt
		}
		if t.StartedAt.Time().After(a.stats.LastAt.Time()) {
			a.stats.LastAt = t.StartedAt
		}
	}
	out := make([]SessionStats, 0, len(byKey))
	for _, a := range byKey {
		a.stats.SpanMs = a.stats.LastAt.Time().Sub(a.stats.FirstAt.Time()).Seconds() * 1000
		for p := range a.providers {
			a.stats.Providers = append(a.stats.Providers, p)
		}
		for m := range a.models {
			a.stats.Models = append(a.stats.Models, m)
		}
		for c := range a.clients {
			a.stats.Clients = append(a.stats.Clients, c)
		}
		sort.Strings(a.stats.Providers)
		sort.Strings(a.stats.Models)
		sort.Strings(a.stats.Clients)
		if a.stats.Providers == nil {
			a.stats.Providers = []string{}
		}
		if a.stats.Models == nil {
			a.stats.Models = []string{}
		}
		if a.stats.Clients == nil {
			a.stats.Clients = []string{}
		}
		out = append(out, a.stats)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastAt.Time().After(out[j].LastAt.Time()) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func equalFold(a, b string) bool { return strings.EqualFold(a, b) }

// Get returns one full trace by id, or false.
func (s *Store) Get(id string) (Trace, bool) {
	s.mu.Lock()
	s.ensureLoaded()
	defer s.mu.Unlock()
	for i := len(s.traces) - 1; i >= 0; i-- {
		if s.traces[i].ID == id {
			return s.traces[i], true
		}
	}
	return Trace{}, false
}

// Stats aggregates the windowed slice into efficiency stats.
func (s *Store) Stats(provider Provider, model string, hours int) Stats {
	if hours < 1 {
		hours = 1
	}
	if hours > 168 {
		hours = 168
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	s.mu.Lock()
	s.ensureLoaded()
	all := append([]Trace(nil), s.traces...)
	s.mu.Unlock()
	var slice []Trace
	for _, t := range all {
		if t.StartedAt.Time().Before(since) {
			continue
		}
		if provider != "" && t.Provider != provider {
			continue
		}
		if model != "" && !equalFold(t.Model, model) {
			continue
		}
		slice = append(slice, t)
	}
	return Rollup(slice, hours, since)
}

// Counts reports memory traces, day files, and directory bytes.
func (s *Store) Counts() (memory, dayFiles int, bytes int64) {
	s.mu.Lock()
	memory = len(s.traces)
	s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return memory, 0, 0
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		dayFiles++
		if info, err := e.Info(); err == nil {
			bytes += info.Size()
		}
	}
	return memory, dayFiles, bytes
}

// Clear drops memory and deletes day files, returning both counts.
func (s *Store) Clear() (traces, files int) {
	s.mu.Lock()
	traces = len(s.traces)
	s.traces = nil
	disk := s.diskEnabled
	s.mu.Unlock()
	if disk {
		entries, err := os.ReadDir(s.dir)
		if err == nil {
			for _, e := range entries {
				if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
					continue
				}
				if os.Remove(filepath.Join(s.dir, e.Name())) == nil {
					files++
				}
			}
		}
	}
	return traces, files
}

func (s *Store) dayPath(t time.Time) string {
	return filepath.Join(s.dir, t.Format("2006-01-02")+".jsonl")
}

func (s *Store) appendJSONL(t Trace) {
	data, err := json.Marshal(t)
	if err != nil {
		return
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return
	}
	path := s.dayPath(t.StartedAt.Time())
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > 0 {
		f.Write([]byte{'\n'})
	}
	f.Write(data)
}

func (s *Store) ensureLoaded() {
	if s.loaded {
		return
	}
	s.loaded = true
	if !s.diskEnabled {
		return
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	var days []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".jsonl" {
			days = append(days, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(days)))
	if len(days) > loadMaxDays {
		days = days[:loadMaxDays]
	}
	var loaded []Trace
	budget := loadMaxBytes
outer:
	for _, day := range days {
		f, err := os.Open(filepath.Join(s.dir, day))
		if err != nil {
			continue
		}
		var lines []string
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1024*1024), 1024*1024)
		for sc.Scan() {
			lines = append(lines, sc.Text())
		}
		f.Close()
		for i := len(lines) - 1; i >= 0; i-- {
			if len(loaded) >= MemoryCap || budget <= 0 {
				break outer
			}
			budget -= len(lines[i])
			var t Trace
			if json.Unmarshal([]byte(lines[i]), &t) == nil && t.ID != "" {
				loaded = append(loaded, t)
			}
		}
	}
	for i, j := 0, len(loaded)-1; i < j; i, j = i+1, j-1 {
		loaded[i], loaded[j] = loaded[j], loaded[i]
	}
	s.traces = loaded
}

func (s *Store) prune() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	var days []string
	sizes := map[string]int64{}
	var total int64
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		days = append(days, e.Name())
		if info, err := e.Info(); err == nil {
			sizes[e.Name()] = info.Size()
			total += info.Size()
		}
	}
	sort.Strings(days)
	for len(days) > MaxDayFiles {
		oldest := days[0]
		days = days[1:]
		if os.Remove(filepath.Join(s.dir, oldest)) == nil {
			total -= sizes[oldest]
			log.Printf("gateway: pruned trace day %s (retention)", oldest)
		}
	}
	for _, day := range days {
		if total <= MaxDirBytes {
			break
		}
		if os.Remove(filepath.Join(s.dir, day)) == nil {
			total -= sizes[day]
			log.Printf("gateway: pruned trace day %s (size budget)", day)
		}
	}
}

// traceIDGenerator is overridden in tests for determinism.
var traceIDGenerator = func() string {
	return strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + strconv.Itoa(os.Getpid())
}
