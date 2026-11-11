package vendors

import "testing"

// Z.ai's percentage is the used share (currentValue / usage), not the
// remaining share. A 30 must read as 30% used.
func TestZhipuPercentageIsUsedPercent(t *testing.T) {
	obj := map[string]any{"data": map[string]any{"limits": []any{
		map[string]any{"type": "TOKENS_LIMIT", "unit": float64(3), "number": float64(5),
			"percentage": float64(30), "remaining": float64(14000)},
		map[string]any{"type": "TOKENS_LIMIT", "unit": float64(6), "number": float64(1),
			"percentage": float64(100)},
	}}}
	rows := zhipuLimits(obj)
	if len(rows) != 2 {
		t.Fatalf("rows: %+v", rows)
	}
	if rows[0].Label != "5h" || rows[0].UsedPercent != 30 {
		t.Fatalf("5h row: %+v", rows[0])
	}
	if rows[0].Detail != "14000 left" {
		t.Fatalf("5h detail: %q", rows[0].Detail)
	}
	if rows[1].Label != "monthly" || rows[1].UsedPercent != 100 {
		t.Fatalf("monthly row: %+v", rows[1])
	}
}
