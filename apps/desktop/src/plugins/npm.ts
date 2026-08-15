/**
 * npm correspondence validation for one-click plugin installs: the registry
 * packument must expose an exact semver whose `dist.integrity` can be pinned
 * and whose repository URL points at the same GitHub repository; the tarball
 * is inspected for lifecycle-script needs (install/postinstall/preinstall and
 * native build markers) without executing anything. Fetch is injected for
 * tests.
 * @module @deepseek-ai/dsh-desktop/plugins/npm
 */

import { gunzipSync } from 'node:zlib'
import type { FetchLike } from './github.ts'
import { exactSemver, parseRepoId, type RepoId, type ScriptNeeds } from './types.ts'

/** One version entry of an npm packument. */
export interface NpmVersionInfo {
  version: string
  integrity: string
  tarball: string
  repositoryUrl?: string
  publishedAt?: string
}

/** The correspondence check result. */
export interface NpmCorrespondence {
  /** The pinned exact version. */
  version: string
  integrity: string
  publishedAt?: string
  scriptNeeds: ScriptNeeds
  /** The rejection code when the npm side fails. */
  rejection?: 'no-published-version' | 'repository-mismatch' | 'invalid-manifest'
  rejectionReason?: string
}

interface NpmDist {
  integrity?: string
  tarball?: string
}

/** A package manifest's script-relevant fields. */
export interface NpmManifest {
  name?: string
  version?: string
  scripts?: Record<string, string>
  repository?: string | { url?: string }
  binary?: unknown
  files?: string[]
}

/** Whether a package manifest carries native build requirements. */
export function nativeBuildNeeds(manifest: NpmManifest): boolean {
  if (manifest.binary !== undefined) return true
  const scripts = Object.keys(manifest.scripts ?? {})
  return scripts.some(script => /^(?:install|preinstall|postinstall|prepare|rebuild)$/u.test(script))
      || scripts.some(script => /build|gyp|cmake|node-gyp/u.test(script))
}

/** The lifecycle-script needs of one manifest. */
export function scriptNeedsOf(manifest: NpmManifest): ScriptNeeds {
  const scripts = Object.entries(manifest.scripts ?? {})
    .filter(([name]) => /^(?:install|postinstall|preinstall)$/u.test(name))
    .map(([name]) => name)
    .sort()
  return { scripts, nativeBuild: nativeBuildNeeds(manifest) }
}

/** Normalize a repository field into a repo identity, when it is a GitHub URL. */
export function repositoryRepoId(repository: string | { url?: string } | undefined): RepoId | undefined {
  const url = typeof repository === 'string' ? repository : repository?.url
  if (url === undefined) return undefined
  return parseRepoId(url)
}

/**
 * Extract the root package.json from a tarball buffer without executing
 * anything. Registry tarballs are gzip streams of ustar entries; the first
 *-level `package/package.json` entry is read from its declared size.
 */
export function extractPackageJson(buffer: Buffer): NpmManifest | undefined {
  let gz: Buffer
  try {
    gz = gunzipSync(buffer)
  } catch {
    return undefined
  }
  let offset = 0
  while (offset + 512 <= gz.length) {
    const header = gz.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') break
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/[^0-7]/gu, '')
    const size = Number.parseInt(sizeOctal, 8) || 0
    const block = offset + 512
    if (name === 'package/package.json' || name === 'package/./package.json') {
      if (block + size > gz.length) return undefined
      try {
        return JSON.parse(gz.subarray(block, block + size).toString('utf8')) as NpmManifest
      } catch {
        return undefined
      }
    }
    offset = block + Math.ceil(size / 512) * 512
  }
  return undefined
}

/** The npm registry client. */
export class NpmClient {
  constructor(
    private readonly fetchFn: FetchLike,
    /** The registry base URL; overridable for mirrors and tests. */
    private readonly registry: string = 'https://registry.npmjs.org',
  ) {}

  /**
   * Fetch the packument for a package name.
   * @param packageName - the npm package name.
   * @returns the version entries with integrity and repository facts.
   */
  async packument(packageName: string): Promise<NpmVersionInfo[]> {
    const response = await this.fetchFn(`${this.registry}/${encodeURIComponent(packageName)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) throw new Error(`npm registry returned ${String(response.status)} for ${packageName}`)
    const payload = await response.json() as {
      time?: Record<string, string>
      versions?: Record<string, { dist?: NpmDist; repository?: string | { url?: string } }>
    }
    const versions: NpmVersionInfo[] = []
    for (const [version, entry] of Object.entries(payload.versions ?? {})) {
      if (!exactSemver(version)) continue
      if (entry.dist?.integrity === undefined || entry.dist.tarball === undefined) continue
      const repo = repositoryRepoId(entry.repository)
      versions.push({
        version,
        integrity: entry.dist.integrity,
        tarball: entry.dist.tarball,
        ...(repo === undefined ? {} : { repositoryUrl: `https://github.com/${repo.owner}/${repo.name}` }),
        ...(payload.time?.[version] === undefined ? {} : { publishedAt: payload.time[version] }),
      })
    }
    versions.sort((left, right) => (left.version < right.version ? -1 : left.version > right.version ? 1 : 0))
    return versions
  }

  /**
   * Download a tarball and parse its root package.json for script needs.
   * The tarball is never executed.
   * @param tarballUrl - the version's tarball URL.
   * @returns the parsed manifest.
   */
  async tarballManifest(tarballUrl: string): Promise<NpmManifest> {
    const response = await this.fetchFn(tarballUrl)
    if (!response.ok) throw new Error(`npm tarball returned ${String(response.status)}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const manifest = extractPackageJson(buffer)
    if (manifest === undefined) throw new Error('npm tarball lacks a root package.json')
    return manifest
  }

  /**
   * Validate the npm correspondence for a one-click install: the exact
   * published version whose repository URL matches the GitHub repo.
   * @param versions - the packument versions.
   * @param repo - the GitHub repository identity.
   * @returns the correspondence or the rejection.
   */
  correspondence(versions: readonly NpmVersionInfo[], repo: RepoId): NpmCorrespondence {
    const candidates = versions.filter(entry => entry.repositoryUrl !== undefined)
    const match = candidates.findLast((entry) => {
      const parsed = parseRepoId(entry.repositoryUrl as string)
      return parsed !== undefined && parsed.owner === repo.owner && parsed.name === repo.name
    })
    if (match === undefined) {
      return {
        version: '',
        integrity: '',
        scriptNeeds: { scripts: [], nativeBuild: false },
        rejection: candidates.length > 0 ? 'repository-mismatch' : 'no-published-version',
        rejectionReason: candidates.length > 0
          ? 'Published versions exist but none points at this GitHub repository.'
          : 'No published version exists for this package.',
      }
    }
    return {
      version: match.version,
      integrity: match.integrity,
      scriptNeeds: { scripts: [], nativeBuild: false },
      ...(match.publishedAt === undefined ? {} : { publishedAt: match.publishedAt }),
    }
  }
}
