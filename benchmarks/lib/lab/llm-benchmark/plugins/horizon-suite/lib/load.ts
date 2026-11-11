/**
 * Page loading for horizon-suite checks.
 *
 * The harness loads an artifact with setContent, which leaves the page on an
 * opaque origin where localStorage throws. Storage checks need a real origin, so
 * freshLoad re-hosts the artifact on a unique http://c<N>.bench.invalid/ origin,
 * and every call to it gets an empty localStorage unless the same origin is
 * requested again. loadOpaque reproduces the harness environment.
 *
 * Network rule, the same online and offline: the page answers only the main-frame
 * GET navigation to the root path of the hosted origin (plus /favicon.ico with
 * 204). Every other request from the page, from a popup or from a WebSocket is
 * aborted or closed before it leaves the browser. Each page keeps ONE route handler
 * for its lifetime and reads a per-page {origin, body} record, so a load never
 * re-registers routes.
 *
 * After a load the rule is the harness's own: domcontentloaded, then 600 ms, then
 * the check runs. A start-up that is deferred longer than that is found with
 * waitForHook (probe.ts), not by a longer fixed wait.
 *
 * Under BENCH_PRELUDE_PARITY=1 the artifact is wrapped with the display prelude
 * (withPrelude), matching what readers see, exactly as the harness does.
 */
import type { BrowserContext, CDPSession, Page, Request, Route } from 'playwright'
import type { CheckContext } from '../../../scorers/check-meta'
import { withPrelude } from '../../../frame-prelude'
import { bounded, probe } from './probe'

const ORIGIN_PREFIX = 'http://c'
const ORIGIN_SUFFIX = '.bench.invalid'
let originCounter = 0

/** Budget for one small browser action (route, CDP send, evaluate). */
const ACTION_MS = 1500
/** Budget for a navigation or a setContent; the error then names the load. */
const NAV_MS = 3000
/** The harness's settleMs: the wait between a document load and the first check. */
export const LOAD_SETTLE_MS = 600

/** A new, never used origin for this process. */
export function nextOrigin(): string {
  originCounter += 1
  return `${ORIGIN_PREFIX}${originCounter}${ORIGIN_SUFFIX}`
}

function preludeParity(): boolean {
  const value = process.env.BENCH_PRELUDE_PARITY
  return value === '1' || value?.toLowerCase() === 'true'
}

/** The document the page should see: the raw artifact, or the display-prelude wrapped one. */
export function documentFor(html: string): string {
  return preludeParity() ? withPrelude(html) : html
}

interface HostRecord {
  /** The origin the page is served from, or undefined when everything is aborted. */
  origin: string | undefined
  /** The document answered for the root path of origin. */
  body: string | undefined
  /** The origin of the previous host call, to decide whether state must be reset. */
  last: string | undefined
}

const records = new WeakMap<Page, HostRecord>()
const guardedContexts = new WeakSet<BrowserContext>()

function isRootNavigation(request: Request, page: Page): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame() && request.method() === 'GET'
  } catch {
    return false
  }
}

async function ensureRouting(page: Page): Promise<HostRecord> {
  const existing = records.get(page)
  if (existing !== undefined) return existing
  const record: HostRecord = { origin: undefined, body: undefined, last: undefined }

  await bounded(
    page.route('**/*', async (route: Route, request: Request) => {
      try {
        const url = new URL(request.url())
        const hosted = record.origin !== undefined && url.origin === record.origin
        if (hosted && url.pathname === '/favicon.ico' && url.search === '') {
          await route.fulfill({ status: 204, body: '' })
        } else if (hosted && url.pathname === '/' && url.search === '' && record.body !== undefined && isRootNavigation(request, page)) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: record.body })
        } else {
          await route.abort()
        }
      } catch {
        // A route that was already handled or torn down: nothing to answer.
      }
    }),
    ACTION_MS,
    'page.route'
  )
  await bounded(
    page.routeWebSocket(/.*/, (socket) => {
      socket.close();
    }),
    ACTION_MS,
    'page.routeWebSocket'
  )
  // A popup the page opens is closed at once; its requests are aborted by the context route.
  page.on('popup', (popup) => {
    popup.close().catch(() => undefined);
  })

  const context = page.context()
  if (!guardedContexts.has(context)) {
    await bounded(
      context.route('**/*', (route) => route.abort()),
      ACTION_MS,
      'context.route'
    )
    await bounded(
      context.routeWebSocket(/.*/, (socket) => {
        socket.close();
      }),
      ACTION_MS,
      'context.routeWebSocket'
    )
    guardedContexts.add(context)
  }
  records.set(page, record)
  return record
}

/** Empty window.name and clear cookies for the bench origins: state must not cross origins. */
async function resetOriginState(page: Page): Promise<void> {
  await probe(page, `() => { try { window.name = ''; } catch (e) { return false; } return true; }`, undefined, ACTION_MS).catch(
    () => undefined
  )
  await bounded(
    page.context().clearCookies({ domain: /bench\.invalid$/ }),
    ACTION_MS,
    'clearCookies'
  ).catch(() => undefined)
}

/**
 * Host `html` at `origin` (the root path only) and navigate the page there. The
 * page answers only the main-frame navigation; every other request is aborted.
 */
export async function hostPage(page: Page, html: string, origin: string): Promise<void> {
  const record = await ensureRouting(page)
  if (record.last !== origin) await resetOriginState(page)
  record.origin = origin
  record.body = documentFor(html)
  record.last = origin
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: NAV_MS })
  await page.waitForTimeout(LOAD_SETTLE_MS)
}

/**
 * Re-host ctx.html on a unique origin and navigate there. Returns the origin.
 * Pass { origin } from an earlier call to load the SAME origin again (a reload
 * test): localStorage then carries over from the earlier document.
 */
export async function freshLoad(ctx: CheckContext, options: { origin?: string } = {}): Promise<string> {
  const origin = options.origin ?? nextOrigin()
  await hostPage(ctx.page, ctx.html, origin)
  return origin
}

/**
 * The harness environment: about:blank, then setContent. Storage throws here, so
 * a check can see what a model does without localStorage. Every request stays
 * aborted, so the page cannot reach the network online or offline.
 */
export async function loadOpaque(ctx: CheckContext): Promise<void> {
  const record = await ensureRouting(ctx.page)
  record.origin = undefined
  record.body = undefined
  record.last = undefined
  await resetOriginState(ctx.page)
  await ctx.page.goto('about:blank', { waitUntil: 'load', timeout: NAV_MS })
  await ctx.page.setContent(documentFor(ctx.html), { waitUntil: 'domcontentloaded', timeout: NAV_MS })
  await ctx.page.waitForTimeout(LOAD_SETTLE_MS)
}

// ---------------------------------------------------------------------------
// Timezone pins
// ---------------------------------------------------------------------------

interface PinState {
  /** One session per page, shared by overlapping pins (created once, awaited by each). */
  session: Promise<CDPSession> | undefined
  /** Every active pin on this page, outermost first. The last entry is the zone in effect. */
  stack: Array<{ zone: string }>
}

const pins = new WeakMap<Page, PinState>()

/**
 * Run fn with the page's timezone pinned to `zone` through a CDP session. Pins
 * nest and may overlap: the zone in effect is always the innermost active pin,
 * and when a pin ends the one beneath it is restored. The override is cleared
 * only when the last pin on the page ends. Requires Chromium (CDP).
 *
 * Only a document loaded inside fn is fully pinned. A formatter or Date created
 * before the pin keeps the zone it was built with.
 */
export async function pinTimezone<T>(page: Page, zone: string, fn: () => Promise<T>): Promise<T> {
  let state = pins.get(page)
  if (state === undefined) {
    state = { session: undefined, stack: [] }
    pins.set(page, state)
  }
  if (state.session === undefined) {
    const opening = bounded(page.context().newCDPSession(page), ACTION_MS, 'newCDPSession')
    state.session = opening
    opening.catch(() => {
      if (state!.session === opening) state!.session = undefined
    })
  }
  let session: CDPSession
  try {
    session = await state.session
  } catch (error) {
    throw new Error(`pinTimezone needs a Chromium CDP session: ${error instanceof Error ? error.message : String(error)}`)
  }
  const entry = { zone }
  state.stack.push(entry)
  try {
    await setZone(session, zone)
    return await fn()
  } finally {
    const at = state.stack.indexOf(entry)
    if (at >= 0) state.stack.splice(at, 1)
    const outer = state.stack[state.stack.length - 1]
    if (outer !== undefined) {
      await setZone(session, outer.zone).catch(() => undefined)
    } else {
      await bounded(session.send('Emulation.setTimezoneOverride', { timezoneId: '' }), ACTION_MS, 'setTimezoneOverride').catch(
        () => undefined
      )
      await bounded(session.detach(), ACTION_MS, 'detach').catch(() => undefined)
      state.session = undefined
    }
  }
}

/**
 * Make `zone` the override in effect. CDP refuses a new zone while one is set
 * ("Timezone override is already in effect"), so the old one is cleared first.
 */
async function setZone(session: CDPSession, zone: string): Promise<void> {
  await bounded(session.send('Emulation.setTimezoneOverride', { timezoneId: '' }), ACTION_MS, 'setTimezoneOverride').catch(
    () => undefined
  )
  await bounded(session.send('Emulation.setTimezoneOverride', { timezoneId: zone }), ACTION_MS, 'setTimezoneOverride')
}

export interface AltPage {
  page: Page
  /** Close the second page or context. Safe to call twice. */
  close(): Promise<void>
}

/**
 * A second page with `zone` set, loaded with ctx.html on a fresh origin. When the
 * backend exposes a browser, the page is in a NEW context with timezoneId set
 * through Playwright. Otherwise (a persistent context) it is a new page in the
 * same context with a CDP timezone override that stays until close(). Either way
 * close() also runs when the main page closes, so an abandoned run leaves nothing
 * open.
 */
export async function altTimezonePage(
  ctx: CheckContext,
  zone: string,
  viewport: { width: number; height: number } = { width: 1024, height: 720 }
): Promise<AltPage> {
  const main = ctx.page
  const browser = main.context().browser()
  let closed = false
  let close: () => Promise<void>
  let page: Page

  if (browser !== null) {
    const context = await bounded(browser.newContext({ timezoneId: zone, viewport }), NAV_MS, 'newContext')
    close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await context.close().catch(() => undefined)
    }
    try {
      page = await bounded(context.newPage(), NAV_MS, 'newPage')
      await hostPage(page, ctx.html, nextOrigin())
    } catch (error) {
      await close()
      throw error
    }
  } else {
    const context = main.context()
    page = await bounded(context.newPage(), ACTION_MS, 'newPage')
    let session: CDPSession | undefined
    close = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (session !== undefined) await bounded(session.detach(), ACTION_MS, 'detach').catch(() => undefined)
      await page.close().catch(() => undefined)
    }
    try {
      session = await bounded(context.newCDPSession(page), ACTION_MS, 'newCDPSession')
      await bounded(session.send('Emulation.setTimezoneOverride', { timezoneId: zone }), ACTION_MS, 'setTimezoneOverride')
      await bounded(page.setViewportSize(viewport), ACTION_MS, 'setViewportSize')
      await hostPage(page, ctx.html, nextOrigin())
    } catch (error) {
      await close()
      throw error
    }
  }
  main.once('close', () => {
    void close()
  })
  return { page, close }
}
