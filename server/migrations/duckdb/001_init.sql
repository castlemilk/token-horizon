-- 001_init: token-horizon cloud server schema (DuckDB).
-- Same shape as migrations/postgres/001_init.sql: users own machines,
-- machines own metered rows. Event UUIDs are the dedup key
-- (redelivery-safe); limit snapshots dedup on their natural key.
-- All timestamps TIMESTAMPTZ, always UTC.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    team         TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machines (
    id          TEXT PRIMARY KEY,
    machine_id  TEXT NOT NULL UNIQUE,
    user_id     TEXT NOT NULL REFERENCES users (id),
    alias       TEXT NOT NULL DEFAULT '',
    platform    TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_machines_user ON machines (user_id);

CREATE TABLE IF NOT EXISTS usage_events (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id),
    machine_id  TEXT NOT NULL,
    ts          TIMESTAMPTZ NOT NULL,
    source      TEXT NOT NULL DEFAULT '',
    vendor      TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    input       BIGINT NOT NULL DEFAULT 0,
    output      BIGINT NOT NULL DEFAULT 0,
    reasoning   BIGINT NOT NULL DEFAULT 0,
    cache_read  BIGINT NOT NULL DEFAULT 0,
    cache_write BIGINT NOT NULL DEFAULT 0,
    cost        DOUBLE PRECISION NOT NULL DEFAULT 0,
    cost_source TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    product     TEXT NOT NULL DEFAULT '',
    account_id  TEXT NOT NULL DEFAULT '',
    request_id  TEXT NOT NULL DEFAULT '',
    attestation TEXT NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_user_ts ON usage_events (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_machine_ts ON usage_events (machine_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_vendor_ts ON usage_events (vendor, ts);

CREATE TABLE IF NOT EXISTS limit_snapshots (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id),
    machine_id   TEXT NOT NULL DEFAULT '',
    recorded_at  TIMESTAMPTZ NOT NULL,
    provider     TEXT NOT NULL DEFAULT '',
    account_id   TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    used_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
    resets_at    TIMESTAMPTZ NULL,
    detail       TEXT NOT NULL DEFAULT '',
    dedup_key    TEXT NOT NULL UNIQUE,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_limits_machine_time ON limit_snapshots (machine_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_limits_provider ON limit_snapshots (provider, recorded_at);

CREATE TABLE IF NOT EXISTS sync_state (
    dataset    TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    cursor     TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset, machine_id)
);
