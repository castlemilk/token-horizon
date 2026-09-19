package ingest

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store/testfake"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
)

func testEnv() Envelope {
	return Envelope{MachineID: "m-1", MachineAlias: "devbox", Handle: "Wockhardt", Team: "core", Platform: "Linux"}
}

func testEvent(id string) usage.UsageEvent {
	return usage.UsageEvent{
		ID: id, Timestamp: time.Now().UTC(), Source: "external",
		Vendor: "kimi", Model: "k3", Tokens: usage.TokenBreakdown{Input: 100, Output: 20},
		Attestation: "measured",
	}
}

func TestEventsCreatesUserAndMachine(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	res, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{testEvent("e-1")})
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted != 1 || res.Duplicates != 0 {
		t.Fatalf("accepted=%d dups=%d", res.Accepted, res.Duplicates)
	}
	if res.User.Handle != "wockhardt" { // normalized
		t.Fatalf("handle=%q", res.User.Handle)
	}
	if res.Machine.MachineID != "m-1" || res.Machine.UserID != res.User.ID {
		t.Fatalf("machine not homed: %+v", res.Machine)
	}
	if len(fake.Events) != 1 {
		t.Fatalf("stored=%d", len(fake.Events))
	}
}

func TestEventsIdempotentRedelivery(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	if _, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	res, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{testEvent("e-1")})
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted != 0 || res.Duplicates != 1 {
		t.Fatalf("accepted=%d dups=%d", res.Accepted, res.Duplicates)
	}
}

func TestEventsRejectsBadEnvelopeAndRows(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	bad := testEnv()
	bad.MachineID = ""
	if _, err := ing.Events(context.Background(), bad, nil); err == nil {
		t.Fatal("expected envelope error")
	}
	ev := testEvent("e-2")
	ev.Vendor = ""
	if _, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{ev}); err == nil {
		t.Fatal("expected row error")
	}
	huge := make([]usage.UsageEvent, MaxEventsBatch+1)
	if _, err := ing.Events(context.Background(), testEnv(), huge); err == nil {
		t.Fatal("expected batch cap error")
	}
}

func TestLimitsStoredAgainstUser(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	sn := usage.LimitSnapshot{RecordedAt: time.Now().UTC(), Provider: "kimi", Label: "5h", UsedPercent: 48}
	res, err := ing.Limits(context.Background(), testEnv(), []usage.LimitSnapshot{sn})
	if err != nil {
		t.Fatal(err)
	}
	if res.Accepted != 1 {
		t.Fatalf("accepted=%d", res.Accepted)
	}
	if len(fake.Limits) != 1 || fake.Limits[0].MachineID != "m-1" || fake.Limits[0].ID == "" {
		t.Fatalf("bad stored snap: %+v", fake.Limits)
	}
}

func TestMachineRehomedOnHandleMove(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	if _, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	moved := testEnv()
	moved.Handle = "newhire"
	if _, err := ing.Events(context.Background(), moved, []usage.UsageEvent{testEvent("e-2")}); err != nil {
		t.Fatal(err)
	}
	m, _ := fake.MachineByID(context.Background(), "m-1")
	second, _ := fake.ResolveUser(context.Background(), "newhire", "newhire", "")
	if m.UserID != second.ID {
		t.Fatalf("machine did not follow handle: %q vs %q", m.UserID, second.ID)
	}
	if !strings.Contains(m.UserID, "newhire") {
		t.Fatalf("unexpected user %q", m.UserID)
	}
}

func TestBlankAliasNeverClobbers(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	if _, err := ing.Events(context.Background(), testEnv(), []usage.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	thin := testEnv()
	thin.MachineAlias, thin.Platform = "", ""
	if _, err := ing.Events(context.Background(), thin, []usage.UsageEvent{testEvent("e-2")}); err != nil {
		t.Fatal(err)
	}
	m, _ := fake.MachineByID(context.Background(), "m-1")
	if m.Alias != "devbox" || m.Platform != "Linux" {
		t.Fatalf("clobbered: %+v", m)
	}
}

func TestIngestPinsUserByUUID(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	ctx := context.Background()

	// A signed-in daemon carries the user UUID from the auth claim: rows
	// attribute to that exact account, no handle resolution involved.
	u, _ := fake.ResolveUser(ctx, "ada", "Ada", "")
	env := Envelope{MachineID: "m-9", MachineAlias: "laptop", UserID: u.ID, Platform: "macOS"}
	ev := testEvent("e-uuid-1")
	res, err := ing.Events(ctx, env, []usage.UsageEvent{ev})
	if err != nil {
		t.Fatal(err)
	}
	if res.User.ID != u.ID {
		t.Fatalf("user=%+v", res.User)
	}
	if res.Machine.UserID != u.ID {
		t.Fatalf("machine=%+v", res.Machine)
	}

	// Unknown UUIDs are rejected, not silently re-homed.
	env.UserID = "00000000-0000-4000-8000-000000000000"
	if _, err := ing.Events(ctx, env, []usage.UsageEvent{testEvent("e-uuid-2")}); err == nil {
		t.Fatal("expected unknown user_id error")
	}

	// And the UUID alone is a sufficient envelope (handle may be blank).
	env = Envelope{MachineID: "m-10", MachineAlias: "desktop", UserID: u.ID}
	if _, err := ing.Events(ctx, env, []usage.UsageEvent{testEvent("e-uuid-3")}); err != nil {
		t.Fatal(err)
	}
}
