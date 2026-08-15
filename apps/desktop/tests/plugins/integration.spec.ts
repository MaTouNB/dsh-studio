/**
 * M3 integration test: install and remove fixture bundles in a temporary
 * desktop profile through the real PluginManager, against a local mock npm
 * registry and the staged dsh runtime. Asserts the operation state machine
 * (`queued → running → restart-required`), the profile manifest change that
 * is only observed after a restart, the install-scripts confirmation gate
 * (marker absent with `--ignore-scripts`, present after "Allow install
 * scripts"), and that a booted profile composes each installed bundle's
 * plugin only while it is installed.
 * @module @deepseek-ai/dsh-desktop/tests/plugins/integration
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitHubClient, type FetchLike } from '../../src/plugins/github.ts'
import { NpmClient } from '../../src/plugins/npm.ts'
import { OperationRegistry } from '../../src/plugins/operations.ts'
import { PluginManager } from '../../src/plugins/manager.ts'

/** The staged runtime directory (gitignored; built by the stage script). */
const STAGE = fileURLToPath(new URL('../../staging/mac-arm64/', import.meta.url))
const STAGE_READY = existsSync(join(STAGE, 'dsh-cli', 'lib', 'bin.js'))
  && existsSync(join(STAGE, 'node', 'bin', 'node'))
  && existsSync(join(STAGE, 'pnpm', 'bin', 'pnpm.cjs'))

const NODE_BIN = join(STAGE, 'node', 'bin', 'node')
const DSH_ENTRY = join(STAGE, 'dsh-cli', 'lib', 'bin.js')
const PNPM_ENTRY = join(STAGE, 'pnpm', 'bin', 'pnpm.cjs')

interface Fixture {
  name: string
  /** The env var whose file the composed plugin writes on boot. */
  composeEnv: string
  tarballName: string
  tarball: Buffer
  integrity: string
  packument: object
}

/** Build one installable npm package tarball (package/ layout) via system tar. */
function buildFixture(
  name: string,
  composeEnv: string,
  extra: { scripts?: Record<string, string>; files?: Record<string, string> },
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fix-'))
  const pkg = join(root, 'package')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  if (extra.files !== undefined) mkdirSync(join(pkg, 'scripts'), { recursive: true })
  const manifest = {
    name,
    version: '1.0.0',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js' },
    ...(extra.scripts === undefined ? {} : { scripts: extra.scripts }),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const rowId = name.replace(/[^a-z0-9-]/gu, '-')
  writeFileSync(join(pkg, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${rowId}`,
    `      name: '${name}'`,
    '',
  ].join('\n'))
  writeFileSync(join(pkg, 'lib', 'index.js'), [
    "import { writeFileSync } from 'node:fs'",
    'export default (ctx) => {',
    `  const target = process.env.${composeEnv}`,
    "  if (target !== undefined) writeFileSync(target, 'composed')",
    '}',
    '',
  ].join('\n'))
  for (const [path, content] of Object.entries(extra.files ?? {})) {
    writeFileSync(join(pkg, path), content)
  }
  const tarballName = `${name.replace('@', '').replace('/', '-')}-1.0.0.tgz`
  execFileSync('tar', ['-czf', tarballName, 'package'], { cwd: root })
  const tarball = readFileSync(join(root, tarballName))
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  return {
    name,
    composeEnv,
    tarballName,
    tarball,
    integrity,
    packument: {
      name,
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          ...manifest,
          dist: { tarball: `http://127.0.0.1:0/${tarballName}`, integrity },
        },
      },
    },
  }
}

/** Serve packuments and tarballs for the fixture packages. */
async function startRegistry(fixtures: Fixture[]): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    for (const fixture of fixtures) {
      if (path === `/${fixture.name}`) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(fixture.packument))
        return
      }
    }
    const match = fixtures.find(fixture => `/${fixture.tarballName}` === path)
    if (match !== undefined) {
      res.setHeader('content-type', 'application/octet-stream')
      res.end(match.tarball)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
    server.listen(0, '127.0.0.1')
  })
  return server
}

/** A scriptable fetch that routes to the local registry. */
function localFetch(registryBase: string): FetchLike {
  return async (url: string) => {
    const response = await fetch(url.replace(/^https:\/\/registry\.npmjs\.org/u, registryBase))
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name: string) => response.headers.get(name) },
      async json() { return response.json() as Promise<unknown> },
      async arrayBuffer() { return response.arrayBuffer() },
    }
  }
}

/** Boot the desktop profile once; reports which fixture compose markers appeared. */
function bootProfile(
  home: string,
  markers: Record<string, string>,
  timeoutMs = 120_000,
): Promise<{ ready: boolean; markers: Record<string, boolean>; log: string }> {
  return new Promise((resolve) => {
    const log: string[] = []
    let finished = false
    const finish = (ready: boolean, why: string): void => {
      if (finished) return
      finished = true
      clearInterval(probe)
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }, 2000).unref()
      const seen: Record<string, boolean> = {}
      for (const [envVar, path] of Object.entries(markers)) {
        void envVar
        seen[path] = existsSync(path)
      }
      resolve({ ready, markers: seen, log: [...log, `finish(${why})`].join('\n') })
    }
    const child: ChildProcess = spawn(NODE_BIN, [DSH_ENTRY, '--profile', 'desktop', '--port', '0'], {
      env: { ...process.env, DSH_HOME: home, ...markers },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk) => { log.push(String(chunk)) })
    child.stderr?.on('data', (chunk) => { log.push(String(chunk)) })
    const timer = setTimeout(() => { finish(false, 'timeout') }, timeoutMs)
    const probe = setInterval(() => {
      if (log.join('').includes('dsh web: http')) finish(true, 'ready')
    }, 500)
    child.on('exit', () => { finish(false, 'exited') })
  })
}

interface Manifest {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

let root: string
let home: string
let profileDir: string
let userDataDir: string
let registry: Server | undefined
let registryBase: string
let manager: PluginManager
let plain: Fixture
let scripted: Fixture
const savedEnv: Record<string, string | undefined> = {}
const envKeys = ['DSH_HOME', 'DSH_FIXTURE_MARKER_SCRIPTED']

describe.skipIf(!STAGE_READY)('M3 plugin install integration (staged runtime)', () => {
  beforeAll(async () => {
    for (const key of envKeys) savedEnv[key] = process.env[key]
    plain = buildFixture('@acme/plain', 'DSH_FIXTURE_COMPOSE_PLAIN', {})
    scripted = buildFixture('@acme/scripted', 'DSH_FIXTURE_COMPOSE_SCRIPTED', {
      scripts: { postinstall: 'node scripts/marker.js' },
      files: { 'scripts/marker.js': [
        "import { writeFileSync } from 'node:fs'",
        'const target = process.env.DSH_FIXTURE_MARKER_SCRIPTED',
        "if (target !== undefined) writeFileSync(target, 'ran')",
        '',
      ].join('\n') },
    })
    registry = await startRegistry([plain, scripted])
    const address = registry.address()
    if (address === null || typeof address === 'string') throw new Error('registry did not listen')
    registryBase = `http://127.0.0.1:${String(address.port)}`
    // Rewrite the packument tarball URLs with the real port.
    for (const fixture of [plain, scripted]) {
      const version = (fixture.packument as { versions: Record<string, { dist: { tarball: string } }> }).versions['1.0.0']
      if (version === undefined) throw new Error('fixture packument lacks 1.0.0')
      version.dist.tarball = `${registryBase}/${fixture.tarballName}`
    }
    root = mkdtempSync(join(tmpdir(), 'dsh-int-'))
    home = join(root, 'home')
    profileDir = join(home, 'profiles', 'desktop')
    userDataDir = join(root, 'user-data')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`)
    process.env.DSH_HOME = home
    process.env.DSH_FIXTURE_MARKER_SCRIPTED = join(root, 'marker-scripted.txt')
    manager = new PluginManager({
      github: new GitHubClient({ fetchFn: localFetch(registryBase), cacheDir: join(userDataDir, 'github-cache') }),
      npm: new NpmClient(localFetch(registryBase), registryBase),
      operations: new OperationRegistry(join(userDataDir, 'plugin-operations')),
      profileDir,
      dshEntry: DSH_ENTRY,
      nodeBin: NODE_BIN,
      pnpmEntry: PNPM_ENTRY,
      userDataDir,
      launcherTimeoutMs: 120_000,
      registry: registryBase,
      onOperation: () => {},
    })
  }, 60_000)

  afterAll(() => {
    registry?.close()
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = savedEnv[key]
    }
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  async function settle(op: { id: string; status: string }, timeoutMs = 60_000): Promise<void> {
    const terminal = new Set(['restart-required', 'succeeded', 'failed'])
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Immediate rejections (invalid requests) are not persisted.
      const current = manager.listOperations().find(candidate => candidate.id === op.id) ?? op
      if (terminal.has(current.status)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`operation ${op.id} did not settle`)
  }

  function manifest(): Manifest {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Manifest
  }

  it('installs without scripts: the manifest changes, but only a restart composes', async () => {
    const op = await manager.install({ packageName: '@acme/plain', version: '1.0.0', allowScripts: false })
    // The op may already be `running` by the time install() resolves.
    expect(['queued', 'running']).toContain(op.status)
    await settle(op)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    // The manifest gained the exact dependency and the reconciled bundle layer.
    const after = manifest()
    expect(after.dependencies['@acme/plain']).toBe('1.0.0')
    expect(after.dsh.profile.bundles).toContain('@acme/plain')
    expect(existsSync(join(profileDir, 'node_modules', '@acme', 'plain', 'cordis.patch.yml'))).toBe(true)
    // The plain package declares no scripts: nothing was allowed, no marker.
    expect(existsSync(process.env.DSH_FIXTURE_MARKER_SCRIPTED as string)).toBe(false)
  }, 120_000)

  it('refuses install scripts without confirmation', async () => {
    const op = await manager.install({ packageName: '@acme/scripted', version: '1.0.0', allowScripts: false })
    await settle(op)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('failed')
    expect(final?.code).toBe('scripts-not-confirmed')
    // Nothing was installed for the scripted package.
    expect(manifest().dependencies['@acme/scripted']).toBeUndefined()
    expect(existsSync(process.env.DSH_FIXTURE_MARKER_SCRIPTED as string)).toBe(false)
  }, 120_000)

  it('installs with the confirmed allow-scripts path and runs the postinstall', async () => {
    const op = await manager.install({ packageName: '@acme/scripted', version: '1.0.0', allowScripts: true })
    await settle(op)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    expect(manifest().dependencies['@acme/scripted']).toBe('1.0.0')
    expect(manifest().dsh.profile.bundles).toContain('@acme/scripted')
    // The profile's pnpm-workspace.yaml allowlists the package, and the
    // postinstall ran.
    const workspace = existsSync(join(profileDir, 'pnpm-workspace.yaml'))
      ? readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
      : ''
    expect(workspace).toContain('"@acme/scripted": true')
    expect(readFileSync(process.env.DSH_FIXTURE_MARKER_SCRIPTED as string, 'utf8')).toBe('ran')
  }, 120_000)

  it('composes the installed bundles into a booted profile (restart observation)', async () => {
    const plainMarker = join(root, 'compose-plain.txt')
    const scriptedMarker = join(root, 'compose-scripted.txt')
    const markers = {
      [plain.composeEnv]: plainMarker,
      [scripted.composeEnv]: scriptedMarker,
    }
    for (const path of Object.values(markers)) rmSync(path, { force: true })
    const boot = await bootProfile(home, markers)
    expect(boot.ready).toBe(true)
    expect(boot.markers[plainMarker]).toBe(true)
    expect(boot.markers[scriptedMarker]).toBe(true)
    expect(readFileSync(scriptedMarker, 'utf8')).toBe('composed')
  }, 180_000)

  it('removes a dependency and stops composing it after the next restart', async () => {
    const op = await manager.remove({ packageName: '@acme/scripted' })
    await settle(op)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    const after = manifest()
    expect(after.dependencies['@acme/scripted']).toBeUndefined()
    expect(after.dsh.profile.bundles).not.toContain('@acme/scripted')
    // The second boot still composes the remaining bundle, but not the removed one.
    const plainMarker = join(root, 'compose2-plain.txt')
    const scriptedMarker = join(root, 'compose2-scripted.txt')
    const markers = {
      [plain.composeEnv]: plainMarker,
      [scripted.composeEnv]: scriptedMarker,
    }
    for (const path of Object.values(markers)) rmSync(path, { force: true })
    const boot = await bootProfile(home, markers)
    expect(boot.ready).toBe(true)
    expect(boot.markers[plainMarker]).toBe(true)
    expect(boot.markers[scriptedMarker]).toBe(false)
  }, 180_000)
})
