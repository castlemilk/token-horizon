import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Safety checks on the report page. The page never runs model-written HTML: the captures are stored images
 * and the page shows only those and the stored measurements. These tests fail if the template ever adds a
 * frame, a sandbox, a run control, an artifact loader, a network request from the page, or any way to write
 * markup or run strings as code.
 *
 * They read the template sources as text. The built report is checked by report/dist-check.mjs.
 */
const templateDir = fileURLToPath(new URL('../../../report/template/', import.meta.url))
const reportJs = readFileSync(`${templateDir}report.js`, 'utf8')
const indexHtml = readFileSync(`${templateDir}index.html`, 'utf8')
const reportCss = readFileSync(`${templateDir}report.css`, 'utf8')
const sources = { 'report.js': reportJs, 'index.html': indexHtml, 'report.css': reportCss }

describe('report template: nothing runs model-written HTML', () => {
  it('has no frame, iframe, embed or object element, and no srcdoc or sandbox attribute', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} names an iframe`).not.toMatch(/iframe/i)
      expect(text, `${file} names srcdoc`).not.toMatch(/srcdoc/i)
      expect(text, `${file} sets a sandbox`).not.toMatch(/['"]sandbox['"]|\bsandbox\s*=/)
      expect(text, `${file} creates an embed or object`).not.toMatch(/createElement\(\s*['"](embed|object|frame|frameset)['"]/)
    }
  })

  it('has no run control, no artifact loader and no artifact callback', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} names a run control`).not.toMatch(/Run this artifact|artifact-run/)
      expect(text, `${file} names the loader`).not.toMatch(/artifact-loader|loadArtifactScript|runArtifact/)
      expect(text, `${file} names the artifact callback`).not.toMatch(/__artifact|__thFrame/)
    }
  })

  it('loads only the board data and its own script: no frame.js and no artifact bundle', () => {
    const scripts = [...indexHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1])
    expect(scripts).toEqual(['./data/board.js', './report.js'])
    expect(indexHtml).not.toMatch(/frame\.js/)
    expect(indexHtml).not.toMatch(/dist\/artifacts|artifacts\//)
  })

  it('the dialog holds captures, the results and one command line, and nothing that runs', () => {
    const dialog = /<dialog id="artifact-dialog"[\s\S]*?<\/dialog>/.exec(indexHtml)?.[0] ?? ''
    expect(dialog).toContain('id="artifact-shots"')
    expect(dialog).toContain('id="artifact-details"')
    expect(dialog).toContain('id="artifact-command"')
    expect(dialog).not.toMatch(/<button[^>]*id="artifact-run"/)
    expect(dialog).not.toMatch(/<script|<iframe|<embed|<object/i)
  })
})

describe('report template: the page makes no requests of its own', () => {
  it('uses no network API: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon or a new window', () => {
    expect(reportJs).not.toMatch(/\bfetch\s*\(/)
    expect(reportJs).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|window\.open|importScripts/)
  })

  it('has no link that prefetches or preconnects', () => {
    expect(indexHtml).not.toMatch(/rel\s*=\s*["']?(prerender|preconnect|prefetch|preload)/i)
  })

  it('the page carries a policy that blocks network, framing and objects', () => {
    const pagePolicy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml)?.[1] ?? ''
    expect(pagePolicy).toContain("default-src 'none'")
    expect(pagePolicy).toContain("connect-src 'none'")
    expect(pagePolicy).toContain("frame-src 'none'")
    expect(pagePolicy).toContain("object-src 'none'")
    expect(pagePolicy).not.toMatch(/https?:/)
  })
})

describe('report template: markup and code', () => {
  it('never uses document.write', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} contains document.write`).not.toContain('document.write')
    }
  })

  it('does not write markup through innerHTML, outerHTML or insertAdjacentHTML', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} assigns innerHTML`).not.toMatch(/\binnerHTML\b/)
      expect(text, `${file} assigns outerHTML`).not.toMatch(/\bouterHTML\b/)
      expect(text, `${file} calls insertAdjacentHTML`).not.toMatch(/\binsertAdjacentHTML\b/)
    }
  })

  it('does not evaluate strings as code', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, `${file} uses eval`).not.toMatch(/\beval\s*\(/)
      expect(text, `${file} uses new Function`).not.toMatch(/new\s+Function\s*\(/)
    }
  })
})

/**
 * The capture browser runs model-written HTML, so its settings are checked here: every connection goes to a dead
 * proxy, WebRTC may send no UDP outside the proxy, Chromium's sandbox stays on, and web security stays on. The
 * isolation test (report/capture-isolation-test.mjs) checks that these settings block a hostile artifact in a browser.
 */
describe('capture browser: model-written HTML cannot reach the network', () => {
  const captureSrc = readFileSync(fileURLToPath(new URL('../../../report/capture.mjs', import.meta.url)), 'utf8')

  it('launches the capture browser with a dead proxy that bypasses nothing, and a WebRTC policy that sends no UDP outside it', async () => {
    const browser = await import('../../../report/capture-browser.mjs')
    const launch = browser.captureLaunchOptions()
    expect(launch.proxy).toEqual({ server: 'http://127.0.0.1:9', bypass: '<-loopback>' })
    expect(launch.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(launch.chromiumSandbox).toBe(true)
    const ctx = browser.captureContextOptions({ width: 1024, height: 720 })
    expect(ctx.proxy).toEqual(launch.proxy)
  })

  it('never disables web security or the sandbox, and no longer takes the harness launch flags', () => {
    const settings = readFileSync(fileURLToPath(new URL('../../../report/capture-browser.mjs', import.meta.url)), 'utf8')
    for (const text of [settings, captureSrc]) {
      expect(text).not.toMatch(/disable-web-security/)
      expect(text).not.toMatch(/--no-sandbox/)
      expect(text).not.toMatch(/CHROMIUM_LAUNCH_ARGS/)
    }
  })

  it('takes the captures through the capture browser settings, not its own launch', () => {
    expect(captureSrc).toMatch(/chromium\.launch\(captureLaunchOptions\(\)\)/)
    expect(captureSrc).toMatch(/browser\.newContext\(captureContextOptions\(DESKTOP\)\)/)
  })
})
