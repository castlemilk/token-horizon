/**
 * Browser-gated tests for the review fixes in the kit (BENCH_BROWSER_TESTS=1).
 * Each test names the defect it pins. Every test opens its own browser context, so a
 * test that wedges a renderer cannot leak into another.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { getSandboxBackend } from '../../../scorers/sandbox-backend'
import { closeSandbox } from '../../../scorers/sandbox'
import type { CheckContext } from '../../../scorers/check-meta'
import { defineCheck, runGuarded, pageStateFor } from './check'
import { probe, hookPresent, waitForHook, errorWatch, freezeMotion } from './probe'
import { freshLoad, loadOpaque, pinTimezone } from './load'
import { samplePixels } from './pixels'
import { CANVAS_READ, LINE_SCREENS, SVG_GEOM, VISIBLE, CONTRAST_AUDIT } from './sources'
import { tabWalk } from './keys'

interface Opened {
  ctx: CheckContext
  close(): Promise<void>
}

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
  await loadOpaque(item.ctx)
  return item
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const OFFSET_SOURCE = '() => new Date(2026, 0, 15, 12, 0, 0).getTimezoneOffset()'

afterAll(async () => {
  for (const item of opened) await item.close()
  await closeSandbox()
})

describe.runIf(process.env.BENCH_BROWSER_TESTS === '1')('horizon-suite kit review fixes (browser)', () => {
  // -------------------------------------------------------------------------
  // check.ts: abandoned runs and timeout poisoning
  // -------------------------------------------------------------------------

  it('a run abandoned at its deadline does not act on the page during the next check', async () => {
    const item = await open('<p>x</p>')
    const zombie = defineCheck('zombie', 5, 'a run that outlives its deadline', async (ctx) => {
      await sleep(4700)
      await probe(ctx.page, '(v) => { window.__victim = v; return true; }', 'ZOMBIE')
      return true
    })
    const victim = defineCheck('victim', 5, 'a check that writes and reads back page state', async (ctx) => {
      await probe(ctx.page, '(v) => { window.__victim = v; return true; }', 'victim-state')
      await sleep(600)
      const read = await probe<string>(ctx.page, '() => window.__victim', undefined, 1000)
      return { passed: read === 'victim-state', detail: `read ${read}` }
    })
    const first = await zombie(item.ctx)
    expect(first).toMatchObject({ passed: false, detail: expect.stringContaining('deadline') })
    const second = await victim(item.ctx)
    expect(second, JSON.stringify(second)).toMatchObject({ passed: true, points: 5 })
  }, 20_000)

  it('a check whose predecessor never returns fails with its full budget and poisons the page', async () => {
    const item = await open('<p>x</p>')
    const stuck = defineCheck('stuck', 4, 'a run that never returns', () => new Promise<boolean>(() => {}))
    const after = defineCheck('after', 6, 'a check after a stuck run', () => true)
    expect(await stuck(item.ctx)).toMatchObject({ passed: false, maxPoints: 4 })
    const row = await after(item.ctx)
    expect(row).toMatchObject({ passed: false, points: 0, maxPoints: 6 })
    expect(row.detail).toContain('still acting on the page')
    const later = await after(item.ctx)
    expect(later.detail).toContain('page unresponsive')
  }, 25_000)

  it('a timeout-shaped error on a wedged page poisons it at once, not after every later timer', async () => {
    const item = await open('<p>x</p>')
    const wedge = defineCheck('wedge', 4, 'a probe that loops forever', async (ctx) => {
      await probe(ctx.page, '() => { while (true) {} }', undefined, 300)
      return true
    })
    const next = defineCheck('next', 6, 'the next check on the wedged page', async (ctx) => {
      await hookPresent(ctx.page, '__bench.step')
      return true
    })
    const started = Date.now()
    const first = await wedge(item.ctx)
    expect(first.passed).toBe(false)
    const second = await next(item.ctx)
    expect(second.passed).toBe(false)
    expect(second.detail).toContain('page unresponsive')
    expect(Date.now() - started).toBeLessThan(4000)
  }, 20_000)

  it('runGuarded keeps the page state per page (a fresh page starts clean)', async () => {
    const item = await open('<p>x</p>')
    const ok = defineCheck('clean', 3, 'a passing check', () => true)
    await ok(item.ctx)
    expect(pageStateFor(item.ctx.page)?.poisoned).toBeUndefined()
    const other = await open('<p>y</p>')
    const row = await runGuarded('direct', 2, other.ctx, () => true)
    expect(row).toMatchObject({ passed: true, points: 2 })
  }, 20_000)

  // -------------------------------------------------------------------------
  // load.ts: network, origins, popups, timers and timezone pins
  // -------------------------------------------------------------------------

  it('a wedged page cannot make freshLoad hang: the call settles within the action budgets', async () => {
    const item = await open('<p>x</p>')
    await freshLoad(item.ctx)
    await probe(item.ctx.page, '() => { while (true) {} }', undefined, 200).catch(() => undefined)
    const verdict = await Promise.race([
      freshLoad(item.ctx).then(
        () => 'loaded',
        () => 'rejected'
      ),
      sleep(10_000).then(() => 'hung'),
    ])
    expect(verdict).not.toBe('hung')
  }, 30_000)

  it('the hosted page cannot fetch anything but the root navigation, with or without a query', async () => {
    const item = await open('<p>x</p>')
    await freshLoad(item.ctx)
    const result = await probe<string[]>(
      item.ctx.page,
      `() => Promise.all(['/?x=1', '/', 'http://example.invalid/'].map(function (u) {
        return fetch(u).then(function () { return 'resolved'; }, function () { return 'rejected'; });
      }))`,
      undefined,
      3000
    )
    expect(result).toEqual(['rejected', 'rejected', 'rejected'])
  }, 20_000)

  it('a WebSocket from the hosted page is closed without connecting', async () => {
    const item = await open('<p>x</p>')
    await freshLoad(item.ctx)
    const outcome = await probe<string>(
      item.ctx.page,
      `() => new Promise(function (resolve) {
        var ws;
        try { ws = new WebSocket('ws://' + location.host + '/ws'); } catch (e) { resolve('threw'); return; }
        ws.onopen = function () { resolve('opened'); };
        ws.onclose = function () { resolve('closed'); };
      })`,
      undefined,
      3000
    )
    expect(outcome).toBe('closed')
  }, 20_000)

  it('a popup the page opens is closed and its request is aborted', async () => {
    const item = await open('<p>x</p>')
    await freshLoad(item.ctx)
    const popupEvent = item.ctx.page.waitForEvent('popup', { timeout: 1500 }).catch(() => null)
    await probe(item.ctx.page, '() => { window.open("/popup-target"); return true; }', undefined, 1500)
    const popup = await popupEvent
    expect(popup).not.toBeNull()
    await sleep(300)
    expect(popup!.isClosed()).toBe(true)
  }, 20_000)

  it('window.name and cookies do not carry from one bench origin to the next', async () => {
    const item = await open('<script>window.name = "carried"; document.cookie = "leak=1; domain=.bench.invalid; path=/";</script><p>x</p>')
    await freshLoad(item.ctx)
    expect(await probe(item.ctx.page, '() => window.name', undefined, 1000)).toBe('carried')
    item.ctx.html = '<p>y</p>'
    await freshLoad(item.ctx)
    const seen = await probe<[string, string]>(item.ctx.page, '() => [window.name, document.cookie]', undefined, 1000)
    expect(seen[0]).toBe('')
    expect(seen[1]).not.toContain('leak=1')
  }, 20_000)

  it('the opaque load keeps every request aborted, so the page cannot reach the network', async () => {
    const item = await open('<p>x</p>')
    await loadOpaque(item.ctx)
    const verdict = await probe<string>(
      item.ctx.page,
      `() => fetch('http://example.invalid/').then(function () { return 'resolved'; }, function () { return 'rejected'; })`,
      undefined,
      3000
    )
    expect(verdict).toBe('rejected')
  }, 20_000)

  it('a start-up hook installed 300 ms after load is present after freshLoad (the 600 ms harness settle)', async () => {
    const item = await open('<script>setTimeout(function () { window.__late = 1; }, 300);</script><p>x</p>')
    await freshLoad(item.ctx)
    expect(await hookPresent(item.ctx.page, '__late')).toBe(true)
  }, 20_000)

  it('waitForHook finds a late hook within its cap, and returns false when the cap passes first', async () => {
    const item = await open('<script>setTimeout(function () { window.__soon = 1; }, 300);</script>')
    await freshLoad(item.ctx)
    expect(await waitForHook(item.ctx.page, '__soon', 1500)).toBe(true)
    expect(await waitForHook(item.ctx.page, '__never', 100)).toBe(false)
  }, 20_000)

  it('a dotted window path starting with two underscores is read from window, a bare word is a selector', async () => {
    const item = await open('<script>window.__kb = {};</script><step></step>')
    await freshLoad(item.ctx)
    expect(await hookPresent(item.ctx.page, '__kb')).toBe(true)
    expect(await hookPresent(item.ctx.page, '__other.go')).toBe(false)
    expect(await hookPresent(item.ctx.page, 'window.__kb')).toBe(true)
    expect(await hookPresent(item.ctx.page, 'step')).toBe(true)
  }, 20_000)

  it('pins overlap safely: an inner pin keeps its zone when an outer pin ends first', async () => {
    const item = await open('<p>x</p>')
    const page = item.ctx.page
    const host = await probe<number>(page, OFFSET_SOURCE, undefined, 1000)
    let inner = NaN
    let afterAll = NaN
    await Promise.all([
      pinTimezone(page, 'UTC', () => sleep(100)),
      pinTimezone(page, 'Asia/Tokyo', async () => {
        await sleep(150)
        inner = await probe<number>(page, OFFSET_SOURCE, undefined, 1000)
      }),
    ])
    afterAll = await probe<number>(page, OFFSET_SOURCE, undefined, 1000)
    expect(inner).toBe(-540)
    expect(afterAll).toBe(host)
  }, 20_000)

  it('a nested pin restores the outer zone when it ends', async () => {
    const item = await open('<p>x</p>')
    const page = item.ctx.page
    let outer = NaN
    let back = NaN
    await pinTimezone(page, 'UTC', async () => {
      await pinTimezone(page, 'Asia/Tokyo', async () => {
        await probe(page, OFFSET_SOURCE, undefined, 1000)
      })
      outer = await probe<number>(page, OFFSET_SOURCE, undefined, 1000)
      back = outer
    })
    expect(outer).toBe(0)
    expect(back).toBe(0)
  }, 20_000)

  // -------------------------------------------------------------------------
  // keys.ts: transitions, identity and positive tab indices
  // -------------------------------------------------------------------------

  it('tabWalk reads the focused style at the end of its transition, not at the first frame', async () => {
    const css = '<style>button{border:2px solid rgb(68,68,68);transition:border-color .2s ease;background:#111;color:#eee}button:focus{outline:none;border-color:rgb(255,212,0)}</style>'
    const item = await open(`${css}<button id="a">A</button><button id="b">B</button><button id="c">C</button>`)
    const walk = await tabWalk(item.ctx.page, 6)
    expect(walk.visits.map((v) => v.id)).toEqual(['a', 'b', 'c'])
    for (const visit of walk.visits) expect(visit.style.borderColor).toBe('rgb(255, 212, 0)')
    for (const after of walk.unfocusedAfter) expect(after.style.borderColor).toBe('rgb(68, 68, 68)')
  }, 20_000)

  it('tabWalk identifies a plan button by data-plan and reaches positive tab indices in browser order', async () => {
    const item = await open(
      '<button id="b1">One</button><button id="first" tabindex="1">First</button>' +
        '<button id="late" tabindex="2">Late</button><button id="b2">Two</button>' +
        '<button id="plan-btn-1" data-plan="starter">Starter</button>'
    )
    const walk = await tabWalk(item.ctx.page, 10)
    expect(walk.visits.map((v) => v.id)).toEqual(['first', 'late', 'b1', 'b2', 'plan-btn-1'])
    const plan = walk.visits.find((v) => v.id === 'plan-btn-1')!
    expect(plan.identity).toBe('starter')
    expect(plan.tag).toBe('button')
    expect(plan.dataset).toEqual({ plan: 'starter' })
  }, 20_000)

  // -------------------------------------------------------------------------
  // sources.ts: contrast audit
  // -------------------------------------------------------------------------

  it('CONTRAST_AUDIT skips text-less inputs (radio, checkbox) on a dark page', async () => {
    const item = await open('<body style="background:#111;color:#eee;margin:0"><p>Plan</p><label><input type="radio" name="r"> Team</label><input type="checkbox"></body>')
    const result = await probe<{ ok: boolean; checked: number }>(item.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.checked).toBeGreaterThan(0)
    expect(result.ok, JSON.stringify(result)).toBe(true)
  }, 20_000)

  it('CONTRAST_AUDIT ignores text hidden by opacity 0', async () => {
    const item = await open('<body style="background:#111;color:#eee"><p>Hello</p><p id="status" style="opacity:0;color:#000;background:#fff">Saved</p></body>')
    const result = await probe<{ ok: boolean }>(item.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.ok, JSON.stringify(result)).toBe(true)
  }, 20_000)

  it('CONTRAST_AUDIT takes the background of a pointer-events:none badge into account', async () => {
    const item = await open(
      '<body style="margin:0;background:#000;color:#fff"><span id="badge" style="position:absolute;left:20px;top:20px;padding:6px;background:#ffd400;color:#111;pointer-events:none;font-size:20px">Sale</span></body>'
    )
    const result = await probe<{ ok: boolean; lowest: Array<{ ratio: number }> }>(item.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.lowest[0]!.ratio).toBeGreaterThan(4.5)
  }, 20_000)

  it('CONTRAST_AUDIT reads oklch() text and background colours', async () => {
    const good = await open('<body style="margin:0;background:oklch(0.99 0 0);color:oklch(0.2 0 0)"><p>Hi there</p></body>')
    expect((await probe<{ ok: boolean }>(good.ctx.page, CONTRAST_AUDIT, undefined, 3000)).ok).toBe(true)
    const card = await open(
      '<body style="margin:0;background:#fff"><div style="background:oklch(0.15 0 0);padding:20px"><p style="color:#222;margin:0">Dark card text</p></div></body>'
    )
    const bad = await probe<{ ok: boolean; failingAll: Array<{ text: string }> }>(card.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(bad.ok, JSON.stringify(bad)).toBe(false)
    expect(bad.failingAll.some((r) => r.text.includes('Dark card'))).toBe(true)
  }, 20_000)

  it('CONTRAST_AUDIT judges SVG text by its fill', async () => {
    const item = await open('<body style="margin:0;background:#fff"><svg width="300" height="60"><text x="10" y="40" font-size="28" fill="#fefefe">Pale</text></svg></body>')
    const result = await probe<{ ok: boolean; failing: { tag: string } | null }>(item.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.ok, JSON.stringify(result)).toBe(false)
    expect(result.failing?.tag).toBe('text')
  }, 20_000)

  it('CONTRAST_AUDIT scrolls low-contrast text below the fold into view, then restores the scroll position', async () => {
    const item = await open(
      '<body style="margin:0;background:#fff;color:#000"><div style="height:2000px"></div><p id="late" style="color:#eee;background:#fff;margin:0">Low contrast late text</p></body>'
    )
    const page = item.ctx.page
    await probe(page, '() => { window.scrollTo(0, 300); return true; }', undefined, 1000)
    const result = await probe<{ ok: boolean; offscreen: number }>(page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.ok, JSON.stringify(result)).toBe(false)
    expect(result.offscreen).toBe(0)
    expect(await probe<number>(page, '() => window.scrollY', undefined, 1000)).toBe(300)
  }, 20_000)

  it('CONTRAST_AUDIT returns every failing row, not just the first', async () => {
    const item = await open('<body style="margin:0;background:#fff"><p style="color:#eee;margin:0">One</p><p style="color:#ddd;margin:0">Two</p></body>')
    const result = await probe<{ failCount: number; failing: { text: string } | null; failingAll: Array<{ text: string }> }>(
      item.ctx.page,
      CONTRAST_AUDIT,
      undefined,
      3000
    )
    expect(result.failCount).toBe(2)
    expect(result.failingAll.map((r) => r.text).sort()).toEqual(['One', 'Two'])
    expect(result.failing?.text).toBe(result.failingAll[0]!.text)
  }, 20_000)

  it('CONTRAST_AUDIT reports checked 0 for an empty body, so a check must require checked > 0', async () => {
    const item = await open('<body></body>')
    const result = await probe<{ checked: number }>(item.ctx.page, CONTRAST_AUDIT, undefined, 3000)
    expect(result.checked).toBe(0)
  }, 20_000)

  // -------------------------------------------------------------------------
  // sources.ts: VISIBLE
  // -------------------------------------------------------------------------

  it('VISIBLE sees a HUD with pointer-events:none over a canvas', async () => {
    const item = await open(
      '<body style="margin:0"><canvas id="scene" width="800" height="600" style="position:absolute;left:0;top:0;width:800px;height:600px"></canvas>' +
        '<div id="hud" style="position:absolute;left:100px;top:100px;width:200px;height:40px;pointer-events:none;background:#000;color:#fff">HUD</div></body>'
    )
    expect(await probe<{ visible: boolean; detail: string }>(item.ctx.page, VISIBLE, '#hud', 3000)).toMatchObject({ visible: true })
  }, 20_000)

  it('VISIBLE sees a zero-width vertical SVG line, and a hollow circle by its outline', async () => {
    const item = await open(
      '<body style="margin:0"><svg width="300" height="300" style="position:absolute;left:0;top:0">' +
        '<line id="ln" x1="50" y1="10" x2="50" y2="190" stroke="#fff" stroke-width="2"/>' +
        '<circle id="ring" cx="150" cy="150" r="50" fill="none" stroke="#fff" stroke-width="4"/></svg></body>'
    )
    expect(await probe<{ visible: boolean }>(item.ctx.page, VISIBLE, '#ln', 3000)).toMatchObject({ visible: true })
    expect(await probe<{ visible: boolean }>(item.ctx.page, VISIBLE, '#ring', 3000)).toMatchObject({ visible: true })
  }, 20_000)

  it('VISIBLE rejects an element at opacity 0', async () => {
    const item = await open('<body style="margin:0"><button id="ghost" style="opacity:0">Go</button></body>')
    expect(await probe<{ visible: boolean; detail: string }>(item.ctx.page, VISIBLE, '#ghost', 3000)).toMatchObject({
      visible: false,
      detail: 'opacity 0',
    })
  }, 20_000)

  // -------------------------------------------------------------------------
  // sources.ts: SVG_GEOM and CANVAS_READ
  // -------------------------------------------------------------------------

  it('SVG_GEOM refuses a display:none line and a line inside defs', async () => {
    const item = await open(
      '<svg width="200" height="200"><line id="hid" style="display:none" x1="0" y1="0" x2="10" y2="10"/>' +
        '<defs><line id="df" x1="0" y1="0" x2="10" y2="10"/></defs></svg>'
    )
    const hidden = await probe<{ ok: boolean }>(item.ctx.page, SVG_GEOM, { op: 'lineScreen', selector: '#hid' }, 3000)
    const inDefs = await probe<{ ok: boolean }>(item.ctx.page, SVG_GEOM, { op: 'lineScreen', selector: '#df' }, 3000)
    expect(hidden.ok).toBe(false)
    expect(inDefs.ok).toBe(false)
  }, 20_000)

  it('SVG_GEOM reads a circle whose cx, cy and r come from CSS', async () => {
    const item = await open(
      '<svg width="300" height="300" style="position:absolute;left:0;top:0"><circle id="c" style="cx:100px;cy:80px;r:20px" fill="red"/></svg>'
    )
    const geom = await probe<{ ok: boolean; cx: number; cy: number; rx: number; ry: number }>(
      item.ctx.page,
      SVG_GEOM,
      { op: 'circleScreen', selector: '#c' },
      3000
    )
    expect(geom.ok).toBe(true)
    expect(geom.cx).toBeCloseTo(100, 6)
    expect(geom.cy).toBeCloseTo(80, 6)
    expect(geom.rx).toBeCloseTo(20, 6)
    expect(geom.ry).toBeCloseTo(20, 6)
  }, 20_000)

  it('LINE_SCREENS maps every matching line through its own transform and reports its data attributes', async () => {
    const item = await open(
      '<svg width="300" height="300" style="position:absolute;left:0;top:0"><g transform="translate(10 20) scale(2)">' +
        '<line class="d" data-f="0.5" x1="0" y1="0" x2="10" y2="0"/><line class="d" data-f="2" x1="0" y1="5" x2="0" y2="15"/></g>' +
        '<line class="d" data-f="9" style="display:none" x1="0" y1="0" x2="1" y2="1"/></svg>'
    )
    const read = await probe<{ count: number; lines: Array<{ ok: boolean; a?: { x: number; y: number }; b?: { x: number; y: number }; data: Record<string, string> }> }>(
      item.ctx.page,
      LINE_SCREENS,
      { selector: '.d' },
      3000
    )
    expect(read.count).toBe(3)
    expect(read.lines[0]).toMatchObject({ ok: true, data: { f: '0.5' } })
    expect(read.lines[0]!.a!.x).toBeCloseTo(10, 6)
    expect(read.lines[0]!.b!.x).toBeCloseTo(30, 6)
    expect(read.lines[1]!.a!.y).toBeCloseTo(30, 6)
    expect(read.lines[2]).toMatchObject({ ok: false, data: { f: '9' } })
  }, 20_000)

  it('CANVAS_READ floors fractional points and rect bounds to whole pixels', async () => {
    const item = await open(
      '<canvas id="cv" width="20" height="20"></canvas><script>var g = document.getElementById("cv").getContext("2d");' +
        'g.fillStyle = "rgb(0,0,0)"; g.fillRect(0, 0, 20, 20); g.fillStyle = "rgb(250,0,0)"; g.fillRect(11, 11, 1, 1);</script>'
    )
    const read = await probe<{ ok: boolean; points: Array<number[] | null>; means: Array<number[] | null> }>(
      item.ctx.page,
      CANVAS_READ,
      { selector: '#cv', points: [[11.5, 11.5]], rects: [[10.5, 10.5, 2, 2]] },
      3000
    )
    expect(read.ok).toBe(true)
    expect(read.points[0]).toEqual([250, 0, 0, 255])
    // Pixels 11 and 12 on each axis: one red of four.
    expect(read.means[0]![0]).toBeCloseTo(62.5, 6)
  }, 20_000)

  // -------------------------------------------------------------------------
  // pixels.ts: clip outside the viewport, non-finite points
  // -------------------------------------------------------------------------

  it('samplePixels reads the right pixels when the clip starts left of the viewport', async () => {
    const item = await open(
      '<body style="margin:0"><div style="position:absolute;left:0;top:0;width:50px;height:100px;background:rgb(255,0,0)"></div>' +
        '<div style="position:absolute;left:50px;top:0;width:50px;height:100px;background:rgb(0,0,255)"></div></body>'
    )
    const colours = await samplePixels(item.ctx.page, { x: -20, y: -6, width: 200, height: 200 }, [
      { x: 45, y: 10 },
      { x: 55, y: 10 },
    ])
    expect(colours[0]).toEqual([255, 0, 0, 1])
    expect(colours[1]).toEqual([0, 0, 255, 1])
  }, 20_000)

  it('samplePixels refuses a point below a clip that overhangs the viewport, and a non-finite point', async () => {
    const item = await open('<body style="margin:0"><div style="position:absolute;left:0;top:700px;width:1024px;height:20px;background:rgb(0,255,0)"></div></body>')
    await expect(samplePixels(item.ctx.page, { x: 0, y: 700, width: 10, height: 100 }, [{ x: 5, y: 750 }])).rejects.toThrow(RangeError)
    await expect(samplePixels(item.ctx.page, { x: 0, y: 0, width: 10, height: 10 }, [{ x: NaN, y: 1 }])).rejects.toThrow(RangeError)
    await expect(samplePixels(item.ctx.page, { x: 2000, y: 0, width: 10, height: 10 }, [{ x: 2005, y: 5 }])).rejects.toThrow(RangeError)
    const inside = await samplePixels(item.ctx.page, { x: 0, y: 700, width: 10, height: 100 }, [{ x: 5, y: 705 }])
    expect(inside[0]).toEqual([0, 255, 0, 1])
  }, 20_000)

  // -------------------------------------------------------------------------
  // probe.ts and errorWatch
  // -------------------------------------------------------------------------

  it('probe accepts a source that ends in a line comment, and refuses NaN in its argument', async () => {
    const item = await open('<p>x</p>')
    expect(await probe(item.ctx.page, '() => 1 // done', undefined, 1000)).toBe(1)
    await expect(probe(item.ctx.page, '(a) => a', { n: NaN }, 1000)).rejects.toThrow(TypeError)
  }, 20_000)

  it('errorWatch counts a SecurityError written into a role=alert as an engine error', async () => {
    const item = await open(
      '<div role="alert">SecurityError: Failed to read the localStorage property from Window: Access is denied for this document.</div>'
    )
    const watch = errorWatch(item.ctx.page)
    try {
      await item.ctx.page.setContent(item.ctx.html)
      expect(await watch.engineErrors()).toHaveLength(1)
    } finally {
      watch.detach()
    }
  }, 20_000)

  it('freezeMotion stops transitions on the page it is given (used by the tab walk)', async () => {
    const item = await open('<p>x</p>')
    await freezeMotion(item.ctx.page)
    expect(await probe<boolean>(item.ctx.page, '() => document.getElementById("__bench_freeze") !== null', undefined, 1000)).toBe(true)
  }, 20_000)
})
