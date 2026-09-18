// Package testfake is an in-memory store.Store for unit tests. No SQL,
// no drivers — it verifies use-case and handler logic only. SQL dialect is
// proven separately by the duckdb integration test (store_duck_test.go).
package testfake

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models"
)

// errTaken stands in for unique violations so use cases exercise their
// taken-handle path without a database (not-found uses sql.ErrNoRows).
var (
	errTaken = errors.New("handle taken")
)

// Fake is a mutex-guarded in-memory Store.
type Fake struct {
	mu       sync.Mutex
	Users    map[string]models.User
	Machine  map[string]models.Machine
	Events   []models.UsageEvent
	Limits   []models.LimitSnapshot
	Cursors  map[string]string
	Sessions map[string]models.Session
	Tickets  map[string]models.Ticket
	Teams    map[string]models.Team
	TeamJoin map[string]string // code -> team id
	TeamMemb map[string]map[string]string
	Groups   map[string]models.Group
	GrpJoin  map[string]string
	GrpMemb  map[string]map[string]string
	Err      error // injected failure for error paths
}

func New() *Fake {
	return &Fake{
		Users: map[string]models.User{}, Machine: map[string]models.Machine{},
		Cursors: map[string]string{}, Sessions: map[string]models.Session{},
		Tickets: map[string]models.Ticket{}, Teams: map[string]models.Team{},
		TeamJoin: map[string]string{}, TeamMemb: map[string]map[string]string{},
		Groups: map[string]models.Group{}, GrpJoin: map[string]string{},
		GrpMemb: map[string]map[string]string{},
	}
}

func (f *Fake) Close() error { return nil }

func (f *Fake) ResolveUser(_ context.Context, handle, displayName, team string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return models.User{}, f.Err
	}
	if u, ok := f.Users[handle]; ok {
		u.DisplayName, u.Team = displayName, team
		f.Users[handle] = u
		return u, nil
	}
	now := time.Now().UTC()
	u := models.User{ID: "user-" + handle, Handle: handle, DisplayName: displayName, Team: team, CreatedAt: now, UpdatedAt: now}
	f.Users[handle] = u
	return u, nil
}

func (f *Fake) RegisterMachine(_ context.Context, m models.Machine) (models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if old, ok := f.Machine[m.MachineID]; ok {
		old.UserID, old.Alias, old.Platform, old.LastSeen = m.UserID, m.Alias, m.Platform, m.LastSeen
		f.Machine[m.MachineID] = old
		return old, nil
	}
	f.Machine[m.MachineID] = m
	return m, nil
}

func (f *Fake) Machines(_ context.Context, userID string) ([]models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []models.Machine
	for _, m := range f.Machine {
		if m.UserID == userID {
			out = append(out, m)
		}
	}
	return out, nil
}

func (f *Fake) MachineByID(_ context.Context, machineID string) (models.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Machine[machineID], nil
}

func (f *Fake) InsertEvents(_ context.Context, _ string, events []models.UsageEvent) (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range f.Events {
		seen[e.ID] = true
	}
	accepted, dups := 0, 0
	for _, e := range events {
		if seen[e.ID] {
			dups++
			continue
		}
		seen[e.ID] = true
		f.Events = append(f.Events, e)
		accepted++
	}
	return accepted, dups, nil
}

func (f *Fake) InsertLimits(_ context.Context, _ string, snaps []models.LimitSnapshot) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Limits = append(f.Limits, snaps...)
	return len(snaps), nil
}

func (f *Fake) HighWater(_ context.Context, machineID string) (time.Time, int64, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ets, lts time.Time
	var n int64
	for _, e := range f.Events {
		if e.MachineID == machineID {
			n++
			if e.Timestamp.After(ets) {
				ets = e.Timestamp
			}
		}
	}
	for _, l := range f.Limits {
		if l.MachineID == machineID && l.RecordedAt.After(lts) {
			lts = l.RecordedAt
		}
	}
	return ets, n, lts, nil
}

func (f *Fake) UsageSummary(_ context.Context, q store.SummaryQuery) ([]store.VendorSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	byVendor := map[string]*store.VendorSummary{}
	for _, e := range f.Events {
		if !q.Since.IsZero() && e.Timestamp.Before(q.Since) {
			continue
		}
		if q.Vendor != "" && e.Vendor != q.Vendor {
			continue
		}
		v := byVendor[e.Vendor]
		if v == nil {
			v = &store.VendorSummary{Vendor: e.Vendor}
			byVendor[e.Vendor] = v
		}
		v.Tokens += e.Tokens.Total()
		v.Cost += e.Cost
		v.Requests++
	}
	var out []store.VendorSummary
	for _, v := range byVendor {
		out = append(out, *v)
	}
	return out, nil
}

func (f *Fake) SetCursor(_ context.Context, dataset, machineID, cursor string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Cursors[dataset+"|"+machineID] = cursor
	return nil
}

func (f *Fake) Cursor(_ context.Context, dataset, machineID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Cursors[dataset+"|"+machineID], nil
}

func (f *Fake) inTeamLocked(team, userID string) bool {
	if team == "" {
		return true
	}
	for id, t := range f.Teams {
		if t.Slug != team {
			continue
		}
		return f.TeamMemb[id][userID] != ""
	}
	return false
}

func (f *Fake) BoardTotals(_ context.Context, team string, since time.Time) ([]store.BoardRow, error) {
	return f.boardTotals(team, since, time.Time{})
}

func (f *Fake) BoardTotalsRange(_ context.Context, team string, since, until time.Time) ([]store.BoardRow, error) {
	return f.boardTotals(team, since, until)
}

func (f *Fake) boardTotals(team string, since, until time.Time) ([]store.BoardRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	byUser := map[string]*store.BoardRow{}
	machines := map[string]map[string]bool{}
	for _, e := range f.Events {
		if e.Timestamp.Before(since) {
			continue
		}
		if !until.IsZero() && !e.Timestamp.Before(until) {
			continue
		}
		var u *models.User
		for _, cand := range f.Users {
			if cand.ID == eventUserID(f, e) {
				c := cand
				u = &c
				break
			}
		}
		if u == nil || !f.inTeamLocked(team, u.ID) {
			continue
		}
		r := byUser[u.ID]
		if r == nil {
			r = &store.BoardRow{UserID: u.ID, Handle: u.Handle, DisplayName: u.DisplayName, AvatarURL: u.AvatarURL}
			byUser[u.ID] = r
		}
		r.Tokens += e.Tokens.Total()
		r.Cost += e.Cost
		r.Requests++
		if machines[u.ID] == nil {
			machines[u.ID] = map[string]bool{}
		}
		machines[u.ID][e.MachineID] = true
	}
	var out []store.BoardRow
	for id, r := range byUser {
		r.Machines = len(machines[id])
		out = append(out, *r)
	}
	return out, nil
}

// eventUserID resolves the fake event's owner via the machine table.
func eventUserID(f *Fake, e models.UsageEvent) string {
	if m, ok := f.Machine[e.MachineID]; ok {
		return m.UserID
	}
	return ""
}

func (f *Fake) BoardDays(_ context.Context, team string, since time.Time, limitDays int) (map[string][]time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string][]time.Time{}
	seen := map[string]map[string]bool{}
	for _, e := range f.Events {
		if e.Timestamp.Before(since) {
			continue
		}
		uid := eventUserID(f, e)
		var handle string
		for _, u := range f.Users {
			if u.ID == uid {
				handle = u.Handle
				break
			}
		}
		if handle == "" || !f.inTeamLocked(team, uid) {
			continue
		}
		day := e.Timestamp.UTC().Format("2006-01-02")
		if seen[handle] == nil {
			seen[handle] = map[string]bool{}
		}
		if !seen[handle][day] {
			seen[handle][day] = true
			if len(out[handle]) < limitDays {
				out[handle] = append(out[handle], e.Timestamp)
			}
		}
	}
	return out, nil
}

func (f *Fake) ResolveUserByProvider(_ context.Context, provider, sub string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.Users {
		if provider == "google" && u.GoogleSub == sub && sub != "" {
			return u, nil
		}
		if provider == "microsoft" && u.MSSub == sub && sub != "" {
			return u, nil
		}
	}
	return models.User{}, sql.ErrNoRows
}

func (f *Fake) UserByHandle(_ context.Context, handle string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.Users {
		if u.Handle == handle {
			return u, nil
		}
	}
	return models.User{}, sql.ErrNoRows
}

func (f *Fake) UserByID(_ context.Context, id string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.Users {
		if u.ID == id {
			return u, nil
		}
	}
	return models.User{}, sql.ErrNoRows
}

func (f *Fake) LinkProvider(_ context.Context, userID, provider, sub, email, avatarURL string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for h, u := range f.Users {
		if u.ID == userID {
			if provider == "google" {
				u.GoogleSub = sub
			} else {
				u.MSSub = sub
			}
			if u.Email == "" {
				u.Email = email
			}
			if u.AvatarURL == "" {
				u.AvatarURL = avatarURL
			}
			f.Users[h] = u
			return nil
		}
	}
	return sql.ErrNoRows
}

func (f *Fake) UpdateUser(_ context.Context, userID, displayName, handle, avatarURL string) (models.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for h, u := range f.Users {
		if u.ID == userID {
			if handle != "" {
				for h2, u2 := range f.Users {
					if h2 != h && u2.Handle == handle {
						return models.User{}, errTaken
					}
				}
				delete(f.Users, h)
				h = handle
				u.Handle = handle
			}
			if displayName != "" {
				u.DisplayName = displayName
			}
			u.AvatarURL = avatarURL
			f.Users[h] = u
			return u, nil
		}
	}
	return models.User{}, sql.ErrNoRows
}

func (f *Fake) CreateSession(_ context.Context, sess models.Session) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Sessions[sess.TokenHash] = sess
	return nil
}

func (f *Fake) SessionByToken(_ context.Context, tokenHash string) (models.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.Sessions[tokenHash]
	if !ok {
		return models.Session{}, sql.ErrNoRows
	}
	return s, nil
}

func (f *Fake) DeleteSession(_ context.Context, tokenHash string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.Sessions, tokenHash)
	return nil
}

func (f *Fake) CreateTicket(_ context.Context, t models.Ticket) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Tickets[t.State] = t
	return nil
}

func (f *Fake) AttachTicketSession(_ context.Context, state, sessionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.Tickets[state]
	if !ok || !t.RedeemedAt.IsZero() {
		return sql.ErrNoRows
	}
	t.SessionID = sessionID
	f.Tickets[state] = t
	return nil
}

func (f *Fake) ClaimTicket(_ context.Context, state string) (models.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.Tickets[state]
	if !ok || !t.RedeemedAt.IsZero() {
		return models.Ticket{}, sql.ErrNoRows
	}
	out := t // pre-redeem snapshot for validation
	t.RedeemedAt = time.Now().UTC()
	f.Tickets[state] = t
	return out, nil
}

func (f *Fake) Ticket(_ context.Context, state string) (models.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.Tickets[state]
	if !ok {
		return models.Ticket{}, sql.ErrNoRows
	}
	return t, nil
}

func (f *Fake) CreateTeam(_ context.Context, id, slug, name, joinCode, ownerID string) (models.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := models.Team{ID: id, Slug: slug, Name: name, JoinCode: joinCode, OwnerID: ownerID, Role: "owner", Members: 1}
	f.Teams[id] = t
	f.TeamJoin[joinCode] = id
	f.TeamMemb[id] = map[string]string{ownerID: "owner"}
	return t, nil
}

func (f *Fake) MyTeams(_ context.Context, userID string) ([]models.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []models.Team
	for id, memb := range f.TeamMemb {
		role, ok := memb[userID]
		if !ok {
			continue
		}
		t := f.Teams[id]
		t.Role = role
		t.Members = len(memb)
		out = append(out, t)
	}
	return out, nil
}

func (f *Fake) TeamByJoinCode(_ context.Context, code string) (models.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.TeamJoin[code]
	if !ok {
		return models.Team{}, sql.ErrNoRows
	}
	return f.Teams[id], nil
}

func (f *Fake) AddTeamMember(_ context.Context, teamID, userID, role string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.TeamMemb[teamID]
	if m == nil {
		m = map[string]string{}
		f.TeamMemb[teamID] = m
	}
	m[userID] = role
	return nil
}

func (f *Fake) LeaveTeamMember(_ context.Context, teamID, userID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.TeamMemb[teamID], userID)
	if len(f.TeamMemb[teamID]) == 0 {
		delete(f.TeamMemb, teamID)
		t := f.Teams[teamID]
		delete(f.TeamJoin, t.JoinCode)
		delete(f.Teams, teamID)
	}
	return nil
}

func (f *Fake) IsTeamMember(_ context.Context, teamID, userID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.TeamMemb[teamID][userID]
	return ok, nil
}

func (f *Fake) CreateGroup(_ context.Context, id, teamID, slug, name, joinCode, ownerID string) (models.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	g := models.Group{ID: id, TeamID: teamID, Slug: slug, Name: name, JoinCode: joinCode, Role: "owner", Members: 1}
	f.Groups[id] = g
	f.GrpJoin[joinCode] = id
	f.GrpMemb[id] = map[string]string{ownerID: "owner"}
	return g, nil
}

func (f *Fake) GroupsByTeam(_ context.Context, teamID, userID string) ([]models.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []models.Group
	for _, g := range f.Groups {
		if g.TeamID != teamID {
			continue
		}
		g.Role = f.GrpMemb[g.ID][userID]
		n := 0
		for range f.GrpMemb[g.ID] {
			n++
		}
		g.Members = n
		out = append(out, g)
	}
	return out, nil
}

func (f *Fake) GroupByJoinCode(_ context.Context, code string) (models.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.GrpJoin[code]
	if !ok {
		return models.Group{}, sql.ErrNoRows
	}
	return f.Groups[id], nil
}

func (f *Fake) AddGroupMember(_ context.Context, groupID, userID, role string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.GrpMemb[groupID]
	if m == nil {
		m = map[string]string{}
		f.GrpMemb[groupID] = m
	}
	m[userID] = role
	return nil
}

func (f *Fake) LeaveGroupMember(_ context.Context, groupID, userID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.GrpMemb[groupID], userID)
	if len(f.GrpMemb[groupID]) == 0 {
		delete(f.GrpMemb, groupID)
		g := f.Groups[groupID]
		delete(f.GrpJoin, g.JoinCode)
		delete(f.Groups, groupID)
	}
	return nil
}
