package usecases

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/testfake"
)

// stubTransport answers token + userinfo calls with canned payloads.
type stubTransport struct{}

func (stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body string
	if strings.HasSuffix(req.URL.Path, "/token") {
		body = `{"access_token":"tok-123"}`
	} else {
		body = `{"sub":"g-sub-1","email":"Ada@Example.com","name":"Ada L","picture":"https://img/x.png"}`
	}
	return &http.Response{
		StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header),
	}, nil
}

func testAuth() (Auth, *testfake.Fake) {
	fake := testfake.New()
	return Auth{Store: fake, Config: AuthConfig{
		Google:    OAuthConfig{ClientID: "cid", ClientSecret: "sec"},
		Microsoft: OAuthConfig{ClientID: "cid", ClientSecret: "sec"},
		PublicURL: "http://cloud:8080",
	}, Client: &http.Client{Transport: stubTransport{}}}, fake
}

func TestLoginURLMint(t *testing.T) {
	auth, _ := testAuth()
	url, state, err := auth.LoginURL(context.Background(), ProviderGoogle)
	if err != nil {
		t.Fatal(err)
	}
	if state == "" || !strings.Contains(url, "accounts.google.com") || !strings.Contains(url, "state="+state) {
		t.Fatalf("url=%q state=%q", url, state)
	}
	if _, _, err := auth.LoginURL(context.Background(), "nope"); err == nil {
		t.Fatal("expected provider error")
	}
	unconfigured := auth
	unconfigured.Config.Google = OAuthConfig{}
	if _, _, err := unconfigured.LoginURL(context.Background(), ProviderGoogle); err == nil {
		t.Fatal("expected unconfigured error")
	}
}

func TestCompleteClaimLogoutFlow(t *testing.T) {
	auth, fake := testAuth()
	ctx := context.Background()
	loginURL, state, err := auth.LoginURL(ctx, ProviderGoogle)
	if err != nil || loginURL == "" {
		t.Fatal(err)
	}
	user, err := auth.Complete(ctx, ProviderGoogle, "code-1", state)
	if err != nil {
		t.Fatal(err)
	}
	if user.Handle != "ada" || user.Email != "Ada@Example.com" {
		t.Fatalf("user=%+v", user)
	}
	token, claimed, err := auth.Claim(ctx, state)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || claimed.ID != user.ID {
		t.Fatalf("claim token=%q user=%+v", token, claimed)
	}
	// Double claim burns.
	if _, _, err := auth.Claim(ctx, state); err == nil {
		t.Fatal("expected double-claim error")
	}
	// Authenticate + logout round-trip.
	me, err := auth.Authenticate(ctx, token)
	if err != nil || me.ID != user.ID {
		t.Fatalf("me=%+v err=%v", me, err)
	}
	if err := auth.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Authenticate(ctx, token); err == nil {
		t.Fatal("expected revoked error")
	}
	_ = fake
}

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

func TestAccountUpdate(t *testing.T) {
	fake := testfake.New()
	ac := Account{Store: fake}
	ctx := context.Background()
	u, _ := fake.ResolveUser(ctx, "ada", "Ada", "")
	if _, err := ac.Update(ctx, u.ID, "Ada L", "ada-l", ""); err != nil {
		t.Fatal(err)
	}
	other, _ := fake.ResolveUser(ctx, "grace", "Grace", "")
	if _, err := ac.Update(ctx, other.ID, "", "ada-l", ""); err == nil {
		t.Fatal("expected taken error")
	}
	if _, err := ac.Update(ctx, other.ID, "", "X", ""); err == nil {
		t.Fatal("expected handle-shape error")
	}
	_ = time.Now
}
