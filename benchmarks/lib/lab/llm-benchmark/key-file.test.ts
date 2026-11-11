import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anthropicEnvKeyProblem, isHeaderSafeApiKey, parseKeyFile, readKeyFile, resolveAnthropicApiKey } from './key-file'

const dirs: string[] = []

function fileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'key-file-test-'))
  dirs.push(dir)
  const path = join(dir, 'key')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseKeyFile', () => {
  it('reads a bare key on its own line', () => {
    expect(parseKeyFile('sk-ant-api03-abc123\n')).toBe('sk-ant-api03-abc123')
  })

  it('trims surrounding whitespace from a bare key', () => {
    expect(parseKeyFile('   sk-ant-api03-abc123  \r\n')).toBe('sk-ant-api03-abc123')
  })

  it('reads NAME=value for the requested name', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY=sk-plain\n')).toBe('sk-plain')
  })

  it('accepts an export prefix', () => {
    expect(parseKeyFile('export ANTHROPIC_API_KEY=sk-exported\n')).toBe('sk-exported')
  })

  it('strips matching double or single quotes', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY="sk-double"\n')).toBe('sk-double')
    expect(parseKeyFile("export ANTHROPIC_API_KEY='sk-single'\n")).toBe('sk-single')
  })

  it('tolerates spaces around the equals sign', () => {
    expect(parseKeyFile('  ANTHROPIC_API_KEY =   sk-spaced  \n')).toBe('sk-spaced')
  })

  it('ignores blank lines and comment lines', () => {
    expect(parseKeyFile('# the sweep key\n\nANTHROPIC_API_KEY=sk-commented\n')).toBe('sk-commented')
  })

  it('picks the requested name out of several assignments', () => {
    const text = 'OPENAI_API_KEY=sk-openai\nANTHROPIC_API_KEY=sk-anthropic\nMOONSHOT_API_KEY=sk-moon\n'
    expect(parseKeyFile(text)).toBe('sk-anthropic')
  })

  it('returns undefined when the file assigns only other names', () => {
    expect(parseKeyFile('OPENAI_API_KEY=sk-openai\n')).toBeUndefined()
  })

  it('returns undefined for an empty file or a whitespace-only file', () => {
    expect(parseKeyFile('')).toBeUndefined()
    expect(parseKeyFile('  \n\t\n')).toBeUndefined()
  })

  it('returns undefined for an empty value', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY=\n')).toBeUndefined()
    expect(parseKeyFile('ANTHROPIC_API_KEY=""\n')).toBeUndefined()
  })

  it('returns undefined for a file that holds only comments', () => {
    expect(parseKeyFile('# nothing here\n')).toBeUndefined()
  })
})

describe('readKeyFile', () => {
  it('reads and parses a file on disk', () => {
    expect(readKeyFile(fileWith('export ANTHROPIC_API_KEY="sk-from-disk"\n'))).toBe('sk-from-disk')
  })

  it('reads a bare key file on disk', () => {
    expect(readKeyFile(fileWith('sk-bare-on-disk\n'))).toBe('sk-bare-on-disk')
  })

  it('returns undefined for a missing file rather than throwing', () => {
    expect(readKeyFile(join(tmpdir(), 'no-such-key-file-for-this-test'))).toBeUndefined()
  })

  it('returns undefined for an empty file', () => {
    expect(readKeyFile(fileWith(''))).toBeUndefined()
  })
})

describe('resolveAnthropicApiKey', () => {
  it('rejects an environment key that cannot be sent in a header, and does not fall back to the file', () => {
    const path = fileWith('ANTHROPIC_API_KEY=sk-from-file\n')
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: 'sk-has a space', ANTHROPIC_API_KEY_FILE: path })).toBeUndefined()
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: 'sk-tab\tinside' })).toBeUndefined()
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: 'sk-new\nline' })).toBeUndefined()
  })

  it('prefers ANTHROPIC_API_KEY and never reads the file', () => {
    const resolved = resolveAnthropicApiKey({
      ANTHROPIC_API_KEY: 'sk-from-env',
      ANTHROPIC_API_KEY_FILE: join(tmpdir(), 'no-such-key-file-for-this-test'),
    })
    expect(resolved).toEqual({ apiKey: 'sk-from-env', source: 'env' })
  })

  it('falls back to the file when ANTHROPIC_API_KEY is not set', () => {
    const path = fileWith('ANTHROPIC_API_KEY=sk-from-file\n')
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY_FILE: path })).toEqual({
      apiKey: 'sk-from-file',
      source: 'file',
    })
  })

  it('treats an empty ANTHROPIC_API_KEY as not set', () => {
    const path = fileWith('sk-file-wins\n')
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: '  ', ANTHROPIC_API_KEY_FILE: path })).toEqual({
      apiKey: 'sk-file-wins',
      source: 'file',
    })
  })

  it('returns undefined when neither variable yields a key', () => {
    expect(resolveAnthropicApiKey({})).toBeUndefined()
    expect(
      resolveAnthropicApiKey({ ANTHROPIC_API_KEY_FILE: join(tmpdir(), 'no-such-key-file-for-this-test') })
    ).toBeUndefined()
  })
})

describe('parseKeyFile: malformed files never yield a value a header cannot carry', () => {
  it('rejects a bare file with a key and a label line, instead of joining them', () => {
    // Joined, this became a header value with a newline in it: the SDK refused the
    // request and its message printed the key.
    expect(parseKeyFile('sk-ant-api03-abc123\nprod key\n')).toBeUndefined()
  })

  it('rejects a bare file that holds two keys', () => {
    expect(parseKeyFile('sk-ant-api03-one\nsk-ant-api03-two\n')).toBeUndefined()
  })

  it('rejects a value with a space, a tab or a control character', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY=sk-ant with space\n')).toBeUndefined()
    expect(parseKeyFile('ANTHROPIC_API_KEY=sk-ant\tlabel\n')).toBeUndefined()
    expect(parseKeyFile('ANTHROPIC_API_KEY=sk-ant\u0000x\n')).toBeUndefined()
    expect(parseKeyFile('sk-ant\u0007bell\n')).toBeUndefined()
  })

  it('strips an unquoted trailing comment after the value', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY=sk-with-note # rotated 2026-10\n')).toBe('sk-with-note')
  })

  it('removes a trailing comment after a quoted value before unquoting it', () => {
    // The gate's case: the quotes must not survive into the key.
    const key = 'sk-ant-api03-quoted-note-0123456789abcdef'
    expect(parseKeyFile(`export ANTHROPIC_API_KEY="${key}" # rotated 2026-10\n`)).toBe(key)
    expect(parseKeyFile(`ANTHROPIC_API_KEY='${key}'   # note\n`)).toBe(key)
  })

  it('reads a quoted value whose hash is inside the quotes as unsafe, not as a comment', () => {
    // A space inside the quotes is not a header-safe key, so nothing is returned.
    expect(parseKeyFile('ANTHROPIC_API_KEY="sk-ab # cd"\n')).toBeUndefined()
  })

  it('rejects a quote that is never closed', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY="sk-open-quote\n')).toBeUndefined()
  })

  it('unquotes a bare key written in quotes', () => {
    expect(parseKeyFile('"sk-ant-api03-quoted"\n')).toBe('sk-ant-api03-quoted')
  })

  it('rejects a colon-separated line, which is not a NAME=value assignment', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY: sk-ant-api03-colon\n')).toBeUndefined()
  })

  it('accepts a key whose every character is printable ASCII', () => {
    expect(isHeaderSafeApiKey('sk-ant-api03-Abc_123.def~xyz')).toBe(true)
    expect(isHeaderSafeApiKey('sk-ant\nx')).toBe(false)
    expect(isHeaderSafeApiKey('')).toBe(false)
  })
})

describe('a key in the environment that cannot be sent in a header', () => {
  it('is named as the problem, without the value, so the run script blames the variable', () => {
    expect(anthropicEnvKeyProblem({ ANTHROPIC_API_KEY: 'sk-has space' })).toBe('not-header-safe')
    expect(anthropicEnvKeyProblem({ ANTHROPIC_API_KEY: 'sk-ok-key' })).toBeUndefined()
    expect(anthropicEnvKeyProblem({})).toBeUndefined()
  })

  it('is not replaced by the file, and the message does not print the key', () => {
    const path = fileWith('ANTHROPIC_API_KEY=sk-from-file\n')
    const bad = 'sk-secret value'
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: bad, ANTHROPIC_API_KEY_FILE: path })).toBeUndefined()
    expect(anthropicEnvKeyProblem({ ANTHROPIC_API_KEY: bad })).not.toContain('sk-secret')
  })
})


describe('malformed quoted values are refused, not cut', () => {
  it('refuses a quoted value followed by text other than a comment, instead of silently dropping the text', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY="KEYVALUE"junk')).toBeUndefined()
    expect(parseKeyFile("ANTHROPIC_API_KEY='KEYVALUE'junk")).toBeUndefined()
  })

  it('still reads a quoted value followed by whitespace and a comment', () => {
    expect(parseKeyFile('ANTHROPIC_API_KEY="KEYVALUE"   # rotated 2026')).toBe('KEYVALUE')
    expect(parseKeyFile('ANTHROPIC_API_KEY="KEYVALUE"')).toBe('KEYVALUE')
  })

  it('refuses an environment key that still carries quote characters at either end', () => {
    expect(isHeaderSafeApiKey('"KEYVALUE"')).toBe(false)
    expect(isHeaderSafeApiKey("'KEYVALUE")).toBe(false)
    expect(isHeaderSafeApiKey('KEYVALUE')).toBe(true)
    expect(anthropicEnvKeyProblem({ ANTHROPIC_API_KEY: '"KEYVALUE"' })).toBe('not-header-safe')
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: '"KEYVALUE"' })).toBeUndefined()
  })
})
