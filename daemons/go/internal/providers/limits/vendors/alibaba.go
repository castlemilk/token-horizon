package vendors

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
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
			data, err := os.ReadFile(filepath.Join(platform.ConfigDir(), "settings.json"))
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

func (a Alibaba) Fetch() []limits.Limit {
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
		if data := limits.PerformRaw(dashReq, "alibaba"); data != nil {
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
	if cna := limits.CookieValue("cna", cookie); cna != "" {
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
		if csrf := limits.CookieValue("login_aliyunid_csrf", cookie); csrf != "" {
			req.Header.Set("x-xsrf-token", csrf)
			req.Header.Set("x-csrf-token", csrf)
		}
		return req
	}

	// Retry ×3: the gateway intermittently omits the 5h window at exhaustion.
	var out []limits.Limit
	for attempt := 0; attempt < 3; attempt++ {
		req := newReq()
		if req == nil {
			return nil
		}
		data := limits.PerformRaw(req, "alibaba")
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
		windows := limits.FindDictContainingAny([]string{"per5HourPercentage", "per1WeekPercentage"}, raw, 0)
		if windows == nil {
			if attempt < 2 {
				time.Sleep(400 * time.Millisecond)
			}
			continue
		}
		if ratio, ok := limits.Number(windows["per5HourPercentage"]); ok {
			pct := ratio
			if ratio <= 1 {
				pct = ratio * 100
			}
			out = append(out, limits.Clamped("alibaba", "5h", pct, limits.EpochUnix(windows["per5HourResetTime"]), "", ""))
		}
		if ratio, ok := limits.Number(windows["per1WeekPercentage"]); ok {
			pct := ratio
			if ratio <= 1 {
				pct = ratio * 100
			}
			out = append(out, limits.Clamped("alibaba", "weekly", pct, limits.EpochUnix(windows["per1WeekResetTime"]), "", ""))
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
