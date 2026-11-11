/**
 * Browser-gated self-test for fixtureMatrix, on a two-check toy suite. It proves the
 * matrix's pass path against the real runChecks: a good page earns the full total,
 * a page that breaks exactly one check fails exactly that check, and a static page
 * scores zero against the full denominator. The tsx path (checksModule) scores the
 * good page in a child process through the tsx loader. The failure path prints the
 * matrix and is exercised by every task's own suite.
 */
import { fixtureMatrix } from './fixture-matrix'
import { toyChecks } from './fixture-matrix.toy-checks'

fixtureMatrix({
  taskId: 'toy-suite',
  checks: toyChecks,
  totalPoints: 10,
  checksModule: { url: new URL('./fixture-matrix.toy-checks.ts', import.meta.url).href, exportName: 'toyChecks' },
  fixtures: [
    { name: 'good', html: '<div id="a"></div><div id="b">ok</div>' },
    { name: 'broken-b', html: '<div id="a"></div><div id="b">no</div>' },
    { name: 'static', html: '<p>nothing here</p>' },
  ],
  expectations: {
    good: 'good',
    'broken-b': ['toy-b'],
    static: 'static',
  },
})
