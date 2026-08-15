/**
 * Wire types for the DSH Studio window bridge (`window.dshStudio`), mirrored
 * from the desktop host's plugin contracts (apps/desktop/src/plugins/types.ts)
 * so the renderer can type the IPC surface without importing host code. The
 * bridge values are plain JSON leaf shapes; the mirror is the wire contract,
 * and any host-side field change must land here too.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-center/client/wire
 */

/** A repository identity, normalized to `owner/name`. */
export interface RepoId {
  owner: string
  name: string
}

/** One GitHub search result (metadata only). */
export interface PluginSearchHit {
  repo: RepoId
  description?: string
  stars: number
  updatedAt: string
  homepage?: string
  url: string
}

/** The GitHub rate-limit state, surfaced so the UI can show it. */
export interface GitHubRateLimit {
  remaining: number
  /** When the quota resets, as an ISO string. */
  resetAt: string
}

/** A page of discovery results. */
export interface PluginSearchPage {
  hits: readonly PluginSearchHit[]
  /** The next page number, or `undefined` on the last page. */
  nextPage?: number
  rateLimit: GitHubRateLimit
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
  /** Lifecycle script names the package declares (`install`, `postinstall`, `preinstall`). */
  scripts: readonly string[]
  /** Whether the package ships native build requirements. */
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
  /** The exact reason text for non-installable repos. */
  rejectionReason?: string
  /** The copyable source URL. */
  sourceUrl: string
}

/** The plugin-change state machine, mirror of the host operation status. */
export type PluginOperationStatus =
  | 'queued'
  | 'running'
  | 'restart-required'
  | 'succeeded'
  | 'failed'

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
  kind: 'install' | 'remove'
  packageName: string
  /** The exact target version (install) or the installed version (remove). */
  target: string
  status: PluginOperationStatus
  timestamp: number
  code?: PluginOperationCode
}

/** One desktop-profile-owned installed bundle. */
export interface PluginInstalledInfo {
  packageName: string
  /** The exact installed version from the profile manifest. */
  version: string
  /** Whether the profile lists the package as a bundle layer. */
  bundle: boolean
}

/** The runtime status snapshot (`window.dshStudio.getInfo/restartHarness`). */
export interface DesktopRuntimeStatus {
  state: string
  restartCount: number
  code?: string
  timestamp: number
}

/** The frozen bridge object exposed by the Electron preload. */
export interface DshStudioApi {
  getInfo(): Promise<{
    appVersion: string
    harnessVersion: string
    platform: string
    arch: string
    profile: string
    logDir: string
    state: string
  }>
  restartHarness(): Promise<DesktopRuntimeStatus>
  openLogs(): Promise<void>
  exportDiagnostics(): Promise<{ canceled: boolean; path?: string }>
  searchPlugins(request: { query: string; page: number }): Promise<PluginSearchPage>
  inspectPlugin(request: { owner: string; name: string }): Promise<PluginCandidate>
  installPlugin(request: { packageName: string; version: string; allowScripts: boolean }): Promise<PluginOperation>
  removePlugin(request: { packageName: string }): Promise<PluginOperation>
  listInstalledPlugins(): Promise<PluginInstalledInfo[]>
  listPluginOperations(): Promise<PluginOperation[]>
  onRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): () => void
  onPluginOperation(listener: (operation: PluginOperation) => void): () => void
}
