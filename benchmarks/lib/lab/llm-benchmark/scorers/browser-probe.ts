/**
 * The known-good probe: a small animated WebGL page that any healthy browser
 * passes, scored with the same per-check budgets as a real artifact.
 *
 * A machine that cannot keep time makes checks miss their timers and return
 * clean failures on pages that work. The probe is the machine's own test of
 * that. browser-fallback.ts runs it before a pair's artifacts are rendered and
 * again after them, and stops the sweep when the probe keeps failing.
 *
 * The page is built into the harness on purpose: a probe that depended on an
 * artifact could fail for the artifact's reasons.
 */
import { defineCheck, type CheckFn } from './check-meta'
import { runChecks } from './sandbox'
import type { ProbeOutcome } from './browser-fallback'

/** The probe page. A WebGL clear that changes every frame, and a button that counts presses. */
export const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;background:#000}canvas{display:block}#probe-button{position:absolute;top:0;left:0}</style>
</head><body>
<canvas id="probe-scene" width="320" height="240"></canvas>
<button id="probe-button" data-count="0">press</button>
<script>
(function () {
  var canvas = document.getElementById('probe-scene');
  var gl = canvas.getContext('webgl');
  var ctx2d = gl ? null : canvas.getContext('2d');
  var t = 0;
  function frame() {
    t++;
    if (gl) {
      gl.clearColor((t % 60) / 60, 0.2, 0.4, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else if (ctx2d) {
      ctx2d.fillStyle = 'hsl(' + (t % 360) + ',70%,50%)';
      ctx2d.fillRect(0, 0, 320, 240);
    }
    requestAnimationFrame(frame);
  }
  frame();
  var button = document.getElementById('probe-button');
  button.addEventListener('click', function () {
    button.dataset.count = String(Number(button.dataset.count) + 1);
  });
})();
</script>
</body></html>`

/** The probe's checks. Budgets match the harness's own point rows, so a probe row reads like an artifact row. */
export const PROBE_CHECKS: CheckFn[] = [
  defineCheck('probe-animates', 30, async (ctx) => {
    const first = await ctx.captureCanvas('canvas#probe-scene')
    await ctx.page.waitForTimeout(300)
    const second = await ctx.captureCanvas('canvas#probe-scene')
    const passed = first !== undefined && second !== undefined && !first.data.equals(second.data)
    return { name: 'probe-animates', passed, points: passed ? 30 : 0, maxPoints: 30 }
  }),
  defineCheck('probe-responds', 30, async (ctx) => {
    await ctx.page.locator('#probe-button').click({ timeout: 5000 })
    const count = await ctx.page.locator('#probe-button').getAttribute('data-count')
    const passed = count === '1'
    return { name: 'probe-responds', passed, points: passed ? 30 : 0, maxPoints: 30 }
  }),
]

/**
 * Score the probe page with the artifact budgets (settle, per-check and batch
 * caps as scorers/behavioral.ts uses them). Never throws: a probe that cannot run
 * is a probe that failed, and the caller decides what that means.
 */
export async function probeKnownGoodBrowser(): Promise<ProbeOutcome> {
  try {
    const rows = await runChecks(PROBE_HTML, PROBE_CHECKS, {
      settleMs: 600,
      perCheckTimeoutMs: 6000,
      totalTimeoutMs: 25_000,
    })
    const failing = rows.filter((r) => !r.passed).map((r) => `${r.name}: ${r.detail ?? 'failed'}`)
    return { ok: failing.length === 0, failing }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // A browser that will not launch at all is not load: the same launch fails again.
    const fatal = /browserType\.launch|Executable doesn't exist/.test(message)
    return { ok: false, failing: [`probe threw: ${message}`], fatal }
  }
}
