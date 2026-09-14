package api

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/castlemilk/token-horizon/server/src/models"
	usecases "github.com/castlemilk/token-horizon/server/src/use_cases"
)

// Auth and account routes. Login is a browser dance bridged back to the
// desktop app with claim tickets: open login URL → provider → callback
// parks a session on the ticket → app claims it once for a bearer token.

// Auth wires the Auth use case plus avatar storage into the Server.
type Auth struct {
	Use  usecases.Auth
	Acct usecases.Account
	Team usecases.Teams
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
	mux.HandleFunc("GET /v1/leaderboard", s.withAuth(s.leaderboard))
}

func (s *Server) leaderboard(w http.ResponseWriter, r *http.Request) {
	if s.Board == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "leaderboard disabled"})
		return
	}
	q := r.URL.Query()
	board, err := s.Board.Rank(r.Context(), q.Get("team"), q.Get("period"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, board)
}

// withAuthOptional lets the service token through but never requires a
// user (used where the caller may be pre-login machinery).
func (s *Server) withAuthOptional(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r)
	}
}

type ctxKey string

const userKey ctxKey = "userID"

// withUser requires a valid session token and passes the user id through.
// The service sync token alone is NOT a user (ingest keeps its own path).
func (s *Server) withUser(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || (s.Token != "" && token == s.Token) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "sign in required"})
			return
		}
		user, err := s.AuthN.Authenticate(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid session"})
			return
		}
		next(w, r, user.ID)
	}
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
		if err == usecases.ErrTicketPending {
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

// --- account ---

// toPublicUser strips provider subs before a user crosses the wire.
func toPublicUser(u models.User) models.User {
	u.GoogleSub, u.MSSub = "", ""
	return u
}

func (a *Auth) me(w http.ResponseWriter, r *http.Request, userID string) {
	u, err := a.Use.Store.UserByID(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "account missing"})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

func (a *Auth) update(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		DisplayName string `json:"display_name"`
		Handle      string `json:"handle"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	u, err := a.Acct.Update(r.Context(), userID, body.DisplayName, body.Handle, "")
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "taken") {
			status = http.StatusConflict
		} else if strings.Contains(err.Error(), "handle") {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

// uploadAvatar accepts a webp/png/jpeg image (the client downscales to
// ~256px webp first), stores it, and points the profile at it.
func (a *Auth) uploadAvatar(w http.ResponseWriter, r *http.Request, userID string) {
	if err := r.ParseMultipartForm(2<<20 + 1<<16); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "multipart parse failed"})
		return
	}
	f, _, err := r.FormFile("avatar")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "avatar file required"})
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 2<<20+1))
	if err != nil || len(raw) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "empty file"})
		return
	}
	ext, ctype, ok := sniffImage(raw)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "avatar must be webp, png, or jpeg"})
		return
	}
	_ = ctype
	if err := os.MkdirAll(a.AvatarDir, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}
	name := userID + ext
	if err := os.WriteFile(filepath.Join(a.AvatarDir, name), raw, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}
	url := strings.TrimSuffix(a.AvatarURLBase, "/") + "/" + userID
	u, err := a.Acct.Update(r.Context(), userID, "", "", url)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

// serveAvatar serves stored avatars (public — <img> tags carry no auth).
func (a *Auth) serveAvatar(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || strings.ContainsAny(id, "/\\") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	for _, ext := range []string{".webp", ".png", ".jpg", ".jpeg"} {
		path := filepath.Join(a.AvatarDir, id+ext)
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		_, ctype, ok := sniffImage(raw)
		if !ok {
			continue
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(raw)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "no avatar"})
}

// sniffImage allows webp/png/jpeg by magic bytes.
func sniffImage(b []byte) (ext, ctype string, ok bool) {
	if len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		return ".webp", "image/webp", true
	}
	if len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n" {
		return ".png", "image/png", true
	}
	if len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
		return ".jpg", "image/jpeg", true
	}
	return "", "", false
}

// --- teams & groups ---

func (a *Auth) createTeam(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	team, err := a.Team.CreateTeam(r.Context(), userID, body.Name)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, team)
}

func (a *Auth) myTeams(w http.ResponseWriter, r *http.Request, userID string) {
	teams, err := a.Team.MyTeams(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
}

func (a *Auth) joinTeam(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	team, err := a.Team.JoinTeam(r.Context(), userID, body.Code)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, team)
}

func (a *Auth) leaveTeam(w http.ResponseWriter, r *http.Request, userID string) {
	if err := a.Team.LeaveTeam(r.Context(), userID, r.PathValue("id")); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *Auth) createGroup(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	group, err := a.Team.CreateGroup(r.Context(), userID, r.PathValue("id"), body.Name)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "not a team member") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, group)
}

func (a *Auth) listGroups(w http.ResponseWriter, r *http.Request, userID string) {
	groups, err := a.Team.Groups(r.Context(), userID, r.PathValue("id"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "not a team member") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (a *Auth) joinGroup(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	group, err := a.Team.JoinGroup(r.Context(), userID, body.Code)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "join the team first") {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, group)
}

func (a *Auth) leaveGroup(w http.ResponseWriter, r *http.Request, userID string) {
	if err := a.Team.LeaveGroup(r.Context(), userID, r.PathValue("id")); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
