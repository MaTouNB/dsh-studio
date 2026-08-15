/**
 * Diagnostic export: one zip with the runtime manifest, the redacted logs,
 * platform facts, the desktop profile's package names and versions, and the
 * effective Desktop configuration. Exclusions are structural — the export
 * never reads credential files, environment values, session logs, prompts,
 * or workspace contents.
 * @module @deepseek-ai/dsh-desktop/diagnostics
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { RuntimeState } from './supervisor.ts'

/** One named entry of the export archive. */
export interface DiagnosticEntry {
  /** Archive-relative path. */
  name: string
  /** UTF-8 content. */
  text: string
}

/** Facts the export collects. */
export interface DiagnosticFacts {
  appVersion: string
  harnessVersion: string
  platform: string
  arch: string
  release: string
  state: RuntimeState
  logDir: string
  profileDir: string
  runtimeManifest: unknown
  profilePackages: Array<{ name: string; version: string }>
}

/** Package names and versions of the desktop profile's own dependencies. */
export function profilePackages(profileDir: string): Array<{ name: string; version: string }> {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  const names = Object.keys(manifest.dependencies ?? {}).sort()
  const packages: Array<{ name: string; version: string }> = []
  for (const name of names) {
    const nodeModulesPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(nodeModulesPath)) continue
    const nodeManifest = JSON.parse(readFileSync(nodeModulesPath, 'utf8')) as { version?: string }
    packages.push({ name, version: nodeManifest.version ?? 'unknown' })
  }
  return packages
}

/**
 * Assemble the export entries from facts and the retained log text.
 * @param facts - collected facts.
 * @param logs - the redacted log text.
 * @returns the archive entries.
 */
export function diagnosticEntries(facts: DiagnosticFacts, logs: string): DiagnosticEntry[] {
  return [
    {
      name: 'runtime-manifest.json',
      text: `${JSON.stringify(facts.runtimeManifest, null, 2)}\n`,
    },
    {
      name: 'logs.txt',
      text: logs,
    },
    {
      name: 'platform.json',
      text: `${JSON.stringify({
        platform: facts.platform,
        arch: facts.arch,
        release: facts.release,
      }, null, 2)}\n`,
    },
    {
      name: 'profile-packages.json',
      text: `${JSON.stringify(facts.profilePackages, null, 2)}\n`,
    },
    {
      name: 'effective-config.json',
      text: `${JSON.stringify({
        appVersion: facts.appVersion,
        harnessVersion: facts.harnessVersion,
        state: facts.state,
        logDir: facts.logDir,
        profileDir: facts.profileDir,
      }, null, 2)}\n`,
    },
  ]
}

/**
 * Write the diagnostic zip to `target`.
 * @param target - absolute destination path.
 * @param entries - the archive entries.
 */
export function writeDiagnosticZip(target: string, entries: readonly DiagnosticEntry[]): void {
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.name] = strToU8(entry.text)
  writeFileSync(target, zipSync(files))
}
