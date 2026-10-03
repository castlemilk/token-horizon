import { spawn, type ChildProcess } from 'node:child_process'
import { get } from 'node:http'
import { join, resolve } from 'node:path'

export const DAEMON_URL = 'http://127.0.0.1:8765'

export interface DaemonHealth {
  ok: true
  name: 'token-horizon-daemon' | 'token-horizon'
  version: string
  build?: { version: string; commit: string; built_at: string }
}

export function isDaemonHealth(value: unknown): value is DaemonHealth {
  if (!value || typeof value !== 'object') return false
  const health = value as Record<string, unknown>
  return (
    health.ok === true &&
    typeof health.version === 'string' &&
    health.version.length > 0 &&
    ((health.name === 'token-horizon-daemon' && health.usage_store === true) || health.name === 'token-horizon')
  )
}

export function daemonExecutable(options: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  platform: NodeJS.Platform
  override?: string
}): string {
  if (options.override) return resolve(options.override)
  const filename = options.platform === 'win32' ? 'token-horizon-daemon.exe' : 'token-horizon-daemon'
  return join(options.packaged ? options.resourcesPath : join(options.appPath, 'resources'), 'daemon', filename)
}

interface SupervisorOptions {
  executable: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  healthUrl?: string
  startupTimeoutMs?: number
  pollIntervalMs?: number
  stopTimeoutMs?: number
  onUnexpectedExit?: (message: string) => void
}

/** Attach to a healthy local core, or supervise only the child this desktop launched. */
export class DaemonSupervisor {
  private child: ChildProcess | undefined
  private stopping = false
  private ready = false
  private stderr = ''
  private failure: string | undefined
  private readonly options: SupervisorOptions

  constructor(options: SupervisorOptions) {
    this.options = options
  }

  async start(): Promise<DaemonHealth> {
    const existing = await this.probe()
    if (this.stopping) throw new Error('Desktop startup was cancelled.')
    if (existing) return existing

    this.child = spawn(this.options.executable, this.options.args ?? ['--port', '8765', '--desktop'], {
      env: this.options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    this.child.stdin?.on('error', () => {
      // The core may close its input as it exits; shutdown still waits for close.
    })
    this.child.stderr?.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8000)
    })
    this.child.on('error', (error) => {
      this.failure = `Could not launch the local core: ${error.message}`
    })
    this.child.on('exit', (code, signal) => {
      this.failure = `The local core exited (${signal ?? code ?? 'unknown'}). ${this.stderr.trim()}`
      if (this.ready && !this.stopping) this.options.onUnexpectedExit?.(this.failure)
    })

    try {
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 15000)
      while (Date.now() < deadline) {
        if (this.stopping) throw new Error('Desktop startup was cancelled.')
        if (this.failure) throw new Error(this.failure)
        const health = await this.probe()
        if (health && !this.failure) {
          this.ready = true
          return health
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 150))
      }
      throw new Error(`The local core did not become ready at ${DAEMON_URL}. ${this.stderr.trim()}`)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, this.options.stopTimeoutMs ?? 5000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      // EOF is portable and lets Go release owned sidecars even on Windows.
      child.stdin?.end()
    })
  }

  private probe(): Promise<DaemonHealth | null> {
    return new Promise((resolve, reject) => {
      const request = get(this.options.healthUrl ?? `${DAEMON_URL}/health`, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 65536) request.destroy(new Error('Local core health response is too large.'))
        })
        response.on('error', reject)
        response.on('end', () => {
          let health: unknown
          try {
            health = JSON.parse(body)
          } catch {
            // An unrelated service or incomplete response must never be adopted.
          }
          if (response.statusCode === 200 && isDaemonHealth(health)) resolve(health)
          else reject(new Error('Port 8765 is occupied by a service that is not a healthy Token Horizon core.'))
        })
      })
      request.setTimeout(1000, () => request.destroy(new Error('The local core health check timed out on port 8765.')))
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') resolve(null)
        else reject(error)
      })
    })
  }
}
