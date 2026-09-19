// Package ingest holds the ingest business logic: identity envelopes in,
// idempotent storage decisions out. It programs against the store port
// only — no HTTP, no SQL here.
package ingest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
)

// Batch caps: the daemon posts ≤500 rows per sync batch; refuse absurd
// payloads before they touch the store.
const (
	MaxEventsBatch = 2000
	MaxLimitsBatch = 2000
)

// Envelope is the identity frame on every daemon push (mirrors CloudSync:
// machine_id + alias identify the device, handle/team the logged-in user).
// UserID — the server-minted user UUID learned at Google/Microsoft login —
// pins attribution to that exact account when present; handle resolution
// is the fallback for daemons that never signed in.
type Envelope struct {
	MachineID    string `json:"machine_id"`
	MachineAlias string `json:"machine_alias"`
	Handle       string `json:"handle"`
	UserID       string `json:"user_id"`
	Team         string `json:"team"`
	Platform     string `json:"platform"`
}

func (e Envelope) Validate() error {
	if e.MachineID == "" {
		return errors.New("envelope: missing machine_id")
	}
	if e.UserID == "" && identity.NormalizeHandle(e.Handle) == "" {
		return errors.New("envelope: missing handle")
	}
	return nil
}

// Ingest coordinates one push batch: resolve the user (the logged-in human
// behind handle), register/touch the machine, then store rows idempotently.
// Unknown users are created on first sight — the handle IS the account.
type Ingest struct {
	Store store.Store
	Now   func() time.Time
}

func (in Ingest) now() time.Time {
	if in.Now != nil {
		return in.Now()
	}
	return time.Now().UTC()
}

// Events stores meter/MITM usage rows against the envelope's user.
func (in Ingest) Events(ctx context.Context, env Envelope, events []usage.UsageEvent) (Result, error) {
	if err := env.Validate(); err != nil {
		return Result{}, err
	}
	if len(events) > MaxEventsBatch {
		return Result{}, fmt.Errorf("events: batch of %d exceeds %d", len(events), MaxEventsBatch)
	}
	user, machine, err := in.identify(ctx, env)
	if err != nil {
		return Result{}, err
	}
	for i := range events {
		events[i].MachineID = machine.MachineID
		if err := events[i].Validate(); err != nil {
			return Result{}, fmt.Errorf("events[%d]: %w", i, err)
		}
	}
	accepted, duplicates, err := in.Store.InsertEvents(ctx, user.ID, events)
	if err != nil {
		return Result{}, err
	}
	return Result{User: user, Machine: machine, Accepted: accepted, Duplicates: duplicates}, nil
}

// Limits stores quota-window observations against the envelope's user.
func (in Ingest) Limits(ctx context.Context, env Envelope, snaps []usage.LimitSnapshot) (Result, error) {
	if err := env.Validate(); err != nil {
		return Result{}, err
	}
	if len(snaps) > MaxLimitsBatch {
		return Result{}, fmt.Errorf("limits: batch of %d exceeds %d", len(snaps), MaxLimitsBatch)
	}
	user, machine, err := in.identify(ctx, env)
	if err != nil {
		return Result{}, err
	}
	for i := range snaps {
		snaps[i].MachineID = machine.MachineID
		if snaps[i].ID == "" {
			snaps[i].ID = identity.NewID()
		}
		if err := snaps[i].Validate(); err != nil {
			return Result{}, fmt.Errorf("limits[%d]: %w", i, err)
		}
	}
	accepted, err := in.Store.InsertLimits(ctx, user.ID, snaps)
	if err != nil {
		return Result{}, err
	}
	return Result{User: user, Machine: machine, Accepted: accepted}, nil
}

// Result reports what one push did.
type Result struct {
	User       identity.User    `json:"user"`
	Machine    identity.Machine `json:"machine"`
	Accepted   int              `json:"accepted"`
	Duplicates int              `json:"duplicates,omitempty"`
}

// identify resolves the human and upserts the device under them. An
// explicit user_id (the server-minted UUID from login) wins: rows attribute
// to that exact account even if the local handle changed. Otherwise the
// handle IS the account (created on first sight). A machine that moves
// handles is re-homed: the device row follows the latest reporting user.
// Blank alias/platform never clobbers a known value (thin envelopes, e.g.
// MITM posts, omit them).
func (in Ingest) identify(ctx context.Context, env Envelope) (identity.User, identity.Machine, error) {
	var user identity.User
	var err error
	if env.UserID != "" {
		user, err = in.Store.UserByID(ctx, env.UserID)
		if err != nil {
			return identity.User{}, identity.Machine{}, errors.New("resolve user: unknown user_id")
		}
		// Signed-in accounts own their profile via PATCH /v1/users/me —
		// ingest never rewrites display fields for them.
	} else {
		handle := identity.NormalizeHandle(env.Handle)
		team := strings.TrimSpace(env.Team)
		user, err = in.Store.ResolveUser(ctx, handle, env.Handle, team)
		if err != nil {
			return identity.User{}, identity.Machine{}, fmt.Errorf("resolve user: %w", err)
		}
	}
	if known, err := in.Store.MachineByID(ctx, env.MachineID); err == nil {
		if env.MachineAlias == "" {
			env.MachineAlias = known.Alias
		}
		if env.Platform == "" {
			env.Platform = known.Platform
		}
	}
	machine, err := in.Store.RegisterMachine(ctx, identity.Machine{
		ID:        identity.NewID(),
		MachineID: env.MachineID,
		UserID:    user.ID,
		Alias:     env.MachineAlias,
		Platform:  env.Platform,
		LastSeen:  in.now(),
	})
	if err != nil {
		return identity.User{}, identity.Machine{}, fmt.Errorf("register machine: %w", err)
	}
	return user, machine, nil
}
