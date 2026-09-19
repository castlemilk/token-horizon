package usage

// Read-time canonicalization, ported from Catalog/Canonical.swift: stored
// rows keep RAW spellings; folds happen in SQL (vendor CASE) and via the
// spelling cache (models). canonical.json in the config dir is a
// USER-EDITABLE override map that wins over the built-in tables.

import (
	"encoding/json"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// vendorTable mirrors Canonical.vendorTable — keep in lockstep.
var vendorTable = map[string]string{
	"anthropic":           "claude",
	"kimi-coding":         "kimi",
	"kimi-coding-plan":    "kimi",
	"kimi-code":           "kimi",
	"moonshot":            "kimi",
	"zai":                 "glm",
	"zhipu":               "glm",
	"zai-coding-plan":     "glm",
	"google":              "gemini",
	"minimax-coding-plan": "minimax",
	"alibaba-token-plan":  "alibaba",
	"opencode-go":         "opencode",
	"llama-cpp":           "llamacpp",
	"llama.cpp":           "llamacpp",
	"llama":               "llamacpp",
	"antigravity":         "agy",
}

type canonicalOverrides struct {
	Vendors map[string]string `json:"vendors"`
	Models  map[string]string `json:"models"`
}

var (
	overrideMu     sync.Mutex
	overrideCache  canonicalOverrides
	overrideLoaded time.Time
	overrideMtime  time.Time
)

// currentOverrides reloads canonical.json live (5s mtime TTL), same as the
// Swift side.
func currentOverrides() canonicalOverrides {
	overrideMu.Lock()
	defer overrideMu.Unlock()
	path := filepath.Join(platform.ConfigDir(), "canonical.json")
	info, err := os.Stat(path)
	if err != nil {
		overrideCache = canonicalOverrides{}
		overrideLoaded = time.Now()
		overrideMtime = time.Time{}
		return overrideCache
	}
	if time.Since(overrideLoaded) < 5*time.Second && info.ModTime().Equal(overrideMtime) {
		return overrideCache
	}
	data, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(data, &overrideCache)
	}
	overrideLoaded = time.Now()
	overrideMtime = info.ModTime()
	return overrideCache
}

// Vendor folds a raw vendor spelling to canonical form (lowercased
// pass-through for unknowns).
func Vendor(raw string) string {
	k := strings.ToLower(strings.TrimSpace(raw))
	if v, ok := currentOverrides().Vendors[k]; ok {
		return v
	}
	if v, ok := vendorTable[k]; ok {
		return v
	}
	return k
}

// vendorCASE builds the SQL CASE expression folding a vendor column to
// canonical form entirely in SQL (stored rows stay raw).
func VendorCASE(column string) string {
	var b strings.Builder
	b.WriteString("CASE LOWER(TRIM(")
	b.WriteString(column)
	b.WriteString("))")
	table := vendorTable
	for k, v := range currentOverrides().Vendors {
		table[k] = v
	}
	for alias, canon := range table {
		b.WriteString(" WHEN '")
		b.WriteString(strings.ReplaceAll(alias, "'", "''"))
		b.WriteString("' THEN '")
		b.WriteString(strings.ReplaceAll(canon, "'", "''"))
		b.WriteString("'")
	}
	b.WriteString(" ELSE LOWER(TRIM(")
	b.WriteString(column)
	b.WriteString(")) END")
	return b.String()
}

// Model folds a raw model spelling toward its canonical id. M1 covers the
// regex-level folds (@attribution suffix, case, snapshot dates, claude
// dotted versions) plus canonical.json model overrides; catalog family-key
// matching arrives with the catalog port (the spelling cache table makes
// folds refineable read-side without touching stored rows).
var (
	snapshotDate    = regexp.MustCompile(`-20\d{6}$`)
	claudeDottedNew = regexp.MustCompile(`(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)`)
	claudeDottedOld = regexp.MustCompile(`claude-(\d+)\.(\d+)`)
)

func Model(vendor, raw string) string {
	m := raw
	if i := strings.IndexByte(m, '@'); i >= 0 {
		m = m[:i]
	}
	m = strings.ToLower(strings.TrimSpace(m))
	m = snapshotDate.ReplaceAllString(m, "")
	m = claudeDottedNew.ReplaceAllString(m, "$1-$2")
	m = claudeDottedOld.ReplaceAllString(m, "claude-$1-$2")
	if v, ok := currentOverrides().Models[Vendor(vendor)+"/"+m]; ok {
		return v
	}
	return m
}
