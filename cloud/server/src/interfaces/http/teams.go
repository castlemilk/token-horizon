package api

import (
	"net/http"
	"strings"
)

// Team and group handlers: create with a join code, join by code, leave
// (empties prune server-side). Groups live inside teams.

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
