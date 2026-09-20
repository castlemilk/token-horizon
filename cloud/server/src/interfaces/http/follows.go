package api

import (
	"net/http"
	"strings"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
)

// Follow handlers: follow/unfollow by handle, list either side of the
// caller's graph, and the social leaderboard over it.

func (a *Auth) follow(w http.ResponseWriter, r *http.Request, userID string) {
	fu, err := a.Follows.Follow(r.Context(), userID, r.PathValue("handle"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "no such user") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, fu)
}

func (a *Auth) unfollow(w http.ResponseWriter, r *http.Request, userID string) {
	if err := a.Follows.Unfollow(r.Context(), userID, r.PathValue("handle")); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "no such user") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *Auth) followers(w http.ResponseWriter, r *http.Request, userID string) {
	users, err := a.Follows.Followers(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"followers": users})
}

func (a *Auth) following(w http.ResponseWriter, r *http.Request, userID string) {
	users, err := a.Follows.Following(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"following": users})
}

// followingBoard ranks the people the caller follows (plus themselves) for
// a window — the social leaderboard.
func (a *Auth) followingBoard(w http.ResponseWriter, r *http.Request, userID string) {
	if a.Board == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "leaderboard disabled"})
		return
	}
	q := r.URL.Query()
	window := q.Get("window")
	if window == "" {
		window = q.Get("period")
	}
	board, err := a.Board.Rank(r.Context(), store.BoardScope{FollowingOf: userID}, window, q.Get("category"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, board)
}
