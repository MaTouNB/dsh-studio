import { defineConfig } from 'vitest/config'

/**
 * Desktop-scoped vitest project: the root configuration already discovers
 * tests under `apps/*`, but a script run from this workspace needs a config
 * whose include stays inside `apps/desktop`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
