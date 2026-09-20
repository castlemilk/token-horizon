// Package social holds the social-graph primitives: teams, team-scoped
// groups, and the follow/follower views. Plain data + validation only.
package social

import (
	"strings"
	"time"
)

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

// FollowUser is one user as seen through the follow graph (public fields
// only; Since is when the follow edge was created).
type FollowUser struct {
	ID          string    `json:"id"`
	Handle      string    `json:"handle"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Bio         string    `json:"bio,omitempty"`
	Since       time.Time `json:"since"`
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
