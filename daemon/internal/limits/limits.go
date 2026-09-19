package limits

// Shared infra for vendor quota adapters (Providers/Limits port):
// LimitsEngine base (cache/refresh throttle/snapshot recording), the
// blocking JSON-over-HTTP helper with per-host 429 backoff, and the quota
// coercion parsers (QuotaParsers port — single source of truth so per-vendor
// parsing never drifts).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

// Limit mirrors ProviderLimit (usedPercent 0-100, clamped).
type Limit struct {
	Provider    string  `json:"provider"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    *int64  `json:"resetsAt,omitempty"`
	Detail      string  `json:"detail"`
	AccountID   string  `json:"accountID,omitempty"`
}

// Clamped builds a row with usedPercent clamped to 0-100.
func Clamped(provider, label string, usedPercent float64, resetsAt *int64, detail, accountID string) Limit {
	if usedPercent < 0 {
		usedPercent = 0
	}
	if usedPercent > 100 {
		usedPercent = 100
	}
	return Limit{Provider: provider, Label: label, UsedPercent: usedPercent,
		ResetsAt: resetsAt, Detail: detail, AccountID: accountID}
}

// Adapter is the per-vendor contract (VendorLimitsAdapter port).
type Adapter interface {
	Provider() string
	// Fetch returns fresh limits (may block; called off the hot path).
	Fetch() []Limit
	// HasCredentials reports whether any credential resolves — distinguishes
	// "vendor unconfigured" (drop rows) from "transient failure" (retain).
	HasCredentials() bool
}

// Engine is the LimitsEngine base: bounded cache, throttled refresh,
// snapshot recording into the store.
type Engine struct {
	mu        sync.Mutex
	cache     []Limit
	lastFetch time.Time
	store     interface {
		RecordLimits([]core.LimitSnapshot) error
	}
}

func NewEngine(store interface {
	RecordLimits([]core.LimitSnapshot) error
}) *Engine {
	return &Engine{store: store}
}

func (e *Engine) Cached() []Limit {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]Limit(nil), e.cache...)
}

func (e *Engine) RefreshNow(fetch func() []Limit) {
	e.mu.Lock()
	e.lastFetch = time.Time{}
	e.mu.Unlock()
	e.RefreshIfDue(fetch, 0)
}

func (e *Engine) RefreshIfDue(fetch func() []Limit, maxAge time.Duration) {
	e.mu.Lock()
	if time.Since(e.lastFetch) < maxAge {
		e.mu.Unlock()
		return
	}
	e.lastFetch = time.Now()
	e.mu.Unlock()
	limits := fetch()
	e.mu.Lock()
	e.cache = limits
	e.mu.Unlock()
	if e.store != nil && len(limits) > 0 {
		snaps := make([]core.LimitSnapshot, 0, len(limits))
		for _, l := range limits {
			snaps = append(snaps, core.LimitSnapshot{
				RecordedAt: time.Now().Unix(), MachineID: core.MachineID(),
				Provider: l.Provider, AccountID: l.AccountID, Label: l.Label,
				UsedPercent: l.UsedPercent, ResetsAt: l.ResetsAt, Detail: l.Detail,
			})
		}
		_ = e.store.RecordLimits(snaps)
	}
}

// ---- HTTP helper (Platform/HTTP.swift + VendorLimitsAdapter helpers) ----

// UserAgent: keep the opencode UA string — some vendor gateways key off it.
var UserAgent = "opencode/1.0.0 (" + map[string]string{
	"darwin": "darwin; arm64", "linux": "linux; x86_64",
}[runtime.GOOS] + ")"

var (
	backoffMu   sync.Mutex
	backoffHost = map[string]time.Time{}
)

func isBackedOff(host string) bool {
	backoffMu.Lock()
	defer backoffMu.Unlock()
	return time.Now().Before(backoffHost[host])
}

func noteStatus(host string, status int) {
	if status != 429 {
		return
	}
	backoffMu.Lock()
	backoffHost[host] = time.Now().Add(60 * time.Second)
	backoffMu.Unlock()
}

var httpClient = &http.Client{Timeout: 12 * time.Second}

// PerformRaw: blocking raw request. nil on transport error, non-2xx.
// 401/403 logged so expired keys don't silently drop rows; 429 arms a
// per-host backoff window.
func PerformRaw(req *http.Request, provider string) []byte {
	host := req.URL.Hostname()
	if isBackedOff(host) {
		return nil
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	noteStatus(host, resp.StatusCode)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		fmt.Fprintf(os.Stderr, "token-horizon: %s quota 401/403 — credential expired, re-auth required\n", provider)
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	data := make([]byte, 0, 64*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		data = append(data, buf[:n]...)
		if err != nil {
			break
		}
	}
	return data
}

func PerformJSON(req *http.Request, provider string) map[string]any {
	data := PerformRaw(req, provider)
	if data == nil {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return nil
	}
	return obj
}

func GetJSON(url, key, provider string) map[string]any {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	return PerformJSON(req, provider)
}

func PostJSON(url, key, provider string, body map[string]any) map[string]any {
	data, err := json.Marshal(body)
	if err != nil {
		return nil
	}
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(data)))
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	return PerformJSON(req, provider)
}

// ---- QuotaParsers port ----

// Number coerces JSON numbers AND string numbers ("120", "1.5M").
func Number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return f, true
		}
		return FlexibleNumber(n)
	}
	return 0, false
}

func Quota(dict map[string]any, key string) (float64, bool) { return Number(dict[key]) }

// FlexibleNumber parses "1.5M", "200K", "3B" (case-insensitive).
func FlexibleNumber(s string) (float64, bool) {
	trimmed := strings.ToUpper(strings.TrimSpace(s))
	var numPart strings.Builder
	multiplier := 1.0
	for _, ch := range trimmed {
		switch {
		case ch >= '0' && ch <= '9' || ch == '.':
			numPart.WriteRune(ch)
		case ch == 'K':
			multiplier = 1_000
		case ch == 'M':
			multiplier = 1_000_000
		case ch == 'B':
			multiplier = 1_000_000_000
		default:
			if numPart.Len() > 0 {
				goto done
			}
		}
	}
done:
	v, err := strconv.ParseFloat(numPart.String(), 64)
	if err != nil {
		return 0, false
	}
	return v * multiplier, true
}

// ParseISO parses RFC3339 with or without fractional seconds.
func ParseISO(s string) *time.Time {
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return &t
		}
	}
	return nil
}

// Epoch coerces epoch seconds (or ms when > 1e12) to a time.
func Epoch(v any) *time.Time {
	n, ok := Number(v)
	if !ok {
		return nil
	}
	if n > 1e12 {
		n /= 1000
	}
	t := time.Unix(int64(n), 0)
	return &t
}

func EpochUnix(v any) *int64 {
	if t := Epoch(v); t != nil {
		u := t.Unix()
		return &u
	}
	return nil
}

func ISOUnix(s string) *int64 {
	if t := ParseISO(s); t != nil {
		u := t.Unix()
		return &u
	}
	return nil
}

func Compact(v float64) string {
	switch {
	case v >= 1_000_000_000:
		return fmt.Sprintf("%.1fB", v/1_000_000_000)
	case v >= 1_000_000:
		return fmt.Sprintf("%.1fM", v/1_000_000)
	case v >= 1_000:
		return fmt.Sprintf("%.1fk", v/1_000)
	default:
		return fmt.Sprintf("%.0f", v)
	}
}

// FindDictContainingAny walks a JSON tree (depth ≤ 10) for the first object
// holding any of the keys.
func FindDictContainingAny(keys []string, node any, depth int) map[string]any {
	if depth >= 10 {
		return nil
	}
	switch n := node.(type) {
	case map[string]any:
		for _, k := range keys {
			if n[k] != nil {
				return n
			}
		}
		for _, v := range n {
			if found := FindDictContainingAny(keys, v, depth+1); found != nil {
				return found
			}
		}
	case []any:
		for _, v := range n {
			if found := FindDictContainingAny(keys, v, depth+1); found != nil {
				return found
			}
		}
	}
	return nil
}

func CookieValue(name, cookie string) string {
	for _, pair := range strings.Split(cookie, ";") {
		trimmed := strings.TrimSpace(pair)
		if strings.HasPrefix(trimmed, name+"=") {
			v := trimmed[len(name)+1:]
			if dec, err := url.QueryUnescape(v); err == nil {
				return dec
			}
			return v
		}
	}
	return ""
}
