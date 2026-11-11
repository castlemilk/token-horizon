import { afterAll, describe, expect, it } from 'vitest'
import { closeSandbox, runChecks } from './sandbox'

afterAll(closeSandbox)

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('rendered canvas capture', () => {
  it('observes WebGL animation without requiring preserveDrawingBuffer', async () => {
    const html = `<canvas width="240" height="160"></canvas><script>
const gl=document.querySelector('canvas').getContext('webgl');
if(!gl)throw new Error('WebGL unavailable');
function draw(t){gl.clearColor((Math.sin(t/300)+1)/2,.2,.7,1);gl.clear(gl.COLOR_BUFFER_BIT);requestAnimationFrame(draw)}
requestAnimationFrame(draw);
</script>`
    const results = await runChecks(html, [async (ctx) => {
      const before = await ctx.captureCanvas()
      await ctx.page.waitForTimeout(350)
      const after = await ctx.captureCanvas()
      return { name: 'webgl-motion', passed: Boolean(before && after && !before.data.equals(after.data)), points: 0, maxPoints: 1 }
    }])
    expect(results.every((r) => r.passed), JSON.stringify(results)).toBe(true)
  }, 15000)

  it('refuses the withdrawn canvas-only option, and the element capture still sees DOM laid over the canvas', async () => {
    // A static canvas with a live readout on top of it. Version 2 reverts the
    // canvas-only capture, so the readout is part of the element capture, as it
    // was in version 1. The option must fail loudly, not return a page capture.
    const html = `<div style="position:relative;width:240px;height:160px">
<canvas width="240" height="160" style="position:absolute;left:0;top:0"></canvas>
<div id="readout" style="position:absolute;left:10px;top:10px;background:#fff;color:#000;font:24px sans-serif">0</div>
</div><script>
const g=document.querySelector('canvas').getContext('2d');g.fillStyle='#345';g.fillRect(0,0,240,160);
let n=0;setInterval(()=>{document.getElementById('readout').textContent=String(++n)},100);
</script>`
    const results = await runChecks(html, [async (ctx) => {
      let refused = false
      try {
        await ctx.captureCanvas('canvas', { canvasOnly: true })
      } catch (e) {
        refused = e instanceof Error && /canvasOnly was withdrawn/.test(e.message)
      }
      const pageBefore = await ctx.captureCanvas()
      await ctx.page.waitForTimeout(350)
      const pageAfter = await ctx.captureCanvas()
      const pageChanged = !pageBefore!.data.equals(pageAfter!.data)
      return {
        name: 'canvas-capture-withdrawn',
        passed: refused && pageChanged,
        points: 0,
        maxPoints: 1,
        detail: `canvasOnly refused ${String(refused)}, element capture changed ${String(pageChanged)}`,
      }
    }])
    expect(results[0]!.passed, results[0]!.detail).toBe(true)
  }, 15000)
})
