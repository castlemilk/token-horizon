// Dev launcher: vite dev + electron against the dev server. Spawns both as
// children (cross-platform — no shell `&`) and tears down together.
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = 'http://localhost:5173'

const vite = spawn('npm', ['run', 'dev', '--', '--strictPort'], { cwd: root, stdio: 'inherit' })
const electron = spawn(
  'npx',
  ['electron', '.'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_DEV_URL: url } }
)

const shutdown = () => {
  vite.kill()
  electron.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
electron.on('exit', shutdown)
vite.on('exit', shutdown)
