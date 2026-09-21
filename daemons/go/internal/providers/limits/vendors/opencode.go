package vendors

import (
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- OpenCode Go (Zen) ----
// GET https://opencode.ai/zen/go/v1/usage
// { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }

type OpenCodeGo struct{}

func (OpenCodeGo) Provider() string { return "opencode-go" }
func (OpenCodeGo) HasCredentials() bool {
	return auth.OpenCodeKey("opencode-go").Resolve() != ""
}

func (o OpenCodeGo) Fetch() []limits.Limit {
	key := auth.OpenCodeKey("opencode-go").Resolve()
	if key == "" {
		return nil
	}
	obj := limits.GetJSON("https://opencode.ai/zen/go/v1/usage", key, o.Provider())
	usage, _ := obj["usage"].(map[string]any)
	var out []limits.Limit
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
		out = append(out, limits.Clamped("opencode-go", window, pct, limits.ISOUnix(resetsAt), detail, ""))
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
