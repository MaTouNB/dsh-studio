/**
 * Desktop profile bootstrap: the packaged application owns the dedicated
 * `desktop` profile under the ordinary DSH home, so third-party profile
 * dependencies (M3) survive application upgrades and reinstallations.
 * @module @deepseek-ai/dsh-desktop/profile
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The profile name every DSH Studio installation boots. */
export const DESKTOP_PROFILE = 'desktop'

/** The shipped bundle layers of the desktop profile, in application order. */
export const DESKTOP_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-integration',
] as const

/**
 * The desktop profile directory under a DSH home.
 * @param home - the DSH home (`$DSH_HOME` or the platform default `~/.dsh`).
 * @returns the absolute profile directory.
 */
export function desktopProfileDir(home: string): string {
  return join(home, 'profiles', DESKTOP_PROFILE)
}

/**
 * Read the profile manifest, or `undefined` when the profile has none.
 * @param home - the DSH home.
 * @returns the parsed manifest.
 */
function readManifest(home: string): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } | undefined {
  const manifestPath = join(desktopProfileDir(home), 'package.json')
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
}

/**
 * Create or reconcile the desktop profile manifest. The profile is
 * app-owned: a missing manifest is created with the shipped bundle layers,
 * and an existing one is only ever extended — the shipped integration bundle
 * is inserted when absent (a profile first created by a pre-M2 checkout must
 * still boot authenticated), while user-owned bundles and dependencies are
 * left untouched.
 * @param home - the DSH home.
 * @param bundles - the shipped `dsh.profile.bundles` layer list.
 * @returns the absolute manifest path.
 */
export function ensureDesktopProfile(
  home: string,
  bundles: readonly string[] = DESKTOP_PROFILE_BUNDLES,
): string {
  const dir = desktopProfileDir(home)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  const existing = readManifest(home)
  if (existing === undefined) {
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }, null, 2)}\n`)
    return manifestPath
  }
  const current = existing.dsh?.profile?.bundles ?? []
  const missing = bundles.filter(bundle => !current.includes(bundle))
  if (missing.length > 0) {
    writeFileSync(manifestPath, `${JSON.stringify({
      ...existing,
      dsh: { ...existing.dsh, profile: { ...existing.dsh?.profile, bundles: [...missing, ...current] } },
    }, null, 2)}\n`)
  }
  return manifestPath
}
