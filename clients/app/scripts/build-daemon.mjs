import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  daemonFilename,
  goArchitectures,
  goPlatforms,
  sha256,
  validateTarget,
  verifyDaemonBundle,
} from './daemon-bundle.mjs'

export const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repositoryDirectory = resolve(appDirectory, '../..')

export function buildDaemon({ platform = process.platform, arch = process.arch, version } = {}) {
  validateTarget(platform, arch)
  version ??=
    process.env.MARKETING_VERSION ?? JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid desktop version: ${version}`)
  }
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  }).trim()
  const builtAt = new Date().toISOString()
  const directory = join(appDirectory, 'resources/daemon')
  const filename = daemonFilename(platform)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `${filename}.${process.pid}.tmp`)
  const stampPackage = 'github.com/castlemilk/token-horizon/daemons/go/internal/platform'
  const ldflags = [
    '-s',
    '-w',
    ...(platform === 'win32' ? ['-H=windowsgui'] : []),
    '-X',
    `${stampPackage}.version=${version}`,
    '-X',
    `${stampPackage}.commit=${commit}`,
    '-X',
    `${stampPackage}.builtAt=${builtAt}`,
  ].join(' ')
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', '-buildvcs=false', '-ldflags', ldflags, '-o', temporary, './cmd/token-horizon-daemon'],
      {
        cwd: join(repositoryDirectory, 'daemons/go'),
        env: { ...process.env, CGO_ENABLED: '0', GOOS: goPlatforms[platform], GOARCH: goArchitectures[arch] },
        stdio: 'inherit',
      }
    )
    chmodSync(temporary, 0o755)
    const info = {
      version,
      commit,
      built_at: builtAt,
      platform,
      arch,
      filename,
      sha256: sha256(readFileSync(temporary)),
    }
    // This directory is generated. Keep exactly one target so a prior build cannot leak into an installer.
    for (const previous of ['token-horizon-daemon', 'token-horizon-daemon.exe', 'build-info.json']) {
      rmSync(join(directory, previous), { force: true })
    }
    renameSync(temporary, join(directory, filename))
    writeFileSync(join(directory, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
    verifyDaemonBundle(directory, platform, arch, version)
    console.log(`Bundled daemon ${version} (${commit}) for ${platform}/${arch}`)
    return info
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, arch: { type: 'string' } } })
  buildDaemon(values)
}
