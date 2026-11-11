import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { BenchmarkCategory, BenchmarkModel, BenchmarkResult, BenchmarkTask } from '../llm-benchmark/types'
import * as registry from '../llm-benchmark/registry'
import { buildBoard, type Board } from './board'

// The public board: the page at token-horizon.dev/benchmarks/. It drops the earlier runs (scorer version 1), the smoke
// tier while it has no version 2 data, and the harness commands. These tests read the real results and registry.

const here = fileURLToPath(new URL('.', import.meta.url))
const benchRoot = resolve(here, '..', '..', '..')
const resultsPath = resolve(benchRoot, 'lib/lab/llm-benchmark/results.json')
const NOW = '2026-11-11T12:00:00.000Z'

function realResults(): BenchmarkResult[] {
  return JSON.parse(readFileSync(resultsPath, 'utf8')) as BenchmarkResult[]
}

function buildFor(target: 'private' | 'public'): Board {
  return buildBoard({
    results: realResults(),
    models: registry.BENCHMARK_MODELS as BenchmarkModel[],
    tasks: registry.BENCHMARK_TASKS as BenchmarkTask[],
    categories: registry.BENCHMARK_CATEGORIES as BenchmarkCategory[],
    signals: null,
    now: NOW,
    target,
    resultsSha256: 'public-test',
  })
}

/** Phrases the public page must not carry: the unpublished harness, the earlier runs, and the smoke tier. */
const FORBIDDEN_ON_PUBLIC = ['not public', 'Earlier runs', 'scorer v1', 'scorer version 1', 'plugin id', 'Smoke tier']
/** Command fragments of the harness. None may appear in the public board or page. */
const HARNESS_COMMANDS = ['npx tsx', 'scripts/', 'rescore-behavioral', 'run-benchmark', 'capture.mjs', 'capture-isolation', 'dist-check', 'task verify']

describe('public board: the earlier runs, the smoke tier without version 2 data, and the harness are not on the page', () => {
  const board = buildFor('public')
  const json = JSON.stringify(board)

  it('is marked as the public target and carries no earlier scope', () => {
    expect(board.source.target).toBe('public')
    expect(board.scopes).toEqual(['headline', 'horizon'])
    expect(Object.keys(board.scopeTasks)).not.toContain('earlier')
    expect(Object.keys(board.insights)).not.toContain('earlier')
    expect(Object.keys(board.effort)).not.toContain('earlier')
    expect(Object.keys(board.guides)).not.toContain('earlier')
    expect(Object.keys(board.glance)).not.toContain('earlier')
    expect(board.summaries.some((s) => s.scope === 'earlier')).toBe(false)
  })

  it('has no version 1 cell, and counts version 2 records only', () => {
    expect(board.cells.length).toBeGreaterThan(0)
    expect(board.cells.every((c) => c.scorerVersion >= 2)).toBe(true)
    expect(Object.keys(board.source.scorerVersions)).toEqual(['2'])
    expect(board.stoppedNotRun.every((n) => n.scorerVersion >= 2)).toBe(true)
  })

  it('names no model that appears only in the earlier runs, and no smoke task', () => {
    const cellModels = new Set(board.cells.map((c) => c.modelId))
    expect(board.models.every((m) => cellModels.has(m.id))).toBe(true)
    expect(board.tasks.some((t) => t.suite === 'smoke')).toBe(false)
    expect(board.suites.map((s) => s.id)).not.toContain('smoke')
  })

  it('has no reproduce commands and no "not public" sentence in the data', () => {
    for (const cmd of HARNESS_COMMANDS) expect(json).not.toContain(cmd)
    expect(json).not.toContain('Reproduce')
    for (const phrase of FORBIDDEN_ON_PUBLIC) expect(json).not.toContain(phrase)
  })

  it('states the held-back task once, by its title, without the earlier wording', () => {
    expect(board.heldBack.map((h) => h.sentence)).toEqual([
      'One task (Seat Pricing Calculator) is not reported: one of its checks is still being validated.',
    ])
    expect(board.suites.every((s) => !/not reported/.test(s.note))).toBe(true)
  })
})

describe('public build: every gallery image the board references is in the public output folder', () => {
  let out = ''
  let board: Board
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'th-public-build-'))
    // The real build, run into a temporary folder: data, page, script and the referenced gallery images.
    execFileSync('npx', ['tsx', 'report/build.mjs', '--target', 'public', '--out', out, '--now', NOW], {
      cwd: benchRoot,
      stdio: 'pipe',
      timeout: 300_000,
    })
    board = JSON.parse(readFileSync(join(out, 'data', 'board.json'), 'utf8'))
  }, 300_000)
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true })
  })

  it('references gallery images that all exist in the public output folder', () => {
    const shots = [...new Set(board.cells.flatMap((c) => c.shots))]
    expect(shots.length).toBeGreaterThan(0)
    const missing = shots.filter((s) => !existsSync(join(out, s.replace(/^dist\//, ''))))
    expect(missing).toEqual([])
  })

  it('ships no fonts, no harness command and no unfilled template marker', () => {
    expect(existsSync(join(out, 'fonts'))).toBe(false)
    const page = readFileSync(join(out, 'index.html'), 'utf8')
    const script = readFileSync(join(out, 'report.js'), 'utf8')
    expect(page).not.toContain('__TARGET__')
    expect(page).not.toMatch(/<!--\/?@(public|private)-->/)
    expect(page).toContain('<link rel="canonical" href="https://token-horizon.dev/benchmarks/">')
    expect(page).toContain('href="/">Token Horizon</a>')
    expect(page).not.toContain('Reproduce a result')
    expect(page).not.toContain('id="reproduce"')
    expect(readFileSync(join(out, 'report.css'), 'utf8')).toContain('url("/fonts/HubotSansVF-Regular.ttf")')
    for (const cmd of HARNESS_COMMANDS) {
      expect(script).not.toContain(cmd)
      expect(page).not.toContain(cmd)
    }
  })
})

describe('private build: the owner keeps every scope, the reproduce commands and the fonts', () => {
  it('keeps the earlier runs scope and the smoke scope when it has data', () => {
    const board = buildFor('private')
    expect(board.source.target).toBe('private')
    expect(board.scopes).toEqual(['headline', 'horizon', 'smoke', 'earlier'])
  })
})
