#!/usr/bin/env node
/**
 * Write `dist/SHA256SUMS.txt` over every packaging artifact, sorted by file
 * name for reproducibility. The sidecar accompanies each release alongside
 * `runtime-manifest.json`.
 * @module @deepseek-ai/dsh-desktop/write-checksums
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(APP_DIR, 'dist')

function main(): void {
  if (!existsSync(DIST_DIR)) throw new Error(`no dist directory at ${DIST_DIR}; run package:mac or package:win first`)
  const rows = readdirSync(DIST_DIR)
    .filter((name) => {
      if (name === 'SHA256SUMS.txt' || name.endsWith('.blockmap') || name === 'builder-debug.yml') return false
      return lstatSync(join(DIST_DIR, name)).isFile()
    })
    .sort()
    .map(name => `${createHash('sha256').update(readFileSync(join(DIST_DIR, name))).digest('hex')}  ${name}`)
  writeFileSync(join(DIST_DIR, 'SHA256SUMS.txt'), `${rows.join('\n')}\n`)
  process.stdout.write(`write-checksums: ${String(rows.length)} artifact(s) recorded in dist/SHA256SUMS.txt\n`)
}

main()
