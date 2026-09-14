-- 002_identity: login, sessions, avatars, teams, groups (DuckDB).
-- Same shape as postgres/002_identity.sql, adjusted: DuckDB has no partial
-- indexes, so provider subs are NULLABLE with plain UNIQUE indexes (NULLs
-- never collide). App logic owns orphan cleanup; FK clauses are documentary.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ms ON users (ms_sub);

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
