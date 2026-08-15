import { defineConfig } from 'tsdown'

/**
 * The Electron main bundle: one ESM entry with `electron` never bundled and
 * `fflate` (diagnostic zip) bundled into the shell. Declarations come from
 * `tsc -b` (dts: false).
 */
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
    bundle: ['fflate'],
  },
})
