#!/usr/bin/env node
/**
 * Static file server for report/dist, bound to 127.0.0.1 only.
 *
 *   node report/serve.mjs [port]        (default port 8787)
 *
 * Uses node:http only. Every response carries a Content-Security-Policy and
 * X-Content-Type-Options: nosniff. Paths are resolved inside dist/ and any
 * path that would leave it is refused.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'dist')
const port = Number(process.argv[2] ?? 8787)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('serve: port must be an integer from 0 to 65535')
  process.exit(1)
}

const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

function send(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(message);
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  } catch {
    return send(res, 400, 'bad request')
  }
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = resolve(root, '.' + normalize('/' + pathname))
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, 'forbidden')
  let stat
  try {
    stat = statSync(file)
  } catch {
    return send(res, 404, 'not found')
  }
  if (!stat.isFile()) return send(res, 404, 'not found')
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache'
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const shown = typeof address === 'object' && address ? address.port : port
  console.log(`report served at http://127.0.0.1:${shown}/ (root ${join('report', 'dist')})`)
})
