package teams

import (
	"context"
	"testing"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/testfake"
)

func TestTeamsFlow(t *testing.T) {
	fake := testfake.New()
	tm := Teams{Store: fake}
	ctx := context.Background()
	team, err := tm.CreateTeam(ctx, "u-1", "Core Team")
	if err != nil || team.JoinCode == "" || team.Role != "owner" {
		t.Fatalf("team=%+v err=%v", team, err)
	}
	mine, err := tm.MyTeams(ctx, "u-1")
	if err != nil || len(mine) != 1 {
		t.Fatalf("mine=%+v err=%v", mine, err)
	}
	joined, err := tm.JoinTeam(ctx, "u-2", team.JoinCode)
	if err != nil || joined.Role != "member" {
		t.Fatalf("joined=%+v err=%v", joined, err)
	}
	if _, err := tm.JoinTeam(ctx, "u-2", team.JoinCode); err == nil {
		t.Fatal("expected already-member error")
	}
	if _, err := tm.JoinTeam(ctx, "u-3", "NOPE1234"); err == nil {
		t.Fatal("expected bad-code error")
	}
	groups, err := tm.Groups(ctx, "u-2", team.ID)
	if err != nil || len(groups) != 0 {
		t.Fatalf("groups=%+v err=%v", groups, err)
	}
	g, err := tm.CreateGroup(ctx, "u-1", team.ID, "Backend")
	if err != nil || g.JoinCode == "" {
		t.Fatalf("group=%+v err=%v", g, err)
	}
	jg, err := tm.JoinGroup(ctx, "u-2", g.JoinCode)
	if err != nil || jg.ID != g.ID {
		t.Fatalf("jg=%+v err=%v", jg, err)
	}
	if _, err := tm.JoinGroup(ctx, "u-9", g.JoinCode); err == nil {
		t.Fatal("expected join-team-first error")
	}
	if err := tm.LeaveGroup(ctx, "u-2", g.ID); err != nil {
		t.Fatal(err)
	}
	if err := tm.LeaveTeam(ctx, "u-2", team.ID); err != nil {
		t.Fatal(err)
	}
	if err := tm.LeaveTeam(ctx, "u-1", team.ID); err != nil {
		t.Fatal(err)
	}
	mine, _ = tm.MyTeams(ctx, "u-1")
	if len(mine) != 0 {
		t.Fatalf("empty team should prune: %+v", mine)
	}
}
