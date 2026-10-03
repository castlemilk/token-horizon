import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { binaryTarget, daemonFilename, sha256, validateTarget, verifyDaemonBundle } from '../scripts/daemon-bundle.mjs'

function executable(platform, arch) {
  const bytes = Buffer.alloc(128)
  if (platform === 'linux') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes)
    bytes.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18)
  } else if (platform === 'win32') {
    bytes.write('MZ')
    bytes.writeUInt32LE(64, 0x3c)
    bytes.write('PE\0\0', 64)
    bytes.writeUInt16LE(0x8664, 68)
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4)
  }
  return bytes
}

for (const [platform, arch] of [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['win32', 'x64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
]) {
  test(`reads executable architecture for ${platform}/${arch}`, () => {
    assert.deepEqual(binaryTarget(executable(platform, arch)), { platform, arch })
  })
}

test('rejects truncated executables, invalid PE pointers, and unsupported desktop targets', () => {
  assert.throws(() => binaryTarget(Buffer.alloc(12)), /truncated/)
  const bytes = executable('win32', 'x64')
  bytes.writeUInt32LE(200, 0x3c)
  assert.throws(() => binaryTarget(bytes), /Invalid PE/)
  assert.throws(() => validateTarget('win32', 'arm64'), /Unsupported/)
  assert.throws(() => validateTarget('linux', 'ia32'), /Unsupported/)
})

test('packaging rejects a wrong target, stale version, or changed executable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'token-horizon-bundle-test-'))
  const bytes = executable('linux', 'x64')
  const path = join(directory, daemonFilename('linux'))
  const info = {
    platform: 'linux',
    arch: 'x64',
    filename: daemonFilename('linux'),
    version: '13.0.0',
    commit: 'abc123',
    built_at: '2026-10-02T00:00:00Z',
    sha256: sha256(bytes),
  }
  try {
    writeFileSync(path, bytes)
    chmodSync(path, 0o755)
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify(info))
    assert.deepEqual(verifyDaemonBundle(directory, 'linux', 'x64', '13.0.0'), info)
    assert.throws(() => verifyDaemonBundle(directory, 'linux', 'arm64', '13.0.0'), /Wrong daemon/)
    assert.throws(() => verifyDaemonBundle(directory, 'linux', 'x64', '14.0.0'), /does not match/)
    bytes[100] = 1
    writeFileSync(path, bytes)
    assert.throws(() => verifyDaemonBundle(directory, 'linux', 'x64', '13.0.0'), /does not match/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
