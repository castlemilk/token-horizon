import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daemonVersion, fetchJSON, limitRows } from '../app/components/token-horizon/api.ts'

test('portable daemon limit rows preserve every window and epoch-second reset', () => {
  const now = Date.UTC(2026, 9, 2, 0, 0, 0)
  const rows = limitRows(
    [
      { provider: 'codex', label: 'weekly', usedPercent: 20 },
      { provider: 'claude', label: '5h', usedPercent: 120, resetsAt: now / 1000 + 3600 },
      { provider: 'codex', label: '5h', usedPercent: -10, resetsAt: now / 1000 + 60 },
    ],
    now
  )
  assert.deepEqual(
    rows.map((row) => row.label),
    ['5h', '5h', 'weekly']
  )
  assert.equal(rows[0].resetsIn, '1m')
  assert.equal(rows[0].remainingPercent, 100)
  assert.equal(rows[1].resetsIn, '1h')
  assert.equal(rows[1].usedPercent, 100)
  assert.equal(rows[2].resetsIn, 'Unavailable')
  assert.equal(rows[2].urgency, 'normal')
})

test('reset at the current time is preserved instead of treated as missing', () => {
  const [row] = limitRows([{ provider: 'kimi', label: 'weekly', usedPercent: 55, resetsAt: 0 }], 0)
  assert.equal(row.resetsIn, 'Now')
  assert.equal(row.remainingPercent, 45)
})

test('version identifies the Go build and the Swift build rather than its API schema', () => {
  assert.equal(daemonVersion({ ok: true, name: 'token-horizon-daemon', version: '13.0.0' }), '13.0.0')
  assert.equal(daemonVersion({ ok: true, name: 'token-horizon', version: 1, build: { version: '13.0.1' } }), '13.0.1')
  assert.equal(daemonVersion({ ok: true, version: 1 }), null)
  assert.equal(daemonVersion(null), null)
})

test('failed local responses cannot appear as a connected service', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"service unavailable"}', { status: 503 })
  try {
    await assert.rejects(fetchJSON('http://127.0.0.1:8765/stats'), /503/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('renderer imports the query and IPC clients without requiring an Electron preload', async () => {
  const { conveyor, queryClient } = await import('../conveyor/client.ts')
  assert.ok(queryClient)
  assert.ok(conveyor)
  assert.equal(typeof globalThis.window, 'undefined')
})
