// Package usecases holds the business logic: envelopes in, decisions out.
// It programs against the store port only — no HTTP, no SQL here.
package usecases

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models"
)

// Batch caps: the daemon posts ≤500 rows per sync batch; refuse absurd
// payloads before they touch the store.
const (
	MaxEventsBatch = 2000
	MaxLimitsBatch = 2000
)

// Envelope is the identity frame on every daemon push (mirrors CloudSync:
// machine_id + alias identify the device, handle/team the logged-in user).
type Envelope struct {
	MachineID    string `json:"machine_id"`
	MachineAlias string `json:"machine_alias"`
	Handle       string `json:"handle"`
	Team         string `json:"team"`
	Platform     string `json:"platform"`
}

func (e Envelope) Validate() error {
	if e.MachineID == "" {
		return errors.New("envelope: missing machine_id")
	}
	if models.NormalizeHandle(e.Handle) == "" {
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
func (in Ingest) Events(ctx context.Context, env Envelope, events []models.UsageEvent) (Result, error) {
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
func (in Ingest) Limits(ctx context.Context, env Envelope, snaps []models.LimitSnapshot) (Result, error) {
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
			snaps[i].ID = newID()
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
	User       models.User    `json:"user"`
	Machine    models.Machine `json:"machine"`
	Accepted   int            `json:"accepted"`
	Duplicates int            `json:"duplicates,omitempty"`
}

// identify resolves the human (handle → user, created on first sight) and
// upserts the device under them. A machine that moves handles is re-homed:
// the device row follows the latest reporting user. Blank alias/platform
// never clobbers a known value (thin envelopes, e.g. MITM posts, omit them).
func (in Ingest) identify(ctx context.Context, env Envelope) (models.User, models.Machine, error) {
	handle := models.NormalizeHandle(env.Handle)
	team := strings.TrimSpace(env.Team)
	user, err := in.Store.ResolveUser(ctx, handle, env.Handle, team)
	if err != nil {
		return models.User{}, models.Machine{}, fmt.Errorf("resolve user: %w", err)
	}
	if known, err := in.Store.MachineByID(ctx, env.MachineID); err == nil {
		if env.MachineAlias == "" {
			env.MachineAlias = known.Alias
		}
		if env.Platform == "" {
			env.Platform = known.Platform
		}
	}
	machine, err := in.Store.RegisterMachine(ctx, models.Machine{
		ID:        newID(),
		MachineID: env.MachineID,
		UserID:    user.ID,
		Alias:     env.MachineAlias,
		Platform:  env.Platform,
		LastSeen:  in.now(),
	})
	if err != nil {
		return models.User{}, models.Machine{}, fmt.Errorf("register machine: %w", err)
	}
	return user, machine, nil
}
