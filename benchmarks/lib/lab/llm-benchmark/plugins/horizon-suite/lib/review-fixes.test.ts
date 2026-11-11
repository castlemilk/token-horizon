/**
 * Plain (no browser) tests for the review fixes in the kit's pure helpers and the
 * matrix's structure check. Each block names the defect it pins.
 */
import { describe, expect, it } from 'vitest'
import { clockwiseAngle, clockwiseAngleRad, deepEqual, parseCssColour } from './math'
import { expressionFor } from './probe'
import { structureProblems } from './fixture-matrix'
import { defineCheck } from './check'

describe('math: edge cases the review found', () => {
  it('deepEqual is false for different non-plain objects that have no own keys', () => {
    expect(deepEqual(new Date(1), new Date(2))).toBe(false)
    expect(deepEqual(new Map([[1, 2]]), new Map())).toBe(false)
    expect(deepEqual(new Set([1]), {})).toBe(false)
    const d = new Date(1)
    expect(deepEqual(d, d)).toBe(true)
  })

  it('deepEqual compares typed arrays element by element with Object.is', () => {
    expect(deepEqual(new Float64Array([1, NaN]), new Float64Array([1, NaN]))).toBe(true)
    expect(deepEqual(new Float64Array([0]), new Float64Array([-0]))).toBe(false)
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(deepEqual(new Uint8Array([1]), new Int8Array([1]))).toBe(false)
  })

  it('a zero-length vector has no direction: its angles are NaN, not 180', () => {
    expect(clockwiseAngleRad(0, 0)).toBeNaN()
    expect(clockwiseAngle(0, 0)).toBeNaN()
    expect(clockwiseAngle(0, -1)).toBeCloseTo(0, 12)
  })

  it('colour channels reject empty tokens and clamp to the 0..255 range', () => {
    expect(() => parseCssColour('rgb(, , )')).toThrow(/empty channel/)
    expect(parseCssColour('color(srgb 1.2 -0.1 0.5)')).toEqual([255, 0, 127.5, 1])
    expect(parseCssColour('rgb(300, -5, 128)')).toEqual([255, 0, 128, 1])
  })
})

describe('probe: arguments JSON cannot carry are refused, not changed', () => {
  it('refuses NaN, infinities, -0, undefined properties, bigint and functions with a hint', () => {
    for (const arg of [{ n: NaN }, { i: Infinity }, { z: -0 }, { u: undefined }, { b: BigInt(1) }, { f: () => 1 }, [NaN]]) {
      expect(() => expressionFor('() => 1', arg)).toThrow(TypeError)
    }
    expect(() => expressionFor('() => 1', { n: NaN })).toThrow(/inside the source string/)
  })

  it('accepts plain JSON data, and no argument at all', () => {
    expect(expressionFor('() => 1')).toBe('(() => 1\n)(undefined)')
    expect(expressionFor('(a) => a', { x: [1, 'two', null, true, { y: 0.5 }] })).toContain('{"x":[1,"two",null,true,{"y":0.5}]}')
  })

  it('ends the source on its own line so a trailing line comment still parses', () => {
    expect(expressionFor('() => 1 // done')).toBe('(() => 1 // done\n)(undefined)')
  })
})

describe('check: a deadline that cannot be used as a check budget', () => {
  it('defineCheck still refuses a check without a rationale', () => {
    expect(() => defineCheck('no-reason', 1, '', () => true)).toThrow(/rationale/)
  })
})

describe('fixture matrix structure', () => {
  const one = defineCheck('only', 10, 'the only check', () => true)
  const fixtures = [{ name: 'good', html: '<p>x</p>' }]

  it('a well formed matrix has no structural problem', () => {
    expect(structureProblems({ checks: [one], fixtures, expectations: { good: 'good' }, totalPoints: 10 })).toEqual([])
  })

  it('an empty fixture list is a problem', () => {
    expect(structureProblems({ checks: [one], fixtures: [], expectations: {}, totalPoints: 10 })).toContain('the matrix has no fixtures')
  })

  it('a matrix with no good fixture is a problem, even with a failing fixture present', () => {
    const problems = structureProblems({
      checks: [one],
      fixtures: [{ name: 'broken', html: '' }],
      expectations: { broken: ['only'] },
      totalPoints: 10,
    })
    expect(problems).toContain('no fixture has expectation good')
  })

  it('a budget that does not sum to the total, and an expectation with no fixture, are problems', () => {
    const problems = structureProblems({
      checks: [one],
      fixtures,
      expectations: { good: 'good', ghost: 'good' },
      totalPoints: 100,
    })
    expect(problems.some((p) => p.includes('sum to 10, not 100'))).toBe(true)
    expect(problems).toContain('expectation ghost has no fixture')
  })
})
