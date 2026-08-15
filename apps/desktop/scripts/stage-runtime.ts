#!/usr/bin/env node
/**
 * Deterministic runtime staging for DSH Studio: builds the CLI dependency
 * closure with `pnpm deploy --prod`, verifies the dsh bin and Web frontend
 * entry, applies the recorded closure patches, prunes foreign-platform
 * native artifacts, downloads and verifies the pinned Node and pnpm
 * runtimes, and writes `runtime-manifest.json` with exact versions and
 * SHA-256 digests. The staged tree is what Electron Builder copies through
 * `extraResources` into every installer.
 * @module @deepseek-ai/dsh-desktop/stage-runtime
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { BOOTSTRAP_PATH, SECRET_ENV } from '../bundle/src/auth.ts'
import { ensureDesktopProfile } from '../src/profile.ts'
import { NODE_VERSION, PRODUCT_NAME } from '../src/product.ts'
import { parseReadyLine } from '../src/runtime.ts'
import {
  CLOSURE_PATCHES,
  digestTree,
  isForeignNativePackage,
  nodeDistFileName,
  nodeDistUrl,
  prebuildDirName,
  studioPlatform,
  type ClosurePatch,
  type StudioPlatform,
} from '../src/staging.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_ROOT = resolve(APP_DIR, '..', '..')
const WORKSPACE_STORE = join(REPO_ROOT, 'node_modules', '.pnpm')

/** Deploy offline when the local store satisfies the closure, unless the operator opts out. */
const DEPLOY_OFFLINE = process.env.DSH_STAGE_OFFLINE !== '0'

/** The per-launch secret the staging smokes authenticate with. */
const SECRET = randomBytes(32).toString('base64url')

/** How long the staging boot smoke waits for the canonical ready line. */
const SMOKE_READY_TIMEOUT_MS = 60_000

interface ComponentInfo {
  version: string
  treeSha256: string
}

function fail(message: string): never {
  process.stderr.write(`stage-runtime: ${message}\n`)
  process.exit(1)
}

function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  // Windows resolves pnpm through its .cmd shim, which spawnSync refuses
  // without a shell since the CVE-2024-27980 hardening.
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  })
  if (result.error !== undefined) fail(`${command} ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

/** Read `packageManager` from the root manifest, e.g. `pnpm@11.7.0`. */
function pnpmVersion(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { packageManager?: string }
  const match = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(manifest.packageManager ?? '')
  if (match === null) fail(`root packageManager ${JSON.stringify(manifest.packageManager)} is not pnpm@<semver>`)
  return match[1] as string
}

/** The virtual-store directory name prefix for a package name. */
function storePrefix(packageName: string): string {
  return packageName.startsWith('@') ? packageName.replace('/', '+') : packageName
}

/**
 * Resolve a patch source package in the workspace: the virtual store first
 * (registry packages), then the workspace manifests themselves (workspace
 * packages are symlinked into dependents, not cloned into the store).
 */
function resolveWorkspacePackage(packageName: string): { dir: string; version: string } {
  const prefix = storePrefix(packageName)
  const storeCandidates = readdirSync(WORKSPACE_STORE).filter(dir => dir.startsWith(`${prefix}@`))
  if (storeCandidates.length === 1) {
    return {
      dir: join(WORKSPACE_STORE, storeCandidates[0] as string, 'node_modules', packageName),
      version: (JSON.parse(readFileSync(join(
        WORKSPACE_STORE, storeCandidates[0] as string, 'node_modules', packageName, 'package.json',
      ), 'utf8')) as { version?: string }).version ?? 'unknown',
    }
  }
  const probes: string[] = []
  for (const entry of readdirSync(join(REPO_ROOT, 'vendor'))) {
    probes.push(join(REPO_ROOT, 'vendor', entry))
  }
  for (const group of readdirSync(join(REPO_ROOT, 'packages'))) {
    const groupDir = join(REPO_ROOT, 'packages', group)
    if (!lstatSync(groupDir).isDirectory()) continue
    for (const entry of readdirSync(groupDir)) {
      probes.push(join(groupDir, entry))
    }
  }
  for (const dir of probes) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
    if (manifest.name === packageName) return { dir, version: manifest.version ?? 'unknown' }
  }
  fail(`workspace package ${packageName} not found`)
}

/** The unique closure virtual-store entry whose package dir is `packageName`. */
function closureStoreEntry(closure: string, packageName: string): string {
  const prefix = storePrefix(packageName)
  const candidates = readdirSync(join(closure, 'node_modules', '.pnpm')).filter(
    dir => dir.startsWith(`${prefix}@`),
  )
  if (candidates.length !== 1) {
    fail(`closure store holds ${String(candidates.length)} candidate(s) for ${packageName}`)
  }
  return candidates[0] as string
}

/** Verify the dsh bin and the Web frontend entry inside the deployed closure. */
function verifyClosureEntries(closure: string): void {
  if (!existsSync(join(closure, 'lib', 'bin.js'))) fail('closure lacks apps/cli/lib/bin.js')
  // pnpm's virtual store places a package's declared deps beside it inside
  // the same store entry, so the frontend resolves from the web-app entry.
  const webAppEntry = closureStoreEntry(closure, '@deepseek-ai/dsh-web-app')
  const webEntry = join(
    closure, 'node_modules', '.pnpm', webAppEntry,
    'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html',
  )
  if (!existsSync(webEntry)) fail('closure lacks the Web frontend entry')
}

/** Copy a real directory tree without following symlinks. */
function copyTree(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name))
  } else if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  } else if (stat.isSymbolicLink()) {
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(readlinkSync(source), target)
  }
}

/** Create or replace a symlink, unlinking a previous entry if needed. */
function linkInto(linkPath: string, target: string): void {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(linkPath)
    else rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(relative(dirname(linkPath), target), linkPath)
}

/** Apply one recorded closure patch: copy from the workspace and link it in. */
function applyClosurePatch(closure: string, patch: ClosurePatch): void {
  const { dir: source, version } = resolveWorkspacePackage(patch.packageName)
  const entry = `${storePrefix(patch.packageName)}@${version}`
  const storeTarget = join(closure, 'node_modules', '.pnpm', entry, 'node_modules', patch.packageName)
  if (!existsSync(storeTarget)) copyTree(source, storeTarget)
  linkInto(join(closure, 'node_modules', ...patch.packageName.split('/')), storeTarget)
  for (const importer of patch.importers) {
    const importerEntry = closureStoreEntry(closure, importer)
    // The virtual store places a package's deps beside it inside the same
    // entry, so the patch link is a sibling of the importer package.
    linkInto(
      join(closure, 'node_modules', '.pnpm', importerEntry, 'node_modules', patch.packageName),
      storeTarget,
    )
  }}

/**
 * Every package name and importer from an `ERR_MODULE_NOT_FOUND` run.
 * Importers may be package libs or preset YAML files; the importer is only
 * needed to place the entry-sibling link and is optional.
 */
function parseMissingPackages(output: string): Array<{ name: string; importer?: string }> {
  const entries: Array<{ name: string; importer?: string }> = []
  for (const match of output.matchAll(/Cannot find package '([^']+)' imported from (.+)/gu)) {
    const segments = /node_modules\/((?:@[^/]+\/)?[^/]+)\/lib\//gu
    let importer: string | undefined
    for (const candidate of (match[2] as string).matchAll(segments)) importer = candidate[1]
    entries.push({ name: match[1] as string, ...(importer === undefined ? {} : { importer }) })
  }
  return entries
}

/**
 * Add missing-package patches that are not already recorded.
 * @returns `false` when every reported package was already patched.
 */
function addPatches(patches: ClosurePatch[], entries: Array<{ name: string; importer?: string }>): boolean {
  let added = false
  for (const entry of entries) {
    if (patches.some(patch => patch.packageName === entry.name)) continue
    patches.push({
      packageName: entry.name,
      importers: entry.importer === undefined ? [] : [entry.importer],
      reason: `undeclared runtime import of ${entry.importer ?? 'a profile preset'} (auto-detected)`,
    })
    process.stdout.write(`stage-runtime: closure patch +${entry.name} (imported by ${entry.importer ?? 'preset'})\n`)
    added = true
  }
  return added
}

/**
 * Hoist every virtual-store package to the closure top-level node_modules.
 * The runtime's profile module fallback resolves the installation graph with
 * `require.resolve.paths`, which does not follow symlinks; a strict deploy
 * layout hides transitive deps inside store entries, so the fallback skips
 * them. Hoisting mirrors the flat layout the fallback assumes and keeps
 * every bundle row resolvable from a profile directory.
 */
function hoistClosure(closure: string): void {
  const store = join(closure, 'node_modules', '.pnpm')
  const top = join(closure, 'node_modules')
  for (const entry of readdirSync(store)) {
    const entryModules = join(store, entry, 'node_modules')
    if (!existsSync(entryModules) || !lstatSync(entryModules).isDirectory()) continue
    for (const name of readdirSync(entryModules)) {
      if (name === '.bin' || name === 'node_modules') continue
      const names = name.startsWith('@')
        ? readdirSync(join(entryModules, name)).map(inner => `${name}/${inner}`)
        : [name]
      for (const packageName of names) {
        const link = join(top, ...packageName.split('/'))
        if (existsSync(link)) continue
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(relative(dirname(link), join(entryModules, ...packageName.split('/'))), link)
      }
    }
  }
}

/**
 * Make the deployed closure self-contained. `pnpm deploy --legacy` keeps
 * workspace-referencing links (the `link:` overrides cosmokit/schemastery
 * and the workspace virtual store itself), which resolve only while the
 * closure stays inside the repository tree. Every link whose target resolves
 * outside the closure is replaced by a link into a mirror store inside the
 * closure, with one real copy per distinct target; mirror contents are
 * processed recursively until no external links remain.
 */
function materializeSourceLinks(closure: string): void {
  const mirrorRoot = join(closure, 'node_modules', '.pnpm', '.dsh-mirror')
  const mirrors = new Map<string, string>()
  for (let pass = 0; pass < 10; pass += 1) {
    const stack = [closure]
    let replaced = 0
    while (stack.length > 0) {
      const dir = stack.pop() as string
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        let stat: ReturnType<typeof lstatSync>
        try {
          stat = lstatSync(path)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          stack.push(path)
          continue
        }
        if (!stat.isSymbolicLink()) continue
        let resolved: string
        try {
          resolved = realpathSync(path)
        } catch {
          continue
        }
        if (resolved === path || resolved.startsWith(`${closure}${sep}`)) continue
        const mirrored = mirrors.get(resolved)
        if (mirrored === undefined) {
          const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16)
          const target = join(mirrorRoot, hash)
          if (!existsSync(target)) copyTree(resolved, target)
          mirrors.set(resolved, target)
        }
        process.stdout.write(`stage-runtime: mirroring ${relative(closure, path)}\n`)
        unlinkSync(path)
        symlinkSync(relative(dirname(path), mirrors.get(resolved) as string), path)
        replaced += 1
      }
    }
    if (replaced === 0) return
  }
  fail('closure still contains repository-referencing links after mirroring')
}

/** Remove foreign-platform native packages and node-pty prebuilds. */
function pruneForeignArtifacts(closure: string, target: StudioPlatform): void {
  const store = join(closure, 'node_modules', '.pnpm')
  for (const entry of readdirSync(store)) {
    const at = entry.indexOf('@', entry.startsWith('@') ? 2 : 0)
    const packageName = entry.slice(0, at).replace('+', '/')
    if (isForeignNativePackage(packageName, target)) {
      rmSync(join(store, entry), { recursive: true, force: true })
      // The top-level link is a symlink whose target just disappeared;
      // existsSync follows the link and misses broken links, so probe lstat.
      const link = join(closure, 'node_modules', ...packageName.split('/'))
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
      } catch {
        // already gone
      }
    }
    if (packageName === 'node-pty') {
      const prebuilds = join(store, entry, 'node_modules', 'node-pty', 'prebuilds')
      if (existsSync(prebuilds)) {
        for (const platformDir of readdirSync(prebuilds)) {
          if (platformDir !== prebuildDirName(target)) {
            rmSync(join(prebuilds, platformDir), { recursive: true, force: true })
          }
        }
      }
    }
  }
}

/** Download a URL to a file, aborting the stage on failure. */
async function download(url: string, targetFile: string): Promise<void> {
  mkdirSync(dirname(targetFile), { recursive: true })
  const response = await fetch(url)
  if (!response.ok) fail(`download ${url} -> HTTP ${String(response.status)}`)
  writeFileSync(targetFile, Buffer.from(await response.arrayBuffer()))
}

function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The SHA-256 nodejs.org publishes for a dist archive. */
async function publishedNodeSha256(archiveName: string): Promise<string> {
  const sums = await (await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).text()
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/u.exec(line.trim())
    if (match !== null && match[2] === archiveName) return match[1] as string
  }
  fail(`nodejs.org SHASUMS256.txt lacks ${archiveName}`)
}

/** The registry integrity (sha512) npm publishes for a pnpm tarball. */
async function pnpmIntegrity(version: string): Promise<string> {
  const packument = await (await fetch(`https://registry.npmjs.org/pnpm/${version}`)).json() as {
    dist?: { integrity?: string }
  }
  if (packument.dist?.integrity === undefined) fail(`registry packument for pnpm@${version} lacks dist.integrity`)
  return packument.dist.integrity
}

function extractTar(archive: string, destDir: string, stripComponents: number): void {
  const result = spawnSync('tar', ['-xzf', archive, '-C', destDir, '--strip-components', String(stripComponents)], { stdio: 'inherit' })
  if (result.status !== 0) fail(`tar extraction of ${archive} failed`)
}

/** Download, verify, and extract the pinned stock Node runtime. */
async function stageNode(target: StudioPlatform, stagingRoot: string): Promise<ComponentInfo> {
  const archiveName = nodeDistFileName(target)
  const archive = join(stagingRoot, 'downloads', archiveName)
  await download(nodeDistUrl(target), archive)
  const published = await publishedNodeSha256(archiveName)
  const actual = fileSha256(archive)
  if (published !== actual) fail(`Node archive SHA-256 mismatch: expected ${published}, got ${actual}`)
  const work = mkdtempSync(join(tmpdir(), 'dsh-stage-node-'))
  try {
    if (target === 'mac-arm64') {
      extractTar(archive, work, 1)
    } else {
      const result = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' })
      if (result.status !== 0) fail('Node zip extraction failed')
      const inner = readdirSync(work).find(name => existsSync(join(work, name, 'node.exe')))
      if (inner === undefined) fail('Node zip lacks node.exe')
      renameSync(join(work, inner), join(work, 'node'))
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw error
  }
  const nodeDir = join(stagingRoot, 'node')
  rmSync(nodeDir, { recursive: true, force: true })
  renameSync(work, nodeDir)
  return { version: NODE_VERSION, treeSha256: digestTree(nodeDir) }
}

/** Download, verify, and extract the pinned pnpm runtime. */
async function stagePnpm(version: string, stagingRoot: string): Promise<ComponentInfo> {
  const tarball = join(stagingRoot, 'downloads', `pnpm-${version}.tgz`)
  await download(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`, tarball)
  const expected = await pnpmIntegrity(version)
  const actual = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  if (actual !== expected) fail(`pnpm tarball integrity mismatch: expected ${expected}, got ${actual}`)
  const work = mkdtempSync(join(tmpdir(), 'dsh-stage-pnpm-'))
  try {
    extractTar(tarball, work, 1)
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw error
  }
  const pnpmDir = join(stagingRoot, 'pnpm')
  rmSync(pnpmDir, { recursive: true, force: true })
  renameSync(work, pnpmDir)
  return { version, treeSha256: digestTree(pnpmDir) }
}

/**
 * Boot the staged CLI against a scratch desktop profile and await the ready
 * line. On failure the combined output is returned so the caller can resolve
 * the next undeclared runtime import.
 */
async function smokeBoot(closure: string, stagingRoot: string): Promise<string | undefined> {
  const smokeHome = join(stagingRoot, 'smoke-home')
  rmSync(smokeHome, { recursive: true, force: true })
  mkdirSync(smokeHome, { recursive: true })
  ensureDesktopProfile(smokeHome)
  const child = spawn(process.execPath, [join(closure, 'lib', 'bin.js'), '--profile', 'desktop', '--port', '0'], {
    cwd: closure,
    // The packaged application never overrides the user's telemetry switch,
    // so the smoke must boot the same composition (telemetry row included);
    // an unconfigured exporter is a local no-op.
    env: { ...process.env, DSH_HOME: smokeHome, [SECRET_ENV]: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const reader = createInterface({ input: child.stdout })
  const port = await new Promise<number | undefined>((resolvePort) => {
    const deadline = setTimeout(() => resolvePort(undefined), SMOKE_READY_TIMEOUT_MS)
    reader.on('line', (line: string) => {
      const found = parseReadyLine(line)
      if (found !== undefined) {
        clearTimeout(deadline)
        resolvePort(found)
      }
    })
    child.on('exit', () => {
      clearTimeout(deadline)
      resolvePort(undefined)
    })
  })
  if (port === undefined) {
    child.kill('SIGKILL')
    return `no ready line. stdout:\n${stdout}\nstderr:\n${stderr}`
  }
  // The desktop composition is authenticated: exchange the secret for the
  // loopback cookie at the bootstrap endpoint, then verify the SPA serves.
  const bootstrap = await fetch(`http://127.0.0.1:${port}${BOOTSTRAP_PATH}?token=${encodeURIComponent(SECRET)}`, { redirect: 'manual' })
  if (bootstrap.status !== 302) return `bootstrap HTTP ${String(bootstrap.status)}`
  const cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0] as string
  if (cookie === '') return 'bootstrap set no cookie'
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
  if (!response.ok) return `HTTP ${String(response.status)} on /`
  const body = await response.text()
  if (!body.includes('<html')) return '/ did not serve an HTML document'
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() })),
    new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 10_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  process.stdout.write(`stage-runtime: boot smoke OK (port ${String(port)})\n`)
  return undefined
}

/** Run the preset-mount probe against the staged closure. */
async function presetProbe(closure: string, stagingRoot: string): Promise<string | undefined> {
  // The probe's own imports must resolve from the closure's hoisted
  // node_modules, so it runs from a copy inside the closure, not from the
  // repository tree.
  const probeSource = join(APP_DIR, 'scripts', 'preset-probe.mjs')
  const probeTarget = join(closure, '.dsh-preset-probe.mjs')
  copyFileSync(probeSource, probeTarget)
  const profileBase = pathToFileURL(join(stagingRoot, 'smoke-home', 'profiles', 'desktop')).href + '/'
  const presetPath = join(closure, 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
  const result = await new Promise<string>((resolveOutput) => {
    const child = spawn(process.execPath, [probeTarget, profileBase, presetPath], {
      cwd: closure,
      env: { ...process.env, [SECRET_ENV]: SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('exit', () => { resolveOutput(output) })
  })
  if (result.includes('PRESET MOUNT OK')) {
    process.stdout.write('stage-runtime: preset probe OK\n')
    return undefined
  }
  return result
}

/** Stage the app-owned desktop integration bundle into the closure. */
function stageIntegrationBundle(closure: string): void {
  const bundleDir = join(APP_DIR, 'bundle')
  run('pnpm', ['--filter', '@deepseek-ai/dsh-desktop-integration', 'run', 'build'], { cwd: REPO_ROOT })
  if (!existsSync(join(bundleDir, 'lib', 'index.js'))) fail('desktop integration bundle is not built')
  const target = join(closure, 'node_modules', '@deepseek-ai', 'dsh-desktop-integration')
  mkdirSync(join(target, 'lib'), { recursive: true })
  copyFileSync(join(bundleDir, 'package.json'), join(target, 'package.json'))
  copyFileSync(join(bundleDir, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
  copyTree(join(bundleDir, 'lib'), join(target, 'lib'))
  const bundleManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as { version?: string }
  const closureManifestPath = join(closure, 'package.json')
  const closureManifest = JSON.parse(readFileSync(closureManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  closureManifest.dependencies = {
    ...(closureManifest.dependencies ?? {}),
    '@deepseek-ai/dsh-desktop-integration': bundleManifest.version ?? '0.1.0-alpha.1',
  }
  writeFileSync(closureManifestPath, `${JSON.stringify(closureManifest, null, 2)}\n`)
}

/**
 * Build the desktop plugin-center client package. It rides the closure as a
 * dependency of the web-app bundle (its row is mounted only by the desktop
 * profile), so the deploy ships it; this step only guarantees the built
 * client bundle exists before the deploy copies the package.
 */
function buildPluginCenter(): void {
  run('pnpm', ['--filter', '@deepseek-ai/dsh-client-ui-settings-plugin-center', 'run', 'bundle'], { cwd: REPO_ROOT })
  if (!existsSync(join(REPO_ROOT, 'packages', 'client', 'ui-settings-plugin-center', 'lib', 'client.js'))) {
    fail('desktop plugin-center client bundle is not built')
  }
}

/** Verify the desktop plugin-center package landed in the deployed closure. */
function verifyPluginCenterStaged(closure: string): void {
  const entry = closureStoreEntry(closure, '@deepseek-ai/dsh-client-ui-settings-plugin-center')
  const clientBundle = join(
    closure, 'node_modules', '.pnpm', entry, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-plugin-center', 'lib', 'client.js',
  )
  if (!existsSync(clientBundle)) fail('closure lacks the desktop plugin-center client bundle')
}

/** Write the runtime manifest with exact versions and digests. */
function writeManifest(
  stagingRoot: string,
  target: StudioPlatform,
  components: Record<string, ComponentInfo>,
  patches: readonly ClosurePatch[],
  appVersion: string,
  electronVersion: string,
): void {
  const manifest = {
    schemaVersion: 1,
    app: { name: PRODUCT_NAME, package: '@deepseek-ai/dsh-desktop', version: appVersion },
    platform: target,
    components,
    closurePatches: patches.map(patch => ({
      package: patch.packageName,
      importers: [...patch.importers],
      reason: patch.reason,
    })),
    electron: { version: electronVersion },
  }
  writeFileSync(join(stagingRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main(): Promise<void> {
  const target = studioPlatform(process.platform, process.arch)
  const stagingRoot = join(APP_DIR, 'staging', target)
  rmSync(stagingRoot, { recursive: true, force: true })
  mkdirSync(stagingRoot, { recursive: true })

  const closure = join(stagingRoot, 'dsh-cli')
  process.stdout.write(`stage-runtime: deploying @deepseek-ai/dsh closure into ${closure}\n`)
  const offlineArgs = DEPLOY_OFFLINE ? ['--offline'] : []
  buildPluginCenter()
  run('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', ...offlineArgs, closure], {
    cwd: REPO_ROOT,
    env: { CI: 'true' },
  })
  verifyClosureEntries(closure)
  stageIntegrationBundle(closure)
  verifyPluginCenterStaged(closure)
  const patches: ClosurePatch[] = [...CLOSURE_PATCHES]
  for (let attempt = 0; attempt < 25; attempt += 1) {
    for (const patch of patches) applyClosurePatch(closure, patch)
    hoistClosure(closure)
    const failure = await smokeBoot(closure, stagingRoot)
    if (failure === undefined) {
      const presetFailure = await presetProbe(closure, stagingRoot)
      if (presetFailure === undefined) break
      const missing = parseMissingPackages(presetFailure)
      if (missing.length === 0) fail(`staging preset probe failed without a resolvable missing package:\n${presetFailure}`)
      if (!addPatches(patches, missing)) {
        fail(`staging preset probe still fails on known packages after patching:\n${presetFailure}`)
      }
      continue
    }
    const missing = parseMissingPackages(failure)
    if (missing.length === 0) fail(`staging boot smoke failed without a resolvable missing package:\n${failure}`)
    if (!addPatches(patches, missing)) {
      fail(`staging boot smoke still fails on known packages after patching:\n${failure}`)
    }
  }
  // The discovery loop stops one patch short of the full set; a final smoke
  // with every patch applied is the verification that gates the stage.
  materializeSourceLinks(closure)
  const complete = await smokeBoot(closure, stagingRoot)
  if (complete !== undefined) fail(`staging boot smoke failed with the complete patch set:\n${complete}`)
  const completePreset = await presetProbe(closure, stagingRoot)
  if (completePreset !== undefined) fail(`staging preset probe failed with the complete patch set:\n${completePreset}`)
  pruneForeignArtifacts(closure, target)
  const postPrune = await smokeBoot(closure, stagingRoot)
  if (postPrune !== undefined) fail(`staging boot smoke failed after native pruning:\n${postPrune}`)
  const postPrunePreset = await presetProbe(closure, stagingRoot)
  if (postPrunePreset !== undefined) fail(`staging preset probe failed after native pruning:\n${postPrunePreset}`)

  const node = await stageNode(target, stagingRoot)
  const pnpm = await stagePnpm(pnpmVersion(), stagingRoot)
  const closureManifest = JSON.parse(readFileSync(join(closure, 'package.json'), 'utf8')) as { version?: string }
  const appManifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as {
    version?: string
    devDependencies?: Record<string, string>
  }
  const dsh = { version: closureManifest.version ?? 'unknown', treeSha256: digestTree(closure) }
  writeManifest(
    stagingRoot,
    target,
    { node, pnpm, dsh },
    patches,
    appManifest.version ?? 'unknown',
    appManifest.devDependencies?.electron ?? 'unknown',
  )
  process.stdout.write(`stage-runtime: done — ${stagingRoot}\n`)
}

await main()
