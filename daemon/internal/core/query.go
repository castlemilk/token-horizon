package core

// Read-side analytics, ported from SQLiteUsageStore.swift. All queries keep
// stored spellings RAW and canonicalize in SQL: vendor CASE expression,
// model spelling join, pricing interval join, annotation rank resolution
// (explicit label > file > header sniff; reported cost > computed).

import (
	"database/sql"
	"fmt"
	"strings"
)

const annotationJoinSQL = `
LEFT JOIN file_annotation fa ON fa.rowid = (
    SELECT MIN(rowid) FROM file_annotation
    WHERE request_id = usage_event.request_id
       OR request_id = usage_event.request_id_alt
)`

const machineJoinSQL = `LEFT JOIN machine mc ON mc.machine_id = usage_event.machine_id`

const spellingJoinSQL = `
LEFT JOIN spelling sm ON sm.kind = 'model'
    AND sm.raw = usage_event.vendor || '/' || usage_event.model`

// costEquivalentSQL prices EVERY row at list rates, in lockstep with
// CostEngine: cache-write as input, reasoning at the OUTPUT rate (net
// storage makes output exclude reasoning — thinking must be added back or
// it is silently free), cache-read at its own rate when priced.
const costEquivalentSQL = `
CASE WHEN pr.input_per_m IS NOT NULL THEN
    (usage_event.input * pr.input_per_m
   + (usage_event.output + usage_event.reasoning) * pr.output_per_m
   + usage_event.cache_write * pr.input_per_m
   + COALESCE(usage_event.cache_read * pr.cache_read_per_m, 0)) / 1000000.0
END`

func pricingJoinSQL() string {
	return fmt.Sprintf(`
LEFT JOIN pricing pr ON pr.rowid = (
    SELECT rowid FROM pricing
    WHERE raw = %s || '/' || COALESCE(sm.canon, usage_event.model)
      AND valid_from <= usage_event.ts
    ORDER BY valid_from DESC LIMIT 1
)`, vendorCASE("usage_event.vendor"))
}

// Filter mirrors UsageFilter: time range + meteredOnly + exact matches on
// raw stored values (vendor folds both sides through the CASE; model matches
// via the spelling cache plus raw equality).
type Filter struct {
	From, To    int64
	MeteredOnly bool
	Vendor      string
	Model       string
	MachineID   string
	Product     string
	SessionID   string
}

func (f Filter) where() (string, []any) {
	var clauses []string
	var args []any
	if f.From > 0 {
		clauses = append(clauses, "usage_event.ts >= ?")
		args = append(args, f.From)
	}
	if f.To > 0 {
		clauses = append(clauses, "usage_event.ts < ?")
		args = append(args, f.To)
	}
	if f.MeteredOnly {
		clauses = append(clauses, "usage_event.attestation != 'selfReported'")
	}
	if f.Vendor != "" {
		clauses = append(clauses, vendorCASE("usage_event.vendor")+" = ?")
		args = append(args, Vendor(f.Vendor))
	}
	if f.Model != "" {
		clauses = append(clauses, `(COALESCE(sm.canon, usage_event.model) = ? OR usage_event.model = ?)`)
		args = append(args, f.Model, f.Model)
	}
	if f.MachineID != "" {
		clauses = append(clauses, "usage_event.machine_id = ?")
		args = append(args, f.MachineID)
	}
	if f.Product != "" {
		// Effective product: explicit label > file annotation > sniffed.
		clauses = append(clauses, `COALESCE(CASE WHEN usage_event.product_source = 'explicitLabel' THEN usage_event.product END, fa.product, usage_event.product) = ?`)
		args = append(args, f.Product)
	}
	if f.SessionID != "" {
		clauses = append(clauses, "usage_event.session_id = ?")
		args = append(args, f.SessionID)
	}
	if len(clauses) == 0 {
		return "", args
	}
	return "WHERE " + strings.Join(clauses, " AND "), args
}

const eventSelectCols = `
    usage_event.rowid, usage_event.id, usage_event.ts, usage_event.machine_id,
    usage_event.source, usage_event.vendor, usage_event.model,
    usage_event.input, usage_event.output, usage_event.reasoning,
    usage_event.cache_read, usage_event.cache_write,
    usage_event.context_occupancy, usage_event.context_limit,
    usage_event.cost, usage_event.prompt_tps, usage_event.gen_tps,
    usage_event.latency_ms, usage_event.session_id, usage_event.attestation,
    usage_event.thinking_level, usage_event.thinking_raw,
    usage_event.product, usage_event.request_id, usage_event.product_source,
    usage_event.cost_source, usage_event.account_id, usage_event.request_id_alt,
    mc.alias, fa.product, fa.cost, ` + costEquivalentSQL

func scanEvent(row interface{ Scan(...any) error }) (*Event, int64, error) {
	var e Event
	var rowid int64
	var fileCost sql.NullFloat64
	var equiv sql.NullFloat64
	err := row.Scan(&rowid, &e.ID, &e.Timestamp, &e.MachineID,
		&e.Source, &e.Vendor, &e.Model,
		&e.Tokens.Input, &e.Tokens.Output, &e.Tokens.Reasoning,
		&e.Tokens.CacheRead, &e.Tokens.CacheWrite,
		&e.ContextOccupancy, &e.ContextLimit,
		&e.CostRaw, &e.PromptTokPerSec, &e.GenerationTokPerSec,
		&e.LatencyMs, &e.SessionID, &e.Attestation,
		&e.ThinkingLevel, &e.ThinkingRaw,
		&e.ProductRaw, &e.RequestID, &e.ProductSource,
		&e.CostSource, &e.AccountID, &e.RequestIDAlt,
		&e.MachineAlias, &e.FileProduct, &fileCost, &equiv)
	if err != nil {
		return nil, 0, err
	}
	if fileCost.Valid {
		e.FileCost = &fileCost.Float64
	}
	if equiv.Valid {
		e.CostEquivalent = &equiv.Float64
	}
	// Rank resolution (UsageEvent.encode contract): explicit label > file >
	// sniffed; reported cost > computed. Consumers never re-implement this.
	if e.ProductSource != nil && *e.ProductSource == "explicitLabel" {
		e.Product = e.ProductRaw
	} else if e.FileProduct != nil {
		e.Product = e.FileProduct
	} else {
		e.Product = e.ProductRaw
	}
	if e.FileCost != nil {
		e.Cost = *e.FileCost
		reported := "reported"
		e.CostSource = &reported
	} else {
		e.Cost = e.CostRaw
	}
	return &e, rowid, nil
}

// EventsPage is the tabular newest-first query with rowid pagination.
func (s *Store) EventsPage(f Filter, cursor int64, limit int) ([]Event, int64, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	where, args := f.where()
	if cursor > 0 {
		if where == "" {
			where = "WHERE usage_event.rowid < ?"
		} else {
			where += " AND usage_event.rowid < ?"
		}
		args = append(args, cursor)
	}
	q := `SELECT ` + eventSelectCols + `
		FROM usage_event ` + annotationJoinSQL + ` ` + spellingJoinSQL + ` ` + machineJoinSQL + ` ` + pricingJoinSQL() + `
		` + where + ` ORDER BY usage_event.rowid DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Event
	var last int64
	for rows.Next() {
		e, rid, err := scanEvent(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *e)
		last = rid
	}
	var next int64
	if len(out) == limit {
		next = last
	}
	return out, next, rows.Err()
}

// Bucket is one arbitrary-resolution time bucket per canonical vendor.
type Bucket struct {
	Start          int64          `json:"start"`
	Vendor         string         `json:"vendor"`
	Tokens         TokenBreakdown `json:"tokens"`
	Cost           float64        `json:"cost"`
	CostEquivalent *float64       `json:"costEquivalent,omitempty"`
	Requests       int64          `json:"requests"`
}

// SnapBucketSeconds mirrors BucketResolution.snap: 300/900/3600/86400.
func SnapBucketSeconds(req int) int {
	switch {
	case req <= 300:
		return 300
	case req <= 900:
		return 900
	case req <= 3600:
		return 3600
	default:
		return 86400
	}
}

func (s *Store) Buckets(f Filter, bucketSeconds int) ([]Bucket, error) {
	size := SnapBucketSeconds(bucketSeconds)
	where, args := f.where()
	q := fmt.Sprintf(`SELECT (usage_event.ts / %d) * %d, %s,
		SUM(usage_event.input), SUM(usage_event.output), SUM(usage_event.reasoning),
		SUM(usage_event.cache_read), SUM(usage_event.cache_write), SUM(usage_event.cost),
		SUM(%s), COUNT(*)
		FROM usage_event %s %s %s
		%s
		GROUP BY 1, 2 ORDER BY 1`,
		size, size, vendorCASE("usage_event.vendor"),
		costEquivalentSQL, spellingJoinSQL, machineJoinSQL, pricingJoinSQL(), where)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Bucket
	for rows.Next() {
		var b Bucket
		var equiv sql.NullFloat64
		if err := rows.Scan(&b.Start, &b.Vendor,
			&b.Tokens.Input, &b.Tokens.Output, &b.Tokens.Reasoning,
			&b.Tokens.CacheRead, &b.Tokens.CacheWrite, &b.Cost,
			&equiv, &b.Requests); err != nil {
			return nil, err
		}
		if equiv.Valid {
			b.CostEquivalent = &equiv.Float64
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ModelSummary / ProviderSummary mirror the Swift DTOs the UI consumes.
type ModelSummary struct {
	Model                  string         `json:"model"`
	Tokens                 TokenBreakdown `json:"tokens"`
	Cost                   float64        `json:"cost"`
	CostEquivalent         *float64       `json:"costEquivalent,omitempty"`
	Requests               int64          `json:"requests"`
	AvgGenerationTokPerSec *float64       `json:"avgGenerationTokPerSec,omitempty"`
	AvgPromptTokPerSec     *float64       `json:"avgPromptTokPerSec,omitempty"`
	AvgContextOccupancy    *float64       `json:"avgContextOccupancy,omitempty"`
	LastEvent              *int64         `json:"lastEvent,omitempty"`
}

type ProviderSummary struct {
	Vendor         string         `json:"vendor"`
	Source         string         `json:"source"`
	Tokens         TokenBreakdown `json:"tokens"`
	Cost           float64        `json:"cost"`
	CostEquivalent *float64       `json:"costEquivalent,omitempty"`
	Requests       int64          `json:"requests"`
	Models         []ModelSummary `json:"models"`
}

// Summary rolls up provider→model over the window with measured-rate
// averages weighted by token volume.
func (s *Store) Summary(f Filter) ([]ProviderSummary, error) {
	where, args := f.where()
	q := fmt.Sprintf(`SELECT %s, usage_event.source,
		COALESCE(sm.canon, usage_event.model),
		SUM(usage_event.input), SUM(usage_event.output), SUM(usage_event.reasoning),
		SUM(usage_event.cache_read), SUM(usage_event.cache_write), SUM(usage_event.cost), COUNT(*),
		SUM(usage_event.gen_tps * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
		SUM(usage_event.prompt_tps * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
		SUM(usage_event.context_occupancy * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
		MAX(usage_event.ts), SUM(%s)
		FROM usage_event %s %s
		%s
		GROUP BY 1, 3
		ORDER BY 4+5+6+7+8 DESC`,
		vendorCASE("usage_event.vendor"), costEquivalentSQL,
		spellingJoinSQL, pricingJoinSQL(), where)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var providers []ProviderSummary
	index := map[string]int{}
	for rows.Next() {
		var vendor, source, model string
		var m ModelSummary
		var equiv sql.NullFloat64
		var last sql.NullInt64
		if err := rows.Scan(&vendor, &source, &model,
			&m.Tokens.Input, &m.Tokens.Output, &m.Tokens.Reasoning,
			&m.Tokens.CacheRead, &m.Tokens.CacheWrite, &m.Cost, &m.Requests,
			&m.AvgGenerationTokPerSec, &m.AvgPromptTokPerSec, &m.AvgContextOccupancy,
			&last, &equiv); err != nil {
			return nil, err
		}
		m.Model = model
		if last.Valid {
			m.LastEvent = &last.Int64
		}
		if equiv.Valid {
			m.CostEquivalent = &equiv.Float64
		}
		i, ok := index[vendor]
		if !ok {
			providers = append(providers, ProviderSummary{Vendor: vendor, Source: source})
			i = len(providers) - 1
			index[vendor] = i
		}
		p := &providers[i]
		p.Tokens.Input += m.Tokens.Input
		p.Tokens.Output += m.Tokens.Output
		p.Tokens.Reasoning += m.Tokens.Reasoning
		p.Tokens.CacheRead += m.Tokens.CacheRead
		p.Tokens.CacheWrite += m.Tokens.CacheWrite
		p.Cost += m.Cost
		p.Requests += m.Requests
		if m.CostEquivalent != nil {
			v := *m.CostEquivalent
			if p.CostEquivalent != nil {
				v += *p.CostEquivalent
			}
			p.CostEquivalent = &v
		}
		p.Models = append(p.Models, m)
	}
	return providers, rows.Err()
}
