-- 001_schema: token-horizon cloud server schema (DuckDB), consolidated.
-- Same shape as migrations/postgres/001_schema.sql: single script, fully
-- idempotent — fresh databases reach the complete schema in one pass and
-- databases that applied the historical 001_init / 002_identity pair
-- converge. DuckDB has no partial indexes, so provider subs are NULLABLE
-- with plain UNIQUE indexes (NULLs never collide). App logic owns orphan
-- cleanup; FK clauses are documentary.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    team         TEXT NOT NULL DEFAULT '',
    email        TEXT,
    avatar_url   TEXT,
    bio          TEXT,
    google_sub   TEXT,
    ms_sub       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Convergence path for databases created before the identity columns
-- existed (historical 001_init): no-ops on fresh databases.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ms ON users (ms_sub);

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

-- Delta-sync reference table: one row per (machine, dataset, payload row)
-- the server has ever accepted. POST /v1/sync/plan answers "which of these
-- ids are new?" against THIS table — small and per-machine — instead of
-- scanning usage_events/limit_snapshots, so daemons push only the rows the
-- server has never seen (never the whole table again).
-- row_id: usage_events → the event UUID; limit_snapshots → the dedup key
-- (machine|provider|account|label|minute-RFC3339, see InsertLimits).
CREATE TABLE IF NOT EXISTS sync_row_refs (
    machine_id  TEXT NOT NULL,
    dataset     TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (machine_id, dataset, row_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id),
    provider   TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_tickets (
    state        TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL DEFAULT '',
    redeemed_at  TIMESTAMPTZ NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
    id         TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL DEFAULT '',
    join_code  TEXT NOT NULL UNIQUE,
    owner_id   TEXT NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id   TEXT NOT NULL REFERENCES teams (id),
    user_id   TEXT NOT NULL REFERENCES users (id),
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL REFERENCES teams (id),
    slug       TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    join_code  TEXT NOT NULL UNIQUE,
    owner_id   TEXT NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, slug)
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id  TEXT NOT NULL REFERENCES groups (id),
    user_id   TEXT NOT NULL REFERENCES users (id),
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);

-- Follow/follower: asymmetric social graph between users. Self-follows are
-- rejected in the use case; rows are idempotent by primary key.
CREATE TABLE IF NOT EXISTS user_follows (
    follower_id TEXT NOT NULL REFERENCES users (id),
    followee_id TEXT NOT NULL REFERENCES users (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON user_follows (followee_id);
