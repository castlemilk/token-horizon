# token-horizon cloud server (`/server`)

Dedicated Go ingest + sync API for Token Horizon. Daemons (meter / MITM
hosts) push what they measure; this server attributes every row to a
**user** (the logged-in human behind the handle) and their **machines**,
and serves the sync pathways (high-water, cursors, rollups, fleet) back.

```
server/
  cmd/server/        wiring: env → store → HTTP listen
  cmd/migrate/       schema migration runner (both dialects, embedded SQL)
  src/
    models/          primitives, one package per concern:
      identity/      User, Machine, Session, Ticket, handle rules, NewID
      social/        Team, Group, FollowUser, Slugify
      usage/         TokenBreakdown, UsageEvent, LimitSnapshot, SyncCursor
    use_cases/       business logic, one package per concern (store port
                     only — no HTTP, no SQL):
      ingest/        Envelope → identify → idempotent store
      sync/          high-water, delta plan, cursors, fleet, rollups
      auth/          Google/Microsoft OAuth dance → ticket → session
      account/       profile edits (display name, handle, bio, avatar)
      teams/         teams + team-scoped groups, invite codes
      follows/       follow/follower graph
      leaderboard/   scoped ranked boards (team / group / following)
    interfaces/      external adapters:
      http/          JSON delivery (package api, one file per concern:
                     server/ingest/sync/auth/account/teams/follows/leaderboard)
      store/         Store port + shared DTOs (BoardScope, SummaryQuery…)
        sqlstore/    database/sql adapter (Postgres + DuckDB, $n, shared DDL)
        testfake/    in-memory Store for unit tests
  migrations/
    postgres/        ONE consolidated, idempotent schema script
    duckdb/          same shape for DuckDB
```

The schema is a single script per dialect (`001_schema.sql`), fully
idempotent: fresh databases reach the complete schema in one pass, and
databases that applied the historical 001_init/002_identity pair converge
on the next `cmd/migrate` run (every statement is IF NOT EXISTS — re-runs
are no-ops, recorded once in schema_migrations).

## Wire contract (matches Swift `CloudSync`)

Identity envelope on every push (see `CloudSchema` + `MachineIdentity`):

```json
{ "machine_id": "<daemon uuid>", "machine_alias": "devbox",
  "handle": "<os username>", "user_id": "<user uuid>", "team": "",
  "platform": "Linux", "rows": [...] }
```

`user_id` is optional: a daemon that completed Google/Microsoft login pins
attribution to that exact account UUID (handle mismatches can't re-home
rows); handle resolution is the fallback for daemons that never signed in.

| Method | Path | Body → Result |
|---|---|---|
| `POST` | `/ingest/events` | CloudSchema usage rows → `{accepted, duplicates, user, machine}` |
| `POST` | `/ingest/limits` | CloudSchema limit rows → `{accepted, user, machine}` |
| `GET` | `/v1/sync/status?machine_id=` | server high-water + per-dataset ref counts (reconcile after offline) |
| `POST` | `/v1/sync/plan` | `{machine_id, dataset, ids}` → `{known, missing}` (delta sync) |
| `GET/POST` | `/v1/sync/cursors` | get/set per-dataset per-machine cursors |
| `GET` | `/v1/usage/summary?handle=&team=&since=&vendor=` | per-vendor/model rollup (leaderboard fuel; rankings derive cloud-side, never persist) |
| `GET` | `/v1/leaderboard?team=&group=&period=` | ranked board over everyone, one team, or one group |
| `GET` | `/v1/machines?handle=` | the user's device fleet |
| `GET` | `/healthz` | unauthenticated liveness |

## Delta sync (push only what's new)

Daemons never copy the whole table twice. Every accepted payload row is
recorded in the per-machine reference table `sync_row_refs`
(`machine_id, dataset, row_id`) in the same transaction. The sync loop is:

1. `GET /v1/sync/status?machine_id=` → high-water + `known_events` /
   `known_limits` counts: is the server behind my local table?
2. `POST /v1/sync/plan {machine_id, dataset, ids:[...]}` → the server
   answers from `sync_row_refs` (never a payload-table scan) with just the
   `missing` ids. `dataset` is `usage_events` (ids = event UUIDs) or
   `limit_snapshots` (ids = dedup keys
   `machine|provider|account|label|minute-RFC3339`).
3. Push only those rows via `/ingest/*`. Event-UUID and dedup-key
   idempotency still applies, so races and redeliveries stay harmless.

## Identity (Google / Microsoft login, profiles, teams)

Desktop login is a browser dance bridged with claim tickets: the app opens
`GET /v1/auth/{google,microsoft}/login` externally, the provider calls back
to the server, and the app polls `POST /v1/auth/claim {state}` (202 =
still open, 200 = `{token, user}`, 410 = burned). Sessions are opaque
30-day bearer tokens (sha256 stored).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/auth/{google,microsoft}/login` | `{url, state}` (public) |
| `GET` | `/v1/auth/{google,microsoft}/callback` | provider redirect target, HTML landing |
| `POST` | `/v1/auth/claim` | burn ticket → `{token, user}` |
| `POST` | `/v1/auth/logout` | revoke session |
| `GET`/`PATCH` | `/v1/users/me` | profile read / display-name + handle + bio edit (409 on taken) |
| `POST` | `/v1/users/me/avatar` | multipart webp/png/jpeg ≤2MB → stored, profile pointed |
| `GET` | `/v1/avatars/{userID}` | public bytes (no auth, for `<img>`) |
| `POST`/`GET` | `/v1/teams`, `/v1/teams/join`, `/v1/teams/{id}/leave` | create (owner), list mine, join by code, leave (empties prune) |
| `POST`/`GET` | `/v1/teams/{id}/groups`, `/v1/groups/join`, `/v1/groups/{id}/leave` | team-scoped groups, same invite-code pattern |
| `PUT`/`DELETE` | `/v1/follows/{handle}` | follow / unfollow (idempotent, no self-follows) |
| `GET` | `/v1/follows/followers`, `/v1/follows/following` | the caller's follow lists |
| `GET` | `/v1/follows/leaderboard?period=` | ranked board over the caller's follow graph + self |

Env additions: `TH_SERVER_PUBLIC_URL` (OAuth callback base),
`GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET`, `TH_SERVER_DATA`
(avatar dir). User routes need a session bearer; ingest keeps accepting
the service `TH_SYNC_TOKEN`.

Point a daemon at it: `TH_SYNC_URL=http://host:8080` (+ `TH_SYNC_HANDLE`,
`TH_SYNC_TEAM`). Event UUIDs make redelivery a no-op; limit snapshots dedup
on `(machine, provider, account, label, minute)`.

## Identity model

- **User**: id is a server-minted UUID that never changes — Google and
  Microsoft subs are LINKS on the account, never the identity. Daemons
  that signed in pin rows to that UUID via the envelope's `user_id`;
  otherwise the normalized `handle` (case/space-insensitive) resolves the
  user, created on first sight, with team/display refreshed on every
  report. A machine that moves handles is re-homed to the latest reporting
  user. Blank alias/platform never clobbers a known value.
- **Machine**: keyed by the daemon's stable `machine_id` UUID; alias is
  display-only, exactly like the Swift side.

## Run

```bash
go run ./cmd/migrate --driver postgres --dsn 'postgres://u:p@host/db?sslmode=disable'
TH_SERVER_DSN='postgres://u:p@host/db?sslmode=disable' TH_SYNC_TOKEN=secret go run ./cmd/server

# DuckDB instead (needs the duckdb build tag — ~100MB static link):
go run -tags duckdb ./cmd/migrate --driver duckdb --dsn /var/lib/th/cloud.duckdb
TH_SERVER_DRIVER=duckdb TH_SERVER_DSN=/var/lib/th/cloud.duckdb TH_SYNC_TOKEN=secret \
  go run -tags duckdb ./cmd/server
```

Or pin the deployment in a config file (`--config`, `$TH_SERVER_CONFIG`,
or `./server.json` when present — see `server.example.json`):

```jsonc
{
  "driver": "duckdb",                     // "postgres" when you move to pg — one-line swap
  "dsn": "/var/lib/th/cloud.duckdb",     // "postgres://u:p@host/db?sslmode=disable"
  "addr": ":8080",
  "syncToken": "change-me",
  "publicUrl": "http://localhost:8080",
  "dataDir": "./data",
  "google":    { "clientId": "", "clientSecret": "" },
  "microsoft": { "clientId": "", "clientSecret": "" }
}
```

```bash
go run -tags duckdb ./cmd/migrate --config server.json   # schema into the configured store
go run -tags duckdb ./cmd/server  --config server.json   # serve from it
```

Swapping stores later: point `driver`/`dsn` at Postgres, run `cmd/migrate`
once against it (both dialects produce the same tables), restart. Precedence
is **env > config file > default** per key, so env still wins for one-off
runs and secrets.

Env: `TH_SERVER_ADDR` (default `:8080`), `TH_SERVER_DSN` (required),
`TH_SERVER_DRIVER` (`postgres`|`duckdb`), `TH_SYNC_TOKEN` (empty = open,
local dev only), `TH_SERVER_CORS_ORIGINS` (comma-separated browser origins
allowed cross-origin — defaults cover the vite dev server and the Tauri
webview; `*` reflects any origin, dev only).

## Verify

```bash
go test ./...                                        # unit (fake store)
go test -tags duckdb ./src/interfaces/store/sqlstore/  # real SQL dialect on :memory:
```
