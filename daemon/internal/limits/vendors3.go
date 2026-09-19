package limits

// Alibaba (cookie-authenticated rolling-window handshake) and Kimi (OAuth
// with auto-refresh + usages payload), plus the Plan registry with
// per-vendor last-good retention.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemon/internal/auth"
	"github.com/castlemilk/token-horizon/daemon/internal/core"
)

// ---- Alibaba Cloud Model Studio (Bailian) Token Plan ----
// See .agents/skills/provider-quota-alibaba/SKILL.md for the handshake spec.

type Alibaba struct{}

func (Alibaba) Provider() string { return "alibaba" }

func (a Alibaba) chain() auth.Chain {
	cookieFile := configPath("alibaba-cookie.txt")
	return auth.Chain{Sources: []auth.Source{
		auth.FileTextEnv("ALIBABA_COOKIE_FILE", cookieFile),
		auth.Env("ALIBABA_TOKEN_PLAN_COOKIE"),
		auth.FileText(cookieFile),
		auth.Custom(func() string {
			data, err := os.ReadFile(filepath.Join(core.ConfigDir(), "settings.json"))
			if err != nil {
				return ""
			}
			var obj map[string]any
			if json.Unmarshal(data, &obj) != nil {
				return ""
			}
			c, _ := obj["alibabaCookie"].(string)
			return c
		}),
	}}
}

func (a Alibaba) HasCredentials() bool { return a.chain().Resolve() != "" }

var secTokenRe = regexp.MustCompile(`sec[_-]?token["'\s:=]+([A-Za-z0-9_%\-]{16,})`)

func (a Alibaba) Fetch() []Limit {
	cookie := a.chain().Resolve()
	if cookie == "" || !strings.Contains(cookie, "=") {
		return nil
	}
	if strings.HasPrefix(strings.ToLower(cookie), "cookie:") {
		cookie = strings.TrimSpace(cookie[7:])
	}

	host := os.Getenv("ALIBABA_TOKEN_PLAN_HOST")
	if host == "" {
		host = "https://bailian-singapore-cs.alibabacloud.com"
	}
	dashboardOrigin := "https://modelstudio.console.alibabacloud.com"
	dashboardURL := dashboardOrigin + "/ap-southeast-1/?tab=plan#/efm/subscription/token-plan"
	usageAPI := "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"

	// sec_token: scrape the dashboard HTML for the CSRF-ish token.
	secToken := ""
	dashReq, err := http.NewRequest(http.MethodGet,
		strings.Replace(dashboardURL, "#/efm/subscription/token-plan", "", 1), nil)
	if err == nil {
		dashReq.Header.Set("Cookie", cookie)
		dashReq.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
		if data := PerformRaw(dashReq, "alibaba"); data != nil {
			if m := secTokenRe.FindSubmatch(data); len(m) > 1 {
				secToken = string(m[1])
			}
		}
	}

	cornerstone := map[string]any{
		"feTraceId": strings.ToLower(newUUIDLike()), "feURL": dashboardURL,
		"protocol": "V2", "console": "ONE_CONSOLE", "productCode": "p_efm",
		"switchUserType": 3, "domain": "modelstudio.console.alibabacloud.com",
		"consoleSite": "MODELSTUDIO_ALBABACLOUD", "userNickName": "",
		"userPrincipalName": "", "xsp_lang": "en-US",
	}
	if cna := CookieValue("cna", cookie); cna != "" {
		cornerstone["X-Anonymous-Id"] = cna
	}
	params, _ := json.Marshal(map[string]any{
		"Api": usageAPI, "V": "1.0",
		"Data": map[string]any{"cornerstoneParam": cornerstone},
	})

	form := url.Values{
		"product":  {"sfm_bailian"},
		"action":   {"IntlBroadScopeAspnGateway"},
		"region":   {"ap-southeast-1"},
		"language": {"en-US"},
		"params":   {string(params)},
	}
	if secToken != "" {
		form.Set("sec_token", secToken)
	}

	apiURL := fmt.Sprintf("%s/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=%s&_v=undefined",
		host, url.QueryEscape(usageAPI))
	newReq := func() *http.Request {
		req, err := http.NewRequest(http.MethodPost, apiURL, strings.NewReader(form.Encode()))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json, text/plain, */*")
		req.Header.Set("Cookie", cookie)
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
		req.Header.Set("Origin", dashboardOrigin)
		req.Header.Set("Referer", dashboardURL)
		if csrf := CookieValue("login_aliyunid_csrf", cookie); csrf != "" {
			req.Header.Set("x-xsrf-token", csrf)
			req.Header.Set("x-csrf-token", csrf)
		}
		return req
	}

	// Retry ×3: the gateway intermittently omits the 5h window at exhaustion.
	var out []Limit
	for attempt := 0; attempt < 3; attempt++ {
		req := newReq()
		if req == nil {
			return nil
		}
		data := PerformRaw(req, "alibaba")
		if data == nil {
			if attempt < 2 {
				time.Sleep(400 * time.Millisecond)
			}
			continue
		}
		var raw any
		if json.Unmarshal(data, &raw) != nil {
			if attempt < 2 {
				time.Sleep(400 * time.Millisecond)
			}
			continue
		}
		windows := FindDictContainingAny([]string{"per5HourPercentage", "per1WeekPercentage"}, raw, 0)
		if windows == nil {
			if attempt < 2 {
				time.Sleep(400 * time.Millisecond)
			}
			continue
		}
		if ratio, ok := Number(windows["per5HourPercentage"]); ok {
			pct := ratio
			if ratio <= 1 {
				pct = ratio * 100
			}
			out = append(out, Clamped("alibaba", "5h", pct, EpochUnix(windows["per5HourResetTime"]), "", ""))
		}
		if ratio, ok := Number(windows["per1WeekPercentage"]); ok {
			pct := ratio
			if ratio <= 1 {
				pct = ratio * 100
			}
			out = append(out, Clamped("alibaba", "weekly", pct, EpochUnix(windows["per1WeekResetTime"]), "", ""))
		}
		if len(out) > 0 {
			break
		}
	}
	return out
}

func newUUIDLike() string {
	// feTraceId only needs uniqueness, not the machine identity.
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid())
}

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
	for _, path := range core.KimiCredentialFiles() {
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
	obj := PerformJSON(req, "kimi")
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

func (k Kimi) Fetch() []Limit {
	profiles := ReadAllKimiCredentials()
	if len(profiles) == 0 {
		return nil
	}
	multi := len(profiles) > 1
	var out []Limit
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

func kimiFetchUsages(token, profile string) []Limit {
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
		if parsed := PerformJSON(req, "kimi"); parsed != nil {
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
func KimiRowsFromUsagesPayload(obj map[string]any, providerName string) []Limit {
	var limits []Limit
	if usage, _ := obj["usage"].(map[string]any); usage != nil {
		if limit, lok := Quota(usage, "limit"); lok {
			if used, uok := Quota(usage, "used"); uok {
				pct := 0.0
				if limit > 0 {
					pct = used / limit * 100
				}
				resetTime, _ := usage["resetTime"].(string)
				limits = append(limits, Clamped(providerName, "week", pct, ISOUnix(resetTime), "", ""))
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
			limit, lok := Quota(detail, "limit")
			remaining, rok := Quota(detail, "remaining")
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
			limits = append(limits, Clamped(providerName, label, pct, ISOUnix(resetTime), "", ""))
		}
	}
	// Fallback synthesis: when the gateway omits the limits[] window entry
	// (observed at window exhaustion), the usages.limit_5h / limit_7d
	// summary block still reports the window. used_ratio is a 0-1 fraction
	// (defensively accept 0-100).
	ratioPercent := func(w map[string]any) (float64, bool) {
		ratio, ok := Quota(w, "used_ratio")
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
	for _, l := range limits {
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
				limits = append(limits, Clamped(providerName, "week", pct, ISOUnix(resetTime), "", ""))
			}
		}
	}
	if !hasHourWindow {
		if w, _ := usages["limit_5h"].(map[string]any); w != nil {
			if pct, ok := ratioPercent(w); ok {
				resetTime, _ := w["reset_time"].(string)
				limits = append(limits, Clamped(providerName, "5h", pct, ISOUnix(resetTime), "", ""))
			}
		}
	}
	return limits
}

// ---- Plan registry (PlanLimitsEngine port) ----

// DefaultAdapters: one per vendor. UI / /limits / snapshot recording pick
// them all up via the registry.
func DefaultAdapters() []Adapter {
	return []Adapter{
		Zhipu{}, MiniMax{}, OpenCodeGo{}, Alibaba{},
		Gemini{}, Claude{}, DeepSeek{}, Codex{}, Kimi{},
	}
}

// Plan fans out over adapters with per-vendor last-good retention: a
// transient fetch failure must not blank the vendor's meters; credentials
// that stopped RESOLVING = deliberate (signed out) — rows drop immediately.
type Plan struct {
	Adapters []Adapter

	mu            sync.Mutex
	lastGood      map[string]lastGoodRows
	LastGoodGrace time.Duration
	now           func() time.Time
}

type lastGoodRows struct {
	rows []Limit
	at   time.Time
}

func NewPlan(adapters []Adapter) *Plan {
	return &Plan{Adapters: adapters, lastGood: map[string]lastGoodRows{},
		LastGoodGrace: 20 * time.Minute, now: time.Now}
}

func (p *Plan) FetchAll() []Limit {
	var out []Limit
	for _, adapter := range p.Adapters {
		rows := adapter.Fetch()
		if len(rows) > 0 {
			p.mu.Lock()
			p.lastGood[adapter.Provider()] = lastGoodRows{rows, p.now()}
			p.mu.Unlock()
			out = append(out, rows...)
			continue
		}
		if !adapter.HasCredentials() {
			// No credential → genuinely unconfigured/signed out.
			p.mu.Lock()
			delete(p.lastGood, adapter.Provider())
			p.mu.Unlock()
			continue
		}
		p.mu.Lock()
		stale, ok := p.lastGood[adapter.Provider()]
		p.mu.Unlock()
		if ok && p.now().Sub(stale.at) < p.LastGoodGrace {
			out = append(out, stale.rows...)
		}
	}
	return out
}
