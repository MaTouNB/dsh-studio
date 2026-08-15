import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { diagnosticEntries, profilePackages, writeDiagnosticZip, type DiagnosticFacts } from '../src/diagnostics.ts'

function facts(overrides: Partial<DiagnosticFacts> = {}): DiagnosticFacts {
  return {
    appVersion: '0.1.0-alpha.1',
    harnessVersion: '0.1.0-rc.5',
    platform: 'darwin',
    arch: 'arm64',
    release: '27.0.0',
    state: 'failed',
    logDir: '/tmp/logs',
    profileDir: '/tmp/profile',
    runtimeManifest: { components: { dsh: { version: '0.1.0-rc.5' } } },
    profilePackages: [],
    ...overrides,
  }
}

describe('diagnostic export', () => {
  it('collects profile package names and versions from the profile node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
    const profile = join(dir, 'profiles', 'desktop')
    mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'some-plugin'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dependencies: {
        '@deepseek-ai/some-plugin': '1.2.3',
        '@deepseek-ai/missing': '2.0.0',
      },
    }))
    writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'some-plugin', 'package.json'), JSON.stringify({ version: '1.2.3' }))
    expect(profilePackages(profile)).toEqual([{ name: '@deepseek-ai/some-plugin', version: '1.2.3' }])
  })

  it('returns no packages for a profile without a manifest', () => {
    expect(profilePackages(join(mkdtempSync(join(tmpdir(), 'dsh-diag-')), 'nowhere'))).toEqual([])
  })

  it('assembles the five named entries and nothing else', () => {
    const entries = diagnosticEntries(facts(), 'redacted log text')
    expect(entries.map(entry => entry.name)).toEqual([
      'runtime-manifest.json',
      'logs.txt',
      'platform.json',
      'profile-packages.json',
      'effective-config.json',
    ])
    expect(entries.find(entry => entry.name === 'logs.txt')?.text).toBe('redacted log text')
  })

  it('writes a readable zip with the entries', () => {
    const target = join(mkdtempSync(join(tmpdir(), 'dsh-diag-')), 'out.zip')
    const entries = diagnosticEntries(facts(), 'log-content')
    writeDiagnosticZip(target, entries)
    const files = unzipSync(readFileSync(target))
    expect(strFromU8(files['logs.txt'] as Uint8Array)).toBe('log-content')
    expect(strFromU8(files['platform.json'] as Uint8Array)).toContain('"arch": "arm64"')
    expect(strFromU8(files['runtime-manifest.json'] as Uint8Array)).toContain('0.1.0-rc.5')
  })
})
