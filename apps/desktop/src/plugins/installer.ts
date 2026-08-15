/**
 * The profile plugin installer: runs the packaged dsh launcher's `plugin`
 * command with exact argv arrays (never a shell), the pinned pnpm runtime
 * via a PATH shim, and an isolated store under the DSH Studio user data
 * directory. Scripts are disabled by default (`--ignore-scripts`); the
 * confirmed "Allow install scripts" path adds the package to the profile's
 * `allowBuilds` before installing without the flag. Removal only touches
 * desktop-profile-owned third-party direct dependencies.
 * @module @deepseek-ai/dsh-desktop/plugins/installer
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The isolated pnpm store directory name under user data. */
export const PNPM_STORE_DIR = 'pnpm-store'

/** The pnpm PATH-shim directory name under user data. */
export const PNPM_SHIM_DIR = 'bin'

/** The exact-version spec for an install. */
export function exactSpec(packageName: string, version: string): string {
  return `${packageName}@${version}`
}

/** Whether the profile manifest names the package as its own direct dependency. */
export function isProfileDirectDependency(profileDir: string, packageName: string): boolean {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies?.[packageName] !== undefined
}

/**
 * The complete argv for one `dsh plugin` invocation. Every element is either
 * a fixed literal or a validated value; renderer input never reaches the
 * array unvalidated.
 * @param args - the validated pnpm arguments.
 * @returns the argv for `dsh plugin --profile desktop <args>`.
 */
export function dshPluginArgv(dshEntry: string, args: readonly string[]): string[] {
  return [dshEntry, 'plugin', '--profile', 'desktop', ...args]
}

/** The pnpm arguments for one install. */
export function installPnpmArgs(
  packageName: string,
  version: string,
  storeDir: string,
  options: { allowScripts: boolean; registry?: string },
): string[] {
  const args = [
    'add',
    exactSpec(packageName, version),
    '--store-dir',
    storeDir,
    ...(options.allowScripts ? [] : ['--ignore-scripts']),
  ]
  return options.registry === undefined ? args : [...args, '--registry', options.registry]
}

/**
 * The pnpm arguments for one removal. The registry override is not a
 * `remove`-accepted flag (unlike `add`), so it travels through the child
 * environment's `npm_config_registry` instead.
 * @param packageName - the installed package to remove.
 * @param storeDir - the isolated store directory.
 */
export function removePnpmArgs(packageName: string, storeDir: string): string[] {
  return ['remove', packageName, '--store-dir', storeDir]
}

/**
 * Append an `allowBuilds` entry for the package to the profile's
 * pnpm-workspace.yaml, creating the file from the shipped template when
 * absent. This is what lets the confirmed install actually run the
 * package's lifecycle scripts under pnpm's strict build policy. Existing
 * `allowBuilds:` blocks are extended in place (never duplicated).
 * @param profileDir - the profile directory.
 * @param packageName - the package to allow.
 */
export function allowBuildsFor(profileDir: string, packageName: string): void {
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const existing = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  const entry = `  ${JSON.stringify(packageName)}: true`
  if (existing.includes(entry)) return
  const allowLine = existing.match(/^allowBuilds:\s*$/mu)
  if (allowLine === null) {
    const block = `allowBuilds:\n${entry}\n`
    const prefix = existing.trim() === '' ? '' : `${existing.replace(/\s*$/u, '')}\n`
    writeFileSync(workspacePath, `${prefix}${block}`)
    return
  }
  const index = allowLine.index ?? 0
  const afterLine = index + allowLine[0].length
  writeFileSync(workspacePath, `${existing.slice(0, afterLine)}\n${entry}${existing.slice(afterLine)}`)
}

/**
 * Ensure the profile's `.npmrc` carries the registry override. pnpm accepts
 * `--registry` on `add` but rejects it on `remove`, so the override travels
 * through the project npmrc instead, where both commands honor it. Without
 * an override the profile is never touched (the packaged app uses the
 * default registry).
 * @param profileDir - the profile directory.
 * @param registry - the npm registry override, when configured.
 */
export function ensureProfileNpmrc(profileDir: string, registry?: string): void {
  if (registry === undefined) return
  const npmrcPath = join(profileDir, '.npmrc')
  const line = `registry=${registry}\n`
  if (existsSync(npmrcPath) && readFileSync(npmrcPath, 'utf8').includes(line)) return
  const existing = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf8') : ''
  const prefix = existing.trim() === '' ? '' : `${existing.replace(/\s*$/u, '')}\n`
  writeFileSync(npmrcPath, `${prefix}${line}`)
}

/**
 * Create the `pnpm` PATH shim that runs the pinned pnpm under the bundled
 * node: a `#!/usr/bin/env node` script requiring the staged pnpm entry. The
 * child's PATH (prepended with the bundled node bin) resolves both.
 * @param shimDir - the shim directory under user data.
 * @param pnpmEntry - the absolute path of the staged pnpm `bin/pnpm.cjs`.
 */
export function ensurePnpmShim(shimDir: string, pnpmEntry: string): void {
  const shim = join(shimDir, 'pnpm')
  const content = `#!/usr/bin/env node\nrequire(${JSON.stringify(pnpmEntry)})\n`
  if (existsSync(shim) && readFileSync(shim, 'utf8') === content) return
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(shim, content)
  chmodSync(shim, 0o755)
}

/** The child environment with the pinned tooling on PATH. */
export function pluginChildEnv(baseEnv: NodeJS.ProcessEnv, prependPath: readonly string[]): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = baseEnv[pathKey] ?? baseEnv.PATH ?? ''
  return {
    ...baseEnv,
    PATH: [...prependPath, ...(existing === '' ? [] : [existing])].join(process.platform === 'win32' ? ';' : ':'),
  }
}

/** The result of one launcher invocation. */
export interface LauncherResult {
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Run one `dsh plugin` invocation with exact argv. */
export function runLauncher(
  nodeBin: string,
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<LauncherResult> {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [...argv], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    } satisfies SpawnOptions)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', () => {
      resolve({ exitCode: 127, signal: null, stdout, stderr })
    })
    child.on('exit', (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr })
    })
  })
}
