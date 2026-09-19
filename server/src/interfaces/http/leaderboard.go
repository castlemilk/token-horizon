package api

import (
	"net/http"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
)

// Leaderboard handler: ranked boards over everyone, one team, or one group.

func (s *Server) leaderboard(w http.ResponseWriter, r *http.Request) {
	if s.Board == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "leaderboard disabled"})
		return
	}
	q := r.URL.Query()
	board, err := s.Board.Rank(r.Context(), store.BoardScope{
		TeamSlug: q.Get("team"),
		GroupID:  q.Get("group"),
	}, q.Get("period"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, board)
}
