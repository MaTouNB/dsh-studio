import { defineConfig } from 'tsdown'

/**
 * The sandboxed preload bundle: one CJS file (`lib/preload.cjs`) with
 * `electron` never bundled. Sandboxed preloads cannot be ESM and cannot
 * import other modules, so everything the bridge needs is inlined here.
 */
export default defineConfig({
  entry: ['src/preload.ts'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
  },
})
