// Package identity holds the identity primitives: the logged-in human
// (User), their devices (Machine), login sessions and OAuth claim tickets.
// Plain data + validation, no I/O, no business rules. Field names mirror
// the Swift Core contracts so the wire stays obvious.
package identity

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// User is one logged-in human. ID is a server-minted UUID that never
// changes; Handle is the identity the daemon reports (TH_SYNC_HANDLE,
// defaulting to the OS username) — unique, human-meaningful. Email/avatar/
// provider links fill in once the user signs in with Google or Microsoft;
// provider subs are "" when unlinked and are LINKS, never the user id.
type User struct {
	ID          string `json:"id"`
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
	Team        string `json:"team"`
	Email       string `json:"email,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Bio         string `json:"bio,omitempty"`
	GoogleSub   string `json:"-"`
	MSSub       string `json:"-"`
	// Geo hint for the leaderboard flag: the daemon's last caller IP.
	// country_code fills in when the IP→country mapping lands.
	LastIP      string    `json:"-"`
	CountryCode string    `json:"country_code,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Machine is one device reporting to the server, always owned by a user.
// MachineID is the stable per-device UUID minted by the daemon;
// Alias is the display label (never identity).
type Machine struct {
	ID        string    `json:"id"`
	MachineID string    `json:"machine_id"`
	UserID    string    `json:"user_id"`
	Alias     string    `json:"alias"`
	Platform  string    `json:"platform"`
	LastSeen  time.Time `json:"last_seen_at"`
	CreatedAt time.Time `json:"created_at"`
}

// NormalizeHandle folds a reported handle to canonical form (the daemon
// sends the OS username verbatim; matching must be case/space-insensitive).
func NormalizeHandle(h string) string {
	return strings.ToLower(strings.TrimSpace(h))
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

// NewID mints a random UUIDv4-shaped hex id (no external deps for identity).
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("identity: no entropy: " + err.Error())
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	hexed := hex.EncodeToString(b[:])
	return hexed[:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:]
}
