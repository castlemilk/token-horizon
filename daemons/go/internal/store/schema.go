package store

// The schema is IDENTICAL to SQLiteUsageStore.swift (v1, no migrations) so
// the Go and Swift daemons share one usage.db during the migration window.
// Pre-v1 databases are archived aside by whichever engine opens them first.

const schemaDDL = `
CREATE TABLE IF NOT EXISTS usage_event (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    machine_id TEXT NOT NULL,
    source TEXT NOT NULL,
    vendor TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    context_occupancy INTEGER,
    context_limit INTEGER,
    cost REAL NOT NULL DEFAULT 0,
    prompt_tps REAL,
    gen_tps REAL,
    latency_ms INTEGER,
    session_id TEXT,
    thinking_level TEXT,
    thinking_raw TEXT,
    product TEXT,
    product_source TEXT,
    cost_source TEXT,
    account_id TEXT,
    request_id TEXT,
    request_id_alt TEXT,
    attestation TEXT NOT NULL DEFAULT 'measured'
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_event(ts);
CREATE INDEX IF NOT EXISTS idx_usage_vendor_ts ON usage_event(vendor, ts);
CREATE INDEX IF NOT EXISTS idx_usage_machine_ts ON usage_event(machine_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_product_ts ON usage_event(product, ts);
CREATE INDEX IF NOT EXISTS idx_usage_requestid ON usage_event(request_id);
CREATE TABLE IF NOT EXISTS context_state (
    session_id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    model TEXT NOT NULL,
    occupancy INTEGER NOT NULL,
    context_limit INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limit_snapshot (
    recorded_at INTEGER NOT NULL,
    machine_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL,
    used_percent REAL NOT NULL,
    resets_at INTEGER,
    detail TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (recorded_at, machine_id, provider, account_id, label)
);
CREATE INDEX IF NOT EXISTS idx_limit_provider_ts ON limit_snapshot(provider, recorded_at);
CREATE TABLE IF NOT EXISTS file_annotation (
    vendor TEXT NOT NULL,
    request_id TEXT NOT NULL,
    product TEXT,
    cost REAL,
    ts INTEGER NOT NULL,
    source_file TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (vendor, request_id)
);
CREATE INDEX IF NOT EXISTS idx_annotation_rid ON file_annotation(request_id);
CREATE TABLE IF NOT EXISTS spelling (
    kind TEXT NOT NULL,
    raw TEXT NOT NULL,
    canon TEXT NOT NULL,
    PRIMARY KEY (kind, raw)
);
CREATE TABLE IF NOT EXISTS pricing (
    raw TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    input_per_m REAL NOT NULL,
    output_per_m REAL NOT NULL,
    cache_read_per_m REAL,
    PRIMARY KEY (raw, valid_from)
);
CREATE TABLE IF NOT EXISTS sync_state (
    dataset TEXT PRIMARY KEY,
    cursor TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machine (
    machine_id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- Trace capture (sidecar contract, daemon-owned): one row per completed
-- exchange, metered or not. ADDITIVE table — old databases gain it via
-- IF NOT EXISTS; v1 tables above are never altered. Bodies are capped
-- UTF-8 prefixes; the *_bytes columns carry full on-wire sizes.
CREATE TABLE IF NOT EXISTS trace (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    vendor TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    status INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error_class TEXT NOT NULL DEFAULT 'none',
    retry_suspect INTEGER NOT NULL DEFAULT 0,
    request_hash TEXT NOT NULL DEFAULT '',
    request_body TEXT NOT NULL DEFAULT '',
    response_body TEXT NOT NULL DEFAULT '',
    request_truncated INTEGER NOT NULL DEFAULT 0,
    response_truncated INTEGER NOT NULL DEFAULT 0,
    request_bytes INTEGER NOT NULL DEFAULT 0,
    response_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace(ts);
CREATE INDEX IF NOT EXISTS idx_trace_vendor_ts ON trace(vendor, ts);
PRAGMA user_version = 1;
`
