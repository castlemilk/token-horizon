// SQLStore implements the store port over database/sql. One code path
// serves Postgres and DuckDB: $n placeholders, no RETURNING, upserts via
// UPDATE-then-INSERT (portable), idempotent writes via ON CONFLICT DO
// NOTHING (supported by both). Drivers register in cmd (pq always,
// go-duckdb behind the `duckdb` build tag).
package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/castlemilk/token-horizon/server/src/models"
)

// SQLStore is a *sql.DB over a migrated schema (see migrations/).
type SQLStore struct {
	db *sql.DB
}

// Open validates connectivity with a ping.
func Open(driver, dsn string) (*SQLStore, error) {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &SQLStore{db: db}, nil
}

// Close releases the pool.
func (s *SQLStore) Close() error { return s.db.Close() }

// ResolveUser finds the user by normalized handle, creating on first sight.
// Team/display refresh on every report (latest wins, cheap and truthful).
func (s *SQLStore) ResolveUser(ctx context.Context, handle, displayName, team string) (models.User, error) {
	var u models.User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, handle, display_name, team, created_at, updated_at FROM users WHERE handle = $1`, handle).Scan(
		&u.ID, &u.Handle, &u.DisplayName, &u.Team, &u.CreatedAt, &u.UpdatedAt)
	switch {
	case err == nil:
		if u.DisplayName != displayName || u.Team != team {
			_, err = s.db.ExecContext(ctx,
				`UPDATE users SET display_name = $1, team = $2, updated_at = $3 WHERE id = $4`,
				displayName, team, time.Now().UTC(), u.ID)
			if err != nil {
				return models.User{}, err
			}
			u.DisplayName, u.Team = displayName, team
		}
		return u, nil
	case err == sql.ErrNoRows:
		now := time.Now().UTC()
		u = models.User{ID: newID(), Handle: handle, DisplayName: displayName, Team: team, CreatedAt: now, UpdatedAt: now}
		_, err = s.db.ExecContext(ctx,
			`INSERT INTO users (id, handle, display_name, team, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
			u.ID, u.Handle, u.DisplayName, u.Team, u.CreatedAt, u.UpdatedAt)
		if err != nil {
			return models.User{}, err
		}
		// Lost a creation race: read the winner.
		if u.ID != "" {
			var check models.User
			if rerr := s.db.QueryRowContext(ctx,
				`SELECT id, handle, display_name, team, created_at, updated_at FROM users WHERE handle = $1`, handle).Scan(
				&check.ID, &check.Handle, &check.DisplayName, &check.Team, &check.CreatedAt, &check.UpdatedAt); rerr == nil {
				return check, nil
			}
		}
		return u, nil
	default:
		return models.User{}, err
	}
}

// RegisterMachine upserts the device under its current user (re-homes on
// handle moves) and touches last_seen. Returns the stored row.
func (s *SQLStore) RegisterMachine(ctx context.Context, m models.Machine) (models.Machine, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE machines SET user_id = $1, alias = $2, platform = $3, last_seen_at = $4 WHERE machine_id = $5`,
		m.UserID, m.Alias, m.Platform, m.LastSeen, m.MachineID)
	if err != nil {
		return models.Machine{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		now := time.Now().UTC()
		if m.ID == "" {
			m.ID = newID()
		}
		if m.LastSeen.IsZero() {
			m.LastSeen = now
		}
		m.CreatedAt = now
		_, err = s.db.ExecContext(ctx,
			`INSERT INTO machines (id, machine_id, user_id, alias, platform, last_seen_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
			m.ID, m.MachineID, m.UserID, m.Alias, m.Platform, m.LastSeen, m.CreatedAt)
		if err != nil {
			return models.Machine{}, err
		}
	}
	return s.MachineByID(ctx, m.MachineID)
}

// MachineByID reads one device by its stable daemon UUID.
func (s *SQLStore) MachineByID(ctx context.Context, machineID string) (models.Machine, error) {
	var m models.Machine
	err := s.db.QueryRowContext(ctx,
		`SELECT id, machine_id, user_id, alias, platform, last_seen_at, created_at
		 FROM machines WHERE machine_id = $1`, machineID).Scan(
		&m.ID, &m.MachineID, &m.UserID, &m.Alias, &m.Platform, &m.LastSeen, &m.CreatedAt)
	if err != nil {
		return models.Machine{}, err
	}
	return m, nil
}

// Machines lists a user's fleet, most-recently-seen first.
func (s *SQLStore) Machines(ctx context.Context, userID string) ([]models.Machine, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, machine_id, user_id, alias, platform, last_seen_at, created_at
		 FROM machines WHERE user_id = $1 ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Machine
	for rows.Next() {
		var m models.Machine
		if err := rows.Scan(&m.ID, &m.MachineID, &m.UserID, &m.Alias, &m.Platform, &m.LastSeen, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// InsertEvents stores usage rows idempotently: the event UUID primary key
// makes redelivery a no-op (duplicates counted via rows-affected math).
func (s *SQLStore) InsertEvents(ctx context.Context, userID string, events []models.UsageEvent) (accepted, duplicates int, err error) {
	if len(events) == 0 {
		return 0, 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO usage_events
		 (id, user_id, machine_id, ts, source, vendor, model,
		  input, output, reasoning, cache_read, cache_write,
		  cost, cost_source, session_id, product, account_id, request_id, attestation)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		 ON CONFLICT DO NOTHING`)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()
	for i := range events {
		e := events[i]
		res, err := stmt.ExecContext(ctx,
			e.ID, userID, e.MachineID, e.Timestamp.UTC(), e.Source, e.Vendor, e.Model,
			e.Tokens.Input, e.Tokens.Output, e.Tokens.Reasoning, e.Tokens.CacheRead, e.Tokens.CacheWrite,
			e.Cost, e.CostSource, e.SessionID, e.Product, e.AccountID, e.RequestID, e.Attestation)
		if err != nil {
			return accepted, duplicates, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			duplicates++
		} else {
			accepted++
		}
	}
	return accepted, duplicates, tx.Commit()
}

// InsertLimits stores quota observations; dedup key is the natural
// (machine, provider, account, label, minute) — retries collapse.
func (s *SQLStore) InsertLimits(ctx context.Context, userID string, snaps []models.LimitSnapshot) (int, error) {
	if len(snaps) == 0 {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO limit_snapshots
		 (id, user_id, machine_id, recorded_at, provider, account_id, label,
		  used_percent, resets_at, detail, dedup_key)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		 ON CONFLICT DO NOTHING`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	accepted := 0
	for i := range snaps {
		sn := snaps[i]
		var resets any
		if sn.HasReset {
			resets = sn.ResetsAt.UTC()
		}
		key := sn.MachineID + "|" + sn.Provider + "|" + sn.AccountID + "|" + sn.Label +
			"|" + sn.RecordedAt.UTC().Truncate(time.Minute).Format(time.RFC3339)
		res, err := stmt.ExecContext(ctx,
			sn.ID, userID, sn.MachineID, sn.RecordedAt.UTC(), sn.Provider, sn.AccountID, sn.Label,
			sn.UsedPercent, resets, sn.Detail, key)
		if err != nil {
			return accepted, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			accepted++
		}
	}
	return accepted, tx.Commit()
}

// HighWater reports server-side high-water for one device (reconciliation:
// the daemon compares these against local cursors after offline stretches).
func (s *SQLStore) HighWater(ctx context.Context, machineID string) (eventsMaxTS time.Time, eventsCount int64, limitsMaxTS time.Time, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(ts), '1970-01-01T00:00:00Z'), COUNT(*) FROM usage_events WHERE machine_id = $1`,
		machineID).Scan(&eventsMaxTS, &eventsCount)
	if err != nil {
		return time.Time{}, 0, time.Time{}, err
	}
	err = s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(recorded_at), '1970-01-01T00:00:00Z') FROM limit_snapshots WHERE machine_id = $1`,
		machineID).Scan(&limitsMaxTS)
	if err != nil {
		return time.Time{}, 0, time.Time{}, err
	}
	return eventsMaxTS, eventsCount, limitsMaxTS, nil
}

// UsageSummary rolls rows up per vendor+model over a window, scoped to a
// user, a team, or (neither given) everything the caller may see. Callers
// aggregate these rows into leaderboards — ranking state never persists.
func (s *SQLStore) UsageSummary(ctx context.Context, q SummaryQuery) ([]VendorSummary, error) {
	const base = `
		SELECT e.vendor, e.model,
		       COALESCE(SUM(e.input+e.output+e.reasoning+e.cache_read+e.cache_write),0),
		       COALESCE(SUM(e.cost),0), COUNT(*)
		FROM usage_events e JOIN users u ON u.id = e.user_id`
	var where []string
	var args []any
	if q.Handle != "" {
		where = append(where, "u.handle = $"+itoa(len(args)+1))
		args = append(args, q.Handle)
	}
	if q.Team != "" {
		where = append(where, "u.team = $"+itoa(len(args)+1))
		args = append(args, q.Team)
	}
	if !q.Since.IsZero() {
		where = append(where, "e.ts >= $"+itoa(len(args)+1))
		args = append(args, q.Since.UTC())
	}
	if q.Vendor != "" {
		where = append(where, "e.vendor = $"+itoa(len(args)+1))
		args = append(args, q.Vendor)
	}
	query := base
	if len(where) > 0 {
		query += " WHERE " + joinAnd(where)
	}
	query += " GROUP BY e.vendor, e.model ORDER BY 3 DESC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VendorSummary
	for rows.Next() {
		var v VendorSummary
		if err := rows.Scan(&v.Vendor, &v.Model, &v.Tokens, &v.Cost, &v.Requests); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// SetCursor records a sync cursor (dataset × machine).
func (s *SQLStore) SetCursor(ctx context.Context, dataset, machineID, cursor string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE sync_state SET cursor = $1, updated_at = $2 WHERE dataset = $3 AND machine_id = $4`,
		cursor, time.Now().UTC(), dataset, machineID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO sync_state (dataset, machine_id, cursor, updated_at)
		 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
		dataset, machineID, cursor, time.Now().UTC())
	return err
}

// Cursor reads a sync cursor ("" when never set).
func (s *SQLStore) Cursor(ctx context.Context, dataset, machineID string) (string, error) {
	var c string
	err := s.db.QueryRowContext(ctx,
		`SELECT cursor FROM sync_state WHERE dataset = $1 AND machine_id = $2`,
		dataset, machineID).Scan(&c)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return c, err
}
