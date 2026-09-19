// Package account holds the profile-edit business logic for the logged-in
// user: display name, handle (username), avatar URL, bio.
package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
)

// Account edits the logged-in user's profile: display name, handle,
// avatar URL, bio. Handle changes keep uniqueness (collision → 409
// upstream).
type Account struct {
	Store store.Store
}

// Update applies a profile edit. Empty display name / avatar / bio keep the
// old values; handle is normalized + validated.
func (a Account) Update(ctx context.Context, userID, displayName, handle, avatarURL, bio string) (identity.User, error) {
	handle = identity.NormalizeHandle(handle)
	if handle != "" {
		if err := identity.ValidateHandle(handle); err != nil {
			return identity.User{}, err
		}
		if taken, err := a.Store.UserByHandle(ctx, handle); err == nil && taken.ID != userID {
			return identity.User{}, errors.New("handle taken")
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return identity.User{}, err
		}
	}
	return a.Store.UpdateUser(ctx, userID, strings.TrimSpace(displayName), handle, strings.TrimSpace(avatarURL), strings.TrimSpace(bio))
}
