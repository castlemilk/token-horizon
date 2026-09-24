package vendors

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

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

func (Codex) Fetch() []limits.Limit {
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
	obj := limits.PerformJSON(req, "codex")
	if obj == nil {
		return nil
	}
	var out []limits.Limit
	for _, w := range codexWindows(obj, time.Now()) {
		out = append(out, limits.Clamped("codex", w.label, w.usedPercent, w.resetsAt, w.detail, account))
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
			if pct, ok := limits.Number(primary["used_percent"]); ok {
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
			pct, ok := limits.Number(primary["used_percent"])
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
	s, ok := limits.Number(seconds)
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
	if after, ok := limits.Number(window["reset_after_seconds"]); ok {
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
