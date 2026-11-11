/**
 * The version of the scoring contract a record was produced under.
 *
 * Version 1 is everything scored before 2026-11-10. Version 2 (the same date)
 * differs from version 1 in these ways, and only these:
 *   - each check declares its name and point budget (`defineCheck`), and a check
 *     that throws, times out or is skipped keeps its points in the denominator
 *     with zero points, so it scores as a clean failure of the same budget;
 *   - a browser-scored artifact the browser could not run leaves a visible
 *     `behavioural-run` fallback row, and no structure-only score is published
 *     from a failed browser: a browser that disconnects while its checks run
 *     (read from the Browser object, never from error text) is a failed run, not
 *     an artifact failure, and on the chromium backend a sweep relaunches the
 *     browser once and stops if the second attempt also fails. A page that closes
 *     itself is an artifact behaviour, scored as failed checks;
 *   - a check that could not finish (a timeout, the horizon deadline or page
 *     budget) is rescored once on a fresh page after a 2-second wait, and both
 *     attempts are logged; a timeout that survives the rescore stays in its row;
 *   - artifacts are rendered one at a time by default (BENCH_SCORE_CONCURRENCY),
 *     and a known-good probe page guards the browser before and after a pair's
 *     renders; these are scoring-process rules, logged per record;
 *   - the doubled-bracket structural rule reads the markup only, not the
 *     contents of script and style elements or comments;
 *   - records carry `scoreAllTrials`.
 * The canvas measures are the byte-level proxies of version 1, and version 2 adds
 * NO new pixel measure. A decoded-pixel measure was evaluated on 2026-11-10 and not
 * adopted (docs/lab/llm-benchmark/scorer-v2-impact.md). Records written before this
 * field existed carry no `scorerVersion` and are read as version 1.
 *
 * What version 1 and version 2 records have in common, and where they differ, is
 * measured by scripts/rescore-parity.mjs and written up in
 * docs/lab/llm-benchmark/scorer-changelog.md.
 *
 * This module is a leaf: it imports nothing, so anything in the harness can
 * stamp or read the version without a dependency cycle.
 */
export const SCORER_VERSION = 2
