package auth

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/testfake"
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
	auth, _ := testAuth()
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
}
