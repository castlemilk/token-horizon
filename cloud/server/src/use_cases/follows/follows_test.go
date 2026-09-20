package follows

import (
	"context"
	"testing"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/testfake"
)

func TestFollowsFlow(t *testing.T) {
	fake := testfake.New()
	ctx := context.Background()
	ada, _ := fake.ResolveUser(ctx, "ada", "Ada", "")
	grace, _ := fake.ResolveUser(ctx, "grace", "Grace", "")

	f := Follows{Store: fake}
	if _, err := f.Follow(ctx, ada.ID, "Grace"); err != nil {
		t.Fatal(err)
	}
	// Refollow is a no-op.
	if _, err := f.Follow(ctx, ada.ID, "grace"); err != nil {
		t.Fatal(err)
	}
	following, err := f.Following(ctx, ada.ID)
	if err != nil || len(following) != 1 || following[0].Handle != "grace" {
		t.Fatalf("following=%+v err=%v", following, err)
	}
	followers, err := f.Followers(ctx, grace.ID)
	if err != nil || len(followers) != 1 || followers[0].Handle != "ada" {
		t.Fatalf("followers=%+v err=%v", followers, err)
	}
	if _, err := f.Follow(ctx, ada.ID, "ada"); err == nil {
		t.Fatal("expected self-follow error")
	}
	if _, err := f.Follow(ctx, ada.ID, "ghost"); err == nil {
		t.Fatal("expected unknown-user error")
	}
	if err := f.Unfollow(ctx, ada.ID, "grace"); err != nil {
		t.Fatal(err)
	}
	following, _ = f.Following(ctx, ada.ID)
	if len(following) != 0 {
		t.Fatalf("after unfollow: %+v", following)
	}
	// Double unfollow is harmless.
	if err := f.Unfollow(ctx, ada.ID, "grace"); err != nil {
		t.Fatal(err)
	}
}
