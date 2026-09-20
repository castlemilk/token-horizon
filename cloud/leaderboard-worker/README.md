# Leaderboard cloud backend (Cloudflare Worker + R2)

Edge-hosted team board replacing Google Sheets as the recommended remote.
Reads are a single R2 blob served with `Cache-Control: public, max-age=60,
stale-while-revalidate=300` + ETag — typically ~50ms, usually edge-cached —
instead of Apps Script cold starts (5–15s).

## API

- `GET /leaderboard` → `{ leaderboard, updatedAt, count }` (+ ETag, 304 support)
- `GET /api/leaderboard?period=&team=` → same + `{ total, period }` (what
  `docs/leaderboard.html` fetches; `team` filters server-side)
- `POST /leaderboard` (alias `POST /api/leaderboard`) ← JSON entry +
  `Authorization: Bearer <TOKEN>` → `{ ok, id, count }`
- `GET /health` → `{ ok, backend: "r2", entries }`

Entry shape = Swift `LeaderboardEntry` keys (`handle`, `team`,
`tokensToday/7d/All`, `cost*`, `streakDays`, `topModel`, `hardware`,
`updatedAt` epoch seconds). Single-blob read-modify-write: fine for a team
board, not for high-frequency multi-writer telemetry.

## Deploy (one time, needs `wrangler login`)

```bash
cd cloud/leaderboard-worker
# 1. Point wrangler.toml at your account (`wrangler whoami` shows the ID)
# 2. Create state + secret + deploy:
npx wrangler r2 bucket create token-horizon-leaderboard
npx wrangler secret put LEADERBOARD_TOKEN   # paste a long random token
npx wrangler deploy
# 3. Point the app at it: Settings → Cloudflare URL + write token
#    (or MCP: token_horizon_leaderboard action=config cloud_url=… cloud_token=…)
```

## Test (no wrangler needed)

```bash
node --test worker.test.mjs   # 12 tests, pure logic + HTTP surface via stubs
```

## Local clients

- App: Settings → **Cloudflare cloud backend** (URL + token). Auto-sync then
  pulls every 5 min (ETag-aware) and publishes only on material change.
- MCP: `token_horizon_leaderboard` with `backend: "auto"` (default),
  `"cloud"`, or `"sheets"`.
- Web: `docs/leaderboard.html?cf=https://<worker>.workers.dev`
