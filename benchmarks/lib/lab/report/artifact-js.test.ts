import { describe, it, expect } from 'vitest'

import { safeFileName } from './artifact-js'

describe('safeFileName', () => {
  it('leaves plain ids unchanged', () => {
    expect(safeFileName('claude-4')).toBe('claude-4')
    expect(safeFileName('mini_platformer')).toBe('mini_platformer')
  })

  it('removes dots and other unsafe characters', () => {
    const name = safeFileName('gpt-5.5/high:x')
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(name.startsWith('gpt-5_5_high_x-')).toBe(true)
  })

  it('keeps ids that sanitise to the same stem apart', () => {
    expect(safeFileName('a.b')).not.toBe(safeFileName('a_b'))
    expect(safeFileName('a.b')).not.toBe(safeFileName('a/b'))
  })

  it('is deterministic', () => {
    expect(safeFileName('x.y')).toBe(safeFileName('x.y'))
  })
})
