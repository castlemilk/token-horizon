import { describe, expect, it } from 'vitest'
import { BEHAVIOURAL_RUN_CHECK, isFallbackCheck, type BenchmarkTask } from '../types'
import { scoreWithBreakdown } from './behavioral'

// No browser is needed for these: a task with no checks is scored structurally,
// and the one row it leaves is the fallback row.
const NO_CHECKS_TASK = { id: 'no-such-behavioural-task', title: 'x', prompt: '' } as unknown as BenchmarkTask
const HTML = '<!doctype html><html><head><title>t</title></head><body><h1>Hello there</h1><p>text</p></body></html>'

describe('fallback rows', () => {
  it('a task with no behavioural checks leaves a fallback row, not an empty list', async () => {
    const result = await scoreWithBreakdown(HTML, NO_CHECKS_TASK)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ name: BEHAVIOURAL_RUN_CHECK, kind: 'fallback', maxPoints: 0, points: 0 })
    expect(isFallbackCheck(result.checks[0]!)).toBe(true)
    expect(result.fallbackReason).toMatch(/no behavioural checks/)
  })

  it('a fallback row that lost its kind is still a fallback, by name', () => {
    // The shape a backfill that copies only the historical fields used to write.
    expect(isFallbackCheck({ name: BEHAVIOURAL_RUN_CHECK })).toBe(true)
    expect(isFallbackCheck({ name: 'code-fallback' })).toBe(true)
  })

  it('a real check that failed is not a fallback', () => {
    expect(isFallbackCheck({ name: 'platformer-jump', kind: undefined })).toBe(false)
  })
})
