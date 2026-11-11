/**
 * What a check row says when a check could not finish in time. Dependency-free
 * on purpose: verify-results.ts reads these patterns from stored breakdowns, and
 * must not load Playwright to do it.
 *
 * Whether the BROWSER died is not decided here. That is read from the Browser
 * object (`SandboxSession.isConnected`, see sandbox-backend.ts), never from text:
 * a page that closes itself, or an artifact that throws "Target closed", is the
 * artifact's behaviour and is scored as failed checks.
 *
 * A check that could not finish is a different case. It did not fail on its
 * merits, so the scorer rescores that artifact once on a fresh page (see
 * browser-fallback.ts). The shapes below are every message the harness and its
 * plugins write when a check runs out of time:
 *  - the sandbox's own per-check timer and batch budget (scorers/sandbox.ts);
 *  - a Playwright TimeoutError a check caught and returned as its detail
 *    (plugins/visual-games/checks.ts returns String(error));
 *  - the horizon kit's deadline and page-budget rows (plugins/horizon-suite/lib/check.ts).
 */

/**
 * Every shape a check row takes when the check did not finish in time. Each
 * alternative is a message the harness or its plugins write, not a loose
 * "timeout" match, so an ordinary failed check is never taken for one:
 *
 *  - `check timeout after Nms`: the sandbox's per-check timer (scorers/sandbox.ts);
 *  - `skipped: batch timeout`: the sandbox's batch budget;
 *  - `<action> timed out after N ms`: the horizon kit's bounded() and probe
 *    deadlines (plugins/horizon-suite/lib/probe.ts), e.g. "reload timed out after 3000 ms";
 *  - `Timeout Nms exceeded`: Playwright's own wording for a locator or page wait;
 *  - `TimeoutError` at the start of a detail, or after `threw: `: a Playwright
 *    TimeoutError a check returned or threw (plugins/visual-games/checks.ts returns
 *    String(error)). Anchored, so an artifact's own text cannot match it;
 *  - `deadline: no result within Nms`, `skipped: page unresponsive after`,
 *    `skipped: page budget of Nms`: the horizon kit's check deadline and page budget
 *    (plugins/horizon-suite/lib/check.ts);
 *  - `stopped at the deadline`: a check that saw its own deadline
 *    (plugins/horizon-suite/tasks/rlc-response-lab/checks.ts).
 */
const TIMEOUT_DETAIL = new RegExp(
  [
    'check timeout after \\d+ ?ms',
    'skipped: batch timeout',
    'timed out after \\d+ ?ms',
    'Timeout \\d+ ?ms exceeded',
    '^(?:threw: )?TimeoutError\\b',
    'deadline: no result within \\d+ ?ms',
    'skipped: page unresponsive after',
    'skipped: page budget of \\d+ ?ms',
    '^stopped at the deadline$',
  ].join('|')
)

/** True when a check row's detail says the check did not finish in time. */
export function isTimeoutDetail(detail: string | undefined): boolean {
  return TIMEOUT_DETAIL.test(detail ?? '')
}

/**
 * True when a breakdown row is a SCORED check that ran out of time. Fallback rows
 * (the browser never ran the checks) and zero-budget rows (the `no-runtime-errors`
 * row, which reports an artifact's own page errors) are not checks, so they never
 * trigger a rescore, whatever their text says.
 */
export function isTimeoutRow(check: { name: string; kind?: string; maxPoints: number; detail?: string }): boolean {
  if (check.kind === 'fallback' || check.name === 'no-runtime-errors' || check.maxPoints <= 0) return false
  return isTimeoutDetail(check.detail)
}
