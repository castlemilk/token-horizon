# Usage sync consistency

Usage exports are snapshots of measured buckets, not increments. Receiving an
export must never assign an all-time total or a cumulative delta to the time of
sync.

## Native capture

`UsageEngine.leaderboardData()` collects the snapshot, daily history, weekday
heatmap and exact `breakdown.hourlyHistory` under one engine lock. SQLite
aggregates share a read transaction, and independently changing Ollama data is
sampled once. One captured date controls the export, including midnight and
daylight-saving boundaries.

- `hourlyHistory[].hour` is the original UTC-hour epoch in seconds.
- `daily[].day` and `modelHistory[].points[].day` retain their source day epoch.
- `collectedAt` orders captures; `updatedAt` is publication metadata.
- Delayed older captures cannot replace newer staged usage or UI data.
- Hourly history is bounded to the existing 120-day model-history window.

## Cloud commit

All mutations of `leaderboard.json` use `updateProfileEntries()`. A commit
compares the R2 ETag read by that attempt, or conditionally creates a missing
document. A conflict reloads the document, rechecks ownership and reapplies the
operation. Exhausted conflicts and storage failures return an error instead of
acknowledging an unsaved sync. Read-side enrichment never writes the document.

Incoming covered days replace their complete model grouping, including changes
to the membership of `Other`. Remote-only days remain intact. Retries replace
the same dated buckets rather than adding their totals again. A newer capture
may correct a count downward; explicitly older captures are rejected.

Charts use dated daily/model measurements. Cumulative ranking snapshots are not
daily usage. When old model groups disagree with a recorded daily total, the
daily total remains authoritative and an unresolved split is shown as `Other`
on that original day. No model proportions or missing timestamps are guessed.

## Regression gates

`LeaderboardBucketTests`, `cloudflare/usage-history.test.mjs`,
`cloudflare/leaderboard-storage.test.mjs` and `scripts/test-usage-history.mjs`
cover original timestamps, coherent capture, retries, corrections, overlapping
writes, ownership changes, model-group churn and chart date alignment. These
checks run in CI and the native release gate.
