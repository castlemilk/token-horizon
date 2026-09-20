// Package follows holds the follow/follower business logic: follow by
// handle, unfollow, and list either side of the graph. Edges are idempotent
// by primary key, so refollows and double-unfollows are harmless.
package follows

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/identity"
	"github.com/castlemilk/token-horizon/cloud/server/src/models/social"
)

// Follows manages the asymmetric follow graph between users.
type Follows struct {
	Store store.Store
}

// resolveTarget finds the follow target by handle (normalized).
func (f Follows) resolveTarget(ctx context.Context, handle string) (identity.User, error) {
	handle = identity.NormalizeHandle(handle)
	if handle == "" {
		return identity.User{}, errors.New("handle required")
	}
	target, err := f.Store.UserByHandle(ctx, handle)
	if errors.Is(err, sql.ErrNoRows) {
		return identity.User{}, errors.New("no such user")
	}
	if err != nil {
		return identity.User{}, err
	}
	return target, nil
}

// Follow makes userID follow handle (no self-follows; refollows no-op).
func (f Follows) Follow(ctx context.Context, userID, handle string) (social.FollowUser, error) {
	target, err := f.resolveTarget(ctx, handle)
	if err != nil {
		return social.FollowUser{}, err
	}
	if target.ID == userID {
		return social.FollowUser{}, errors.New("cannot follow yourself")
	}
	if err := f.Store.Follow(ctx, userID, target.ID); err != nil {
		return social.FollowUser{}, err
	}
	return social.FollowUser{
		ID: target.ID, Handle: target.Handle, DisplayName: target.DisplayName,
		AvatarURL: target.AvatarURL, Bio: target.Bio, Since: time.Now().UTC(),
	}, nil
}

// Unfollow removes the edge (idempotent).
func (f Follows) Unfollow(ctx context.Context, userID, handle string) error {
	target, err := f.resolveTarget(ctx, handle)
	if err != nil {
		return err
	}
	return f.Store.Unfollow(ctx, userID, target.ID)
}

// Followers lists who follows the caller; Following lists whom they follow.
func (f Follows) Followers(ctx context.Context, userID string) ([]social.FollowUser, error) {
	users, err := f.Store.Followers(ctx, userID)
	if users == nil {
		users = []social.FollowUser{}
	}
	return users, err
}

func (f Follows) Following(ctx context.Context, userID string) ([]social.FollowUser, error) {
	users, err := f.Store.Following(ctx, userID)
	if users == nil {
		users = []social.FollowUser{}
	}
	return users, err
}
