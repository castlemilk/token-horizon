import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { appDirectory } from './build-daemon.mjs'
import { goPlatforms, verifyDaemonBundle } from './daemon-bundle.mjs'

const { values } = parseArgs({ options: { directory: { type: 'string' } } })
const platform = process.platform
const arch = process.arch
if (platform !== 'linux' && platform !== 'win32') {
  throw new Error('Packaged desktop smoke tests run on native Linux or Windows hosts')
}
const outputName = platform === 'linux' ? `linux${arch === 'x64' ? '' : `-${arch}`}-unpacked` : 'win-unpacked'
const directory = values.directory ? resolve(values.directory) : join(appDirectory, 'dist', outputName)
const resources =
  platform === 'darwin' ? join(directory, 'Token Horizon.app/Contents/Resources') : join(directory, 'resources')
const info = verifyDaemonBundle(join(resources, 'daemon'), platform, arch)
const executable =
  platform === 'darwin'
    ? join(directory, 'Token Horizon.app/Contents/MacOS/token-horizon')
    : join(directory, `token-horizon${platform === 'win32' ? '.exe' : ''}`)
const healthUrl = 'http://127.0.0.1:8765/health'
try {
  await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
  throw new Error('The smoke test requires port 8765 to be unused; an existing local core is running')
} catch (error) {
  if (error.message.includes('requires port 8765')) throw error
}

const portReservation = createServer()
portReservation.listen(0, '127.0.0.1')
await once(portReservation, 'listening')
const debugPort = portReservation.address().port
await new Promise((resolve) => portReservation.close(resolve))
const temporary = mkdtempSync(join(tmpdir(), 'token-horizon-desktop-smoke-'))
writeFileSync(
  join(temporary, 'settings.json'),
  JSON.stringify({ captureMethodology: 'point', filePolling: false, traceCapture: false })
)
const environment = {
  ...process.env,
  TH_CONFIG_DIR: temporary,
  TH_CAPTURE_METHODOLOGY: 'point',
  TH_FILE_POLL: '0',
  TH_CONSENT: '',
}
delete environment.TOKEN_HORIZON_DAEMON_BIN
delete environment.ELECTRON_RUN_AS_NODE
let logs = ''
let child
let socket
let closed = false
const pending = new Map()
let requestId = 0

async function until(check, description) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (closed) throw new Error(`Desktop exited before ${description}\n${logs}`)
    try {
      const result = await check()
      if (result) return result
    } catch {
      /* Startup polls retry until the deadline. */
    }
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${description}\n${logs}`)
}

function evaluate(expression) {
  const id = ++requestId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Renderer evaluation timed out'))
    }, 5000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    )
  })
}

try {
  child = spawn(
    executable,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(temporary, 'electron')}`],
    {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    }
  )
  child.on('error', (error) => {
    logs += error.message
    closed = true
  })
  child.on('close', () => {
    closed = true
  })
  child.stdout.on('data', (data) => {
    logs = (logs + data.toString()).slice(-16000)
  })
  child.stderr.on('data', (data) => {
    logs = (logs + data.toString()).slice(-16000)
  })
  const health = await until(async () => {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
    const value = await response.json()
    return value.ok ? value : undefined
  }, 'the bundled daemon health endpoint')
  assert.equal(health.platform, goPlatforms[platform])
  assert.deepEqual(health.build, { version: info.version, commit: info.commit, built_at: info.built_at })
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })
    return (await response.json()).find((item) => item.type === 'page' && item.url.startsWith('file:'))
  }, 'the packaged dashboard window')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error || message.result?.exceptionDetails) waiter.reject(new Error(JSON.stringify(message)))
    else waiter.resolve(message.result?.result?.value)
  })
  await until(async () => {
    const value = await evaluate(
      `({ title: document.title, text: document.body.innerText, bridge: typeof window.conveyor?.invoke })`
    )
    return (
      value.title === 'Token Horizon' &&
      value.text.includes('Tokens Today') &&
      value.text.includes('Connected') &&
      value.bridge === 'function'
    )
  }, 'a rendered dashboard with the preload bridge and live API connection')
  // Exercise the window-control IPC, then let before-quit tear down the owned daemon.
  await evaluate("window.conveyor.invoke('conveyor:window', 'close')").catch(() => {})
  const deadline = Date.now() + 10000
  while (!closed && Date.now() < deadline) await delay(100)
  assert.ok(closed, 'Desktop did not exit after closing its window')
  await assert.rejects(
    () => fetch(healthUrl, { signal: AbortSignal.timeout(1000) }),
    'Desktop left its bundled daemon running'
  )
  console.log(`Packaged desktop smoke passed: ${platform}/${arch}, ${info.version} (${info.commit})`)
} finally {
  socket?.close()
  if (child?.pid && !closed) {
    if (platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* Already exited. */
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
