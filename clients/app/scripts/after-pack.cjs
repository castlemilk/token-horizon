module.exports = async function afterPack(context) {
  const { join } = require('node:path')
  const { extractFile } = require('@electron/asar')
  const { verifyDaemonBundle } = await import('./daemon-bundle.mjs')
  // electron-builder's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
      : join(context.appOutDir, 'resources')
  verifyDaemonBundle(join(resources, 'daemon'), context.electronPlatformName, arch, context.packager.appInfo.version)
  // These are loaded from ASAR at runtime; a whitelist that omits one must fail the build.
  for (const filename of [
    'out/main/main.js',
    'out/preload/preload.js',
    'out/renderer/index.html',
    'resources/build/icon.png',
  ]) {
    extractFile(join(resources, 'app.asar'), filename)
  }
}
