import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../src/plugins/github.ts'
import { GitHubClient } from '../../src/plugins/github.ts'
import { NpmClient } from '../../src/plugins/npm.ts'
import { OperationRegistry } from '../../src/plugins/operations.ts'
import { DESKTOP_PROFILE_BUNDLES } from '../../src/profile.ts'
import { PluginManager, candidateFrom } from '../../src/plugins/manager.ts'

// Mock the launcher so manager flows never spawn a real dsh process.
vi.mock('../../src/plugins/installer.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/plugins/installer.ts')>()
  return { ...mod, runLauncher: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })) }
})

import { runLauncher } from '../../src/plugins/installer.ts'
const mockRunLauncher = vi.mocked(runLauncher)

/** Minimal ustar gzip tarball with a root package.json. */
function makeTarGz(manifest: object): Buffer {
  const content = Buffer.from(JSON.stringify(manifest), 'utf8')
  const header = Buffer.alloc(512)
  Buffer.from('package/package.json', 'utf8').copy(header, 0)
  Buffer.from(content.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124)
  Buffer.from('0000777\0', 'ascii').copy(header, 100)
  Buffer.from('0000000\0', 'ascii').copy(header, 108)
  Buffer.from('0000000\0', 'ascii').copy(header, 116)
  Buffer.from('00000000000\0', 'ascii').copy(header, 136)
  header[156] = 0x30
  Buffer.from('        ', 'ascii').copy(header, 148)
  let sum = 0
  for (const byte of header) sum += byte
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148)
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(body)
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]))
}

const TARBALL_WITH_SCRIPTS = makeTarGz({
  name: '@acme/fixture',
  version: '1.0.0',
  scripts: { postinstall: 'node marker.js' },
})
const TARBALL_PLAIN = makeTarGz({ name: '@acme/fixture', version: '1.0.0' })

const PACKUMENT_URL = 'https://registry.npmjs.org/%40acme%2Ffixture'
const TARBALL_URL = 'https://registry.npmjs.org/@acme/fixture/-/fixture-1.0.0.tgz'
const COMMIT = 'a'.repeat(40)

/** Route-based fetch: exact URL → canned response. */
function routeFetch(routes: Record<string, () => { status?: number; body?: unknown; tarball?: Buffer }>): FetchLike {
  const fetchFn: FetchLike = async (url) => {
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    const entry = route()
    const tarball = entry.tarball
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      headers: { get: () => null },
      async json() { return entry.body },
      async arrayBuffer() {
        if (tarball === undefined) return new ArrayBuffer(0)
        return tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) as ArrayBuffer
      },
    }
  }
  return fetchFn
}

/** GitHub routes for a valid candidate repo. */
function githubRoutes(): Record<string, () => { status?: number; body?: unknown }> {
  return {
    'https://api.github.com/repos/acme/fixture': () => ({
      body: { archived: false, default_branch: 'main' },
    }),
    'https://api.github.com/repos/acme/fixture/git/ref/heads/main': () => ({
      body: { object: { sha: COMMIT, type: 'commit' } },
    }),
    ['https://api.github.com/repos/acme/fixture/contents/package.json?ref=' + COMMIT]: () => ({
      body: {
        type: 'file',
        content: Buffer.from(JSON.stringify({
          name: '@acme/fixture',
          license: 'MIT',
          main: 'lib/index.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        })).toString('base64'),
      },
    }),
    ['https://api.github.com/repos/acme/fixture/contents/lib/index.js?ref=' + COMMIT]: () => ({
      body: { type: 'file', content: Buffer.from('export default {}').toString('base64') },
    }),
  }
}

/** npm routes; `plain` serves a tarball without lifecycle scripts. */
function npmRoutes(plain = false): Record<string, () => { status?: number; body?: unknown; tarball?: Buffer }> {
  return {
    [PACKUMENT_URL]: () => ({
      body: {
        time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        versions: {
          '1.0.0': {
            dist: { integrity: 'sha512-abc', tarball: TARBALL_URL },
            repository: { url: 'https://github.com/acme/fixture' },
          },
        },
      },
    }),
    [TARBALL_URL]: () => ({ tarball: plain ? TARBALL_PLAIN : TARBALL_WITH_SCRIPTS }),
  }
}

interface Harness {
  root: string
  profileDir: string
  manager: PluginManager
  onOperation: ReturnType<typeof vi.fn>
}

function harness(overrides: { plainTarball?: boolean; profileDeps?: Record<string, string> } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mgr-'))
  const profileDir = join(root, 'profiles', 'desktop')
  const userDataDir = join(root, 'user-data')
  const onOperation = vi.fn()
  const github = new GitHubClient({ fetchFn: routeFetch(githubRoutes()), cacheDir: join(root, 'cache') })
  const npm = new NpmClient(routeFetch(npmRoutes(overrides.plainTarball)))
  const operations = new OperationRegistry(join(userDataDir, 'plugin-operations'))
  const manager = new PluginManager({
    github,
    npm,
    operations,
    profileDir,
    dshEntry: join(root, 'dsh', 'lib', 'bin.js'),
    nodeBin: process.execPath,
    pnpmEntry: join(root, 'pnpm', 'bin', 'pnpm.cjs'),
    userDataDir,
    launcherTimeoutMs: 5000,
    registry: 'http://127.0.0.1:4873',
    onOperation,
  })
  mkdirSync(profileDir, { recursive: true })
  if (overrides.profileDeps !== undefined) {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: overrides.profileDeps }), 'utf8')
  }
  return { root, profileDir, manager, onOperation }
}

/** Wait for one operation to reach a terminal status. */
async function settled(manager: PluginManager, id: string, timeoutMs = 3000): Promise<void> {
  const terminal = new Set(['restart-required', 'succeeded', 'failed'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const op = manager.listOperations().find(candidate => candidate.id === id)
    if (op !== undefined && terminal.has(op.status)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`operation ${id} did not settle`)
}

describe('candidateFrom', () => {
  const base = {
    repo: { owner: 'acme', name: 'fixture' },
    commitSha: COMMIT,
    sourceUrl: 'https://github.com/acme/fixture',
    archived: false,
    defaultBranch: 'main',
    rateLimit: { remaining: 10, resetAt: '2026-01-01T00:00:00.000Z' },
  }

  it('surfaces repo rejections as non-installable', () => {
    const candidate = candidateFrom({ ...base, rejection: 'archived', rejectionReason: 'archived' })
    expect(candidate.installable).toBe(false)
    expect(candidate.rejection).toBe('archived')
  })

  it('combines npm correspondence into an installable candidate', () => {
    const candidate = candidateFrom(
      { ...base, rootPackageJson: { name: '@acme/fixture', license: 'MIT' } },
      { version: '1.0.0', integrity: 'sha512-abc', scriptNeeds: { scripts: [], nativeBuild: false } },
      { scripts: [], nativeBuild: false },
    )
    expect(candidate.installable).toBe(true)
    expect(candidate.npmVersion).toBe('1.0.0')
    expect(candidate.integrity).toBe('sha512-abc')
    expect(candidate.license).toBe('MIT')
  })
})

describe('PluginManager', () => {
  beforeEach(() => {
    mockRunLauncher.mockClear()
  })

  afterEach(() => {
    for (const dir of [join(tmpdir(), 'dsh-mgr-clean-')]) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects invalid install requests without touching the profile', async () => {
    const { manager } = harness()
    const op = await manager.install({ packageName: 'rm -rf /', version: '1.0.0', allowScripts: false })
    expect(op.status).toBe('failed')
    expect(op.code).toBe('invalid-request')
    expect(mockRunLauncher).not.toHaveBeenCalled()
    const ranged = await manager.install({ packageName: '@acme/fixture', version: 'latest', allowScripts: false })
    expect(ranged.code).toBe('invalid-request')
  })

  it('refuses install scripts without explicit confirmation and spawns nothing', async () => {
    const { manager } = harness()
    const op = await manager.install({ packageName: '@acme/fixture', version: '1.0.0', allowScripts: false })
    await settled(manager, op.id)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('failed')
    expect(final?.code).toBe('scripts-not-confirmed')
    expect(mockRunLauncher).not.toHaveBeenCalled()
  })

  it('installs without scripts when the package declares none', async () => {
    const { manager } = harness({ plainTarball: true })
    const op = await manager.install({ packageName: '@acme/fixture', version: '1.0.0', allowScripts: false })
    await settled(manager, op.id)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    expect(mockRunLauncher).toHaveBeenCalledTimes(1)
  })

  it('allows build scripts after confirmation and runs the launcher', async () => {
    const { profileDir, manager } = harness()
    const op = await manager.install({ packageName: '@acme/fixture', version: '1.0.0', allowScripts: true })
    await settled(manager, op.id)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    expect(mockRunLauncher).toHaveBeenCalledTimes(1)
    const workspace = readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain('"@acme/fixture": true')
  })

  it('refuses removing shipped desktop bundles', async () => {
    const shipped = DESKTOP_PROFILE_BUNDLES[0]
    const { manager } = harness()
    const op = await manager.remove({ packageName: shipped })
    expect(op.status).toBe('failed')
    expect(op.code).toBe('shipped-bundle')
    expect(mockRunLauncher).not.toHaveBeenCalled()
  })

  it('refuses removing packages the profile does not directly depend on', async () => {
    const { manager } = harness({ profileDeps: {} })
    const op = await manager.remove({ packageName: '@acme/fixture' })
    expect(op.status).toBe('failed')
    expect(op.code).toBe('not-a-direct-dependency')
    expect(mockRunLauncher).not.toHaveBeenCalled()
  })

  it('removes a desktop-profile-owned third-party dependency', async () => {
    const { manager } = harness({ profileDeps: { '@acme/fixture': '1.0.0' } })
    const op = await manager.remove({ packageName: '@acme/fixture' })
    await settled(manager, op.id)
    const final = manager.listOperations().find(candidate => candidate.id === op.id)
    expect(final?.status).toBe('restart-required')
    expect(mockRunLauncher).toHaveBeenCalledTimes(1)
  })

  it('inspects a repo into an installable candidate', async () => {
    const { manager } = harness()
    const candidate = await manager.inspect({ owner: 'acme', name: 'fixture' })
    expect(candidate.installable).toBe(true)
    expect(candidate.npmVersion).toBe('1.0.0')
    expect(candidate.scriptNeeds?.scripts).toEqual(['postinstall'])
  })

  it('inspects into a non-installable candidate when the npm side mismatches', async () => {
    const root = harnessRoot()
    const github = new GitHubClient({ fetchFn: routeFetch(githubRoutes()), cacheDir: join(root, 'cache') })
    // The packument exists, but its repository points elsewhere.
    const mismatchRoutes = npmRoutes()
    mismatchRoutes[PACKUMENT_URL] = () => ({
      body: {
        versions: {
          '1.0.0': {
            dist: { integrity: 'sha512-abc', tarball: TARBALL_URL },
            repository: { url: 'https://github.com/other/repo' },
          },
        },
      },
    })
    const npm = new NpmClient(routeFetch(mismatchRoutes))
    const operations = new OperationRegistry(join(root, 'user-data', 'plugin-operations'))
    const isolated = new PluginManager({
      github, npm, operations,
      profileDir: join(root, 'profiles', 'desktop'),
      dshEntry: join(root, 'dsh', 'lib', 'bin.js'),
      nodeBin: process.execPath,
      pnpmEntry: join(root, 'pnpm', 'bin', 'pnpm.cjs'),
      userDataDir: join(root, 'user-data'),
      launcherTimeoutMs: 5000,
      onOperation: vi.fn(),
    })
    const candidate = await isolated.inspect({ owner: 'acme', name: 'fixture' })
    expect(candidate.installable).toBe(false)
    expect(candidate.rejection).toBe('repository-mismatch')
  })

  it('lists installed desktop-profile dependencies with their bundle flag', () => {
    const { profileDir, manager } = harness({
      profileDeps: { '@acme/fixture': '1.0.0', '@acme/plain': '2.0.0' },
    })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@acme/fixture': '1.0.0', '@acme/plain': '2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@acme/fixture'] } },
    }), 'utf8')
    const installed = manager.listInstalled()
    expect(installed).toEqual([
      { packageName: '@acme/fixture', version: '1.0.0', bundle: true },
      { packageName: '@acme/plain', version: '2.0.0', bundle: false },
    ])
    // A missing profile manifest lists nothing.
    const bare = new PluginManager({
      github: new GitHubClient({ fetchFn: routeFetch(githubRoutes()), cacheDir: join(harnessRoot(), 'cache') }),
      npm: new NpmClient(routeFetch(npmRoutes())),
      operations: new OperationRegistry(join(harnessRoot(), 'user-data', 'plugin-operations')),
      profileDir: join(harnessRoot(), 'missing-profile'),
      dshEntry: join(harnessRoot(), 'dsh', 'lib', 'bin.js'),
      nodeBin: process.execPath,
      pnpmEntry: join(harnessRoot(), 'pnpm', 'bin', 'pnpm.cjs'),
      userDataDir: join(harnessRoot(), 'user-data'),
      launcherTimeoutMs: 5000,
      onOperation: vi.fn(),
    })
    expect(bare.listInstalled()).toEqual([])
  })
})

/** A fresh temp root for one-off harnesses. */
function harnessRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mgr-'))
}
