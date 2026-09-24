package vendors

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
)

// ---- Kimi Coding Plan (OAuth + usages) ----
// See .agents/skills/provider-quota-kimi/SKILL.md.

const kimiClientID = "17e5f671-d194-4dfb-9706-5516cb48c098"

type KimiCredentials struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    float64
	Path         string
}

// ReadAllKimiCredentials: every credential file holding a token is one
// profile (multi-account).
func ReadAllKimiCredentials() []KimiCredentials {
	var out []KimiCredentials
	for _, path := range usage.KimiCredentialFiles() {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		token, _ := obj["access_token"].(string)
		if token == "" {
			continue
		}
		refresh, _ := obj["refresh_token"].(string)
		expires := numOr(obj["expires_at"], 0)
		out = append(out, KimiCredentials{AccessToken: token, RefreshToken: refresh,
			ExpiresAt: expires, Path: path})
	}
	return out
}

func saveKimiCredentials(c KimiCredentials) {
	obj := map[string]any{
		"access_token": c.AccessToken, "refresh_token": c.RefreshToken,
		"expires_at": c.ExpiresAt, "scope": "kimi-code", "token_type": "Bearer",
	}
	data, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(c.Path, data, 0o600)
}

func refreshKimi(c KimiCredentials) *KimiCredentials {
	if c.RefreshToken == "" {
		return nil
	}
	form := url.Values{
		"client_id":     {kimiClientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {c.RefreshToken},
	}
	req, err := http.NewRequest(http.MethodPost, "https://auth.kimi.com/api/oauth/token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	obj := limits.PerformJSON(req, "kimi")
	if obj == nil {
		return nil
	}
	access, _ := obj["access_token"].(string)
	if access == "" {
		return nil
	}
	refresh, _ := obj["refresh_token"].(string)
	if refresh == "" {
		refresh = c.RefreshToken
	}
	expiresIn := numOr(obj["expires_in"], 3600)
	return &KimiCredentials{AccessToken: access, RefreshToken: refresh,
		ExpiresAt: float64(time.Now().Unix()) + expiresIn, Path: c.Path}
}

// kimiProfileLabel: the kimi home two levels up from
// …/.kimi-code/credentials/kimi-code.json → "kimi-code".
func kimiProfileLabel(path string) string {
	base := filepath.Base(filepath.Dir(filepath.Dir(path)))
	return strings.TrimPrefix(base, ".")
}

type Kimi struct{}

func (Kimi) Provider() string { return "kimi" }
func (Kimi) HasCredentials() bool {
	return len(ReadAllKimiCredentials()) > 0
}

func (k Kimi) Fetch() []limits.Limit {
	profiles := ReadAllKimiCredentials()
	if len(profiles) == 0 {
		return nil
	}
	multi := len(profiles) > 1
	var out []limits.Limit
	for i, creds := range profiles {
		if i > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		// Auto-refresh: renew 5 min before expiry.
		if creds.ExpiresAt > 0 && float64(time.Now().Unix())+300 > creds.ExpiresAt {
			if refreshed := refreshKimi(creds); refreshed != nil {
				creds = *refreshed
				saveKimiCredentials(creds)
			} else {
				continue
			}
		}
		profile := ""
		if multi {
			profile = kimiProfileLabel(creds.Path)
		}
		out = append(out, kimiFetchUsages(creds.AccessToken, profile)...)
	}
	return out
}

func kimiFetchUsages(token, profile string) []limits.Limit {
	providerName := "kimi"
	if profile != "" {
		providerName = "kimi (" + profile + ")"
	}
	// Retry ×3: the gateway intermittently omits windows or 429s at the exact
	// moment a window exhausts — a single-shot read blanks the meter right
	// when the user most wants to see it.
	var obj map[string]any
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest(http.MethodGet, "https://api.kimi.com/coding/v1/usages", nil)
		if err != nil {
			return nil
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "OpenUsage")
		if parsed := limits.PerformJSON(req, "kimi"); parsed != nil {
			obj = parsed
			break
		}
		if attempt < 2 {
			time.Sleep(400 * time.Millisecond)
		}
	}
	if obj == nil {
		return nil
	}
	return KimiRowsFromUsagesPayload(obj, providerName)
}

// KimiRowsFromUsagesPayload: pure payload → rows mapping (network-free,
// unit-tested — KimiLimitsEngine.rowsFromUsagesPayload port).
func KimiRowsFromUsagesPayload(obj map[string]any, providerName string) []limits.Limit {
	var rows []limits.Limit
	if usage, _ := obj["usage"].(map[string]any); usage != nil {
		if limit, lok := limits.Quota(usage, "limit"); lok {
			if used, uok := limits.Quota(usage, "used"); uok {
				pct := 0.0
				if limit > 0 {
					pct = used / limit * 100
				}
				resetTime, _ := usage["resetTime"].(string)
				rows = append(rows, limits.Clamped(providerName, "week", pct, limits.ISOUnix(resetTime), "", ""))
			}
		}
	}
	if entries, _ := obj["limits"].([]any); entries != nil {
		for i, raw := range entries {
			if i >= 2 {
				break
			}
			entry, _ := raw.(map[string]any)
			detail, _ := entry["detail"].(map[string]any)
			if detail == nil {
				continue
			}
			limit, lok := limits.Quota(detail, "limit")
			remaining, rok := limits.Quota(detail, "remaining")
			if !lok || !rok {
				continue
			}
			pct := 0.0
			if limit > 0 {
				pct = (limit - remaining) / limit * 100
			}
			label := "window"
			if win, _ := entry["window"].(map[string]any); win != nil {
				duration := int(numOr(win["duration"], 0))
				unit, _ := win["timeUnit"].(string)
				switch {
				case strings.Contains(unit, "MINUTE"):
					if duration%60 == 0 && duration >= 60 {
						label = fmt.Sprintf("%dh", duration/60)
					} else {
						label = fmt.Sprintf("%dm", duration)
					}
				case strings.Contains(unit, "HOUR"):
					label = fmt.Sprintf("%dh", duration)
				case strings.Contains(unit, "DAY"):
					label = fmt.Sprintf("%dd", duration)
				}
			}
			resetTime, _ := detail["resetTime"].(string)
			rows = append(rows, limits.Clamped(providerName, label, pct, limits.ISOUnix(resetTime), "", ""))
		}
	}
	// Fallback synthesis: when the gateway omits the limits[] window entry
	// (observed at window exhaustion), the usages.limit_5h / limit_7d
	// summary block still reports the window. used_ratio is a 0-1 fraction
	// (defensively accept 0-100).
	ratioPercent := func(w map[string]any) (float64, bool) {
		ratio, ok := limits.Quota(w, "used_ratio")
		if !ok {
			return 0, false
		}
		if ratio <= 1 {
			return ratio * 100, true
		}
		return ratio, true
	}
	usages, _ := obj["usages"].(map[string]any)
	hasWeek := false
	hasHourWindow := false
	for _, l := range rows {
		if l.Label == "week" {
			hasWeek = true
		}
		if strings.HasSuffix(l.Label, "h") || strings.HasSuffix(l.Label, "m") {
			hasHourWindow = true
		}
	}
	if !hasWeek {
		if w, _ := usages["limit_7d"].(map[string]any); w != nil {
			if pct, ok := ratioPercent(w); ok {
				resetTime, _ := w["reset_time"].(string)
				rows = append(rows, limits.Clamped(providerName, "week", pct, limits.ISOUnix(resetTime), "", ""))
			}
		}
	}
	if !hasHourWindow {
		if w, _ := usages["limit_5h"].(map[string]any); w != nil {
			if pct, ok := ratioPercent(w); ok {
				resetTime, _ := w["reset_time"].(string)
				rows = append(rows, limits.Clamped(providerName, "5h", pct, limits.ISOUnix(resetTime), "", ""))
			}
		}
	}
	return rows
}
