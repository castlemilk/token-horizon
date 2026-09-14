# token-horizon cloud server (`/server`)

Dedicated Go ingest + sync API for Token Horizon. Daemons (meter / MITM
hosts) push what they measure; this server attributes every row to a
**user** (the logged-in human behind the handle) and their **machines**,
and serves the sync pathways (high-water, cursors, rollups, fleet) back.

```
server/
  cmd/server/        wiring: env → store → HTTP listen
  cmd/migrate/       schema migration runner (both dialects, embedded SQL)
  src/models/        primitives: User, Machine, UsageEvent, LimitSnapshot…
  src/use_cases/     business logic: Ingest (identify → store, idempotent),
                     Sync (high-water, fleet, rollups)
  src/interfaces/
    http/            routes + auth + wire mapping (CloudSync-compatible)
    store/           Store port + database/sql implementation ($n, shared DDL)
  src/testfake/      in-memory Store for unit tests
  migrations/
    postgres/        versioned schema (Postgres)
    duckdb/          versioned schema (DuckDB, same shape)
```

## Wire contract (matches Swift `CloudSync`)

Identity envelope on every push (see `CloudSchema` + `MachineIdentity`):

```json
{ "machine_id": "<daemon uuid>", "machine_alias": "devbox",
  "handle": "<os username>", "team": "", "platform": "Linux", "rows": [...] }
```

| Method | Path | Body → Result |
|---|---|---|
| `POST` | `/ingest/events` | CloudSchema usage rows → `{accepted, duplicates, user, machine}` |
| `POST` | `/ingest/limits` | CloudSchema limit rows → `{accepted, user, machine}` |
| `GET` | `/v1/sync/status?machine_id=` | server high-water vs local cursors (reconcile after offline) |
| `GET/POST` | `/v1/sync/cursors` | get/set per-dataset per-machine cursors |
| `GET` | `/v1/usage/summary?handle=&team=&since=&vendor=` | per-vendor/model rollup (leaderboard fuel; rankings derive cloud-side, never persist) |
| `GET` | `/v1/machines?handle=` | the user's device fleet |
| `GET` | `/healthz` | unauthenticated liveness |

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
| `GET`/`PATCH` | `/v1/users/me` | profile read / display-name + handle edit (409 on taken) |
| `POST` | `/v1/users/me/avatar` | multipart webp/png/jpeg ≤2MB → stored, profile pointed |
| `GET` | `/v1/avatars/{userID}` | public bytes (no auth, for `<img>`) |
| `POST`/`GET` | `/v1/teams`, `/v1/teams/join`, `/v1/teams/{id}/leave` | create (owner), list mine, join by code, leave (empties prune) |
| `POST`/`GET` | `/v1/teams/{id}/groups`, `/v1/groups/join`, `/v1/groups/{id}/leave` | team-scoped groups, same invite-code pattern |

Env additions: `TH_SERVER_PUBLIC_URL` (OAuth callback base),
`GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET`, `TH_SERVER_DATA`
(avatar dir). User routes need a session bearer; ingest keeps accepting
the service `TH_SYNC_TOKEN`.

Point a daemon at it: `TH_SYNC_URL=http://host:8080` (+ `TH_SYNC_HANDLE`,
`TH_SYNC_TEAM`). Event UUIDs make redelivery a no-op; limit snapshots dedup
on `(machine, provider, account, label, minute)`.

## Identity model

- **User**: resolved by normalized `handle` (case/space-insensitive),
  created on first sight; team/display refresh on every report. A machine
  that moves handles is re-homed to the latest reporting user. Blank
  alias/platform never clobbers a known value.
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

Env: `TH_SERVER_ADDR` (default `:8080`), `TH_SERVER_DSN` (required),
`TH_SERVER_DRIVER` (`postgres`|`duckdb`), `TH_SYNC_TOKEN` (empty = open,
local dev only).

## Verify

```bash
go test ./...                              # unit (fake store)
go test -tags duckdb ./src/interfaces/store/  # real SQL dialect on :memory:
```
