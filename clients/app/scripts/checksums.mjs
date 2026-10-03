import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appDirectory } from './build-daemon.mjs'
import { sha256 } from './daemon-bundle.mjs'

const directory = join(appDirectory, 'dist')
const artifacts = readdirSync(directory)
  .filter((name) => /\.(AppImage|deb|exe)$/.test(name))
  .sort()
if (artifacts.length === 0) throw new Error('No desktop installers were built')
const lines = artifacts.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}`)
writeFileSync(join(directory, `SHA256SUMS-${process.platform}-${process.arch}.txt`), `${lines.join('\n')}\n`)
console.log(lines.join('\n'))
