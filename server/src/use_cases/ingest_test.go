package usecases

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models"
	"github.com/castlemilk/token-horizon/server/src/testfake"
)

func testEnv() Envelope {
	return Envelope{MachineID: "m-1", MachineAlias: "devbox", Handle: "Wockhardt", Team: "core", Platform: "Linux"}
}

func testEvent(id string) models.UsageEvent {
	return models.UsageEvent{
		ID: id, Timestamp: time.Now().UTC(), Source: "external",
		Vendor: "kimi", Model: "k3", Tokens: models.TokenBreakdown{Input: 100, Output: 20},
		Attestation: "measured",
	}
}

func TestEventsCreatesUserAndMachine(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	res, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{testEvent("e-1")})
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
	if _, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	res, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{testEvent("e-1")})
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
	if _, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{ev}); err == nil {
		t.Fatal("expected row error")
	}
	huge := make([]models.UsageEvent, MaxEventsBatch+1)
	if _, err := ing.Events(context.Background(), testEnv(), huge); err == nil {
		t.Fatal("expected batch cap error")
	}
}

func TestLimitsStoredAgainstUser(t *testing.T) {
	fake := testfake.New()
	ing := Ingest{Store: fake}
	sn := models.LimitSnapshot{RecordedAt: time.Now().UTC(), Provider: "kimi", Label: "5h", UsedPercent: 48}
	res, err := ing.Limits(context.Background(), testEnv(), []models.LimitSnapshot{sn})
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
	if _, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	moved := testEnv()
	moved.Handle = "newhire"
	if _, err := ing.Events(context.Background(), moved, []models.UsageEvent{testEvent("e-2")}); err != nil {
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
	if _, err := ing.Events(context.Background(), testEnv(), []models.UsageEvent{testEvent("e-1")}); err != nil {
		t.Fatal(err)
	}
	thin := testEnv()
	thin.MachineAlias, thin.Platform = "", ""
	if _, err := ing.Events(context.Background(), thin, []models.UsageEvent{testEvent("e-2")}); err != nil {
		t.Fatal(err)
	}
	m, _ := fake.MachineByID(context.Background(), "m-1")
	if m.Alias != "devbox" || m.Platform != "Linux" {
		t.Fatalf("clobbered: %+v", m)
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
