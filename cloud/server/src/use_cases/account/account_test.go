package account

import (
	"context"
	"testing"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/testfake"
)

func TestAccountUpdate(t *testing.T) {
	fake := testfake.New()
	ac := Account{Store: fake}
	ctx := context.Background()
	u, _ := fake.ResolveUser(ctx, "ada", "Ada", "")
	if _, err := ac.Update(ctx, u.ID, "Ada L", "ada-l", "", "burning tokens since 2024"); err != nil {
		t.Fatal(err)
	}
	me, _ := fake.UserByID(ctx, u.ID)
	if me.Bio != "burning tokens since 2024" {
		t.Fatalf("bio=%q", me.Bio)
	}
	other, _ := fake.ResolveUser(ctx, "grace", "Grace", "")
	if _, err := ac.Update(ctx, other.ID, "", "ada-l", "", ""); err == nil {
		t.Fatal("expected taken error")
	}
	if _, err := ac.Update(ctx, other.ID, "", "X", "", ""); err == nil {
		t.Fatal("expected handle-shape error")
	}
}
