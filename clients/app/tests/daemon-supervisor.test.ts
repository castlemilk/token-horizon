import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { DaemonSupervisor, daemonExecutable, isDaemonHealth } from '../lib/main/daemon-supervisor.ts'

const health = { ok: true, name: 'token-horizon-daemon', version: 'test', usage_store: true }

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const fixture = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(${JSON.stringify(health)}));
});
server.listen(Number(process.env.TH_TEST_PORT), '127.0.0.1');
process.stdin.resume();
if (process.env.TH_TEST_IGNORE_TERM) process.on('SIGTERM', () => {});
else {
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.stdin.on('end', () => server.close(() => process.exit(0)));
}
if (process.env.TH_TEST_CRASH) setTimeout(() => process.exit(7), 700);
`

function supervisor(port: number, options: Partial<ConstructorParameters<typeof DaemonSupervisor>[0]> = {}) {
  return new DaemonSupervisor({
    executable: process.execPath,
    args: ['-e', fixture],
    env: { ...process.env, TH_TEST_PORT: String(port) },
    healthUrl: `http://127.0.0.1:${port}/health`,
    startupTimeoutMs: 3000,
    pollIntervalMs: 25,
    stopTimeoutMs: 100,
    ...options,
  })
}

test('daemon paths use packaged resources, development resources, and Windows .exe', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    const filename = platform === 'win32' ? 'token-horizon-daemon.exe' : 'token-horizon-daemon'
    const options = { platform, resourcesPath: '/installed resources', appPath: '/dev app' }
    assert.equal(daemonExecutable({ ...options, packaged: true }), join(options.resourcesPath, 'daemon', filename))
    assert.equal(
      daemonExecutable({ ...options, packaged: false }),
      join(options.appPath, 'resources', 'daemon', filename)
    )
    assert.equal(daemonExecutable({ ...options, packaged: true, override: process.execPath }), process.execPath)
  }
})

test('recognizes healthy Go and native macOS cores, rejects unrelated and unhealthy services', () => {
  assert.equal(isDaemonHealth(health), true)
  assert.equal(isDaemonHealth({ ok: true, name: 'token-horizon', version: '1.0' }), true)
  for (const value of [
    null,
    {},
    { ...health, ok: false },
    { ...health, usage_store: false },
    { ...health, name: 'another-app' },
    { ...health, version: '' },
  ]) {
    assert.equal(isDaemonHealth(value), false)
  }
})

test('attaches to an existing core and leaves it running after desktop shutdown', async (t) => {
  const server = createServer((_, response) => response.end(JSON.stringify(health)))
  const port = await listen(server)
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const core = supervisor(port, { executable: '/this-must-never-be-launched' })
  assert.deepEqual(await core.start(), health)
  await core.stop()
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
})

test('refuses an occupied port with an unrelated service', async (t) => {
  const server = createServer((_, response) => response.end('{"ok":true,"name":"other"}'))
  const port = await listen(server)
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await assert.rejects(supervisor(port).start(), /occupied.*not a healthy Token Horizon/)
})

test('starts the owned core, waits for health, and stops it on quit', async (t) => {
  const port = await unusedPort()
  const core = supervisor(port)
  t.after(() => core.stop())
  assert.deepEqual(await core.start(), health)
  await core.stop()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
})

test('reports a missing executable without waiting for the startup deadline', async () => {
  const port = await unusedPort()
  await assert.rejects(
    supervisor(port, { executable: join(process.cwd(), 'missing-daemon') }).start(),
    /Could not launch/
  )
})

test('stops a core that never becomes healthy after the startup deadline', async (t) => {
  const port = await unusedPort()
  const core = supervisor(port, { args: ['-e', 'setInterval(() => {}, 1000)'], startupTimeoutMs: 100 })
  t.after(() => core.stop())
  await assert.rejects(core.start(), /did not become ready/)
  await core.stop()
})

test('escalates shutdown when a child ignores SIGTERM', async (t) => {
  const port = await unusedPort()
  const core = supervisor(port, { env: { ...process.env, TH_TEST_PORT: String(port), TH_TEST_IGNORE_TERM: '1' } })
  t.after(() => core.stop())
  await core.start()
  await core.stop()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
})

test('reports unexpected child exit after readiness', async (t) => {
  const port = await unusedPort()
  let notify!: (message: string) => void
  const exit = new Promise<string>((resolve) => {
    notify = resolve
  })
  const core = supervisor(port, {
    env: { ...process.env, TH_TEST_PORT: String(port), TH_TEST_CRASH: '1' },
    onUnexpectedExit: notify,
  })
  t.after(() => core.stop())
  await core.start()
  assert.match(await exit, /exited \(7\)/)
})
