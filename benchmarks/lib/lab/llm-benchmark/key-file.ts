import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Reading an API key from a file, so a key can live outside the shell
 * environment (and out of shell history and process listings) while still
 * reaching the sweep through `ANTHROPIC_API_KEY_FILE`.
 *
 * A key file may hold either:
 *   - the bare key on its own line, or
 *   - one or more `NAME=value` lines, optionally prefixed with `export ` and
 *     optionally quoted. The value for the requested NAME is used.
 *
 * Blank lines and lines starting with `#` are ignored. A key read from a file is
 * never logged: callers report WHERE it came from, not what it is.
 */

export const ANTHROPIC_KEY_NAME = 'ANTHROPIC_API_KEY'

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
/**
 * A value that can be sent as an HTTP header value: printable ASCII, no space,
 * no control character. Anything else would make the header layer refuse the
 * request, and the refusal text prints the value it refused.
 */
const HEADER_SAFE_VALUE = /^[\x21-\x7E]+$/

/**
 * True when `value` can be sent as an HTTP header value: printable ASCII, no
 * space, and not wrapped in quote characters. A key that still carries its own
 * quotes is a mis-pasted assignment, so it is refused even though every
 * character in it is header-safe.
 */
export function isHeaderSafeApiKey(value: string): boolean {
  return HEADER_SAFE_VALUE.test(value) && !/^["']|["']$/.test(value)
}

/**
 * The value with any trailing shell comment removed. A quoted value ends at its
 * closing quote, and only whitespace or a ` #` comment may follow that quote;
 * anything else (`"KEY"junk`) is not a clean assignment, so the value is refused
 * rather than silently cut. An unquoted value ends at the first ` #`. An
 * unterminated quote is not a key this file can supply.
 */
function withoutTrailingComment(value: string): string | undefined {
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1)
    if (close < 0) return undefined
    const rest = value.slice(close + 1)
    if (rest.trim() !== '' && !/^\s+#/.test(rest)) return undefined
    return value.slice(0, close + 1)
  }
  return value.replace(/\s+#.*$/, '')
}

/**
 * One value, cleaned. The trailing comment is removed FIRST, and only then is a
 * quoted value unquoted, so `"key" # note` yields `key`, not `"key"`. The result
 * must be a header-safe key, otherwise the value is not a key this file can supply.
 */
function cleanValue(raw: string): string | undefined {
  const bare = withoutTrailingComment(raw.trim())
  if (bare === undefined) return undefined
  const trimmed = bare.trim()
  const quoted =
    trimmed.length >= 2 &&
    (trimmed[0] === '"' || trimmed[0] === "'") &&
    trimmed[0] === trimmed[trimmed.length - 1]
  const value = (quoted ? trimmed.slice(1, -1) : trimmed).trim()
  return value.length > 0 && isHeaderSafeApiKey(value) ? value : undefined
}

/**
 * The key named `name` from the text of a key file. PURE.
 *
 * Returns `undefined` for an empty file, for a file whose `NAME=value` lines
 * don't name `name`, for an empty or unsafe value, and for a bare file with more
 * than one line (a key plus a label, or two keys: which one is the key is not
 * knowable, so none is returned). A file with no `NAME=value` line at all is
 * read as a bare key, and must be exactly one line.
 */
export function parseKeyFile(text: string, name: string = ANTHROPIC_KEY_NAME): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (lines.length === 0) return undefined

  const assignments = lines
    .map((line) => ASSIGNMENT.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
  if (assignments.length === 0) {
    // No NAME=value line: the file is the bare key, and only one line can be it.
    return lines.length === 1 ? cleanValue(lines[0]) : undefined
  }

  const hit = assignments.find((match) => match[1] === name)
  if (!hit) return undefined
  return cleanValue(hit[2])
}

/**
 * Read and parse a key file. Returns `undefined` when the file is missing or
 * unreadable, so the caller decides whether that is fatal. A leading `~/` is
 * expanded to the home directory.
 */
export function readKeyFile(path: string, name: string = ANTHROPIC_KEY_NAME): string | undefined {
  const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  let text: string
  try {
    text = readFileSync(resolved, 'utf8')
  } catch {
    return undefined
  }
  return parseKeyFile(text, name)
}

/**
 * Why the environment's `ANTHROPIC_API_KEY` cannot be used, or undefined when it
 * can or is not set. The value is never part of the answer, so a caller can name
 * the problem without printing the key.
 */
export function anthropicEnvKeyProblem(
  env: Record<string, string | undefined>
): 'not-header-safe' | undefined {
  const direct = env[ANTHROPIC_KEY_NAME]?.trim()
  if (!direct) return undefined
  return isHeaderSafeApiKey(direct) ? undefined : 'not-header-safe'
}

/**
 * The Anthropic key for this process: `ANTHROPIC_API_KEY` when it is set, else the
 * key in the file `ANTHROPIC_API_KEY_FILE` names. The file is not read when the
 * variable is set. `source` says which path supplied the key; the key itself is
 * returned only to the caller that needs it, never logged here.
 *
 * An environment key that cannot be sent in a header is rejected (undefined), and
 * the file is not consulted in its place: the sweep then stops with its fatal
 * message, instead of making calls that the header layer refuses.
 */
export function resolveAnthropicApiKey(
  env: Record<string, string | undefined>
): { apiKey: string; source: 'env' | 'file' } | undefined {
  const direct = env[ANTHROPIC_KEY_NAME]?.trim()
  if (direct) return isHeaderSafeApiKey(direct) ? { apiKey: direct, source: 'env' } : undefined
  const file = env.ANTHROPIC_API_KEY_FILE?.trim()
  if (!file) return undefined
  const fromFile = readKeyFile(file)
  return fromFile ? { apiKey: fromFile, source: 'file' } : undefined
}
