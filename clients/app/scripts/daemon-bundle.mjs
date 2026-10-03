import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const goPlatforms = { linux: 'linux', win32: 'windows', darwin: 'darwin' }
export const goArchitectures = { x64: 'amd64', arm64: 'arm64' }

export function daemonFilename(platform) {
  return `token-horizon-daemon${platform === 'win32' ? '.exe' : ''}`
}

export function validateTarget(platform, arch) {
  if (!goPlatforms[platform] || !goArchitectures[arch] || (platform === 'win32' && arch !== 'x64')) {
    throw new Error(`Unsupported desktop target: ${platform}/${arch}`)
  }
}

export function binaryTarget(bytes) {
  if (bytes.length < 64) throw new Error('Daemon executable is truncated')
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Expected a 64-bit little-endian ELF daemon')
    const machine = bytes.readUInt16LE(18)
    return { platform: 'linux', arch: { 0x3e: 'x64', 0xb7: 'arm64' }[machine] }
  }
  if (bytes.toString('ascii', 0, 2) === 'MZ') {
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
      throw new Error('Invalid PE daemon executable')
    }
    return { platform: 'win32', arch: { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(peOffset + 4)] }
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { platform: 'darwin', arch: { 0x1000007: 'x64', 0x100000c: 'arm64' }[bytes.readUInt32LE(4)] }
  }
  throw new Error('Daemon is not a supported ELF, PE, or Mach-O executable')
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyDaemonBundle(directory, platform, arch, version) {
  validateTarget(platform, arch)
  const filename = daemonFilename(platform)
  const path = join(directory, filename)
  const bytes = readFileSync(path)
  const actual = binaryTarget(bytes)
  if (actual.platform !== platform || actual.arch !== arch) {
    throw new Error(`Wrong daemon executable: expected ${platform}/${arch}, got ${actual.platform}/${actual.arch}`)
  }
  const info = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8'))
  if (
    info.platform !== platform ||
    info.arch !== arch ||
    info.filename !== filename ||
    info.sha256 !== sha256(bytes) ||
    (version !== undefined && info.version !== version) ||
    typeof info.commit !== 'string' ||
    !info.commit ||
    !Number.isFinite(Date.parse(info.built_at))
  ) {
    throw new Error('Daemon build-info.json does not match the executable or desktop version')
  }
  // Windows filesystems do not expose POSIX executable bits for cross-target bundles.
  if (process.platform !== 'win32' && platform !== 'win32' && (statSync(path).mode & 0o111) === 0) {
    throw new Error('Bundled daemon is missing executable permissions')
  }
  return info
}
