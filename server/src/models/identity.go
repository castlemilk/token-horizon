package models

import (
	"errors"
	"strings"
	"time"
)

// Identity additions: login, sessions, avatars, teams, groups.
// Users table gains email/avatar_url/google_sub/ms_sub (002_identity).

// Session is an opaque bearer token (sha256 stored, plaintext shown once).
type Session struct {
	TokenHash string    `json:"-"`
	UserID    string    `json:"user_id"`
	Provider  string    `json:"provider"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Expired reports whether the session is past its TTL.
func (s Session) Expired(now time.Time) bool { return !now.Before(s.ExpiresAt) }

// Ticket bridges the browser OAuth dance back to the desktop app: the
// login step mints a state, the provider callback attaches a session to it,
// and the app claims it exactly once (then it burns).
type Ticket struct {
	State      string    `json:"state"`
	SessionID  string    `json:"-"`
	RedeemedAt time.Time `json:"-"`
	CreatedAt  time.Time `json:"-"`
	ExpiresAt  time.Time `json:"-"`
}

// Claimable reports whether Claim may still redeem the ticket.
func (t Ticket) Claimable(now time.Time) bool {
	return t.SessionID != "" && t.RedeemedAt.IsZero() && now.Before(t.ExpiresAt)
}

// Team groups users (leaderboards, shared quotas later). JoinCode is the
// human-passable invite; Slug is URL identity.
type Team struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	JoinCode  string    `json:"join_code,omitempty"`
	OwnerID   string    `json:"-"`
	Role      string    `json:"role,omitempty"`
	Members   int       `json:"members,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Group is a team-scoped circle with its own invite code.
type Group struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"team_id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	JoinCode  string    `json:"join_code,omitempty"`
	OwnerID   string    `json:"-"`
	Role      string    `json:"role,omitempty"`
	Members   int       `json:"members,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Slugify folds a name to URL identity: lowercase alnum + dashes, ≤32.
func Slugify(raw string) string {
	var out strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				out.WriteRune('-')
				lastDash = true
			}
		}
		if out.Len() >= 32 {
			break
		}
	}
	return strings.Trim(out.String(), "-")
}

// ValidateHandle enforces the account-handle contract for edits.
func ValidateHandle(h string) error {
	h = NormalizeHandle(h)
	if len(h) < 2 || len(h) > 32 {
		return errors.New("handle must be 2-32 chars")
	}
	for _, r := range h {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return errors.New("handle: lowercase letters, digits, - and _ only")
		}
	}
	return nil
}
