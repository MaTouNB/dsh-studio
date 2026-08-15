import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitHubClient, pathTraverses, PLUGIN_TOPIC, SEARCH_CACHE_TTL_MS, SEARCH_PER_PAGE, type FetchLike } from '../../src/plugins/github.ts'

/** A scriptable fetch: URL → canned response sequence. */
function mockFetch(routes: Record<string, () => {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}>): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    calls.push(url)
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    const entry = route()
    const headers = new Map(Object.entries(entry.headers ?? {}))
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      async json() {
        return entry.body
      },
      async arrayBuffer() {
        return Buffer.from('').buffer
      },
    }
  }
  return Object.assign(fetchFn, { calls })
}

const SHAS = {
  commit: 'a'.repeat(40),
}

function repoRoutes(overrides: Record<string, unknown> = {}): Record<string, () => { status?: number; body?: unknown }> {
  return {
    'https://api.github.com/repos/acme/fixture': () => ({
      body: {
        archived: false,
        default_branch: 'main',
        ...(overrides.repo ?? {}),
      },
    }),
    'https://api.github.com/repos/acme/fixture/git/ref/heads/main': () => ({
      body: { object: { sha: SHAS.commit, type: 'commit' } },
    }),
    ['https://api.github.com/repos/acme/fixture/contents/package.json?ref=' + SHAS.commit]: () => ({
      body: {
        type: 'file',
        content: Buffer.from(JSON.stringify({
          name: '@acme/fixture',
          license: 'MIT',
          main: 'lib/index.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          ...(overrides.manifest ?? {}),
        })).toString('base64'),
      },
    }),
    ['https://api.github.com/repos/acme/fixture/contents/lib/index.js?ref=' + SHAS.commit]: () => ({
      body: { type: 'file', content: Buffer.from('export default {}').toString('base64') },
    }),
  }
}

function client(routes: Record<string, () => { status?: number; headers?: Record<string, string>; body?: unknown }>): GitHubClient {
  return new GitHubClient({
    fetchFn: mockFetch(routes),
    cacheDir: mkdtempSync(join(tmpdir(), 'dsh-gh-')),
  })
}

describe('GitHubClient', () => {
  it('pins the discovery contract: topic, page size, and cache window', () => {
    expect(PLUGIN_TOPIC).toBe('dsh-plugin')
    expect(SEARCH_PER_PAGE).toBe(10)
    expect(SEARCH_CACHE_TTL_MS).toBe(15 * 60 * 1000)
  })

  it('parses search pages with pagination and rate limits', async () => {
    const fetchFn = mockFetch({
      'https://api.github.com/search/repositories?q=topic%3Adsh-plugin%20archived%3Afalse%20agent&per_page=10&page=1': () => ({
        headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1700000000', etag: '"abc"' },
        body: {
          items: Array.from({ length: 10 }, (_, index) => ({
            full_name: `acme/plugin-${String(index)}`,
            description: 'a plugin',
            stargazers_count: 3,
            updated_at: '2026-01-01T00:00:00Z',
            html_url: `https://github.com/acme/plugin-${String(index)}`,
          })),
        },
      }),
    })
    const client = new GitHubClient({ fetchFn, cacheDir: mkdtempSync(join(tmpdir(), 'dsh-gh-')) })
    const page = await client.search({ query: 'agent', page: 1 })
    expect(page.hits).toHaveLength(10)
    expect(page.nextPage).toBe(2)
    expect(page.rateLimit.remaining).toBe(42)
    expect(page.rateLimit.resetAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('serves fresh cached pages without a network call and revalidates with ETag', async () => {
    const routes = {
      'https://api.github.com/search/repositories?q=topic%3Adsh-plugin%20archived%3Afalse%20agent&per_page=10&page=1': () => ({
        headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1700000000', etag: '"etag1"' },
        body: { items: [{ full_name: 'acme/one', stargazers_count: 1, updated_at: '2026-01-01T00:00:00Z' }] },
      }),
    }
    const fetchFn = mockFetch(routes)
    const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-gh-'))
    const client = new GitHubClient({ fetchFn, cacheDir, now: () => 0 })
    await client.search({ query: 'agent', page: 1 })
    const callsAfterFirst = fetchFn.calls.length
    // Fresh window: served from cache.
    const cached = await client.search({ query: 'agent', page: 1 })
    expect(cached.hits[0]?.repo.name).toBe('one')
    expect(fetchFn.calls.length).toBe(callsAfterFirst)
    // Stale window + ETag match: revalidates with If-None-Match and a 304.
    const stale = new GitHubClient({ fetchFn, cacheDir, now: () => SEARCH_CACHE_TTL_MS + 60_000 })
    const revalidated = await stale.search({ query: 'agent', page: 1 })
    expect(revalidated.hits).toHaveLength(1)
    expect(fetchFn.calls.length).toBe(callsAfterFirst + 1)
  })

  it('rejects archived repositories', async () => {
    const inspection = await client(repoRoutes({ repo: { archived: true } })).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('archived')
    expect(inspection.archived).toBe(true)
  })

  it('rejects a missing root package.json', async () => {
    const routes = repoRoutes()
    routes['https://api.github.com/repos/acme/fixture/contents/package.json?ref=' + SHAS.commit] = () => ({ status: 404, body: {} })
    const inspection = await client(routes).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('missing-root-package-json')
  })

  it('rejects a submodule root package.json', async () => {
    const routes = repoRoutes()
    routes['https://api.github.com/repos/acme/fixture/contents/package.json?ref=' + SHAS.commit] = () => ({
      body: { type: 'submodule', submodule_git_url: 'https://github.com/other/thing' },
    })
    const inspection = await client(routes).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('submodule-package')
  })

  it('rejects an unparsable root package.json', async () => {
    const routes = repoRoutes()
    routes['https://api.github.com/repos/acme/fixture/contents/package.json?ref=' + SHAS.commit] = () => ({
      body: { type: 'file', content: Buffer.from('{not json').toString('base64') },
    })
    const inspection = await client(routes).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('invalid-manifest')
  })

  it('rejects missing bundle declarations', async () => {
    const inspection = await client(repoRoutes({ manifest: { dsh: {} } })).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('no-bundle-declaration')
  })

  it('rejects path traversal in the bundle patch', async () => {
    const inspection = await client(repoRoutes({ manifest: { dsh: { bundle: { patch: '../escape.yml' } } } }))
      .inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('path-traversal')
    expect(pathTraverses('../escape.yml')).toBe(true)
    expect(pathTraverses('patches/plugin.yml')).toBe(false)
  })

  it('rejects missing build artifacts at the pinned commit', async () => {
    const routes = repoRoutes()
    routes['https://api.github.com/repos/acme/fixture/contents/lib/index.js?ref=' + SHAS.commit] = () => ({ status: 404, body: {} })
    const inspection = await client(routes).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBe('missing-build-artifacts')
  })

  it('accepts a valid candidate repository', async () => {
    const inspection = await client(repoRoutes()).inspect({ owner: 'acme', name: 'fixture' })
    expect(inspection.rejection).toBeUndefined()
    expect(inspection.commitSha).toBe(SHAS.commit)
    expect(inspection.rootPackageJson?.name).toBe('@acme/fixture')
  })
})
