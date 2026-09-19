package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store/testfake"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/use_cases/account"
	"github.com/castlemilk/token-horizon/server/src/use_cases/auth"
	"github.com/castlemilk/token-horizon/server/src/use_cases/ingest"
	syncuc "github.com/castlemilk/token-horizon/server/src/use_cases/sync"
	"github.com/castlemilk/token-horizon/server/src/use_cases/teams"
)

func testAuthServer(t *testing.T) (*Server, *testfake.Fake) {
	t.Helper()
	fake := testfake.New()
	srv := &Server{
		Ingest: ingest.Ingest{Store: fake},
		Sync:   syncuc.Sync{Store: fake},
		AuthN:  auth.Auth{Store: fake},
	}
	srv.AuthRoutes = &Auth{
		Use: srv.AuthN, Acct: account.Account{Store: fake}, Team: teams.Teams{Store: fake},
		AvatarDir: t.TempDir() + "/avatars", AvatarURLBase: "/v1/avatars",
	}
	return srv, fake
}

// seedSession creates a user + live session, returning the bearer token.
func seedSession(t *testing.T, fake *testfake.Fake, handle string) (token, userID string) {
	t.Helper()
	u, err := fake.ResolveUser(t.Context(), handle, handle, "")
	if err != nil {
		t.Fatal(err)
	}
	token = "tok-" + handle
	sum := sha256.Sum256([]byte(token))
	fake.Sessions[hex.EncodeToString(sum[:])] = identity.Session{
		TokenHash: hex.EncodeToString(sum[:]), UserID: u.ID,
		CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
	return token, u.ID
}

func authedWith(token, method, path string, body []byte, ctype string) *http.Request {
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	return r
}

func TestMeRequiresSession(t *testing.T) {
	srv, _ := testAuthServer(t)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/v1/users/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d", rec.Code)
	}
}

func TestAccountUpdateAndAvatar(t *testing.T) {
	srv, fake := testAuthServer(t)
	token, _ := seedSession(t, fake, "ada")

	// Rename + display name.
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, authedWith(token, "PATCH", "/v1/users/me",
		[]byte(`{"display_name":"Ada L","handle":"ada-l"}`), "application/json"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ada-l") {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Avatar: minimal webp (RIFF....WEBP) — client downscales first.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("avatar", "me.webp")
	_, _ = fw.Write(append([]byte("RIFF\x00\x00\x00\x00WEBP"), bytes.Repeat([]byte{1}, 64)...))
	_ = mw.Close()
	rec2 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec2, authedWith(token, "POST", "/v1/users/me/avatar", buf.Bytes(), mw.FormDataContentType()))
	if rec2.Code != http.StatusOK || !strings.Contains(rec2.Body.String(), "/v1/avatars/") {
		t.Fatalf("code=%d body=%s", rec2.Code, rec2.Body.String())
	}

	// Reject non-images.
	var buf2 bytes.Buffer
	mw2 := multipart.NewWriter(&buf2)
	fw2, _ := mw2.CreateFormFile("avatar", "evil.exe")
	_, _ = fw2.Write([]byte("MZ binary"))
	_ = mw2.Close()
	rec3 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec3, authedWith(token, "POST", "/v1/users/me/avatar", buf2.Bytes(), mw2.FormDataContentType()))
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("code=%d", rec3.Code)
	}

	// Logout kills the session.
	rec4 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec4, authedWith(token, "POST", "/v1/auth/logout", []byte(`{}`), "application/json"))
	if rec4.Code != http.StatusOK {
		t.Fatalf("code=%d", rec4.Code)
	}
	rec5 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec5, authedWith(token, "GET", "/v1/users/me", nil, ""))
	if rec5.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d", rec5.Code)
	}
}

func TestTeamsAndGroupsFlow(t *testing.T) {
	srv, fake := testAuthServer(t)
	token, _ := seedSession(t, fake, "ada")
	token2, _ := seedSession(t, fake, "grace")

	post := func(tok, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.Routes().ServeHTTP(rec, authedWith(tok, "POST", path, []byte(body), "application/json"))
		return rec
	}
	get := func(tok, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.Routes().ServeHTTP(rec, authedWith(tok, "GET", path, nil, ""))
		return rec
	}

	rec := post(token, "/v1/teams", `{"name":"Core"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID       string `json:"id"`
		JoinCode string `json:"join_code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	if rec := post(token2, "/v1/teams/join", `{"code":"`+created.JoinCode+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("join: %d %s", rec.Code, rec.Body.String())
	}
	if rec := get(token2, "/v1/teams"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Core") {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	grec := post(token, "/v1/teams/"+created.ID+"/groups", `{"name":"Backend"}`)
	if grec.Code != http.StatusOK {
		t.Fatalf("group: %d %s", grec.Code, grec.Body.String())
	}
	var grp struct {
		ID       string `json:"id"`
		JoinCode string `json:"join_code"`
	}
	_ = json.Unmarshal(grec.Body.Bytes(), &grp)
	if rec := post(token2, "/v1/groups/join", `{"code":"`+grp.JoinCode+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("gjoin: %d %s", rec.Code, rec.Body.String())
	}
	if rec := get(token2, "/v1/teams/"+created.ID+"/groups"); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "Backend") {
		t.Fatalf("groups: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(token2, "/v1/groups/"+grp.ID+"/leave", `{}`); rec.Code != http.StatusOK {
		t.Fatalf("gleave: %d", rec.Code)
	}
	if rec := post(token2, "/v1/teams/"+created.ID+"/leave", `{}`); rec.Code != http.StatusOK {
		t.Fatalf("leave: %d", rec.Code)
	}
}
