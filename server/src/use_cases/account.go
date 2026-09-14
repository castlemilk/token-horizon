package usecases

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models"
)

// Account edits the logged-in user's profile: display name, handle,
// avatar URL. Handle changes keep uniqueness (collision → 409 upstream).
type Account struct {
	Store store.Store
}

// Update applies a profile edit. Empty display name keeps the old one;
// handle is normalized + validated; avatar URL sets the photo.
func (a Account) Update(ctx context.Context, userID, displayName, handle, avatarURL string) (models.User, error) {
	handle = models.NormalizeHandle(handle)
	if handle != "" {
		if err := models.ValidateHandle(handle); err != nil {
			return models.User{}, err
		}
		if taken, err := a.Store.UserByHandle(ctx, handle); err == nil && taken.ID != userID {
			return models.User{}, errors.New("handle taken")
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return models.User{}, err
		}
	}
	return a.Store.UpdateUser(ctx, userID, strings.TrimSpace(displayName), handle, strings.TrimSpace(avatarURL))
}
