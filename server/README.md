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
