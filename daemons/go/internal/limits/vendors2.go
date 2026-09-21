package limits

// Codex (ChatGPT subscription wham/usage), Gemini (CloudCode + agy language
// server), Alibaba (cookie handshake), Kimi (OAuth + usages payload).

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/auth"
)

func accountKeyFor(vendor, credential string) string {
	return usage.AccountKey(vendor, credential)
}

// ---- Codex / ChatGPT subscription ----
// GET https://chatgpt.com/backend-api/wham/usage
// { plan_type, rate_limit.primary_window {used_percent, limit_window_seconds,
//   reset_at}, additional_rate_limits [...] }

type Codex struct{}

func (Codex) Provider() string { return "codex" }

func codexToken() (string, map[string]any) {
	entry := auth.OpenCodeAuthEntry("openai")
	if entry == nil {
		return "", nil
	}
	for _, field := range []string{"access", "access_token", "accessToken", "key", "token"} {
		if token, ok := entry[field].(string); ok && token != "" {
			return token, entry
		}
	}
	return "", nil
}

func (Codex) HasCredentials() bool {
	token, _ := codexToken()
	return token != ""
}

// openaiAccountID: explicit entry field first, JWT payload fallback
// (https://api.openai.com/auth → chatgpt_account_id).
func openaiAccountID(entry map[string]any, token string) string {
	if entry != nil {
		for _, field := range []string{"accountId", "account_id", "chatgpt_account_id"} {
			if id, ok := entry[field].(string); ok && id != "" {
				return id
			}
		}
	}
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	b64 := strings.NewReplacer("-", "+", "_", "/").Replace(parts[1])
	for len(b64)%4 != 0 {
		b64 += "="
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		return ""
	}
	if authObj, _ := payload["https://api.openai.com/auth"].(map[string]any); authObj != nil {
		if id, _ := authObj["chatgpt_account_id"].(string); id != "" {
			return id
		}
	}
	return ""
}

func (Codex) Fetch() []Limit {
	token, entry := codexToken()
	if token == "" {
		return nil
	}
	acctHeader := openaiAccountID(entry, token)
	account := accountKeyFor("codex", token)
	req, err := http.NewRequest(http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if acctHeader != "" {
		req.Header.Set("ChatGPT-Account-ID", acctHeader)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
	req.Header.Set("Accept", "application/json")
	obj := PerformJSON(req, "codex")
	if obj == nil {
		return nil
	}
	var out []Limit
	for _, w := range codexWindows(obj, time.Now()) {
		out = append(out, Clamped("codex", w.label, w.usedPercent, w.resetsAt, w.detail, account))
	}
	return out
}

type codexWindow struct {
	label       string
	usedPercent float64
	resetsAt    *int64
	detail      string
}

// codexWindows: primary window + per-feature windows from a wham/usage
// payload (pure — unit-tested).
func codexWindows(obj map[string]any, now time.Time) []codexWindow {
	var out []codexWindow
	plan, _ := obj["plan_type"].(string)
	detail := ""
	if plan != "" {
		detail = plan + " plan"
	}
	if rl, _ := obj["rate_limit"].(map[string]any); rl != nil {
		if primary, _ := rl["primary_window"].(map[string]any); primary != nil {
			if pct, ok := Number(primary["used_percent"]); ok {
				out = append(out, codexWindow{codexWindowLabel(primary["limit_window_seconds"]),
					pct, codexResetDate(primary, now), detail})
			}
		}
	}
	if arr, _ := obj["additional_rate_limits"].([]any); arr != nil {
		for i, raw := range arr {
			if i >= 5 {
				break
			}
			entry, _ := raw.(map[string]any)
			rl, _ := entry["rate_limit"].(map[string]any)
			primary, _ := rl["primary_window"].(map[string]any)
			pct, ok := Number(primary["used_percent"])
			if !ok {
				continue
			}
			name, _ := entry["limit_name"].(string)
			if name == "" {
				name, _ = entry["metered_feature"].(string)
			}
			if name == "" {
				name = "extra"
			}
			out = append(out, codexWindow{codexWindowLabel(primary["limit_window_seconds"]) + " · " + name,
				pct, codexResetDate(primary, now), detail})
		}
	}
	return out
}

// 604800 → "weekly", 18000 → "5h", else Nd/Nh/Nm.
func codexWindowLabel(seconds any) string {
	s, ok := Number(seconds)
	if !ok || s <= 0 {
		return "window"
	}
	sec := int64(s)
	if sec%86400 == 0 {
		if sec == 604800 {
			return "weekly"
		}
		return fmt.Sprintf("%dd", sec/86400)
	}
	if sec%3600 == 0 {
		return fmt.Sprintf("%dh", sec/3600)
	}
	m := sec / 60
	if m < 1 {
		m = 1
	}
	return fmt.Sprintf("%dm", m)
}

// reset_at epoch wins; reset_after_seconds counts from now.
func codexResetDate(window map[string]any, now time.Time) *int64 {
	switch ts := window["reset_at"].(type) {
	case float64:
		u := int64(ts)
		return &u
	case string:
		if f, err := parseFloat(ts); err == nil {
			u := int64(f)
			return &u
		}
	}
	if after, ok := Number(window["reset_after_seconds"]); ok {
		u := now.Add(time.Duration(after) * time.Second).Unix()
		return &u
	}
	return nil
}

func parseFloat(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%g", &f)
	return f, err
}

// ---- Gemini (CloudCode + Antigravity language server) ----

type Gemini struct{ LsofPath string } // LsofPath overrides agy discovery (tests)

func (Gemini) Provider() string { return "google" }

var geminiCredsPath = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".gemini/oauth_creds.json")
}

func (g Gemini) chain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{
		auth.FileJSON(geminiCredsPath(), "access_token"),
		auth.KeychainBase64JSON("gemini", "antigravity", "access_token"),
	}}
}

func (g Gemini) HasCredentials() bool { return g.chain().Resolve() != "" }

func (g Gemini) credentials() []auth.LabeledCredential {
	home, _ := os.UserHomeDir()
	var dirs []string
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), ".gemini") {
			dirs = append(dirs, filepath.Join(home, e.Name()))
		}
	}
	if len(dirs) == 0 {
		dirs = []string{filepath.Join(home, ".gemini")}
	}
	var out []auth.LabeledCredential
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, "oauth_creds.json"))
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		if token, _ := obj["access_token"].(string); token != "" {
			label := ""
			if len(dirs) > 1 {
				label = strings.TrimPrefix(filepath.Base(dir), ".")
			}
			out = append(out, auth.LabeledCredential{Label: label, Credential: token})
		}
	}
	if len(out) == 0 {
		if token := g.chain().Resolve(); token != "" {
			out = append(out, auth.LabeledCredential{Credential: token})
		}
	}
	return out
}

func (g Gemini) Fetch() []Limit {
	if agy := g.fetchAgyLanguageServerLimits(); len(agy) > 0 {
		return agy
	}
	creds := g.credentials()
	if len(creds) == 0 {
		return nil
	}
	var out []Limit
	for i, cred := range creds {
		if i > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		out = append(out, g.fetchCloudCode(cred.Credential)...)
	}
	return out
}

func (g Gemini) projectID() string {
	data, err := os.ReadFile(geminiCredsPath())
	if err != nil {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return ""
	}
	id, _ := obj["project_id"].(string)
	return id
}

func (g Gemini) fetchCloudCode(token string) []Limit {
	obj := PostJSON("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		token, "google", map[string]any{"project": g.projectID()})
	buckets, _ := obj["buckets"].([]any)
	var out []Limit
	for _, raw := range buckets {
		bucket, _ := raw.(map[string]any)
		remaining, ok := Number(bucket["remainingFraction"])
		if !ok {
			continue
		}
		used := (1 - remaining) * 100
		model, _ := bucket["modelId"].(string)
		if model == "" {
			model, _ = bucket["tokenType"].(string)
		}
		if model == "" {
			model = "gemini"
		}
		reset, _ := bucket["resetTime"].(string)
		out = append(out, Clamped("gemini", model, used, ISOUnix(reset), "", ""))
	}
	return out
}

// Antigravity (agy) language server on loopback: discover listen ports via
// lsof, POST RetrieveUserQuotaSummary.
var agyPortRe = regexp.MustCompile(`127\.0\.0\.1:(\d+)`)

func (g Gemini) discoverAgyPorts() []int {
	lsof := g.LsofPath
	if lsof == "" {
		lsof = "lsof"
	}
	out, err := execCommand(lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-c", "agy", "-a", "-i4")
	if err != nil {
		return nil
	}
	var ports []int
	seen := map[int]bool{}
	for _, m := range agyPortRe.FindAllStringSubmatch(out, -1) {
		var p int
		fmt.Sscanf(m[1], "%d", &p)
		if p > 0 && !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}
	return ports
}

func (g Gemini) fetchAgyLanguageServerLimits() []Limit {
	for _, port := range g.discoverAgyPorts() {
		req, err := http.NewRequest(http.MethodPost,
			fmt.Sprintf("http://127.0.0.1:%d/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", port),
			strings.NewReader("{}"))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		data := PerformRaw(req, "agy")
		if data == nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		resp, _ := obj["response"].(map[string]any)
		groups, _ := resp["groups"].([]any)
		if len(groups) == 0 {
			continue
		}
		var out []Limit
		for _, rawG := range groups {
			gr, _ := rawG.(map[string]any)
			gname, _ := gr["displayName"].(string)
			lower := strings.ToLower(gname)
			prefix := lower
			if strings.Contains(lower, "gemini") {
				prefix = "gemini"
			} else if strings.Contains(lower, "claude") || strings.Contains(lower, "gpt") {
				prefix = "3p"
			}
			buckets, _ := gr["buckets"].([]any)
			for _, rawB := range buckets {
				b, _ := rawB.(map[string]any)
				rem := numOr(b["remainingFraction"], 1.0)
				used := (1.0 - rem) * 100.0
				if used < 0 {
					used = 0
				}
				if used > 100 {
					used = 100
				}
				window, _ := b["window"].(string)
				if window == "" {
					window, _ = b["bucketId"].(string)
				}
				if window == "" {
					window = "quota"
				}
				reset, _ := b["resetTime"].(string)
				out = append(out, Clamped("agy", prefix+" "+window,
					float64(int(used*10+0.5))/10, ISOUnix(reset),
					fmt.Sprintf("%d%% left", int(rem*100+0.5)), ""))
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}
