package store

// Trace capture persistence (sidecar /traces + /proxy/stats contract,
// daemon-owned). One row per completed exchange, metered or not — the
// usage_event table keeps counting, this table keeps evidence. Writes are
// INSERT OR IGNORE on the event UUID so redelivery is safe; reads never
// touch usage rows.

import (
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
)

// traceCapRows bounds the table (FIFO prune, throttled — see RecordTrace).
// 2000 rows × 512KB worst-case bodies ≈ 1GB ceiling; typical traffic with
// small JSON bodies lands in the tens of MB. Age pruning via
// TH_RETENTION_DAYS applies on top when set.
const traceCapRows = 2000

// tracePruneEvery bounds prune cost: check the cap every Nth insert.
const tracePruneEvery = 64

func (s *Store) RecordTrace(t usage.Trace) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO trace
		(id, ts, vendor, model, method, path, status, ttft_ms, duration_ms,
		 input_tokens, output_tokens, error_class, retry_suspect, request_hash,
		 request_body, response_body, request_truncated, response_truncated,
		 request_bytes, response_bytes)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.Timestamp, t.Vendor, t.Model, t.Method, t.Path, t.StatusCode,
		t.TTFBMs, t.DurationMs, t.InputTokens, t.OutputTokens, t.ErrorClass,
		boolInt(t.RetrySuspect), t.RequestHash, t.RequestBody, t.ResponseBody,
		boolInt(t.RequestTruncated), boolInt(t.ResponseTruncated),
		t.RequestBytes, t.ResponseBytes)
	if err != nil {
		return err
	}
	if n := s.traceInserts.Add(1); n%tracePruneEvery == 0 {
		s.pruneTraces(retentionCutoff())
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// retentionCutoff shares TH_RETENTION_DAYS with usage rows (0 = retain).
func retentionCutoff() int64 {
	if days, _ := strconv.Atoi(platform.EnvOr("TH_RETENTION_DAYS", "")); days > 0 {
		return time.Now().AddDate(0, 0, -days).Unix()
	}
	return 0
}

func (s *Store) pruneTraces(cutoff int64) {
	if cutoff > 0 {
		_, _ = s.db.Exec(`DELETE FROM trace WHERE ts < ?`, cutoff)
	}
	_, _ = s.db.Exec(`DELETE FROM trace WHERE id NOT IN
		(SELECT id FROM trace ORDER BY ts DESC, rowid DESC LIMIT ?)`, traceCapRows)
}

// TracePage lists trace summaries (bodies never leave the table here),
// newest-first, limit clamped 1–100 (default 25, sidecar parity).
func (s *Store) TracePage(vendor, model string, limit int) ([]usage.TraceSummary, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var clauses []string
	var args []any
	if vendor != "" {
		clauses = append(clauses, usage.VendorCASE("vendor")+" = ?")
		args = append(args, usage.Vendor(vendor))
	}
	if model != "" {
		clauses = append(clauses, "model = ?")
		args = append(args, model)
	}
	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	q := `SELECT id, ts, vendor, model, method, path, status, ttft_ms, duration_ms,
		input_tokens, output_tokens, error_class, retry_suspect, request_hash,
		request_truncated, response_truncated, request_bytes, response_bytes
		FROM trace ` + where + ` ORDER BY ts DESC, rowid DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []usage.TraceSummary
	for rows.Next() {
		var t usage.TraceSummary
		var retry, reqTrunc, respTrunc int
		if err := rows.Scan(&t.ID, &t.Timestamp, &t.Vendor, &t.Model, &t.Method,
			&t.Path, &t.StatusCode, &t.TTFBMs, &t.DurationMs, &t.InputTokens,
			&t.OutputTokens, &t.ErrorClass, &retry, &t.RequestHash,
			&reqTrunc, &respTrunc, &t.RequestBytes, &t.ResponseBytes); err != nil {
			return nil, err
		}
		t.RetrySuspect = retry != 0
		t.RequestTruncated = reqTrunc != 0
		t.ResponseTruncated = respTrunc != 0
		out = append(out, t)
	}
	return out, rows.Err()
}

// TraceByID returns the full trace including bodies; sql.ErrNoRows on miss.
func (s *Store) TraceByID(id string) (*usage.Trace, error) {
	var t usage.Trace
	var retry, reqTrunc, respTrunc int
	err := s.db.QueryRow(`SELECT id, ts, vendor, model, method, path, status,
		ttft_ms, duration_ms, input_tokens, output_tokens, error_class,
		retry_suspect, request_hash, request_body, response_body,
		request_truncated, response_truncated, request_bytes, response_bytes
		FROM trace WHERE id = ?`, id).Scan(
		&t.ID, &t.Timestamp, &t.Vendor, &t.Model, &t.Method, &t.Path,
		&t.StatusCode, &t.TTFBMs, &t.DurationMs, &t.InputTokens, &t.OutputTokens,
		&t.ErrorClass, &retry, &t.RequestHash, &t.RequestBody, &t.ResponseBody,
		&reqTrunc, &respTrunc, &t.RequestBytes, &t.ResponseBytes)
	if err != nil {
		return nil, err
	}
	t.RetrySuspect = retry != 0
	t.RequestTruncated = reqTrunc != 0
	t.ResponseTruncated = respTrunc != 0
	return &t, nil
}

// TraceCount returns the live trace row count.
func (s *Store) TraceCount() (int, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM trace`).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// ClearTraces drops every trace row; returns the cleared count.
func (s *Store) ClearTraces() (int, error) {
	res, err := s.db.Exec(`DELETE FROM trace`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// TraceStats aggregates the window (hours clamped 1–168, default 24,
// sidecar parity): totals, error/retry rates, TTFT and active-time tok/s,
// per-(vendor, model) rows sorted by requests desc. Averages ignore
// zero-TTFT rows; tok/s sums output over summed active time of successful
// traces only (errors produce nothing measurable; active<=1ms contributes
// nothing).
func (s *Store) TraceStats(vendor, model string, hours int) (usage.TraceStats, error) {
	if hours <= 0 || hours > 168 {
		hours = 24
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour).Unix()
	st := usage.TraceStats{WindowHours: hours, Since: since, ByModel: []usage.TraceModelStats{}}
	var clauses []string
	var args []any
	clauses = append(clauses, "ts >= ?")
	args = append(args, since)
	if vendor != "" {
		clauses = append(clauses, usage.VendorCASE("vendor")+" = ?")
		args = append(args, usage.Vendor(vendor))
	}
	if model != "" {
		clauses = append(clauses, "model = ?")
		args = append(args, model)
	}
	where := "WHERE " + strings.Join(clauses, " AND ")
	rows, err := s.db.Query(`SELECT vendor, model,
		COUNT(*),
		SUM(CASE WHEN error_class != 'none' THEN 1 ELSE 0 END),
		SUM(CASE WHEN retry_suspect != 0 THEN 1 ELSE 0 END),
		SUM(input_tokens), SUM(output_tokens),
		SUM(CASE WHEN ttft_ms > 0 THEN ttft_ms ELSE 0 END),
		SUM(CASE WHEN ttft_ms > 0 THEN 1 ELSE 0 END),
		SUM(CASE WHEN error_class = 'none' AND duration_ms - ttft_ms > 1 THEN output_tokens ELSE 0 END),
		SUM(CASE WHEN error_class = 'none' AND duration_ms - ttft_ms > 1 THEN duration_ms - ttft_ms ELSE 0 END)
		FROM trace `+where+` GROUP BY vendor, model ORDER BY COUNT(*) DESC`, args...)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	var totalOut, totalActive int64
	for rows.Next() {
		var m usage.TraceModelStats
		var errs, retries, ttftSum, ttftN, outSum, activeSum int64
		var inSum int64
		if err := rows.Scan(&m.Vendor, &m.Model, &m.Requests, &errs, &retries,
			&inSum, &m.OutputTokens, &ttftSum, &ttftN, &outSum, &activeSum); err != nil {
			return st, err
		}
		m.Errors = int(errs)
		m.InputTokens = inSum
		if ttftN > 0 {
			m.AvgTTFBMs = float64(ttftSum) / float64(ttftN)
		}
		if activeSum > 0 {
			m.AvgTokPerSec = float64(outSum) / (float64(activeSum) / 1000)
		}
		st.Requests += m.Requests
		st.Errors += m.Errors
		st.RetrySuspects += int(retries)
		totalOut += outSum
		totalActive += activeSum
		st.ByModel = append(st.ByModel, m)
	}
	if err := rows.Err(); err != nil {
		return st, err
	}
	if st.Requests > 0 {
		st.ErrorRate = float64(st.Errors) / float64(st.Requests)
	}
	if totalActive > 0 {
		st.AvgTokPerSec = float64(totalOut) / (float64(totalActive) / 1000)
	}
	var ttftSum, ttftN int64
	_ = s.db.QueryRow(`SELECT COALESCE(SUM(CASE WHEN ttft_ms > 0 THEN ttft_ms ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN ttft_ms > 0 THEN 1 ELSE 0 END),0) FROM trace `+where, args...).Scan(&ttftSum, &ttftN)
	if ttftN > 0 {
		st.AvgTTFBMs = float64(ttftSum) / float64(ttftN)
	}
	return st, nil
}
