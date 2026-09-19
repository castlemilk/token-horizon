// SQLStore implements the store port over database/sql. One code path
// serves Postgres and DuckDB: $n placeholders, no RETURNING, upserts via
// UPDATE-then-INSERT (portable), idempotent writes via ON CONFLICT DO
// NOTHING (supported by both). Drivers register in cmd (pq always,
// go-duckdb behind the `duckdb` build tag).
package sqlstore

import (
	"context"
	"database/sql"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
	"github.com/castlemilk/token-horizon/server/src/models/usage"
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

// userColumns is the full user projection; COALESCE keeps both dialects
// on plain strings (provider subs are NULL when unlinked).
const userColumns = `id, handle, display_name, team,
	COALESCE(email, ''), COALESCE(avatar_url, ''), COALESCE(bio, ''),
	COALESCE(google_sub, ''), COALESCE(ms_sub, ''),
	created_at, updated_at`

func scanUser(u *identity.User) []any {
	return []any{&u.ID, &u.Handle, &u.DisplayName, &u.Team,
		&u.Email, &u.AvatarURL, &u.Bio, &u.GoogleSub, &u.MSSub,
		&u.CreatedAt, &u.UpdatedAt}
}

// ResolveUser finds the user by normalized handle, creating on first sight.
// Team/display refresh on every report (latest wins, cheap and truthful).
func (s *SQLStore) ResolveUser(ctx context.Context, handle, displayName, team string) (identity.User, error) {
	var u identity.User
	err := s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE handle = $1`, handle).Scan(scanUser(&u)...)
	switch {
	case err == nil:
		if u.DisplayName != displayName || u.Team != team {
			_, err = s.db.ExecContext(ctx,
				`UPDATE users SET display_name = $1, team = $2, updated_at = $3 WHERE id = $4`,
				displayName, team, time.Now().UTC(), u.ID)
			if err != nil {
				return identity.User{}, err
			}
			u.DisplayName, u.Team = displayName, team
		}
		return u, nil
	case err == sql.ErrNoRows:
		now := time.Now().UTC()
		u = identity.User{ID: identity.NewID(), Handle: handle, DisplayName: displayName, Team: team, CreatedAt: now, UpdatedAt: now}
		_, err = s.db.ExecContext(ctx,
			`INSERT INTO users (id, handle, display_name, team, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
			u.ID, u.Handle, u.DisplayName, u.Team, u.CreatedAt, u.UpdatedAt)
		if err != nil {
			return identity.User{}, err
		}
		// Lost a creation race: read the winner.
		if u.ID != "" {
			var check identity.User
			if rerr := s.db.QueryRowContext(ctx,
				`SELECT `+userColumns+` FROM users WHERE handle = $1`, handle).Scan(scanUser(&check)...); rerr == nil {
				return check, nil
			}
		}
		return u, nil
	default:
		return identity.User{}, err
	}
}

// RegisterMachine upserts the device under its current user (re-homes on
// handle moves) and touches last_seen. Returns the stored row.
func (s *SQLStore) RegisterMachine(ctx context.Context, m identity.Machine) (identity.Machine, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE machines SET user_id = $1, alias = $2, platform = $3, last_seen_at = $4 WHERE machine_id = $5`,
		m.UserID, m.Alias, m.Platform, m.LastSeen, m.MachineID)
	if err != nil {
		return identity.Machine{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		now := time.Now().UTC()
		if m.ID == "" {
			m.ID = identity.NewID()
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
			return identity.Machine{}, err
		}
	}
	return s.MachineByID(ctx, m.MachineID)
}

// MachineByID reads one device by its stable daemon UUID.
func (s *SQLStore) MachineByID(ctx context.Context, machineID string) (identity.Machine, error) {
	var m identity.Machine
	err := s.db.QueryRowContext(ctx,
		`SELECT id, machine_id, user_id, alias, platform, last_seen_at, created_at
		 FROM machines WHERE machine_id = $1`, machineID).Scan(
		&m.ID, &m.MachineID, &m.UserID, &m.Alias, &m.Platform, &m.LastSeen, &m.CreatedAt)
	if err != nil {
		return identity.Machine{}, err
	}
	return m, nil
}

// Machines lists a user's fleet, most-recently-seen first.
func (s *SQLStore) Machines(ctx context.Context, userID string) ([]identity.Machine, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, machine_id, user_id, alias, platform, last_seen_at, created_at
		 FROM machines WHERE user_id = $1 ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []identity.Machine
	for rows.Next() {
		var m identity.Machine
		if err := rows.Scan(&m.ID, &m.MachineID, &m.UserID, &m.Alias, &m.Platform, &m.LastSeen, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// InsertEvents stores usage rows idempotently: the event UUID primary key
// makes redelivery a no-op (duplicates counted via rows-affected math).
func (s *SQLStore) InsertEvents(ctx context.Context, userID string, events []usage.UsageEvent) (accepted, duplicates int, err error) {
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
	// Record every pushed row in the delta-sync reference table (same tx),
	// including duplicates: refs converge even if a past ref write failed,
	// so POST /v1/sync/plan can answer from this small per-machine table.
	refs, err := tx.PrepareContext(ctx,
		`INSERT INTO sync_row_refs (machine_id, dataset, row_id, received_at)
		 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`)
	if err != nil {
		return 0, 0, err
	}
	defer refs.Close()
	refAt := time.Now().UTC()
	for i := range events {
		e := events[i]
		res, err := stmt.ExecContext(ctx,
			e.ID, userID, e.MachineID, e.Timestamp.UTC(), e.Source, e.Vendor, e.Model,
			e.Tokens.Input, e.Tokens.Output, e.Tokens.Reasoning, e.Tokens.CacheRead, e.Tokens.CacheWrite,
			e.Cost, e.CostSource, e.SessionID, e.Product, e.AccountID, e.RequestID, e.Attestation)
		if err != nil {
			return accepted, duplicates, err
		}
		if _, err := refs.ExecContext(ctx, e.MachineID, store.DatasetUsageEvents, e.ID, refAt); err != nil {
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
func (s *SQLStore) InsertLimits(ctx context.Context, userID string, snaps []usage.LimitSnapshot) (int, error) {
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
	refs, err := tx.PrepareContext(ctx,
		`INSERT INTO sync_row_refs (machine_id, dataset, row_id, received_at)
		 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`)
	if err != nil {
		return 0, err
	}
	defer refs.Close()
	refAt := time.Now().UTC()
	accepted := 0
	for i := range snaps {
		sn := snaps[i]
		var resets any
		if sn.HasReset {
			resets = sn.ResetsAt.UTC()
		}
		key := sn.DedupKey()
		res, err := stmt.ExecContext(ctx,
			sn.ID, userID, sn.MachineID, sn.RecordedAt.UTC(), sn.Provider, sn.AccountID, sn.Label,
			sn.UsedPercent, resets, sn.Detail, key)
		if err != nil {
			return accepted, err
		}
		if _, err := refs.ExecContext(ctx, sn.MachineID, store.DatasetLimitSnapshots, key, refAt); err != nil {
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
func (s *SQLStore) UsageSummary(ctx context.Context, q store.SummaryQuery) ([]store.VendorSummary, error) {
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
	var out []store.VendorSummary
	for rows.Next() {
		var v store.VendorSummary
		if err := rows.Scan(&v.Vendor, &v.Model, &v.Tokens, &v.Cost, &v.Requests); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// FilterMissingRows answers the sync-plan question: of the candidate row
// ids a machine is considering pushing, which has the server never seen?
// Reads sync_row_refs only (small, per-machine) — never the payload tables.
func (s *SQLStore) FilterMissingRows(ctx context.Context, machineID, dataset string, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var args []any
	args = append(args, machineID, dataset)
	placeholders := ""
	for i, id := range ids {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "$" + itoa(len(args)+1)
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT row_id FROM sync_row_refs
		 WHERE machine_id = $1 AND dataset = $2 AND row_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	known := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		known[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var missing []string
	for _, id := range ids {
		if !known[id] {
			missing = append(missing, id)
		}
	}
	return missing, nil
}

// RefCount reports how many payload rows a machine has ever delivered for
// one dataset (reconciliation signal for /v1/sync/status).
func (s *SQLStore) RefCount(ctx context.Context, machineID, dataset string) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sync_row_refs WHERE machine_id = $1 AND dataset = $2`,
		machineID, dataset).Scan(&n)
	return n, err
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

// BoardTotals aggregates one row per user over a window, optionally scoped
// to a team, a group, or a user's follow graph (store.BoardScope; zero value =
// everyone). Membership-gated, not the legacy free-text u.team.
func (s *SQLStore) BoardTotals(ctx context.Context, scope store.BoardScope, since time.Time) ([]store.BoardRow, error) {
	return s.boardTotals(ctx, scope, since, time.Time{})
}

// BoardTotalsRange bounds the window above as well (previous-period deltas).
func (s *SQLStore) BoardTotalsRange(ctx context.Context, scope store.BoardScope, since, until time.Time) ([]store.BoardRow, error) {
	return s.boardTotals(ctx, scope, since, until)
}

// scopeFilter renders the WHERE clause for a store.BoardScope; arg appends a
// bound value and returns its placeholder.
func scopeFilter(scope store.BoardScope, arg func(v any) string) string {
	switch {
	case scope.TeamSlug != "":
		p := arg(scope.TeamSlug)
		return `EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
			WHERE tm.user_id = u.id AND t.slug = ` + p + `)`
	case scope.GroupID != "":
		p := arg(scope.GroupID)
		return `EXISTS (SELECT 1 FROM group_members gm
			WHERE gm.user_id = u.id AND gm.group_id = ` + p + `)`
	case scope.FollowingOf != "":
		p := arg(scope.FollowingOf)
		return `(u.id = ` + p + ` OR EXISTS (SELECT 1 FROM user_follows uf
			WHERE uf.follower_id = ` + p + ` AND uf.followee_id = u.id))`
	}
	return ""
}

func (s *SQLStore) boardTotals(ctx context.Context, scope store.BoardScope, since, until time.Time) ([]store.BoardRow, error) {
	args := []any{since.UTC()}
	arg := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	onClause := `e.user_id = u.id AND e.ts >= $1`
	if !until.IsZero() {
		onClause += ` AND e.ts < ` + arg(until.UTC())
	}
	query := `
		SELECT u.id, u.handle, u.display_name, COALESCE(u.avatar_url, ''),
		       COALESCE(SUM(e.input+e.output+e.reasoning+e.cache_read+e.cache_write),0),
		       COALESCE(SUM(e.cost),0), COUNT(e.id),
		       COUNT(DISTINCT e.machine_id)
		FROM users u LEFT JOIN usage_events e ON ` + onClause
	if filter := scopeFilter(scope, arg); filter != "" {
		query += ` WHERE ` + filter
	}
	query += ` GROUP BY u.id, u.handle, u.display_name, u.avatar_url
		HAVING COUNT(e.id) > 0 ORDER BY 5 DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.BoardRow
	for rows.Next() {
		var b store.BoardRow
		if err := rows.Scan(&b.UserID, &b.Handle, &b.DisplayName, &b.AvatarURL,
			&b.Tokens, &b.Cost, &b.Requests, &b.Machines); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// BoardDays returns distinct active UTC days per user handle (bounded), for
// streak computation in the use case. CAST AS DATE holds on both dialects.
func (s *SQLStore) BoardDays(ctx context.Context, scope store.BoardScope, since time.Time, limitDays int) (map[string][]time.Time, error) {
	args := []any{since.UTC()}
	arg := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	query := `
		SELECT u.handle, CAST(e.ts AS DATE) AS day
		FROM usage_events e JOIN users u ON u.id = e.user_id
		WHERE e.ts >= $1`
	if filter := scopeFilter(scope, arg); filter != "" {
		query += ` AND ` + filter
	}
	query += ` GROUP BY u.handle, CAST(e.ts AS DATE) ORDER BY 1, 2 DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]time.Time{}
	for rows.Next() {
		var handle string
		var day time.Time
		if err := rows.Scan(&handle, &day); err != nil {
			return nil, err
		}
		if len(out[handle]) < limitDays {
			out[handle] = append(out[handle], day)
		}
	}
	return out, rows.Err()
}
