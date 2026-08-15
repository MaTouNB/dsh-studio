import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowBuildsFor,
  dshPluginArgv,
  ensurePnpmShim,
  ensureProfileNpmrc,
  exactSpec,
  installPnpmArgs,
  isProfileDirectDependency,
  pluginChildEnv,
  removePnpmArgs,
  runLauncher,
} from '../../src/plugins/installer.ts'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inst-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('installer argv', () => {
  it('builds an exact-spec install argv with the isolated store', () => {
    expect(exactSpec('@acme/fixture', '1.2.3')).toBe('@acme/fixture@1.2.3')
    const args = installPnpmArgs('@acme/fixture', '1.2.3', '/store', { allowScripts: false })
    expect(args).toEqual(['add', '@acme/fixture@1.2.3', '--store-dir', '/store', '--ignore-scripts'])
    expect(args).not.toContain('&&')
    expect(args).not.toContain(';')
    expect(args).not.toContain('$( ')
  })

  it('drops --ignore-scripts only when scripts are explicitly allowed', () => {
    const args = installPnpmArgs('@acme/fixture', '1.2.3', '/store', { allowScripts: true })
    expect(args).toEqual(['add', '@acme/fixture@1.2.3', '--store-dir', '/store'])
  })

  it('appends the registry override as a separate literal element', () => {
    const args = installPnpmArgs('@acme/fixture', '1.2.3', '/store', {
      allowScripts: false,
      registry: 'http://127.0.0.1:4873',
    })
    expect(args).toEqual([
      'add', '@acme/fixture@1.2.3', '--store-dir', '/store', '--ignore-scripts', '--registry', 'http://127.0.0.1:4873',
    ])
  })

  it('builds removal argv and the launcher prefix without shell interpolation', () => {
    expect(removePnpmArgs('@acme/fixture', '/store')).toEqual(['remove', '@acme/fixture', '--store-dir', '/store'])
    expect(dshPluginArgv('/dsh/lib/bin.js', ['add', 'x@1.0.0'])).toEqual([
      '/dsh/lib/bin.js', 'plugin', '--profile', 'desktop', 'add', 'x@1.0.0',
    ])
  })

  it('appends allowBuilds entries idempotently', () => {
    const dir = tmpDir()
    allowBuildsFor(dir, '@acme/fixture')
    const once = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(once).toContain('allowBuilds:\n  "@acme/fixture": true\n')
    allowBuildsFor(dir, '@acme/fixture')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(once)
    allowBuildsFor(dir, '@acme/other')
    const twice = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(twice).toContain('"@acme/other": true')
    expect(twice.match(/allowBuilds:/gu)).toHaveLength(1)
  })

  it('writes the profile .npmrc registry override idempotently', () => {
    const dir = tmpDir()
    ensureProfileNpmrc(dir, 'http://127.0.0.1:4873')
    const once = readFileSync(join(dir, '.npmrc'), 'utf8')
    expect(once).toBe('registry=http://127.0.0.1:4873\n')
    ensureProfileNpmrc(dir, 'http://127.0.0.1:4873')
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe(once)
    // No override: the profile is left untouched.
    expect(existsSync(join(tmpDir(), '.npmrc'))).toBe(false)
  })

  it('creates the executable pnpm shim pointing at the staged entry', () => {
    const dir = tmpDir()
    ensurePnpmShim(join(dir, 'bin'), '/runtime/pnpm/bin/pnpm.cjs')
    const shim = readFileSync(join(dir, 'bin', 'pnpm'), 'utf8')
    expect(shim).toBe('#!/usr/bin/env node\nrequire("/runtime/pnpm/bin/pnpm.cjs")\n')
    // Idempotent: recreating with the same entry keeps the file byte-identical.
    ensurePnpmShim(join(dir, 'bin'), '/runtime/pnpm/bin/pnpm.cjs')
    expect(readFileSync(join(dir, 'bin', 'pnpm'), 'utf8')).toBe(shim)
  })

  it('prepends pinned tooling directories to the child PATH', () => {
    const env = pluginChildEnv({ PATH: '/usr/bin:/bin' }, ['/shim', '/node/bin'])
    expect(env.PATH).toBe('/shim:/node/bin:/usr/bin:/bin')
    const empty = pluginChildEnv({}, ['/shim'])
    expect(empty.PATH).toBe('/shim')
  })

  it('detects profile direct dependencies from the manifest', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@acme/fixture': '1.0.0', '@deepseek-ai/dsh-desktop-integration': '0.0.0' },
    }), 'utf8')
    expect(isProfileDirectDependency(dir, '@acme/fixture')).toBe(true)
    expect(isProfileDirectDependency(dir, '@acme/absent')).toBe(false)
    expect(isProfileDirectDependency(join(dir, 'missing'), '@acme/fixture')).toBe(false)
  })

  it('runs the launcher with exact argv and reports the exit code', async () => {
    const nodeBin = process.execPath
    const script = tmpDir()
    const probe = join(script, 'probe.js')
    writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    const result = await runLauncher(nodeBin, [probe, 'a b', 'c;d', '$HOME'], {
      cwd: script,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['a b', 'c;d', '$HOME'])
    // A missing binary resolves to the launcher failure exit code.
    const missing = await runLauncher(join(script, 'no-such-node'), [probe], {
      cwd: script,
      env: {},
      timeoutMs: 1000,
    })
    expect(missing.exitCode).toBe(127)
  })
})
