package identity

import "time"

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
