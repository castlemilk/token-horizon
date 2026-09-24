/**
 * Loopback service endpoints. The Token Horizon daemon serves :8765, the
 * workflow engine :8766, and the Ollama telemetry proxy :11435.
 *
 * Retarget another machine's daemons via query params
 * (`?server=host:8765&engine=host:8766&proxy=host:11435`), persisted in
 * localStorage so the choice survives reloads.
 */
function resolve(key: string, param: string, fallback: string): string {
  const storageKey = `th.endpoint.${key}`
  const fromQuery = new URLSearchParams(window.location.search).get(param)
  if (fromQuery) {
    localStorage.setItem(storageKey, fromQuery)
    return withScheme(fromQuery)
  }
  const stored = localStorage.getItem(storageKey)
  if (stored) return withScheme(stored)
  return fallback
}

function withScheme(host: string): string {
  return host.startsWith('http') ? host : `http://${host}`
}

export const endpoints = {
  server: resolve('server', 'server', 'http://127.0.0.1:8765'),
  engine: resolve('engine', 'engine', 'http://127.0.0.1:8766'),
  proxy: resolve('proxy', 'proxy', 'http://127.0.0.1:11435'),
}
