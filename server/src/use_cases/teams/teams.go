// Package teams holds the team and group business logic: create with a
// join code, join by code, leave (empties prune themselves). Groups always
// live inside a team; only team members may create or join that team's
// groups.
package teams

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/models/social"
)

// Teams manages multi-team and group membership.
type Teams struct {
	Store store.Store
	Now   func() time.Time
}

var joinAlphabet = []byte("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

func joinCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = joinAlphabet[int(b[i])%len(joinAlphabet)]
	}
	return string(b), nil
}

// CreateTeam makes a team; the caller becomes its owner.
func (t Teams) CreateTeam(ctx context.Context, ownerID, name string) (social.Team, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return social.Team{}, errors.New("name required")
	}
	slug := social.Slugify(name)
	if slug == "" {
		slug = "team"
	}
	for attempt := 0; ; attempt++ {
		try := slug
		if attempt > 0 {
			try = fmt.Sprintf("%s-%d", slug, attempt)
		}
		code, err := joinCode()
		if err != nil {
			return social.Team{}, err
		}
		team, err := t.Store.CreateTeam(ctx, identity.NewID(), try, name, code, ownerID)
		if err == nil {
			return team, nil
		}
		if attempt > 8 {
			return social.Team{}, err
		}
	}
}

// MyTeams lists the caller's teams.
func (t Teams) MyTeams(ctx context.Context, userID string) ([]social.Team, error) {
	teams, err := t.Store.MyTeams(ctx, userID)
	if err != nil {
		return nil, err
	}
	if teams == nil {
		teams = []social.Team{}
	}
	return teams, nil
}

// JoinTeam redeems an invite code.
func (t Teams) JoinTeam(ctx context.Context, userID, code string) (social.Team, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	team, err := t.Store.TeamByJoinCode(ctx, code)
	if errors.Is(err, sql.ErrNoRows) {
		return social.Team{}, errors.New("unknown invite code")
	}
	if err != nil {
		return social.Team{}, err
	}
	if member, err := t.Store.IsTeamMember(ctx, team.ID, userID); err != nil {
		return social.Team{}, err
	} else if member {
		return social.Team{}, errors.New("already a member")
	}
	if err := t.Store.AddTeamMember(ctx, team.ID, userID, "member"); err != nil {
		return social.Team{}, err
	}
	team.Role = "member"
	return team, nil
}

// LeaveTeam parts a team (empties prune themselves server-side).
func (t Teams) LeaveTeam(ctx context.Context, userID, teamID string) error {
	return t.Store.LeaveTeamMember(ctx, teamID, userID)
}

// CreateGroup makes a group inside a team the caller belongs to.
func (t Teams) CreateGroup(ctx context.Context, userID, teamID, name string) (social.Group, error) {
	member, err := t.Store.IsTeamMember(ctx, teamID, userID)
	if err != nil {
		return social.Group{}, err
	}
	if !member {
		return social.Group{}, errors.New("not a team member")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return social.Group{}, errors.New("name required")
	}
	slug := social.Slugify(name)
	if slug == "" {
		slug = "group"
	}
	for attempt := 0; ; attempt++ {
		try := slug
		if attempt > 0 {
			try = fmt.Sprintf("%s-%d", slug, attempt)
		}
		code, err := joinCode()
		if err != nil {
			return social.Group{}, err
		}
		group, err := t.Store.CreateGroup(ctx, identity.NewID(), teamID, try, name, code, userID)
		if err == nil {
			return group, nil
		}
		if attempt > 8 {
			return social.Group{}, err
		}
	}
}

// Groups lists a team's groups (caller must belong).
func (t Teams) Groups(ctx context.Context, userID, teamID string) ([]social.Group, error) {
	member, err := t.Store.IsTeamMember(ctx, teamID, userID)
	if err != nil {
		return nil, err
	}
	if !member {
		return nil, errors.New("not a team member")
	}
	groups, err := t.Store.GroupsByTeam(ctx, teamID, userID)
	if err != nil {
		return nil, err
	}
	if groups == nil {
		groups = []social.Group{}
	}
	return groups, nil
}

// JoinGroup redeems a group invite (caller must belong to its team).
func (t Teams) JoinGroup(ctx context.Context, userID, code string) (social.Group, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	group, err := t.Store.GroupByJoinCode(ctx, code)
	if errors.Is(err, sql.ErrNoRows) {
		return social.Group{}, errors.New("unknown invite code")
	}
	if err != nil {
		return social.Group{}, err
	}
	member, err := t.Store.IsTeamMember(ctx, group.TeamID, userID)
	if err != nil {
		return social.Group{}, err
	}
	if !member {
		return social.Group{}, errors.New("join the team first")
	}
	if err := t.Store.AddGroupMember(ctx, group.ID, userID, "member"); err != nil {
		return social.Group{}, err
	}
	group.Role = "member"
	return group, nil
}

// LeaveGroup parts a group (empties prune themselves server-side).
func (t Teams) LeaveGroup(ctx context.Context, userID, groupID string) error {
	return t.Store.LeaveGroupMember(ctx, groupID, userID)
}
