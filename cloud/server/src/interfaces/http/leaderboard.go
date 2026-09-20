package api

import (
	"net/http"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
)

// Leaderboard handler: PUBLIC ranked boards (no session required) over
// everyone, one team, or one group — ?window=today|week|month|6m|year|all
// and ?category=tokens|cost|requests. The legacy ?period= name still maps.

func (s *Server) leaderboard(w http.ResponseWriter, r *http.Request) {
	if s.Board == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"error": "leaderboard disabled"})
		return
	}
	q := r.URL.Query()
	window := q.Get("window")
	if window == "" {
		// Back-compat with the first UI picker.
		switch q.Get("period") {
		case "", "today":
			window = "today"
		case "week", "7d":
			window = "week"
		case "all":
			window = "all"
		default:
			window = q.Get("period") // let the use case reject unknown values
		}
	}
	board, err := s.Board.Rank(r.Context(), store.BoardScope{
		TeamSlug: q.Get("team"),
		GroupID:  q.Get("group"),
	}, window, q.Get("category"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, board)
}
