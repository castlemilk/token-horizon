package store

// usage.TokenBreakdown NET semantics (identical to Models.swift): input EXCLUDES
// cacheRead/cacheWrite, output EXCLUDES reasoning — wire subsets are
// subtracted at write time by the meter, so total == provider ground truth.
// Stored vendor/model spellings are RAW; canonicalization is read-time only.

import (
	"database/sql"
	"fmt"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

// Store is the local sqlite usage store. One *sql.DB pinned to a single
// connection serializes writers; WAL lets concurrent readers through.
type Store struct {
	db *sql.DB
	// traceInserts counts RecordTrace calls for prune throttling.
	traceInserts atomic.Int64
}

func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaDDL); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	// Opt-in retention (the sidecar prunes traces; usage rows are unbounded
	// by default). TH_RETENTION_DAYS=N deletes usage_event rows older than N
	// days on open; unset/0 retains everything. Schema untouched — DELETE
	// only, never ALTER.
	if days, _ := strconv.Atoi(platform.EnvOr("TH_RETENTION_DAYS", "")); days > 0 {
		cutoff := time.Now().AddDate(0, 0, -days).Unix()
		if _, err := db.Exec(`DELETE FROM usage_event WHERE ts < ?`, cutoff); err != nil {
			db.Close()
			return nil, fmt.Errorf("retention: %w", err)
		}
		if _, err := db.Exec(`DELETE FROM trace WHERE ts < ?`, cutoff); err != nil {
			db.Close()
			return nil, fmt.Errorf("retention: %w", err)
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Exec is a raw passthrough for tests and one-off maintenance (the schema is
// v1 with no migrations — never use this for migrations).
func (s *Store) Exec(query string, args ...any) (sql.Result, error) {
	return s.db.Exec(query, args...)
}

// InsertMetered is the ONLY writer of usage rows (meters/MITM); idempotent
// on event UUID (INSERT OR IGNORE) so redelivery is safe. The machine alias
// is upserted once per machine, never stored per row.
func (s *Store) InsertMetered(events []usage.Event) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO usage_event
		(id, ts, machine_id, source, vendor, model, input, output, reasoning,
		 cache_read, cache_write, context_occupancy, context_limit, cost,
		 prompt_tps, gen_tps, latency_ms, session_id, thinking_level,
		 thinking_raw, product, product_source, cost_source, account_id,
		 request_id, request_id_alt, attestation)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	inserted := 0
	for _, e := range events {
		if e.ID == "" {
			e.ID = platform.NewUUID()
		}
		if e.Attestation == "" {
			e.Attestation = "measured"
		}
		res, err := stmt.Exec(e.ID, e.Timestamp, e.MachineID, e.Source, e.Vendor, e.Model,
			e.Tokens.Input, e.Tokens.Output, e.Tokens.Reasoning, e.Tokens.CacheRead, e.Tokens.CacheWrite,
			e.ContextOccupancy, e.ContextLimit, e.Cost, e.PromptTokPerSec, e.GenerationTokPerSec,
			e.LatencyMs, e.SessionID, e.ThinkingLevel, e.ThinkingRaw, e.Product, e.ProductSource,
			e.CostSource, e.AccountID, e.RequestID, e.RequestIDAlt, e.Attestation)
		if err != nil {
			return inserted, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			inserted++
		}
		if e.MachineAlias != nil {
			if _, err := tx.Exec(`INSERT INTO machine (machine_id, alias, updated_at) VALUES (?,?,?)
				ON CONFLICT(machine_id) DO UPDATE SET alias=excluded.alias, updated_at=excluded.updated_at`,
				e.MachineID, *e.MachineAlias, time.Now().Unix()); err != nil {
				return inserted, err
			}
		}
	}
	return inserted, tx.Commit()
}

// ---- Sync cursors (sync_state) ----

func (s *Store) SyncCursor(dataset string) (string, error) {
	var c string
	err := s.db.QueryRow(`SELECT cursor FROM sync_state WHERE dataset = ?`, dataset).Scan(&c)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return c, err
}

func (s *Store) SetSyncCursor(dataset, cursor string) error {
	_, err := s.db.Exec(`INSERT INTO sync_state (dataset, cursor, updated_at) VALUES (?,?,?)
		ON CONFLICT(dataset) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`,
		dataset, cursor, time.Now().Unix())
	return err
}

// EventsAfter returns up to limit events with rowid > cursor, ascending —
// the sync outbox read. lastRowid is the cursor to persist after an
// acknowledged push.
func (s *Store) EventsAfter(cursor int64, limit int) (events []usage.Event, lastRowid int64, err error) {
	rows, err := s.db.Query(`SELECT rowid, id, ts, machine_id, source, vendor, model,
		input, output, reasoning, cache_read, cache_write, cost, cost_source,
		session_id, product, account_id, request_id, attestation
		FROM usage_event WHERE rowid > ? ORDER BY rowid LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, cursor, err
	}
	defer rows.Close()
	lastRowid = cursor
	for rows.Next() {
		var e usage.Event
		err = rows.Scan(&lastRowid, &e.ID, &e.Timestamp, &e.MachineID, &e.Source, &e.Vendor, &e.Model,
			&e.Tokens.Input, &e.Tokens.Output, &e.Tokens.Reasoning, &e.Tokens.CacheRead, &e.Tokens.CacheWrite,
			&e.Cost, &e.CostSource, &e.SessionID, &e.Product, &e.AccountID, &e.RequestID, &e.Attestation)
		if err != nil {
			return nil, cursor, err
		}
		events = append(events, e)
	}
	return events, lastRowid, rows.Err()
}

// LimitHistory returns snapshots with recorded_at >= from and < to,
// ascending — the sync outbox read for the limits dataset.
func (s *Store) LimitHistory(from, to int64, limit int) ([]usage.LimitSnapshot, error) {
	rows, err := s.db.Query(`SELECT recorded_at, machine_id, provider, account_id, label,
		used_percent, resets_at, detail FROM limit_snapshot
		WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at LIMIT ?`, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []usage.LimitSnapshot
	for rows.Next() {
		var sn usage.LimitSnapshot
		if err := rows.Scan(&sn.RecordedAt, &sn.MachineID, &sn.Provider, &sn.AccountID,
			&sn.Label, &sn.UsedPercent, &sn.ResetsAt, &sn.Detail); err != nil {
			return nil, err
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

// Annotate stores file annotations (INSERT OR IGNORE on vendor+request_id).
func (s *Store) Annotate(annotations []usage.FileAnnotation) error {
	if len(annotations) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO file_annotation
		(vendor, request_id, product, cost, ts, source_file) VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, a := range annotations {
		if _, err := stmt.Exec(a.Vendor, a.RequestID, a.Product, a.Cost, a.Timestamp, a.SourceFile); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Count() (int64, error) {
	var n int64
	err := s.db.QueryRow(`SELECT COUNT(*) FROM usage_event`).Scan(&n)
	return n, err
}

// RecordLimits persists wire/quota-API limit observations (INSERT OR IGNORE
// on the natural key — re-polls are no-ops).
func (s *Store) RecordLimits(snaps []usage.LimitSnapshot) error {
	if len(snaps) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO limit_snapshot
		(recorded_at, machine_id, provider, account_id, label, used_percent, resets_at, detail)
		VALUES (?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, sn := range snaps {
		if _, err := stmt.Exec(sn.RecordedAt, sn.MachineID, sn.Provider, sn.AccountID,
			sn.Label, sn.UsedPercent, sn.ResetsAt, sn.Detail); err != nil {
			return err
		}
	}
	return tx.Commit()
}
