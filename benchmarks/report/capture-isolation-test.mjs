#!/usr/bin/env node
/**
 * Checks that the capture browser cannot reach the network, using a hostile artifact.
 *
 *   npx tsx report/capture-isolation-test.mjs
 *
 * The probe (report/fixtures/hostile/capture-probe.html) asks for a prefetch link, speculation rules, an
 * image, fetch, XMLHttpRequest, EventSource, a WebSocket, a beacon, an iframe and a WebRTC STUN request.
 * Each goes to a listener this script owns on 127.0.0.1: a TCP server (HTTP, upgrades) and a UDP socket.
 *
 * The probe is loaded the way capture.mjs loads an artifact (page.setContent), in a context made by
 * captureContextOptions(), with NO request interception. So the test checks the launch settings alone.
 * Then a plain browser runs the same probe as a negative control, and it must reach the listeners. If it
 * does not, the probe proves nothing and the test fails.
 *
 * Exit code 0 when the capture browser reaches nothing and the control reaches something; 1 otherwise.
 */
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), 'Library/Caches/ms-playwright-benchmarks')
const { chromium } = await import('playwright')
const { captureLaunchOptions, captureContextOptions } = await import('./capture-browser.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const probeTemplate = readFileSync(join(here, 'fixtures/hostile/capture-probe.html'), 'utf8')
const SETTLE_MS = 2500

const failures = []
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

/** Listeners on 127.0.0.1 that record every connection, request, upgrade and datagram. */
async function startListeners() {
  const hits = []
  const http = createServer((req, res) => {
    hits.push(`http ${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
    res.end('probe')
  })
  const sockets = new Set()
  http.on('connection', (socket) => {
    hits.push('tcp connection')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  http.on('upgrade', (req) => hits.push(`websocket upgrade ${req.url}`))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const udp = createSocket('udp4')
  udp.on('message', (msg) => hits.push(`udp datagram ${msg.length} bytes`))
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve))
  return {
    httpPort: http.address().port,
    udpPort: udp.address().port,
    hits,
    close: () => new Promise((resolve) => {
      udp.close();
      for (const socket of sockets) socket.destroy();
      http.close(() => resolve());
    })
  }
}

/** Runs the probe in one browser context and returns what the listeners recorded and what the page said. */
async function runProbe(browser, options, listeners) {
  const html = probeTemplate
    .replaceAll('__HTTP_PORT__', String(listeners.httpPort))
    .replaceAll('__UDP_PORT__', String(listeners.udpPort))
  const before = listeners.hits.length
  const context = await browser.newContext(options)
  try {
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    await page.waitForTimeout(SETTLE_MS)
    const said = await page.evaluate(() => [...document.querySelectorAll('#out li')].map((li) => li.textContent))
    return { reached: listeners.hits.slice(before), said }
  } finally {
    await context.close().catch(() => {})
  }
}

const listeners = await startListeners()
const browser = await chromium.launch(captureLaunchOptions())
const control = await chromium.launch({ headless: true })
try {
  // 1. The capture browser: its launch and context settings, and nothing else.
  const capture = await runProbe(browser, captureContextOptions({ width: 1024, height: 720 }), listeners)
  console.log(`capture browser said: ${capture.said.join(' | ') || '(nothing)'}`)
  check(capture.said.length > 0, 'the probe ran in the capture browser (the page wrote its lines)')
  check(capture.reached.length === 0, `the capture browser reached no listener${capture.reached.length ? ': ' + capture.reached.join('; ') : ''}`)

  // 2. Negative control: a plain browser must reach the listeners, or the probe proves nothing.
  const plain = await runProbe(control, { viewport: { width: 1024, height: 720 } }, listeners)
  const kinds = [...new Set(plain.reached.map((e) => e.split(' ')[0] + ' ' + (e.split(' ')[1] ?? '')))]
  console.log(`plain browser reached ${plain.reached.length} listener event(s): ${kinds.join(', ')}`)
  check(plain.reached.length > 0, `negative control: a plain browser reaches the listeners (${plain.reached.length} events), so the probe can fail`)
} finally {
  await browser.close().catch(() => {})
  await control.close().catch(() => {})
  await listeners.close()
}

console.log(`${failures.length} failed check(s)`)
process.exitCode = failures.length ? 1 : 0
