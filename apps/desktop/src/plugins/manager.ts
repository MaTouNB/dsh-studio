/**
 * The plugin manager: discovery, inspection, and the single-flight install /
 * remove operations over the desktop profile. Every renderer input is
 * validated before it becomes an argv element; operations transition through
 * `queued → running → restart-required`, and failures keep the previous
 * profile state intact.
 * @module @deepseek-ai/dsh-desktop/plugins/manager
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_PROFILE_BUNDLES } from '../profile.ts'
import { GitHubClient, type RepoInspection } from './github.ts'
import {
  PNPM_SHIM_DIR,
  PNPM_STORE_DIR,
  allowBuildsFor,
  dshPluginArgv,
  ensurePnpmShim,
  ensureProfileNpmrc,
  installPnpmArgs,
  isProfileDirectDependency,
  pluginChildEnv,
  removePnpmArgs,
  runLauncher,
} from './installer.ts'
import { NpmClient, scriptNeedsOf, type NpmCorrespondence } from './npm.ts'
import { OperationRegistry } from './operations.ts'
import type {
  PluginCandidate,
  PluginInspectRequest,
  PluginInstallRequest,
  PluginInstalledInfo,
  PluginOperation,
  PluginOperationCode,
  PluginRemoveRequest,
  PluginSearchPage,
  PluginSearchRequest,
  RepoId,
} from './types.ts'
import { exactSemver, validPackageName } from './types.ts'

/** The manager's host dependencies. */
export interface PluginManagerOptions {
  github: GitHubClient
  npm: NpmClient
  operations: OperationRegistry
  profileDir: string
  /** The absolute path of the dsh launcher entry (`lib/bin.js`). */
  dshEntry: string
  /** The absolute path of the bundled node binary. */
  nodeBin: string
  /** The absolute path of the staged pnpm entry (`bin/pnpm.cjs`). */
  pnpmEntry: string
  /** The user-data directory for the isolated store and shims. */
  userDataDir: string
  /** A launcher timeout for one pnpm invocation. */
  launcherTimeoutMs: number
  /** The npm registry override for tests. */
  registry?: string
  /** Status change notification for the renderer. */
  onOperation(operation: PluginOperation): void
}

/** Combine repo facts and npm correspondence into a candidate. */
export function candidateFrom(
  inspection: RepoInspection,
  npmCorrespondence?: NpmCorrespondence,
  scriptNeeds?: { scripts: readonly string[]; nativeBuild: boolean },
): PluginCandidate {
  const base = {
    repo: inspection.repo,
    commitSha: inspection.commitSha,
    sourceUrl: inspection.sourceUrl,
    ...(inspection.rootPackageJson?.name === undefined ? {} : { packageName: inspection.rootPackageJson.name }),
    ...(inspection.rootPackageJson?.license === undefined ? {} : { license: inspection.rootPackageJson.license }),
  }
  if (inspection.rejection !== undefined) {
    return {
      ...base,
      installable: false,
      rejection: inspection.rejection,
      ...(inspection.rejectionReason === undefined ? {} : { rejectionReason: inspection.rejectionReason }),
    }
  }
  if (npmCorrespondence?.rejection !== undefined) {
    return {
      ...base,
      installable: false,
      rejection: npmCorrespondence.rejection,
      ...(npmCorrespondence.rejectionReason === undefined ? {} : { rejectionReason: npmCorrespondence.rejectionReason }),
    }
  }
  return {
    ...base,
    installable: true,
    ...(npmCorrespondence?.version === undefined ? {} : { npmVersion: npmCorrespondence.version }),
    ...(npmCorrespondence?.integrity === undefined ? {} : { integrity: npmCorrespondence.integrity }),
    ...(npmCorrespondence?.publishedAt === undefined ? {} : { publishedAt: npmCorrespondence.publishedAt }),
    ...(scriptNeeds === undefined ? {} : { scriptNeeds }),
  }
}

/** The plugin manager. */
export class PluginManager {
  constructor(private readonly options: PluginManagerOptions) {}

  /** Search GitHub for compatible repositories. */
  search(request: PluginSearchRequest): Promise<PluginSearchPage> {
    return this.options.github.search(request)
  }

  /** Inspect one repository into a candidate. */
  async inspect(request: PluginInspectRequest): Promise<PluginCandidate> {
    const repo: RepoId = { owner: request.owner, name: request.name }
    const inspection = await this.options.github.inspect(repo)
    if (inspection.rejection !== undefined || inspection.rootPackageJson === undefined) {
      return candidateFrom(inspection)
    }
    const packageName = inspection.rootPackageJson.name
    if (packageName === undefined || !validPackageName(packageName)) {
      return candidateFrom({ ...inspection, rejection: 'invalid-manifest', rejectionReason: 'The root package.json has no valid package name.' })
    }
    const versions = await this.options.npm.packument(packageName)
    const correspondence = this.options.npm.correspondence(versions, repo)
    if (correspondence.rejection !== undefined) {
      return candidateFrom(inspection, correspondence)
    }
    const manifest = await this.options.npm.tarballManifest(
      versions.find(entry => entry.version === correspondence.version)?.tarball ?? '',
    )
    return candidateFrom(inspection, correspondence, scriptNeedsOf(manifest))
  }

  /** Queue and run one install. */
  install(request: PluginInstallRequest): Promise<PluginOperation> {
    if (!validPackageName(request.packageName) || !exactSemver(request.version)) {
      return Promise.resolve(this.failImmediately('install', request.packageName, request.version, 'invalid-request'))
    }
    const operation = this.options.operations.enqueue('install', request.packageName, request.version)
    if (operation.status !== 'queued') return Promise.resolve(operation)
    void this.runInstall(operation, request)
    return Promise.resolve(operation)
  }

  /** Queue and run one removal. */
  remove(request: PluginRemoveRequest): Promise<PluginOperation> {
    if (!validPackageName(request.packageName)) {
      return Promise.resolve(this.failImmediately('remove', request.packageName, '', 'invalid-request'))
    }
    if (DESKTOP_PROFILE_BUNDLES.includes(request.packageName as (typeof DESKTOP_PROFILE_BUNDLES)[number])) {
      return Promise.resolve(this.failImmediately('remove', request.packageName, '', 'shipped-bundle'))
    }
    if (!isProfileDirectDependency(this.options.profileDir, request.packageName)) {
      return Promise.resolve(this.failImmediately('remove', request.packageName, '', 'not-a-direct-dependency'))
    }
    const installed = this.installedVersion(request.packageName)
    const operation = this.options.operations.enqueue('remove', request.packageName, installed ?? '')
    if (operation.status !== 'queued') return Promise.resolve(operation)
    void this.runRemove(operation)
    return Promise.resolve(operation)
  }

  /** The persisted operations. */
  listOperations(): readonly PluginOperation[] {
    return this.options.operations.list()
  }

  /**
   * The installed desktop-profile dependencies, for the Manage tab. Only
   * direct dependencies are listed (each with its exact installed version
   * and whether the profile also composes it as a bundle layer); shipped
   * template bundles that are not dependencies never appear.
   * @returns the installed dependency facts.
   */
  listInstalled(): PluginInstalledInfo[] {
    const manifestPath = join(this.options.profileDir, 'package.json')
    if (!existsSync(manifestPath)) return []
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    return Object.entries(manifest.dependencies ?? {})
      .map(([packageName, version]) => ({
        packageName,
        version,
        bundle: bundles.has(packageName),
      }))
      .sort((left, right) => left.packageName.localeCompare(right.packageName))
  }

  private failImmediately(kind: PluginOperation['kind'], packageName: string, target: string, code: PluginOperationCode): PluginOperation {
    const operation: PluginOperation = {
      id: `rejected-${Date.now()}`,
      kind,
      packageName,
      target,
      status: 'failed',
      timestamp: Date.now(),
      code,
    }
    this.options.onOperation(operation)
    return operation
  }

  private async runInstall(operation: PluginOperation, request: PluginInstallRequest): Promise<void> {
    const registry = this.options.registry
    this.options.operations.update(operation, 'running')
    this.options.onOperation(operation)
    try {
      // Refuse to run scripts without the explicit confirmation; nothing is
      // spawned and the profile is untouched.
      const needsScripts = await this.candidateScripts(request.packageName, request.version)
      if (needsScripts && !request.allowScripts) {
        this.options.operations.update(operation, 'failed', 'scripts-not-confirmed')
        this.options.onOperation(operation)
        return
      }
      if (request.allowScripts && needsScripts) {
        allowBuildsFor(this.options.profileDir, request.packageName)
      }
      const storeDir = join(this.options.userDataDir, PNPM_STORE_DIR)
      const shimDir = join(this.options.userDataDir, PNPM_SHIM_DIR)
      ensurePnpmShim(shimDir, this.options.pnpmEntry)
      const args = installPnpmArgs(request.packageName, request.version, storeDir, {
        allowScripts: request.allowScripts,
        ...(registry === undefined ? {} : { registry }),
      })
      const result = await this.run(args)
      if (result.exitCode !== 0) {
        this.options.operations.update(operation, 'failed', 'launcher-failed')
        this.options.onOperation(operation)
        return
      }
      this.options.operations.update(operation, 'restart-required')
      this.options.onOperation(operation)
    } catch (error) {
      this.options.operations.update(operation, 'failed', 'unknown')
      this.options.onOperation(operation)
      void error
    }
  }

  private async runRemove(operation: PluginOperation): Promise<void> {
    this.options.operations.update(operation, 'running')
    this.options.onOperation(operation)
    try {
      const storeDir = join(this.options.userDataDir, PNPM_STORE_DIR)
      const shimDir = join(this.options.userDataDir, PNPM_SHIM_DIR)
      ensurePnpmShim(shimDir, this.options.pnpmEntry)
      const result = await this.run(removePnpmArgs(operation.packageName, storeDir))
      if (result.exitCode !== 0) {
        this.options.operations.update(operation, 'failed', 'launcher-failed')
        this.options.onOperation(operation)
        return
      }
      this.options.operations.update(operation, 'restart-required')
      this.options.onOperation(operation)
    } catch (error) {
      this.options.operations.update(operation, 'failed', 'unknown')
      this.options.onOperation(operation)
      void error
    }
  }

  private run(args: readonly string[]): ReturnType<typeof runLauncher> {
    const runtimeDir = join(this.options.dshEntry, '..', '..')
    const bundledNodeDir = join(this.options.nodeBin, '..')
    const shimDir = join(this.options.userDataDir, PNPM_SHIM_DIR)
    // The registry override rides the profile .npmrc (and the install flag):
    // `pnpm remove` rejects a --registry flag, but both commands honor the
    // project npmrc.
    ensureProfileNpmrc(this.options.profileDir, this.options.registry)
    return runLauncher(this.options.nodeBin, dshPluginArgv(this.options.dshEntry, args), {
      cwd: this.options.profileDir,
      env: pluginChildEnv(process.env, [shimDir, bundledNodeDir, join(runtimeDir, 'pnpm', 'bin')]),
      timeoutMs: this.options.launcherTimeoutMs,
    })
  }

  /** The npm-side script needs of an exact version, fetched on demand. */
  private async candidateScripts(packageName: string, version: string): Promise<boolean> {
    try {
      const versions = await this.options.npm.packument(packageName)
      const entry = versions.find(candidate => candidate.version === version)
      if (entry === undefined) return false
      const manifest = await this.options.npm.tarballManifest(entry.tarball)
      const needs = scriptNeedsOf(manifest)
      return needs.scripts.length > 0 || needs.nativeBuild
    } catch {
      return false
    }
  }

  /** The installed version of a direct dependency, from the profile manifest. */
  private installedVersion(packageName: string): string | undefined {
    const manifestPath = join(this.options.profileDir, 'package.json')
    if (!existsSync(manifestPath)) return undefined
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    return manifest.dependencies?.[packageName]
  }
}
