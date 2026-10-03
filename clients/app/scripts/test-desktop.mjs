import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appDirectory } from './build-daemon.mjs'

// Enumerate in Node so Windows cmd and Unix shells run exactly the same suites.
const tests = readdirSync(join(appDirectory, 'tests'))
  .filter((name) => /\.test\.(ts|mjs)$/.test(name))
  .sort()
  .map((name) => join(appDirectory, 'tests', name))
if (tests.length === 0) throw new Error('No desktop tests found')
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...tests], {
  cwd: appDirectory,
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
