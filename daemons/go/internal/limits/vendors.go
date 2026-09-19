package limits

// Per-vendor quota adapters (Providers/<Vendor>/*Limits.swift ports).
// One Fetch() per vendor; auth chains come from internal/auth. Registered
// in DefaultAdapters(); the Plan registry supplies caching, refresh,
// last-good retention and snapshot recording.

import (
	"encoding/json"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/auth"
)

func configPath(name string) string { return filepath.Join(platform.ConfigDir(), name) }

// ---- Zhipu (GLM Coding Plan) ----
// GET https://api.z.ai/api/monitor/usage/quota/limit
// { data: { limits: [{ type, unit, number, percentage, remaining, nextResetTime }] } }

type Zhipu struct{}

func (Zhipu) Provider() string { return "glm" }
func (Zhipu) HasCredentials() bool {
	return auth.Chain{Sources: []auth.Source{auth.OpenCodeKey("zai-coding-plan"), auth.OpenCodeKey("zai")}}.Resolve() != ""
}

func (z Zhipu) Fetch() []Limit {
	key := z.authChain().Resolve()
	if key == "" {
		return nil
	}
	obj := GetJSON("https://api.z.ai/api/monitor/usage/quota/limit", key, z.Provider())
	data, _ := obj["data"].(map[string]any)
	limits, _ := data["limits"].([]any)
	var out []Limit
	for _, raw := range limits {
		l, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		pct, ok := l["percentage"].(float64)
		if !ok {
			continue
		}
		typ, _ := l["type"].(string)
		unit := int(numOr(l["unit"], 0))
		number := int(numOr(l["number"], 1))
		var label string
		switch {
		case typ == "TOKENS_LIMIT" && unit == 3:
			label = fmt.Sprintf("%dh", number)
		case typ == "TOKENS_LIMIT" && unit == 6:
			if number > 1 {
				label = fmt.Sprintf("%dmo", number)
			} else {
				label = "monthly"
			}
		case typ == "TOKENS_LIMIT" && unit == 5:
			if number > 1 {
				label = fmt.Sprintf("%dw", number)
			} else {
				label = "weekly"
			}
		case typ == "TOKENS_LIMIT" && unit == 4:
			if number > 1 {
				label = fmt.Sprintf("%dd", number)
			} else {
				label = "daily"
			}
		case typ == "TIME_LIMIT":
			label = "search"
		default:
			label = strings.ToLower(strings.ReplaceAll(typ, "_LIMIT", ""))
		}
		detail := ""
		if remaining, ok := l["remaining"].(float64); ok {
			detail = fmt.Sprintf("%.0f left", remaining)
		}
		out = append(out, Clamped("glm", label, pct, EpochUnix(l["nextResetTime"]), detail, ""))
	}
	return out
}

func (z Zhipu) authChain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{auth.OpenCodeKey("zai-coding-plan"), auth.OpenCodeKey("zai")}}
}

func numOr(v any, def float64) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return def
}

// ---- MiniMax Token Plan ----
// GET https://www.minimax.io/v1/token_plan/remains
// { model_remains: [{ current_interval_remaining_percent, end_time, ... }] }

type MiniMax struct{}

func (MiniMax) Provider() string { return "minimax" }
func (MiniMax) HasCredentials() bool {
	return auth.OpenCodeKey("minimax-coding-plan").Resolve() != ""
}

func (m MiniMax) Fetch() []Limit {
	key := auth.OpenCodeKey("minimax-coding-plan").Resolve()
	if key == "" {
		return nil
	}
	obj := GetJSON("https://www.minimax.io/v1/token_plan/remains", key, m.Provider())
	remains, _ := obj["model_remains"].([]any)
	if len(remains) == 0 {
		return nil
	}
	var out []Limit
	first, _ := remains[0].(map[string]any)
	if remaining, ok := Number(first["current_interval_remaining_percent"]); ok {
		out = append(out, Clamped("minimax", "interval", 100-remaining, EpochUnix(first["end_time"]), "", ""))
	}
	if remaining, ok := Number(first["current_weekly_remaining_percent"]); ok {
		out = append(out, Clamped("minimax", "weekly", 100-remaining, EpochUnix(first["weekly_end_time"]), "", ""))
	}
	for _, raw := range remains[1:min(5, len(remains))] {
		extra, _ := raw.(map[string]any)
		remaining, ok := Number(extra["current_interval_remaining_percent"])
		if !ok {
			continue
		}
		name, _ := extra["model"].(string)
		if name == "" {
			name = fmt.Sprintf("model-%d", len(out))
		}
		out = append(out, Clamped("minimax", "interval · "+name, 100-remaining, EpochUnix(extra["end_time"]), "", ""))
	}
	return out
}

// ---- OpenCode Go (Zen) ----
// GET https://opencode.ai/zen/go/v1/usage
// { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }

type OpenCodeGo struct{}

func (OpenCodeGo) Provider() string { return "opencode-go" }
func (OpenCodeGo) HasCredentials() bool {
	return auth.OpenCodeKey("opencode-go").Resolve() != ""
}

func (o OpenCodeGo) Fetch() []Limit {
	key := auth.OpenCodeKey("opencode-go").Resolve()
	if key == "" {
		return nil
	}
	obj := GetJSON("https://opencode.ai/zen/go/v1/usage", key, o.Provider())
	usage, _ := obj["usage"].(map[string]any)
	var out []Limit
	for _, window := range sortedKeys(usage) {
		metric, _ := usage[window].(map[string]any)
		pct, ok := metric["percent"].(float64)
		if !ok {
			continue
		}
		detail := ""
		if status, _ := metric["status"].(string); status == "rate-limited" {
			detail = "rate-limited"
		}
		resetsAt, _ := metric["resetsAt"].(string)
		out = append(out, Clamped("opencode-go", window, pct, ISOUnix(resetsAt), detail, ""))
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// ---- DeepSeek Platform balance ----
// GET https://api.deepseek.com/user/balance

type DeepSeek struct{}

func (DeepSeek) Provider() string { return "deepseek" }
func (d DeepSeek) chain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{auth.OpenCodeKey("deepseek"), auth.Env("DEEPSEEK_API_KEY")}}
}
func (d DeepSeek) HasCredentials() bool { return d.chain().Resolve() != "" }

func (d DeepSeek) Fetch() []Limit {
	key := d.chain().Resolve()
	if key == "" {
		return nil
	}
	obj := GetJSON("https://api.deepseek.com/user/balance", key, d.Provider())
	if avail, _ := obj["is_available"].(bool); !avail {
		return nil
	}
	infos, _ := obj["balance_infos"].([]any)
	if len(infos) == 0 {
		return nil
	}
	first, _ := infos[0].(map[string]any)
	total, _ := first["total_balance"].(string)
	if total == "" {
		if n, ok := first["total_balance"].(float64); ok {
			total = fmt.Sprintf("%v", n)
		}
	}
	curr, _ := first["currency"].(string)
	if curr == "" {
		curr = "USD"
	}
	return []Limit{Clamped("deepseek", "balance", 0, nil, "$"+total+" "+curr, "")}
}

// ---- Claude (Claude Code OAuth) ----
// GET https://api.anthropic.com/api/oauth/usage
// { five_hour: {utilization, resets_at}, seven_day: {...}, limits: [weekly_scoped...] }

type Claude struct{ ConfigDir string }

func (Claude) Provider() string { return "claude" }

var claudeKeyPaths = []string{"claudeAiOauth.accessToken", "oauth.accessToken", "accessToken"}

func (c Claude) configDir() string {
	if c.ConfigDir != "" {
		return c.ConfigDir
	}
	raw := os.Getenv("CLAUDE_CONFIG_DIR")
	if raw == "" {
		raw = "~/.claude"
	}
	return auth.Expand(raw)
}

func (c Claude) chain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{
		auth.FileJSON(filepath.Join(c.configDir(), ".credentials.json"), claudeKeyPaths...),
		auth.Keychain("Claude Code-credentials", claudeKeyPaths...),
	}}
}

func (c Claude) HasCredentials() bool { return c.chain().Resolve() != "" }

// credentials: every ~/.claude* variant dir holding .credentials.json is one
// profile (multi-account); Keychain is the fallback single profile.
func (c Claude) credentials() []auth.LabeledCredential {
	home, _ := os.UserHomeDir()
	var dirs []string
	if env := os.Getenv("CLAUDE_CONFIG_DIR"); env != "" {
		dirs = []string{auth.Expand(env)}
	} else {
		entries, _ := os.ReadDir(home)
		for _, e := range entries {
			if e.IsDir() && strings.HasPrefix(e.Name(), ".claude") {
				dirs = append(dirs, filepath.Join(home, e.Name()))
			}
		}
		if len(dirs) == 0 {
			dirs = []string{filepath.Join(home, ".claude")}
		}
	}
	var out []auth.LabeledCredential
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, ".credentials.json"))
		if err != nil {
			continue
		}
		var obj any
		if json.Unmarshal(data, &obj) != nil {
			continue
		}
		for _, kp := range claudeKeyPaths {
			if token := auth.Walk(obj, kp); token != "" {
				label := ""
				if len(dirs) > 1 {
					label = strings.TrimPrefix(filepath.Base(dir), ".")
				}
				out = append(out, auth.LabeledCredential{Label: label, Credential: token})
				break
			}
		}
	}
	if len(out) == 0 {
		if token := c.chain().Resolve(); token != "" {
			out = append(out, auth.LabeledCredential{Credential: token})
		}
	}
	return out
}

func (c Claude) Fetch() []Limit {
	creds := c.credentials()
	if len(creds) == 0 {
		return nil
	}
	multi := len(creds) > 1
	var out []Limit
	for i, cred := range creds {
		if i > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		name := "claude"
		if multi && cred.Label != "" {
			name = "claude (" + cred.Label + ")"
		}
		out = append(out, c.fetchWindows(cred.Credential, name)...)
	}
	return out
}

func (c Claude) fetchWindows(token, providerName string) []Limit {
	account := accountKeyFor("claude", token)
	req, err := http.NewRequest(http.MethodGet, "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Accept", "application/json")
	obj := PerformJSON(req, "claude")
	if obj == nil {
		return nil
	}
	var out []Limit
	for _, w := range [][2]string{{"five_hour", "5h"}, {"seven_day", "weekly"}, {"seven_day_oauth_apps", "apps 7d"}} {
		window, _ := obj[w[0]].(map[string]any)
		if window == nil {
			continue
		}
		pct, ok := Number(window["utilization"])
		if !ok {
			pct, ok = Number(window["used_percent"])
		}
		if !ok {
			pct, ok = Number(window["usedPercent"])
		}
		if !ok {
			continue
		}
		var resetsAt *int64
		switch ts := window["resets_at"].(type) {
		case string:
			resetsAt = ISOUnix(ts)
		case float64:
			resetsAt = EpochUnix(ts)
		}
		out = append(out, Clamped(providerName, w[1], pct, resetsAt, "", account))
	}
	if entries, ok := obj["limits"].([]any); ok {
		for _, raw := range entries {
			entry, _ := raw.(map[string]any)
			if entry["kind"] != "weekly_scoped" {
				continue
			}
			model := "scoped"
			if scope, _ := entry["scope"].(map[string]any); scope != nil {
				if m, _ := scope["model"].(map[string]any); m != nil {
					if dn, _ := m["display_name"].(string); dn != "" {
						model = dn
					}
				}
			}
			if pct, ok := Number(entry["utilization"]); ok {
				resetsAt, _ := entry["resets_at"].(string)
				out = append(out, Clamped(providerName, "weekly · "+model, pct, ISOUnix(resetsAt), "", account))
			}
		}
	}
	return out
}
