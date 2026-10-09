import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The mod's own tests run under `claude plugin test`, not here.
    exclude: ['plugins/**', 'node_modules/**', 'e2e/**'],
  },
})
