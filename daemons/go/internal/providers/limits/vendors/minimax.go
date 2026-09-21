package vendors

import (
	"fmt"

	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/auth"
	"github.com/castlemilk/token-horizon/daemons/go/internal/providers/limits"
)

// ---- MiniMax Token Plan ----
// GET https://www.minimax.io/v1/token_plan/remains
// { model_remains: [{ current_interval_remaining_percent, end_time, ... }] }

type MiniMax struct{}

func (MiniMax) Provider() string { return "minimax" }
func (MiniMax) HasCredentials() bool {
	return auth.OpenCodeKey("minimax-coding-plan").Resolve() != ""
}

func (m MiniMax) Fetch() []limits.Limit {
	key := auth.OpenCodeKey("minimax-coding-plan").Resolve()
	if key == "" {
		return nil
	}
	obj := limits.GetJSON("https://www.minimax.io/v1/token_plan/remains", key, m.Provider())
	remains, _ := obj["model_remains"].([]any)
	if len(remains) == 0 {
		return nil
	}
	var out []limits.Limit
	first, _ := remains[0].(map[string]any)
	if remaining, ok := limits.Number(first["current_interval_remaining_percent"]); ok {
		out = append(out, limits.Clamped("minimax", "interval", 100-remaining, limits.EpochUnix(first["end_time"]), "", ""))
	}
	if remaining, ok := limits.Number(first["current_weekly_remaining_percent"]); ok {
		out = append(out, limits.Clamped("minimax", "weekly", 100-remaining, limits.EpochUnix(first["weekly_end_time"]), "", ""))
	}
	for _, raw := range remains[1:min(5, len(remains))] {
		extra, _ := raw.(map[string]any)
		remaining, ok := limits.Number(extra["current_interval_remaining_percent"])
		if !ok {
			continue
		}
		name, _ := extra["model"].(string)
		if name == "" {
			name = fmt.Sprintf("model-%d", len(out))
		}
		out = append(out, limits.Clamped("minimax", "interval · "+name, 100-remaining, limits.EpochUnix(extra["end_time"]), "", ""))
	}
	return out
}
