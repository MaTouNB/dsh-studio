/**
 * Windows installed-artifact smoke: silent-install the NSIS installer into a
 * scratch directory, verify the installed payload (the Electron shell, the
 * staged runtime with the dsh CLI, node, pnpm, and the runtime manifest), and
 * uninstall cleanly. Runs on the native Windows lane (the windows-2025
 * workflow job); the packaged-app auth smoke remains macOS-only.
 * @module @deepseek-ai/dsh-desktop/smoke-installed-win
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

function fail(message: string): never {
  process.stderr.write(`smoke-installed-win: ${message}\n`)
  process.exit(1)
}

/** The NSIS installer under dist/, e.g. `DSH Studio-0.1.0-alpha.1-win-x64.exe`. */
function findInstaller(): string {
  const dist = join(APP_DIR, 'dist')
  if (!existsSync(dist)) fail('dist directory missing — run package:win first')
  const candidates = readdirSync(dist).filter(name => /^DSH Studio-.*-win-x64\.exe$/u.test(name))
  if (candidates.length !== 1) fail(`expected exactly one win-x64 installer under dist, found ${String(candidates.length)}`)
  return join(dist, candidates[0] as string)
}

function runSync(command: string, args: readonly string[]): void {
  // Windows resolves .exe paths directly through CreateProcess (no shell), so
  // the NSIS /D= switch survives verbatim.
  const result = spawnSync(command, [...args], { stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.error?.message ?? String(result.status)})`)
  }
}

/** The staged-runtime components an installed app must ship. */
const REQUIRED_PATHS = [
  'DSH Studio.exe',
  join('resources', 'app.asar'),
  join('resources', 'runtime', 'dsh-cli', 'lib', 'bin.js'),
  join('resources', 'runtime', 'node', 'bin', 'node.exe'),
  join('resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'),
  join('resources', 'runtime', 'runtime-manifest.json'),
]

function main(): void {
  const installer = findInstaller()
  const target = mkdtempSync(join(tmpdir(), 'dsh-installed-'))
  try {
    // NSIS silent install; /D must be the last argument and unquoted.
    runSync(installer, ['/S', `/D=${target}`])
    for (const relative of REQUIRED_PATHS) {
      if (!existsSync(join(target, relative))) fail(`installed payload missing ${relative}`)
    }
    const manifest = JSON.parse(readFileSync(join(target, 'resources', 'runtime', 'runtime-manifest.json'), 'utf8')) as {
      app?: { version?: string }
      platform?: string
    }
    if (manifest.app?.version === undefined) fail('runtime manifest lacks app.version')
    if (manifest.platform !== 'win-x64') fail(`runtime manifest platform ${String(manifest.platform)} is not win-x64`)
    process.stdout.write(`smoke-installed-win: installed ${installer} with runtime manifest v${manifest.app.version} (${manifest.platform})\n`)

    const uninstaller = readdirSync(target).find(name => /^Uninstall /u.test(name))
    if (uninstaller === undefined) fail('installed tree lacks the NSIS uninstaller')
    runSync(join(target, uninstaller), ['/S'])
    if (existsSync(target)) fail('uninstall left files behind')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
  process.stdout.write('smoke-installed-win: ok\n')
}

main()
