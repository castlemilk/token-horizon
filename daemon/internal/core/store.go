package core

// TokenBreakdown NET semantics (identical to Models.swift): input EXCLUDES
// cacheRead/cacheWrite, output EXCLUDES reasoning — wire subsets are
// subtracted at write time by the meter, so total == provider ground truth.
// Stored vendor/model spellings are RAW; canonicalization is read-time only.

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type TokenBreakdown struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

func (t TokenBreakdown) Total() int64 {
	return t.Input + t.Output + t.Reasoning + t.CacheRead + t.CacheWrite
}

// Event mirrors UsageEvent's wire encoding (camelCase keys; cost/product are
// the EFFECTIVE rank-resolved values, costRaw/productRaw the meter's own).
type Event struct {
	ID                  string         `json:"id"`
	Timestamp           int64          `json:"timestamp"`
	MachineID           string         `json:"machineID"`
	MachineAlias        *string        `json:"machineAlias,omitempty"`
	Source              string         `json:"source"`
	Vendor              string         `json:"vendor"`
	Model               string         `json:"model"`
	Tokens              TokenBreakdown `json:"tokens"`
	ContextOccupancy    *int64         `json:"contextOccupancy,omitempty"`
	ContextLimit        *int64         `json:"contextLimit,omitempty"`
	Cost                float64        `json:"cost"`
	CostRaw             float64        `json:"costRaw"`
	PromptTokPerSec     *float64       `json:"promptTokPerSec,omitempty"`
	GenerationTokPerSec *float64       `json:"generationTokPerSec,omitempty"`
	LatencyMs           *int64         `json:"latencyMs,omitempty"`
	SessionID           *string        `json:"sessionID,omitempty"`
	ThinkingLevel       *string        `json:"thinkingLevel,omitempty"`
	ThinkingRaw         *string        `json:"thinkingRaw,omitempty"`
	Product             *string        `json:"product,omitempty"`
	ProductRaw          *string        `json:"productRaw,omitempty"`
	ProductSource       *string        `json:"productSource,omitempty"`
	CostSource          *string        `json:"costSource,omitempty"`
	AccountID           *string        `json:"accountID,omitempty"`
	FileProduct         *string        `json:"fileProduct,omitempty"`
	FileCost            *float64       `json:"fileCost,omitempty"`
	CostEquivalent      *float64       `json:"costEquivalent,omitempty"`
	RequestID           *string        `json:"requestID,omitempty"`
	RequestIDAlt        *string        `json:"requestIDAlt,omitempty"`
	Attestation         string         `json:"attestation"`
}

// Store is the local sqlite usage store. One *sql.DB pinned to a single
// connection serializes writers; WAL lets concurrent readers through.
type Store struct {
	db *sql.DB
}

func openStore(path string) (*Store, error) {
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
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// InsertMetered is the ONLY writer of usage rows (meters/MITM); idempotent
// on event UUID (INSERT OR IGNORE) so redelivery is safe. The machine alias
// is upserted once per machine, never stored per row.
func (s *Store) InsertMetered(events []Event) (int, error) {
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
			e.ID = newUUID()
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
func (s *Store) EventsAfter(cursor int64, limit int) (events []Event, lastRowid int64, err error) {
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
		var e Event
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

// LimitSnapshot mirrors the Swift DTO (epoch seconds on the wire).
type LimitSnapshot struct {
	RecordedAt  int64   `json:"recorded_at"`
	MachineID   string  `json:"machine_id"`
	Provider    string  `json:"provider"`
	AccountID   string  `json:"account_id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"used_percent"`
	ResetsAt    *int64  `json:"resets_at"`
	Detail      string  `json:"detail"`
}

// LimitHistory returns snapshots with recorded_at >= from and < to,
// ascending — the sync outbox read for the limits dataset.
func (s *Store) LimitHistory(from, to int64, limit int) ([]LimitSnapshot, error) {
	rows, err := s.db.Query(`SELECT recorded_at, machine_id, provider, account_id, label,
		used_percent, resets_at, detail FROM limit_snapshot
		WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at LIMIT ?`, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LimitSnapshot
	for rows.Next() {
		var sn LimitSnapshot
		if err := rows.Scan(&sn.RecordedAt, &sn.MachineID, &sn.Provider, &sn.AccountID,
			&sn.Label, &sn.UsedPercent, &sn.ResetsAt, &sn.Detail); err != nil {
			return nil, err
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

// FileAnnotation: a file's own claim of tool identity + tool-reported
// cost, keyed by provider request id; LEFT JOINed onto metered rows at
// READ time (files never create or modify usage rows).
type FileAnnotation struct {
	Vendor     string
	RequestID  string
	Product    string
	Cost       *float64
	Timestamp  int64
	SourceFile string
}

// Annotate stores file annotations (INSERT OR IGNORE on vendor+request_id).
func (s *Store) Annotate(annotations []FileAnnotation) error {
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
func (s *Store) RecordLimits(snaps []LimitSnapshot) error {
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
