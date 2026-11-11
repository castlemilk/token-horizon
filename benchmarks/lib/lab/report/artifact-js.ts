import { createHash } from 'node:crypto'

/**
 * File-name helper for the static report's capture step.
 *
 * Captured images are written to `dist/gallery/<taskId>/<modelId>-a.jpg` (and -b.jpg). Model and task ids
 * contain dots, slashes and colons, so each id is made file-system safe here.
 */

/**
 * A file-system-safe stem for a model or task id. Ids that are already plain
 * (letters, digits, '_' and '-') are returned unchanged; any other id (model
 * ids contain dots, slashes, colons, ...) gets its unsafe runs replaced by '_'
 * plus an 8-hex-digit hash of the original, so two different ids can never
 * collapse onto the same file name.
 */
export function safeFileName(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id
  const readable = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'id'
  const digest = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8)
  return `${readable}-${digest}`
}
