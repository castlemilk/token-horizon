package sync

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/interfaces/store/testfake"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
	"github.com/castlemilk/token-horizon/server/src/use_cases/ingest"
)

func TestSyncPlanDeltaOnly(t *testing.T) {
	fake := testfake.New()
	ing := ingest.Ingest{Store: fake}
	s := Sync{Store: fake}
	ctx := context.Background()

	env := ingest.Envelope{MachineID: "m-1", MachineAlias: "devbox", Handle: "ada", Platform: "Linux"}
	mk := func(id string) usage.UsageEvent {
		return usage.UsageEvent{
			ID: id, Timestamp: time.Now().UTC(), Source: "external", Vendor: "kimi",
			Model: "k3", Tokens: usage.TokenBreakdown{Input: 10}, Attestation: "measured",
		}
	}
	if _, err := ing.Events(ctx, env, []usage.UsageEvent{mk("e-1"), mk("e-2")}); err != nil {
		t.Fatal(err)
	}

	// The daemon's local table holds e-1, e-2, e-3 — plan must flag only e-3.
	plan, err := s.PlanRows(ctx, "m-1", store.DatasetUsageEvents, []string{"e-1", "e-2", "e-3"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Known != 2 || len(plan.Missing) != 1 || plan.Missing[0] != "e-3" {
		t.Fatalf("plan=%+v", plan)
	}

	// Push the delta; a re-plan over the full local set reports no missing.
	if _, err := ing.Events(ctx, env, []usage.UsageEvent{mk("e-3")}); err != nil {
		t.Fatal(err)
	}
	plan, err = s.PlanRows(ctx, "m-1", store.DatasetUsageEvents, []string{"e-1", "e-2", "e-3"})
	if err != nil || len(plan.Missing) != 0 || plan.Known != 3 {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}

	// Limits dedup keys plan the same way.
	snap := usage.LimitSnapshot{
		RecordedAt: time.Now().UTC(), Provider: "kimi", Label: "5h", UsedPercent: 42,
	}
	if _, err := ing.Limits(ctx, env, []usage.LimitSnapshot{snap}); err != nil {
		t.Fatal(err)
	}
	snap.MachineID = "m-1" // ingest stamps the envelope's machine
	plan, err = s.PlanRows(ctx, "m-1", store.DatasetLimitSnapshots,
		[]string{snap.DedupKey(), "m-1|kimi||5h|2999-01-01T00:00:00Z"})
	if err != nil || plan.Known != 1 || len(plan.Missing) != 1 {
		t.Fatalf("limits plan=%+v err=%v", plan, err)
	}

	// Status exposes reference counts.
	st, err := s.Status(ctx, "m-1")
	if err != nil || st.KnownEvents != 3 || st.KnownLimits != 1 {
		t.Fatalf("status=%+v err=%v", st, err)
	}

	if _, err := s.PlanRows(ctx, "m-1", "bogus", []string{"x"}); err == nil {
		t.Fatal("expected dataset error")
	}
	if _, err := s.PlanRows(ctx, "", store.DatasetUsageEvents, nil); err == nil {
		t.Fatal("expected machine_id error")
	}
}

func TestSummaryValidation(t *testing.T) {
	fake := testfake.New()
	s := Sync{Store: fake}
	if _, err := s.Summary(context.Background(), "", "", "", time.Time{}); err == nil {
		t.Fatal("expected scope error")
	}
	if _, err := s.Summary(context.Background(), "wockhardt", "", "", time.Now().Add(48*time.Hour)); err == nil {
		t.Fatal("expected future error")
	}
}
