package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models"
)

// Identity + teams/groups persistence (002_identity schema). NULLIF keeps
// provider subs NULL when unlinked on both dialects.

// ResolveUserByProvider finds the user linked to a Google/Microsoft sub.
func (s *SQLStore) ResolveUserByProvider(ctx context.Context, provider, sub string) (models.User, error) {
	col := "google_sub"
	if provider == "microsoft" {
		col = "ms_sub"
	}
	var u models.User
	err := s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE `+col+` = $1`, sub).Scan(scanUser(&u)...)
	return u, err
}

// UserByHandle reads one user by handle (sql.ErrNoRows when free).
func (s *SQLStore) UserByHandle(ctx context.Context, handle string) (models.User, error) {
	var u models.User
	err := s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE handle = $1`, handle).Scan(scanUser(&u)...)
	return u, err
}

// UserByID reads one user by id.
func (s *SQLStore) UserByID(ctx context.Context, id string) (models.User, error) {
	var u models.User
	err := s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = $1`, id).Scan(scanUser(&u)...)
	return u, err
}

// LinkProvider attaches a provider sub to a user (unique per provider).
func (s *SQLStore) LinkProvider(ctx context.Context, userID, provider, sub, email, avatarURL string) error {
	col := "google_sub"
	if provider == "microsoft" {
		col = "ms_sub"
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET `+col+` = NULLIF($1, ''),
		 email = CASE WHEN COALESCE(email, '') = '' THEN $2 ELSE email END,
		 avatar_url = CASE WHEN COALESCE(avatar_url, '') = '' THEN $3 ELSE avatar_url END,
		 updated_at = $4 WHERE id = $5`,
		sub, email, avatarURL, time.Now().UTC(), userID)
	return err
}

// UpdateUser edits display profile fields. Empty display name keeps the old
// one; empty avatar URL keeps the old photo (removal is a separate,
// deliberate action); handle applies as given (uniqueness validated upstream).
func (s *SQLStore) UpdateUser(ctx context.Context, userID, displayName, handle, avatarURL string) (models.User, error) {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET
		 display_name = CASE WHEN $1 = '' THEN display_name ELSE $1 END,
		 handle = CASE WHEN $2 = '' THEN handle ELSE $2 END,
		 avatar_url = CASE WHEN $3 = '' THEN avatar_url ELSE $3 END,
		 updated_at = $4 WHERE id = $5`,
		displayName, handle, avatarURL, time.Now().UTC(), userID)
	if err != nil {
		return models.User{}, err
	}
	var u models.User
	err = s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = $1`, userID).Scan(scanUser(&u)...)
	return u, err
}

// CreateSession stores a session by token hash.
func (s *SQLStore) CreateSession(ctx context.Context, sess models.Session) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, provider, created_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		sess.TokenHash, sess.UserID, sess.Provider, sess.CreatedAt, sess.ExpiresAt)
	return err
}

// SessionByToken resolves a bearer token hash ("" user when missing).
func (s *SQLStore) SessionByToken(ctx context.Context, tokenHash string) (models.Session, error) {
	var sess models.Session
	err := s.db.QueryRowContext(ctx,
		`SELECT token_hash, user_id, provider, created_at, expires_at
		 FROM sessions WHERE token_hash = $1`, tokenHash).Scan(
		&sess.TokenHash, &sess.UserID, &sess.Provider, &sess.CreatedAt, &sess.ExpiresAt)
	return sess, err
}

// DeleteSession revokes one token; DeleteUserSessions revokes them all.
func (s *SQLStore) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// CreateTicket stores a login claim ticket.
func (s *SQLStore) CreateTicket(ctx context.Context, t models.Ticket) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO auth_tickets (state, session_id, created_at, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		t.State, t.SessionID, t.CreatedAt, t.ExpiresAt)
	return err
}

// AttachTicketSession records the completed login on the ticket.
func (s *SQLStore) AttachTicketSession(ctx context.Context, state, sessionID string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE auth_tickets SET session_id = $1 WHERE state = $2 AND redeemed_at IS NULL`,
		sessionID, state)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// Ticket reads one claim ticket without touching it.
func (s *SQLStore) Ticket(ctx context.Context, state string) (models.Ticket, error) {
	var t models.Ticket
	err := s.db.QueryRowContext(ctx,
		`SELECT state, session_id, redeemed_at, created_at, expires_at
		 FROM auth_tickets WHERE state = $1`, state).Scan(
		&t.State, &t.SessionID, &t.RedeemedAt, &t.CreatedAt, &t.ExpiresAt)
	return t, err
}

// ClaimTicket burns a ticket exactly once, returning its pre-redeem state
// for validation (concurrent claims lose the UPDATE race → ErrNoRows).
func (s *SQLStore) ClaimTicket(ctx context.Context, state string) (models.Ticket, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return models.Ticket{}, err
	}
	defer tx.Rollback()
	var t models.Ticket
	err = tx.QueryRowContext(ctx,
		`SELECT state, session_id, redeemed_at, created_at, expires_at
		 FROM auth_tickets WHERE state = $1`, state).Scan(
		&t.State, &t.SessionID, &t.RedeemedAt, &t.CreatedAt, &t.ExpiresAt)
	if err != nil {
		return models.Ticket{}, err
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE auth_tickets SET redeemed_at = $1
		 WHERE state = $2 AND redeemed_at IS NULL AND expires_at > $1`, time.Now().UTC(), state)
	if err != nil {
		return models.Ticket{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return models.Ticket{}, sql.ErrNoRows
	}
	return t, tx.Commit()
}

// --- teams ---

// memberTable describes a membership join (table/column names are internal
// constants — never interpolated from input).
type memberTable struct {
	member string // join table
	idCol  string // parent id column in the join
	parent string // parent table to prune when emptied
}

var (
	teamMembership  = memberTable{"team_members", "team_id", "teams"}
	groupMembership = memberTable{"group_members", "group_id", "groups"}
)

func (s *SQLStore) addMember(ctx context.Context, t memberTable, id, userID, role string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO `+t.member+` (`+t.idCol+`, user_id, role, joined_at)
		 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
		id, userID, role, time.Now().UTC())
	return err
}

func (s *SQLStore) isMember(ctx context.Context, t memberTable, id, userID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM `+t.member+` WHERE `+t.idCol+` = $1 AND user_id = $2`, id, userID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// leaveAndPrune parts a member, deleting the parent when emptied so invite
// codes never dangle.
func (s *SQLStore) leaveAndPrune(ctx context.Context, t memberTable, id, userID string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM `+t.member+` WHERE `+t.idCol+` = $1 AND user_id = $2`, id, userID); err != nil {
		return err
	}
	var left int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM `+t.member+` WHERE `+t.idCol+` = $1`, id).Scan(&left); err != nil {
		return err
	}
	if left == 0 {
		_, err := s.db.ExecContext(ctx, `DELETE FROM `+t.parent+` WHERE id = $1`, id)
		return err
	}
	return nil
}

// CreateTeam makes a team (creator becomes owner) with a fresh join code.
func (s *SQLStore) CreateTeam(ctx context.Context, id, slug, name, joinCode, ownerID string) (models.Team, error) {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return models.Team{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO teams (id, slug, name, join_code, owner_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`, id, slug, name, joinCode, ownerID, now); err != nil {
		return models.Team{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at)
		 VALUES ($1, $2, 'owner', $3)`, id, ownerID, now); err != nil {
		return models.Team{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.Team{}, err
	}
	return models.Team{ID: id, Slug: slug, Name: name, JoinCode: joinCode, OwnerID: ownerID, Role: "owner", Members: 1, CreatedAt: now}, nil
}

// MyTeams lists a user's teams with their role and member counts.
func (s *SQLStore) MyTeams(ctx context.Context, userID string) ([]models.Team, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT t.id, t.slug, t.name, t.owner_id, tm.role,
		        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id), t.created_at
		 FROM teams t JOIN team_members tm ON tm.team_id = t.id
		 WHERE tm.user_id = $1 ORDER BY t.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Team
	for rows.Next() {
		var t models.Team
		if err := rows.Scan(&t.ID, &t.Slug, &t.Name, &t.OwnerID, &t.Role, &t.Members, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TeamByJoinCode resolves an invite code.
func (s *SQLStore) TeamByJoinCode(ctx context.Context, code string) (models.Team, error) {
	var t models.Team
	err := s.db.QueryRowContext(ctx,
		`SELECT id, slug, name, owner_id, created_at FROM teams WHERE join_code = $1`, code).Scan(
		&t.ID, &t.Slug, &t.Name, &t.OwnerID, &t.CreatedAt)
	return t, err
}

// AddTeamMember joins (idempotent); LeaveTeamMember parts. Empty teams are
// pruned so invite codes never dangle.
func (s *SQLStore) AddTeamMember(ctx context.Context, teamID, userID, role string) error {
	return s.addMember(ctx, teamMembership, teamID, userID, role)
}

// IsTeamMember reports membership (any role).
func (s *SQLStore) IsTeamMember(ctx context.Context, teamID, userID string) (bool, error) {
	return s.isMember(ctx, teamMembership, teamID, userID)
}

func (s *SQLStore) LeaveTeamMember(ctx context.Context, teamID, userID string) error {
	return s.leaveAndPrune(ctx, teamMembership, teamID, userID)
}

// --- groups (team-scoped) ---

// CreateGroup makes a group inside a team (creator becomes owner).
func (s *SQLStore) CreateGroup(ctx context.Context, id, teamID, slug, name, joinCode, ownerID string) (models.Group, error) {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return models.Group{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO groups (id, team_id, slug, name, join_code, owner_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`, id, teamID, slug, name, joinCode, ownerID, now); err != nil {
		return models.Group{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id, role, joined_at)
		 VALUES ($1, $2, 'owner', $3)`, id, ownerID, now); err != nil {
		return models.Group{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.Group{}, err
	}
	return models.Group{ID: id, TeamID: teamID, Slug: slug, Name: name, JoinCode: joinCode, Role: "owner", Members: 1, CreatedAt: now}, nil
}

// GroupsByTeam lists a team's groups with the caller's role + counts.
func (s *SQLStore) GroupsByTeam(ctx context.Context, teamID, userID string) ([]models.Group, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT g.id, g.team_id, g.slug, g.name,
		        COALESCE((SELECT role FROM group_members WHERE group_id = g.id AND user_id = $2), ''),
		        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id), g.created_at
		 FROM groups g WHERE g.team_id = $1 ORDER BY g.created_at`, teamID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Group
	for rows.Next() {
		var g models.Group
		if err := rows.Scan(&g.ID, &g.TeamID, &g.Slug, &g.Name, &g.Role, &g.Members, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GroupByJoinCode resolves a group invite.
func (s *SQLStore) GroupByJoinCode(ctx context.Context, code string) (models.Group, error) {
	var g models.Group
	err := s.db.QueryRowContext(ctx,
		`SELECT id, team_id, slug, name, owner_id, created_at FROM groups WHERE join_code = $1`, code).Scan(
		&g.ID, &g.TeamID, &g.Slug, &g.Name, &g.OwnerID, &g.CreatedAt)
	return g, err
}

// AddGroupMember joins (idempotent); LeaveGroupMember parts (prunes empties).
func (s *SQLStore) AddGroupMember(ctx context.Context, groupID, userID, role string) error {
	return s.addMember(ctx, groupMembership, groupID, userID, role)
}

func (s *SQLStore) LeaveGroupMember(ctx context.Context, groupID, userID string) error {
	return s.leaveAndPrune(ctx, groupMembership, groupID, userID)
}
