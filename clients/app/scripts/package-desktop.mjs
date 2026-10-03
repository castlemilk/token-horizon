import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { appDirectory, buildDaemon } from './build-daemon.mjs'
import { validateTarget } from './daemon-bundle.mjs'

const { values } = parseArgs({
  options: { platform: { type: 'string' }, arch: { type: 'string' }, unpacked: { type: 'boolean', default: false } },
})
const platform = values.platform ?? process.platform
const arch = values.arch ?? process.arch
validateTarget(platform, arch)
const info = buildDaemon({ platform, arch })
const require = createRequire(import.meta.url)
const vitePackage = require.resolve('electron-vite/package.json')
const viteManifest = require(vitePackage)
execFileSync(process.execPath, [join(vitePackage, '..', viteManifest.bin['electron-vite']), 'build'], {
  cwd: appDirectory,
  stdio: 'inherit',
})
const { build, Platform, Arch } = require('electron-builder')
const builderPlatform = { linux: Platform.LINUX, win32: Platform.WINDOWS, darwin: Platform.MAC }[platform]
await build({
  projectDir: appDirectory,
  targets: builderPlatform.createTarget(values.unpacked ? ['dir'] : undefined, Arch[arch]),
  publish: 'never',
  config: { extends: join(appDirectory, 'electron-builder.yml'), extraMetadata: { version: info.version } },
})
