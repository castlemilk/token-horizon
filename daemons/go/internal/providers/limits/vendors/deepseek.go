package vendors

import (
	"fmt"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- DeepSeek Platform balance ----
// GET https://api.deepseek.com/user/balance

type DeepSeek struct{}

func (DeepSeek) Provider() string { return "deepseek" }
func (d DeepSeek) chain() auth.Chain {
	return auth.Chain{Sources: []auth.Source{auth.OpenCodeKey("deepseek"), auth.Env("DEEPSEEK_API_KEY")}}
}
func (d DeepSeek) HasCredentials() bool { return d.chain().Resolve() != "" }

func (d DeepSeek) Fetch() []limits.Limit {
	key := d.chain().Resolve()
	if key == "" {
		return nil
	}
	obj := limits.GetJSON("https://api.deepseek.com/user/balance", key, d.Provider())
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
	return []limits.Limit{limits.Clamped("deepseek", "balance", 0, nil, "$"+total+" "+curr, "")}
}
