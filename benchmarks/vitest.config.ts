import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const METHODOLOGY = 'lib/lab/llm-benchmark/methodology.test.ts'

export default defineConfig({
  // Mirror the tsconfig `@/*` path alias so tests can import via `@/...`.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // Pure-logic and fs-based tests; no DOM needed (see the source repo's
    // vitest.config.ts for why jsdom is avoided under vitest 4).
    environment: 'node',
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['lib/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['node_modules', METHODOLOGY],
        },
      },
      {
        extends: true,
        test: {
          name: 'methodology',
          include: [METHODOLOGY],
          // methodology.test.ts has a `the real content tree` block that reads
          // content/blog/*/index.mdx from process.cwd(). Those posts live only in
          // benebsworth.com, so that block fails with ENOENT here (it passes in the
          // source repo). Only those tests are filtered out by name. The other 22
          // in the file run, instead of excluding the whole file.
          testNamePattern: /^(?!.*the real content tree)/,
        },
      },
    ],
  },
})
