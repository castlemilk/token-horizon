import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureMatrix } from '../../lib/fixture-matrix'
import { CHECK_LIST, checks } from './checks'
import { PROMPT, SANDBOX_HYGIENE, task } from './task'
import * as H from './hidden'
import { allFixtures, brokenArtifacts, expectations, goodArtifact, staticFake } from './fixtures'
import { pose } from './pose'
import { FIRST_LOAD } from './reference'

/** Public first-load titles: visible in the prompt by design, so never hidden values. */
const FIRST_TITLES: string[] = [...FIRST_LOAD.todo, ...FIRST_LOAD.doing, ...FIRST_LOAD.done]

/** The sha256 of the specification's final_prompt. Pinned, so the comparison never depends on a scratch file. */
const PROMPT_SHA256 = 'c0a8e64acab22f91a74ad29e8945a5a5c8d7caa1abaa361899160def6bff9cc6'

const SPEC = new URL('../../design/task-kanban-keyboard-undo.json', import.meta.url)
const PROMPTS = new URL('../../../../prompts.ts', import.meta.url)
const spec = existsSync(SPEC) ? (JSON.parse(readFileSync(SPEC, 'utf8')) as { final_prompt: string; final_checks: Array<{ name: string; points: number }> }) : null

describe('specification conformance', () => {
  it('declares the ten checks in order with the specified points, summing to 100', () => {
    if (spec !== null) {
      expect(CHECK_LIST.map((c) => c.checkName)).toEqual(spec.final_checks.map((c) => c.name))
      expect(CHECK_LIST.map((c) => c.maxPoints)).toEqual(spec.final_checks.map((c) => c.points))
    }
    expect(CHECK_LIST.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0)).toBe(100)
    expect(Object.keys(checks)).toEqual(CHECK_LIST.map((c) => c.checkName))
  })

  it('the prompt is the pinned specification final_prompt, character for character', () => {
    expect(createHash('sha256').update(PROMPT).digest('hex')).toBe(PROMPT_SHA256)
    if (spec !== null) expect(PROMPT).toBe(spec.final_prompt)
  })

  it('the task row carries the declared identity, scorer and check list', () => {
    expect(task.id).toBe('kanban-keyboard-undo')
    expect(task.slug).toBe('kanban-keyboard-undo')
    expect(task.category).toBe('ui-building')
    expect(task.title).toBe('Keyboard Kanban with Undo')
    expect(task.scorer).toBe('behavioral')
    expect(task.iterationsDefault).toBe(3)
    expect(task.demoComponentName).toBe('HorizonSuiteDemo')
    expect(task.checks).toEqual(CHECK_LIST.map((c) => c.checkName))
  })

  it('the sandbox contract is the first eight non-empty lines of the global constant plus the specified sentence', () => {
    const src = readFileSync(PROMPTS, 'utf8')
    const start = src.indexOf('EXECUTION ENVIRONMENT')
    const end = src.indexOf('LAYOUT', start)
    const eight = src.slice(start, end).split('\n').filter((l) => l.trim() !== '').slice(0, 8)
    expect(SANDBOX_HYGIENE).toBe(
      eight.join('\n') +
        '\nSet html,body{margin:0;min-height:100%} and default to a polished dark theme. Open the document with <html lang="en">. Every control must work; no placeholder text. Output only the HTML document.'
    )
    expect(task.sandboxConstraints).toBe('\n' + SANDBOX_HYGIENE)
  })

  it('the hidden version string is the one the run log records', () => {
    expect(H.HIDDEN_VERSION).toBe('kanban-keyboard-undo/v2')
  })
})

describe('hidden inputs stay out of the prompt and the gallery pose', () => {
  const forbidden: string[] = [
    ...H.KEY_TITLES,
    ...H.FOCUS_TITLES,
    ...H.HOSTILE_TITLES,
    ...H.OPAQUE_STEPS.flatMap((s) => ('title' in s && !FIRST_TITLES.includes(s.title) ? [s.title] : [])),
    ...H.PERSIST_TITLES,
    H.RECOVERED_TITLE,
    H.WIP_SPARE,
    H.SHORTCUT_TITLE,
    H.INPUT_DRAFT,
    H.UNBROKEN_TITLE,
    H.ADD_TITLES.messy,
    H.depthTitle(0),
    H.bulkTitle(0),
    'Refresh staging data',
    'Write changelog',
    'Ship the Q3 report',
    String(H.KEY_SEED),
    String(H.ROBUST_SEED),
  ]

  it('the prompt contains none of the hidden titles or seeds', () => {
    for (const value of forbidden) {
      expect(PROMPT.includes(value), `prompt contains hidden value ${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('the gallery pose contains none of the hidden seeds, check titles or the unbroken title', () => {
    for (const value of H.KEY_TITLES.concat(H.FOCUS_TITLES, [H.UNBROKEN_TITLE, H.WIP_SPARE, H.SHORTCUT_TITLE], [String(H.KEY_SEED), String(H.ROBUST_SEED)])) {
      expect(pose.includes(value), `pose contains hidden value ${JSON.stringify(value)}`).toBe(false)
    }
  })
})

describe('fixtures', () => {
  it('every broken variant differs from the good artifact', () => {
    for (const [name, html] of Object.entries(brokenArtifacts)) {
      expect(html, `${name} equals the good artifact`).not.toBe(goodArtifact)
    }
    expect(staticFake).not.toBe(goodArtifact)
  })

  it('every fixture has an expectation and every expectation names a real check', () => {
    const names = new Set(CHECK_LIST.map((c) => c.checkName))
    for (const f of allFixtures()) {
      expect(expectations[f.name], `${f.name} has no expectation`).toBeDefined()
    }
    for (const [fixture, expected] of Object.entries(expectations)) {
      if (expected === 'good') continue
      for (const n of expected) expect(names.has(n), `${fixture} names unknown check ${n}`).toBe(true)
    }
  })
})

fixtureMatrix({
  taskId: 'kanban-keyboard-undo',
  checks: CHECK_LIST,
  fixtures: allFixtures(),
  expectations,
  checksModule: { url: new URL('./checks.ts', import.meta.url).href, exportName: 'CHECK_LIST' },
})
