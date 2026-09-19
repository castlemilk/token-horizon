// Package testfake is an in-memory store.Store for unit tests. No SQL,
// no drivers — it verifies use-case and handler logic only. SQL dialect is
// proven separately by the duckdb integration test (sqlstore_duck_test.go).
package testfake

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/models/social"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
)

// errTaken stands in for unique violations so use cases exercise their
// taken-handle path without a database (not-found uses sql.ErrNoRows).
var (
	errTaken = errors.New("handle taken")
)

// Fake is a mutex-guarded in-memory Store.
type Fake struct {
	mu       sync.Mutex
	Users    map[string]identity.User
	Machine  map[string]identity.Machine
	Events   []usage.UsageEvent
	Limits   []usage.LimitSnapshot
	Cursors  map[string]string
	Refs     map[string]bool // machine|dataset|row -> delivered
	Sessions map[string]identity.Session
	Tickets  map[string]identity.Ticket
	Teams    map[string]social.Team
	TeamJoin map[string]string // code -> team id
	TeamMemb map[string]map[string]string
	Groups   map[string]social.Group
	GrpJoin  map[string]string
	GrpMemb  map[string]map[string]string
	Follows  map[string]map[string]time.Time // follower id -> followee id -> since
	Err      error                           // injected failure for error paths
}

func New() *Fake {
	return &Fake{
		Users: map[string]identity.User{}, Machine: map[string]identity.Machine{},
		Cursors: map[string]string{}, Refs: map[string]bool{}, Sessions: map[string]identity.Session{},
		Tickets: map[string]identity.Ticket{}, Teams: map[string]social.Team{},
		TeamJoin: map[string]string{}, TeamMemb: map[string]map[string]string{},
		Groups: map[string]social.Group{}, GrpJoin: map[string]string{},
		GrpMemb: map[string]map[string]string{}, Follows: map[string]map[string]time.Time{},
	}
}

func (f *Fake) Close() error { return nil }

func (f *Fake) ResolveUser(_ context.Context, handle, displayName, team string) (identity.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return identity.User{}, f.Err
	}
	if u, ok := f.Users[handle]; ok {
		u.DisplayName, u.Team = displayName, team
		f.Users[handle] = u
		return u, nil
	}
	now := time.Now().UTC()
	u := identity.User{ID: "user-" + handle, Handle: handle, DisplayName: displayName, Team: team, CreatedAt: now, UpdatedAt: now}
	f.Users[handle] = u
	return u, nil
}

func (f *Fake) RegisterMachine(_ context.Context, m identity.Machine) (identity.Machine, error) {
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

func (f *Fake) Machines(_ context.Context, userID string) ([]identity.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []identity.Machine
	for _, m := range f.Machine {
		if m.UserID == userID {
			out = append(out, m)
		}
	}
	return out, nil
}

func (f *Fake) MachineByID(_ context.Context, machineID string) (identity.Machine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Machine[machineID], nil
}

func (f *Fake) InsertEvents(_ context.Context, _ string, events []usage.UsageEvent) (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range f.Events {
		seen[e.ID] = true
	}
	accepted, dups := 0, 0
	for _, e := range events {
		f.Refs[e.MachineID+"|"+store.DatasetUsageEvents+"|"+e.ID] = true
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

func (f *Fake) InsertLimits(_ context.Context, _ string, snaps []usage.LimitSnapshot) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, sn := range snaps {
		f.Refs[sn.MachineID+"|"+store.DatasetLimitSnapshots+"|"+sn.DedupKey()] = true
	}
	f.Limits = append(f.Limits, snaps...)
	return len(snaps), nil
}

func (f *Fake) FilterMissingRows(_ context.Context, machineID, dataset string, ids []string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var missing []string
	for _, id := range ids {
		if !f.Refs[machineID+"|"+dataset+"|"+id] {
			missing = append(missing, id)
		}
	}
	return missing, nil
}

func (f *Fake) RefCount(_ context.Context, machineID, dataset string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	prefix := machineID + "|" + dataset + "|"
	var n int64
	for k := range f.Refs {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n, nil
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

// inScopeLocked reports whether a user passes a BoardScope (mirrors the
// SQL scopeFilter semantics; follow scope includes the user themselves).
func (f *Fake) inScopeLocked(scope store.BoardScope, userID string) bool {
	switch {
	case scope.TeamSlug != "":
		return f.inTeamLocked(scope.TeamSlug, userID)
	case scope.GroupID != "":
		return f.GrpMemb[scope.GroupID][userID] != ""
	case scope.FollowingOf != "":
		if userID == scope.FollowingOf {
			return true
		}
		_, ok := f.Follows[scope.FollowingOf][userID]
		return ok
	}
	return true
}

func (f *Fake) BoardTotals(_ context.Context, scope store.BoardScope, since time.Time) ([]store.BoardRow, error) {
	return f.boardTotals(scope, since, time.Time{})
}

func (f *Fake) BoardTotalsRange(_ context.Context, scope store.BoardScope, since, until time.Time) ([]store.BoardRow, error) {
	return f.boardTotals(scope, since, until)
}

func (f *Fake) boardTotals(scope store.BoardScope, since, until time.Time) ([]store.BoardRow, error) {
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
		var u *identity.User
		for _, cand := range f.Users {
			if cand.ID == eventUserID(f, e) {
				c := cand
				u = &c
				break
			}
		}
		if u == nil || !f.inScopeLocked(scope, u.ID) {
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
func eventUserID(f *Fake, e usage.UsageEvent) string {
	if m, ok := f.Machine[e.MachineID]; ok {
		return m.UserID
	}
	return ""
}

func (f *Fake) BoardDays(_ context.Context, scope store.BoardScope, since time.Time, limitDays int) (map[string][]time.Time, error) {
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
		if handle == "" || !f.inScopeLocked(scope, uid) {
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

func (f *Fake) ResolveUserByProvider(_ context.Context, provider, sub string) (identity.User, error) {
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
	return identity.User{}, sql.ErrNoRows
}

func (f *Fake) UserByHandle(_ context.Context, handle string) (identity.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.Users {
		if u.Handle == handle {
			return u, nil
		}
	}
	return identity.User{}, sql.ErrNoRows
}

func (f *Fake) UserByID(_ context.Context, id string) (identity.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.Users {
		if u.ID == id {
			return u, nil
		}
	}
	return identity.User{}, sql.ErrNoRows
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

func (f *Fake) UpdateUser(_ context.Context, userID, displayName, handle, avatarURL, bio string) (identity.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for h, u := range f.Users {
		if u.ID == userID {
			if handle != "" {
				for h2, u2 := range f.Users {
					if h2 != h && u2.Handle == handle {
						return identity.User{}, errTaken
					}
				}
				delete(f.Users, h)
				h = handle
				u.Handle = handle
			}
			if displayName != "" {
				u.DisplayName = displayName
			}
			if avatarURL != "" {
				u.AvatarURL = avatarURL
			}
			if bio != "" {
				u.Bio = bio
			}
			f.Users[h] = u
			return u, nil
		}
	}
	return identity.User{}, sql.ErrNoRows
}

func (f *Fake) CreateSession(_ context.Context, sess identity.Session) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Sessions[sess.TokenHash] = sess
	return nil
}

func (f *Fake) SessionByToken(_ context.Context, tokenHash string) (identity.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.Sessions[tokenHash]
	if !ok {
		return identity.Session{}, sql.ErrNoRows
	}
	return s, nil
}

func (f *Fake) DeleteSession(_ context.Context, tokenHash string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.Sessions, tokenHash)
	return nil
}

func (f *Fake) CreateTicket(_ context.Context, t identity.Ticket) error {
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

func (f *Fake) ClaimTicket(_ context.Context, state string) (identity.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.Tickets[state]
	if !ok || !t.RedeemedAt.IsZero() {
		return identity.Ticket{}, sql.ErrNoRows
	}
	out := t // pre-redeem snapshot for validation
	t.RedeemedAt = time.Now().UTC()
	f.Tickets[state] = t
	return out, nil
}

func (f *Fake) Ticket(_ context.Context, state string) (identity.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.Tickets[state]
	if !ok {
		return identity.Ticket{}, sql.ErrNoRows
	}
	return t, nil
}

func (f *Fake) CreateTeam(_ context.Context, id, slug, name, joinCode, ownerID string) (social.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := social.Team{ID: id, Slug: slug, Name: name, JoinCode: joinCode, OwnerID: ownerID, Role: "owner", Members: 1}
	f.Teams[id] = t
	f.TeamJoin[joinCode] = id
	f.TeamMemb[id] = map[string]string{ownerID: "owner"}
	return t, nil
}

func (f *Fake) MyTeams(_ context.Context, userID string) ([]social.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []social.Team
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

func (f *Fake) TeamByJoinCode(_ context.Context, code string) (social.Team, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.TeamJoin[code]
	if !ok {
		return social.Team{}, sql.ErrNoRows
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

func (f *Fake) CreateGroup(_ context.Context, id, teamID, slug, name, joinCode, ownerID string) (social.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	g := social.Group{ID: id, TeamID: teamID, Slug: slug, Name: name, JoinCode: joinCode, Role: "owner", Members: 1}
	f.Groups[id] = g
	f.GrpJoin[joinCode] = id
	f.GrpMemb[id] = map[string]string{ownerID: "owner"}
	return g, nil
}

func (f *Fake) GroupsByTeam(_ context.Context, teamID, userID string) ([]social.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []social.Group
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

func (f *Fake) GroupByJoinCode(_ context.Context, code string) (social.Group, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.GrpJoin[code]
	if !ok {
		return social.Group{}, sql.ErrNoRows
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

// --- follows ---

func (f *Fake) Follow(_ context.Context, followerID, followeeID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.Follows[followerID]
	if m == nil {
		m = map[string]time.Time{}
		f.Follows[followerID] = m
	}
	if _, ok := m[followeeID]; !ok {
		m[followeeID] = time.Now().UTC()
	}
	return nil
}

func (f *Fake) Unfollow(_ context.Context, followerID, followeeID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.Follows[followerID], followeeID)
	return nil
}

func (f *Fake) followUserLocked(id string, since time.Time) social.FollowUser {
	for _, u := range f.Users {
		if u.ID == id {
			return social.FollowUser{
				ID: u.ID, Handle: u.Handle, DisplayName: u.DisplayName,
				AvatarURL: u.AvatarURL, Bio: u.Bio, Since: since,
			}
		}
	}
	return social.FollowUser{ID: id, Since: since}
}

func (f *Fake) Followers(_ context.Context, userID string) ([]social.FollowUser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []social.FollowUser
	for follower, edges := range f.Follows {
		if since, ok := edges[userID]; ok {
			out = append(out, f.followUserLocked(follower, since))
		}
	}
	return out, nil
}

func (f *Fake) Following(_ context.Context, userID string) ([]social.FollowUser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []social.FollowUser
	for followee, since := range f.Follows[userID] {
		out = append(out, f.followUserLocked(followee, since))
	}
	return out, nil
}

func (f *Fake) IsFollowing(_ context.Context, followerID, followeeID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.Follows[followerID][followeeID]
	return ok, nil
}
