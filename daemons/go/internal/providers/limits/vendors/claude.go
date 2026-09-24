package vendors

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

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

func (c Claude) Fetch() []limits.Limit {
	creds := c.credentials()
	if len(creds) == 0 {
		return nil
	}
	multi := len(creds) > 1
	var out []limits.Limit
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

func (c Claude) fetchWindows(token, providerName string) []limits.Limit {
	account := accountKeyFor("claude", token)
	req, err := http.NewRequest(http.MethodGet, "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Accept", "application/json")
	obj := limits.PerformJSON(req, "claude")
	if obj == nil {
		return nil
	}
	var out []limits.Limit
	for _, w := range [][2]string{{"five_hour", "5h"}, {"seven_day", "weekly"}, {"seven_day_oauth_apps", "apps 7d"}} {
		window, _ := obj[w[0]].(map[string]any)
		if window == nil {
			continue
		}
		pct, ok := limits.Number(window["utilization"])
		if !ok {
			pct, ok = limits.Number(window["used_percent"])
		}
		if !ok {
			pct, ok = limits.Number(window["usedPercent"])
		}
		if !ok {
			continue
		}
		var resetsAt *int64
		switch ts := window["resets_at"].(type) {
		case string:
			resetsAt = limits.ISOUnix(ts)
		case float64:
			resetsAt = limits.EpochUnix(ts)
		}
		out = append(out, limits.Clamped(providerName, w[1], pct, resetsAt, "", account))
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
			if pct, ok := limits.Number(entry["utilization"]); ok {
				resetsAt, _ := entry["resets_at"].(string)
				out = append(out, limits.Clamped(providerName, "weekly · "+model, pct, limits.ISOUnix(resetsAt), "", account))
			}
		}
	}
	return out
}
