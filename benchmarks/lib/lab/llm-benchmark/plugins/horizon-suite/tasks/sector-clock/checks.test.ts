import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { checks, CHECK_SPECS, PROMPT_SHA256, promptHash } from './checks'
import { brokenArtifacts, expectations, goodArtifact, goodVariants, staticPicture } from './fixtures'
import * as H from './hidden'
import { pose } from './pose'
import { UTC_MS_MAX, UTC_MS_MIN } from './reference'
import { task } from './task'

/** The specification file, compared when it is still on disk. The hash above is the check that always runs. */
const SPEC_PATH =
  new URL('../../design/task-sector-clock.json', import.meta.url)
const PROMPTS_PATH = new URL('../../../../prompts.ts', import.meta.url)

const specFile = existsSync(SPEC_PATH) ? JSON.parse(readFileSync(SPEC_PATH, 'utf8')) : undefined

describe('sector-clock definition', () => {
  it('names and points match the specification file in order and sum to 100', () => {
    const names = CHECK_SPECS.map((c) => c.name)
    expect(names).toEqual(task.checks)
    expect(Object.keys(checks)).toEqual(names)
    expect(CHECK_SPECS.reduce((n, c) => n + c.points, 0)).toBe(100)
    for (const spec of CHECK_SPECS) {
      expect(checks[spec.name]?.checkName).toBe(spec.name)
      expect(checks[spec.name]?.maxPoints).toBe(spec.points)
    }
    if (specFile !== undefined) {
      const fromSpec = specFile.final_checks.map((c: { name: string; points: number }) => ({ name: c.name, points: c.points }))
      expect(fromSpec).toEqual(CHECK_SPECS)
    }
  })

  it('the task prompt is the specification final_prompt, pinned by hash inside the plugin', () => {
    expect(promptHash(task.prompt)).toBe(PROMPT_SHA256)
    if (specFile !== undefined) expect(task.prompt).toBe(specFile.final_prompt)
  })

  it('the task row declares the fixed fields', () => {
    expect(task.id).toBe('sector-clock')
    expect(task.slug).toBe('sector-clock')
    expect(task.category).toBe('ui-building')
    expect(task.title).toBe('Sector Clock')
    expect(task.scorer).toBe('behavioral')
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
    expect(task.iterationsDefault).toBe(3)
    expect(task.blurb.length).toBeGreaterThan(0)
    expect(task.methodNotes.length).toBeGreaterThan(0)
  })

  it('the sandbox contract is the first eight contract lines of SANDBOX_CONSTRAINTS plus the sentence', () => {
    const prompts = readFileSync(PROMPTS_PATH, 'utf8')
    const lines = prompts.split('\n')
    const start = lines.findIndex((l) => l.startsWith('export const SANDBOX_CONSTRAINTS = `'))
    const body: string[] = []
    for (let i = start + 1; i < lines.length && body.length < 8; i++) {
      if (lines[i]!.trim() === '') continue
      if (lines[i]!.startsWith('LAYOUT')) break
      body.push(lines[i]!)
    }
    expect(body.length).toBe(8)
    const contract = task.sandboxConstraints ?? ''
    for (const line of body) expect(contract).toContain(line)
    expect(contract.startsWith(body[0]!)).toBe(true)
    expect(contract.endsWith(
      'Set html,body{margin:0;min-height:100%} and default to a polished dark theme. Every control must work; no placeholder text. Output only the HTML document.'
    )).toBe(true)
    expect(contract).not.toContain('requestAnimationFrame')
  })

  it('the prompt contains no hidden test instant (the public on-load default is excluded by design)', () => {
    const instants = [
      ...H.MINUTE_SECOND_CASES,
      ...H.HOUR_CASES,
      ...H.OFFSET_CASES,
      ...H.DATE_CASES,
      ...H.ISO_WEEK_CASES,
      ...H.H24_CASES,
      ...H.EDGE_CASES,
      ...H.HOST_ZONE_CASES,
      H.PAINT_INSTANT,
      H.PARKED_INSTANT,
      H.SYNC_FIRST,
      H.SYNC_SECOND,
    ]
    // The prompt states the public range bounds; a case that sits exactly on one is not a secret.
    const publicBounds = [UTC_MS_MIN, UTC_MS_MAX]
    for (const inst of instants) {
      if (Math.abs(inst.utcMs) < 1e6 || publicBounds.includes(inst.utcMs)) continue
      expect(task.prompt, `hidden instant ${inst.label}`).not.toContain(String(inst.utcMs))
    }
    // The public default is the only instant the prompt may state.
    expect(task.prompt).toContain(String(H.DEFAULT_INSTANT.utcMs))
  })

  it('the pose uses only the public default and no hidden input', () => {
    expect(pose).toContain(String(H.DEFAULT_INSTANT.utcMs))
    for (const inst of [...H.MINUTE_SECOND_CASES, ...H.OFFSET_CASES]) {
      expect(pose).not.toContain(String(inst.utcMs))
    }
  })

  it('every mutation changes the artifact and the broken variants differ from the good one', () => {
    expect(Object.keys(brokenArtifacts).length).toBe(21)
    expect(Object.keys(goodVariants).length).toBe(4)
    for (const [name, html] of Object.entries({ ...brokenArtifacts, ...goodVariants })) {
      expect(html, name).not.toBe(goodArtifact)
    }
    expect(staticPicture).not.toBe(goodArtifact)
  })

  it('the expectations name only real checks and every fixture has one', () => {
    const names = new Set(CHECK_SPECS.map((c) => c.name))
    for (const [fixture, want] of Object.entries(expectations)) {
      if (want === 'good') continue
      for (const name of want) expect(names.has(name), `${fixture} expects ${name}`).toBe(true)
    }
    expect(Object.keys(expectations).length).toBe(1 + Object.keys(goodVariants).length + Object.keys(brokenArtifacts).length + 1)
  })
})

fixtureMatrix({
  taskId: 'sector-clock',
  checks: CHECK_SPECS.map((c) => checks[c.name]!),
  fixtures: [
    { name: 'clock-good', html: goodArtifact },
    ...Object.entries(goodVariants).map(([name, html]) => ({ name, html })),
    ...Object.entries(brokenArtifacts).map(([name, html]) => ({ name, html })),
    { name: 'clock-control-static-picture', html: staticPicture },
  ],
  expectations,
})
