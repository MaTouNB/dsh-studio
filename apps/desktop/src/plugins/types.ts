/**
 * Plugin-management contracts for the preload surface: closed unions, bounded
 * strings, and the persisted operation records. Renderer input never becomes
 * a shell command; every value here is validated before it is used to build
 * an argv array.
 * @module @deepseek-ai/dsh-desktop/plugins/types
 */

/** A repository identity, normalized to `owner/name`. */
export interface RepoId {
  owner: string
  name: string
}

/** One GitHub search result as surfaced to the UI (metadata only, never trust). */
export interface PluginSearchHit {
  repo: RepoId
  description?: string
  stars: number
  updatedAt: string
  homepage?: string
  url: string
}

/** The GitHub rate-limit state, surfaced verbatim so the UI can show it. */
export interface GitHubRateLimit {
  remaining: number
  /** The time when the quota resets, as an ISO string. */
  resetAt: string
}

/** A page of discovery results. */
export interface PluginSearchPage {
  hits: readonly PluginSearchHit[]
  /** The next page number, or `undefined` on the last page. */
  nextPage?: number
  rateLimit: GitHubRateLimit
}

/** Search input from the renderer. */
export interface PluginSearchRequest {
  /** Free-text query combined with the `dsh-plugin` topic filter. */
  query: string
  /** One-based page number; bounded. */
  page: number
}

/** Why a repository cannot be one-click installed; a closed code set. */
export type RejectionCode =
  | 'no-bundle-declaration'
  | 'missing-root-package-json'
  | 'archived'
  | 'path-traversal'
  | 'submodule-package'
  | 'missing-build-artifacts'
  | 'monorepo-root-undeterminable'
  | 'no-published-version'
  | 'repository-mismatch'
  | 'invalid-manifest'

/** The lifecycle-script needs of the exact candidate version. */
export interface ScriptNeeds {
  /** Names of lifecycle scripts the package declares (`install`, `postinstall`, `preinstall`). */
  scripts: readonly string[]
  /** Whether the package ships native build requirements (binding.gyp etc.). */
  nativeBuild: boolean
}

/** The inspected candidate, ready for confirmation or a one-click install. */
export interface PluginCandidate {
  repo: RepoId
  /** The full resolved default-branch commit SHA. */
  commitSha: string
  packageName?: string
  license?: string
  /** The exact pinned npm version when one-click install is possible. */
  npmVersion?: string
  /** The npm tarball integrity (`sha512-…`) of the pinned version. */
  integrity?: string
  /** The package's published time (ISO) for the pinned version. */
  publishedAt?: string
  /** The scripts the pinned version requests, for the confirmation dialog. */
  scriptNeeds?: ScriptNeeds
  /** Whether one-click install is possible; otherwise `rejection` explains. */
  installable: boolean
  /** The closed rejection code when not installable. */
  rejection?: RejectionCode
  /** The exact reason text for non-installable repos (copyable, not a code). */
  rejectionReason?: string
  /** The copyable source URL for non-installable repos. */
  sourceUrl: string
}

/** Inspection input: the repo identity from a search hit. */
export interface PluginInspectRequest {
  owner: string
  name: string
}

/** The exact spec a renderer may request: an npm bundle at an exact version. */
export interface PluginInstallRequest {
  packageName: string
  /** Exact semver, never a range. */
  version: string
  /** Explicit confirmation to run lifecycle scripts; refused without it. */
  allowScripts: boolean
}

/** Removal input: a desktop-profile-owned third-party direct dependency. */
export interface PluginRemoveRequest {
  packageName: string
}

/** One installed desktop-profile dependency, surfaced to the Manage tab. */
export interface PluginInstalledInfo {
  packageName: string
  /** The exact installed version from the profile manifest. */
  version: string
  /** Whether the profile also lists the package as a bundle layer. */
  bundle: boolean
}

/** The plugin-change state machine. */
type PluginOperationStatus =
  | 'queued'
  | 'running'
  | 'restart-required'
  | 'succeeded'
  | 'failed'

/** The plugin-change kinds. */
export type PluginOperationKind = 'install' | 'remove'

/** Safe diagnostic codes for plugin operations. */
export type PluginOperationCode =
  | 'interrupted'
  | 'scripts-not-confirmed'
  | 'not-a-direct-dependency'
  | 'shipped-bundle'
  | 'invalid-request'
  | 'launcher-failed'
  | 'unknown'

/** One persisted plugin operation. */
export interface PluginOperation {
  id: string
  kind: PluginOperationKind
  packageName: string
  /** The exact target version (install) or the installed version (remove). */
  target: string
  status: PluginOperationStatus
  timestamp: number
  code?: PluginOperationCode
}

/** The serialized operation store. */
export interface PluginOperationStore {
  /** The last issued operation id, for id generation across starts. */
  lastId: number
  operations: PluginOperation[]
}

/** Bounded validation helpers shared by every input path. */
export function validPackageName(name: string): boolean {
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(name)
}

/** Exact semver, no ranges (per the spec: versions must be exact). */
export function exactSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:[+][0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)
}

/** Normalize a GitHub URL or `owner/name` into a repo identity, if possible. */
export function parseRepoId(value: string): RepoId | undefined {
  let url = value.trim()
  // Strip npm-style prefixes: git+https, git+ssh, git://, ssh://.
  if (/^git\+/u.test(url)) url = url.slice(4)
  url = url.replace(/^(?:git|ssh):\/\//u, 'https://')
  // scp-like form: git@github.com:owner/name(.git).
  const scpLike = /^git@github\.com:(.+)$/u.exec(url)
  if (scpLike !== null) url = `https://github.com/${scpLike[1] as string}`
  // Strip userinfo from https URLs (https://git@github.com/…).
  url = url.replace(/^https?:\/\/[^/]+@/u, 'https://')
  const match = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/|$)/u.exec(url)
  if (match === null) return undefined
  return { owner: match[1] as string, name: match[2] as string }
}
