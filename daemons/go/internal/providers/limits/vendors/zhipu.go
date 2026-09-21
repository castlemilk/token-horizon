package vendors

import (
	"fmt"
	"strings"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- Zhipu (GLM Coding Plan) ----
// GET https://api.z.ai/api/monitor/usage/quota/limit
// { data: { limits: [{ type, unit, number, percentage, remaining, nextResetTime }] } }

type Zhipu struct{}

func (Zhipu) Provider() string { return "glm" }
func (Zhipu) HasCredentials() bool {
	return auth.Chain{Sources: []auth.Source{auth.OpenCodeKey("zai-coding-plan"), auth.OpenCodeKey("zai")}}.Resolve() != ""
}

func (z Zhipu) Fetch() []limits.Limit {
	key := z.authChain().Resolve()
	if key == "" {
		return nil
	}
	obj := limits.GetJSON("https://api.z.ai/api/monitor/usage/quota/limit", key, z.Provider())
	data, _ := obj["data"].(map[string]any)
	rows, _ := data["limits"].([]any)
	var out []limits.Limit
	for _, raw := range rows {
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
		out = append(out, limits.Clamped("glm", label, pct, limits.EpochUnix(l["nextResetTime"]), detail, ""))
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
