/**
 * Browser-gated tests for the horizon-suite kit. Run with BENCH_BROWSER_TESTS=1
 * (and PLAYWRIGHT_BROWSERS_PATH pointing at an installed Chromium).
 *
 * Each test opens its own browser context from the harness's sandbox backend, so
 * a test that wedges the renderer cannot leak into another test.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getSandboxBackend } from '../../../scorers/sandbox-backend'
import { closeSandbox } from '../../../scorers/sandbox'
import type { CheckContext } from '../../../scorers/check-meta'
import { defineCheck, pageStateFor, runGuarded } from './check'
import { probe, hookPresent, errorWatch, freezeMotion, withViewport, settle } from './probe'
import { freshLoad, loadOpaque, pinTimezone, altTimezonePage } from './load'
import { samplePixels, paintDiff, sampleBlockMax } from './pixels'
import { CANVAS_READ, SVG_GEOM, VISIBLE, CONTRAST_AUDIT } from './sources'
import { tabWalk } from './keys'
import { contrastRatio } from './math'

interface Opened {
  ctx: CheckContext
  close(): Promise<void>
}

/** Budget for closing a context whose renderer may be wedged. */
const CLOSE_MS = 3000

async function openContext(html: string): Promise<Opened> {
  const session = await getSandboxBackend().launch()
  const context = await session.newContext({ viewport: { width: 1024, height: 720 } })
  const page = await context.newPage()
  const ctx: CheckContext = { page, html, captureCanvas: async () => undefined }
  return {
    ctx,
    close: async () => {
      await Promise.race([
        context.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_MS)),
      ])
    },
  }
}

const opened: Opened[] = []
async function open(html: string): Promise<Opened> {
  const item = await openContext(html)
  opened.push(item)
  return item
}

afterAll(async () => {
  for (const item of opened) await item.close()
  await closeSandbox()
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('horizon-suite kit (browser)', () => {
  // -------------------------------------------------------------------------
  // defineCheck and the wrapper's guarantees
  // -------------------------------------------------------------------------

  it('defineCheck keeps maxPoints when the check throws', async () => {
    const item = await open('<p>x</p>')
    const check = defineCheck('kit-throws', 9, 'a check that throws keeps its budget', () => {
      throw new Error('kaboom')
    })
    const row = await check(item.ctx)
    expect(row).toMatchObject({ name: 'kit-throws', passed: false, points: 0, maxPoints: 9 })
    expect(row.detail).toContain('kaboom')
    expect(check.checkName).toBe('kit-throws')
    expect(check.maxPoints).toBe(9)
    expect(check.rationale).toContain('budget')
  }, 30_000)

  it('defineCheck keeps maxPoints when the run never resolves, and reports within 5 s', async () => {
    const item = await open('<p>x</p>')
    const check = defineCheck('kit-hangs', 7, 'a run that never resolves keeps its budget', () => new Promise<boolean>(() => {}))
    const started = Date.now()
    const row = await check(item.ctx)
    const elapsed = Date.now() - started
    expect(row).toMatchObject({ name: 'kit-hangs', passed: false, points: 0, maxPoints: 7 })
    expect(row.detail).toContain('deadline')
    expect(elapsed).toBeLessThan(5000)
    expect(elapsed).toBeGreaterThanOrEqual(4000)
  }, 30_000)

  it('a check that passes earns its full budget and a returned object carries its detail', async () => {
    const item = await open('<p>x</p>')
    const check = defineCheck('kit-passes', 5, 'a passing check earns the budget', async () => ({
      passed: true,
      detail: 'measured 1 bound 2',
    }))
    expect(await check(item.ctx)).toEqual({ name: 'kit-passes', passed: true, points: 5, maxPoints: 5, detail: 'measured 1 bound 2' })
  }, 30_000)

  it('a per-page budget makes later checks fail fast with their full budget', async () => {
    const item = await open('<p>x</p>')
    const first = defineCheck('kit-budget-first', 3, 'starts the page clock', async () => true)
    expect((await first(item.ctx)).passed).toBe(true)
    const firstAt = pageStateFor(item.ctx.page)!.firstAt
    // Move the wrapper's clock forward instead of waiting 20 s.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(firstAt + 21_000)
    try {
      const later = defineCheck('kit-budget-later', 6, 'runs after the page budget', async () => true)
      const row = await runGuarded('kit-budget-later', 6, item.ctx, async () => true)
      expect(row).toMatchObject({ name: 'kit-budget-later', passed: false, points: 0, maxPoints: 6 })
      expect(row.detail).toContain('budget')
      expect(later.maxPoints).toBe(6)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // probes and hooks
  // -------------------------------------------------------------------------

  it('probe refuses a function where a source string is required', async () => {
    const item = await open('<p>x</p>')
    await expect(probe(item.ctx.page, (() => 1) as unknown as string)).rejects.toThrow(TypeError)
  }, 30_000)

  it('hookPresent sees window.__bench members and contract elements, and nothing else', async () => {
    const item = await open(
      '<button id="reset-view">Reset</button><script>window.__bench = { step() {}, name: "x", empty: null };</script>'
    )
    await loadOpaque(item.ctx)
    const page = item.ctx.page
    expect(await hookPresent(page, '__bench.step')).toBe(true)
    expect(await hookPresent(page, '__bench.name')).toBe(true)
    expect(await hookPresent(page, 'window.__bench.step')).toBe(true)
    expect(await hookPresent(page, '__bench.missing')).toBe(false)
    expect(await hookPresent(page, '__bench.empty')).toBe(false)
    expect(await hookPresent(page, '#reset-view')).toBe(true)
    expect(await hookPresent(page, '#nope')).toBe(false)
  }, 30_000)

  it('freezeMotion stops CSS transitions and is idempotent per document', async () => {
    const item = await open('<div id="t" style="width:10px;transition:width 5s linear">x</div>')
    await loadOpaque(item.ctx)
    await freezeMotion(item.ctx.page)
    await freezeMotion(item.ctx.page)
    const style = await probe<{ duration: string; styles: number }>(
      item.ctx.page,
      '() => ({ duration: getComputedStyle(document.getElementById("t")).transitionDuration, styles: document.querySelectorAll("#__bench_freeze").length })'
    )
    expect(style).toEqual({ duration: '0s', styles: 1 })
  }, 30_000)

  it('freezeMotion finishes an entrance animation that fills forwards, so the drawing is not blanked', async () => {
    const item = await open(
      '<style>@keyframes fade{to{opacity:1}}</style><div id="t" style="opacity:0;animation:fade .4s forwards">x</div>'
    )
    await loadOpaque(item.ctx)
    await freezeMotion(item.ctx.page)
    const opacity = await probe<string>(item.ctx.page, '() => getComputedStyle(document.getElementById("t")).opacity', undefined, 1000)
    expect(opacity).toBe('1')
  }, 30_000)

  it('errorWatch collects uncaught errors and engine-error alerts, then detaches', async () => {
    const item = await open(
      '<div role="alert">ReferenceError: pricing is not defined</div><script>throw new Error("boom at start")</script>'
    )
    const watch = errorWatch(item.ctx.page)
    try {
      await loadOpaque(item.ctx)
      expect(watch.pageErrors.join(' | ')).toContain('boom at start')
      expect(await watch.engineErrors()).toEqual(['ReferenceError: pricing is not defined'])
    } finally {
      watch.detach()
    }
    expect(watch.pageErrors.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  // -------------------------------------------------------------------------
  // loading
  // -------------------------------------------------------------------------

  const STORAGE_PROBE = `() => {
    try {
      var empty = localStorage.length === 0;
      localStorage.setItem('probe', '1');
      var works = localStorage.getItem('probe') === '1';
      localStorage.removeItem('probe');
      return { empty: empty, works: works };
    } catch (e) { return { empty: null, works: false, error: e.name }; }
  }`

  it('freshLoad gives working, empty localStorage, and a second load on the same origin sees what was stored', async () => {
    const item = await open('<p>storage</p>')
    const origin = await freshLoad(item.ctx)
    expect(origin).toMatch(/^http:\/\/c\d+\.bench\.invalid$/)
    expect(await probe(item.ctx.page, STORAGE_PROBE)).toEqual({ empty: true, works: true })

    await probe(item.ctx.page, "() => { localStorage.setItem('kept', 'yes'); return true; }")

    const again = await freshLoad(item.ctx, { origin })
    expect(again).toBe(origin)
    expect(await probe(item.ctx.page, "() => localStorage.getItem('kept')")).toBe('yes')

    const other = await freshLoad(item.ctx)
    expect(other).not.toBe(origin)
    expect(await probe(item.ctx.page, "() => localStorage.getItem('kept')")).toBeNull()
  }, 30_000)

  it('freshLoad aborts requests to other hosts and answers the favicon', async () => {
    const item = await open('<img src="http://example.invalid/x.png"><p id="ok">loaded</p>')
    await freshLoad(item.ctx)
    expect(await probe(item.ctx.page, "() => document.getElementById('ok').textContent")).toBe('loaded')
  }, 30_000)

  it('loadOpaque makes localStorage throw (or be unavailable)', async () => {
    const item = await open('<p>opaque</p>')
    await loadOpaque(item.ctx)
    const result = await probe<{ worked: boolean; error?: string }>(
      item.ctx.page,
      `() => { try { localStorage.setItem('x', '1'); return { worked: true }; } catch (e) { return { worked: false, error: e.name }; } }`
    )
    expect(result.worked).toBe(false)
  }, 30_000)

  it('pinTimezone changes the offset reported inside fn and restores it afterwards', async () => {
    const item = await open('<p>zone</p>')
    await loadOpaque(item.ctx)
    const offsetSource = '() => new Date(Date.UTC(2025, 0, 15, 12)).getTimezoneOffset()'
    const before = await probe<number>(item.ctx.page, offsetSource)
    const inside = await pinTimezone(item.ctx.page, 'Pacific/Kiritimati', () => probe<number>(item.ctx.page, offsetSource))
    expect(inside).toBe(-840)
    const insideKolkata = await pinTimezone(item.ctx.page, 'Asia/Kolkata', () => probe<number>(item.ctx.page, offsetSource))
    expect(insideKolkata).toBe(-330)
    expect(await probe<number>(item.ctx.page, offsetSource)).toBe(before)
  }, 30_000)

  it('altTimezonePage loads the artifact in a second context with its own zone', async () => {
    const item = await open('<p>alt</p>')
    await loadOpaque(item.ctx)
    const alt = await altTimezonePage(item.ctx, 'Asia/Kolkata')
    try {
      expect(await probe<number>(alt.page, '() => new Date(Date.UTC(2025, 0, 15, 12)).getTimezoneOffset()')).toBe(-330)
      expect(await probe<string>(alt.page, '() => document.querySelector("p").textContent')).toBe('alt')
    } finally {
      await alt.close()
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // pixels
  // -------------------------------------------------------------------------

  it('samplePixels returns the exact fill colour of two different solid rectangles', async () => {
    const item = await open(
      '<body style="margin:0">' +
        '<div style="position:absolute;left:10px;top:10px;width:100px;height:50px;background:rgb(200,30,90)"></div>' +
        '<div style="position:absolute;left:200px;top:100px;width:80px;height:40px;background:rgb(12,180,77)"></div>' +
        '</body>'
    )
    await loadOpaque(item.ctx)
    const colours = await samplePixels(
      item.ctx.page,
      { x: 0, y: 0, width: 400, height: 300 },
      [
        { x: 50, y: 30 },
        { x: 240, y: 120 },
        { x: 5, y: 5 },
      ]
    )
    expect(colours).toEqual([
      [200, 30, 90, 1],
      [12, 180, 77, 1],
      [255, 255, 255, 1],
    ])
  }, 30_000)

  it('sampleBlockMax takes the per-channel maximum, so it finds a bright 1 px stroke beside a point', async () => {
    // Black page, white 1 px stroke in column 50. The 3-px block around x=50 covers
    // the stroke; the block around x=52 (columns 51 to 53) does not.
    const item = await open(
      '<body style="margin:0;background:#000"><div style="position:absolute;left:50px;top:50px;width:1px;height:40px;background:#fff"></div></body>'
    )
    await loadOpaque(item.ctx)
    const [at, away] = await sampleBlockMax(item.ctx.page, { x: 0, y: 0, width: 120, height: 120 }, [
      { x: 50, y: 60 },
      { x: 52, y: 60 },
    ], 1)
    expect(at![0]).toBe(255)
    expect(away![0]).toBe(0)
  }, 30_000)

  it('paintDiff reports a large difference where an element paints and about zero elsewhere', async () => {
    const item = await open(
      '<body style="margin:0"><div id="paint" style="position:absolute;left:300px;top:200px;width:60px;height:60px;background:rgb(200,30,90)"></div></body>'
    )
    await loadOpaque(item.ctx)
    const [inside, outside] = await paintDiff(item.ctx.page, { x: 0, y: 0, width: 500, height: 400 }, '#paint', [
      { x: 330, y: 230 },
      { x: 50, y: 50 },
    ])
    expect(inside).toBeGreaterThanOrEqual(200)
    expect(outside).toBeLessThanOrEqual(2)
    // The style insertion is removed again: the element paints as before.
    const after = await samplePixels(item.ctx.page, { x: 0, y: 0, width: 500, height: 400 }, [{ x: 330, y: 230 }])
    expect(after[0]).toEqual([200, 30, 90, 1])
  }, 30_000)

  it('CANVAS_READ reads the modal colour, a point and a block mean from a 2d canvas', async () => {
    const item = await open(
      '<canvas id="c" width="50" height="40"></canvas><script>' +
        "var x = document.getElementById('c').getContext('2d');" +
        "x.fillStyle = 'rgb(10,200,30)'; x.fillRect(0, 0, 50, 40);" +
        "x.fillStyle = 'rgb(255,0,0)'; x.fillRect(0, 0, 10, 10);" +
        '</script>'
    )
    await loadOpaque(item.ctx)
    const read = await probe<{
      ok: boolean
      modal: number[]
      points: Array<number[] | null>
      means: Array<number[] | null>
    }>(item.ctx.page, CANVAS_READ, { selector: '#c', points: [[5, 5], [30, 30], [60, 60]], rects: [[10, 0, 40, 40]] })
    expect(read.ok).toBe(true)
    expect(read.modal).toEqual([10, 200, 30, 255])
    expect(read.points).toEqual([[255, 0, 0, 255], [10, 200, 30, 255], null])
    expect(read.means[0]![0]).toBeCloseTo(10, 6)
  }, 30_000)

  it('CANVAS_READ explains a canvas with no 2d context, when WebGL is available', async () => {
    const item = await open('<canvas id="g"></canvas><script>window.__gl = !!document.getElementById("g").getContext("webgl");</script>')
    await loadOpaque(item.ctx)
    const hasGl = await probe<boolean>(item.ctx.page, '() => window.__gl === true')
    if (!hasGl) return // this Chromium has no WebGL; the 2d path is covered above
    const read = await probe<{ ok: boolean; detail?: string }>(item.ctx.page, CANVAS_READ, { selector: '#g' })
    expect(read.ok).toBe(false)
    expect(read.detail).toContain('no 2d context')
  }, 30_000)

  // -------------------------------------------------------------------------
  // SVG geometry and visibility
  // -------------------------------------------------------------------------

  it('SVG_GEOM returns correct screen coordinates for a line in a rotated, scaled group', async () => {
    const item = await open(
      '<body style="margin:0"><svg id="s" width="400" height="300" style="position:absolute;left:0;top:0;display:block">' +
        '<g id="g" transform="translate(100 50) rotate(30) scale(2)">' +
        '<line id="l" x1="10" y1="0" x2="0" y2="20" stroke="black"/>' +
        '</g></svg></body>'
    )
    await loadOpaque(item.ctx)
    const geom = await probe<{ ok: boolean; a: { x: number; y: number }; b: { x: number; y: number } }>(
      item.ctx.page,
      SVG_GEOM,
      { op: 'lineScreen', selector: '#l' }
    )
    // Independent reference: scale 2, then rotate 30 degrees, then translate.
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const map = (x: number, y: number) => {
      const sx = 2 * x
      const sy = 2 * y
      return { x: sx * c - sy * s + 100, y: sx * s + sy * c + 50 }
    }
    const wantA = map(10, 0)
    const wantB = map(0, 20)
    expect(geom.ok).toBe(true)
    expect(Math.abs(geom.a.x - wantA.x)).toBeLessThan(0.01)
    expect(Math.abs(geom.a.y - wantA.y)).toBeLessThan(0.01)
    expect(Math.abs(geom.b.x - wantB.x)).toBeLessThan(0.01)
    expect(Math.abs(geom.b.y - wantB.y)).toBeLessThan(0.01)
  }, 30_000)

  it('SVG_GEOM reports a clear failure for the wrong element type', async () => {
    const item = await open('<body style="margin:0"><svg width="50" height="50"><rect id="r" x="1" y="2" width="3" height="4"/></svg></body>')
    await loadOpaque(item.ctx)
    const wrong = await probe<{ ok: boolean; detail?: string }>(item.ctx.page, SVG_GEOM, { op: 'lineScreen', selector: '#r' })
    expect(wrong.ok).toBe(false)
    expect(wrong.detail).toContain('not a line')
  }, 30_000)

  it('VISIBLE says a decoy overlay covers the target, and passes an uncovered target', async () => {
    const decoy = await open(
      '<body style="margin:0"><button id="target" style="position:absolute;left:100px;top:100px;width:80px;height:30px">Go</button>' +
        '<div style="position:absolute;left:90px;top:90px;width:120px;height:60px;background:#fff"></div></body>'
    )
    await loadOpaque(decoy.ctx)
    const covered = await probe<{ visible: boolean; detail: string }>(decoy.ctx.page, VISIBLE, '#target')
    expect(covered.visible).toBe(false)
    expect(covered.detail).toContain('covered by')

    const plain = await open(
      '<body style="margin:0"><button id="target" style="position:absolute;left:100px;top:100px;width:80px;height:30px">Go</button></body>'
    )
    await loadOpaque(plain.ctx)
    expect(await probe<{ visible: boolean }>(plain.ctx.page, VISIBLE, '#target')).toMatchObject({ visible: true })
    expect(await probe<{ visible: boolean }>(plain.ctx.page, VISIBLE, '#missing')).toMatchObject({ visible: false })
  }, 30_000)

  // -------------------------------------------------------------------------
  // contrast
  // -------------------------------------------------------------------------

  it('CONTRAST_AUDIT passes a high-contrast page and flags a low-contrast element', async () => {
    const good = await open('<body style="background:#fff;margin:0"><p style="color:#111">Readable heading text</p></body>')
    await loadOpaque(good.ctx)
    const passing = await probe<{ ok: boolean; checked: number; failing: unknown }>(good.ctx.page, CONTRAST_AUDIT)
    expect(passing.ok).toBe(true)
    expect(passing.checked).toBeGreaterThanOrEqual(1)
    expect(passing.failing).toBeNull()

    const bad = await open('<body style="background:#fff;margin:0"><p id="low" style="color:#eee">Pale text here</p></body>')
    await loadOpaque(bad.ctx)
    const failing = await probe<{
      ok: boolean
      failing: { id: string; ratio: number; required: number } | null
      lowest: Array<{ ratio: number }>
    }>(bad.ctx.page, CONTRAST_AUDIT)
    expect(failing.ok).toBe(false)
    expect(failing.failing).toMatchObject({ id: 'low', required: 4.5 })
    expect(failing.failing!.ratio).toBeLessThan(2)
    expect(failing.lowest.length).toBe(1)
    // The in-page ratio agrees with the Node reference (#eee on white).
    expect(failing.failing!.ratio).toBeCloseTo(contrastRatio([238, 238, 238], [255, 255, 255]), 9)
  }, 30_000)

  it('CONTRAST_AUDIT applies opacity and the large-text rule', async () => {
    // #777 on white is 4.48:1: below 4.5 at 16px, but a large 24px text needs only 3.
    const small = await open('<body style="background:#fff;margin:0"><p style="color:#777;font-size:16px">Grey small text</p></body>')
    await loadOpaque(small.ctx)
    expect(await probe<{ ok: boolean }>(small.ctx.page, CONTRAST_AUDIT)).toMatchObject({ ok: false })

    const large = await open('<body style="background:#fff;margin:0"><p style="color:#777;font-size:24px">Grey large text</p></body>')
    await loadOpaque(large.ctx)
    expect(await probe<{ ok: boolean }>(large.ctx.page, CONTRAST_AUDIT)).toMatchObject({ ok: true })

    // Half-transparent text: its alpha is multiplied by the element's opacity.
    const faded = await open('<body style="background:#fff;margin:0"><p style="color:#000;opacity:0.1">Faded text here</p></body>')
    await loadOpaque(faded.ctx)
    expect(await probe<{ ok: boolean }>(faded.ctx.page, CONTRAST_AUDIT)).toMatchObject({ ok: false })
  }, 30_000)

  // -------------------------------------------------------------------------
  // viewport and keyboard
  // -------------------------------------------------------------------------

  it('withViewport restores the viewport after a throw', async () => {
    const item = await open('<p>viewport</p>')
    await loadOpaque(item.ctx)
    const size = '() => ({ w: innerWidth, h: innerHeight })'
    await expect(
      withViewport(item.ctx.page, 600, 400, async () => {
        expect(await probe<{ w: number; h: number }>(item.ctx.page, size)).toEqual({ w: 600, h: 400 })
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await probe<{ w: number; h: number }>(item.ctx.page, size)).toEqual({ w: 1024, h: 720 })
  }, 30_000)

  it('tabWalk visits three buttons in order, with the focused and unfocused styles', async () => {
    const item = await open(
      '<body><button id="b1">One</button><div>not focusable</div><button id="b2">Two</button><button id="b3">Three</button></body>'
    )
    await loadOpaque(item.ctx)
    await settle(item.ctx.page)
    const walk = await tabWalk(item.ctx.page, 8)
    expect(walk.visits.map((v) => v.identity)).toEqual(['b1', 'b2', 'b3'])
    expect(walk.ended).not.toBe('limit')
    expect(walk.unfocusedBefore.map((v) => v.identity)).toEqual(['b1', 'b2', 'b3'])
    expect(walk.unfocusedAfter.map((v) => v.identity)).toEqual(['b1', 'b2', 'b3'])
    // Nothing is left focused, and the sentinel is gone.
    expect(await probe<boolean>(item.ctx.page, "() => document.getElementById('__bench_tab_start') === null")).toBe(true)
  }, 30_000)

  it('tabWalk rejects a press limit that is not a positive integer', async () => {
    const item = await open('<button>x</button>')
    await loadOpaque(item.ctx)
    await expect(tabWalk(item.ctx.page, 0)).rejects.toThrow(RangeError)
  }, 30_000)

  // -------------------------------------------------------------------------
  // Renderer-wedging tests run LAST: each leaves a page whose main thread never
  // returns, so nothing after them may share its renderer.
  // -------------------------------------------------------------------------

  it('probe returns values and times out on an infinite loop without hanging the test', async () => {
    const item = await open('<p>x</p>')
    expect(await probe(item.ctx.page, '(a) => a * 2', 21)).toBe(42)
    expect(await probe(item.ctx.page, '() => ({ ok: true, list: [1, 2] })')).toEqual({ ok: true, list: [1, 2] })
    const started = Date.now()
    await expect(probe(item.ctx.page, '() => { for (;;) {} }', undefined, 300)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 30_000)

  it('a second check on a poisoned page fails fast with its full budget', async () => {
    const item = await open('<p>busy</p>')
    // The page's main thread never returns: the evaluate never resolves and the
    // 500 ms poison probe cannot run either, so the page is marked poisoned.
    const wedge = defineCheck('kit-wedge', 4, 'wedges the renderer on purpose', () =>
      item.ctx.page.evaluate('(() => { for (;;) {} })()') as unknown as Promise<boolean>
    )
    const first = await wedge(item.ctx)
    expect(first).toMatchObject({ passed: false, points: 0, maxPoints: 4 })
    expect(first.detail).toContain('unresponsive')
    expect(pageStateFor(item.ctx.page)?.poisoned).toBeDefined()

    const later = defineCheck('kit-after-wedge', 6, 'runs on a poisoned page', async () => true)
    const started = Date.now()
    const row = await later(item.ctx)
    const elapsed = Date.now() - started
    expect(row).toMatchObject({ name: 'kit-after-wedge', passed: false, points: 0, maxPoints: 6 })
    expect(row.detail).toContain('unresponsive')
    expect(elapsed).toBeLessThan(500)
  }, 30_000)
})
