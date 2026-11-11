/**
 * The two-check toy suite the fixture-matrix self-test scores through the tsx loader
 * in a child process. Kept in its own module so the child can import it by URL.
 */
import { defineCheck } from './check'
import { probe } from './probe'

export const toyA = defineCheck('toy-a', 4, 'the first marker element exists', async (ctx) => ({
  passed: await probe<boolean>(ctx.page, '() => document.querySelector("#a") !== null', undefined, 1000),
}))

export const toyB = defineCheck('toy-b', 6, 'the second marker element reads ok', async (ctx) => ({
  passed: await probe<boolean>(
    ctx.page,
    '() => { const el = document.querySelector("#b"); return !!el && el.textContent === "ok"; }',
    undefined,
    1000
  ),
}))

export const toyChecks = [toyA, toyB]
