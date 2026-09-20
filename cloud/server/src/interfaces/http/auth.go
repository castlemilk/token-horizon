package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/account"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/auth"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/follows"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/leaderboard"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/teams"
)

// Auth and account routes. Login is a browser dance bridged back to the
// desktop app with claim tickets: open login URL → provider → callback
// parks a session on the ticket → app claims it once for a bearer token.

// Auth wires the login, account, teams, and follows use cases plus avatar
// storage into the Server.
type Auth struct {
	Use     auth.Auth
	Acct    account.Account
	Team    teams.Teams
	Follows follows.Follows
	Board   *leaderboard.Leaderboard
	// AvatarDir stores avatar files; AvatarURLBase prefixes their public URL.
	AvatarDir     string
	AvatarURLBase string
}

func (s *Server) mountAuth(mux *http.ServeMux, a *Auth) {
	mux.HandleFunc("GET /v1/auth/{provider}/login", a.login)
	mux.HandleFunc("GET /v1/auth/{provider}/callback", s.withAuthOptional(func(w http.ResponseWriter, r *http.Request) {
		a.callback(w, r)
	}))
	mux.HandleFunc("POST /v1/auth/claim", a.claim)
	mux.HandleFunc("POST /v1/auth/logout", s.withUser(func(w http.ResponseWriter, r *http.Request, userID string) {
		a.logout(w, r, userID)
	}))
	mux.HandleFunc("GET /v1/users/me", s.withUser(a.me))
	mux.HandleFunc("PATCH /v1/users/me", s.withUser(a.update))
	mux.HandleFunc("POST /v1/users/me/avatar", s.withUser(a.uploadAvatar))
	mux.HandleFunc("GET /v1/avatars/{id}", a.serveAvatar)
	mux.HandleFunc("POST /v1/teams", s.withUser(a.createTeam))
	mux.HandleFunc("GET /v1/teams", s.withUser(a.myTeams))
	mux.HandleFunc("POST /v1/teams/join", s.withUser(a.joinTeam))
	mux.HandleFunc("POST /v1/teams/{id}/leave", s.withUser(a.leaveTeam))
	mux.HandleFunc("POST /v1/teams/{id}/groups", s.withUser(a.createGroup))
	mux.HandleFunc("GET /v1/teams/{id}/groups", s.withUser(a.listGroups))
	mux.HandleFunc("POST /v1/groups/join", s.withUser(a.joinGroup))
	mux.HandleFunc("POST /v1/groups/{id}/leave", s.withUser(a.leaveGroup))
	mux.HandleFunc("PUT /v1/follows/{handle}", s.withUser(a.follow))
	mux.HandleFunc("DELETE /v1/follows/{handle}", s.withUser(a.unfollow))
	mux.HandleFunc("GET /v1/follows/followers", s.withUser(a.followers))
	mux.HandleFunc("GET /v1/follows/following", s.withUser(a.following))
	mux.HandleFunc("GET /v1/follows/leaderboard", s.withUser(a.followingBoard))
	// The rankings are public — sign-in is for joining teams/following,
	// never for viewing.
	mux.HandleFunc("GET /v1/leaderboard", s.leaderboard)
}

// --- login flow ---

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	url, state, err := a.Use.LoginURL(r.Context(), provider)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": url, "state": state})
}

func (a *Auth) callback(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	q := r.URL.Query()
	user, err := a.Use.Complete(r.Context(), provider, q.Get("code"), q.Get("state"))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("<h1>Sign-in failed</h1><p>" + err.Error() + "</p><p>Return to the app and try again.</p>"))
		return
	}
	name := user.DisplayName
	if name == "" {
		name = user.Handle
	}
	w.Header().Set("Content-Type", "text/html")
	_, _ = fmt.Fprintf(w, `<h1>Signed in as %s</h1><p>Return to Token Horizon — you're connected.</p><script>try{window.close()}catch(e){}</script>`, name)
}

func (a *Auth) claim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State string `json:"state"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	token, user, err := a.Use.Claim(r.Context(), body.State)
	if err != nil {
		if err == auth.ErrTicketPending {
			writeJSON(w, http.StatusAccepted, map[string]any{"status": "pending"})
			return
		}
		writeJSON(w, http.StatusGone, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": toPublicUser(user)})
}

func (a *Auth) logout(w http.ResponseWriter, r *http.Request, _ string) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err := a.Use.Logout(r.Context(), token); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
