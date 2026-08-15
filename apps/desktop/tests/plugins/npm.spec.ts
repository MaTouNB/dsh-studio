import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../../src/plugins/github.ts'
import {
  NpmClient,
  extractPackageJson,
  nativeBuildNeeds,
  repositoryRepoId,
  scriptNeedsOf,
} from '../../src/plugins/npm.ts'

/** Build a minimal ustar tarball (gzip) with the given entries. */
function makeTarGz(entries: Array<{ path: string; content: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const content = Buffer.from(entry.content, 'utf8')
    const header = Buffer.alloc(512)
    name.copy(header, 0, 0, Math.min(name.length, 100))
    const size = content.length.toString(8).padStart(11, '0') + '\0'
    Buffer.from(size, 'ascii').copy(header, 124)
    Buffer.from('0000777\0', 'ascii').copy(header, 100)
    Buffer.from('0000000\0', 'ascii').copy(header, 108)
    Buffer.from('0000000\0', 'ascii').copy(header, 116)
    Buffer.from('00000000000\0', 'ascii').copy(header, 136)
    header[156] = 0x30 // regular file
    Buffer.from('ustar\0', 'ascii').copy(header, 257)
    Buffer.from('00', 'ascii').copy(header, 263)
    // checksum field as spaces, then the computed sum in octal.
    Buffer.from('        ', 'ascii').copy(header, 148)
    let sum = 0
    for (const byte of header) sum += byte
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148)
    blocks.push(header)
    blocks.push(content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const TARBALL = makeTarGz([
  { path: 'package/package.json', content: JSON.stringify({
    name: '@acme/fixture',
    version: '1.0.0',
    scripts: { postinstall: 'node scripts/marker.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) },
  { path: 'package/lib/index.js', content: 'export default {}' },
])

const PACKUMENT_URL = 'https://registry.npmjs.org/%40acme%2Ffixture'
const TARBALL_URL = 'https://registry.npmjs.org/@acme/fixture/-/fixture-1.0.0.tgz'

const PACKUMENT = {
  time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
  versions: {
    '1.0.0': {
      dist: { integrity: 'sha512-abc', tarball: TARBALL_URL },
      repository: { url: 'https://github.com/acme/fixture' },
    },
    '0.9.0': {
      dist: { integrity: 'sha512-def', tarball: 'https://registry.npmjs.org/@acme/fixture/-/fixture-0.9.0.tgz' },
      repository: 'https://github.com/other/repo.git',
    },
    'not-a-version': {},
  },
}

/** A route-based fetch mock like the GitHub spec, with tarball bytes support. */
function mockFetch(routes: Record<string, () => { status?: number; body?: unknown; tarball?: Buffer }>): FetchLike {
  const fetchFn: FetchLike = async (url) => {
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    const entry = route()
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      headers: { get: () => null },
      async json() {
        return entry.body
      },
      async arrayBuffer() {
        const tarball = entry.tarball
        if (tarball === undefined) return new ArrayBuffer(0)
        return tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) as ArrayBuffer
      },
    }
  }
  return fetchFn
}

function client(): NpmClient {
  const fetchFn = mockFetch({
    [PACKUMENT_URL]: () => ({ body: PACKUMENT }),
    [TARBALL_URL]: () => ({ tarball: TARBALL }),
  })
  return new NpmClient(fetchFn)
}

describe('npm correspondence', () => {
  it('extracts the root package.json from a gzip tar without executing it', () => {
    const manifest = extractPackageJson(TARBALL)
    expect(manifest?.name).toBe('@acme/fixture')
    expect(manifest?.scripts?.postinstall).toBe('node scripts/marker.js')
  })

  it('returns undefined for non-tarball buffers', () => {
    expect(extractPackageJson(Buffer.from('not gzip'))).toBeUndefined()
  })

  it('detects script needs', () => {
    expect(scriptNeedsOf({ scripts: { postinstall: 'x' } })).toEqual({ scripts: ['postinstall'], nativeBuild: true })
    expect(scriptNeedsOf({ scripts: { test: 'x' } })).toEqual({ scripts: [], nativeBuild: false })
    expect(scriptNeedsOf({ binary: 'bin.js' })).toEqual({ scripts: [], nativeBuild: true })
    expect(nativeBuildNeeds({ scripts: { build: 'node-gyp rebuild' } })).toBe(true)
  })

  it('parses packuments into exact-version entries', async () => {
    const versions = await client().packument('@acme/fixture')
    expect(versions.map(entry => entry.version)).toEqual(['0.9.0', '1.0.0'])
    expect(versions[1]?.integrity).toBe('sha512-abc')
    expect(versions[1]?.publishedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('selects the matching version and reports mismatch or absence', async () => {
    const versions = await client().packument('@acme/fixture')
    const match = client().correspondence(versions, { owner: 'acme', name: 'fixture' })
    expect(match.version).toBe('1.0.0')
    expect(match.rejection).toBeUndefined()
    const mismatch = client().correspondence(versions, { owner: 'acme', name: 'other' })
    expect(mismatch.rejection).toBe('repository-mismatch')
    const absent = client().correspondence([], { owner: 'acme', name: 'fixture' })
    expect(absent.rejection).toBe('no-published-version')
  })

  it('reads the tarball manifest', async () => {
    const manifest = await client().tarballManifest(TARBALL_URL)
    expect(manifest.name).toBe('@acme/fixture')
  })

  it('normalizes repository fields', () => {
    expect(repositoryRepoId('https://github.com/acme/fixture.git')).toEqual({ owner: 'acme', name: 'fixture' })
    expect(repositoryRepoId({ url: 'git+ssh://git@github.com/acme/fixture.git' })).toEqual({ owner: 'acme', name: 'fixture' })
    expect(repositoryRepoId('https://gitlab.com/acme/fixture')).toBeUndefined()
    expect(repositoryRepoId(undefined)).toBeUndefined()
  })
})
