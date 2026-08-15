/**
 * GitHub plugin discovery and repository inspection. Search queries the
 * public repository search API for `dsh-plugin`-topic, non-archived
 * repositories; results are cached per query with ETags under the cache
 * directory and a 15-minute freshness window. Repository inspection resolves
 * the default branch to a full commit, reads the root package.json, and
 * rejects repos that cannot be one-click candidates (archived, path
 * traversal, submodule packages, missing build artifacts, undeterminable
 * monorepo roots, or no bundle declaration). Fetch is injected for tests.
 * @module @deepseek-ai/dsh-desktop/plugins/github
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GitHubRateLimit,
  PluginSearchHit,
  PluginSearchPage,
  RejectionCode,
  RepoId,
} from './types.ts'

/** The freshness window for cached search pages. */
export const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000

/** The topic every compatible repository must carry. */
export const PLUGIN_TOPIC = 'dsh-plugin'

/** Search page size. */
export const SEARCH_PER_PAGE = 10

/** One raw repository inspection result. */
export interface RepoInspection {
  repo: RepoId
  archived: boolean
  defaultBranch: string
  commitSha: string
  /** The root package.json, decoded, when present. */
  rootPackageJson?: { name?: string; license?: string; main?: string; dsh?: { bundle?: { patch?: unknown } } }
  /** The rejection code when the repo is not a candidate, else `undefined`. */
  rejection?: RejectionCode
  /** The exact reason text for the UI. */
  rejectionReason?: string
  sourceUrl: string
  rateLimit: GitHubRateLimit
}

/** A fetch-compatible function (Node fetch signature subset). */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** GitHub client dependencies. */
export interface GitHubOptions {
  fetchFn: FetchLike
  cacheDir: string
  now?: () => number
}

interface GitHubError {
  message?: string
}

/** Whether a repository root path escapes the repo root (path traversal). */
export function pathTraverses(value: string): boolean {
  return value.split('/').some(segment => segment === '..')
}

/** The bounded query cache entry. */
interface SearchCacheEntry {
  etag: string
  page: PluginSearchPage
  fetchedAt: number
}

/** Parse a 40-hex or 64-hex SHA from a ref object. */
function shaFrom(value: unknown): string | undefined {
  const sha = (value as { sha?: unknown } | null)?.sha
  return typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined
}

function rateLimit(headers: { get(name: string): string | null }, now: number): GitHubRateLimit {
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? '0')
  const reset = Number(headers.get('x-ratelimit-reset') ?? '0')
  return {
    remaining: Number.isFinite(remaining) ? remaining : 0,
    resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : new Date(now + 60_000).toISOString(),
  }
}

/** The GitHub discovery client. */
export class GitHubClient {
  constructor(private readonly options: GitHubOptions) {}

  private cachePath(queryKey: string): string {
    return join(this.options.cacheDir, `${Buffer.from(queryKey).toString('hex')}.json`)
  }

  /**
   * Search repositories. Fresh cached pages are served without a network
   * call; stale entries revalidate with If-None-Match and a 304 refreshes
   * the window.
   * @param request - the query and page.
   * @returns the page with hits, the next page, and the rate-limit state.
   */
  async search(request: { query: string; page: number }): Promise<PluginSearchPage> {
    const now = this.options.now?.() ?? Date.now()
    const queryKey = `${request.query}|${String(request.page)}`
    const cachePath = this.cachePath(queryKey)
    const cached = readCache(cachePath) as SearchCacheEntry | undefined
    if (cached !== undefined && now - cached.fetchedAt < SEARCH_CACHE_TTL_MS) {
      return cached.page
    }
    const q = `topic:${PLUGIN_TOPIC} archived:false ${request.query}`.trim()
    const response = await this.options.fetchFn(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${String(SEARCH_PER_PAGE)}&page=${String(request.page)}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'DSH-Studio',
          ...(cached !== undefined ? { 'if-none-match': cached.etag } : {}),
        },
      },
    )
    const limits = rateLimit(response.headers, now)
    if (response.status === 304 && cached !== undefined) {
      const refreshed = { ...cached, fetchedAt: now }
      writeCache(cachePath, refreshed)
      return cached.page
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as GitHubError
      throw new Error(`GitHub search failed (${String(response.status)}): ${body.message ?? 'unknown error'}`)
    }
    const payload = await response.json() as {
      items?: Array<{
        full_name?: string
        description?: string | null
        stargazers_count?: number
        updated_at?: string
        html_url?: string
        homepage?: string | null
      }>
    }
    const hits: PluginSearchHit[] = []
    for (const item of payload.items ?? []) {
      const parts = (item.full_name ?? '').split('/')
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') continue
      hits.push({
        repo: { owner: parts[0] as string, name: parts[1] as string },
        stars: item.stargazers_count ?? 0,
        updatedAt: item.updated_at ?? '',
        url: item.html_url ?? `https://github.com/${parts[0]}/${parts[1]}`,
        ...(item.description === undefined || item.description === null ? {} : { description: item.description }),
        ...(item.homepage === undefined || item.homepage === null ? {} : { homepage: item.homepage }),
      })
    }
    const etag = response.headers.get('etag')
    const page: PluginSearchPage = {
      hits,
      ...(hits.length === SEARCH_PER_PAGE ? { nextPage: request.page + 1 } : {}),
      rateLimit: limits,
    }
    if (etag !== null) {
      writeCache(cachePath, { etag, page, fetchedAt: now })
    }
    return page
  }

  /**
   * Inspect one repository: default branch, full commit, root package.json,
   * and the candidate rejections.
   * @param repo - the repository identity.
   * @returns the inspection facts and rejection state.
   */
  async inspect(repo: RepoId): Promise<RepoInspection> {
    const now = this.options.now?.() ?? Date.now()
    const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`
    const fetchJson = async (path: string): Promise<{
      ok: boolean
      status: number
      headers: { get(name: string): string | null }
      json(): Promise<unknown>
    }> => {
      const response = await this.options.fetchFn(`${base}${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'DSH-Studio' },
      })
      return response
    }
    const repoResponse = await fetchJson('')
    const limits = rateLimit(repoResponse.headers, now)
    const sourceUrl = `https://github.com/${repo.owner}/${repo.name}`
    if (!repoResponse.ok) {
      return { repo, archived: false, defaultBranch: '', commitSha: '', rejection: 'invalid-manifest', rejectionReason: `GitHub returned ${String(repoResponse.status)}`, sourceUrl, rateLimit: limits }
    }
    const repoPayload = await repoResponse.json() as {
      archived?: boolean
      default_branch?: string
      license?: { spdx_id?: string | null } | null
    }
    if (repoPayload.archived === true) {
      return { repo, archived: true, defaultBranch: repoPayload.default_branch ?? '', commitSha: '', rejection: 'archived', rejectionReason: 'The repository is archived.', sourceUrl, rateLimit: limits }
    }
    const defaultBranch = repoPayload.default_branch ?? 'main'
    const refResponse = await fetchJson(`/git/ref/heads/${defaultBranch}`)
    const refPayload = await refResponse.json() as { object?: { sha?: string } }
    const commitSha = shaFrom(refPayload.object)
    if (!refResponse.ok || commitSha === undefined) {
      return { repo, archived: false, defaultBranch, commitSha: '', rejection: 'invalid-manifest', rejectionReason: `Could not resolve the default branch ref (${String(refResponse.status)}).`, sourceUrl, rateLimit: limits }
    }

    const manifestResponse = await fetchJson(`/contents/package.json?ref=${commitSha}`)
    if (!manifestResponse.ok) {
      return { repo, archived: false, defaultBranch, commitSha, rejection: 'missing-root-package-json', rejectionReason: 'The repository has no root package.json.', sourceUrl, rateLimit: limits }
    }
    const manifestPayload = await manifestResponse.json() as { type?: string; content?: string; submodule_git_url?: string }
    if (manifestPayload.type === 'submodule' || manifestPayload.submodule_git_url !== undefined) {
      return { repo, archived: false, defaultBranch, commitSha, rejection: 'submodule-package', rejectionReason: 'The root package.json is a submodule, not a regular file.', sourceUrl, rateLimit: limits }
    }
    let rootPackageJson: { name?: string; license?: string; main?: string; dsh?: { bundle?: { patch?: unknown } } } | undefined
    try {
      rootPackageJson = JSON.parse(Buffer.from(manifestPayload.content ?? '', 'base64').toString('utf8')) as typeof rootPackageJson
    } catch {
      return { repo, archived: false, defaultBranch, commitSha, rejection: 'invalid-manifest', rejectionReason: 'The root package.json does not parse.', sourceUrl, rateLimit: limits }
    }
    if (rootPackageJson === undefined) {
      return { repo, archived: false, defaultBranch, commitSha, rejection: 'invalid-manifest', rejectionReason: 'The root package.json is empty.', sourceUrl, rateLimit: limits }
    }
    const patch = rootPackageJson.dsh?.bundle?.patch
    if (typeof patch !== 'string' || patch === '') {
      return { repo, archived: false, defaultBranch, commitSha, rootPackageJson, rejection: 'no-bundle-declaration', rejectionReason: 'The root package.json declares no dsh.bundle.patch.', sourceUrl, rateLimit: limits }
    }
    if (pathTraverses(patch)) {
      return { repo, archived: false, defaultBranch, commitSha, rootPackageJson, rejection: 'path-traversal', rejectionReason: 'The bundle patch path escapes the repository root.', sourceUrl, rateLimit: limits }
    }
    // The built entry: the declared main, or the conventional lib/index.js.
    const main = rootPackageJson.main ?? 'lib/index.js'
    if (typeof main !== 'string' || main === '' || pathTraverses(main)) {
      return { repo, archived: false, defaultBranch, commitSha, rootPackageJson, rejection: 'path-traversal', rejectionReason: 'The main entry path escapes the repository root.', sourceUrl, rateLimit: limits }
    }
    const entryResponse = await fetchJson(`/contents/${main}?ref=${commitSha}`)
    if (!entryResponse.ok) {
      return { repo, archived: false, defaultBranch, commitSha, rootPackageJson, rejection: 'missing-build-artifacts', rejectionReason: `The built entry ${main} is absent at the pinned commit.`, sourceUrl, rateLimit: limits }
    }
    return { repo, archived: false, defaultBranch, commitSha, rootPackageJson, sourceUrl, rateLimit: limits }
  }
}

/** Read a JSON cache entry, tolerating absence and corruption. */
function readCache(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeCache(path: string, entry: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entry)}\n`)
}
