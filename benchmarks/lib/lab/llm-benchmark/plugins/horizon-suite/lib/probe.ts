/**
 * Page probes: the only way horizon-suite checks run code in the artifact page.
 *
 * - probe(page, source, arg, timeoutMs) evaluates a plain-JavaScript SOURCE STRING
 *   of the form "(...) => ..." and raced against a timer, because page.evaluate
 *   has no timeout of its own. Strings are used instead of functions: a function
 *   compiled by tsx can capture the module-level __name helper, which does not
 *   exist in the page (postmortem 0008).
 * - hookPresent, settle, freezeMotion, finishAnimations, withViewport and
 *   errorWatch are the small, fixed set of page-level operations every task uses.
 */
import type { ConsoleMessage, Page } from 'playwright'

export const DEFAULT_PROBE_MS = 3000

/**
 * Check that a probe argument survives JSON exactly. JSON turns NaN and the
 * infinities into null, -0 into 0, drops undefined properties and cannot carry
 * functions, symbols or bigints, so any of those throws instead of changing the
 * input silently. Write such values inside the source string.
 */
function assertJsonSafe(value: unknown, path: string): void {
  const hint = 'write that value inside the source string instead (JSON cannot carry it)'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`probe argument ${path} is ${Object.is(value, -0) ? '-0' : String(value)}; ${hint}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`probe argument ${path} is not a plain object (${String(proto?.constructor?.name)}); ${hint}`)
    }
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new TypeError(`probe argument ${path}.${key} is undefined; ${hint}`)
      assertJsonSafe(item, `${path}.${key}`)
    }
    return
  }
  throw new TypeError(`probe argument ${path} has type ${typeof value}; ${hint}`)
}

/**
 * Build the expression that probe() evaluates. Exported for tests and debugging.
 * The newline before the closing parenthesis ends a trailing line comment in the
 * source, so a source ending in "// note" still parses.
 */
export function expressionFor(source: string, arg?: unknown): string {
  if (typeof source !== 'string') {
    throw new TypeError('probe needs a source string, not a function (see postmortem 0008)')
  }
  let argText = 'undefined'
  if (arg !== undefined) {
    assertJsonSafe(arg, 'arg')
    argText = JSON.stringify(arg)
  }
  return '(' + source + '\n)(' + argText + ')'
}

/**
 * Evaluate `source` (a function written as a string) with one JSON-serialisable
 * argument and return its result. Rejects with "probe timed out" after timeoutMs.
 * A timed-out evaluation may still be pending in the browser; the caller decides
 * whether the page is still usable (see defineCheck's poison probe).
 */
export async function probe<T = unknown>(
  page: Page,
  source: string,
  arg?: unknown,
  timeoutMs: number = DEFAULT_PROBE_MS
): Promise<T> {
  const expression = expressionFor(source, arg)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  const evaluated = page.evaluate(expression) as Promise<T>
  // A late rejection after the timer won must not surface as unhandled.
  evaluated.catch(() => {})
  try {
    return await Promise.race([evaluated, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Source for a window path (e.g. "__bench.step") or a CSS selector, existence only. */
const HOOK_PATH_SOURCE = `(path) => {
  let o = window;
  for (const k of path.split('.')) {
    if (o === null || o === undefined) return false;
    o = o[k];
  }
  return o !== undefined && o !== null;
}`

const SELECTOR_SOURCE = `(selector) => {
  try { return document.querySelector(selector) !== null; } catch (e) { return false; }
}`

/** A dotted window path: "window.x", or any path whose first segment starts with two underscores. */
const WINDOW_PATH = /^(window\.|__[A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$)/

/**
 * Synchronous existence test, run before any interaction so a page without the
 * contract fails in milliseconds. A dotted path on window ("__bench.step",
 * "__kb", or "window.__kb": any first segment beginning with two underscores)
 * is looked up on window; anything else is a CSS selector (e.g. "#scene").
 */
export async function hookPresent(page: Page, pathOrSelector: string): Promise<boolean> {
  if (WINDOW_PATH.test(pathOrSelector)) {
    const path = pathOrSelector.replace(/^window\./, '')
    return probe<boolean>(page, HOOK_PATH_SOURCE, path, 1000)
  }
  return probe<boolean>(page, SELECTOR_SOURCE, pathOrSelector, 1000)
}

const ONE_FRAME_SOURCE = `() => new Promise((resolve) => {
  requestAnimationFrame(() => resolve(true));
})`

/**
 * Poll hookPresent once per animation frame until it is present or capMs has
 * passed. Use it after a load whose start-up may be deferred (a timer, a
 * fonts.ready callback), instead of guessing a delay. Returns false at the cap.
 */
export async function waitForHook(page: Page, pathOrSelector: string, capMs = 1500): Promise<boolean> {
  const deadline = Date.now() + capMs
  for (;;) {
    if (await hookPresent(page, pathOrSelector)) return true
    if (Date.now() >= deadline) return false
    await probe(page, ONE_FRAME_SOURCE, undefined, 250).catch(() => undefined)
  }
}

const TWO_FRAMES_SOURCE = `() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`

/**
 * Wait for two animation frames, capped at 250 ms. Use only after real keyboard
 * or pointer input and viewport changes. In-page probes never need it.
 */
export async function settle(page: Page): Promise<void> {
  await probe(page, TWO_FRAMES_SOURCE, undefined, 250).catch(() => undefined)
}

const FREEZE_SOURCE = `() => {
  if (document.getElementById('__bench_freeze')) return false;
  const style = document.createElement('style');
  style.id = '__bench_freeze';
  style.textContent =
    '*,*::before,*::after{transition:none !important;' +
    'scroll-behavior:auto !important;caret-color:transparent !important}';
  (document.head || document.documentElement).appendChild(style);
  for (const animation of document.getAnimations()) {
    try { animation.finish(); } catch (e) {
      // An infinite animation cannot finish: hold it at its first frame instead.
      try { animation.currentTime = 0; animation.pause(); } catch (e2) { /* nothing more to do */ }
    }
  }
  return true;
}`

/**
 * Stop CSS transitions and finish the running Web Animations in the current
 * document (once per document; a new load needs it again). Animation is not set
 * to none: that returned an entrance animation (opacity 0 at rest, animated to 1
 * with fill-mode forwards) to its base state, so a finished page read as empty.
 * Finishing carries each animation to its end state instead. Works in any
 * document, including the opaque-origin one from loadOpaque.
 */
export async function freezeMotion(page: Page): Promise<void> {
  await probe(page, FREEZE_SOURCE, undefined, 1500)
}

const FINISH_SOURCE = `() => {
  let finished = 0;
  for (const animation of document.getAnimations()) {
    try { animation.finish(); finished++; } catch (e) { /* infinite animations cannot finish */ }
  }
  return finished;
}`

/** Finish every remaining Web Animation the page has. Returns how many finished. */
export async function finishAnimations(page: Page): Promise<number> {
  return probe<number>(page, FINISH_SOURCE, undefined, 1500).catch(() => 0)
}

/** Race a promise against a deadline. The label names the action in the error. */
export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + " ms")), ms)
  })
  promise.catch(() => undefined)
  try {
    return await Promise.race([promise, late])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const ACTION_MS = 1500

/**
 * Run fn with the viewport set to width x height, then restore 1024 x 720 in
 * finally, even when fn throws. Waits two frames after each resize.
 */
export async function withViewport<T>(
  page: Page,
  width: number,
  height: number,
  fn: () => Promise<T>
): Promise<T> {
  try {
    await bounded(page.setViewportSize({ width, height }), ACTION_MS, 'setViewportSize')
    await settle(page)
    return await fn()
  } finally {
    await bounded(page.setViewportSize({ width: 1024, height: 720 }), ACTION_MS, 'setViewportSize').catch(() => undefined)
    await settle(page)
  }
}

const ALERTS_SOURCE = `() => Array.from(document.querySelectorAll('[role="alert"]'))
  .map((el) => (el.textContent || '').trim())
  .filter((text) => text.length > 0)`

/** Shapes of an engine error that a start-up catch wrote into a role=alert element. */
export const ENGINE_ERROR_SHAPE =
  /(ReferenceError|TypeError|SyntaxError|RangeError|URIError|EvalError|SecurityError|Access is denied for this document|is not defined|is not a function|Cannot read prop|Uncaught|Script error)/

const RESOURCE_NOISE = /(Failed to load resource|net::ERR_|ERR_FAILED|ERR_BLOCKED_BY)/

export interface ErrorWatch {
  /** Uncaught exceptions (pageerror), in order. */
  readonly pageErrors: readonly string[]
  /** console.error messages, minus resource-load noise. */
  readonly consoleErrors: readonly string[]
  /** Text of every [role=alert] element now in the page. */
  alerts(): Promise<string[]>
  /** The alerts whose text has an engine-error shape. */
  engineErrors(): Promise<string[]>
  /** Remove the listeners. Call in finally. */
  detach(): void
}

/**
 * Collect page errors. Attach BEFORE the page loads (before freshLoad or
 * loadOpaque) so start-up errors are seen. Always call detach() in finally.
 */
export function errorWatch(page: Page): ErrorWatch {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message)
  }
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (RESOURCE_NOISE.test(text)) return
    consoleErrors.push(text)
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  let attached = true

  const alerts = async (): Promise<string[]> =>
    probe<string[]>(page, ALERTS_SOURCE, undefined, 1000).catch(() => [])

  return {
    pageErrors,
    consoleErrors,
    alerts,
    async engineErrors() {
      return (await alerts()).filter((text) => ENGINE_ERROR_SHAPE.test(text))
    },
    detach() {
      if (!attached) return
      attached = false
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
    },
  }
}
