import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PROFILE,
  DESKTOP_PROFILE_BUNDLES,
  desktopProfileDir,
  ensureDesktopProfile,
} from '../src/profile.ts'

function homeDir(): string {
  return join(tmpdir(), `dsh-profile-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
}

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function manifestOf(home: string): ProfileManifest {
  return JSON.parse(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'), 'utf8')) as ProfileManifest
}

describe('desktop profile bootstrap', () => {
  it('creates the profile manifest with the shipped bundle layers', () => {
    const home = homeDir()
    const manifestPath = ensureDesktopProfile(home)
    expect(manifestPath).toBe(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'))
    const manifest = manifestOf(home)
    expect(manifest.name).toBe('dsh-profile-desktop')
    expect(manifest.private).toBe(true)
    expect(manifest.dsh?.profile?.bundles).toEqual([...DESKTOP_PROFILE_BUNDLES])
  })

  it('extends a pre-M2 manifest with the missing shipped bundles, preserving user data', () => {
    const home = homeDir()
    const dir = desktopProfileDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { 'user-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    ensureDesktopProfile(home)
    const manifest = manifestOf(home)
    expect(manifest.name).toBe('dsh-profile-desktop')
    expect(manifest.dependencies).toEqual({ 'user-plugin': '1.0.0' })
    expect(manifest.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-desktop-integration',
      '@deepseek-ai/dsh-base',
    ])
  })

  it('leaves a manifest with the full shipped list byte-identical', () => {
    const home = homeDir()
    const dir = desktopProfileDir(home)
    mkdirSync(dir, { recursive: true })
    const content = JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {},
      dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
    })
    writeFileSync(join(dir, 'package.json'), content)
    ensureDesktopProfile(home)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(content)
  })

  it('is idempotent', () => {
    const home = homeDir()
    ensureDesktopProfile(home)
    const first = readFileSync(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'), 'utf8')
    ensureDesktopProfile(home)
    expect(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'), 'utf8')).toBe(first)
    expect(existsSync(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'))).toBe(true)
  })

  it('accepts an explicit bundle list', () => {
    const home = homeDir()
    ensureDesktopProfile(home, ['@deepseek-ai/dsh-base'])
    expect(manifestOf(home).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    rmSync(home, { recursive: true, force: true })
  })
})
